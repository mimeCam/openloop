import XCTest
import shared

final class NotificationStoreTests: XCTestCase {

    var instanceDir: String!

    override func setUpWithError() throws {
        instanceDir = NSTemporaryDirectory() + "openloop-notif-\(UUID().uuidString)/proj"
        try FileManager.default.createDirectory(
            atPath: instanceDir + "/.openloop", withIntermediateDirectories: true
        )
        try LogManager.createTables(at: instanceDir)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(
            atPath: (instanceDir as NSString).deletingLastPathComponent
        )
    }

    func runEnd(_ session: String, endedAt: Double) throws {
        try LogManager.insertRunEnd(
            RunEnd(
                session: session, workflowId: "wf", success: true, took: 3,
                startedAt: endedAt - 3, endedAt: endedAt
            ),
            at: instanceDir
        )
    }

    func testEmptyInstanceHasNoNotifications() throws {
        XCTAssertEqual(try Notifications.list(at: instanceDir), [])
        XCTAssertEqual(Notifications.unreadCount(at: instanceDir), 0)
    }

    func testMissingDbIsEmpty() throws {
        let ghost = instanceDir + "/ghost"
        XCTAssertEqual(try Notifications.list(at: ghost), [])
        XCTAssertEqual(Notifications.unreadCount(at: ghost), 0)
    }

    func testRunEndsAppearAsUnreadWorkflowNotifications() throws {
        try runEnd("s1", endedAt: 100)
        try runEnd("s2", endedAt: 200)
        let items = try Notifications.list(at: instanceDir)
        XCTAssertEqual(items.map(\.refId), ["s2", "s1"])
        XCTAssertTrue(items.allSatisfy { !$0.read && $0.kind == "workflow" })
        XCTAssertEqual(Notifications.unreadCount(at: instanceDir), 2)
    }

    func testMarkReadHidesFromUnreadButKeepsInList() throws {
        try runEnd("s1", endedAt: 100)
        try Notifications.markRead(kind: "workflow", refId: "s1", at: instanceDir)
        let items = try Notifications.list(at: instanceDir)
        XCTAssertEqual(items.count, 1)
        XCTAssertTrue(items[0].read)
        XCTAssertEqual(Notifications.unreadCount(at: instanceDir), 0)
    }

    func testMarkAllReadCoversWorkflowAndNodeRuns() throws {
        try runEnd("s1", endedAt: 100)
        try completedNodeRun(id: "rl1")
        XCTAssertEqual(Notifications.unreadCount(at: instanceDir), 2)
        try Notifications.markAllRead(at: instanceDir)
        XCTAssertEqual(Notifications.unreadCount(at: instanceDir), 0)
        XCTAssertEqual(try Notifications.list(at: instanceDir).count, 2)
    }

    func testNodeRunItemShape() throws {
        try completedNodeRun(id: "rl1", status: "failed")
        let items = try Notifications.list(at: instanceDir)
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].kind, "node_run")
        XCTAssertEqual(items[0].nodeId, "n1")
        XCTAssertFalse(items[0].success)
        XCTAssertEqual(items[0].prompt, "p")
    }

    func completedNodeRun(id: String, status: String = "success") throws {
        try GraphStore.createTables(at: instanceDir)
        try GraphStore.insertRunLog(
            GraphRunLog(
                id: id, nodeId: "n1", prompt: "p", status: "progress",
                output: nil, took: nil, createdAt: 50, completedAt: nil
            ),
            at: instanceDir
        )
        try GraphStore.updateRunLog(
            id: id, status: status, output: "ok", took: 2, at: instanceDir
        )
    }
}
