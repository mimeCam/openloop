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

    func runLog(_ id: String, node: String, status: String = "success") -> GraphRunLog {
        GraphRunLog(id: id, nodeId: node, prompt: "p", status: status, output: nil, took: nil, createdAt: 1, completedAt: nil)
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
