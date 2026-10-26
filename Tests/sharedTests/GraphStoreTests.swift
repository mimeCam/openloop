import XCTest
import SQLite
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

    func runLog(_ id: String, node: String, status: String = "success", parent: String? = nil, root: String? = nil) -> GraphRunLog {
        GraphRunLog(id: id, nodeId: node, prompt: "p", status: status, output: nil, took: nil, createdAt: 1, completedAt: nil, parentRunId: parent, rootRunId: root)
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
}
