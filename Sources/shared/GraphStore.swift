import Foundation
import SQLite
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

private let storeLog = PrintLog(module: "graph-store")

private let sqliteBusyTimeout: Double = 3

public struct GraphNode: Sendable {
    public let id: String
    public let parentId: String?
    public let prompt: String
    public let agent: String
    public let status: String
    public let output: String?
    public let took: Int?
    public let mcp: String?
    /// Marker only: this node's MCP endpoint requires an auth key. The key
    /// itself lives in `.openloop/secrets.json5` (SecretStore), keyed by
    /// `mcp` — per machine, never in the committed node file.
    public let mcpRequiresAuth: Bool
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
        mcpRequiresAuth: Bool = false,
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
        self.mcpRequiresAuth = mcpRequiresAuth
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

private struct McpConfig: Codable {
    let mcpServers: [String: McpServer]
}

private struct McpServer: Codable {
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

    private struct ConnectStageError: Error, CustomStringConvertible {
        let stage: String
        let underlying: Error
        var description: String { "\(stage): \(GraphStore.describeSqliteError(underlying))" }
    }

    private static func connect(at instancePath: String) throws -> Connection {
        _ = PathIO.createDirectoryIfNotExists(
            atPath: FilePath(instancePath).appending(Paths.dataFolderName).string
        )
        let path = dbPath(at: instancePath)
        let db: Connection
        do {
            db = try Connection(path)
        } catch {
            throw ConnectStageError(stage: "open \(path)", underlying: error)
        }
        db.busyTimeout = sqliteBusyTimeout
        do {
            try db.execute("PRAGMA journal_mode=WAL;")
        } catch {
            throw ConnectStageError(stage: "PRAGMA journal_mode=WAL on \(path)", underlying: error)
        }
        do {
            try db.execute("PRAGMA synchronous=NORMAL;")
        } catch {
            throw ConnectStageError(stage: "PRAGMA synchronous=NORMAL on \(path)", underlying: error)
        }
        return db
    }

    private static func describeSqliteError(_ error: Error) -> String {
        if case let SQLite.Result.error(message, code, _) = error {
            return "\(message) [code \(code) \(sqliteCodeName(code))]"
        }
        if case let SQLite.Result.extendedError(message, extendedCode, _) = error {
            return "\(message) [extended code \(extendedCode) \(sqliteCodeName(extendedCode))]"
        }
        return String(describing: error)
    }

    private static let sqliteResultCodeNames: [Int32: String] = [
        0: "SQLITE_OK", 1: "SQLITE_ERROR", 2: "SQLITE_INTERNAL", 3: "SQLITE_PERM",
        4: "SQLITE_ABORT", 5: "SQLITE_BUSY", 6: "SQLITE_LOCKED", 7: "SQLITE_NOMEM",
        8: "SQLITE_READONLY", 9: "SQLITE_INTERRUPT", 10: "SQLITE_IOERR", 11: "SQLITE_CORRUPT",
        12: "SQLITE_NOTFOUND", 13: "SQLITE_FULL", 14: "SQLITE_CANTOPEN", 15: "SQLITE_PROTOCOL",
        17: "SQLITE_SCHEMA", 18: "SQLITE_TOOBIG", 19: "SQLITE_CONSTRAINT", 20: "SQLITE_MISMATCH",
        21: "SQLITE_MISUSE", 23: "SQLITE_AUTH", 25: "SQLITE_RANGE", 26: "SQLITE_NOTADB",
    ]

    private static func sqliteCodeName(_ code: Int32) -> String {
        sqliteResultCodeNames[code] ?? "SQLITE_CODE_\(code)"
    }

    private static let runLogTableDdl = """
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
        try NodeStore.ensureDir(at: instancePath)
        try createRunLogTables(at: instancePath)
    }

    private static func sqliteMasterHas(_ table: String, _ db: Connection) throws -> Bool {
        let n = try db.scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?;", table
        ) as? Int64
        return (n ?? 0) > 0
    }

    private static func createRunLogTables(at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.execute(runLogTableDdl)
        try db.run("CREATE INDEX IF NOT EXISTS idx_graph_run_logs_node ON graph_run_logs(node_id);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_graph_run_logs_completed_at ON graph_run_logs(completed_at);")
        migrateRunLogColumns(db)
        try db.run("CREATE INDEX IF NOT EXISTS idx_graph_run_logs_root ON graph_run_logs(root_run_id);")
        // Same logs.db file as LogManager's tables: session follow-up inserts
        // write the run row and its notification-kind marker in ONE
        // transaction, so the marker table must exist whenever the run-log
        // tables do (LogManager.createTables creates it too — idempotent).
        try db.execute(LogManager.notificationKindsDdl)
    }

    private static func migrateRunLogColumns(_ db: Connection) {
        try? db.run("ALTER TABLE graph_run_logs ADD COLUMN parent_run_id TEXT;")
        try? db.run("ALTER TABLE graph_run_logs ADD COLUMN summary TEXT;")
        try? db.run("ALTER TABLE graph_run_logs ADD COLUMN root_run_id TEXT;")
        backfillRootRunIds(db)
    }

    private static func backfillRootRunIds(_ db: Connection) {
        repairRootRunIds(db)
    }

    // One invariant, two callers (the boot backfill above, and deleteRunLog's
    // splice below): a row whose root is NULL or dangles at a run that no
    // longer exists re-derives it from the parent chain — boot self-heals
    // legacy corruption, delete heals its own splice. Dangling extends the
    // original NULL-only contract without changing any boot outcome.
    private static func repairRootRunIds(_ db: Connection) {
        let ids = repairableRunIds(db)
        guard !ids.isEmpty else { return }
        let parentOf = runParentMap(db)
        for id in ids {
            guard let root = convoRoot(of: id, parentOf: parentOf) else { continue }
            try? db.run("UPDATE graph_run_logs SET root_run_id = ? WHERE id = ?;", root, id)
        }
    }

    private static func repairableRunIds(_ db: Connection) -> [String] {
        let sql = """
        SELECT id FROM graph_run_logs
        WHERE root_run_id IS NULL OR root_run_id NOT IN (SELECT id FROM graph_run_logs);
        """
        guard let statement = try? db.prepare(sql) else { return [] }
        return statement.compactMap { $0[0] as? String }
    }

    // Parent edges among LIVING rows only: a parent_run_id pointing at a
    // deleted run (raw corruption, pre-feature manual deletes) reads as no
    // parent, so convoRoot terminates at the orphan itself, never at a ghost.
    private static func runParentMap(_ db: Connection) -> [String: String] {
        let sql = "SELECT c.id, c.parent_run_id FROM graph_run_logs c JOIN graph_run_logs p ON p.id = c.parent_run_id;"
        guard let statement = try? db.prepare(sql) else { return [:] }
        let pairs = statement.compactMap { row -> (String, String)? in
            guard let id = row[0] as? String, let parent = row[1] as? String else { return nil }
            return (id, parent)
        }
        return Dictionary(uniqueKeysWithValues: pairs)
    }

    private static func convoRoot(of id: String, parentOf: [String: String]) -> String? {
        var seen: Set<String> = []
        var cur = id
        while let parent = parentOf[cur] {
            if !seen.insert(cur).inserted { return nil }
            cur = parent
        }
        return cur
    }

    // MARK: - Node CRUD (facade → NodeStore files)
    // Signatures frozen: api handlers, runner and tests keep compiling as-is.
    // Node metadata lives in `.openloop/nodes/<UUID>.json5` (see NodeStore).

    public static func insertNode(_ node: GraphNode, at instancePath: String) throws {
        try NodeStore.save(node, at: instancePath)
    }

    public static func fetchNodes(at instancePath: String) throws -> [GraphNode] {
        NodeStore.list(at: instancePath)
    }

    public static func updateNode(
        id: String,
        status: String,
        output: String?,
        took: Int?,
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { file in
            file.status = status
            file.output = output
            file.took = took
            file.completedAt = Date().timeIntervalSinceReferenceDate
        }
    }

    public static func updatePrompt(
        id: String,
        prompt: String,
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { $0.prompt = prompt }
    }

    public static func updateAgent(
        id: String,
        agent: String,
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { $0.agent = agent }
    }

    public static func updateSummary(
        id: String,
        summary: String,
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { $0.summary = summary }
    }

    public static func updateName(
        id: String,
        name: String?,
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { $0.name = name }
    }

    /// Auth keys live per machine in SecretStore keyed by the node's MCP
    /// URL (dedup: one key serves every node on that URL). The node file
    /// keeps only the `mcp_requires_auth` marker. Clearing (`auth` nil/empty)
    /// removes the URL's key and the marker.
    public static func updateMcpAuth(
        id: String,
        auth: String?,
        at instancePath: String
    ) throws {
        guard let node = NodeStore.load(id: id, at: instancePath) else {
            assertionFailure("updateMcpAuth on missing node \(id) — caller must validate existence")
            return
        }
        if let url = node.mcp, url.notEmpty {
            try SecretStore.setSecret(auth, for: url, at: instancePath)
        }
        try NodeStore.mutate(id: id, at: instancePath) { $0.mcpRequiresAuth = (auth?.notEmpty == true) }
    }

    /// How many nodes wait on an MCP key this computer doesn't hold: marker
    /// on (the repo says "this MCP requires a key") and no local secret for
    /// the node's URL — the same pair `mcp_requires_auth`/`mcp_auth_local` the
    /// graph wire exposes per node. Read-only and dir-missing tolerant
    /// (NodeStore.list → []): powers the graph header warning and the
    /// instances-list cell badge without creating anything.
    public static func mcpAuthMissingCount(at instancePath: String) -> Int {
        let secrets = SecretStore.load(at: instancePath)
        func hasLocalKey(_ url: String?) -> Bool {
            url.flatMap { secrets[$0] }?.notEmpty == true
        }
        return NodeStore.list(at: instancePath)
            .filter { $0.mcpRequiresAuth && !hasLocalKey($0.mcp) }
            .count
    }

    public static func updateMcp(
        id: String,
        mcp: String?,
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { $0.mcp = mcp }
    }

    public static func updatePersonas(
        id: String,
        personas: [String],
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { $0.personas = personas }
    }

    public static func updateStatus(
        id: String,
        status: String,
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { $0.status = status }
    }

    public static func finishSummary(
        id: String,
        summary: String?,
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { file in
            file.summary = summary
            file.status = summary == nil ? "answered" : "success"
        }
    }

    public static func updateParent(
        id: String,
        parent: String?,
        at instancePath: String
    ) throws {
        try NodeStore.mutate(id: id, at: instancePath) { $0.parentId = parent }
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
        try NodeStore.mutate(id: id, at: instancePath) { $0.active = active }
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

    // Delete semantics preserved from the SQL era: single delete bridges
    // children to the deleted node's parent; subtree delete removes all.
    // Files are removed children-first (deepest first), so an interrupted
    // delete leaves orphans the frontend already tolerates — never a parent
    // whose subtree half-exists. Run-log cleanup stays one sqlite transaction.
    public static func deleteNode(id: String, at instancePath: String) throws {
        try bridgeChildren(of: id, at: instancePath)
        try NodeStore.delete(id: id, at: instancePath)
        try deleteRunLogs(underNodeIds: [id], at: instancePath)
    }

    public static func deleteNodes(ids: Set<String>, at instancePath: String) throws {
        for id in deepestFirst(ids, at: instancePath) {
            try NodeStore.delete(id: id, at: instancePath)
        }
        try deleteRunLogs(underNodeIds: ids, at: instancePath)
    }

    private static func bridgeChildren(of id: String, at instancePath: String) throws {
        guard let gone = NodeStore.load(id: id, at: instancePath) else { return }
        for child in NodeStore.list(at: instancePath) where child.parentId == id {
            try NodeStore.mutate(id: child.id, at: instancePath) { $0.parentId = gone.parentId }
        }
    }

    // Takes NODE ids (cascade companion to deleteNode/deleteNodes): removes
    // every run-log row anchored at those nodes — a run thread is never left
    // dangling under a node that no longer exists.
    private static func deleteRunLogs(underNodeIds ids: Set<String>, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.transaction {
            for id in ids {
                try db.run("DELETE FROM graph_run_logs WHERE node_id = ?;", id)
            }
        }
    }

    public static func runLog(id: String, at instancePath: String) throws -> GraphRunLog? {
        let db = try connect(at: instancePath)
        let sql = "SELECT \(runLogColumns) FROM graph_run_logs WHERE id = ?;"
        return try db.prepare(sql, id).compactMap(toRunLog).first
    }

    // The "delete a turn" contract, shared by node threads and session
    // threads: ONE row splices out — every row whose parent_run_id pointed
    // at it re-parents to ITS parent (nil ⇒ those rows become thread roots),
    // roots re-derive, and the row's notification marker + read rows drop —
    // all in ONE transaction (all statements or none). Deleting a parent is
    // the feature, not an error: no "has children" guard.
    public static func deleteRunLog(id: String, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.transaction {
            try bridgeRunChildren(of: id, db)
            try db.run("DELETE FROM graph_run_logs WHERE id = ?;", id)
            dropRunMarkerRows(db, runId: id)
            repairRootRunIds(db)
        }
    }

    // `next` reparents to `deleted.parent` — the splice that lets a
    // follow-up turn survive the deletion of the turn it answered. Must run
    // BEFORE the row dies: the subselect reads the deleted run's parent.
    private static func bridgeRunChildren(of id: String, _ db: Connection) throws {
        let sql = """
        UPDATE graph_run_logs
        SET parent_run_id = (SELECT parent_run_id FROM graph_run_logs WHERE id = ?)
        WHERE parent_run_id = ?;
        """
        try db.run(sql, id, id)
    }

    // Hygiene, not correctness: the notification LIST derives from rows (a
    // deleted run's notification vanishes with its row), but the kind marker
    // and read rows would linger forever. notification_reads may not exist
    // on graph-only instances — that failure must not fail the delete.
    private static func dropRunMarkerRows(_ db: Connection, runId: String) {
        try? db.run("DELETE FROM notification_kinds WHERE run_id = ?;", runId)
        try? db.run("DELETE FROM notification_reads WHERE ref_id = ?;", runId)
    }

    // The "delete a full RUN" contract (the runs-list delete): the thread
    // root AND every row of its thread go together — the conversation twin
    // of deleteNodes' subtree cascade. Ids are collected BEFORE the delete
    // (marker/read hygiene for each); repairRootRunIds stays the safety net
    // for any stray row still pointing into the dead thread.
    public static func deleteRunThread(id: String, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.transaction {
            let ids = threadRunIds(id, db)
            try db.run("DELETE FROM graph_run_logs WHERE id = ? OR root_run_id = ?;", id, id)
            for runId in ids { dropRunMarkerRows(db, runId: runId) }
            repairRootRunIds(db)
        }
    }

    private static func threadRunIds(_ rootId: String, _ db: Connection) -> [String] {
        let sql = "SELECT id FROM graph_run_logs WHERE id = ? OR root_run_id = ?;"
        guard let rows = try? db.prepare(sql, rootId, rootId) else { return [] }
        return rows.compactMap { $0[0] as? String }
    }

    static func purgeOldRunLogs(olderThan cutoff: Double, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        guard try sqliteMasterHas("graph_run_logs", db) else { return }
        let ids = try oldRunIds(cutoff, db)
        try db.transaction {
            try db.run("DELETE FROM graph_run_logs WHERE created_at < ?;", cutoff)
            for runId in ids { dropRunMarkerRows(db, runId: runId) }
            repairRootRunIds(db)
        }
    }

    private static func deepestFirst(_ ids: Set<String>, at instancePath: String) -> [String] {
        let parentOf = NodeStore.list(at: instancePath)
            .reduce(into: [:]) { $0[$1.id] = $1.parentId }
        return ids.sorted { (depth(of: $0, parentOf: parentOf), $1) > (depth(of: $1, parentOf: parentOf), $0) }
    }

    // Cycle-safe hop count up the parent chain (0 = root).
    private static func depth(of id: String, parentOf: [String: String?]) -> Int {
        var hops = 0
        var seen: Set<String> = []
        var cur: String? = id
        while let c = cur, seen.insert(c).inserted, let p = parentOf[c] ?? nil {
            cur = p
            hops += 1
        }
        return hops
    }

    public struct PersonaContext {
        public let texts: [String]
        public let mcps: Set<GraphMcpEndpoint>

        public init(texts: [String], mcps: Set<GraphMcpEndpoint>) {
            self.texts = texts
            self.mcps = mcps
        }

        public static let empty = PersonaContext(texts: [], mcps: [])
    }

    public static func personaContext(personaId: String, at instancePath: String) throws -> PersonaContext {
        let nodes = try fetchNodes(at: instancePath)
        let chains = longestAssignedChains(personaId: personaId, nodes: nodes)
        return PersonaContext(
            texts: chains.map(chainText),
            mcps: chains.reduce(into: []) { $0.formUnion(chainMcpEndpoints($1, at: instancePath)) }
        )
    }

    public static func chainText(_ chain: [GraphNode]) -> String {
        chain.compactMap(\.summary).joined(separator: "\n\n---\n\n")
    }

    /// Auth is resolved HERE, by URL, from the secrets store OF THE INSTANCE
    /// THE NODES CAME FROM — never stored on the node. Parent-instance
    /// semantics fall out for free: every caller builds its chain from one
    /// dir's node files and passes that same dir, so a node living in
    /// `/prj/root/.openloop/nodes` reads `/prj/root/.openloop/secrets.json5`
    /// while a node in `/prj/root/inner/.openloop` reads its own — the
    /// runner/collectContext and sessionPersonaContext per-dir loops keep
    /// that pairing intact. Marker-less URLs on a machine that happens to
    /// hold their key still get auth: the store is keyed by endpoint, and a
    /// configured endpoint's key applies to every node that calls it.
    public static func chainMcpEndpoints(_ chain: [GraphNode], at instancePath: String) -> Set<GraphMcpEndpoint> {
        let secrets = SecretStore.load(at: instancePath)
        return Set(chain.compactMap { node in
            guard let url = node.mcp, url.notEmpty else { return nil }
            return GraphMcpEndpoint(url: url, auth: secrets[url])
        })
    }

    /// URL-deduped union of per-folder endpoint sets, NEAREST FOLDER WINS:
    /// `perDir` must be ordered nearest-first (see
    /// `Paths.contextLookupDirs`), and the first folder to contribute a URL
    /// owns its auth — two folders holding different keys for the same URL
    /// must not surface the loser as a ghost `host-2` server in the run's
    /// mcp config (which plain `formUnion` would keep).
    public static func nearestWinsMcpUnion(
        _ perDir: [Set<GraphMcpEndpoint>]
    ) -> Set<GraphMcpEndpoint> {
        var byUrl: [String: GraphMcpEndpoint] = [:]
        for set in perDir {
            for endpoint in set where byUrl[endpoint.url] == nil {
                byUrl[endpoint.url] = endpoint
            }
        }
        return Set(byUrl.values)
    }

    public static let containerCtxDir = "/context"

    public static func contextRunDir(_ runId: String) -> FilePath {
        Paths.tmpRoot.appending("graph-runs").appending(runId)
    }

    public static func deleteContextRunDir(_ id: String) {
        _ = PathIO.deleteDirectoryAndItsContents(atPath: contextRunDir(id).string)
    }

    private static let staleArtifactsMaxAge: TimeInterval = 24 * 3600

    public static func sweepStaleRunArtifacts() {
        sweepStaleRunArtifacts(maxAge: staleArtifactsMaxAge)
    }

    public static func sweepStaleRunArtifacts(maxAge: TimeInterval) {
        let tmp = Paths.tmpRoot
        sweepStaleEntries(in: tmp.appending("graph-runs").string, maxAge: maxAge)
        sweepStaleEntries(in: tmp.appending("graph-mcp").string, maxAge: maxAge)
    }

    private static func sweepStaleEntries(in dir: String, maxAge: TimeInterval) {
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

    private static func uniqueServerName(for url: String, used: Set<String>) -> String {
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

    private static func longestAssignedChains(personaId: String, nodes: [GraphNode]) -> [[GraphNode]] {
        let matched = assignedWithSummary(personaId: personaId, nodes: nodes)
        return matched
            .filter { node in !matched.contains { isAncestor(node, of: $0, nodes: nodes) } }
            .map { chain(of: $0, in: nodes) }
    }

    private static func assignedWithSummary(personaId: String, nodes: [GraphNode]) -> [GraphNode] {
        nodes.filter { $0.active && $0.personas.contains(personaId) && $0.summary?.notEmpty == true }
    }

    private static func isAncestor(_ node: GraphNode, of other: GraphNode, nodes: [GraphNode]) -> Bool {
        guard other.id != node.id else { return false }
        return chain(of: other, in: nodes).contains { $0.id == node.id }
    }

    private static let runLogColumns = "id, node_id, prompt, status, output, took, created_at, completed_at, parent_run_id, summary, root_run_id"

    public static func insertRunLog(_ log: GraphRunLog, at instancePath: String) throws {
        let db = try connect(at: instancePath)
        try db.run(
            "INSERT INTO graph_run_logs (id, node_id, prompt, status, output, took, created_at, parent_run_id, root_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
            log.id, log.nodeId, log.prompt, log.status, log.output, log.took, log.createdAt, log.parentRunId, log.rootRunId
        )
    }

    /// Session-anchored run-log insert (workflow follow-up thread). `nodeId`
    /// carries the workflow session UUID — the single overloaded anchor
    /// column — and the notification kind discriminator is the marker row
    /// written in the SAME transaction, never inferred from the id later.
    /// Unlike insertRunLog this also persists `completed_at` (the seeded
    /// run-0 row is born with it set, so its completion surfaces in
    /// notifications the moment its status turns terminal).
    public static func insertSessionRunLog(
        _ log: GraphRunLog,
        session: String,
        workflowId: String,
        at instancePath: String
    ) throws {
        let db = try connect(at: instancePath)
        try db.transaction {
            try db.run(
                "INSERT INTO graph_run_logs (id, node_id, prompt, status, output, took, created_at, completed_at, parent_run_id, root_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
                log.id, log.nodeId, log.prompt, log.status, log.output, log.took, log.createdAt, log.completedAt, log.parentRunId, log.rootRunId
            )
            try db.run(
                "INSERT OR REPLACE INTO notification_kinds (run_id, kind, session, workflow_id) VALUES (?, 'session_run', ?, ?);",
                log.id, session, workflowId
            )
        }
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

    /// One thread by its root id (root included), oldest first — the
    /// liveness-guard source for the full-RUN delete.
    public static func fetchRunThread(rootId: String, at instancePath: String) throws -> [GraphRunLog] {
        let db = try connect(at: instancePath)
        let rows = try db.prepare(
            "SELECT \(runLogColumns) FROM graph_run_logs WHERE id = ? OR root_run_id = ? ORDER BY created_at ASC;", rootId, rootId
        )
        return rows.compactMap(toRunLog)
    }

    public static func fetchProgressRunLogs(at instancePath: String) throws -> [GraphRunLog] {
        let db = try connect(at: instancePath)
        let rows = try db.prepare(
            "SELECT \(runLogColumns) FROM graph_run_logs WHERE status IN (\(runningStatusesSqlList));"
        )
        return rows.compactMap(toRunLog)
    }

    public static let runningStatuses = ["progress", "summarizing"]

    private static let runningStatusesSqlList = runningStatuses.map { "'\($0)'" }.joined(separator: ", ")

    public static func countRunningRunLogs(at instancePath: String) -> (node: Int, session: Int) {
        let path = dbPath(at: instancePath)
        guard PathIO.isFileExistent(atPath: path) else { return (0, 0) }
        var stage = "connect (open + pragmas)"
        do {
            let db = try connect(at: instancePath)
            stage = "sqlite_master table probe"
            let hasRunLogs = try sqliteMasterHas("graph_run_logs", db)
            let hasKinds = try sqliteMasterHas("notification_kinds", db)
            guard hasRunLogs, hasKinds else {
                storeLog.warn(
                    "running-count: tolerated state at \(path): graph_run_logs=\(hasRunLogs) notification_kinds=\(hasKinds) — returning 0/0"
                )
                return (0, 0)
            }
            stage = "count query"
            return try runningRunCounts(on: db)
        } catch {
            storeLog.err("running-count: FAILED at stage [\(stage)] on \(path): \(describeSqliteError(error))")
            logDbDiagnostics(at: path)
            assertionFailure("graph_run_logs read failed on an existing db [stage \(stage)]: \(describeSqliteError(error))")
            return (0, 0)
        }
    }

    private static func logDbDiagnostics(at path: String) {
        let fm = FileManager.default
        func sizeInfo(_ p: String) -> String {
            guard let attrs = try? fm.attributesOfItem(atPath: p),
                  let size = attrs[.size] as? Int,
                  let mtime = attrs[.modificationDate] as? Date else { return "missing" }
            return "\(size)B mtime=\(Int(mtime.timeIntervalSinceReferenceDate))"
        }
        storeLog.err(
            "diag: db=\(sizeInfo(path)) wal=\(sizeInfo(path + "-wal")) shm=\(sizeInfo(path + "-shm"))"
        )
        do {
            let db = try Connection(path)
            let tables = (try? db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;"))?
                .compactMap { $0[0] as? String } ?? ["<unreadable>"]
            storeLog.err("diag: tables: \(tables.joined(separator: ", "))")
            if tables.contains("graph_run_logs") {
                let histogram = (try? db.prepare("SELECT status, COUNT(*) FROM graph_run_logs GROUP BY status;"))?
                    .compactMap { row -> String? in
                        guard let status = row[0] as? String, let n = row[1] as? Int64 else { return nil }
                        return "\(status)=\(n)"
                    } ?? []
                storeLog.err(
                    "diag: graph_run_logs by status: \(histogram.joined(separator: ", ")) (counted as running: \(runningStatuses.joined(separator: ", ")))"
                )
            }
        } catch {
            storeLog.err("diag: diagnostics read failed: \(describeSqliteError(error))")
        }
    }

    private static func runningRunCounts(on db: Connection) throws -> (node: Int, session: Int) {
        var counts = (node: 0, session: 0)
        for row in try db.prepare(runningRunCountSql) {
            guard let isSession = row[0] as? Int64,
                  let n = row[1] as? Int64 else {
                storeLog.err(
                    "running-count: undecodable row is_session=\(String(describing: row[0])) count=\(String(describing: row[1]))"
                )
                assertionFailure("corrupt graph_run_logs running-count row")
                continue
            }
            if isSession == 1 { counts.session = Int(n) } else { counts.node = Int(n) }
        }
        return counts
    }

    private static let runningRunCountSql = """
    SELECT (COALESCE(k.kind, '') = 'session_run') AS is_session, COUNT(*)
    FROM graph_run_logs g
    LEFT JOIN notification_kinds k ON k.run_id = g.id
    WHERE g.status IN (\(runningStatusesSqlList))
    GROUP BY is_session;
    """

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
            "SELECT g.node_id, g.status, COUNT(*) FROM graph_run_logs g " +
            "LEFT JOIN notification_kinds k ON k.run_id = g.id " +
            "WHERE g.parent_run_id IS NULL AND COALESCE(k.kind, '') <> 'session_run' " +
            "GROUP BY g.node_id, g.status;"
        )
        return rows.reduce(into: [:]) { counts, row in
            guard let parts = countParts(row) else { return }
            counts[parts.id, default: RunCounts()].total += parts.n
            if parts.status == "success" { counts[parts.id]!.success += parts.n }
            if parts.status == "failed" { counts[parts.id]!.failed += parts.n }
            if parts.status == "progress" || parts.status == "summarizing" { counts[parts.id]!.active += parts.n }
        }
    }

    private static func countParts(_ row: [Binding?]) -> (id: String, status: String, n: Int)? {
        guard let id = row[0] as? String,
              let status = row[1] as? String,
              let n = row[2] as? Int64 else {
            assertionFailure("corrupt graph_run_logs count row")
            return nil
        }
        return (id, status, Int(n))
    }

    private static func toRunLog(_ row: [Binding?]) -> GraphRunLog? {
        guard let id = row[0] as? String,
              let nodeId = row[1] as? String,
              let prompt = row[2] as? String,
              let status = row[3] as? String,
              let createdAt = row[6] as? Double else {
            assertionFailure("corrupt graph_run_logs row: \(row[0] ?? "nil")")
            return nil
        }
        return GraphRunLog(
            id: id, nodeId: nodeId, prompt: prompt, status: status,
            output: row[4] as? String, took: (row[5] as? Int64).map(Int.init),
            createdAt: createdAt, completedAt: row[7] as? Double,
            parentRunId: row[8] as? String, summary: row[9] as? String, rootRunId: row[10] as? String
        )
    }
}

private func oldRunIds(_ cutoff: Double, _ db: Connection) throws -> [String] {
    let sql = "SELECT id FROM graph_run_logs WHERE created_at < ?;"
    return try db.prepare(sql, cutoff).compactMap { $0[0] as? String }
}
