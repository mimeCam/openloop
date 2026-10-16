import Foundation
import SQLite
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

public struct GraphNode: Sendable {
    public let id: String
    public let parentId: String?
    public let prompt: String
    public let agent: String
    public let status: String
    public let output: String?
    public let took: Int?
    public let mcp: String?
    public let mcpAuth: String?
    public let summary: String?
    public let name: String?
    public let personas: [String]
    public let createdAt: Double
    public let completedAt: Double?
    public let active: Bool

    public init(
        id: String,
        parentId: String?,
        prompt: String,
        agent: String,
        status: String,
        output: String?,
        took: Int?,
        mcp: String?,
        mcpAuth: String? = nil,
        summary: String? = nil,
        name: String? = nil,
        personas: [String] = [],
        createdAt: Double,
        completedAt: Double?,
        active: Bool = true
    ) {
        self.id = id
        self.parentId = parentId
        self.prompt = prompt
        self.agent = agent
        self.status = status
        self.output = output
        self.took = took
        self.mcp = mcp
        self.mcpAuth = mcpAuth
        self.summary = summary
        self.name = name
        self.personas = personas
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.active = active
    }
}

public struct GraphRunLog: Sendable {
    public let id: String
    public let nodeId: String
    public let prompt: String
    public let status: String
    public let output: String?
    public let took: Int?
    public let createdAt: Double
    public let completedAt: Double?
    public let parentRunId: String?
    public let summary: String?
    public let rootRunId: String?

    public init(
        id: String,
        nodeId: String,
        prompt: String,
        status: String,
        output: String?,
        took: Int?,
        createdAt: Double,
        completedAt: Double?,
        parentRunId: String? = nil,
        summary: String? = nil,
        rootRunId: String? = nil
    ) {
        self.id = id
        self.nodeId = nodeId
        self.prompt = prompt
        self.status = status
        self.output = output
        self.took = took
        self.createdAt = createdAt
        self.completedAt = completedAt
        self.parentRunId = parentRunId
        self.summary = summary
        self.rootRunId = rootRunId
    }
}

public struct GraphMcpEndpoint: Hashable, Sendable {
    public let url: String
    public let auth: String?

    public init(url: String, auth: String?) {
        self.url = url
        self.auth = auth
    }
}

struct McpConfig: Codable {
    let mcpServers: [String: McpServer]
}

struct McpServer: Codable {
    let type = "http"
    let url: String
    let headers: [String: String]?

    init(url: String, auth: String?) {
        self.url = url
        self.headers = auth.map { ["Authorization": $0] }
    }
}

public struct RunCounts: Sendable {
    public var total: Int
    public var success: Int
    public var failed: Int
    /// Run-log rows currently in "progress" — NOT the node `active` (dormant) flag.
    /// Invariant: total == success + failed + active (GROUP BY counts every status into total).
    public var active: Int

    public init(total: Int = 0, success: Int = 0, failed: Int = 0, active: Int = 0) {
        self.total = total
        self.success = success
        self.failed = failed
        self.active = active
    }
}

public struct GraphStore {

    public static func dbPath(at instancePath: String) -> String {
        FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("logs.db")
            .string
    }

    static func connect(at instancePath: String) throws -> Connection {
        _ = PathIO.createDirectoryIfNotExists(
            atPath: FilePath(instancePath).appending(Paths.dataFolderName).string
        )
        let db = try Connection(dbPath(at: instancePath))
        db.busyTimeout = 3
        try db.execute("PRAGMA journal_mode=WAL;")
        try db.execute("PRAGMA synchronous=NORMAL;")
        return db
    }

    static let nodeTableDdl = """
    CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        prompt TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        created_at REAL NOT NULL,
        completed_at REAL,
        active INTEGER NOT NULL DEFAULT 1
    );
    """

    static let runLogTableDdl = """
    CREATE TABLE IF NOT EXISTS graph_run_logs (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        took INTEGER,
        created_at REAL NOT NULL,
        completed_at REAL,
        root_run_id TEXT
    );
    """

    public static func createTables(at instancePath: String) throws {
        try createNodeTables(at: instancePath)
        try createRunLogTables(at: instancePath)
    }

    static func createNodeTables(at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.execute(nodeTableDdl)
        try db.run("CREATE INDEX IF NOT EXISTS idx_graph_nodes_parent ON graph_nodes(parent_id);")
        migrateNodeColumns(db)
    }

    static func migrateNodeColumns(_ db: Connection) {
        try? db.run("ALTER TABLE graph_nodes ADD COLUMN took INTEGER;")
        try? db.run("ALTER TABLE graph_nodes ADD COLUMN mcp TEXT;")
        try? db.run("ALTER TABLE graph_nodes ADD COLUMN mcp_auth TEXT;")
        try? db.run("ALTER TABLE graph_nodes ADD COLUMN summary TEXT;")
        try? db.run("ALTER TABLE graph_nodes ADD COLUMN personas TEXT;")
        try? db.run("ALTER TABLE graph_nodes ADD COLUMN name TEXT;")
        try? db.run("ALTER TABLE graph_nodes ADD COLUMN active INTEGER NOT NULL DEFAULT 1;")
        try? db.run("UPDATE graph_nodes SET status='answered' WHERE status='success' AND summary IS NULL;")
    }

    static func createRunLogTables(at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.execute(runLogTableDdl)
        try db.run("CREATE INDEX IF NOT EXISTS idx_graph_run_logs_node ON graph_run_logs(node_id);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_graph_run_logs_completed_at ON graph_run_logs(completed_at);")
        migrateRunLogColumns(db)
        try db.run("CREATE INDEX IF NOT EXISTS idx_graph_run_logs_root ON graph_run_logs(root_run_id);")
    }

    static func migrateRunLogColumns(_ db: Connection) {
        try? db.run("ALTER TABLE graph_run_logs ADD COLUMN parent_run_id TEXT;")
        try? db.run("ALTER TABLE graph_run_logs ADD COLUMN summary TEXT;")
        try? db.run("ALTER TABLE graph_run_logs ADD COLUMN root_run_id TEXT;")
        backfillRootRunIds(db)
    }

    static func backfillRootRunIds(_ db: Connection) {
        let rows = unrootedRunRows(db)
        guard !rows.isEmpty else { return }
        let pairs: [(String, String)] = rows.compactMap { row in
            guard let id = row[0] as? String, let parent = row[1] as? String else { return nil }
            return (id, parent)
        }
        let parentOf = Dictionary(uniqueKeysWithValues: pairs)
        for id in rows.compactMap({ $0[0] as? String }) {
            guard let root = convoRoot(of: id, parentOf: parentOf) else { continue }
            try? db.run("UPDATE graph_run_logs SET root_run_id = ? WHERE id = ?;", root, id)
        }
    }

    static func unrootedRunRows(_ db: Connection) -> [[Binding?]] {
        guard let statement = try? db.prepare("SELECT id, parent_run_id FROM graph_run_logs WHERE root_run_id IS NULL;") else { return [] }
        var rows: [[Binding?]] = []
        for row in statement { rows.append(row) }
        return rows
    }

    static func convoRoot(of id: String, parentOf: [String: String]) -> String? {
        var seen: Set<String> = []
        var cur = id
        while let parent = parentOf[cur] {
            if !seen.insert(cur).inserted { return nil }
            cur = parent
        }
        return cur
    }

    public static func insertNode(_ node: GraphNode, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "INSERT INTO graph_nodes (id, parent_id, prompt, agent, status, output, took, mcp, mcp_auth, summary, personas, created_at, active, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
            node.id,
            node.parentId,
            node.prompt,
            node.agent,
            node.status,
            node.output,
            node.took,
            node.mcp,
            node.mcpAuth,
            node.summary,
            encodePersonas(node.personas),
            node.createdAt,
            node.active,
            node.name
        )
    }

    public static func fetchNodes(at instancePath: String) throws -> [GraphNode] {
        let db = try connect(at: instancePath)
        let rows = try db.prepare(
            "SELECT id, parent_id, prompt, agent, status, output, took, mcp, created_at, completed_at, summary, personas, mcp_auth, active, name FROM graph_nodes ORDER BY created_at;"
        )
        return rows.compactMap(toNode)
    }

    public static func updateNode(
        id: String,
        status: String,
        output: String?,
        took: Int?,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET status = ?, output = ?, took = ?, completed_at = ? WHERE id = ?;",
            status,
            output,
            took,
            Date().timeIntervalSinceReferenceDate,
            id
        )
    }

    public static func updatePrompt(
        id: String,
        prompt: String,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET prompt = ? WHERE id = ?;",
            prompt,
            id
        )
    }

    public static func updateSummary(
        id: String,
        summary: String,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET summary = ? WHERE id = ?;",
            summary,
            id
        )
    }

    public static func updateName(
        id: String,
        name: String?,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET name = ? WHERE id = ?;",
            name,
            id
        )
    }

    public static func updateMcpAuth(
        id: String,
        auth: String?,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET mcp_auth = ? WHERE id = ?;",
            auth,
            id
        )
    }

    public static func updateMcp(
        id: String,
        mcp: String?,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET mcp = ? WHERE id = ?;",
            mcp,
            id
        )
    }

    public static func updatePersonas(
        id: String,
        personas: [String],
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET personas = ? WHERE id = ?;",
            encodePersonas(personas),
            id
        )
    }

    public static func updateStatus(
        id: String,
        status: String,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET status = ? WHERE id = ?;",
            status,
            id
        )
    }

    public static func finishSummary(
        id: String,
        summary: String?,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET summary = ?, status = ? WHERE id = ?;",
            summary,
            summary == nil ? "answered" : "success",
            id
        )
    }

    public static func updateParent(
        id: String,
        parent: String?,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_nodes SET parent_id = ? WHERE id = ?;",
            parent,
            id
        )
    }

    public static func chain(of node: GraphNode, in nodes: [GraphNode]) -> [GraphNode] {
        var lineage: [GraphNode] = []
        var current: GraphNode? = node
        while let c = current {
            if c.active { lineage.append(c) }
            current = nodes.first { $0.id == c.parentId }
        }
        return lineage.reversed()
    }

    public static func updateActive(id: String, active: Bool, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.run("UPDATE graph_nodes SET active = ? WHERE id = ?;", active, id)
    }

    public static func subtreeIds(of node: GraphNode, in nodes: [GraphNode]) -> Set<String> {
        var children: [String: [String]] = [:]
        for n in nodes { children[n.parentId ?? "", default: []].append(n.id) }
        var seen: Set<String> = [node.id]
        var queue = [node.id]
        while let id = queue.popLast() {
            for child in children[id] ?? [] where !seen.contains(child) {
                seen.insert(child)
                queue.append(child)
            }
        }
        return seen
    }

    public static func deleteNode(id: String, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.transaction {
            // updateParent SQL inlined on purpose — the public method opens a
            // 2nd connection, which would break this transaction's atomicity.
            try db.run(
                "UPDATE graph_nodes SET parent_id = (SELECT parent_id FROM graph_nodes WHERE id = ?) WHERE parent_id = ?;",
                id, id
            )
            try db.run("DELETE FROM graph_run_logs WHERE node_id = ?;", id)
            try db.run("DELETE FROM graph_nodes WHERE id = ?;", id)
        }
    }

    public static func deleteNodes(ids: Set<String>, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.transaction {
            for id in ids {
                try db.run("DELETE FROM graph_run_logs WHERE node_id = ?;", id)
                try db.run("DELETE FROM graph_nodes WHERE id = ?;", id)
            }
        }
    }

    public struct PersonaContext {
        public let texts: [String]
        public let mcps: Set<GraphMcpEndpoint>

        public static let empty = PersonaContext(texts: [], mcps: [])
    }

    public static func personaContext(personaId: String, at instancePath: String) throws -> PersonaContext {
        let nodes = try fetchNodes(at: instancePath)
        let chains = longestAssignedChains(personaId: personaId, nodes: nodes)
        return PersonaContext(
            texts: chains.map(chainText),
            mcps: chains.reduce(into: []) { $0.formUnion(chainMcpEndpoints($1)) }
        )
    }

    public static func chainText(_ chain: [GraphNode]) -> String {
        chain.compactMap(\.summary).joined(separator: "\n\n---\n\n")
    }

    public static func chainMcpEndpoints(_ chain: [GraphNode]) -> Set<GraphMcpEndpoint> {
        Set(chain.compactMap { node in
            guard let url = node.mcp, url.notEmpty else { return nil }
            let auth = (node.mcpAuth?.notEmpty == true) ? node.mcpAuth : nil
            return GraphMcpEndpoint(url: url, auth: auth)
        })
    }

    public static let containerCtxDir = "/context"

    public static func contextRunDir(_ runId: String) -> FilePath {
        Paths.tmpRoot.appending("graph-runs").appending(runId)
    }

    public static func deleteContextRunDir(_ id: String) {
        _ = PathIO.deleteDirectoryAndItsContents(atPath: contextRunDir(id).string)
    }

    public static func sweepStaleRunArtifacts(maxAge: TimeInterval = 24 * 3600) {
        let tmp = Paths.tmpRoot
        sweepStaleEntries(in: tmp.appending("graph-runs").string, maxAge: maxAge)
        sweepStaleEntries(in: tmp.appending("graph-mcp").string, maxAge: maxAge)
    }

    static func sweepStaleEntries(in dir: String, maxAge: TimeInterval) {
        let cutoff = Date().addingTimeInterval(-maxAge)
        for entry in (try? PathIO.contentsOfDirectory(atPath: dir)) ?? [] {
            let path = (dir as NSString).appendingPathComponent(entry)
            if let mtime = PathIO.modificationDate(atPath: path), mtime < cutoff {
                _ = PathIO.deleteDirectoryAndItsContents(atPath: path)
            }
        }
    }

    public static func mcpConfigPath(_ runId: String) -> FilePath {
        Paths.tmpRoot.appending("graph-mcp").appending(runId + ".json")
    }

    public static func writeMcpConfig(_ endpoints: Set<GraphMcpEndpoint>, runId: String) -> String? {
        guard !endpoints.isEmpty, let json = encodeMcpConfig(endpoints) else { return nil }
        let file = mcpConfigPath(runId)
        _ = PathIO.createDirectoryIfNotExists(atPath: file.removingLastComponent().string)
        do {
            try json.write(toFile: file.string, atomically: true, encoding: .utf8)
            return file.string
        } catch {
            assertionFailure("\(error)")
            return nil
        }
    }

    public static func encodeMcpConfig(_ endpoints: Set<GraphMcpEndpoint>) -> String? {
        var used = Set<String>()
        var servers = [String: McpServer]()
        for endpoint in endpoints {
            let name = uniqueServerName(for: endpoint.url, used: used)
            used.insert(name)
            servers[name] = McpServer(url: endpoint.url, auth: endpoint.auth)
        }
        let data = try? JSONEncoder().encode(McpConfig(mcpServers: servers))
        return data.flatMap { String(data: $0, encoding: .utf8) }
    }

    static func uniqueServerName(for url: String, used: Set<String>) -> String {
        let host = URL(string: url)?.host ?? url
        let base = String(host.split(separator: ".").first ?? Substring(host))
        guard used.contains(base) else { return base }
        var i = 2
        while used.contains("\(base)-\(i)") { i += 1 }
        return "\(base)-\(i)"
    }

    public static func writeContextFile(_ text: String, in dir: FilePath, fileName: String? = nil) throws -> FilePath {
        let file = dir.appending(fileName ?? UUID().uuidString + ".md")
        try text.write(toFile: file.string, atomically: true, encoding: .utf8)
        return file
    }

    static func longestAssignedChains(personaId: String, nodes: [GraphNode]) -> [[GraphNode]] {
        let matched = assignedWithSummary(personaId: personaId, nodes: nodes)
        return matched
            .filter { node in !matched.contains { isAncestor(node, of: $0, nodes: nodes) } }
            .map { chain(of: $0, in: nodes) }
    }

    static func assignedWithSummary(personaId: String, nodes: [GraphNode]) -> [GraphNode] {
        nodes.filter { $0.active && $0.personas.contains(personaId) && $0.summary?.notEmpty == true }
    }

    static func isAncestor(_ node: GraphNode, of other: GraphNode, nodes: [GraphNode]) -> Bool {
        guard other.id != node.id else { return false }
        return chain(of: other, in: nodes).contains { $0.id == node.id }
    }

    static func toNode(_ row: [Binding?]) -> GraphNode? {
        guard let id = row[0] as? String,
              let prompt = row[2] as? String,
              let agent = row[3] as? String,
              let status = row[4] as? String,
              let createdAt = row[8] as? Double else {
            return nil
        }
        return GraphNode(
            id: id,
            parentId: row[1] as? String,
            prompt: prompt,
            agent: agent,
            status: status,
            output: row[5] as? String,
            took: (row[6] as? Int64).map(Int.init),
            mcp: row[7] as? String,
            mcpAuth: row[12] as? String,
            summary: row[10] as? String,
            name: row[14] as? String,
            personas: decodePersonas(row[11] as? String),
            createdAt: createdAt,
            completedAt: row[9] as? Double,
            active: (row[13] as? Int64).map { $0 != 0 } ?? true
        )
    }

    static func encodePersonas(_ personas: [String]) -> String {
        guard let data = try? JSONEncoder().encode(personas),
              let json = String(data: data, encoding: .utf8) else { return "[]" }
        return json
    }

    static func decodePersonas(_ json: String?) -> [String] {
        guard let json,
              let data = json.data(using: .utf8),
              let list = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return list
    }

    static let runLogColumns = "id, node_id, prompt, status, output, took, created_at, completed_at, parent_run_id, summary, root_run_id"

    public static func insertRunLog(_ log: GraphRunLog, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "INSERT INTO graph_run_logs (id, node_id, prompt, status, output, took, created_at, parent_run_id, root_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
            log.id, log.nodeId, log.prompt, log.status, log.output, log.took, log.createdAt, log.parentRunId, log.rootRunId
        )
    }

    public static func finishRunSummary(id: String, summary: String?, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_run_logs SET summary = ?, status = ? WHERE id = ?;",
            summary,
            summary == nil ? "answered" : "success",
            id
        )
    }

    public static func runChain(of log: GraphRunLog, in logs: [GraphRunLog]) -> [GraphRunLog] {
        let byId = Dictionary(logs.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var lineage: [GraphRunLog] = []
        var seen = Set<String>()
        var current: GraphRunLog? = log
        while let c = current, !seen.contains(c.id) {
            seen.insert(c.id)
            lineage.append(c)
            current = c.parentRunId.flatMap { byId[$0] }
        }
        return lineage.reversed()
    }

    public static func runSummaries(_ chain: [GraphRunLog]) -> String {
        chain.compactMap(\.summary).joined(separator: "\n\n---\n\n")
    }

    public static func updateRunLog(
        id: String,
        status: String,
        output: String?,
        took: Int?,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_run_logs SET status = ?, output = ?, took = ?, completed_at = ? WHERE id = ?;",
            status, output, took, Date().timeIntervalSinceReferenceDate, id
        )
    }

    public static func restartRunLog(id: String, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "UPDATE graph_run_logs SET status = 'progress', output = NULL, took = NULL, completed_at = NULL WHERE id = ?;",
            id
        )
    }

    public static func fetchRunLogs(nodeId: String, at instancePath: String) throws -> [GraphRunLog] {
        let db = try connect(at: instancePath)
        let rows = try db.prepare(
            "SELECT \(runLogColumns) FROM graph_run_logs WHERE node_id = ? ORDER BY created_at DESC;", nodeId
        )
        return rows.compactMap(toRunLog)
    }

    public static func fetchProgressRunLogs(at instancePath: String) throws -> [GraphRunLog] {
        let db = try connect(at: instancePath)
        let rows = try db.prepare(
            "SELECT \(runLogColumns) FROM graph_run_logs WHERE status IN ('progress', 'summarizing');"
        )
        return rows.compactMap(toRunLog)
    }

    /// Terminal one-off node runs (Run button) ended after `since` — the
    /// node-run source for notifications. `since` is exclusive;
    /// `completed_at` is a reference-date Double, like the rest of this table.
    public static func fetchTerminalRunLogs(since: Double, at instancePath: String) throws -> [GraphRunLog] {
        let db = try connect(at: instancePath)
        let rows = try db.prepare(
            """
            SELECT \(runLogColumns) FROM graph_run_logs
            WHERE completed_at IS NOT NULL AND completed_at > ?
              AND status IN ('success', 'failed')
            ORDER BY completed_at ASC;
            """,
            since
        )
        return rows.compactMap(toRunLog)
    }

    public static func fetchRunCounts(at instancePath: String) throws -> [String: RunCounts] {
        let db = try connect(at: instancePath)
        let rows = try db.prepare(
            "SELECT node_id, status, COUNT(*) FROM graph_run_logs WHERE parent_run_id IS NULL GROUP BY node_id, status;"
        )
        return rows.reduce(into: [:]) { counts, row in
            guard let parts = countParts(row) else { return }
            counts[parts.id, default: RunCounts()].total += parts.n
            if parts.status == "success" { counts[parts.id]!.success += parts.n }
            if parts.status == "failed" { counts[parts.id]!.failed += parts.n }
            if parts.status == "progress" || parts.status == "summarizing" { counts[parts.id]!.active += parts.n }
        }
    }

    static func countParts(_ row: [Binding?]) -> (id: String, status: String, n: Int)? {
        guard let id = row[0] as? String,
              let status = row[1] as? String,
              let n = row[2] as? Int64 else { return nil }
        return (id, status, Int(n))
    }

    static func toRunLog(_ row: [Binding?]) -> GraphRunLog? {
        guard let id = row[0] as? String,
              let nodeId = row[1] as? String,
              let prompt = row[2] as? String,
              let status = row[3] as? String,
              let createdAt = row[6] as? Double else { return nil }
        return GraphRunLog(
            id: id, nodeId: nodeId, prompt: prompt, status: status,
            output: row[4] as? String, took: (row[5] as? Int64).map(Int.init),
            createdAt: createdAt, completedAt: row[7] as? Double,
            parentRunId: row[8] as? String, summary: row[9] as? String, rootRunId: row[10] as? String
        )
    }
}
