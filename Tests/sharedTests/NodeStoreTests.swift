import XCTest
import shared

// File-store realities for `.openloop/nodes/<UUID>.json5` — the SQL-era node
// scenarios keep running in GraphStoreTests through the facade; this suite
// pins the behaviors files added: corrupt-skip, deterministic order,
// lost-update serialization, byte-stability and atomic writes.
final class NodeStoreTests: XCTestCase {

    var path: String!

    override func setUpWithError() throws {
        path = NSTemporaryDirectory() + "openloop-nodeStore-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        try NodeStore.ensureDir(at: path)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(atPath: path)
    }

    func node(_ id: String, _ parent: String?, createdAt: Double = 1) -> GraphNode {
        GraphNode(
            id: id, parentId: parent, prompt: "p \(id)", agent: "a", status: "success",
            output: nil, took: nil, mcp: nil, createdAt: createdAt, completedAt: nil
        )
    }

    func filesInNodesDir() throws -> [String] {
        try PathIO.contentsOfDirectory(atPath: NodeStore.nodesDir(at: path).string).sorted()
    }

    func fileBody(_ id: String) throws -> String {
        try String(contentsOfFile: NodeStore.filePath(id: id, at: path).string, encoding: .utf8)
    }

    func testSaveWritesJson5WithWireSnakeCaseKeysInStabilityOrder() throws {
        try NodeStore.save(node("a", nil), at: path)
        let body = try fileBody("a")
        // identity first, output last — exact layout, deterministic bytes
        XCTAssertTrue(body.hasPrefix("{\n  \"id\" : \"a\",\n  \"parent_id\" : null,\n  \"created_at\" : 1,\n"))
        XCTAssertTrue(body.hasSuffix("  \"mcp\" : null,\n  \"mcp_requires_auth\" : false,\n  \"output\" : null\n}\n"))
        XCTAssertFalse(body.contains("parentId")) // camelCase must never leak into the file
        // the Linux pretty printer spells an empty array "[\n\n]" with an UNindented close
        XCTAssertTrue(body.contains("  \"assigned_node_ids\" : [\n\n],\n"), "the empty-array field rides, snake_case")
    }

    func testFileKeysFollowStabilityOrderExactly() throws {
        // pins the FULL key sequence — a Field reorder must fail loudly here,
        // not churn every node file's diff layout in the wild
        try NodeStore.save(node("a", nil), at: path)
        let keys = try fileBody("a")
            .split(separator: "\n")
            .compactMap { $0.split(separator: "\"").dropFirst().first.map(String.init) }
        XCTAssertEqual(
            keys,
            ["id", "parent_id", "created_at", "agent", "took", "completed_at",
             "name", "summary", "prompt", "status", "active", "personas",
             "assigned_node_ids", "mcp", "mcp_requires_auth", "output"]
        )
    }

    func testLoadRoundtripsEveryField() throws {
        let full = GraphNode(
            id: "n", parentId: "root", prompt: "q", agent: "cc", status: "answered",
            output: "a", took: 9, mcp: "https://mcp.example", mcpRequiresAuth: true,
            summary: "s", name: "alpha", personas: ["p1", "p2"],
            assignedNodeIds: ["up-1", "up-2"],
            createdAt: 719267835.42, completedAt: 719267900.0, active: false
        )
        try NodeStore.save(full, at: path)
        let back = try XCTUnwrap(NodeStore.load(id: "n", at: path))
        XCTAssertEqual(back.id, full.id)
        XCTAssertEqual(back.parentId, full.parentId)
        XCTAssertEqual(back.prompt, full.prompt)
        XCTAssertEqual(back.agent, full.agent)
        XCTAssertEqual(back.status, full.status)
        XCTAssertEqual(back.output, full.output)
        XCTAssertEqual(back.took, full.took)
        XCTAssertEqual(back.mcp, full.mcp)
        XCTAssertEqual(back.mcpRequiresAuth, full.mcpRequiresAuth)
        XCTAssertEqual(back.summary, full.summary)
        XCTAssertEqual(back.name, full.name)
        XCTAssertEqual(back.personas, full.personas)
        XCTAssertEqual(back.assignedNodeIds, full.assignedNodeIds)
        XCTAssertEqual(back.createdAt, full.createdAt, accuracy: 1e-9)
        XCTAssertEqual(back.completedAt ?? 0, full.completedAt ?? 0, accuracy: 1e-9)
        XCTAssertEqual(back.active, false)
    }

    func testListSortsByCreatedAtThenId() throws {
        try NodeStore.save(node("b", nil, createdAt: 2), at: path)
        try NodeStore.save(node("z", nil, createdAt: 1), at: path)
        try NodeStore.save(node("a", nil, createdAt: 1), at: path)
        XCTAssertEqual(NodeStore.list(at: path).map(\.id), ["a", "z", "b"])
    }

    func testListReturnsEmptyWhenDirMissingOrEmpty() throws {
        XCTAssertTrue(NodeStore.list(at: path).isEmpty)
        let missing = NSTemporaryDirectory() + "openloop-nodeStore-absent-\(UUID().uuidString)"
        XCTAssertTrue(NodeStore.list(at: missing).isEmpty)
    }

    func testMutatePreservesUntouchedFields() throws {
        // the lost-update regression: a name edit must not erase the summary
        // a detached lifecycle task wrote concurrently
        try NodeStore.save(
            GraphNode(
                id: "n", parentId: nil, prompt: "q", agent: "a", status: "summarizing",
                output: "o", took: 3, mcp: nil, summary: "precious", createdAt: 1, completedAt: nil
            ),
            at: path
        )
        try NodeStore.mutate(id: "n", at: path) { $0.name = "alpha" }
        let back = try XCTUnwrap(NodeStore.load(id: "n", at: path))
        XCTAssertEqual(back.name, "alpha")
        XCTAssertEqual(back.summary, "precious")
        XCTAssertEqual(back.status, "summarizing")
    }

    func testMutateNoOpsOnMissingFile() throws {
        try NodeStore.mutate(id: "ghost", at: path) { $0.name = "x" }
        XCTAssertTrue(NodeStore.list(at: path).isEmpty)
    }

    func testCorruptFileIsSkippedWithoutAbortingList() throws {
        try NodeStore.save(node("good", nil), at: path)
        try Data("<<<<<<< HEAD\n".utf8)
            .write(to: URL(fileURLWithPath: NodeStore.filePath(id: "torn", at: path).string))
        XCTAssertEqual(NodeStore.list(at: path).map(\.id), ["good"])
        XCTAssertNil(NodeStore.load(id: "torn", at: path))
    }

    func testInnerIdMismatchTrustsFilename() throws {
        try NodeStore.save(node("real-id", nil), at: path)
        let wrong = NodeStore.filePath(id: "file-id", at: path)
        try Data(fileBody("real-id").replacingOccurrences(of: "real-id", with: "other-id").utf8)
            .write(to: URL(fileURLWithPath: wrong.string))
        XCTAssertNil(NodeStore.load(id: "file-id", at: path))
        XCTAssertEqual(NodeStore.list(at: path).map(\.id), ["real-id"])
    }

    func testDeleteRemovesTheFile() throws {
        try NodeStore.save(node("a", nil), at: path)
        try NodeStore.delete(id: "a", at: path)
        XCTAssertEqual(try filesInNodesDir(), [])
        try NodeStore.delete(id: "a", at: path) // missing = no-op success, SQL parity
    }

    func testUnchangedSaveIsByteStableAndLeavesNoTmp() throws {
        try NodeStore.save(node("a", nil), at: path)
        let before = try fileBody("a")
        let mtime = PathIO.modificationDate(atPath: NodeStore.filePath(id: "a", at: path).string)
        try NodeStore.save(node("a", nil), at: path) // same content
        XCTAssertEqual(try fileBody("a"), before)
        XCTAssertEqual(
            PathIO.modificationDate(atPath: NodeStore.filePath(id: "a", at: path).string),
            mtime,
            "unchanged node must not be rewritten — git status stays quiet after viewing"
        )
        XCTAssertFalse(try filesInNodesDir().contains { $0.contains(".tmp") })
    }

    // — no `mcp_auth` mover ships: the pre-split plaintext era was never
    //    distributed and its values were moved by hand. A file that still
    //    carries the key is unknown-key territory — the debug tripwire in
    //    NodeStore.assertNoUnknownKeys names it, and no test grants it a
    //    silent pass. —
}
