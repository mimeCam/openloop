import XCTest
import shared
import SQLite

final class DbSizeTests: XCTestCase {

    var path: String!
    var dbPath: String { path + "/.openloop/logs.db" }

    override func setUpWithError() throws {
        path = NSTemporaryDirectory() + "openloop-dbsize-\(UUID().uuidString)"
        // .openloop must exist before createTables opens its connection
        try FileManager.default.createDirectory(
            atPath: path + "/.openloop", withIntermediateDirectories: true
        )
        try LogManager.createTables(at: path)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(atPath: path)
    }

    // MARK: - size

    func testSizeIsZeroWithoutDb() throws {
        let fresh = NSTemporaryDirectory() + "openloop-dbsize-none-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: fresh) }
        XCTAssertEqual(LogManager.dbFilesSize(at: fresh), 0)
    }

    func testSizeSumsDbAndSidecars() throws {
        try Data(repeating: 1, count: 1024).write(to: URL(fileURLWithPath: dbPath + "-wal"))
        try Data(repeating: 1, count: 512).write(to: URL(fileURLWithPath: dbPath + "-shm"))
        XCTAssertEqual(
            LogManager.dbFilesSize(at: path),
            try fmSize(dbPath) + fmSize(dbPath + "-wal") + fmSize(dbPath + "-shm")
        )
    }

    func testNeedsCleanThresholdBelowAtAbove() throws {
        // below: the fresh db from setUp is a few KB
        XCTAssertLessThan(LogManager.dbFilesSize(at: path), LogManager.cleanThresholdBytes)
        // at: exactly 1 GiB of sidecar already tips the >= verdict
        try makeSparseWal(of: LogManager.cleanThresholdBytes)
        XCTAssertGreaterThanOrEqual(LogManager.dbFilesSize(at: path), LogManager.cleanThresholdBytes)
        try makeSparseWal(of: LogManager.cleanThresholdBytes + 1024)
        XCTAssertGreaterThan(LogManager.dbFilesSize(at: path), LogManager.cleanThresholdBytes)
    }

    // MARK: - clean

    func testCleanRemovesOldLogsAndCascadesMessagesParents() throws {
        let ref = Date().timeIntervalSinceReferenceDate
        try insertLog(workflowId: "old-wf", startedAt: ref - olderThanMonthSecs)
        try insertLog(workflowId: "fresh-wf", startedAt: ref)
        _ = try LogManager.cleanOldLogs(at: path)
        XCTAssertEqual(try LogManager.countLogs(instancePath: path), 1)
        XCTAssertEqual(try scalarInt("SELECT COUNT(*) FROM messages;"), 1)
        XCTAssertEqual(try scalarInt("SELECT COUNT(*) FROM parents;"), 1)
        XCTAssertEqual(try LogManager.fetchLogs(instancePath: path, workflowId: "fresh-wf").count, 1)
        XCTAssertEqual(try LogManager.fetchLogs(instancePath: path, workflowId: "old-wf").count, 0)
    }

    // regression: the cascade must walk logs.message_id -> messages.id (messages.log_id holds the WORKFLOW id)
    func testCleanCascadesViaMessageIdNotLogId() throws {
        let sharedMessageId = try insertSharedMessagePair()
        _ = try LogManager.cleanOldLogs(at: path)
        XCTAssertEqual(try scalarInt("SELECT COUNT(*) FROM logs;"), 1)
        XCTAssertEqual(try scalarInt("SELECT COUNT(*) FROM messages;"), 1)
        XCTAssertEqual(
            try scalarInt("SELECT COUNT(*) FROM messages WHERE id = \(sharedMessageId);"), 1
        )
    }

    func testCleanRemovesOldRunEndsGraphRunsAndMarkers() throws {
        let ref = Date().timeIntervalSinceReferenceDate
        let monthAgo = ref - monthSecs
        try LogManager.insertRunEnd(end("old", monthAgo), at: path)
        try LogManager.insertRunEnd(end("fresh", ref), at: path)
        try LogManager.markNotificationRead(kind: "workflow", refId: "old", at: path)
        try GraphStore.createTables(at: path)
        try GraphStore.insertSessionRunLog(
            run("old-run", createdAt: monthAgo), session: "s", workflowId: "wf", at: path
        )
        try GraphStore.insertRunLog(run("fresh-run", createdAt: ref), at: path)
        try LogManager.markNotificationRead(kind: "node_run", refId: "old-run", at: path)
        _ = try LogManager.cleanOldLogs(at: path)
        XCTAssertEqual(try LogManager.fetchRunEnds(since: 0, at: path).count, 1)
        XCTAssertEqual(try GraphStore.fetchRunLogs(nodeId: "n", at: path).count, 1)
        XCTAssertEqual(try scalarInt("SELECT COUNT(*) FROM notification_reads;"), 0)
        XCTAssertEqual(try scalarInt("SELECT COUNT(*) FROM notification_kinds;"), 0)
    }

    func testCleanCutoffBoundary() throws {
        let ref = Date().timeIntervalSinceReferenceDate
        // strictly-less cutoff — 5 s inside survives, 5 s past dies
        try insertLog(workflowId: "newer-wf", startedAt: ref - monthSecs + 5)
        try insertLog(workflowId: "older-wf", startedAt: ref - monthSecs - 5)
        _ = try LogManager.cleanOldLogs(at: path)
        XCTAssertEqual(try LogManager.countLogs(instancePath: path), 1)
        XCTAssertEqual(try LogManager.fetchLogs(instancePath: path, workflowId: "newer-wf").count, 1)
    }

    func testCleanWithoutDbIsNoOpSuccess() throws {
        let fresh = NSTemporaryDirectory() + "openloop-dbsize-noclean-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: fresh) }
        let outcome = try LogManager.cleanOldLogs(at: fresh)
        XCTAssertEqual(outcome.sizeBefore, 0)
        XCTAssertEqual(outcome.sizeAfter, 0)
        XCTAssertTrue(outcome.vacuumed)
        // the clean path must never CREATE a db
        XCTAssertFalse(FileManager.default.fileExists(atPath: fresh + "/.openloop/logs.db"))
    }

    func testCleanShrinksFileAfterVacuum() throws {
        let ref = Date().timeIntervalSinceReferenceDate
        try insertLog(
            workflowId: "big-old-wf",
            startedAt: ref - olderThanMonthSecs,
            output: String(repeating: "x", count: 200_000)
        )
        let before = LogManager.dbFilesSize(at: path)
        let outcome = try LogManager.cleanOldLogs(at: path)
        XCTAssertTrue(outcome.vacuumed)
        XCTAssertLessThan(outcome.sizeAfter, before)
        XCTAssertGreaterThan(outcome.bytesReclaimed, 0)
    }

    // regression: sizeAfter is measured after the connection closes — an open WAL pins a transient -shm
    func testCleanSizeAfterExcludesTransientSidecars() throws {
        let ref = Date().timeIntervalSinceReferenceDate
        try insertLog(workflowId: "tiny-old-wf", startedAt: ref - olderThanMonthSecs)
        let before = LogManager.dbFilesSize(at: path)
        let outcome = try LogManager.cleanOldLogs(at: path)
        XCTAssertTrue(outcome.vacuumed)
        XCTAssertLessThanOrEqual(outcome.sizeAfter, before)
        XCTAssertEqual(outcome.sizeAfter, LogManager.dbFilesSize(at: path))
    }

    // MARK: - fixtures

    private let monthSecs = 30.0 * 24 * 3600
    private let olderThanMonthSecs = 40.0 * 24 * 3600

    private func end(_ session: String, _ endedAt: Double) -> RunEnd {
        RunEnd(
            session: session, workflowId: "wf", success: true,
            took: 3, startedAt: endedAt - 3, endedAt: endedAt
        )
    }

    private func run(_ id: String, createdAt: Double) -> GraphRunLog {
        GraphRunLog(
            id: id, nodeId: "n", prompt: "p", status: "success",
            output: "o", took: 1, createdAt: createdAt, completedAt: createdAt + 1
        )
    }

    private func insertLog(workflowId: String, startedAt: Double, output: String = "out") throws {
        try LogManager.saveLog(
            RunLog(
                success: true, took: 1, startedAt: startedAt, endedAt: startedAt + 1,
                workflowId: workflowId, personaId: nil, agent: "a",
                msg: RunLog.Message(
                    input: "in", output: output,
                    parents: [RunLog.Message.Parent(id: "p", text: "ctx")]
                )
            ),
            at: path
        )
    }

    // the shape saveLog can't produce: one message shared by an old and a fresh logs row
    private func insertSharedMessagePair() throws -> Int64 {
        let db = try Connection(dbPath)
        try db.run("INSERT INTO messages (log_id, input, output) VALUES ('wf', 'in', 'out');")
        let mid = db.lastInsertRowid
        let ref = Date().timeIntervalSinceReferenceDate
        try insertLogRow(id: "old", startedAt: ref - olderThanMonthSecs, messageId: mid)
        try insertLogRow(id: "fresh", startedAt: ref, messageId: mid)
        return mid
    }

    private func insertLogRow(id: String, startedAt: Double, messageId: Int64) throws {
        try Connection(dbPath).run(
            """
            INSERT INTO logs (id, success, took, started_at, ended_at, workflow_id,
                              persona_id, agent, created_at, message_id)
            VALUES (?, 1, 1, ?, ?, 'wf', NULL, 'a', 0, ?);
            """,
            id, startedAt, startedAt + 1, messageId
        )
    }

    private func makeSparseWal(of bytes: Int64) throws {
        _ = FileManager.default.createFile(atPath: dbPath + "-wal", contents: nil)
        let fh = try FileHandle(forWritingTo: URL(fileURLWithPath: dbPath + "-wal"))
        try fh.truncate(atOffset: UInt64(bytes))
        try fh.close()
    }

    private func scalarInt(_ sql: String) throws -> Int {
        Int(try XCTUnwrap(
            try Connection(dbPath).scalar(sql) as? Int64,
            "\(sql) must return an integer"
        ))
    }

    private func fmSize(_ p: String) throws -> Int64 {
        let attrs = try FileManager.default.attributesOfItem(atPath: p)
        return try XCTUnwrap(attrs[.size] as? NSNumber, "\(p) must stat with a size").int64Value
    }
}
