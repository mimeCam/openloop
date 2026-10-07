import Vapor
import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import shared

actor GraphRunRegistry {
    static let shared = GraphRunRegistry()

    private var live: Set<String> = []

    func add(_ id: String) {
        live.insert(id)
    }

    func remove(_ id: String) {
        live.remove(id)
    }

    func isLive(_ id: String) -> Bool {
        live.contains(id)
    }
}

struct GraphHandler: Sendable {

    func list(req: Request) async throws -> GraphNodesResponse {
        let instancePath = try instancePathFrom(req)
        do {
            try GraphStore.createTables(at: instancePath)
            try await sweepInterrupted(instancePath: instancePath)
            try await sweepRunLogs(instancePath: instancePath)
            return GraphNodesResponse(nodes: try graphContents(at: instancePath))
        } catch {
            req.logger.error("Failed to fetch graph nodes: \(error)")
            throw Abort(.internalServerError)
        }
    }

    func create(req: Request) async throws -> GraphNodeContent {
        let instancePath = try instancePathFrom(req)
        let body = try req.content.decode(GraphCreateRequest.self)
        try validateCreate(body, instancePath: instancePath)
        return try await launchNode(body, instancePath: instancePath)
    }

    func agents(req: Request) async throws -> AgentsResponse {
        let files = (try? PathIO.contentsOfDirectory(atPath: Paths.bin.string)) ?? []
        let agents = files
            .filter(isRunnerScript)
            .sorted()
            .map { AgentEntry(name: String($0.dropFirst("openloop_".count))) }
        return AgentsResponse(agents: agents)
    }

    func update(req: Request) async throws -> GraphNodeContent {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        let body = try req.content.decode(GraphUpdateRequest.self)
        try applyUpdates(nodeId: nodeId, body: body, instancePath: instancePath)
        guard let node = try findNode(id: nodeId, at: instancePath) else {
            throw Abort(.notFound, reason: "Node not found: \(nodeId)")
        }
        return try contentWithStats(node, at: instancePath)
    }

    func regenSummary(req: Request) async throws -> GraphNodeContent {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        let node = try regenTarget(id: nodeId, at: instancePath)
        let script = try resolveScript(for: node.agent)
        await GraphRunRegistry.shared.add(nodeId)
        try rerunIfEdited(req, node: node, script: script, instancePath: instancePath)
        let fresh = try findNode(id: nodeId, at: instancePath) ?? node
        return try contentWithStats(fresh, at: instancePath)
    }

    func run(req: Request) async throws -> GraphRunLogContent {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        let body = try req.content.decode(GraphRunRequest.self)
        guard body.prompt.trimmingCharacters(in: .whitespacesAndNewlines).notEmpty else {
            throw Abort(.badRequest, reason: "prompt must not be empty")
        }
        return toContent(try await runLogFor(nodeId: nodeId, prompt: body.prompt, at: instancePath))
    }

    func logs(req: Request) async throws -> GraphRunLogsResponse {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        guard try findNode(id: nodeId, at: instancePath) != nil else {
            throw Abort(.notFound, reason: "Node not found: \(nodeId)")
        }
        let rows = try GraphStore.fetchRunLogs(nodeId: nodeId, at: instancePath)
        return GraphRunLogsResponse(logs: rows.map(toContent))
    }

    func delete(req: Request) async throws -> GraphNodesResponse {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        let chain = req.query[Bool.self, at: "chain"] == true
        return try await deleteTarget(id: nodeId, chain: chain, instancePath: instancePath)
    }
}

private extension GraphHandler {

    func validateCreate(_ body: GraphCreateRequest, instancePath: String) throws {
        guard body.prompt.notEmpty else {
            throw Abort(.badRequest, reason: "prompt must not be empty")
        }
        guard PathIO.isDirectoryExistent(atPath: instancePath) else {
            throw Abort(.badRequest, reason: "Instance dir not found: \(instancePath)")
        }
    }

    func launchNode(_ body: GraphCreateRequest, instancePath: String) async throws -> GraphNodeContent {
        let script = try resolveScript(for: body.agent)
        let parentId = try resolveParentId(body, instancePath: instancePath)
        let node = makeNode(body, parentId: parentId)
        try GraphStore.createTables(at: instancePath)
        try GraphStore.insertNode(node, at: instancePath)
        try reparentTarget(of: body.insert_before, to: node.id, at: instancePath)
        await GraphRunRegistry.shared.add(node.id)
        detachLifecycle(node, script: script, instancePath: instancePath)
        return toContent(node)
    }

    func makeNode(_ body: GraphCreateRequest, parentId: String?) -> GraphNode {
        GraphNode(
            id: UUID().uuidString,
            parentId: parentId,
            prompt: body.prompt,
            agent: body.agent,
            status: "progress",
            output: nil,
            took: nil,
            mcp: normalized(body.mcp),
            mcpAuth: normalized(body.mcp_auth),
            createdAt: Date().timeIntervalSinceReferenceDate,
            completedAt: nil
        )
    }

    func normalized(_ value: String?) -> String? {
        value.flatMap { $0.isEmpty ? nil : $0 }
    }

    func applyUpdates(nodeId: String, body: GraphUpdateRequest, instancePath: String) throws {
        if let mcp = body.mcp { try GraphStore.updateMcp(id: nodeId, mcp: normalized(mcp), at: instancePath) }
        if let auth = body.mcp_auth { try GraphStore.updateMcpAuth(id: nodeId, auth: normalized(auth), at: instancePath) }
        if let active = body.active { try GraphStore.updateActive(id: nodeId, active: active, at: instancePath) }
        try applyDetailUpdates(nodeId: nodeId, body: body, instancePath: instancePath)
    }

    func applyDetailUpdates(nodeId: String, body: GraphUpdateRequest, instancePath: String) throws {
        if let summary = body.summary, summary.notEmpty {
            try GraphStore.updateSummary(id: nodeId, summary: summary, at: instancePath)
        }
        if let personas = body.personas {
            try GraphStore.updatePersonas(id: nodeId, personas: personas, at: instancePath)
        }
    }

    func instancePathFrom(_ req: Request) throws -> String {
        guard let raw = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }
        return raw.removingPercentEncoding ?? raw
    }

    func nodeIdFrom(_ req: Request) throws -> String {
        guard let raw = req.parameters.get("nid") else {
            throw Abort(.badRequest)
        }
        return raw.removingPercentEncoding ?? raw
    }

    func findNode(id: String, at instancePath: String) throws -> GraphNode? {
        try GraphStore.fetchNodes(at: instancePath).first { $0.id == id }
    }

    var deleteBusyReason: String { "Still running — let the run finish, then delete." }

    func deleteTarget(id: String, chain: Bool, instancePath: String) async throws -> GraphNodesResponse {
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        guard let node = nodes.first(where: { $0.id == id }) else {
            throw Abort(.notFound, reason: "Node not found: \(id)")
        }
        let ids = chain ? GraphStore.subtreeIds(of: node, in: nodes) : Set([node.id])
        try await assertDeletable(ids, nodes: nodes, instancePath: instancePath)
        if chain { try GraphStore.deleteNodes(ids: ids, at: instancePath) }
        else { try GraphStore.deleteNode(id: node.id, at: instancePath) }
        return GraphNodesResponse(nodes: try graphContents(at: instancePath))
    }

    func assertDeletable(_ ids: Set<String>, nodes: [GraphNode], instancePath: String) async throws {
        let busy = nodes.filter { ids.contains($0.id) && isRunning($0.status) }
        guard busy.isEmpty else { throw Abort(.conflict, reason: deleteBusyReason) }
        try await assertNoLiveRuns(ids, instancePath: instancePath)
    }

    func assertNoLiveRuns(_ ids: Set<String>, instancePath: String) async throws {
        for id in ids {
            if await GraphRunRegistry.shared.isLive(id) { throw Abort(.conflict, reason: deleteBusyReason) }
        }
        for log in try GraphStore.fetchProgressRunLogs(at: instancePath) where ids.contains(log.nodeId) {
            if await GraphRunRegistry.shared.isLive(log.id) { throw Abort(.conflict, reason: deleteBusyReason) }
        }
    }

    func isRunning(_ status: String) -> Bool {
        status == "progress" || status == "summarizing"
    }

    func resolveScript(for agent: String) throws -> FilePath {
        let script = Paths.bin.appending("openloop_\(agent)")
        guard PathIO.isFileExistent(atPath: script.string) else {
            throw Abort(.badRequest, reason: "Unknown agent: \(agent)")
        }
        return script
    }

    func isRunnerScript(_ file: String) -> Bool {
        guard file.hasPrefix("openloop_") else { return false }
        let body = file.dropFirst("openloop_".count)
        guard let r = body.range(of: "_docker") else { return false }
        let variant = body[r.upperBound...]
        guard variant.hasPrefix("-"), variant.count > 1 else { return false }
        return !["base", "swift", "swiftbridge"].contains(String(variant.dropFirst()))
    }

    func resolveParentId(
        _ body: GraphCreateRequest,
        instancePath: String
    ) throws -> String? {
        guard let target = body.insert_before else { return body.parent_id }
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        guard let existing = nodes.first(where: { $0.id == target }) else {
            throw Abort(.badRequest, reason: "Node not found: \(target)")
        }
        return existing.parentId
    }

    func reparentTarget(
        of insertBefore: String?,
        to newId: String,
        at instancePath: String
    ) throws {
        guard let target = insertBefore else { return }
        try GraphStore.updateParent(id: target, parent: newId, at: instancePath)
    }

    func sweepInterrupted(instancePath: String) async throws {
        let stale = try GraphStore.fetchNodes(at: instancePath).filter {
            $0.status == "progress" || $0.status == "summarizing"
        }
        for node in stale where !(await GraphRunRegistry.shared.isLive(node.id)) {
            try sweepNode(node, at: instancePath)
        }
    }

    func sweepNode(_ node: GraphNode, at instancePath: String) throws {
        if node.status == "summarizing" {
            return try GraphStore.updateStatus(id: node.id, status: "answered", at: instancePath)
        }
        try GraphStore.updateNode(id: node.id, status: "failed", output: "interrupted", took: nil, at: instancePath)
    }

    func regenTarget(id: String, at instancePath: String) throws -> GraphNode {
        guard let node = try findNode(id: id, at: instancePath) else {
            throw Abort(.notFound, reason: "Node not found: \(id)")
        }
        if node.status == "summarizing" {
            throw Abort(.conflict, reason: "Summary already in progress")
        }
        guard ["answered", "success"].contains(node.status) else {
            throw Abort(.badRequest, reason: "Node has no answer to summarize")
        }
        return node
    }

    func detachSummary(id: String, script: FilePath, instancePath: String) {
        Task.detached {
            await maybeSummarize(id: id, script: script, instancePath: instancePath)
        }
    }

    func detachLifecycle(_ node: GraphNode, script: FilePath, instancePath: String) {
        Task.detached { await runLifecycle(node, script: script, instancePath: instancePath) }
    }

    func rerunIfEdited(_ req: Request, node: GraphNode, script: FilePath, instancePath: String) throws {
        guard let prompt = editedPrompt(req, current: node.prompt), prompt != node.prompt else {
            try GraphStore.updateStatus(id: node.id, status: "summarizing", at: instancePath)
            detachSummary(id: node.id, script: script, instancePath: instancePath)
            return
        }
        try GraphStore.updatePrompt(id: node.id, prompt: prompt, at: instancePath)
        try GraphStore.updateNode(id: node.id, status: "progress", output: nil, took: nil, at: instancePath)
        guard let fresh = try findNode(id: node.id, at: instancePath) else { return }
        detachLifecycle(fresh, script: script, instancePath: instancePath)
    }

    func editedPrompt(_ req: Request, current: String) -> String? {
        guard let body = try? req.content.decode(GraphSummaryRequest.self),
              let prompt = body.prompt?.trimmingCharacters(in: .whitespacesAndNewlines),
              prompt.notEmpty else { return nil }
        return prompt
    }

    func graphContents(at instancePath: String) throws -> [GraphNodeContent] {
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        let counts = (try? GraphStore.fetchRunCounts(at: instancePath)) ?? [:]
        return nodes.map {
            toContent($0, counts: counts[$0.id] ?? RunCounts(), runnable: isChainReady($0, nodes: nodes))
        }
    }

    func contentWithStats(_ node: GraphNode, at instancePath: String) throws -> GraphNodeContent {
        let counts = (try? GraphStore.fetchRunCounts(at: instancePath))?[node.id] ?? RunCounts()
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        return toContent(node, counts: counts, runnable: isChainReady(node, nodes: nodes))
    }

    func isChainReady(_ node: GraphNode, nodes: [GraphNode]) -> Bool {
        GraphStore.chain(of: node, in: nodes).allSatisfy { $0.status == "success" }
    }

    func runLogFor(nodeId: String, prompt: String, at instancePath: String) async throws -> GraphRunLog {
        guard let node = try findNode(id: nodeId, at: instancePath) else { throw Abort(.notFound, reason: "Node not found: \(nodeId)") }
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        let chain = GraphStore.chain(of: node, in: nodes)
        guard chain.allSatisfy({ $0.status == "success" }) else { throw Abort(.badRequest, reason: "Chain not ready — parents need summaries") }
        let logId = UUID().uuidString
        let ctxPath = try writeContext(chain, id: logId)
        let mcpPath = GraphStore.writeMcpConfig(GraphStore.chainMcpEndpoints(chain), runId: logId)
        return try await scheduleRunLog(node, prompt: prefixedPrompt(prompt, ctxPath), logId: logId, mcpPath: mcpPath, at: instancePath)
    }

    func newRunLog(id: String, nodeId: String, prompt: String) -> GraphRunLog {
        GraphRunLog(
            id: id, nodeId: nodeId, prompt: prompt, status: "progress",
            output: nil, took: nil, createdAt: Date().timeIntervalSinceReferenceDate, completedAt: nil
        )
    }

    func scheduleRunLog(
        _ node: GraphNode, prompt: String, logId: String, mcpPath: String?, at instancePath: String
    ) async throws -> GraphRunLog {
        let script = try resolveScript(for: node.agent)
        let log = newRunLog(id: logId, nodeId: node.id, prompt: prompt)
        await GraphRunRegistry.shared.add(log.id)
        try GraphStore.insertRunLog(log, at: instancePath)
        Task.detached { await executeRunLog(log, script: script, instancePath: instancePath, mcpPath: mcpPath) }
        return log
    }

    func sweepRunLogs(instancePath: String) async throws {
        let stale = try GraphStore.fetchProgressRunLogs(at: instancePath)
        for log in stale where !(await GraphRunRegistry.shared.isLive(log.id)) {
            try GraphStore.updateRunLog(
                id: log.id, status: "failed", output: "interrupted", took: nil, at: instancePath
            )
        }
    }

    func toContent(_ log: GraphRunLog) -> GraphRunLogContent {
        GraphRunLogContent(
            id: log.id, node_id: log.nodeId, prompt: log.prompt, status: log.status,
            output: log.output, took: log.took,
            created_at: unixMs(log.createdAt), completed_at: log.completedAt.map(unixMs)
        )
    }

    func toContent(_ node: GraphNode, counts: RunCounts = RunCounts(), runnable: Bool = false) -> GraphNodeContent {
        GraphNodeContent(
            id: node.id, parent_id: node.parentId, prompt: node.prompt, agent: node.agent,
            status: node.status, output: node.output, took: node.took, mcp: node.mcp,
            mcp_auth: node.mcpAuth,
            summary: node.summary, personas: node.personas, active: node.active, runnable: runnable,
            runs: RunCountsContent(total: counts.total, success: counts.success, failed: counts.failed),
            created_at: unixMs(node.createdAt), completed_at: node.completedAt.map(unixMs)
        )
    }

    func unixMs(_ refInterval: Double) -> Int64 {
        Int64(Date(timeIntervalSinceReferenceDate: refInterval).timeIntervalSince1970 * 1000)
    }
}

private func runLifecycle(
    _ node: GraphNode,
    script: FilePath,
    instancePath: String
) async {
    await runAnswerPhase(node, script: script, instancePath: instancePath)
    await maybeSummarize(id: node.id, script: script, instancePath: instancePath)
}

private func runAnswerPhase(_ node: GraphNode, script: FilePath, instancePath: String) async {
    let tb = TimedBenchmark()
    let run = await answerOnce(node, script: script, instancePath: instancePath)
    let answered = run.out?.notEmpty == true
    try? GraphStore.updateNode(
        id: node.id, status: answered ? "summarizing" : "failed", output: run.out ?? run.error,
        took: Int(tb.intervalSinceInitialized), at: instancePath
    )
    if !answered { await GraphRunRegistry.shared.remove(node.id) }
}

private func executeRunLog(_ log: GraphRunLog, script: FilePath, instancePath: String, mcpPath: String?) async {
    let tb = TimedBenchmark()
    let env = mcpPath.map { ["MCP_CONFIG_PATH": $0] }
    let out = (try? await exec(script.string, args: runArgs(log.prompt, instancePath), chroot: instancePath, env: env)) ?? nil
    let ok = out?.notEmpty == true
    try? GraphStore.updateRunLog(
        id: log.id, status: ok ? "success" : "failed", output: out,
        took: Int(tb.intervalSinceInitialized), at: instancePath
    )
    await GraphRunRegistry.shared.remove(log.id)
    cleanupRunArtifacts(log.id, mcpPath: mcpPath)
}

private func cleanupRunArtifacts(_ runId: String, mcpPath: String?) {
    deleteMcpConfig(mcpPath)
    GraphStore.deleteContextRunDir(runId)
}

private func deleteMcpConfig(_ path: String?) {
    guard let path, PathIO.isFileExistent(atPath: path) else { return }
    assert(PathIO.deleteDirectoryAndItsContents(atPath: path))
}

private func runDir(_ id: String) throws -> FilePath {
    let dir = GraphStore.contextRunDir(String(id.prefix(8)))
    guard PathIO.createDirectoryIfNotExists(atPath: dir.string) else {
        throw Abort(.internalServerError, reason: "Could not create ctx dir: \(dir.string)")
    }
    return dir
}

private func writeContext(_ chain: [GraphNode], id: String) throws -> String? {
    try writeIfNotEmpty(GraphStore.chainText(chain), in: try runDir(id), name: "ctx.md")
}

private func writeIfNotEmpty(_ text: String, in dir: FilePath, name: String) throws -> String? {
    guard text.notEmpty else { return nil }
    return try GraphStore.writeContextFile(text, in: dir, fileName: name).string
}

private func writeQa(_ node: GraphNode, id: String) throws -> (question: String, answer: String) {
    let dir = try runDir(id)
    return (
        try GraphStore.writeContextFile(node.prompt, in: dir, fileName: "question.md").string,
        try GraphStore.writeContextFile(node.output ?? "", in: dir, fileName: "answer.md").string
    )
}

private func chainArtifacts(_ node: GraphNode, at instancePath: String) -> (ctxPath: String?, mcpPath: String?) {
    let nodes = (try? GraphStore.fetchNodes(at: instancePath)) ?? []
    let chain = GraphStore.chain(of: node, in: nodes)
    return (
        (try? writeContext(chain, id: node.id)),
        GraphStore.writeMcpConfig(GraphStore.chainMcpEndpoints(chain), runId: node.id)
    )
}

private func prefixedPrompt(_ prompt: String, _ ctxPath: String?) -> String {
    ctxPath.map { "@\($0)\nContext files are read-only.\n\(prompt)" } ?? prompt
}

private func runScript(
    _ script: FilePath, args: [String], chroot: String, env: [String: String]?
) async -> (out: String?, error: String?) {
    do {
        let out = try await subprocess(script, args: args, chroot: FilePath(chroot), env: env)
        return (out, nil)
    } catch {
        return (nil, "\(error)")
    }
}

private func answerOnce(_ node: GraphNode, script: FilePath, instancePath: String) async -> (out: String?, error: String?) {
    let artifacts = chainArtifacts(node, at: instancePath)
    defer { deleteMcpConfig(artifacts.mcpPath) }
    let args = runArgs(prefixedPrompt(node.prompt, artifacts.ctxPath), instancePath)
    let env = artifacts.mcpPath.map { ["MCP_CONFIG_PATH": $0] }
    return await runScript(script, args: args, chroot: instancePath, env: env)
}

private func maybeSummarize(id: String, script: FilePath, instancePath: String) async {
    defer { GraphStore.deleteContextRunDir(id) }
    guard let node = try? GraphStore.fetchNodes(at: instancePath).first(where: { $0.id == id }),
          node.status == "summarizing" else {
        await GraphRunRegistry.shared.remove(id)
        return
    }
    await summarize(node, script: script, instancePath: instancePath)
}

private func summarize(_ node: GraphNode, script: FilePath, instancePath: String) async {
    let artifacts = chainArtifacts(node, at: instancePath)
    defer { deleteMcpConfig(artifacts.mcpPath) }
    guard let prompt = summaryPrompt(node, ctxPath: artifacts.ctxPath) else {
        await GraphRunRegistry.shared.remove(node.id)
        return
    }
    await runSummary(node, prompt: prompt, artifacts: artifacts, script: script, instancePath: instancePath)
}

private func runSummary(
    _ node: GraphNode, prompt: String, artifacts: (ctxPath: String?, mcpPath: String?),
    script: FilePath, instancePath: String
) async {
    let env = artifacts.mcpPath.map { ["MCP_CONFIG_PATH": $0] }
    let run = await runScript(script, args: runArgs(prompt, instancePath), chroot: instancePath, env: env)
    let trimmed = run.out?.trimmingCharacters(in: .whitespacesAndNewlines)
    try? GraphStore.finishSummary(
        id: node.id, summary: (trimmed?.isEmpty == true) ? nil : trimmed, at: instancePath
    )
    await GraphRunRegistry.shared.remove(node.id)
}

private let summaryInstruction = "Summarize the QUESTION and ANSWER below concisely, plain text, no preamble, just state the found fact, dont mention question/answer."

private func summaryPrompt(_ node: GraphNode, ctxPath: String?) -> String? {
    guard let qa = try? writeQa(node, id: node.id) else { return nil }
    return prefixedPrompt(
        "\(summaryInstruction)\n\nQUESTION: @\(qa.question)\n\nANSWER: @\(qa.answer)",
        ctxPath
    )
}

private func runArgs(_ prompt: String, _ instancePath: String) -> [String] {
    [topInstanceDir(instancePath), "_bottom_", prompt]
}

private func topInstanceDir(_ instancePath: String) -> String {
    Paths.dirsToHome(from: FilePath(instancePath))
        .last { dir in
            PathIO.isDirectoryExistent(atPath: dir.appending(Paths.dataFolderName).string)
        }?
        .string ?? instancePath
}

extension GraphHandler {
    struct GraphNodeContent: Content, Sendable {
        var id: String
        var parent_id: String?
        var prompt: String
        var agent: String
        var status: String
        var output: String?
        var took: Int?
        var mcp: String?
        var mcp_auth: String?
        var summary: String?
        var personas: [String]
        var active: Bool
        var runnable: Bool
        var runs: RunCountsContent
        var created_at: Int64
        var completed_at: Int64?
    }

    struct RunCountsContent: Content, Sendable {
        var total: Int
        var success: Int
        var failed: Int
    }

    struct GraphRunLogContent: Content, Sendable {
        var id: String
        var node_id: String
        var prompt: String
        var status: String
        var output: String?
        var took: Int?
        var created_at: Int64
        var completed_at: Int64?
    }

    struct GraphRunLogsResponse: Content, Sendable {
        var logs: [GraphRunLogContent]
    }

    struct GraphRunRequest: Content, Sendable {
        var prompt: String
    }

    struct GraphSummaryRequest: Content, Sendable {
        var prompt: String?
    }

    struct GraphNodesResponse: Content, Sendable {
        var nodes: [GraphNodeContent]
    }

    struct GraphCreateRequest: Content, Sendable {
        var prompt: String
        var parent_id: String?
        var insert_before: String?
        var agent: String
        var mcp: String?
        var mcp_auth: String?
    }

    struct GraphUpdateRequest: Content, Sendable {
        var mcp: String?
        var mcp_auth: String?
        var summary: String?
        var personas: [String]?
        var active: Bool?
    }

    struct AgentEntry: Content, Sendable {
        var name: String
    }

    struct AgentsResponse: Content, Sendable {
        var agents: [AgentEntry]
    }
}
