import XCTest
import SQLite
import SystemPackage
import shared

final class GraphStoreTests: XCTestCase {

    var path: String!

    override func setUpWithError() throws {
        path = NSTemporaryDirectory() + "openloop-graphstore-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        try GraphStore.createTables(at: path)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(atPath: path)
    }

    func node(_ id: String, _ parent: String?, status: String = "success") -> GraphNode {
        GraphNode(
            id: id, parentId: parent, prompt: "p \(id)", agent: "a", status: status,
            output: nil, took: nil, mcp: nil, createdAt: 1, completedAt: nil
        )
    }

    func insert(_ nodes: GraphNode...) throws {
        for n in nodes { try GraphStore.insertNode(n, at: path) }
    }

    func remaining() throws -> [String: GraphNode] {
        try GraphStore.fetchNodes(at: path).reduce(into: [:]) { $0[$1.id] = $1 }
    }

    func runLog(_ id: String, node: String, status: String = "success", parent: String? = nil, root: String? = nil, refIds: [String]? = nil) -> GraphRunLog {
        GraphRunLog(id: id, nodeId: node, prompt: "p", status: status, output: nil, took: nil, createdAt: 1, completedAt: nil, parentRunId: parent, rootRunId: root, refNodeIds: refIds)
    }

    func testDeleteLeafRemovesOnlyThatNode() throws {
        try insert(node("a", nil), node("b", nil))
        try GraphStore.deleteNode(id: "a", at: path)
        XCTAssertEqual(Set(try remaining().keys), ["b"])
    }

    // ── nearestWinsMcpUnion: the cross-folder MCP merge — nearest folder
    // owns a URL's auth, no ghost `host-2` duplicate survives. ───────────

    func endpoint(_ url: String, _ auth: String?) -> GraphMcpEndpoint {
        GraphMcpEndpoint(url: url, auth: auth)
    }

    func testNearestWinsMcpUnionTakesFirstAuthPerUrl() {
        let near: Set<GraphMcpEndpoint> = [
            endpoint("https://a.example", "near"),
            endpoint("https://b.example", "only-near"),
        ]
        let far: Set<GraphMcpEndpoint> = [
            endpoint("https://a.example", "far"),
            endpoint("https://c.example", nil),
        ]
        let merged = GraphStore.nearestWinsMcpUnion([near, far])
        XCTAssertEqual(merged.count, 3, "one entry per URL, the loser must not survive as a duplicate")
        XCTAssertEqual(merged.first { $0.url == "https://a.example" }?.auth, "near")
        XCTAssertEqual(merged.first { $0.url == "https://b.example" }?.auth, "only-near")
        XCTAssertNil(merged.first { $0.url == "https://c.example" }?.auth)
    }

    func testNearestWinsMcpUnionOverEmptyFoldersKeepsEverything() {
        let global: Set<GraphMcpEndpoint> = [endpoint("https://g.example", "k")]
        let merged = GraphStore.nearestWinsMcpUnion([[], global, []])
        XCTAssertEqual(merged, global)
    }

    func testNearestWinsMcpUnionEmptyInputIsEmpty() {
        XCTAssertTrue(GraphStore.nearestWinsMcpUnion([]).isEmpty)
    }

    func testDeleteMidChainBridgesChildrenToGrandparent() throws {
        try insert(node("a", nil), node("b", "a"), node("c", "b"))
        try GraphStore.deleteNode(id: "b", at: path)
        let left = try remaining()
        XCTAssertEqual(Set(left.keys), ["a", "c"])
        XCTAssertEqual(left["c"]?.parentId, "a")
    }

    func testDeleteRootMakesChildrenRoots() throws {
        try insert(node("a", nil), node("b", "a"))
        try GraphStore.deleteNode(id: "a", at: path)
        let left = try remaining()
        XCTAssertEqual(Set(left.keys), ["b"])
        XCTAssertNil(left["b"]?.parentId)
    }

    func testDeleteNodesRemovesWholeSubtreeOnly() throws {
        try insert(node("a", nil), node("b", "a"), node("c", "b"), node("d", "a"), node("e", nil), node("f", "e"))
        let all = try GraphStore.fetchNodes(at: path)
        let subtree = GraphStore.subtreeIds(of: all[0], in: all)
        XCTAssertEqual(subtree, ["a", "b", "c", "d"])
        try GraphStore.deleteNodes(ids: subtree, at: path)
        XCTAssertEqual(Set(try remaining().keys), ["e", "f"])
    }

    func testDeleteNodeCascadesRunLogs() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("l1", node: "a"), at: path)
        try GraphStore.deleteNode(id: "a", at: path)
        XCTAssertTrue(try GraphStore.fetchRunLogs(nodeId: "a", at: path).isEmpty)
        XCTAssertNil(try GraphStore.fetchRunCounts(at: path)["a"])
    }

    // ── deleteRunLog: the "delete a turn" contract shared by node threads
    // and session threads — `next` reparents to `deleted.parent`. ─────────

    func runLogsById() throws -> [String: GraphRunLog] {
        try GraphStore.fetchRunLogs(nodeId: "a", at: path)
            .reduce(into: [:]) { $0[$1.id] = $1 }
    }

    func testDeleteRunLogLeafRemovesOnlyThatRun() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a", parent: "r1", root: "r1"), at: path)
        try GraphStore.deleteRunLog(id: "r2", at: path)
        XCTAssertEqual(Set(try runLogsById().keys), ["r1"])
    }

    func testDeleteRunLogMidThreadBridgesChildrenToGrandparent() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a", parent: "r1", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r3", node: "a", parent: "r2", root: "r1"), at: path)
        try GraphStore.deleteRunLog(id: "r2", at: path)
        let left = try runLogsById()
        XCTAssertEqual(left["r3"]?.parentRunId, "r1") // next reparents to deleted.parent
        XCTAssertEqual(left["r3"]?.rootRunId, "r1") // living root — untouched
    }

    func testDeleteRunLogRootReRootsChildren() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a", parent: "r1", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r3", node: "a", parent: "r2", root: "r1"), at: path)
        try GraphStore.deleteRunLog(id: "r1", at: path)
        let left = try runLogsById()
        XCTAssertNil(left["r2"]?.parentRunId)
        XCTAssertEqual(left["r2"]?.rootRunId, "r2") // child promotes to root
        XCTAssertEqual(left["r3"]?.rootRunId, "r2") // descendants follow
    }

    func testDeleteRunLogKeepsUnrelatedThreadsIntact() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("t1", node: "a", root: "t1"), at: path)
        try GraphStore.insertRunLog(runLog("t2", node: "a", parent: "t1", root: "t1"), at: path)
        try GraphStore.insertRunLog(runLog("u1", node: "a", root: "u1"), at: path)
        try GraphStore.deleteRunLog(id: "t1", at: path)
        let left = try runLogsById()
        XCTAssertEqual(left["u1"]?.rootRunId, "u1")
        XCTAssertNil(left["t2"]?.parentRunId)
    }

    func testDeleteRunLogDropsKindMarkerAndReads() throws {
        try LogManager.createTables(at: path) // owns notification_reads
        try GraphStore.insertSessionRunLog(
            GraphRunLog(id: "sr1", nodeId: "sess-1", prompt: "p", status: "success", output: "o", took: 1, createdAt: 2, completedAt: 3),
            session: "sess-1", workflowId: "wf", at: path
        )
        try LogManager.markNotificationRead(kind: "session_run", refId: "sr1", at: path)
        try GraphStore.deleteRunLog(id: "sr1", at: path)
        XCTAssertNil(try LogManager.fetchNotificationKinds(at: path)["sr1"])
        XCTAssertFalse(try LogManager.fetchReadNotificationRefs(kind: "session_run", at: path).contains("sr1"))
        XCTAssertTrue(try GraphStore.fetchRunLogs(nodeId: "sess-1", at: path).isEmpty)
    }

    func testDeleteRunLogDoesNotChangeThreadCounts() throws {
        // the fetchRunCounts invariant: badges track thread ROOTS only —
        // mid delete keeps the root, root delete promotes its child. Deleting
        // a turn never moves the badge.
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", status: "success", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a", status: "success", parent: "r1", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r3", node: "a", status: "success", parent: "r2", root: "r1"), at: path)
        try GraphStore.deleteRunLog(id: "r2", at: path) // mid
        XCTAssertEqual(try GraphStore.fetchRunCounts(at: path)["a"]?.total, 1)
        try GraphStore.deleteRunLog(id: "r1", at: path) // root
        XCTAssertEqual(try GraphStore.fetchRunCounts(at: path)["a"]?.total, 1)
    }

    // ── deleteRunThread: the runs-list delete — root + every follow-up go,
    // the conversation twin of deleteNodes' subtree cascade. ──────────────

    func testDeleteRunThreadRemovesRootAndFollowUps() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("t1", node: "a", root: "t1"), at: path)
        try GraphStore.insertRunLog(runLog("t2", node: "a", parent: "t1", root: "t1"), at: path)
        try GraphStore.insertRunLog(runLog("t3", node: "a", parent: "t2", root: "t1"), at: path)
        let thread = try GraphStore.fetchRunThread(rootId: "t1", at: path)
        XCTAssertEqual(thread.map(\.id), ["t1", "t2", "t3"], "fetchRunThread: root included, oldest first")
        try GraphStore.deleteRunThread(id: "t1", at: path)
        XCTAssertTrue(try runLogsById().isEmpty)
    }

    func testDeleteRunThreadKeepsUnrelatedThreadsIntact() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("t1", node: "a", root: "t1"), at: path)
        try GraphStore.insertRunLog(runLog("t2", node: "a", parent: "t1", root: "t1"), at: path)
        try GraphStore.insertRunLog(runLog("u1", node: "a", root: "u1"), at: path)
        try GraphStore.insertRunLog(runLog("u2", node: "a", parent: "u1", root: "u1"), at: path)
        try GraphStore.deleteRunThread(id: "t1", at: path)
        let left = try runLogsById()
        XCTAssertEqual(Set(left.keys), ["u1", "u2"])
        XCTAssertEqual(left["u2"]?.rootRunId, "u1")
    }

    func testDeleteRunThreadDropsKindMarkersAndReads() throws {
        try LogManager.createTables(at: path) // owns notification_reads
        for id in ["sr1", "sr2"] {
            try GraphStore.insertSessionRunLog(
                GraphRunLog(id: id, nodeId: "sess-1", prompt: "p", status: "success", output: "o", took: 1, createdAt: 2, completedAt: 3, parentRunId: id == "sr1" ? nil : "sr1", rootRunId: "sr1"),
                session: "sess-1", workflowId: "wf", at: path
            )
            try LogManager.markNotificationRead(kind: "session_run", refId: id, at: path)
        }
        try GraphStore.deleteRunThread(id: "sr1", at: path)
        XCTAssertTrue(try LogManager.fetchNotificationKinds(at: path).isEmpty, "every deleted row's marker drops")
        XCTAssertTrue(try LogManager.fetchReadNotificationRefs(kind: "session_run", at: path).isEmpty)
        XCTAssertTrue(try GraphStore.fetchRunLogs(nodeId: "sess-1", at: path).isEmpty)
    }

    func testDeleteRunThreadDecrementsThreadCounts() throws {
        // the badge tracks roots — a turn delete never moves it, a thread
        // delete removes exactly one root.
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("t1", node: "a", status: "success", root: "t1"), at: path)
        try GraphStore.insertRunLog(runLog("t2", node: "a", status: "success", parent: "t1", root: "t1"), at: path)
        try GraphStore.insertRunLog(runLog("u1", node: "a", status: "success", root: "u1"), at: path)
        XCTAssertEqual(try GraphStore.fetchRunCounts(at: path)["a"]?.total, 2)
        try GraphStore.deleteRunThread(id: "t1", at: path)
        XCTAssertEqual(try GraphStore.fetchRunCounts(at: path)["a"]?.total, 1)
    }

    func testCreateTablesRepairsDanglingRootRunIds() throws {
        // pre-feature manual delete / interrupted splice: a row whose root
        // points at a run that no longer exists self-heals at boot
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a", parent: "r1", root: "r1"), at: path)
        let db = try Connection(GraphStore.dbPath(at: path))
        try db.run("DELETE FROM graph_run_logs WHERE id = 'r1';")
        try GraphStore.createTables(at: path) // boot path
        XCTAssertEqual(try runLogsById()["r2"]?.rootRunId, "r2")
    }

    func testRunCountsTrackProgressRows() throws {
        // pins the counting invariant where it lives: total = success + failed + active
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("l1", node: "a", status: "success"), at: path)
        try GraphStore.insertRunLog(runLog("l2", node: "a", status: "progress"), at: path)
        try GraphStore.insertRunLog(runLog("l3", node: "a", status: "progress"), at: path)
        let counts = try XCTUnwrap(GraphStore.fetchRunCounts(at: path)["a"])
        XCTAssertEqual(counts.total, 3)
        XCTAssertEqual(counts.success, 1)
        XCTAssertEqual(counts.failed, 0)
        XCTAssertEqual(counts.active, 2)
    }

    func testRunCountsTreatSummarizingAsActive() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("l1", node: "a", status: "summarizing"), at: path)
        let counts = try XCTUnwrap(GraphStore.fetchRunCounts(at: path)["a"])
        XCTAssertEqual(counts.total, 1)
        XCTAssertEqual(counts.active, 1)
    }

    private func sessionRun(_ id: String, status: String) throws {
        try GraphStore.insertSessionRunLog(
            GraphRunLog(id: id, nodeId: "sess-1", prompt: "p", status: status, output: nil, took: nil, createdAt: 1, completedAt: nil),
            session: "sess-1", workflowId: "wf", at: path
        )
    }

    private func assertRunning(_ node: Int, _ session: Int, line: UInt = #line) {
        let c = GraphStore.countRunningRunLogs(at: path)
        XCTAssertEqual(c.node, node, line: line)
        XCTAssertEqual(c.session, session, line: line)
    }

    func testCountRunningSplitsNodeAndSessionRuns() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("n1", node: "a", status: "progress"), at: path)
        try GraphStore.insertRunLog(runLog("n2", node: "a", status: "failed"), at: path)
        try sessionRun("s1", status: "summarizing")
        assertRunning(1, 1)
    }

    func testCountRunningCountsEveryInFlightRowNotRoots() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", status: "progress", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a", status: "progress", parent: "r1", root: "r1"), at: path)
        try sessionRun("s1", status: "progress")
        assertRunning(2, 1)
    }

    func testCountRunningTreatsSummarizingAsRunning() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("n1", node: "a", status: "summarizing"), at: path)
        assertRunning(1, 0)
    }

    func testCountRunningEmptyDbIsZeroZero() {
        assertRunning(0, 0)
    }

    func testCountRunningToleratesMissingInstanceDir() {
        let missing = NSTemporaryDirectory() + "openloop-no-such-\(UUID().uuidString)"
        let c = GraphStore.countRunningRunLogs(at: missing)
        XCTAssertEqual(c.node, 0)
        XCTAssertEqual(c.session, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: missing), "a badge read must not create anything")
    }

    func testCountRunningToleratesLogOnlyDb() throws {
        let logOnly = NSTemporaryDirectory() + "openloop-logonly-\(UUID().uuidString)"
        try FileManager.default.createDirectory(
            atPath: logOnly + "/.openloop", withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(atPath: logOnly) }
        try LogManager.createTables(at: logOnly)

        let c = GraphStore.countRunningRunLogs(at: logOnly)
        XCTAssertEqual(c.node, 0)
        XCTAssertEqual(c.session, 0)
    }

    func testCountRunningToleratesDbWithoutKindMarkers() throws {
        let db = try Connection(GraphStore.dbPath(at: path))
        try db.run("DROP TABLE notification_kinds;")
        assertRunning(0, 0)
    }

    func testRunChainWalksParentRunIdsOldestFirst() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(GraphRunLog(id: "r1", nodeId: "a", prompt: "p", status: "success", output: "o", took: 1, createdAt: 1, completedAt: nil), at: path)
        try GraphStore.insertRunLog(GraphRunLog(id: "r2", nodeId: "a", prompt: "p", status: "success", output: "o", took: 1, createdAt: 2, completedAt: nil, parentRunId: "r1"), at: path)
        try GraphStore.insertRunLog(GraphRunLog(id: "r3", nodeId: "a", prompt: "p", status: "progress", output: nil, took: nil, createdAt: 3, completedAt: nil, parentRunId: "r2"), at: path)
        let logs = try GraphStore.fetchRunLogs(nodeId: "a", at: path)
        let chain = GraphStore.runChain(of: logs[0], in: logs)
        XCTAssertEqual(chain.map(\.id), ["r1", "r2", "r3"])
    }

    func testRunSummariesSkipsUnsummarized() throws {
        let chain = [
            GraphRunLog(id: "r1", nodeId: "a", prompt: "p", status: "success", output: "o", took: 1, createdAt: 1, completedAt: nil, summary: "s1"),
            GraphRunLog(id: "r2", nodeId: "a", prompt: "p", status: "answered", output: "o", took: 1, createdAt: 2, completedAt: nil),
            GraphRunLog(id: "r3", nodeId: "a", prompt: "p", status: "success", output: "o", took: 1, createdAt: 3, completedAt: nil, summary: "s3")
        ]
        XCTAssertEqual(GraphStore.runSummaries(chain), "s1\n\n---\n\ns3")
    }

    func testFollowupConvoContextIncludesParentSummary() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(GraphRunLog(id: "r1", nodeId: "a", prompt: "p", status: "success", output: "o", took: 1, createdAt: 1, completedAt: nil), at: path)
        try GraphStore.insertRunLog(GraphRunLog(id: "r2", nodeId: "a", prompt: "p", status: "success", output: "o", took: 1, createdAt: 2, completedAt: nil, parentRunId: "r1"), at: path)
        try GraphStore.finishRunSummary(id: "r1", summary: "s1", at: path)
        try GraphStore.finishRunSummary(id: "r2", summary: "s2", at: path)
        let logs = try GraphStore.fetchRunLogs(nodeId: "a", at: path)
        let parent = try XCTUnwrap(logs.first { $0.id == "r2" })
        XCTAssertEqual(GraphStore.runSummaries(GraphStore.runChain(of: parent, in: logs)), "s1\n\n---\n\ns2")
    }

    func testFinishRunSummaryRoundTrip() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("l1", node: "a", status: "summarizing"), at: path)
        try GraphStore.finishRunSummary(id: "l1", summary: "  x  ", at: path)
        var run = try XCTUnwrap(try GraphStore.fetchRunLogs(nodeId: "a", at: path).first { $0.id == "l1" })
        XCTAssertEqual(run.status, "success")
        XCTAssertEqual(run.summary, "  x  ")
        try GraphStore.finishRunSummary(id: "l1", summary: nil, at: path)
        run = try XCTUnwrap(try GraphStore.fetchRunLogs(nodeId: "a", at: path).first { $0.id == "l1" })
        XCTAssertEqual(run.status, "answered")
        XCTAssertNil(run.summary)
    }

    // ── The advisory scope audit: two columns, marker then verdict, cleared by every summary rewrite. ──

    func testAuditMarkerThenVerdictRoundTrip() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a"), at: path)
        try GraphStore.markRunAuditing(id: "r1", at: path)
        var run = try XCTUnwrap(try runLogsById()["r1"])
        XCTAssertEqual(run.auditStatus, "analyzing")
        XCTAssertNil(run.audit, "the marker arms with no verdict — the pulse, not a band")
        try GraphStore.finishRunAudit(id: "r1", audit: "beyond scope: refactored the parser too", at: path)
        run = try XCTUnwrap(try runLogsById()["r1"])
        XCTAssertEqual(run.audit, "beyond scope: refactored the parser too")
        XCTAssertNil(run.auditStatus, "the terminal write clears the marker in the same statement")
    }

    func testFinishRunAuditFailureWritesNeutral() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a"), at: path)
        try GraphStore.markRunAuditing(id: "r1", at: path)
        try GraphStore.finishRunAudit(id: "r1", audit: nil, at: path)
        let run = try XCTUnwrap(try runLogsById()["r1"])
        XCTAssertNil(run.audit)
        XCTAssertNil(run.auditStatus, "a failed analysis renders neutral — no pulse forever")
    }

    func testFreshRowReadsNeutralAudit() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a"), at: path)
        let run = try XCTUnwrap(try runLogsById()["r1"])
        XCTAssertNil(run.audit, "not audited is not audited clean — fresh rows render nothing")
        XCTAssertNil(run.auditStatus)
    }

    func testFinishRunSummaryClearsAuditPair() throws {
        // manual edits and every regen land here — a badge must never lie over a rewritten summary
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", status: "summarizing"), at: path)
        try GraphStore.markRunAuditing(id: "r1", at: path)
        try GraphStore.finishRunAudit(id: "r1", audit: "All clear", at: path)
        try GraphStore.finishRunSummary(id: "r1", summary: "hand-edited", at: path)
        let run = try XCTUnwrap(try runLogsById()["r1"])
        XCTAssertNil(run.audit)
        XCTAssertNil(run.auditStatus)
    }

    func testRestartRunLogClearsAuditPair() throws {
        // belt-and-braces for retries: the old verdict dies with the old answer
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", status: "failed"), at: path)
        try GraphStore.markRunAuditing(id: "r1", at: path)
        try GraphStore.finishRunAudit(id: "r1", audit: "beyond scope: also rewrote the tests", at: path)
        try GraphStore.restartRunLog(id: "r1", at: path)
        let run = try XCTUnwrap(try runLogsById()["r1"])
        XCTAssertNil(run.audit)
        XCTAssertNil(run.auditStatus)
    }

    func testSweepStuckRunAuditsClearsMarkersOnly() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a"), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a"), at: path)
        try GraphStore.markRunAuditing(id: "r1", at: path) // a restart interrupted this one
        try GraphStore.finishRunAudit(id: "r2", audit: "x", at: path)
        try GraphStore.sweepStuckRunAudits(at: path)
        let runs = try runLogsById()
        XCTAssertNil(runs["r1"]?.auditStatus, "a restart must not leave rows pulsing forever")
        XCTAssertNil(runs["r1"]?.audit)
        XCTAssertEqual(runs["r2"]?.audit, "x", "the sweep touches only stuck markers")
        XCTAssertNil(runs["r2"]?.auditStatus)
    }

    func testLegacyRunDbMigratesAuditColumns() throws {
        let legacy = try legacyRunDb()
        defer { try? FileManager.default.removeItem(atPath: legacy) }
        let db = try Connection(GraphStore.dbPath(at: legacy))
        try insertLegacyRun(db, id: "r1", parent: nil)
        try GraphStore.createTables(at: legacy) // boot path — adds audit/audit_status
        let run = try XCTUnwrap(try GraphStore.fetchRunLogs(nodeId: "a", at: legacy).first { $0.id == "r1" })
        XCTAssertNil(run.audit, "legacy rows read neutral")
        XCTAssertNil(run.auditStatus)
    }

    func testInsertRunLogPersistsParentRunId() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(GraphRunLog(id: "r1", nodeId: "a", prompt: "p", status: "success", output: "o", took: 1, createdAt: 1, completedAt: nil), at: path)
        try GraphStore.insertRunLog(GraphRunLog(id: "r2", nodeId: "a", prompt: "p", status: "progress", output: nil, took: nil, createdAt: 2, completedAt: nil, parentRunId: "r1"), at: path)
        let run = try XCTUnwrap(try GraphStore.fetchRunLogs(nodeId: "a", at: path).first { $0.id == "r2" })
        XCTAssertEqual(run.parentRunId, "r1")
    }

    func testInsertRunLogPersistsRootRunId() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a", parent: "r1", root: "r1"), at: path)
        let roots = try GraphStore.fetchRunLogs(nodeId: "a", at: path)
            .reduce(into: [:]) { $0[$1.id] = $1.rootRunId }
        XCTAssertEqual(roots, ["r1": "r1", "r2": "r1"])
    }

    func testRestartRunLogResetsToProgress() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(GraphRunLog(id: "r1", nodeId: "a", prompt: "p", status: "failed", output: "interrupted", took: 3, createdAt: 1, completedAt: 2), at: path)
        try GraphStore.restartRunLog(id: "r1", at: path)
        let run = try XCTUnwrap(try GraphStore.fetchRunLogs(nodeId: "a", at: path).first { $0.id == "r1" })
        XCTAssertEqual(run.status, "progress")
        XCTAssertNil(run.output)
        XCTAssertNil(run.took)
        XCTAssertNil(run.completedAt)
    }

    func testRunCountsExcludeFollowupRuns() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", status: "success"), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a", status: "success", parent: "r1", root: "r1"), at: path)
        try GraphStore.insertRunLog(runLog("r3", node: "a", status: "progress", parent: "r2", root: "r1"), at: path)
        let counts = try GraphStore.fetchRunCounts(at: path)["a"]
        XCTAssertEqual(counts?.total, 1)
        XCTAssertEqual(counts?.success, 1)
        XCTAssertEqual(counts?.active, 0)
    }

    // ── Session follow-ups: rows anchored on the session UUID (node_id),
    // kind persisted transactionally as a notification_kinds marker. ───────

    func testInsertSessionRunLogWritesRowAndKindMarker() throws {
        let log = GraphRunLog(
            id: "sr1", nodeId: "sess-1", prompt: "p", status: "summarizing",
            output: "answer", took: 1, createdAt: 10, completedAt: 11,
            rootRunId: "sr1"
        )
        try GraphStore.insertSessionRunLog(log, session: "sess-1", workflowId: "wf", at: path)
        let rows = try GraphStore.fetchRunLogs(nodeId: "sess-1", at: path)
        XCTAssertEqual(rows.map(\.id), ["sr1"])
        XCTAssertEqual(rows[0].completedAt, 11) // seed rows are born completed
        let markers = try LogManager.fetchNotificationKinds(at: path)
        XCTAssertEqual(
            markers["sr1"],
            NotificationKindMarker(runId: "sr1", kind: "session_run", session: "sess-1", workflowId: "wf")
        )
    }

    func testSessionRunsDoNotInflateNodeRunCounts() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", status: "success"), at: path)
        try GraphStore.insertSessionRunLog(
            GraphRunLog(id: "sr1", nodeId: "sess-1", prompt: "p", status: "success", output: "o", took: 1, createdAt: 2, completedAt: 3),
            session: "sess-1", workflowId: "wf", at: path
        )
        // the session UUID is not a node id — its rows are inert for counts
        let counts = try GraphStore.fetchRunCounts(at: path)
        XCTAssertEqual(counts["a"]?.total, 1)
        XCTAssertNil(counts["sess-1"])
    }

    func testChainTextIncludesNodeOwnSummary() throws {
        try insert(node("a", nil))
        try insert(GraphNode(
            id: "b", parentId: "a", prompt: "p", agent: "a", status: "success",
            output: nil, took: nil, mcp: nil, summary: "child summary", createdAt: 2, completedAt: nil
        ))
        try GraphStore.updateSummary(id: "a", summary: "root summary", at: path)
        let nodes = try GraphStore.fetchNodes(at: path)
        let child = try XCTUnwrap(nodes.first { $0.id == "b" })
        XCTAssertEqual(GraphStore.chainText(GraphStore.chain(of: child, in: nodes)), "root summary\n\n---\n\nchild summary")
    }

    // refContextText: gate on the referenced node's own summary, content from its whole chain

    func insertSummarized(_ id: String, _ parent: String?, _ summary: String?) throws {
        try insert(GraphNode(
            id: id, parentId: parent, prompt: "p", agent: "a", status: "success",
            output: nil, took: nil, mcp: nil, summary: summary, createdAt: 1, completedAt: nil
        ))
    }

    func testRefContextTextCarriesWholeChainOldestFirst() throws {
        // a summary-less middle node skips silently
        try insertSummarized("root", nil, "root summary")
        try insertSummarized("mid", "root", nil)
        try insertSummarized("ref", "mid", "ref summary")
        let nodes = try GraphStore.fetchNodes(at: path)
        let ref = try XCTUnwrap(nodes.first { $0.id == "ref" })
        XCTAssertEqual(
            GraphStore.refContextText(node: ref, chain: GraphStore.chain(of: ref, in: nodes)),
            "root summary\n\n---\n\nref summary"
        )
    }

    func testRefContextTextGateIsThePickedNodeNotItsParents() throws {
        // parents carry summaries, the picked node doesn't → no file rides
        try insertSummarized("root", nil, "root summary")
        try insertSummarized("ref", "root", nil)
        let nodes = try GraphStore.fetchNodes(at: path)
        let ref = try XCTUnwrap(nodes.first { $0.id == "ref" })
        XCTAssertNil(GraphStore.refContextText(node: ref, chain: GraphStore.chain(of: ref, in: nodes)))
    }

    func testRefContextTextDropsDormantAncestors() throws {
        // a dormant ancestor's summary drops out exactly where its MCPs do
        try insertSummarized("root", nil, "root summary")
        try insertSummarized("mid", "root", "mid summary")
        try insertSummarized("ref", "mid", "ref summary")
        try GraphStore.updateActive(id: "mid", active: false, at: path)
        let nodes = try GraphStore.fetchNodes(at: path)
        let ref = try XCTUnwrap(nodes.first { $0.id == "ref" })
        XCTAssertEqual(
            GraphStore.refContextText(node: ref, chain: GraphStore.chain(of: ref, in: nodes)),
            "root summary\n\n---\n\nref summary"
        )
    }

    // ref_node_ids: persist on insert, survive a retry's restart untouched

    func testRefNodeIdsRoundTripBothInsertPaths() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", refIds: ["n1", "n2"]), at: path)
        try GraphStore.insertSessionRunLog(runLog("s1", node: "sess-1", refIds: ["n3"]), session: "sess-1", workflowId: "wf", at: path)
        let runs = try GraphStore.fetchRunLogs(nodeId: "a", at: path)
        XCTAssertEqual(runs.first { $0.id == "r1" }?.refNodeIds, ["n1", "n2"])
        let sessions = try GraphStore.fetchRunLogs(nodeId: "sess-1", at: path)
        XCTAssertEqual(sessions.first { $0.id == "s1" }?.refNodeIds, ["n3"])
    }

    func testRefNodeIdsNilWhenAbsentAndKeptThroughRestart() throws {
        try insert(node("a", nil))
        try GraphStore.insertRunLog(runLog("r1", node: "a", status: "failed", refIds: ["n1"]), at: path)
        try GraphStore.insertRunLog(runLog("r2", node: "a"), at: path) // no refs -> column nil, decodes nil
        try GraphStore.restartRunLog(id: "r1", at: path) // the retry path: must not touch the column
        let runs = try GraphStore.fetchRunLogs(nodeId: "a", at: path)
        XCTAssertEqual(runs.first { $0.id == "r1" }?.refNodeIds, ["n1"])
        XCTAssertNil(runs.first { $0.id == "r2" }?.refNodeIds)
    }

    func testEncodeDecodeRefNodeIds() {
        XCTAssertEqual(GraphStore.decodeRefNodeIds(GraphStore.encodeRefNodeIds(nil)), nil)
        XCTAssertEqual(GraphStore.decodeRefNodeIds(GraphStore.encodeRefNodeIds([])), nil)
        XCTAssertEqual(GraphStore.decodeRefNodeIds(GraphStore.encodeRefNodeIds(["a", "b"])), ["a", "b"])
        XCTAssertEqual(GraphStore.decodeRefNodeIds("not json"), nil)
        XCTAssertEqual(GraphStore.decodeRefNodeIds(nil), nil)
    }

    // chainMcpUrls: the count-only twin of chainMcpEndpoints — unique URLs along an ACTIVE chain
    func testChainMcpUrlsDedupesAndSkipsInactive() throws {
        try insert(node("root", nil))
        try insert(node("mid", "root"))
        try insert(node("leaf", "mid"))
        try GraphStore.updateMcp(id: "root", mcp: "https://a.example", at: path)
        try GraphStore.updateMcp(id: "mid", mcp: "https://a.example", at: path) // duplicate URL — one entry
        try GraphStore.updateMcp(id: "leaf", mcp: "https://b.example", at: path)
        var nodes = try remaining()
        let leaf = nodes["leaf"]!
        XCTAssertEqual(GraphStore.chainMcpUrls(GraphStore.chain(of: leaf, in: Array(nodes.values))).sorted(),
                       ["https://a.example", "https://b.example"])
        // a dormant MIDDLE node drops only its own endpoint — the active root's URL still rides
        try GraphStore.updateActive(id: "mid", active: false, at: path)
        nodes = try remaining()
        XCTAssertEqual(GraphStore.chainMcpUrls(GraphStore.chain(of: leaf, in: Array(nodes.values))).sorted(),
                       ["https://a.example", "https://b.example"])
        // dormant root as well — only the leaf's own endpoint remains
        try GraphStore.updateActive(id: "root", active: false, at: path)
        nodes = try remaining()
        XCTAssertEqual(GraphStore.chainMcpUrls(GraphStore.chain(of: leaf, in: Array(nodes.values))), ["https://b.example"])
    }

    func testLegacyDbBackfillsRootRunIdFromParentChain() throws {
        let legacy = try legacyRunDb()
        defer { try? FileManager.default.removeItem(atPath: legacy) }
        let db = try Connection(GraphStore.dbPath(at: legacy))
        try insertLegacyRun(db, id: "r1", parent: nil)
        try insertLegacyRun(db, id: "r2", parent: "r1")
        try insertLegacyRun(db, id: "r3", parent: "r2")
        try GraphStore.createTables(at: legacy)
        let roots = try GraphStore.fetchRunLogs(nodeId: "a", at: legacy)
            .reduce(into: [:]) { $0[$1.id] = $1.rootRunId }
        XCTAssertEqual(roots, ["r1": "r1", "r2": "r1", "r3": "r1"])
    }

    func legacyRunDb() throws -> String {
        let dir = NSTemporaryDirectory() + "openloop-graphstore-legacy-runs-\(UUID().uuidString)"
        try FileManager.default.createDirectory(
            atPath: (dir as NSString).appendingPathComponent(Paths.dataFolderName),
            withIntermediateDirectories: true
        )
        let db = try Connection(GraphStore.dbPath(at: dir))
        try db.execute("""
        CREATE TABLE graph_run_logs (
            id TEXT PRIMARY KEY,
            node_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            status TEXT NOT NULL,
            output TEXT,
            took INTEGER,
            created_at REAL NOT NULL,
            completed_at REAL,
            parent_run_id TEXT,
            summary TEXT
        );
        """)
        return dir
    }

    func insertLegacyRun(_ db: Connection, id: String, parent: String?) throws {
        try db.run(
            "INSERT INTO graph_run_logs (id, node_id, prompt, status, output, took, created_at, completed_at, parent_run_id, summary) VALUES (?, 'a', 'p', 'success', NULL, NULL, 1, NULL, ?, NULL);",
            id, parent
        )
    }

    func testDeleteNodesCascadesRunLogsOfDescendants() throws {
        try insert(node("a", nil), node("b", "a"))
        try GraphStore.insertRunLog(runLog("l1", node: "a"), at: path)
        try GraphStore.insertRunLog(runLog("l2", node: "b"), at: path)
        try GraphStore.deleteNodes(ids: ["a", "b"], at: path)
        XCTAssertTrue(try GraphStore.fetchRunCounts(at: path).isEmpty)
    }

    func testSubtreeIdsTerminatesOnParentCycle() throws {
        // corrupt-DB guard: a parent_id cycle must not hang the subtree walk
        try insert(node("a", "b"), node("b", "a"), node("c", "a"))
        let all = try GraphStore.fetchNodes(at: path)
        let subtree = GraphStore.subtreeIds(of: all[0], in: all)
        XCTAssertEqual(subtree, ["a", "b", "c"])
    }

    func testDeleteNodeKeepsUnrelatedChildrenUntouched() throws {
        try insert(node("a", nil), node("x", nil), node("y", "x"))
        try GraphStore.deleteNode(id: "a", at: path)
        let left = try remaining()
        XCTAssertEqual(left["y"]?.parentId, "x")
    }

    // — chain names (name lives on the node; NULL = unnamed) —

    func testNameRoundtripsThroughInsertAndFetch() throws {
        // summary/mcpRequiresAuth asserted alongside: file keys and decoder are
        // decoupled knowledge — any reshuffle must fail loudly on more than
        // the new field.
        try insert(
            node("a", nil),
            GraphNode(
                id: "n", parentId: nil, prompt: "p", agent: "a", status: "success",
                output: nil, took: nil, mcp: "https://mcp.example", mcpRequiresAuth: true,
                summary: "s", name: "alpha", createdAt: 1, completedAt: nil
            )
        )
        let left = try remaining()
        XCTAssertEqual(left["n"]?.name, "alpha")
        XCTAssertEqual(left["n"]?.summary, "s")
        XCTAssertEqual(left["n"]?.mcpRequiresAuth, true)
        XCTAssertEqual(left["a"]?.mcpRequiresAuth, false) // default — proves the flag is not stuck on
        XCTAssertNil(left["a"]?.name)
    }

    func testUpdateNameSetsAndClears() throws {
        try insert(node("a", nil))
        try GraphStore.updateName(id: "a", name: "alpha", at: path)
        XCTAssertEqual(try remaining()["a"]?.name, "alpha")
        try GraphStore.updateName(id: "a", name: nil, at: path) // nil = clear to NULL
        XCTAssertNil(try remaining()["a"]?.name)
    }

    func testUpdateAgentSwitchesAndPreservesOtherFields() throws {
        try insert(node("a", nil))
        try GraphStore.updateAgent(id: "a", agent: "cc_docker", at: path)
        let n = try XCTUnwrap(remaining()["a"])
        XCTAssertEqual(n.agent, "cc_docker")
        XCTAssertEqual(n.prompt, "p a") // the switch must not disturb neighbours
    }

    // — MCP auth: key in the per-machine secrets store, marker on the node —

    func testUpdateMcpAuthStoresKeyAndMarkerThenClearsBoth() throws {
        try insert(GraphNode(
            id: "a", parentId: nil, prompt: "p", agent: "x", status: "success",
            output: nil, took: nil, mcp: "https://mcp.example",
            createdAt: 1, completedAt: nil
        ))
        try GraphStore.updateMcpAuth(id: "a", auth: "Bearer k", at: path)
        XCTAssertEqual(SecretStore.secret(for: "https://mcp.example", at: path), "Bearer k")
        XCTAssertEqual(try remaining()["a"]?.mcpRequiresAuth, true)

        try GraphStore.updateMcpAuth(id: "a", auth: nil, at: path) // clear
        XCTAssertNil(SecretStore.secret(for: "https://mcp.example", at: path))
        XCTAssertEqual(try remaining()["a"]?.mcpRequiresAuth, false)
    }

    func testChainMcpEndpointsResolvesAuthFromSecretsOfThatInstance() throws {
        // auth is per-URL-per-instance: nodes read the secrets file of the
        // dir they live in — never a co-located node's stored key, never
        // another instance's store
        try insert(
            GraphNode(id: "a", parentId: nil, prompt: "p", agent: "x", status: "success",
                      output: nil, took: nil, mcp: "https://one.example", mcpRequiresAuth: true,
                      summary: "s", createdAt: 1, completedAt: nil),
            GraphNode(id: "b", parentId: nil, prompt: "p", agent: "x", status: "success",
                      output: nil, took: nil, mcp: "https://two.example", mcpRequiresAuth: true,
                      summary: "s", createdAt: 1, completedAt: nil)
        )
        try SecretStore.setSecret("k1", for: "https://one.example", at: path)
        let nodes = try GraphStore.fetchNodes(at: path)
        let endpoints = GraphStore.chainMcpEndpoints(nodes, at: path)
        XCTAssertEqual(endpoints, Set([
            GraphMcpEndpoint(url: "https://one.example", auth: "k1"),
            // marker says a key exists, this machine doesn't hold it (clone)
            GraphMcpEndpoint(url: "https://two.example", auth: nil),
        ]))
    }

    // The wire pair mcp_requires_auth/mcp_auth_local, aggregated for the graph
    // header warning and the instances list: only marker-set-but-not-held
    // counts. A marker-less URL (no key configured) and a held key are both
    // silence, and a missing nodes dir is 0 — the list API must stay cheap
    // and side-effect free.
    func testMcpAuthMissingCountCountsOnlyMarkerSetWithoutLocalKey() throws {
        try insert(
            GraphNode(id: "held", parentId: nil, prompt: "p", agent: "x", status: "success",
                      output: nil, took: nil, mcp: "https://one.example", mcpRequiresAuth: true,
                      summary: "s", createdAt: 1, completedAt: nil),
            GraphNode(id: "gone", parentId: nil, prompt: "p", agent: "x", status: "success",
                      output: nil, took: nil, mcp: "https://two.example", mcpRequiresAuth: true,
                      summary: "s", createdAt: 1, completedAt: nil),
            GraphNode(id: "gone2", parentId: nil, prompt: "p", agent: "x", status: "success",
                      output: nil, took: nil, mcp: "https://two.example", mcpRequiresAuth: true,
                      summary: "s", createdAt: 1, completedAt: nil),
            GraphNode(id: "bare", parentId: nil, prompt: "p", agent: "x", status: "success",
                      output: nil, took: nil, mcp: "https://three.example",
                      summary: "s", createdAt: 1, completedAt: nil)
        )
        try SecretStore.setSecret("k1", for: "https://one.example", at: path)
        XCTAssertEqual(GraphStore.mcpAuthMissingCount(at: path), 2)
        // one key fixes every node on that URL (dedup is the store's point)
        try SecretStore.setSecret("k2", for: "https://two.example", at: path)
        XCTAssertEqual(GraphStore.mcpAuthMissingCount(at: path), 0)
        let empty = NSTemporaryDirectory() + "openloop-graphstore-none-\(UUID().uuidString)"
        XCTAssertEqual(GraphStore.mcpAuthMissingCount(at: empty), 0)
    }

    // personaContextAcrossLadder: the ONE shared ladder walk — texts in ladder order, MCPs nearest-wins

    private struct Ladder {
        let tmp: String
        let inst: String
        let parentProject: String
        let global: String
    }

    private func makeLadder() throws -> Ladder {
        let tmp = NSTemporaryDirectory() + "openloop-persona-ladder-\(UUID().uuidString)"
        let parentProject = tmp + "/root"
        let inst = parentProject + "/inst"
        let global = tmp + "/global" // plays the user-global share
        for d in [parentProject, inst, global] {
            try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        }
        return Ladder(tmp: tmp, inst: inst, parentProject: parentProject, global: global)
    }

    private func personaNode(
        _ id: String, _ parent: String?, persona: String,
        summary: String?, mcp: String? = nil
    ) -> GraphNode {
        GraphNode(
            id: id, parentId: parent, prompt: "p", agent: "x", status: "success",
            output: nil, took: nil, mcp: mcp, summary: summary, personas: [persona],
            createdAt: 1, completedAt: nil
        )
    }

    private func ladderCtx(_ l: Ladder, persona: String) throws -> GraphStore.PersonaContext {
        try GraphStore.personaContextAcrossLadder(
            personaId: persona, from: FilePath(l.inst), globalRoot: FilePath(l.global)
        )
    }

    func testJoinedTextFencesBlocksAndDropsEmpties() {
        XCTAssertEqual(GraphStore.joinedText([]), "")
        XCTAssertEqual(GraphStore.joinedText(["", ""]), "", "empty texts are not blocks")
        XCTAssertEqual(GraphStore.joinedText(["a", "", "b"]), "a\n\n---\n\nb")
        XCTAssertEqual(GraphStore.joinedText(["a", "b"]), "a\n\n---\n\nb", "the exact fence chainText uses")
    }

    func testPersonaContextAcrossLadderCollectsTextsInLadderOrder() throws {
        let ladder = try makeLadder()
        defer { try? FileManager.default.removeItem(atPath: ladder.tmp) }
        try GraphStore.insertNode(personaNode("g1", nil, persona: "p", summary: "global"), at: ladder.global)
        try GraphStore.insertNode(personaNode("pp1", nil, persona: "p", summary: "parent"), at: ladder.parentProject)
        try GraphStore.insertNode(personaNode("i1", nil, persona: "p", summary: "inst root"), at: ladder.inst)
        try GraphStore.insertNode(personaNode("i2", "i1", persona: "p", summary: "inst leaf"), at: ladder.inst)
        let ctx = try ladderCtx(ladder, persona: "p")
        // one chain per folder (longest-wins inside a folder), folders nearest-first
        XCTAssertEqual(ctx.texts, ["inst root\n\n---\n\ninst leaf", "parent", "global"])
    }

    func testPersonaContextAcrossLadderMergesMcpsNearestWinsByFolder() throws {
        let ladder = try makeLadder()
        defer { try? FileManager.default.removeItem(atPath: ladder.tmp) }
        try GraphStore.insertNode(
            personaNode("i1", nil, persona: "p", summary: "s", mcp: "https://shared.example"),
            at: ladder.inst
        )
        try GraphStore.insertNode(
            personaNode("pp1", nil, persona: "p", summary: "s", mcp: "https://parent.example"),
            at: ladder.parentProject
        )
        try GraphStore.insertNode(
            personaNode("g1", nil, persona: "p", summary: "s", mcp: "https://shared.example"),
            at: ladder.global
        )
        // each folder's key lives in ITS OWN secrets store (auth is per-folder)
        try SecretStore.setSecret("near", for: "https://shared.example", at: ladder.inst)
        try SecretStore.setSecret("far", for: "https://shared.example", at: ladder.global)
        try SecretStore.setSecret("parent-key", for: "https://parent.example", at: ladder.parentProject)
        let ctx = try ladderCtx(ladder, persona: "p")
        XCTAssertEqual(ctx.mcps, Set([
            GraphMcpEndpoint(url: "https://shared.example", auth: "near"),
            GraphMcpEndpoint(url: "https://parent.example", auth: "parent-key"),
        ]), "the nearer folder owns a shared URL's auth — the share's loser must not survive as a ghost")
    }

    func testPersonaContextAcrossLadderGateIsTheTaggedNodesOwnSummary() throws {
        let ladder = try makeLadder()
        defer { try? FileManager.default.removeItem(atPath: ladder.tmp) }
        // tagged node without a summary and without a tagged descendant: its chain drops out entirely
        try GraphStore.insertNode(
            personaNode("bare", nil, persona: "p", summary: nil, mcp: "https://bare.example"),
            at: ladder.inst
        )
        var ctx = try ladderCtx(ladder, persona: "p")
        XCTAssertTrue(ctx.texts.isEmpty)
        XCTAssertTrue(ctx.mcps.isEmpty)
        // a summary-less MIDDLE member of a matched chain is not the gate
        try GraphStore.insertNode(
            personaNode("mid", nil, persona: "other", summary: nil, mcp: "https://mid.example"),
            at: ladder.inst
        )
        try GraphStore.insertNode(
            personaNode("leaf", "mid", persona: "p", summary: "leaf s", mcp: "https://leaf.example"),
            at: ladder.inst
        )
        ctx = try ladderCtx(ladder, persona: "p")
        XCTAssertEqual(ctx.texts, ["leaf s"])
        XCTAssertEqual(ctx.mcps, Set([
            GraphMcpEndpoint(url: "https://mid.example", auth: nil),
            GraphMcpEndpoint(url: "https://leaf.example", auth: nil),
        ]), "every chain member's MCP rides, summary or not — and bare's never does")
    }

    // ChainResolver: the same resolver node RUNs, #node refs and the persona channel all use

    private struct DeepLadder {
        let tmp: String
        let cic: String      // the running instance
        let innerB: String   // parent project
        let prjA: String     // grandparent project
        let global: String   // plays the user-global share
    }

    private func makeDeepLadder() throws -> DeepLadder {
        let tmp = NSTemporaryDirectory() + "openloop-resolver-\(UUID().uuidString)"
        let prjA = tmp + "/prjA"
        let innerB = prjA + "/innerB"
        let cic = innerB + "/cic"
        let global = tmp + "/global"
        for d in [prjA, innerB, cic, global] {
            try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        }
        return DeepLadder(tmp: tmp, cic: cic, innerB: innerB, prjA: prjA, global: global)
    }

    /// root(parent:summary:assigned:mcp:) — the assignment-carrying node builder.
    private func assignedNode(
        _ id: String, _ parent: String?, summary: String?,
        assigned: [String] = [], mcp: String? = nil, persona: String? = nil
    ) -> GraphNode {
        GraphNode(
            id: id, parentId: parent, prompt: "p", agent: "x", status: "success",
            output: nil, took: nil, mcp: mcp, summary: summary,
            personas: persona.map { [$0] } ?? [], assignedNodeIds: assigned,
            createdAt: 1, completedAt: nil
        )
    }

    private func seedEightNodeTrace(_ l: DeepLadder) throws {
        try GraphStore.insertNode(assignedNode("gr-1", nil, summary: "gr-1 s", mcp: "https://gr.example"), at: l.global)
        try GraphStore.insertNode(assignedNode("gr-2", "gr-1", summary: "gr-2 s"), at: l.global)
        try GraphStore.insertNode(assignedNode("prjA-1", nil, summary: "prjA-1 s", assigned: ["gr-2"]), at: l.prjA)
        try GraphStore.insertNode(assignedNode("prjA-2", "prjA-1", summary: "prjA-2 s"), at: l.prjA)
        try GraphStore.insertNode(assignedNode("innerB-1", nil, summary: "innerB-1 s", assigned: ["prjA-2"]), at: l.innerB)
        try GraphStore.insertNode(assignedNode("innerB-2", "innerB-1", summary: "innerB-2 s"), at: l.innerB)
        try GraphStore.insertNode(assignedNode("cic-1", nil, summary: "cic-1 s", assigned: ["innerB-2"]), at: l.cic)
        try GraphStore.insertNode(assignedNode("cic-2", "cic-1", summary: "cic-2 s"), at: l.cic)
    }

    private func resolveNode(_ id: String, at l: DeepLadder) throws -> GraphStore.ResolvedChain {
        let node = try XCTUnwrap(NodeStore.load(id: id, at: l.cic))
        var resolver = GraphStore.ChainResolver(globalRoot: FilePath(l.global))
        return resolver.resolve(node: node, at: l.cic)
    }

    func testResolverFollowsAssignmentsAcrossFoldersOldestFirst() throws {
        // each splice's own root's assignments expand FIRST, then its line — oldest material first
        let l = try makeDeepLadder()
        defer { try? FileManager.default.removeItem(atPath: l.tmp) }
        try seedEightNodeTrace(l)
        // resolve(node:) takes ANY member — its ancestor line IS the own line
        let resolved = try resolveNode("cic-2", at: l)
        XCTAssertEqual(resolved.nodes.map(\.id), [
            "gr-1", "gr-2", "prjA-1", "prjA-2", "innerB-1", "innerB-2", "cic-1", "cic-2",
        ])
        XCTAssertEqual(resolved.segments.map(\.instance), [l.global, l.prjA, l.innerB])
        XCTAssertEqual(resolved.own.map(\.id), ["cic-1", "cic-2"])
        XCTAssertEqual(GraphStore.chainText(resolved.nodes),
                       "gr-1 s\n\n---\n\ngr-2 s\n\n---\n\nprjA-1 s\n\n---\n\nprjA-2 s\n\n---\n\ninnerB-1 s\n\n---\n\ninnerB-2 s\n\n---\n\ncic-1 s\n\n---\n\ncic-2 s")
    }

    func testResolverMcpSetsAreOwnFirstThenSegmentsPerFolder() throws {
        let l = try makeDeepLadder()
        defer { try? FileManager.default.removeItem(atPath: l.tmp) }
        try seedEightNodeTrace(l)
        // same URL on the own chain's root and in the assigned global chain — the OWN instance's key must win
        try GraphStore.updateMcp(id: "cic-1", mcp: "https://gr.example", at: l.cic)
        try SecretStore.setSecret("own-key", for: "https://gr.example", at: l.cic)
        try SecretStore.setSecret("global-key", for: "https://gr.example", at: l.global)
        let resolved = try resolveNode("cic-2", at: l)
        let sets = resolved.mcpEndpointSets()
        XCTAssertEqual(sets.count, 1 + resolved.segments.count, "one set per folder: own line first, then each segment")
        XCTAssertEqual(
            GraphStore.nearestWinsMcpUnion(sets),
            [GraphMcpEndpoint(url: "https://gr.example", auth: "own-key")],
            "own-instance auth owns the URL — the global segment's loser must not surface"
        )
    }

    func testResolverDedupesFirstOccurrenceWins() throws {
        let l = try makeDeepLadder()
        defer { try? FileManager.default.removeItem(atPath: l.tmp) }
        try GraphStore.insertNode(assignedNode("shared", nil, summary: "shared s"), at: l.prjA)
        try GraphStore.insertNode(assignedNode("a", "shared", summary: "a s"), at: l.prjA)
        try GraphStore.insertNode(assignedNode("b", "shared", summary: "b s"), at: l.prjA)
        try GraphStore.insertNode(assignedNode("r", nil, summary: "r s", assigned: ["a", "b"]), at: l.cic)
        let resolved = try resolveNode("r", at: l)
        // both splices' lines share `shared`: the first occurrence wins
        XCTAssertEqual(resolved.nodes.map(\.id), ["shared", "a", "b", "r"])
        XCTAssertEqual(resolved.segments.count, 2, "two assignments stay two segments — dedupe is by id, not by splice")
    }

    func testResolverSkipsDanglingAndSameProjectIdsSilently() throws {
        let l = try makeDeepLadder()
        defer { try? FileManager.default.removeItem(atPath: l.tmp) }
        // a same-project node is NOT an assignment target (strictly up the ladder)
        try GraphStore.insertNode(assignedNode("sibling", nil, summary: "sibling s"), at: l.cic)
        // a dead id (deleted upstream) logs one line and is skipped
        try GraphStore.insertNode(
            assignedNode("r", nil, summary: "r s", assigned: ["sibling", "ghost-id", "r"]),
            at: l.cic
        )
        let resolved = try resolveNode("r", at: l)
        XCTAssertEqual(resolved.nodes.map(\.id), ["r"])
        XCTAssertTrue(resolved.segments.isEmpty)
    }

    func testResolverDropsInactiveTargetsAndDormantMidLineFields() throws {
        let l = try makeDeepLadder()
        defer { try? FileManager.default.removeItem(atPath: l.tmp) }
        // inactive target: drops out of its own splice, its active ancestors still ride
        try GraphStore.insertNode(assignedNode("anc", nil, summary: "anc s"), at: l.innerB)
        try GraphStore.insertNode(assignedNode("target", "anc", summary: "target s", assigned: ["gone"]), at: l.innerB)
        try GraphStore.updateActive(id: "target", active: false, at: l.innerB)
        // mid-line node carrying the field (hand-edited): dormant
        try GraphStore.insertNode(assignedNode("r", nil, summary: "r s", assigned: ["target"]), at: l.cic)
        let resolved = try resolveNode("r", at: l)
        XCTAssertEqual(resolved.nodes.map(\.id), ["anc", "r"], "the inactive target drops; `gone` (dangling under a dormant field) never fires")
    }

    func testUpdateAssignedNodeIdsSetsAndClears() throws {
        try insert(node("a", nil))
        try GraphStore.updateAssignedNodeIds(id: "a", assignedNodeIds: ["up-1", "up-1", ""], at: path)
        XCTAssertEqual(try remaining()["a"]?.assignedNodeIds, ["up-1", "up-1", ""], "the store writes what it is given — hygiene is the wire's job")
        try GraphStore.updateAssignedNodeIds(id: "a", assignedNodeIds: [], at: path)
        XCTAssertEqual(try remaining()["a"]?.assignedNodeIds, [])
    }

    func testPersonaContextPullsAssignmentsThroughTheSameResolver() throws {
        let l = try makeDeepLadder()
        defer { try? FileManager.default.removeItem(atPath: l.tmp) }
        try seedEightNodeTrace(l)
        try SecretStore.setSecret("gr-key", for: "https://gr.example", at: l.global)
        // the persona is tagged on the whole cic chain; its assignments ride
        try GraphStore.updatePersonas(id: "cic-1", personas: ["p"], at: l.cic)
        try GraphStore.updatePersonas(id: "cic-2", personas: ["p"], at: l.cic)
        let ctx = try GraphStore.personaContext(
            personaId: "p", at: l.cic, globalRoot: FilePath(l.global)
        )
        XCTAssertEqual(ctx.texts, [GraphStore.chainText(try resolveNode("cic-2", at: l).nodes)],
                       "persona chains resolve through the same resolver node RUNs use")
        XCTAssertEqual(ctx.mcps, [GraphMcpEndpoint(url: "https://gr.example", auth: "gr-key")],
                       "assignment-segment MCPs ride with auth from their own folder")
    }
}
