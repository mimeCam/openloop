import Foundation
import Logging
import SQLite
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

private let log = PrintLog(module: "Database")

public struct LogManager {

    private static func getConnection(_ dbPath: String) throws -> Connection {
        let db = try Connection(dbPath)
        db.busyTimeout = 3
        try db.execute("PRAGMA journal_mode=WAL;")
        try db.execute("PRAGMA synchronous=NORMAL;")
        return db
    }

    public static func createTables(at instancePath: String) throws {
        let dbPath = FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("logs.db")
            .string
        let db = try getConnection(dbPath)
        try createTables(on: db)
    }

    private static func createTables(on db: Connection) throws {
        try db.execute("""
        CREATE TABLE IF NOT EXISTS logs (
            id TEXT PRIMARY KEY,
            success INTEGER NOT NULL,
            took INTEGER NOT NULL,
            started_at REAL NOT NULL,
            ended_at REAL NOT NULL,
            workflow_id TEXT NOT NULL,
            persona_id TEXT,
            agent TEXT NOT NULL,
            created_at REAL NOT NULL,
            message_id INTEGER NOT NULL
        );
        """)

        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_started_at ON logs(started_at);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_workflow_id ON logs(workflow_id);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_persona_id ON logs(persona_id);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_agent ON logs(agent);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_message_id ON logs(message_id);")

        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_persona_workflow_started ON logs(persona_id, workflow_id, started_at DESC);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_null_persona_started ON logs(started_at DESC) WHERE persona_id IS NULL;")

        try db.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_id TEXT NOT NULL,
            input TEXT NOT NULL,
            output TEXT NOT NULL
        );
        """)

        try db.run("CREATE INDEX IF NOT EXISTS idx_messages_log_id ON messages(log_id);")

        try db.execute("""
        CREATE TABLE IF NOT EXISTS parents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL,
            parent_id TEXT NOT NULL,
            text TEXT NOT NULL
        );
        """)

        try db.run("CREATE INDEX IF NOT EXISTS idx_parents_message_id ON parents(message_id);")

        // One row per top-level workflow run ending; feeds per-instance notifications.
        try db.execute("""
        CREATE TABLE IF NOT EXISTS run_ends (
            session TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            success INTEGER NOT NULL,
            took INTEGER NOT NULL,
            started_at REAL NOT NULL,
            ended_at REAL NOT NULL
        );
        """)
        try db.run("CREATE INDEX IF NOT EXISTS idx_run_ends_ended_at ON run_ends(ended_at);")

        try db.execute("""
        CREATE TABLE IF NOT EXISTS notification_reads (
            kind TEXT NOT NULL,
            ref_id TEXT NOT NULL,
            read_at REAL NOT NULL,
            PRIMARY KEY (kind, ref_id)
        );
        """)

        try db.execute(notificationKindsDdl)

        try migrateLegacy(on: db)
    }

    /// Persisted kind discriminator for graph run-log rows, written by the
    /// producer at run-log insert time. `graph_run_logs.node_id` also holds
    /// workflow session UUIDs (session follow-up threads), and the kind lives
    /// with the notification domain — not on, or inferred from, the run log.
    /// Absence of a marker means "node_run": every node run and every
    /// pre-session-era row stays marker-less.
    /// GraphStore.createRunLogTables creates this table too (same logs.db),
    /// so the transactional session insert never races a fresh instance.
    public static let notificationKindsDdl = """
    CREATE TABLE IF NOT EXISTS notification_kinds (
        run_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        session TEXT,
        workflow_id TEXT
    );
    """

    private static func migrateLegacy(on db: Connection) throws {
        try? db.run("ALTER TABLE logs ADD COLUMN session TEXT;")
        try? db.run("ALTER TABLE logs ADD COLUMN level INTEGER;")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session);")
        try migrateRemoveInstancePath(on: db)
    }

    private static func migrateRemoveInstancePath(on db: Connection) throws {
        let hasColumn = (try? db.prepare("PRAGMA table_info(logs);").contains { $0[1] as? String == "instance_path" }) ?? false
        guard hasColumn else {
            return
        }

        try db.transaction {
            try db.execute("""
            CREATE TABLE logs_new (
                id TEXT PRIMARY KEY,
                success INTEGER NOT NULL,
                took INTEGER NOT NULL,
                started_at REAL NOT NULL,
                ended_at REAL NOT NULL,
                workflow_id TEXT NOT NULL,
                persona_id TEXT,
                agent TEXT NOT NULL,
                created_at REAL NOT NULL,
                message_id INTEGER NOT NULL,
                session TEXT,
                level INTEGER
            );
            """)
            try db.run("""
            INSERT INTO logs_new
                SELECT id, success, took, started_at, ended_at, workflow_id,
                       persona_id, agent, created_at, message_id, session, level
                FROM logs;
            """)
            try db.run("DROP TABLE logs;")
            try db.run("ALTER TABLE logs_new RENAME TO logs;")
        }

        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_started_at ON logs(started_at);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_workflow_id ON logs(workflow_id);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_persona_id ON logs(persona_id);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_agent ON logs(agent);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_message_id ON logs(message_id);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_session ON logs(session);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_persona_workflow_started ON logs(persona_id, workflow_id, started_at DESC);")
        try db.run("CREATE INDEX IF NOT EXISTS idx_logs_null_persona_started ON logs(started_at DESC) WHERE persona_id IS NULL;")
    }

    public static func saveLog(
        _ runLog: RunLog, at instancePath: String
    ) throws {
        log.info("Starting saveLog")
        log.info("workflowId: \(runLog.workflowId)")
        log.info("agent: \(runLog.agent)")
        log.info("success: \(runLog.success)")

        let dbPath = FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("logs.db")
            .string
        log.info("dbPath: \(dbPath)")

        let db = try getConnection(dbPath)
        log.info("Got connection")

        try db.transaction {
            log.info("Inserting message into messages table")
            try db.run(
                "INSERT INTO messages (log_id, input, output) VALUES (?, ?, ?);",
                runLog.workflowId,
                runLog.msg.input,
                runLog.msg.output
            )
            let messageId = db.lastInsertRowid
            log.info("Message inserted with messageId: \(messageId)")

            log.info("Inserting \(runLog.msg.parents.count) parents")
            for parent in runLog.msg.parents {
                try db.run(
                    "INSERT INTO parents (message_id, parent_id, text) VALUES (?, ?, ?);",
                    messageId,
                    parent.id,
                    parent.text
                )
            }
            log.info("Parents inserted")

            log.info("Inserting log into logs table")
            let logId = UUID().uuidString
            try insertLog(runLog, messageId: messageId, logId: logId, on: db)
            log.info("Log inserted successfully")
        }
    }

    public static func countLogs(
        instancePath: String,
        personaId: String? = nil,
        workflowId: String? = nil
    ) throws -> Int {
        log.info("Starting countLogs")
        log.info("instancePath: \(instancePath)")
        log.info("personaId: \(personaId ?? "nil")")
        log.info("workflowId: \(workflowId ?? "nil")")

        let dbPath = FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("logs.db")
            .string
        log.info("dbPath: \(dbPath)")

        let db = try getConnection(dbPath)
        log.info("Got connection")

        var baseQuery = "SELECT COUNT(*) as count FROM logs l"
        var binds: [Binding] = []

        if let personaId {
            baseQuery += " WHERE l.persona_id = ?"
            binds.append(personaId)
        } else {
            baseQuery += " WHERE l.persona_id IS NULL"
        }

        if let workflowId {
            baseQuery += " AND l.workflow_id = ?"
            binds.append(workflowId)
        }

        let finalQuery = baseQuery + ";"

        let count: Int64
        if binds.count == 2 {
            count = try db.scalar(finalQuery, binds[0], binds[1]) as? Int64 ?? 0
        } else {
            count = try db.scalar(finalQuery, binds[0]) as? Int64 ?? 0
        }

        let resultCount = Int(count)
        log.info("Complete. Count: \(resultCount)")
        return resultCount
    }

    public static func fetchLogs(
        instancePath: String,
        personaId: String? = nil,
        workflowId: String? = nil,
        offset: Int = 0,
        limit: Int = 1000
    ) throws -> [RunLog] {
        log.info("Starting fetchLogs")
        log.info("instancePath: \(instancePath)")
        log.info("personaId: \(personaId ?? "nil")")
        log.info("workflowId: \(workflowId ?? "nil")")

        let dbPath = FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("logs.db")
            .string
        log.info("dbPath: \(dbPath)")

        let db = try getConnection(dbPath)
        log.info("Got connection")

        var baseQuery = "SELECT l.success, l.took, l.started_at, l.ended_at, l.workflow_id, l.persona_id, l.agent, m.input, m.output, m.id, l.session, l.level FROM logs l JOIN messages m ON l.message_id = m.id"

        if let personaId {
            baseQuery += " WHERE l.persona_id = ?"
        } else {
            baseQuery += " WHERE l.persona_id IS NULL"
        }

        if let workflowId {
            baseQuery += " AND l.workflow_id = ?"
        }

        let finalQuery = baseQuery + " ORDER BY l.started_at DESC LIMIT ? OFFSET ?;"

        struct LogRowData {
            let success: Bool
            let took: Int
            let startedAt: Double
            let endedAt: Double
            let workflowId: String
            let personaId: String?
            let agent: String
            let input: String
            let output: String
            let messageId: Int64
            let session: String?
            let level: Int?
        }

        log.info("Executing query...")

        var logRows: [LogRowData] = []
        var stmt: Statement

        if let personaId, let workflowId {
            stmt = try db.prepare(finalQuery, personaId, workflowId, limit, offset)
        } else if let personaId {
            stmt = try db.prepare(finalQuery, personaId, limit, offset)
        } else if let workflowId {
            stmt = try db.prepare(finalQuery, workflowId, limit, offset)
        } else {
            stmt = try db.prepare(finalQuery, limit, offset)
        }

        for (index, row) in stmt.enumerated() {
            let success = (row[0] as? Int64 ?? 0) != 0
            let took = Int(row[1] as? Int64 ?? 0)
            let startedAt = row[2] as? Double ?? 0
            let endedAt = row[3] as? Double ?? 0
            let workflowId = row[4] as? String ?? ""
            let personaId = row[5] as? String
            let agent = row[6] as? String ?? ""
            let input = row[7] as? String ?? ""
            let output = row[8] as? String ?? ""
            let messageId = row[9] as? Int64 ?? 0
            let session = row[10] as? String
            let level = (row[11] as? Int64).map { Int($0) }

            log.info("Row #\(index + 1) data - success: \(success), took: \(took), workflowId: \(workflowId), agent: \(agent), messageId: \(messageId), personaId: \(personaId ?? "NULL")")

            logRows.append(LogRowData(
                success: success,
                took: took,
                startedAt: startedAt,
                endedAt: endedAt,
                workflowId: workflowId,
                personaId: personaId,
                agent: agent,
                input: input,
                output: output,
                messageId: messageId,
                session: session,
                level: level
            ))
        }

        log.info("Query complete. Processing \(logRows.count) logRows into results")

        var parentsMap: [Int64: [RunLog.Message.Parent]] = [:]
        var results: [RunLog] = []

        for logRow in logRows {
            log.info("Processing logRow with messageId: \(logRow.messageId)")
            if parentsMap[logRow.messageId] == nil {
                parentsMap[logRow.messageId] = []
                log.info("Fetching parents for messageId: \(logRow.messageId)")

                var parents: [RunLog.Message.Parent] = []
                let parentStmt = try db.prepare("SELECT parent_id, text FROM parents WHERE message_id = ?;", logRow.messageId)
                for parentRow in parentStmt {
                    if let parentId = parentRow[0] as? String,
                       let text = parentRow[1] as? String {
                        log.info("Found parent - id: \(parentId), text: \(text)")
                        parents.append(RunLog.Message.Parent(id: parentId, text: text))
                    }
                }
                parentsMap[logRow.messageId] = parents
                log.info("Found \(parents.count) parents")
            }

            let parents = parentsMap[logRow.messageId] ?? []
            log.info("Creating RunLog with \(parents.count) parents")
            let runLog = RunLog(
                success: logRow.success,
                took: logRow.took,
                startedAt: logRow.startedAt,
                endedAt: logRow.endedAt,
                workflowId: logRow.workflowId,
                personaId: logRow.personaId,
                agent: logRow.agent,
                msg: RunLog.Message(input: logRow.input, output: logRow.output, parents: parents),
                session: logRow.session,
                level: logRow.level
            )
            results.append(runLog)
        }

        log.info("Complete. Returning \(results.count) results")
        return results
    }

    public static func fetchLogsBySession(
        instancePath: String,
        session: String
    ) throws -> [RunLog] {
        log.info("fetchLogsBySession session: \(session)")
        let dbPath = FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("logs.db")
            .string
        let db = try getConnection(dbPath)

        let query = """
        SELECT l.success, l.took, l.started_at, l.ended_at, l.workflow_id, l.persona_id, l.agent, m.input, m.output, m.id, l.session, l.level
        FROM logs l JOIN messages m ON l.message_id = m.id
        WHERE l.session = ?
        ORDER BY l.started_at ASC;
        """

        struct LogRowData {
            let success: Bool; let took: Int
            let startedAt: Double; let endedAt: Double
            let workflowId: String; let personaId: String?
            let agent: String
            let input: String; let output: String
            let messageId: Int64; let session: String?; let level: Int?
        }

        var logRows: [LogRowData] = []
        let stmt = try db.prepare(query, session)
        for row in stmt {
            logRows.append(LogRowData(
                success: (row[0] as? Int64 ?? 0) != 0,
                took: Int(row[1] as? Int64 ?? 0),
                startedAt: row[2] as? Double ?? 0,
                endedAt: row[3] as? Double ?? 0,
                workflowId: row[4] as? String ?? "",
                personaId: row[5] as? String,
                agent: row[6] as? String ?? "",
                input: row[7] as? String ?? "",
                output: row[8] as? String ?? "",
                messageId: row[9] as? Int64 ?? 0,
                session: row[10] as? String,
                level: (row[11] as? Int64).map { Int($0) }
            ))
        }

        var parentsMap: [Int64: [RunLog.Message.Parent]] = [:]
        var results: [RunLog] = []
        for logRow in logRows {
            if parentsMap[logRow.messageId] == nil {
                var parents: [RunLog.Message.Parent] = []
                let pStmt = try db.prepare("SELECT parent_id, text FROM parents WHERE message_id = ?;", logRow.messageId)
                for pRow in pStmt {
                    if let pid = pRow[0] as? String, let txt = pRow[1] as? String {
                        parents.append(RunLog.Message.Parent(id: pid, text: txt))
                    }
                }
                parentsMap[logRow.messageId] = parents
            }
            let parents = parentsMap[logRow.messageId] ?? []
            results.append(RunLog(
                success: logRow.success,
                took: logRow.took,
                startedAt: logRow.startedAt,
                endedAt: logRow.endedAt,
                workflowId: logRow.workflowId,
                personaId: logRow.personaId,
                agent: logRow.agent,
                msg: RunLog.Message(input: logRow.input, output: logRow.output, parents: parents),
                session: logRow.session,
                level: logRow.level
            ))
        }
        log.info("fetchLogsBySession complete. \(results.count) logs")
        return results
    }

    public static func insertRunEnd(_ end: RunEnd, at instancePath: String) throws {
        let db = try getConnection(try logsDbPath(at: instancePath))
        try db.run(
            """
            INSERT OR REPLACE INTO run_ends (session, workflow_id, success, took, started_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?);
            """,
            end.session,
            end.workflowId,
            end.success ? 1 : 0,
            end.took,
            end.startedAt,
            end.endedAt
        )
    }

    /// `since` is exclusive: only rows with `ended_at` strictly greater than
    /// it are returned.
    public static func fetchRunEnds(since: Double, at instancePath: String) throws -> [RunEnd] {
        let db = try getConnection(try logsDbPath(at: instancePath))
        let stmt = try db.prepare(
            """
            SELECT session, workflow_id, success, took, started_at, ended_at
            FROM run_ends WHERE ended_at > ? ORDER BY ended_at ASC;
            """,
            since
        )
        return stmt.compactMap { row in
            guard let session = row[0] as? String,
                  let workflowId = row[1] as? String else { return nil }
            return RunEnd(
                session: session,
                workflowId: workflowId,
                success: (row[2] as? Int64 ?? 0) != 0,
                took: Int(row[3] as? Int64 ?? 0),
                startedAt: row[4] as? Double ?? 0,
                endedAt: row[5] as? Double ?? 0
            )
        }
    }

    /// The single `run_ends` row for a workflow session (INSERT OR REPLACE
    /// keeps one per session) — the success gate for session follow-ups.
    public static func fetchRunEnd(session: String, at instancePath: String) throws -> RunEnd? {
        let db = try getConnection(try logsDbPath(at: instancePath))
        let rows = try db.prepare(
            """
            SELECT session, workflow_id, success, took, started_at, ended_at
            FROM run_ends WHERE session = ? LIMIT 1;
            """,
            session
        )
        return rows.compactMap { row in
            guard let session = row[0] as? String,
                  let workflowId = row[1] as? String else { return nil }
            return RunEnd(
                session: session,
                workflowId: workflowId,
                success: (row[2] as? Int64 ?? 0) != 0,
                took: Int(row[3] as? Int64 ?? 0),
                startedAt: row[4] as? Double ?? 0,
                endedAt: row[5] as? Double ?? 0
            )
        }.first
    }

    public static func fetchFirstAsk(session: String, at instancePath: String) throws -> String? {
        let db = try getConnection(try logsDbPath(at: instancePath))
        let rows = try db.prepare(
            """
            SELECT m.input FROM logs l
            JOIN messages m ON m.id = l.message_id
            WHERE l.session = ? ORDER BY l.started_at ASC LIMIT 1;
            """,
            session
        )
        return rows.compactMap { $0[0] as? String }.first
    }

    public static func markNotificationRead(
        kind: String, refId: String, at instancePath: String
    ) throws {
        let db = try getConnection(try logsDbPath(at: instancePath))
        try db.run(
            "INSERT OR REPLACE INTO notification_reads (kind, ref_id, read_at) VALUES (?, ?, ?);",
            kind, refId, Date().timeIntervalSinceReferenceDate
        )
    }

    public static func fetchReadNotificationRefs(
        kind: String, at instancePath: String
    ) throws -> Set<String> {
        let db = try getConnection(try logsDbPath(at: instancePath))
        let rows = try db.prepare(
            "SELECT ref_id FROM notification_reads WHERE kind = ?;", kind
        )
        return Set(rows.compactMap { $0[0] as? String })
    }

    /// Every persisted run-kind marker, keyed by run id. Only session rows
    /// carry markers; callers treat a missing key as "node_run".
    public static func fetchNotificationKinds(
        at instancePath: String
    ) throws -> [String: NotificationKindMarker] {
        let db = try getConnection(try logsDbPath(at: instancePath))
        let rows = try db.prepare(
            "SELECT run_id, kind, session, workflow_id FROM notification_kinds;"
        )
        var markers: [String: NotificationKindMarker] = [:]
        for row in rows {
            guard let runId = row[0] as? String,
                  let kind = row[1] as? String else { continue }
            markers[runId] = NotificationKindMarker(
                runId: runId,
                kind: kind,
                session: row[2] as? String,
                workflowId: row[3] as? String
            )
        }
        return markers
    }

    public static func markAllNotificationsRead(at instancePath: String) throws {
        let db = try getConnection(try logsDbPath(at: instancePath))
        let now = Date().timeIntervalSinceReferenceDate
        try db.run(
            "INSERT OR REPLACE INTO notification_reads (kind, ref_id, read_at) " +
            "SELECT 'workflow', session, ? FROM run_ends;", now
        )
        // Every terminal graph run log with its persisted kind marker when
        // one exists — session follow-ups must read back as 'session_run',
        // not 'node_run' — while marker-less rows stay 'node_run'.
        try? db.run(
            "INSERT OR REPLACE INTO notification_reads (kind, ref_id, read_at) " +
            "SELECT COALESCE(k.kind, 'node_run'), g.id, ? " +
            "FROM graph_run_logs g LEFT JOIN notification_kinds k ON k.run_id = g.id " +
            "WHERE g.completed_at IS NOT NULL AND g.status IN ('success', 'failed');", now
        )
    }

    static func logsDbPath(at instancePath: String) throws -> String {
        FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("logs.db")
            .string
    }

    private static func insertLog(
        _ runLog: RunLog, messageId: Int64, logId: String, on db: Connection
    ) throws {
        try db.run(
            """
            INSERT INTO logs (id, success, took, started_at, ended_at, workflow_id, persona_id, agent, created_at, message_id, session, level)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """,
            logId,
            runLog.success ? 1 : 0,
            runLog.took,
            runLog.startedAt,
            runLog.endedAt,
            runLog.workflowId,
            runLog.personaId,
            runLog.agent,
            Date().timeIntervalSince1970,
            messageId,
            runLog.session,
            runLog.level.map { Int64($0) }
        )
    }
}
