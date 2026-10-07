import XCTest
import shared

final class RunEndsTests: XCTestCase {

    var path: String!

    override func setUpWithError() throws {
        path = NSTemporaryDirectory() + "openloop-runends-\(UUID().uuidString)"
        // Production boot sequence: runner.run() → LogManager.createTables
        // (which needs `.openloop` to exist, as `openloop` boot guarantees).
        try FileManager.default.createDirectory(
            atPath: path + "/.openloop", withIntermediateDirectories: true
        )
        try LogManager.createTables(at: path)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(atPath: path)
    }

    func end(_ session: String, endedAt: Double, success: Bool = true) -> RunEnd {
        RunEnd(
            session: session, workflowId: "wf", success: success,
            took: 3, startedAt: endedAt - 3, endedAt: endedAt
        )
    }

    func testInsertAndFetchRoundTrip() throws {
        try LogManager.insertRunEnd(end("s1", endedAt: 100), at: path)
        let ends = try LogManager.fetchRunEnds(since: 0, at: path)
        XCTAssertEqual(ends.count, 1)
        XCTAssertEqual(ends[0].session, "s1")
        XCTAssertEqual(ends[0].workflowId, "wf")
        XCTAssertTrue(ends[0].success)
        XCTAssertEqual(ends[0].took, 3)
    }

    func testFetchSinceExcludesBoundaryAndOlder() throws {
        try LogManager.insertRunEnd(end("s1", endedAt: 100), at: path)
        XCTAssertEqual(try LogManager.fetchRunEnds(since: 100, at: path).count, 0)
        XCTAssertEqual(try LogManager.fetchRunEnds(since: 100.1, at: path).count, 0)
        XCTAssertEqual(try LogManager.fetchRunEnds(since: 99.9, at: path).count, 1)
    }

    func testFetchReturnsFailureFlag() throws {
        try LogManager.insertRunEnd(end("ok", endedAt: 100), at: path)
        try LogManager.insertRunEnd(end("bad", endedAt: 101, success: false), at: path)
        let ends = try LogManager.fetchRunEnds(since: 0, at: path)
        XCTAssertEqual(ends.first { $0.session == "ok" }?.success, true)
        XCTAssertEqual(ends.first { $0.session == "bad" }?.success, false)
    }

    func testTerminalRunLogsOnlyReturnsTerminalStatuses() throws {
        try GraphStore.createTables(at: path)
        // Production shape: insert as progress, terminal status + completed_at
        // arrive via updateRunLog (executeRunLog / sweepRunLogs).
        try GraphStore.insertRunLog(
            GraphRunLog(id: "p", nodeId: "n", prompt: "p", status: "progress",
                        output: nil, took: nil, createdAt: 1, completedAt: nil),
            at: path
        )
        try GraphStore.insertRunLog(
            GraphRunLog(id: "s", nodeId: "n", prompt: "p", status: "progress",
                        output: nil, took: nil, createdAt: 1, completedAt: nil),
            at: path
        )
        try GraphStore.updateRunLog(id: "s", status: "success", output: "o", took: 2, at: path)

        let stillRunning = try GraphStore.fetchTerminalRunLogs(since: 0, at: path)
        XCTAssertEqual(stillRunning.map(\.id), ["s"]) // progress never qualifies
    }

    func testTerminalRunLogsSinceBoundary() throws {
        try GraphStore.createTables(at: path)
        try GraphStore.insertRunLog(
            GraphRunLog(id: "s", nodeId: "n", prompt: "p", status: "progress",
                        output: nil, took: nil, createdAt: 1, completedAt: nil),
            at: path
        )
        try GraphStore.updateRunLog(id: "s", status: "success", output: "o", took: 2, at: path)
        let endedAt = Date().timeIntervalSinceReferenceDate // ~= completed_at just written
        XCTAssertEqual(try GraphStore.fetchTerminalRunLogs(since: endedAt + 1, at: path).count, 0)
        XCTAssertEqual(try GraphStore.fetchTerminalRunLogs(since: endedAt - 1, at: path).count, 1)
    }
}
