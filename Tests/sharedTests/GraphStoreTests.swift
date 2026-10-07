import XCTest
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

    func runLog(_ id: String, node: String) -> GraphRunLog {
        GraphRunLog(id: id, nodeId: node, prompt: "p", status: "success", output: nil, took: nil, createdAt: 1, completedAt: nil)
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
}
