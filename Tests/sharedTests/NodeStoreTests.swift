import XCTest
import SQLite
import shared

// File-store realities for `.openloop/nodes/<UUID>.json5` — the SQL-era node
// scenarios keep running in GraphStoreTests through the facade; this suite
// pins the behaviors files added: corrupt-skip, deterministic order,
// lost-update serialization, byte-stability, atomic writes and the one-shot
// sqlite → files migration (incl. idempotency and the `graph_nodes_bak`
// rollback path).
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
             "mcp", "mcp_requires_auth", "output"]
        )
    }

    func testLoadRoundtripsEveryField() throws {
        let full = GraphNode(
            id: "n", parentId: "root", prompt: "q", agent: "cc", status: "answered",
            output: "a", took: 9, mcp: "https://mcp.example", mcpRequiresAuth: true,
            summary: "s", name: "alpha", personas: ["p1", "p2"],
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

    // — migration: legacy `graph_nodes` table → files —

    func legacyNodeDb() throws -> (path: String, db: Connection) {
        let dir = NSTemporaryDirectory() + "openloop-nodeStore-legacy-\(UUID().uuidString)"
        try FileManager.default.createDirectory(
            atPath: (dir as NSString).appendingPathComponent(Paths.dataFolderName),
            withIntermediateDirectories: true
        )
        let db = try Connection(GraphStore.dbPath(at: dir))
        try db.execute("""
        CREATE TABLE graph_nodes (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            prompt TEXT NOT NULL,
            agent TEXT NOT NULL,
            status TEXT NOT NULL,
            output TEXT,
            took INTEGER,
            mcp TEXT,
            mcp_auth TEXT,
            summary TEXT,
            personas TEXT,
            created_at REAL NOT NULL,
            completed_at REAL,
            active INTEGER NOT NULL DEFAULT 1,
            name TEXT
        );
        """)
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
            summary TEXT,
            root_run_id TEXT
        );
        """)
        return (dir, db)
    }

    func insertLegacyNode(
        _ db: Connection, id: String, parent: String?, status: String = "success",
        summary: String? = nil, personas: String? = nil, active: Int = 1
    ) throws {
        try db.run(
            """
            INSERT INTO graph_nodes (id, parent_id, prompt, agent, status, output, took,
                                     mcp, mcp_auth, summary, personas, created_at,
                                     completed_at, active, name)
            VALUES (?, ?, 'p', 'cc', ?, NULL, NULL, NULL, NULL, ?, ?, 1, NULL, ?, NULL);
            """,
            id, parent, status, summary, personas, active
        )
    }

    func testMigrationDumpsRowsToFilesAndRenamesTable() throws {
        let (dir, db) = try legacyNodeDb()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        try insertLegacyNode(db, id: "a", parent: nil, summary: "sa", personas: "[\"p1\"]")
        try insertLegacyNode(db, id: "b", parent: "a", status: "failed", active: 0)

        try GraphStore.createTables(at: dir)

        let nodes = NodeStore.list(at: dir).reduce(into: [:]) { $0[$1.id] = $1 }
        XCTAssertEqual(Set(nodes.keys), ["a", "b"])
        XCTAssertEqual(nodes["a"]?.summary, "sa")
        XCTAssertEqual(nodes["a"]?.personas, ["p1"])
        XCTAssertEqual(nodes["a"]?.parentId, nil)
        XCTAssertEqual(nodes["b"]?.status, "failed")
        XCTAssertEqual(nodes["b"]?.active, false)
        XCTAssertEqual(nodes["b"]?.parentId, "a")

        let after = try Connection(GraphStore.dbPath(at: dir))
        XCTAssertEqual(try after.scalar("SELECT COUNT(*) FROM graph_nodes_bak;") as? Int64, 2)
        XCTAssertEqual(
            try after.scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'graph_nodes';") as? Int64,
            0
        )
    }

    func testMigrationIsIdempotent() throws {
        let (dir, db) = try legacyNodeDb()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        try insertLegacyNode(db, id: "a", parent: nil)
        try GraphStore.createTables(at: dir)
        try GraphStore.createTables(at: dir) // second run must be a no-op

        XCTAssertEqual(NodeStore.list(at: dir).map(\.id), ["a"])
        let after = try Connection(GraphStore.dbPath(at: dir))
        XCTAssertEqual(try after.scalar("SELECT COUNT(*) FROM graph_nodes_bak;") as? Int64, 1)
    }

    func testMigrationAppliesLegacyStatusFixup() throws {
        // pre-backfill DB: success with no summary becomes "answered" in files
        let (dir, db) = try legacyNodeDb()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        try insertLegacyNode(db, id: "a", parent: nil, status: "success", summary: nil)
        try GraphStore.createTables(at: dir)
        XCTAssertEqual(NodeStore.list(at: dir).first?.status, "answered")
    }

    func testMigrationKeepsRunLogsIntact() throws {
        let (dir, db) = try legacyNodeDb()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        try insertLegacyNode(db, id: "a", parent: nil)
        try db.run(
            "INSERT INTO graph_run_logs (id, node_id, prompt, status, created_at) VALUES ('r1', 'a', 'p', 'success', 1);"
        )
        try GraphStore.createTables(at: dir)
        XCTAssertEqual(try GraphStore.fetchRunLogs(nodeId: "a", at: dir).map(\.id), ["r1"])
    }

    // The legacy `mcp_auth` column is never read: that era never shipped, so
    // a stale column (hand-added by the old ALTER ladder) contributes nothing
    // — marker false, no secret, value never written anywhere.
    func testMigrationIgnoresStaleMcpAuthColumn() throws {
        let (dir, db) = try legacyNodeDb()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        try db.run("""
        INSERT INTO graph_nodes (id, parent_id, prompt, agent, status, output, took,
                                 mcp, mcp_auth, summary, personas, created_at,
                                 completed_at, active, name)
        VALUES ('a', NULL, 'p', 'cc', 'success', NULL, NULL,
                'https://mcp.example', 'Bearer sqlite', NULL, NULL, 1, NULL, 1, NULL);
        """)
        try GraphStore.createTables(at: dir)
        XCTAssertNil(SecretStore.secret(for: "https://mcp.example", at: dir))
        let node = try XCTUnwrap(NodeStore.load(id: "a", at: dir))
        XCTAssertFalse(node.mcpRequiresAuth)
        let body = try String(contentsOfFile: NodeStore.filePath(id: "a", at: dir).string, encoding: .utf8)
        XCTAssertFalse(body.contains("sqlite"))
    }

    func testBakRollbackRestoresIdenticalNodeSet() throws {
        let (dir, db) = try legacyNodeDb()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        try insertLegacyNode(db, id: "a", parent: nil, summary: "sa", personas: "[\"p1\"]")
        try insertLegacyNode(db, id: "b", parent: "a", status: "failed", active: 0)
        try GraphStore.createTables(at: dir)
        let migrated = NodeStore.list(at: dir)

        // "rollback": drop the files, rename bak back, re-migrate
        _ = PathIO.deleteDirectoryAndItsContents(atPath: NodeStore.nodesDir(at: dir).string)
        let after = try Connection(GraphStore.dbPath(at: dir))
        try after.run("ALTER TABLE graph_nodes_bak RENAME TO graph_nodes;")
        try GraphStore.createTables(at: dir)

        XCTAssertEqual(NodeStore.list(at: dir).map(\.id), migrated.map(\.id))
        XCTAssertEqual(NodeStore.list(at: dir).map(\.summary), migrated.map(\.summary))
        XCTAssertEqual(NodeStore.list(at: dir).map(\.personas), migrated.map(\.personas))
        XCTAssertEqual(NodeStore.list(at: dir).map(\.active), migrated.map(\.active))
    }
}
