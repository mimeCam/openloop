import Vapor
import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import shared

private let runnerEnvSidecarSuffix = ".env"
private let baseScriptVariants: Set<String> = ["base", "swift", "swiftbridge"]
private let agentBinaryPrefix = "openloop_"

private actor GraphRunRegistry {

    private var live: Set<String> = []

    fileprivate func add(_ id: String) {
        live.insert(id)
    }

    fileprivate func remove(_ id: String) {
        live.remove(id)
    }

    fileprivate func isLive(_ id: String) -> Bool {
        live.contains(id)
    }
}

private let graphRunRegistry = GraphRunRegistry()

/// Boot-only guard for the stuck-audit sweep — `list` polls every 5s and cannot tell a crashed analysis from a live one; first poll after boot is the sweep.
private actor AuditSweepLedger {
    private var swept: Set<String> = []
    fileprivate func needsSweep(_ path: String) -> Bool { swept.insert(path).inserted }
}

private let auditSweepLedger = AuditSweepLedger()

struct GraphHandler: Sendable {

    func list(req: Request) async throws -> GraphNodesResponse {
        let instancePath = try instancePathFrom(req)
        do {
            try GraphStore.createTables(at: instancePath)
            try await sweepInterrupted(instancePath: instancePath)
            try await sweepRunLogs(instancePath: instancePath)
            GraphStore.sweepStaleRunArtifacts()
            if await auditSweepLedger.needsSweep(instancePath) {
                try? GraphStore.sweepStuckRunAudits(at: instancePath)
            }
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
        let files = try PathIO.contentsOfDirectory(atPath: Paths.bin.string)
        let agents = files
            .filter(isRunnerScript)
            .sorted()
            .map { name -> AgentEntry in
                assert(name.hasPrefix(agentBinaryPrefix), "isRunnerScript admits only \(agentBinaryPrefix)-prefixed scripts")
                return AgentEntry(name: String(name.dropFirst(agentBinaryPrefix.count)))
            }
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
        await graphRunRegistry.add(nodeId)
        try rerun(req, node: node, script: script, instancePath: instancePath)
        guard let fresh = try findNode(id: nodeId, at: instancePath) else {
            throw Abort(.internalServerError, reason: "Node vanished after rerun: \(nodeId)")
        }
        return try contentWithStats(fresh, at: instancePath)
    }

    func run(req: Request) async throws -> GraphRunLogContent {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        let body = try req.content.decode(GraphRunRequest.self)
        guard body.prompt.trimmingCharacters(in: .whitespacesAndNewlines).notEmpty else {
            throw Abort(.badRequest, reason: "prompt must not be empty")
        }
        return toContent(try await runLogFor(
            nodeId: nodeId, prompt: body.prompt, parentRunId: body.parent_run_id,
            refNodeIds: dedupeNodeIds(body.node_ids), at: instancePath
        ))
    }

    func retryRun(req: Request) async throws -> GraphRunLogContent {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        let runId = try runIdFrom(req)
        return try await retryRunLog(nodeId: nodeId, runId: runId, at: instancePath)
    }

    // Plain DELETE splices one turn; ?thread=true cascades the whole run
    // (the runs-list bin) — the same query-flag grammar as node ?chain=true.
    func deleteRun(req: Request) async throws -> GraphRunLogsResponse {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        let runId = try runIdFrom(req)
        if req.query[Bool.self, at: "thread"] == true {
            return try await deleteRunThread(runId: runId, anchor: nodeId, at: instancePath)
        }
        return try await deleteRunLog(runId: runId, anchor: nodeId, at: instancePath)
    }

    func updateRun(req: Request) async throws -> GraphRunLogContent {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        let runId = try runIdFrom(req)
        let body = try req.content.decode(GraphRunSummaryRequest.self)
        let summary = body.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard summary.notEmpty else { throw Abort(.badRequest, reason: "summary must not be empty") }
        try assertRunExists(runId, nodeId: nodeId, at: instancePath)
        try GraphStore.finishRunSummary(id: runId, summary: summary, at: instancePath)
        return try fetchedRun(runId, nodeId: nodeId, at: instancePath)
    }

    func logs(req: Request) async throws -> GraphRunLogsResponse {
        let instancePath = try instancePathFrom(req)
        let nodeId = try nodeIdFrom(req)
        try GraphStore.createTables(at: instancePath)
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
        guard normalized(body.mcp) != nil || normalized(body.mcp_auth) == nil else {
            throw Abort(.badRequest, reason: "mcp_auth requires an MCP URL")
        }
    }

    func launchNode(_ body: GraphCreateRequest, instancePath: String) async throws -> GraphNodeContent {
        let script = try resolveScript(for: body.agent)
        let parentId = try resolveParentId(body, instancePath: instancePath)
        let node = makeNode(body, parentId: parentId)
        try GraphStore.createTables(at: instancePath)
        try GraphStore.insertNode(node, at: instancePath)
        try storeCreateAuth(node, body, instancePath: instancePath)
        try reparentTarget(of: body.insert_before, to: node.id, at: instancePath)
        await graphRunRegistry.add(node.id)
        detachLifecycle(node, runId: UUID().uuidString, script: script, instancePath: instancePath)
        return toContent(node, secrets: SecretStore.load(at: instancePath))
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
            mcpRequiresAuth: normalized(body.mcp) != nil && normalized(body.mcp_auth) != nil,
            createdAt: Date().timeIntervalSinceReferenceDate,
            completedAt: nil
        )
    }

    // The create-time key goes to the machine-local secrets store keyed by
    // the new node's URL (validated above: a key without a URL is a 400).
    func storeCreateAuth(_ node: GraphNode, _ body: GraphCreateRequest, instancePath: String) throws {
        guard let url = node.mcp, url.notEmpty, let auth = normalized(body.mcp_auth) else { return }
        try SecretStore.setSecret(auth, for: url, at: instancePath)
    }

    func normalized(_ value: String?) -> String? {
        value.flatMap { $0.isEmpty ? nil : $0 }
    }

    func applyUpdates(nodeId: String, body: GraphUpdateRequest, instancePath: String) throws {
        if let mcp = body.mcp { try GraphStore.updateMcp(id: nodeId, mcp: normalized(mcp), at: instancePath) }
        if let auth = body.mcp_auth { try applyMcpAuthUpdate(nodeId: nodeId, auth: auth, instancePath: instancePath) }
        if let name = body.name { try GraphStore.updateName(id: nodeId, name: normalized(name), at: instancePath) }
        if let active = body.active { try GraphStore.updateActive(id: nodeId, active: active, at: instancePath) }
        if let agent = body.agent { try applyAgentUpdate(nodeId: nodeId, agent: agent, instancePath: instancePath) }
        try applyDetailUpdates(nodeId: nodeId, body: body, instancePath: instancePath)
    }

    // mcp_auth on the wire is WRITE-ONLY: set/replace (non-empty, stored in
    // the per-machine secrets file keyed by the node's URL) or clear (empty
    // string — normalized to nil). A key with no URL has nowhere to live —
    // 400 before anything is written. `mcp` is applied first above, so a
    // same-PUT URL change already keys correctly.
    func applyMcpAuthUpdate(nodeId: String, auth: String, instancePath: String) throws {
        let value = normalized(auth)
        if value != nil {
            guard let node = try findNode(id: nodeId, at: instancePath), node.mcp?.notEmpty == true else {
                throw Abort(.badRequest, reason: "Set an MCP URL before saving its authorization")
            }
        }
        try GraphStore.updateMcpAuth(id: nodeId, auth: value, at: instancePath)
    }

    // Agent switch validates against the same runner-script table the create
    // path resolves through — an unknown name is a 400 before any file is
    // touched. Stored agents re-resolve on every later execution (summary
    // regen, RUN, retry), so nothing else needs adjusting here; an in-flight
    // run keeps the script it already launched with.
    func applyAgentUpdate(nodeId: String, agent: String, instancePath: String) throws {
        let name = agent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.notEmpty else { throw Abort(.badRequest, reason: "agent must not be empty") }
        _ = try resolveScript(for: name)
        try GraphStore.updateAgent(id: nodeId, agent: name, at: instancePath)
    }

    func applyDetailUpdates(nodeId: String, body: GraphUpdateRequest, instancePath: String) throws {
        if let summary = body.summary, summary.notEmpty {
            try GraphStore.updateSummary(id: nodeId, summary: summary, at: instancePath)
        }
        if let personas = body.personas {
            try GraphStore.updatePersonas(id: nodeId, personas: personas, at: instancePath)
        }
        if let assignedNodeIds = body.assigned_node_ids {
            try GraphStore.updateAssignedNodeIds(
                id: nodeId,
                assignedNodeIds: dedupeNodeIds(assignedNodeIds),
                at: instancePath
            )
        }
    }

    func instancePathFrom(_ req: Request) throws -> String {
        try req.routeParam("id")
    }

    func nodeIdFrom(_ req: Request) throws -> String {
        try req.routeParam("nid")
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
            if await graphRunRegistry.isLive(id) { throw Abort(.conflict, reason: deleteBusyReason) }
        }
        for log in try GraphStore.fetchProgressRunLogs(at: instancePath) where ids.contains(log.nodeId) {
            if await graphRunRegistry.isLive(log.id) { throw Abort(.conflict, reason: deleteBusyReason) }
        }
    }

    func isRunning(_ status: String) -> Bool {
        GraphStore.runningStatuses.contains(status)
    }

    func resolveScript(for agent: String) throws -> FilePath {
        let script = Paths.bin.appending("\(agentBinaryPrefix)\(agent)")
        guard PathIO.isFileExistent(atPath: script.string) else {
            throw Abort(.badRequest, reason: "Unknown agent: \(agent)")
        }
        return script
    }

    func isRunnerScript(_ file: String) -> Bool {
        guard file.hasPrefix(agentBinaryPrefix), !file.hasSuffix(runnerEnvSidecarSuffix) else { return false }
        guard let variant = dockerVariant(of: file.dropFirst(agentBinaryPrefix.count)) else { return false }
        return !baseScriptVariants.contains(variant)
    }

    func dockerVariant(of bare: Substring) -> String? {
        guard let r = bare.range(of: "_docker") else { return nil }
        let variant = bare[r.upperBound...]
        guard variant.hasPrefix("-"), variant.count > 1 else { return nil }
        return String(variant.dropFirst())
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
        let stale = try GraphStore.fetchNodes(at: instancePath)
            .filter { GraphStore.runningStatuses.contains($0.status) }
        for node in stale where !(await graphRunRegistry.isLive(node.id)) {
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
        guard ["answered", "success", "failed"].contains(node.status) else {
            throw Abort(.badRequest, reason: "Node has no answer to summarize")
        }
        return node
    }

    func detachLifecycle(_ node: GraphNode, runId: String, script: FilePath, instancePath: String) {
        Task.detached { await runLifecycle(node, runId: runId, script: script, instancePath: instancePath) }
    }

    func rerun(_ req: Request, node: GraphNode, script: FilePath, instancePath: String) throws {
        let prompt = editedPrompt(req, current: node.prompt) ?? node.prompt
        try GraphStore.updatePrompt(id: node.id, prompt: prompt, at: instancePath)
        try GraphStore.updateNode(id: node.id, status: "progress", output: nil, took: nil, at: instancePath)
        guard let fresh = try findNode(id: node.id, at: instancePath) else { return }
        detachLifecycle(fresh, runId: UUID().uuidString, script: script, instancePath: instancePath)
    }

    func editedPrompt(_ req: Request, current: String) -> String? {
        guard let body = try? req.content.decode(GraphSummaryRequest.self),
              let prompt = body.prompt?.trimmingCharacters(in: .whitespacesAndNewlines),
              prompt.notEmpty else { return nil }
        return prompt
    }

    func graphContents(at instancePath: String) throws -> [GraphNodeContent] {
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        let counts = try GraphStore.fetchRunCounts(at: instancePath)
        let secrets = SecretStore.load(at: instancePath)
        return nodes.map {
            toContent($0, counts: counts[$0.id] ?? RunCounts(), runnable: isChainReady($0, nodes: nodes), secrets: secrets)
        }
    }

    func contentWithStats(_ node: GraphNode, at instancePath: String) throws -> GraphNodeContent {
        let counts = try GraphStore.fetchRunCounts(at: instancePath)[node.id] ?? RunCounts()
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        return toContent(node, counts: counts, runnable: isChainReady(node, nodes: nodes), secrets: SecretStore.load(at: instancePath))
    }

    func isChainReady(_ node: GraphNode, nodes: [GraphNode]) -> Bool {
        GraphStore.chain(of: node, in: nodes).allSatisfy { $0.status == "success" }
    }

    func runLogFor(nodeId: String, prompt: String, parentRunId: String?, refNodeIds: [String]?, at instancePath: String) async throws -> GraphRunLog {
        guard let node = try findNode(id: nodeId, at: instancePath) else { throw Abort(.notFound, reason: "Node not found: \(nodeId)") }
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        // readiness stays the OWN chain's rule — assignments never gate a Run
        let chain = GraphStore.chain(of: node, in: nodes)
        guard chain.allSatisfy({ $0.status == "success" }) else { throw Abort(.badRequest, reason: "Chain not ready — parents need summaries") }
        // resolve refs before any artifact is written — an unknown id is a 400 that names it
        let refs = try resolveNodeRefs(refNodeIds, at: instancePath)
        let logId = UUID().uuidString
        let parent = try parentRun(parentRunId, nodeId: nodeId, at: instancePath)
        try writeRunContext(node, parent: parent, refs: refs, id: logId, at: instancePath)
        // MCP surface: own resolved chain first, then each ref's — merged nearest-wins
        let mcpPath = GraphStore.writeMcpConfig(
            GraphStore.nearestWinsMcpUnion(
                resolvedChain(node, at: instancePath).mcpEndpointSets()
                    + refMcpEndpointSets(refs)
            ),
            runId: logId
        )
        let rootRunId = parent?.rootRunId ?? parent?.id ?? logId
        return try await scheduleRunLog(
            node, prompt: prompt, logId: logId, parentRunId: parentRunId,
            rootRunId: rootRunId, mcpPath: mcpPath, refNodeIds: refs.map(\.id), at: instancePath
        )
    }

    func parentRun(_ id: String?, nodeId: String, at instancePath: String) throws -> GraphRunLog? {
        guard let id else { return nil }
        let logs = try GraphStore.fetchRunLogs(nodeId: nodeId, at: instancePath)
        guard let run = logs.first(where: { $0.id == id }) else {
            throw Abort(.notFound, reason: "Run not found: \(id)")
        }
        guard !logs.contains(where: { $0.parentRunId == id }) else {
            throw Abort(.conflict, reason: "Run already continued — append to the conversation tip")
        }
        guard run.status == "success" else {
            throw Abort(.badRequest, reason: "Run not ready — it needs a summary before a follow-up")
        }
        return run
    }

    /// The run's resolved chain: own line + standing assignments (GraphStore.ChainResolver).
    func resolvedChain(_ node: GraphNode, at instancePath: String) -> GraphStore.ResolvedChain {
        var resolver = GraphStore.ChainResolver()
        return resolver.resolve(node: node, at: instancePath)
    }

    func writeRunContext(
        _ node: GraphNode, parent: GraphRunLog?, refs: [NodeRef], id: String, at instancePath: String
    ) throws {
        // ctx.md = chainText of the FULLY resolved chain — assignment knowledge rides inside it
        _ = try writeContext(resolvedChain(node, at: instancePath).nodes, id: id)
        _ = try writeConvo(parent, id: id, at: instancePath)
        try writeRefContext(refs, id: id)
    }

    func writeConvo(_ parent: GraphRunLog?, id: String, at instancePath: String) throws -> String? {
        guard let parent else { return nil }
        let logs = try GraphStore.fetchRunLogs(nodeId: parent.nodeId, at: instancePath)
        let text = GraphStore.runSummaries(GraphStore.runChain(of: parent, in: logs))
        return try writeIfNotEmpty(text, in: try runDir(id), name: "convo.md")
    }

    func newRunLog(
        id: String, nodeId: String, prompt: String, parentRunId: String?, rootRunId: String?, refNodeIds: [String]? = nil
    ) -> GraphRunLog {
        GraphRunLog(
            id: id, nodeId: nodeId, prompt: prompt, status: "progress",
            output: nil, took: nil, createdAt: Date().timeIntervalSinceReferenceDate, completedAt: nil,
            parentRunId: parentRunId, rootRunId: rootRunId, refNodeIds: refNodeIds
        )
    }

    func scheduleRunLog(
        _ node: GraphNode, prompt: String, logId: String, parentRunId: String?, rootRunId: String,
        mcpPath: String?, refNodeIds: [String]?, at instancePath: String
    ) async throws -> GraphRunLog {
        let log = newRunLog(
            id: logId, nodeId: node.id, prompt: prompt,
            parentRunId: parentRunId, rootRunId: rootRunId, refNodeIds: refNodeIds
        )
        await graphRunRegistry.add(log.id)
        try GraphStore.insertRunLog(log, at: instancePath)
        try detachRun(log, agent: node.agent, mcpPath: mcpPath, instancePath: instancePath)
        return log
    }

    func retryRunLog(nodeId: String, runId: String, at instancePath: String) async throws -> GraphRunLogContent {
        try GraphStore.createTables(at: instancePath)
        guard let node = try findNode(id: nodeId, at: instancePath) else { throw Abort(.notFound, reason: "Node not found: \(nodeId)") }
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        guard GraphStore.chain(of: node, in: nodes).allSatisfy({ $0.status == "success" }) else {
            throw Abort(.badRequest, reason: "Chain not ready — parents need summaries")
        }
        let run = try await failedTipRun(runId, nodeId: nodeId, at: instancePath)
        return try await relaunchRun(run, node: node, at: instancePath)
    }

    func failedTipRun(_ runId: String, nodeId: String, at instancePath: String) async throws -> GraphRunLog {
        let logs = try GraphStore.fetchRunLogs(nodeId: nodeId, at: instancePath)
        guard let run = logs.first(where: { $0.id == runId }) else { throw Abort(.notFound, reason: "Run not found: \(runId)") }
        guard run.status == "failed" else { throw Abort(.badRequest, reason: "Only failed runs can be restarted") }
        guard !logs.contains(where: { $0.parentRunId == runId }) else {
            throw Abort(.conflict, reason: "Run already continued — restart the conversation tip")
        }
        if await graphRunRegistry.isLive(runId) { throw Abort(.conflict, reason: "Restart already in flight") }
        return run
    }

    func relaunchRun(_ run: GraphRunLog, node: GraphNode, at instancePath: String) async throws -> GraphRunLogContent {
        let logs = try GraphStore.fetchRunLogs(nodeId: node.id, at: instancePath)
        let parent = run.parentRunId.flatMap { pid in logs.first { $0.id == pid } }
        // the row kept its ref ids: a retry re-resolves them through the ladder AS IT IS NOW
        let refs = try resolveNodeRefs(run.refNodeIds, at: instancePath)
        try writeRunContext(node, parent: parent, refs: refs, id: run.id, at: instancePath)
        let mcpPath = GraphStore.writeMcpConfig(
            GraphStore.nearestWinsMcpUnion(
                resolvedChain(node, at: instancePath).mcpEndpointSets()
                    + refMcpEndpointSets(refs)
            ),
            runId: run.id
        )
        await graphRunRegistry.add(run.id)
        try GraphStore.restartRunLog(id: run.id, at: instancePath)
        try detachRun(run, agent: node.agent, mcpPath: mcpPath, instancePath: instancePath)
        return try fetchedRun(run.id, nodeId: node.id, at: instancePath)
    }

    func detachRun(_ run: GraphRunLog, agent: String, mcpPath: String?, instancePath: String) throws {
        let script = try resolveScript(for: agent)
        Task.detached { await executeRunLog(run, script: script, instancePath: instancePath, mcpPath: mcpPath) }
    }

    func sweepRunLogs(instancePath: String) async throws {
        let stale = try GraphStore.fetchProgressRunLogs(at: instancePath)
        guard stale.notEmpty else { return }
        // Session-anchored rows never sweep to "answered": an interrupted
        // follow-up or seed summarization must surface as a failure — an
        // "answered" thread root would silently block every follow-up.
        let sessionRunIds = Set(try LogManager.fetchNotificationKinds(at: instancePath).keys)
        for log in stale where !(await graphRunRegistry.isLive(log.id)) {
            try sweepRunLog(log, sessionRunIds: sessionRunIds, at: instancePath)
        }
    }

    func sweepRunLog(_ log: GraphRunLog, sessionRunIds: Set<String>, at instancePath: String) throws {
        if log.status == "summarizing" {
            if sessionRunIds.contains(log.id) {
                return try GraphStore.updateRunLog(
                    id: log.id, status: "failed", output: log.output, took: log.took, at: instancePath
                )
            }
            return try GraphStore.finishRunSummary(id: log.id, summary: nil, at: instancePath)
        }
        try GraphStore.updateRunLog(id: log.id, status: "failed", output: "interrupted", took: nil, at: instancePath)
    }

    func runIdFrom(_ req: Request) throws -> String {
        try req.routeParam("rid")
    }

    func assertRunExists(_ runId: String, nodeId: String, at instancePath: String) throws {
        guard try GraphStore.fetchRunLogs(nodeId: nodeId, at: instancePath).contains(where: { $0.id == runId }) else {
            throw Abort(.notFound, reason: "Run not found: \(runId)")
        }
    }

    func fetchedRun(_ runId: String, nodeId: String, at instancePath: String) throws -> GraphRunLogContent {
        guard let run = try GraphStore.fetchRunLogs(nodeId: nodeId, at: instancePath).first(where: { $0.id == runId }) else {
            throw Abort(.notFound, reason: "Run not found: \(runId)")
        }
        return toContent(run)
    }

    // The DELETE contract for one run-log row, shared by both anchors (node
    // threads and session threads are rows in one table; node_id is the
    // overloaded anchor column). The run must exist under the route's anchor
    // (404 — the anchor compare doubles as the wrong-route guard) and be
    // terminal + not in the registry (409, the deleteBusyReason precedent).
    // A run whose LATER thread rows exist is still deletable — each row's
    // artifacts key by their own run id; only parent_run_id metadata changes
    // under it. Deleting a parent IS the feature: no "has children" guard
    // (unlike retry). Fresh list back, mirroring the node-delete precedent.
    func deleteRunLog(runId: String, anchor: String, at instancePath: String) async throws -> GraphRunLogsResponse {
        try GraphStore.createTables(at: instancePath)
        guard let run = try GraphStore.runLog(id: runId, at: instancePath), run.nodeId == anchor else {
            throw Abort(.notFound, reason: "Run not found: \(runId)")
        }
        try await assertRunDeletable(run, at: instancePath)
        try GraphStore.deleteRunLog(id: runId, at: instancePath)
        return GraphRunLogsResponse(logs: try GraphStore.fetchRunLogs(nodeId: anchor, at: instancePath).map(toContent))
    }

    func assertRunDeletable(_ run: GraphRunLog, at instancePath: String) async throws {
        guard !isRunning(run.status), !(await graphRunRegistry.isLive(run.id)) else {
            throw Abort(.conflict, reason: deleteBusyReason)
        }
    }

    // The full-RUN delete core (the runs-list bin on graph.html): the root
    // plus every follow-up cascade in one transaction — the conversation
    // twin of ?chain=true. Guards widen to EVERY row: any in-flight turn
    // holds the whole delete (409). Root-only — a follow-up id is the wrong
    // object for a list delete (its own row has the per-turn splice); 400.
    func deleteRunThread(runId: String, anchor: String, at instancePath: String) async throws -> GraphRunLogsResponse {
        try GraphStore.createTables(at: instancePath)
        guard let run = try GraphStore.runLog(id: runId, at: instancePath), run.nodeId == anchor else {
            throw Abort(.notFound, reason: "Run not found: \(runId)")
        }
        guard run.parentRunId == nil else { throw Abort(.badRequest, reason: "Not a thread root") }
        let thread = try GraphStore.fetchRunThread(rootId: runId, at: instancePath)
        for row in thread { try await assertRunDeletable(row, at: instancePath) }
        try GraphStore.deleteRunThread(id: runId, at: instancePath)
        return GraphRunLogsResponse(logs: try GraphStore.fetchRunLogs(nodeId: anchor, at: instancePath).map(toContent))
    }

    func toContent(_ log: GraphRunLog) -> GraphRunLogContent {
        GraphRunLogContent(
            id: log.id, node_id: log.nodeId, prompt: log.prompt, status: log.status,
            output: log.output, took: log.took,
            created_at: unixMs(log.createdAt), completed_at: log.completedAt.map(unixMs),
            parent_run_id: log.parentRunId, summary: log.summary, root_run_id: log.rootRunId,
            audit: log.audit, audit_status: log.auditStatus
        )
    }

    // The secret NEVER crosses this boundary (write-only on PUT/POST):
    // `mcp_requires_auth` = the repo-traveling node-file marker;
    // `mcp_auth_local` = this machine's secrets store holds a key for the
    // node's URL — what runs will actually send. requires && !local is the
    // fresh-clone state the UI surfaces as "set the key on this computer".
    func toContent(_ node: GraphNode, counts: RunCounts = RunCounts(), runnable: Bool = false, secrets: [String: String] = [:]) -> GraphNodeContent {
        GraphNodeContent(
            id: node.id, parent_id: node.parentId, prompt: node.prompt, agent: node.agent,
            status: node.status, output: node.output, took: node.took, mcp: node.mcp,
            mcp_requires_auth: node.mcpRequiresAuth,
            mcp_auth_local: node.mcp.flatMap { secrets[$0] }?.notEmpty == true,
            summary: node.summary, personas: node.personas, assigned_node_ids: node.assignedNodeIds,
            active: node.active, name: node.name, runnable: runnable,
            runs: RunCountsContent(total: counts.total, success: counts.success, failed: counts.failed, active: counts.active),
            created_at: unixMs(node.createdAt), completed_at: node.completedAt.map(unixMs)
        )
    }

    func unixMs(_ refInterval: Double) -> Int64 {
        Int64(Date(timeIntervalSinceReferenceDate: refInterval).timeIntervalSince1970 * 1000)
    }
}

private func runLifecycle(
    _ node: GraphNode,
    runId: String,
    script: FilePath,
    instancePath: String
) async {
    await runAnswerPhase(node, runId: runId, script: script, instancePath: instancePath)
    await maybeSummarize(id: node.id, runId: runId, script: script, instancePath: instancePath)
}

private func runAnswerPhase(_ node: GraphNode, runId: String, script: FilePath, instancePath: String) async {
    let tb = TimedBenchmark()
    let run = await answerOnce(node, runId: runId, script: script, instancePath: instancePath)
    let answered = run.out?.notEmpty == true
    try? GraphStore.updateNode(
        id: node.id, status: answered ? "summarizing" : "failed", output: run.out ?? run.error,
        took: Int(tb.intervalSinceInitialized), at: instancePath
    )
    if !answered { await graphRunRegistry.remove(node.id) }
}

private func executeRunLog(_ log: GraphRunLog, script: FilePath, instancePath: String, mcpPath: String?) async {
    let tb = TimedBenchmark()
    let out = await execRunLog(log, script: script, instancePath: instancePath, mcpPath: mcpPath)
    let took = Int(tb.intervalSinceInitialized)
    try? GraphStore.updateRunLog(id: log.id, status: out?.notEmpty == true ? "summarizing" : "failed", output: out, took: took, at: instancePath)
    if let output = out, output.notEmpty {
        await summarizeRunLog(log, output: output, script: script, instancePath: instancePath)
    }
    await graphRunRegistry.remove(log.id)
    cleanupRunArtifacts(log.id, mcpPath: mcpPath)
}

private func execRunLog(_ log: GraphRunLog, script: FilePath, instancePath: String, mcpPath: String?) async -> String? {
    let env = runEnv(mcpPath: mcpPath, runDir: GraphStore.contextRunDir(log.id))
    return try? await exec(script.string, args: runArgs(runExecPrompt(log), instancePath), chroot: instancePath, env: env)
}

private func runExecPrompt(_ log: GraphRunLog) -> String {
    var prefix = runFile(log.id, "ctx.md") != nil ? ctxFileLine : ""
    if runFile(log.id, "convo.md") != nil { prefix += convoFileLine }
    prefix += refFileLine(log.id)
    return prefix + log.prompt
}

/// One @-line for this run's ref-<id>.md files — the parent-<id>.md grammar.
private func refFileLine(_ runId: String) -> String {
    let refs = refContextFileNames(runId)
    guard refs.notEmpty else { return "" }
    let list = refs.map { "@\(GraphStore.containerCtxDir)/\($0)" }.joined(separator: " ")
    return "Context files (absolute paths at filesystem root, outside the working directory, read-only): \(list)\n"
}

private func refContextFileNames(_ runId: String) -> [String] {
    let dir = GraphStore.contextRunDir(runId)
    guard PathIO.isDirectoryExistent(atPath: dir.string),
          let names = try? PathIO.contentsOfDirectory(atPath: dir.string) else { return [] }
    return names.filter { $0.hasPrefix("ref-") && $0.hasSuffix(".md") }.sorted()
}

private func runFile(_ runId: String, _ name: String) -> String? {
    let file = GraphStore.contextRunDir(runId).appending(name)
    return PathIO.isFileExistent(atPath: file.string) ? file.string : nil
}

private func summarizeRunLog(_ log: GraphRunLog, output: String, script: FilePath, instancePath: String) async {
    // Summaries are text filtering — MCP-free by decision (no MCP_CONFIG_PATH).
    let env = runEnv(mcpPath: nil, runDir: GraphStore.contextRunDir(log.id))
    guard let prompt = qaSummaryPrompt(question: log.prompt, answer: output, runId: log.id) else {
        try? GraphStore.finishRunSummary(id: log.id, summary: nil, at: instancePath)
        return
    }
    let run = await runScript(script, args: runArgs(prompt, instancePath), chroot: instancePath, env: env)
    let trimmed = run.out?.trimmingCharacters(in: .whitespacesAndNewlines)
    let summary = (trimmed?.isEmpty == true) ? nil : trimmed
    try? GraphStore.finishRunSummary(id: log.id, summary: summary, at: instancePath)
    if let summary {
        maybeAnalyze(id: log.id, question: log.prompt, summary: summary, script: script, instancePath: instancePath)
    }
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
    let dir = GraphStore.contextRunDir(id)
    guard PathIO.createDirectoryIfNotExists(atPath: dir.string) else {
        throw Abort(.internalServerError, reason: "Could not create ctx dir: \(dir.string)")
    }
    return dir
}

private func runEnv(mcpPath: String?, runDir: FilePath) -> [String: String] {
    var env = ["GRAPH_RUN_DIR": runDir.string]
    if let mcpPath { env["MCP_CONFIG_PATH"] = mcpPath }
    return env
}

private func writeContext(_ chain: [GraphNode], id: String) throws -> String? {
    try writeIfNotEmpty(GraphStore.chainText(chain), in: try runDir(id), name: "ctx.md")
}

private func writeIfNotEmpty(_ text: String, in dir: FilePath, name: String) throws -> String? {
    guard text.notEmpty else { return nil }
    return try GraphStore.writeContextFile(text, in: dir, fileName: name).string
}

private func writeQa(_ question: String, _ answer: String, id: String) throws -> (question: String, answer: String) {
    let dir = try runDir(id)
    return (
        try GraphStore.writeContextFile(question, in: dir, fileName: "question.md").string,
        try GraphStore.writeContextFile(answer, in: dir, fileName: "answer.md").string
    )
}

private func chainArtifacts(_ node: GraphNode, runId: String, at instancePath: String) throws -> (ctxPath: String?, mcpPath: String?) {
    let nodes = try GraphStore.fetchNodes(at: instancePath)
    let chain = GraphStore.chain(of: node, in: nodes)
    return (
        try writeContext(ancestors(of: node, in: nodes), id: runId),
        GraphStore.writeMcpConfig(GraphStore.chainMcpEndpoints(chain, at: instancePath), runId: runId)
    )
}

private func ancestors(of node: GraphNode, in nodes: [GraphNode]) -> [GraphNode] {
    Array(GraphStore.chain(of: node, in: nodes).dropLast())
}

private let ctxFileLine = "Context file: @\(GraphStore.containerCtxDir)/ctx.md — absolute path at filesystem root, outside the working directory, read-only. Read it before answering.\n"

private let convoFileLine = "Previous conversation summary: @\(GraphStore.containerCtxDir)/convo.md — absolute path at filesystem root, outside the working directory, read-only. Read it before answering; treat it as already-known context — build on it, do not restate it.\n"

private func prefixedPrompt(_ prompt: String, _ ctxPath: String?) -> String {
    ctxPath.map { _ in ctxFileLine + prompt } ?? prompt
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

private func answerOnce(_ node: GraphNode, runId: String, script: FilePath, instancePath: String) async -> (out: String?, error: String?) {
    let artifacts: (ctxPath: String?, mcpPath: String?)
    do {
        artifacts = try chainArtifacts(node, runId: runId, at: instancePath)
    } catch {
        return (nil, "Context prep failed: \(error)")
    }
    defer { deleteMcpConfig(artifacts.mcpPath) }
    let args = runArgs(prefixedPrompt(node.prompt, artifacts.ctxPath), instancePath)
    let env = runEnv(mcpPath: artifacts.mcpPath, runDir: GraphStore.contextRunDir(runId))
    return await runScript(script, args: args, chroot: instancePath, env: env)
}

private func maybeSummarize(id: String, runId: String, script: FilePath, instancePath: String) async {
    defer { GraphStore.deleteContextRunDir(runId) }
    guard let node = try? GraphStore.fetchNodes(at: instancePath).first(where: { $0.id == id }),
          node.status == "summarizing" else {
        await graphRunRegistry.remove(id)
        return
    }
    await summarize(node, runId: runId, script: script, instancePath: instancePath)
}

private func summarize(_ node: GraphNode, runId: String, script: FilePath, instancePath: String) async {
    assert((node.output ?? "").notEmpty, "summarizing nodes always carry a non-empty output")
    guard let answer = node.output, answer.notEmpty,
          let prompt = qaSummaryPrompt(question: node.prompt, answer: answer, runId: runId) else {
        await graphRunRegistry.remove(node.id)
        return
    }
    await runSummary(node, runId: runId, prompt: prompt, script: script, instancePath: instancePath)
}

private func runSummary(
    _ node: GraphNode, runId: String, prompt: String,
    script: FilePath, instancePath: String
) async {
    // Summaries are text filtering — MCP-free by decision (no MCP_CONFIG_PATH).
    let env = runEnv(mcpPath: nil, runDir: GraphStore.contextRunDir(runId))
    let run = await runScript(script, args: runArgs(prompt, instancePath), chroot: instancePath, env: env)
    let trimmed = run.out?.trimmingCharacters(in: .whitespacesAndNewlines)
    try? GraphStore.finishSummary(
        id: node.id, summary: (trimmed?.isEmpty == true) ? nil : trimmed, at: instancePath
    )
    await graphRunRegistry.remove(node.id)
}

// Filter, not narrate: the output is the answer's own reply at the ask's depth — a plain-wording rule only, facts and depth stay.
private let summaryInstruction = """
    You are filtering the ANSWER below, with the QUESTION's ask as the filter: keep what serves that ask, at the depth the ask needs, and drop the rest of the ANSWER — other topics, unrelated repo changes, detail beyond the ask. Keep every change the ANSWER states about existing behavior — dropped checks, changed order, changed defaults — even when tucked into a trade-off aside: that is part of what the turn delivered, and later turns must not assume the old behavior still holds.
    The output is the filtered answer itself, written as the direct reply to the QUESTION — the answering agent's own reply at that depth, in its voice and stance: plain text, terse and dense, written for a 12-year-old reader — everyday words, short sentences, every technical term explained in plain words at first use; the wording simplifies, the facts and their names stay as they are.
    The first line is the most reusable sentence of the reply: its key fact or decision point.
    """
// Delta vs convo.md — without it the summarizer re-compresses each turn's recap into the next convo.md, compounding every turn.
// Change-driven: an item recurs only together with its change; an empty delta stores nil — no summary beats filler.
private let deltaSummaryInstruction = """
    @\(GraphStore.containerCtxDir)/convo.md is the previous conversation summary — read it first and treat its facts as already stated, filtered out just like the off-ask material.
    Write only what THIS turn's answer adds on top of it: new facts and state changes — an item already stated in convo.md returns only together with its change (unresolved became resolved, working became broken, scope grew or shrank); its unchanged state stays recorded in convo.md - do not reiterate.
    """

private func qaSummaryPrompt(question: String, answer: String, runId: String) -> String? {
    guard (try? writeQa(question, answer, id: runId)) != nil else { return nil }
    let c = GraphStore.containerCtxDir
    let hasConvo = runFile(runId, "convo.md") != nil
    let files = "Context files (absolute paths at filesystem root, outside the working directory, read-only): @\(c)/question.md\(hasConvo ? ", @\(c)/convo.md and" : " and") @\(c)/answer.md\n"
    let instruction = hasConvo ? summaryInstruction + "\n" + deltaSummaryInstruction : summaryInstruction
    return files + "\(instruction)\n\nQUESTION: @\(c)/question.md\n\nANSWER: @\(c)/answer.md"
}

// MARK: - Advisory scope audit
// One detached agent pass after a non-empty summary lands — pure advice for the user, feeds nothing downstream, gates nothing.
// Off-switch: OPENLOOP_AUDIT=0 disables (future-proofing; no live site needs it).
private let auditEnabled = ProcessInfo.processInfo.environment["OPENLOOP_AUDIT"] != "0"

// Filter, not audit — the reply may not go beyond the recorded turn; the all-clear line is exactly "All clear".
private let auditInstruction = """
You are filtering the ANSWER below, with the ASK as the filter: keep only what the ASK does not cover — anything the turn did beyond it, added, removed, or changed, and any piece of the ASK the ANSWER does not deliver — and drop the rest of the ANSWER: what the ASK asked for and the ANSWER delivered appears nowhere in the output, not even as a mention (no "delivered as asked" lines, no filtered-out lists).
The ASK's literal text is the only authorization: whatever it does not request is beyond scope, however small, sensible, or well argued. An ANSWER that proposes, plans, defends, or merely announces a change (e.g.: "future-proofing", "belt-and-braces", "while I'm here", "the design needs it", "a known trade-off", "flagging it so it's a known behavior") is not an ASK that requests it — keep that line: naming a change inside the reply converts nothing, because nobody signs off on one flagged line buried in a long answer.
Keep, too, what the ASK never named: files, features, or behavior beyond it; removed or weakened existing behavior (dropped checks, changed lookup or precedence order, changed defaults, changed where files land); new control surface (environment variables, settings, flags, defaults, knobs); added tests, docs, or dependencies; renames, refactors, unasked improvements. When unsure whether the ASK covers something, keep it: a false line costs one line, an unflagged extra ships unreviewed.
The output is the filtered ANSWER itself — the kept pieces only, nothing of your own. One line per piece, marked at the start: `beyond scope:` for what the answer did beyond the ask, in its own words; `missing:` for a piece of the ask the answer does not deliver. Each line names the thing and where it landed.
If the filter leaves nothing, reply with exactly this line and nothing else: `All clear`.
"""

/// qaSummaryPrompt's delivery, but in the audit's OWN throwaway ctx dir — the run's dir dies at finish, before the verdict lands.
private func qaAuditPrompt(question: String, answer: String, auditId: String) throws -> String {
    let dir = try runDir(auditId)
    _ = try GraphStore.writeContextFile(question, in: dir, fileName: "ask.md")
    _ = try GraphStore.writeContextFile(answer, in: dir, fileName: "answer.md")
    let c = GraphStore.containerCtxDir
    let files = "Context files (absolute paths at filesystem root, outside the working directory, read-only): @\(c)/ask.md and @\(c)/answer.md\n"
    return files + auditInstruction + "\n\nASK: @\(c)/ask.md\n\nANSWER: @\(c)/answer.md"
}

private func maybeAnalyze(id: String, question: String, summary: String, script: FilePath, instancePath: String) {
    guard auditEnabled else { return }
    // Files land BEFORE the marker — a failed write means no audit at all, not a pulse over a run that never starts.
    let auditId = UUID().uuidString
    guard let prompt = try? qaAuditPrompt(question: question, answer: summary, auditId: auditId) else { return }
    try? GraphStore.markRunAuditing(id: id, at: instancePath)
    Task.detached {
        // A crash leaves the dir to the 24h stale-artifacts sweep, like every other run dir.
        defer { GraphStore.deleteContextRunDir(auditId) }
        let run = await runScript(
            script,
            args: runArgs(prompt, instancePath),
            chroot: instancePath,
            env: runEnv(mcpPath: nil, runDir: GraphStore.contextRunDir(auditId)) // MCP-free, like the summarizer's
        )
        let trimmed = run.out?.trimmingCharacters(in: .whitespacesAndNewlines)
        try? GraphStore.finishRunAudit(
            id: id, audit: (trimmed?.isEmpty == true) ? nil : trimmed, at: instancePath
        )
    }
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
        var mcp_requires_auth: Bool
        var mcp_auth_local: Bool
        var summary: String?
        var personas: [String]
        /// Standing assignment ids — roots only, dormant once parented (see ChainResolver).
        var assigned_node_ids: [String]
        var active: Bool
        var name: String?
        var runnable: Bool
        var runs: RunCountsContent
        var created_at: Int64
        var completed_at: Int64?
    }

    struct RunCountsContent: Content, Sendable {
        var total: Int
        var success: Int
        var failed: Int
        var active: Int
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
        var parent_run_id: String?
        var summary: String?
        var root_run_id: String?
        /// Advisory scope-audit verdict (nil = not audited — renders neutral, never clean).
        var audit: String?
        /// "analyzing" while the detached audit runs; nil otherwise.
        var audit_status: String?
    }

    struct GraphRunLogsResponse: Content, Sendable {
        var logs: [GraphRunLogContent]
    }

    struct GraphRunRequest: Content, Sendable {
        var prompt: String
        var parent_run_id: String?
        /// `#node` mention ids — resolveNodeRefs resolves them through the ladder.
        var node_ids: [String]?
    }

    struct GraphRunSummaryRequest: Content, Sendable {
        var summary: String
    }

    struct GraphSummaryRequest: Content, Sendable {
        var prompt: String?
    }

    struct GraphNodesResponse: Content, Sendable {
        var nodes: [GraphNodeContent]
    }

    /// Straight copies off the node file — secrets-free; `chain_mcp_count` = resolved-chain MCP URL count.
    struct GraphLadderNodeEntry: Content, Sendable {
        var id: String
        var name: String?
        var agent: String
        var status: String
        var active: Bool
        var source: String
        var source_path: String
        var chain_mcp_count: Int
        var parent_id: String?
        var created_at: Int64
        var assigned_node_ids: [String]
    }

    struct GraphLadderNodesResponse: Content, Sendable {
        var nodes: [GraphLadderNodeEntry]
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
        /// Standing assignment ids — [] clears; dead ids log one line and are skipped at run time.
        var assigned_node_ids: [String]?
        var active: Bool?
        var name: String?
        var agent: String?
    }

    struct AgentEntry: Content, Sendable {
        var name: String
    }

    struct AgentsResponse: Content, Sendable {
        var agents: [AgentEntry]
    }
}

// MARK: - #node references (cross-instance node mentions)
// Refs are READ-ONLY inputs: nothing is ever written to the folder a referenced node lives in.

/// A ladder-resolved #node reference — one resolution shared by the MCP and context halves.
private struct NodeRef: Sendable {
    let id: String
    let node: GraphNode
    let resolved: GraphStore.ResolvedChain
    let sourceInstance: String
}

extension GraphHandler {

    /// GET /api/instances/:id/graph/nodes — every node visible through the ladder.
    func ladderNodes(req: Request) async throws -> GraphLadderNodesResponse {
        let instancePath = try instancePathFrom(req)
        do {
            return GraphLadderNodesResponse(nodes: try ladderNodeEntries(at: instancePath))
        } catch {
            req.logger.error("Failed to list ladder nodes: \(error)")
            throw Abort(.internalServerError)
        }
    }
}

private extension GraphHandler {

    /// Nearest-first ladder walk, id-deduped (a nearer copy shadows); the entry order IS the ladder.
    func ladderNodeEntries(at instancePath: String) throws -> [GraphLadderNodeEntry] {
        var seen = Set<String>()
        var entries: [GraphLadderNodeEntry] = []
        var resolver = GraphStore.ChainResolver()
        for dir in Paths.contextLookupDirs(from: FilePath(instancePath)) {
            let path = dir.string
            let nodes = NodeStore.list(at: path)
            guard nodes.notEmpty else { continue }
            let source = ladderSourceLabel(dir: path, instance: instancePath)
            for node in nodes where !seen.contains(node.id) {
                seen.insert(node.id)
                entries.append(GraphLadderNodeEntry(
                    id: node.id,
                    name: node.name,
                    agent: node.agent,
                    status: node.status,
                    active: node.active,
                    source: source,
                    source_path: path,
                    chain_mcp_count: resolver.resolve(node: node, at: path).mcpUrlCount(),
                    parent_id: node.parentId,
                    created_at: unixMs(node.createdAt),
                    assigned_node_ids: node.assignedNodeIds
                ))
            }
        }
        return entries
    }

    func ladderSourceLabel(dir: String, instance: String) -> String {
        if dir == instance { return "project" }
        if dir == Paths.globalShareRoot.string { return "global" }
        return "parent"
    }

    // MARK: run-time resolution

    /// Request-shape hygiene: drop empties, dedupe keep-order — callers never re-default.
    func dedupeNodeIds(_ ids: [String]?) -> [String] {
        guard let ids else { return [] }
        var seen = Set<String>()
        var out: [String] = []
        for id in ids where id.notEmpty && seen.insert(id).inserted { out.append(id) }
        return out
    }

    /// Nearest-first ladder resolution; an id no folder holds is a 400 that NAMES it.
    func resolveNodeRefs(_ ids: [String]?, at instancePath: String) throws -> [NodeRef] {
        guard let ids, ids.notEmpty else { return [] }
        let dirs = Paths.contextLookupDirs(from: FilePath(instancePath))
        var resolver = GraphStore.ChainResolver()
        var resolved: [String: NodeRef] = [:]
        for id in ids {
            guard resolved[id] == nil else { continue }
            guard let ref = dirs.lazy.compactMap({ dir in
                NodeStore.load(id: id, at: dir.string).map { node in
                    NodeRef(
                        id: id, node: node,
                        resolved: resolver.resolve(node: node, at: dir.string),
                        sourceInstance: dir.string
                    )
                }
            }).first else {
                throw Abort(.badRequest, reason: "Unknown node reference: \(id)")
            }
            resolved[id] = ref
        }
        return ids.compactMap { resolved[$0] }
    }

    /// Per-dir sets, not one union — the caller's nearest-wins merge puts the run's own surface first.
    func refMcpEndpointSets(_ refs: [NodeRef]) -> [Set<GraphMcpEndpoint>] {
        refs.flatMap { $0.resolved.mcpEndpointSets() }
    }

    /// The persona rule: gate on the ref's own summary, content = resolved chainText; files land in the RUNNING instance only.
    func writeRefContext(_ refs: [NodeRef], id: String) throws {
        guard refs.notEmpty else { return }
        let dir = try runDir(id)
        for ref in refs {
            guard let text = GraphStore.refContextText(node: ref.node, chain: ref.resolved.nodes) else { continue }
            _ = try GraphStore.writeContextFile(
                text, in: dir, fileName: "ref-\(fileSafeId(ref.id)).md"
            )
        }
    }
}

// MARK: - Session follow-ups (workflow follow-up conversations)
//
// The bottom-most persona of a workflow session can be continued
// conversation-style once the session ran successfully. Turns reuse the RUN
// engine and live in graph_run_logs anchored on the session UUID — `node_id`
// is the single overloaded anchor column, and the notification kind
// ("session_run") is persisted as a notification_kinds marker at insert
// time, never inferred from the id. Lifecycle mirrors node RUNs: progress →
// summarizing → success | failed, tip-only appends, failed-tip retry; manual
// summaries go through the existing PUT /graph/:nid/runs/:rid (updateRun has
// no findNode guard, so the session UUID works as a thread anchor there).

extension GraphHandler {

    func sessionLogs(req: Request) async throws -> GraphRunLogsResponse {
        let instancePath = try instancePathFrom(req)
        let session = try sessionIdFrom(req)
        try GraphStore.createTables(at: instancePath)
        let rows = try GraphStore.fetchRunLogs(nodeId: session, at: instancePath)
        return GraphRunLogsResponse(logs: rows.map(toContent))
    }

    func sessionRun(req: Request) async throws -> GraphRunLogContent {
        let instancePath = try instancePathFrom(req)
        let session = try sessionIdFrom(req)
        let body = try req.content.decode(GraphRunRequest.self)
        guard body.prompt.trimmingCharacters(in: .whitespacesAndNewlines).notEmpty else {
            throw Abort(.badRequest, reason: "prompt must not be empty")
        }
        return toContent(try await sessionRunLog(
            session: session, prompt: body.prompt,
            parentRunId: body.parent_run_id, refNodeIds: dedupeNodeIds(body.node_ids), at: instancePath
        ))
    }

    func sessionSeed(req: Request) async throws -> GraphRunLogContent {
        let instancePath = try instancePathFrom(req)
        let session = try sessionIdFrom(req)
        return toContent(try await seedSessionRun(session: session, at: instancePath))
    }

    func sessionRetryRun(req: Request) async throws -> GraphRunLogContent {
        let instancePath = try instancePathFrom(req)
        let session = try sessionIdFrom(req)
        let runId = try runIdFrom(req)
        return try await retrySessionRunLog(session: session, runId: runId, at: instancePath)
    }

    // Thin sibling of deleteRun — same core, session UUID as the anchor.
    func sessionDeleteRun(req: Request) async throws -> GraphRunLogsResponse {
        let instancePath = try instancePathFrom(req)
        let session = try sessionIdFrom(req)
        let runId = try runIdFrom(req)
        return try await deleteRunLog(runId: runId, anchor: session, at: instancePath)
    }

    func sessionIdFrom(_ req: Request) throws -> String {
        try req.routeParam("sid")
    }
}

private extension GraphHandler {

    // MARK: gates & derivation

    /// Follow-ups need a completed successful session — run_ends is the
    /// source of truth for "the workflow finished".
    func sessionRunEnd(_ session: String, at instancePath: String) throws -> RunEnd {
        try LogManager.createTables(at: instancePath)
        guard let end = try LogManager.fetchRunEnd(session: session, at: instancePath) else {
            throw Abort(.conflict, reason: "No completed run for this session")
        }
        guard end.success else {
            throw Abort(.conflict, reason: "Session run failed — follow-ups need a successful run")
        }
        return end
    }

    /// The session's bottom-most persona log — the synthesized `_bottom_`
    /// completion or the single persona of the last level (max by level,
    /// then start time). Follow-ups derive only the parent context (and the
    /// seed run's output) from this row — the agent comes from the workflow.
    /// Exactly one such row exists per successful session.
    func sessionTip(_ session: String, at instancePath: String) throws -> RunLog {
        let personaLogs = try LogManager.fetchLogsBySession(
            instancePath: instancePath, session: session
        ).filter { $0.personaId != nil }
        guard let tip = personaLogs.max(by: {
            ($0.level ?? -1, $0.startedAt) < ($1.level ?? -1, $1.startedAt)
        }) else {
            throw Abort(.conflict, reason: "No persona logs for this session")
        }
        return tip
    }

    /// The tip persona's direct graph parents' full outputs, as recorded by
    /// the runner — the same facts a fresh workflow run feeds the persona,
    /// materialized as parent-<id>.md context files.
    func sessionParents(_ tip: RunLog) -> [SessionParent] {
        tip.msg.parents.compactMap { parent in
            parent.id.notEmpty ? SessionParent(id: parent.id, text: parent.text) : nil
        }
    }

    /// The workflow's own agent, from its run row (not the workflow file) — sessions must outlive workflow edits and deletions.
    func sessionWorkflowAgent(_ end: RunEnd, session: String, at instancePath: String) throws -> String {
        guard let agent = try LogManager.fetchLogsBySession(instancePath: instancePath, session: session)
            .first(where: { $0.personaId == nil && $0.workflowId == end.workflowId })?
            .agent,
            agent.notEmpty else {
            throw Abort(.conflict, reason: "No workflow row for this session")
        }
        return agent
    }

    /// One persona's context via the same shared ladder walk the runner's collectContext uses.
    func sessionPersonaContext(
        personaId: String, instancePath: String
    ) throws -> GraphStore.PersonaContext {
        guard isRealSessionPersona(personaId) else { return .empty }
        return try GraphStore.personaContextAcrossLadder(
            personaId: personaId, from: FilePath(instancePath)
        )
    }

    /// The session's full persona surface over ALL its personas (outer + inner), first-seen order.
    func sessionPersonaUnion(
        session: String, at instancePath: String
    ) throws -> GraphStore.PersonaContext {
        var order: [String] = []
        var seen: Set<String> = []
        for log in try LogManager.fetchLogsBySession(instancePath: instancePath, session: session) {
            guard let id = log.personaId, isRealSessionPersona(id), seen.insert(id).inserted else {
                continue
            }
            order.append(id)
        }
        var texts: [String] = []
        var perPersona: [Set<GraphMcpEndpoint>] = []
        for id in order {
            let ctx = try sessionPersonaContext(personaId: id, instancePath: instancePath)
            texts += ctx.texts
            perPersona.append(ctx.mcps)
        }
        return GraphStore.PersonaContext(texts: texts, mcps: GraphStore.nearestWinsMcpUnion(perPersona))
    }

    // MARK: thread bookkeeping

    /// The latest session thread row nobody continues.
    func sessionThreadTip(_ logs: [GraphRunLog]) -> GraphRunLog? {
        let continued = Set(logs.compactMap(\.parentRunId))
        return logs
            .filter { !continued.contains($0.id) }
            .max { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    /// Parent contract mirrors parentRun(_:nodeId:at:) for the session
    /// thread. A nil parentRunId appends to the current tip — the session
    /// thread is ONE conversation, so the UI sends the tip explicitly anyway.
    func sessionParentRun(_ parentRunId: String?, logs: [GraphRunLog]) throws -> GraphRunLog? {
        guard let id = parentRunId else {
            guard let tip = sessionThreadTip(logs) else {
                throw Abort(.conflict, reason: "Seed the original answer first")
            }
            guard tip.status == "success" else {
                throw Abort(.badRequest, reason: "Run not ready — it needs a summary before a follow-up")
            }
            return tip
        }
        guard let run = logs.first(where: { $0.id == id }) else {
            throw Abort(.notFound, reason: "Run not found: \(id)")
        }
        guard !logs.contains(where: { $0.parentRunId == id }) else {
            throw Abort(.conflict, reason: "Run already continued — append to the conversation tip")
        }
        guard run.status == "success" else {
            throw Abort(.badRequest, reason: "Run not ready — it needs a summary before a follow-up")
        }
        return run
    }

    /// Seeds the run's context dir: ctx.md (persona chains' knowledge), convo.md, parent-*.md, ref-*.md — all @-referenced.
    func writeSessionContext(
        parents: [SessionParent],
        parent: GraphRunLog?,
        logs: [GraphRunLog],
        personaTexts: [String],
        refs: [NodeRef],
        id: String
    ) throws {
        let dir = try runDir(id)
        _ = try writeIfNotEmpty(GraphStore.joinedText(personaTexts), in: dir, name: "ctx.md")
        if let parent {
            let text = GraphStore.runSummaries(GraphStore.runChain(of: parent, in: logs))
            _ = try writeIfNotEmpty(text, in: dir, name: "convo.md")
        }
        for parentOutput in parents {
            _ = try GraphStore.writeContextFile(
                parentOutput.text, in: dir, fileName: "parent-\(fileSafeId(parentOutput.id)).md"
            )
        }
        try writeRefContext(refs, id: id)
    }

    // MARK: follow-up turn

    func sessionRunLog(
        session: String, prompt: String, parentRunId: String?, refNodeIds: [String]?, at instancePath: String
    ) async throws -> GraphRunLog {
        try GraphStore.createTables(at: instancePath)
        let end = try sessionRunEnd(session, at: instancePath)
        let tipLog = try sessionTip(session, at: instancePath)
        let logs = try GraphStore.fetchRunLogs(nodeId: session, at: instancePath)
        let parent = try sessionParentRun(parentRunId, logs: logs)
        let script = try resolveScript(
            for: try sessionWorkflowAgent(end, session: session, at: instancePath)
        )
        let refs = try resolveNodeRefs(refNodeIds, at: instancePath)
        // knowledge → ctx.md, tools → mcp config; each ref's chain merges after the session's own surface
        let personas = try sessionPersonaUnion(session: session, at: instancePath)
        let logId = UUID().uuidString
        try writeSessionContext(
            parents: sessionParents(tipLog), parent: parent, logs: logs,
            personaTexts: personas.texts, refs: refs, id: logId
        )
        let mcpPath = GraphStore.writeMcpConfig(
            GraphStore.nearestWinsMcpUnion([personas.mcps] + refMcpEndpointSets(refs)),
            runId: logId
        )
        let log = newRunLog(
            id: logId, nodeId: session, prompt: prompt,
            parentRunId: parent?.id, rootRunId: parent?.rootRunId ?? parent?.id ?? logId,
            refNodeIds: refs.map(\.id)
        )
        await graphRunRegistry.add(log.id)
        try GraphStore.insertSessionRunLog(
            log, session: session, workflowId: end.workflowId, at: instancePath
        )
        Task.detached {
            await executeSessionRun(SessionRunExecution(
                log: log, script: script,
                instancePath: instancePath, mcpPath: mcpPath, resumeOutput: false
            ))
        }
        return log
    }

    // MARK: run 0 (seed)

    /// Materializes the session's original answer as the thread root — an
    /// explicit opt-in. Prompt = the original ask, output = the tip
    /// persona's output, created_at = the tip's start; a summarization pass
    /// then produces the summary follow-ups gate on. Empty or failed
    /// summarization lands as "failed" (never "answered"): the user asked
    /// for this row, and the failed status is the requested feedback.
    func seedSessionRun(session: String, at instancePath: String) async throws -> GraphRunLog {
        try GraphStore.createTables(at: instancePath)
        let end = try sessionRunEnd(session, at: instancePath)
        guard try GraphStore.fetchRunLogs(nodeId: session, at: instancePath).isEmpty else {
            throw Abort(.conflict, reason: "Already seeded")
        }
        let tipLog = try sessionTip(session, at: instancePath)
        guard let ask = try LogManager.fetchFirstAsk(session: session, at: instancePath), ask.notEmpty else {
            throw Abort(.conflict, reason: "No original ask found for this session")
        }
        guard tipLog.msg.output.notEmpty else {
            throw Abort(.conflict, reason: "Tip persona log has no output")
        }
        let script = try resolveScript(
            for: try sessionWorkflowAgent(end, session: session, at: instancePath)
        )
        let logId = UUID().uuidString
        // completed_at is set at insert: while the summarization runs the row
        // stays invisible to notifications (status filter), and the moment
        // the summary lands the completion surfaces — feedback for the action
        // that requested it (an explicit tap, or the log page's auto-seed).
        let log = GraphRunLog(
            id: logId, nodeId: session, prompt: ask, status: "summarizing",
            output: tipLog.msg.output, took: tipLog.took,
            createdAt: tipLog.startedAt,
            completedAt: Date().timeIntervalSinceReferenceDate,
            parentRunId: nil, summary: nil, rootRunId: logId
        )
        await graphRunRegistry.add(log.id)
        try GraphStore.insertSessionRunLog(
            log, session: session, workflowId: end.workflowId, at: instancePath
        )
        Task.detached { await summarizeSeedRun(log, script: script, instancePath: instancePath) }
        return log
    }

    // MARK: retry

    /// Session-scoped retry — the node route 404s on session UUIDs
    /// (findNode). Mirrors the node-retry contract (failed tips only, no
    /// children, not in flight); the agent is the workflow's own
    /// (sessionWorkflowAgent — GraphRunLog stores no agent). A failed run
    /// that still holds its output (a seeded run-0, or a summarization the
    /// sweep interrupted) retries the summarization only — the answer exists.
    func retrySessionRunLog(
        session: String, runId: String, at instancePath: String
    ) async throws -> GraphRunLogContent {
        try GraphStore.createTables(at: instancePath)
        let end = try sessionRunEnd(session, at: instancePath)
        let tipLog = try sessionTip(session, at: instancePath)
        let logs = try GraphStore.fetchRunLogs(nodeId: session, at: instancePath)
        guard let run = logs.first(where: { $0.id == runId }) else {
            throw Abort(.notFound, reason: "Run not found: \(runId)")
        }
        guard run.status == "failed" else {
            throw Abort(.badRequest, reason: "Only failed runs can be restarted")
        }
        guard !logs.contains(where: { $0.parentRunId == runId }) else {
            throw Abort(.conflict, reason: "Run already continued — restart the conversation tip")
        }
        if await graphRunRegistry.isLive(runId) {
            throw Abort(.conflict, reason: "Restart already in flight")
        }
        let script = try resolveScript(
            for: try sessionWorkflowAgent(end, session: session, at: instancePath)
        )
        let parent = run.parentRunId.flatMap { pid in logs.first { $0.id == pid } }
        // same refs + persona scope as sessionRunLog — re-resolved as of now, a retry must not regress them
        let refs = try resolveNodeRefs(run.refNodeIds, at: instancePath)
        let personas = try sessionPersonaUnion(session: session, at: instancePath)
        try writeSessionContext(
            parents: sessionParents(tipLog), parent: parent, logs: logs,
            personaTexts: personas.texts, refs: refs, id: run.id
        )
        let mcpPath = GraphStore.writeMcpConfig(
            GraphStore.nearestWinsMcpUnion([personas.mcps] + refMcpEndpointSets(refs)),
            runId: run.id
        )
        await graphRunRegistry.add(run.id)
        try GraphStore.restartRunLog(id: run.id, at: instancePath)
        Task.detached {
            await executeSessionRun(SessionRunExecution(
                log: run, script: script,
                instancePath: instancePath, mcpPath: mcpPath,
                resumeOutput: (run.output ?? "").notEmpty
            ))
        }
        return try fetchedSessionRun(runId, session: session, at: instancePath)
    }

    func fetchedSessionRun(
        _ runId: String, session: String, at instancePath: String
    ) throws -> GraphRunLogContent {
        guard let run = try GraphStore.fetchRunLogs(nodeId: session, at: instancePath)
            .first(where: { $0.id == runId }) else {
            throw Abort(.notFound, reason: "Run not found: \(runId)")
        }
        return toContent(run)
    }
}

// MARK: - Session execution payloads & detached engine

private struct SessionParent: Sendable, Equatable {
    let id: String
    let text: String
}

private struct SessionRunExecution: Sendable {
    let log: GraphRunLog
    let script: FilePath
    let instancePath: String
    let mcpPath: String?
    /// True when the run's recorded output is the answer to (re-)summarize
    /// (a seeded run-0 or an interrupted summarization) — the agent is not
    /// re-run.
    let resumeOutput: Bool
}

private func isRealSessionPersona(_ id: String) -> Bool {
    id != "_bottom_" && id != "_head_" && !id.hasPrefix(":")
}

private func fileSafeId(_ id: String) -> String {
    String(id.map { c in
        (c.isLetter || c.isNumber || c == "-" || c == "_") ? c : "-"
    })
}

/// The session RUN engine — executeRunLog with the SAME generic `_bottom_`
/// arg shape node RUNs use (runArgs); only the prompt prefix differs
/// (convo/parent file refs).
private func executeSessionRun(_ run: SessionRunExecution) async {
    let tb = TimedBenchmark()
    let out = run.resumeOutput
        ? run.log.output
        : await execSessionRun(run)
    if run.resumeOutput {
        // Restore output + completed_at (restartRunLog nulled both) before
        // summarizing — finishRunSummary never sets completed_at, and
        // notifications require it on terminal rows.
        try? GraphStore.updateRunLog(
            id: run.log.id, status: "summarizing",
            output: out, took: run.log.took, at: run.instancePath
        )
    } else {
        try? GraphStore.updateRunLog(
            id: run.log.id,
            status: out?.notEmpty == true ? "summarizing" : "failed",
            output: out, took: Int(tb.intervalSinceInitialized), at: run.instancePath
        )
    }
    if let output = out, output.notEmpty {
        await summarizeSessionRun(run, output: output)
    }
    await graphRunRegistry.remove(run.log.id)
    cleanupRunArtifacts(run.log.id, mcpPath: run.mcpPath)
}

private func execSessionRun(_ run: SessionRunExecution) async -> String? {
    let env = runEnv(mcpPath: run.mcpPath, runDir: GraphStore.contextRunDir(run.log.id))
    return try? await exec(
        run.script.string,
        args: runArgs(try sessionExecPrompt(run), run.instancePath),
        chroot: run.instancePath,
        env: env
    )
}

/// The stored prompt stays clean for UI display; the exec prompt prefixes the same file refs node RUNs use: ctx.md, convo.md, parents, refs.
private func sessionExecPrompt(_ run: SessionRunExecution) throws -> String {
    var prefix = runFile(run.log.id, "ctx.md") != nil ? ctxFileLine : ""
    prefix += runFile(run.log.id, "convo.md") != nil ? convoFileLine : ""
    let parents = try parentContextFileNames(run.log.id)
    let refs = refContextFileNames(run.log.id)
    let files = parents + refs
    if files.notEmpty {
        let list = files
            .map { "@\(GraphStore.containerCtxDir)/\($0)" }
            .joined(separator: " ")
        prefix += "Context files (absolute paths at filesystem root, outside the working directory, read-only): \(list)\n"
    }
    return prefix + run.log.prompt
}

private func parentContextFileNames(_ runId: String) throws -> [String] {
    let dir = GraphStore.contextRunDir(runId)
    guard PathIO.isDirectoryExistent(atPath: dir.string) else { return [] }
    return try PathIO.contentsOfDirectory(atPath: dir.string)
        .filter { $0.hasPrefix("parent-") && $0.hasSuffix(".md") }
        .sorted()
}

private func summarizeSessionRun(_ run: SessionRunExecution, output: String) async {
    // Summaries are text filtering (question.md → answer.md) — MCP-free by decision; tools serve the answer phase only.
    let env = runEnv(mcpPath: nil, runDir: GraphStore.contextRunDir(run.log.id))
    guard let prompt = qaSummaryPrompt(
        question: run.log.prompt, answer: output, runId: run.log.id
    ) else {
        try? GraphStore.finishRunSummary(id: run.log.id, summary: nil, at: run.instancePath)
        return
    }
    let summary = await runScript(
        run.script, args: runArgs(prompt, run.instancePath),
        chroot: run.instancePath, env: env
    )
    let trimmed = summary.out?.trimmingCharacters(in: .whitespacesAndNewlines)
    let text = (trimmed?.isEmpty == true) ? nil : trimmed
    try? GraphStore.finishRunSummary(id: run.log.id, summary: text, at: run.instancePath)
    if let text {
        maybeAnalyze(
            id: run.log.id, question: run.log.prompt, summary: text,
            script: run.script, instancePath: run.instancePath
        )
    }
}

/// Run-0 summarization — the one place an empty summary is a FAILURE rather
/// than "answered": a thread root without a summary can never be followed
/// up, and the user explicitly asked for this row.
private func summarizeSeedRun(
    _ log: GraphRunLog, script: FilePath, instancePath: String
) async {
    defer { GraphStore.deleteContextRunDir(log.id) }
    assert((log.output ?? "").notEmpty, "run-0 seeds carry the tip persona's non-empty output")
    guard let output = log.output, output.notEmpty,
          let prompt = qaSummaryPrompt(question: log.prompt, answer: output, runId: log.id) else {
        try? GraphStore.updateRunLog(
            id: log.id, status: "failed", output: log.output, took: log.took, at: instancePath
        )
        await graphRunRegistry.remove(log.id)
        return
    }
    let summary = await runScript(
        script, args: runArgs(prompt, instancePath), chroot: instancePath,
        env: runEnv(mcpPath: nil, runDir: GraphStore.contextRunDir(log.id))
    )
    let trimmed = summary.out?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let trimmed, trimmed.notEmpty {
        try? GraphStore.finishRunSummary(id: log.id, summary: trimmed, at: instancePath)
        maybeAnalyze(id: log.id, question: log.prompt, summary: trimmed, script: script, instancePath: instancePath)
    } else {
        try? GraphStore.updateRunLog(
            id: log.id, status: "failed", output: log.output, took: log.took, at: instancePath
        )
    }
    await graphRunRegistry.remove(log.id)
}
