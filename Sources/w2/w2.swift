
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import Foundation
import Dispatch
import ArgumentParser
import shared

private let log = PrintLog(module: "w2")

private struct W2Error: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { self.description = message }
}

private let env = ProcessInfo.processInfo.environment
private let ccAgentScript = env["W2_AGENT"] ?? "openloop_cc_docker"
private let getsvenBase = env["GETSVEN_BASE"] ?? "https://personas.getsven.com"
private let getsvenKey = env["GETSVEN_API_KEY"]
private let defaultMaxRepairAttempts = 3
private let maxRepairAttempts: Int = {
    guard let raw = env["MAX_REPAIR_ATTEMPTS"] else { return defaultMaxRepairAttempts }
    guard let value = Int(raw) else {
        assertionFailure("MAX_REPAIR_ATTEMPTS must be an integer (got \"\(raw)\")")
        return defaultMaxRepairAttempts
    }
    return value
}()

private let agentScriptPrefix = "openloop_"
private let headlessPersonaArg = "_head_"
private let planModeArg = "plan"
private let runnerBinary = "openloop-runner"

private let personasFolder = "personas"
private let knowledgeFolder = "knowledge"
private let workflowsFolder = "workflows"
private let dataFileSuffix = ".\(shared.json)"

private let jsonSentinelStart = "<<<W2JSON"
private let jsonSentinelEnd = "W2JSON>>>"
private let jsonFenceStart = "```json"
private let jsonFenceEnd = "```"

private let repairSnippetLimit = 8192
private let httpOKStatuses = 200..<300
private let oneShotEverySecs = 0

private let derivedAgent: String = {
    let stripped = ccAgentScript.hasPrefix(agentScriptPrefix)
        ? String(ccAgentScript.dropFirst(agentScriptPrefix.count))
        : ccAgentScript
    assert(stripped.notEmpty, "W2_AGENT must not resolve to an empty agent name")
    return stripped
}()

@main
struct w2: ParsableCommand {

    @Argument(help: "Task / ask for the team to accomplish")
    private var ask: String

    func run() throws {
        Task {
            let recorder = CleanupRecorder()
            do {
                try await autopilot(ask: ask, recorder: recorder)
            } catch {
                log.err("failed: \(error)")
            }
            recorder.cleanup()
            w2.exit()
        }
        dispatchMain()
    }
}

// MARK: - Orchestration

private func autopilot(ask: String, recorder: CleanupRecorder) async throws {
    guard ask.notEmpty else {
        throw W2Error("ask must not be empty")
    }

    Paths.exitIfLegacyDataFolderExists()

    let home = FilePath(NSHomeDirectory())
    let cur = Paths.curDir
    guard cur != home, cur.string.hasPrefix(home.string) else {
        throw W2Error("must run inside $HOME (got: \(cur.string))")
    }

    try ensureOpenloopDirs()

    let parent = topMostOpenloopAncestor()
    let inventory = collectInventory()
    let invPersonaIds = Set(inventory.flatMap(\.personas).map(\.id))
    let invWorkflowIds = Set(inventory.flatMap(\.workflows).map(\.id))

    let prompt = try buildPrompt(inventory: inventory, ask: ask)

    assert(maxRepairAttempts > 0, "MAX_REPAIR_ATTEMPTS must be a positive integer")
    var plan: Plan?
    var repairContext = ""
    for attempt in 1...maxRepairAttempts {
        log.info("asking \(ccAgentScript) to design the team (attempt \(attempt)/\(maxRepairAttempts))...")
        let fullPrompt = repairContext.notEmpty ? """
            \(prompt)

            PREVIOUS ATTEMPT FAILED — the JSON you returned was malformed. Fix it and return ONLY the sentinel-wrapped JSON per the schema.
            \(repairContext)
            """ : prompt

        let raw = try await callCCdocker(prompt: fullPrompt, parent: parent)
        let block = extractBlock(raw)
        do {
            plan = try parseAndValidate(block: block, invPersonaIds: invPersonaIds, invWorkflowIds: invWorkflowIds)
            break
        } catch {
            log.warn("validation failed: \(error)")
            let snippet = String(block.prefix(repairSnippetLimit))
            repairContext = """
                Parser/validator error: \(error)

                Your previous (malformed) JSON:
                \(snippet)
                """
            if attempt == maxRepairAttempts {
                throw W2Error("\(ccAgentScript) did not produce valid JSON after \(maxRepairAttempts) attempts. Last error: \(error)")
            }
        }
    }

    guard let plan else {
        throw W2Error("no plan produced")
    }

    let workflowId = try await materialize(plan: plan, ask: ask, recorder: recorder)
    log.info("workflow \(workflowId) ready — launching via \(runnerBinary)...")
    try await runRunner(workflowId: workflowId, ask: ask)
}

// MARK: - Inventory

// real I/O — side effects must not hide inside assert() (debug-only)
private func ensureOpenloopDirs() throws {
    let base = Paths.curDir.appending(Paths.dataFolderName)
    for sub in [personasFolder, knowledgeFolder, workflowsFolder] {
        let dir = base.appending(sub)
        guard PathIO.createDirectoryIfNotExists(atPath: dir.string) else {
            throw W2Error("failed to ensure \(dir.string)")
        }
    }
}

private func topMostOpenloopAncestor() -> FilePath {
    var parent = Paths.curDir
    for dir in Paths.dirsToHome() {
        if PathIO.isDirectoryExistent(atPath: dir.appending(Paths.dataFolderName).string) {
            parent = dir
        }
    }
    return parent
}

private func collectInventory() -> [InventoryDir] {
    let all = Paths.dirsToHome()
    assert(all.first == Paths.curDir, "dirsToHome() starts at curDir — the 'parent' relation depends on it")
    var result: [InventoryDir] = []
    for (idx, dir) in all.enumerated() {
        let openloop = dir.appending(Paths.dataFolderName)
        guard PathIO.isDirectoryExistent(atPath: openloop.string) else { continue }
        let relation: String
        if dir == Paths.curDir { relation = "cur" }
        else if idx == 1 { relation = "parent" }
        else { relation = "ancestor-\(idx)" }
        result.append(InventoryDir(
            path: dir.string,
            relation: relation,
            personas: listPersonas(in: openloop),
            workflows: listWorkflows(in: openloop)
        ))
    }
    return result
}

private func listPersonas(in openloop: FilePath) -> [InventoryPersona] {
    let dir = openloop.appending(personasFolder)
    guard let names = try? PathIO.contentsOfDirectory(atPath: dir.string) else {
        log.warn("failed to list personas in \(dir.string) — reporting none")
        return []
    }
    return names.filter { $0.hasSuffix(dataFileSuffix) }.map { fname in
        let id = String(fname.dropLast(dataFileSuffix.count))
        let fp = dir.appending(fname)
        var name = ""
        var role = ""
        var about = ""
        var task = ""
        if let data = FileManager.default.contents(atPath: fp.string),
           let p = try? json5Decoder.decode(Persona.self, from: data) {
            name = p.name
            role = p.role
            about = p.about
            task = p.task
        } else {
            log.warn("failed to parse \(fp.string) — including \(id) with empty metadata")
        }
        return InventoryPersona(id: id, name: name, role: role, about: about, task: task)
    }
}

private func listWorkflows(in openloop: FilePath) -> [InventoryWorkflow] {
    let dir = openloop.appending(workflowsFolder)
    guard let names = try? PathIO.contentsOfDirectory(atPath: dir.string) else {
        log.warn("failed to list workflows in \(dir.string) — reporting none")
        return []
    }
    return names.filter { $0.hasSuffix(dataFileSuffix) }.map { fname in
        let id = String(fname.dropLast(dataFileSuffix.count))
        let fp = dir.appending(fname)
        var name = ""
        var desc = ""
        if let data = FileManager.default.contents(atPath: fp.string),
           let w = try? json5Decoder.decode(Workflow.self, from: data) {
            name = w.name
            desc = w.desc
        } else {
            log.warn("failed to parse \(fp.string) — including \(id) with empty metadata")
        }
        return InventoryWorkflow(id: id, name: name, desc: desc)
    }
}

// MARK: - Prompt

private func buildPrompt(inventory: [InventoryDir], ask: String) throws -> String {
    let data = try snakeCaseEncoder.encode(inventory)
    guard let invJSON = String(data: data, encoding: .utf8) else {
        assertionFailure("JSONEncoder output is always valid UTF-8")
        throw W2Error("failed to UTF-8 encode inventory JSON")
    }

    return """
Openloop is a tool that enabled a team of AI personas to work on a single task within a project. To accomplish this openloop relies on workflows and personas, each workflow consists of personas executing in order in order to complete a given task. 
You are the team architect and your job is to assemble a team. Design a persona team to accomplish a user task, then return team structure (workflow + personas) as JSON.

TASK (user ask):
\(ask)

EXISTING OPENLOOP INSTANCES (project hierarchy, nearest-first). REUSE these personas/workflows by id wherever they fit:
\(invJSON)

PERSONA MARKETPLACE — discover additional personas with curl (parse with jq):
  GET \(getsvenBase)/api/personas             list all
  GET \(getsvenBase)/api/personas?q=<query>   search name/role/about
  GET \(getsvenBase)/api/personas/{id}        detail: name, role, about, system_prompt, task, avatar, knowledge_files

RULES:
1. REUSE existing personas/workflows wherever they fit — reference them by their existing id. Mandatory when a fitting one already exists in the cur or a parent instance.
2. For NEW personas, pick them from the marketplace (by slug or UUID) and list their ids in "personas[]". We fetch each from the marketplace and installs it locally under that SAME id — so use that exact id when referencing the persona in any workflow's levels. Do NOT list personas that already exist locally.
3. levels is the plan, top-to-bottom. Each row runs AFTER the one above; personas in the SAME row run in parallel. A persona receives context ONLY from the row directly above it (its parent level) — personas on the SAME row do NOT see each other's output, so they run blind to one another. Be deliberate when putting 2 or more personas on the same row: only do it when they genuinely don't need each other's input (otherwise stack them in separate rows). Each entry is a persona id (existing, or new from personas[]) or ":<workflow-id>" to nest a workflow. Example:
   "levels": [
     [ "ceo" ],                        // top: plans and delegates
     [ "designer", "brand-marketer" ], // middle: run in parallel
     [ ":dev-ios" ]                    // bottom: nests the dev-ios workflow below
   ]
   where ":dev-ios" is itself a small reusable workflow, e.g.:
   "levels": [
     [ "only-tests" ],   // writes tests up front, no implementation
     [ "developer" ],    // implements until the tests pass
     [ "code-reviewer" ] // applies project-specific style, catches gotchas
   ]
4. Inner workflows (composition): a ":<workflow-id>" entry references another workflow that behaves exactly like a persona — it receives the previous level's output as input, and its own final result is piped forward to the next level. The referenced workflow MUST already exist (cur or a parent instance) OR be another workflow you output in "workflows[]". You may output 1 or more workflows — the FIRST one is the main/entry workflow that gets run; output just that one if you only reuse existing inner workflows.
5. You only provide id, name, desc, levels for each workflow. w2 sets the rest automatically: every_secs=0 (one-shot), agent="\(derivedAgent)", and ask (the user ask for the main workflow, "" for inner ones).

OUTPUT: print ONLY a JSON object wrapped exactly between these sentinel lines, no prose, no markdown fences:
\(jsonSentinelStart)
{ ... }
\(jsonSentinelEnd)

JSON SCHEMA:
{
  "workflows": [
    {
      "id": "<workflow-id>",                  // required: filename + ":ref" target (slug-like; must not collide with existing local workflows)
      "name": "...",                          // optional (defaults to id)
      "desc": "...",                          // optional (defaults to "")
      "levels": [["<persona-id>", ...], ...]  // required, top-to-bottom
    }
  ],
  "personas": ["<marketplace-slug-or-uuid>", ...]   // NEW personas to fetch; installed locally under this id; must match the ids used in levels; omit/empty if you only reuse existing personas
}

Constraints:
- The FIRST workflow in workflows[] is the main/entry workflow that w2 runs.
- Every persona id used in any workflow.levels must either exist locally already (cur/parent instance) or be listed in personas[].
- Every ":<workflow-id>" must reference an existing workflow (cur/parent instance) or another workflow in workflows[].
- workflow ids must be unique and must not collide with existing local workflow ids.
- personas[] may be empty/omitted if you reuse only existing personas.
"""
}

// MARK: - cc_docker call

private func callCCdocker(prompt: String, parent: FilePath) async throws -> String {
    let script = Paths.bin.appending(ccAgentScript)
    guard PathIO.isFileExistent(atPath: script.string) else {
        throw W2Error("\(ccAgentScript) not found at \(script.string)")
    }
    guard let raw = try await exec(
        script.string,
        args: [parent.string, headlessPersonaArg, prompt, "", planModeArg],
        chroot: Paths.curDir.string
    ) else {
        throw W2Error("\(ccAgentScript) produced no output")
    }
    return raw
}

private func extractBlock(_ raw: String) -> String {
    if let s = raw.range(of: jsonSentinelStart),
       let e = raw.range(of: jsonSentinelEnd, range: s.upperBound..<raw.endIndex) {
        return String(raw[s.upperBound..<e.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if let s = raw.range(of: jsonFenceStart),
       let e = raw.range(of: jsonFenceEnd, range: s.upperBound..<raw.endIndex) {
        return String(raw[s.upperBound..<e.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return raw.trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - Parse + validate

private func parseAndValidate(block: String, invPersonaIds: Set<String>, invWorkflowIds: Set<String>) throws -> Plan {
    let plan: Plan
    do {
        plan = try snakeCaseDecoder.decode(Plan.self, from: Data(block.utf8))
    } catch {
        throw W2Error("Invalid JSON: \(error)")
    }
    try validate(plan: plan, invPersonaIds: invPersonaIds, invWorkflowIds: invWorkflowIds)
    return plan
}

private func validate(plan: Plan, invPersonaIds: Set<String>, invWorkflowIds: Set<String>) throws {
    let wfs = plan.workflows
    guard wfs.notEmpty else {
        throw W2Error("workflows must be a non-empty array (the first one is the main/entry workflow)")
    }

    for wf in wfs {
        guard wf.id.notEmpty else {
            throw W2Error("each workflow needs a non-empty 'id'")
        }
        guard wf.levels.notEmpty else {
            throw W2Error("workflow \(wf.id).levels must be a non-empty array of arrays")
        }
        for level in wf.levels {
            for entry in level {
                guard entry.notEmpty else {
                    throw W2Error("workflow \(wf.id).levels contains an empty string")
                }
            }
        }
    }

    let wfIds = wfs.map(\.id)
    guard Set(wfIds).count == wfIds.count else {
        throw W2Error("workflow ids must be unique")
    }
    let wfOverlap = wfIds.filter { invWorkflowIds.contains($0) }
    if wfOverlap.notEmpty {
        throw W2Error("workflow ids collide with existing local workflows: \(wfOverlap)")
    }

    for wf in wfs {
        let f = workflowFilePath(id: wf.id)
        if PathIO.isFileExistent(atPath: f) {
            throw W2Error("refusing to overwrite existing workflow file: \(f)")
        }
    }

    let fetchIds = Set(plan.personaIds)
    let wfIdSet = Set(wfIds)
    for wf in wfs {
        let unknown = wf.levels.flatMap(\.self).filter { entry in
            if entry.hasPrefix(":") {
                let ref = String(entry.dropFirst())
                return !wfIdSet.contains(ref) && !invWorkflowIds.contains(ref)
            }
            return !fetchIds.contains(entry) && !invPersonaIds.contains(entry)
        }
        if unknown.notEmpty {
            throw W2Error("workflow \(wf.id).levels references unknown ids (not an existing/fetched persona, not an existing/created workflow): \(unknown)")
        }
    }

    let pids = plan.personaIds
    guard Set(pids).count == pids.count else {
        throw W2Error("personas[] ids must be unique")
    }
}

private func workflowFilePath(id: String) -> String {
    Paths.curDir
        .appending(Paths.dataFolderName).appending(workflowsFolder)
        .appending(id + dataFileSuffix).string
}

// MARK: - Materialize

private func materialize(plan: Plan, ask: String, recorder: CleanupRecorder) async throws -> String {
    assert(plan.workflows.notEmpty, "validate() guarantees at least one workflow")

    let personasDir = Paths.curDir.appending(Paths.dataFolderName).appending(personasFolder)
    let knowledgeDir = Paths.curDir.appending(Paths.dataFolderName).appending(knowledgeFolder)
    for dir in [personasDir, knowledgeDir] {
        guard PathIO.createDirectoryIfNotExists(atPath: dir.string) else {
            throw W2Error("failed to create \(dir.string)")
        }
    }

    for pid in plan.personaIds {
        let personaFile = personasDir.appending(pid + dataFileSuffix)
        if PathIO.isFileExistent(atPath: personaFile.string) {
            log.warn("persona \(pid) already exists locally — skipping fetch")
            continue
        }
        let kdir = knowledgeDir.appending(pid)
        guard PathIO.createDirectoryIfNotExists(atPath: kdir.string) else {
            throw W2Error("failed to create \(kdir.string)")
        }
        try await fetchRemotePersona(remote: pid, outFile: personaFile, kdir: kdir)
        recorder.record(personaFile.string)
        recorder.record(kdir.string)
    }

    for (i, wf) in plan.workflows.enumerated() {
        try await writeWorkflow(wf, ask: i == 0 ? ask : "", recorder: recorder)
    }

    return plan.workflows[0].id
}

private func writeWorkflow(_ wf: PlanWorkflow, ask: String, recorder: CleanupRecorder) async throws {
    let wfDir = Paths.curDir.appending(Paths.dataFolderName).appending(workflowsFolder)
    guard PathIO.createDirectoryIfNotExists(atPath: wfDir.string) else {
        throw W2Error("failed to create \(wfDir.string)")
    }
    let wfFile = wfDir.appending(wf.id + dataFileSuffix)
    let workflow = Workflow(
        name: wf.resolvedName,
        desc: wf.resolvedDesc,
        everySecs: oneShotEverySecs,
        agent: derivedAgent,
        ask: ask,
        levels: wf.levels
    )
    try await writeJSON(workflow, to: wfFile)
    recorder.record(wfFile.string)
}

private func runRunner(workflowId: String, ask: String) async throws {
    let runner = Paths.bin.appending(runnerBinary)
    guard PathIO.isFileExistent(atPath: runner.string) else {
        throw W2Error("\(runnerBinary) not found at \(runner.string)")
    }
    _ = try await exec(runner.string, args: [workflowId, ask], chroot: Paths.curDir.string)
}

// MARK: - Marketplace

private func fetchRemotePersona(remote: String, outFile: FilePath, kdir: FilePath) async throws {
    let detail = try await getJSON(PersonaDetail.self, url: "\(getsvenBase)/api/personas/\(remote)")
    let persona = Persona(
        name: detail.name,
        role: detail.role,
        about: detail.about,
        task: detail.task,
        avatar: detail.avatar,
        agent: nil
    )
    try await writeJSON(persona, to: outFile)

    for kf in detail.knowledgeFileRefs {
        assert(kf.filename.notEmpty, "knowledge file reference must carry a non-empty filename")
        guard let resp = try? await getJSON(KnowledgeFileResponse.self,
                                            url: "\(getsvenBase)/api/personas/\(remote)/knowledge/\(kf.filename)") else {
            log.warn("failed to fetch knowledge file \(kf.filename) for \(remote) — skipping")
            continue
        }
        try await writeString(resp.file.contentMd, to: kdir.appending(kf.filename))
    }
}

private func getJSON<T: Decodable>(_ type: T.Type, url urlString: String) async throws -> T {
    guard let url = URL(string: urlString) else {
        throw W2Error("invalid url: \(urlString)")
    }
    var headers: [String: String] = [:]
    if let key = getsvenKey, key.notEmpty {
        headers["Authorization"] = "Bearer \(key)"
    }
    let (data, http) = try await Net.get(url, headers: headers)
    guard httpOKStatuses.contains(http.statusCode) else {
        throw W2Error("request failed (\(http.statusCode)): \(urlString)")
    }
    do {
        return try snakeCaseDecoder.decode(T.self, from: data)
    } catch {
        throw W2Error("failed to decode response from \(urlString): \(error)")
    }
}

// MARK: - File writes

private func writeJSON<T: Encodable>(_ value: T, to fp: FilePath) async throws {
    let data = try snakeCaseEncoder.encode(value)
    guard await File(fp.string).write(data) else {
        throw W2Error("failed to write \(fp.string)")
    }
}

private func writeString(_ s: String, to fp: FilePath) async throws {
    let ok = await File(fp.string).write(Data(s.utf8))
    guard ok else {
        throw W2Error("failed to write \(fp.string)")
    }
}

// MARK: - Cleanup

private final class CleanupRecorder {
    private var paths: [String] = []
    fileprivate func record(_ p: String) { paths.append(p) }
    fileprivate func cleanup() {
        for p in paths {
            if PathIO.isFileExistent(atPath: p) {
                do { try FileManager.default.removeItem(atPath: p) } catch { log.warn("cleanup: failed to remove \(p): \(error)") }
            } else if PathIO.isDirectoryExistent(atPath: p) {
                if !PathIO.deleteDirectoryAndItsContents(atPath: p) { log.warn("cleanup: failed to remove \(p)") }
            }
        }
    }
}

// MARK: - Models

private struct InventoryDir: Encodable {
    let path: String
    let relation: String
    let personas: [InventoryPersona]
    let workflows: [InventoryWorkflow]
}
private struct InventoryPersona: Encodable { let id: String; let name: String; let role: String; let about: String; let task: String }
private struct InventoryWorkflow: Encodable { let id: String; let name: String; let desc: String }

private struct Plan: Decodable {
    let workflows: [PlanWorkflow]
    let personas: [String]?
}
private extension Plan {
    var personaIds: [String] {
        guard let personas else { return [] } // schema: personas[] may be omitted (reuse-only plan)
        return personas
    }
}
private struct PlanWorkflow: Decodable {
    let id: String
    let name: String?
    let desc: String?
    let levels: [[String]]
}
private extension PlanWorkflow {
    var resolvedName: String {
        guard let name else { return id } // schema: name is optional and defaults to the id
        return name
    }
    var resolvedDesc: String {
        guard let desc else { return "" } // schema: desc is optional and defaults to ""
        return desc
    }
}

private struct PersonaDetail: Decodable {
    let name: String
    let role: String
    let about: String
    let task: String
    let avatar: String?
    let knowledgeFiles: [KFileRef]?
}
private extension PersonaDetail {
    var knowledgeFileRefs: [KFileRef] {
        guard let knowledgeFiles else {
            assertionFailure("persona detail without knowledge_files — the getsven contract always includes it")
            return []
        }
        return knowledgeFiles
    }
}
private struct KFileRef: Decodable { let filename: String }
private struct KnowledgeFileResponse: Decodable { let file: KnowledgeFileContent }
private struct KnowledgeFileContent: Decodable { let filename: String?; let contentMd: String }

// MARK: - Codables

private let snakeCaseDecoder: JSONDecoder = {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
}()

private let json5Decoder: JSONDecoder = {
    let d = JSONDecoder()
    d.allowsJSON5 = true
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
}()

private let snakeCaseEncoder: JSONEncoder = {
    let e = JSONEncoder()
    e.keyEncodingStrategy = .convertToSnakeCase
    e.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
    return e
}()
