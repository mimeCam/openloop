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
        // summary/mcpAuth asserted alongside: SELECT order and toNode indices
        // are decoupled positional knowledge — any reshuffle must fail loudly
        // on more than the new field.
        try insert(
            node("a", nil),
            GraphNode(
                id: "n", parentId: nil, prompt: "p", agent: "a", status: "success",
                output: nil, took: nil, mcp: "https://mcp.example", mcpAuth: "Bearer t",
                summary: "s", name: "alpha", createdAt: 1, completedAt: nil
            )
        )
        let left = try remaining()
        XCTAssertEqual(left["n"]?.name, "alpha")
        XCTAssertEqual(left["n"]?.summary, "s")
        XCTAssertEqual(left["n"]?.mcpAuth, "Bearer t")
        XCTAssertNil(left["a"]?.name) // default nil — proves row index 14, not a shift
    }

    func testUpdateNameSetsAndClears() throws {
        try insert(node("a", nil))
        try GraphStore.updateName(id: "a", name: "alpha", at: path)
        XCTAssertEqual(try remaining()["a"]?.name, "alpha")
        try GraphStore.updateName(id: "a", name: nil, at: path) // nil = clear to NULL
        XCTAssertNil(try remaining()["a"]?.name)
    }

    func testLegacyDbMigratesNameColumn() throws {
        // pre-name database: the original 8-column schema. createTables runs
        // migrateNodeColumns; if the ALTER is missing, insertNode throws.
        let legacy = NSTemporaryDirectory() + "openloop-graphstore-legacy-\(UUID().uuidString)"
        try FileManager.default.createDirectory(
            atPath: (legacy as NSString).appendingPathComponent(Paths.dataFolderName),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(atPath: legacy) }
        let db = try Connection(GraphStore.dbPath(at: legacy))
        try db.execute("""
        CREATE TABLE graph_nodes (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            prompt TEXT NOT NULL,
            agent TEXT NOT NULL,
            status TEXT NOT NULL,
            output TEXT,
            created_at REAL NOT NULL,
            completed_at REAL
        );
        """)
        try GraphStore.createTables(at: legacy)
        try GraphStore.insertNode(node("a", nil), at: legacy)
        try GraphStore.updateName(id: "a", name: "old db", at: legacy)
        XCTAssertEqual(try GraphStore.fetchNodes(at: legacy).first?.name, "old db")
    }
}
