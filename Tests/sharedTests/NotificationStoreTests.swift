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

    func testWorkflowItemCarriesOriginalAsk() throws {
        try seedMessage(session: "s1", input: "fix the bug", startedAt: 90)
        try seedMessage(session: "s1", input: "follow-up ask", startedAt: 95)
        try runEnd("s1", endedAt: 100)
        let items = try Notifications.list(at: instanceDir)
        XCTAssertEqual(items.first?.prompt, "fix the bug")
    }

    func testWorkflowItemWithoutSavedAskHasNilPrompt() throws {
        try runEnd("s1", endedAt: 100)
        let items = try Notifications.list(at: instanceDir)
        XCTAssertEqual(items.first?.prompt, nil)
    }

    func seedMessage(session: String, input: String, startedAt: Double) throws {
        try LogManager.saveLog(
            RunLog(
                success: true, took: 1, startedAt: startedAt, endedAt: startedAt + 1,
                workflowId: "wf", personaId: nil, agent: "a",
                msg: .init(input: input, output: "ok", parents: []),
                session: session, level: nil
            ),
            at: instanceDir
        )
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

    // ── Session follow-up notifications (kind "session_run") ───────────────
    // graph_run_logs.node_id is overloaded: session-anchored rows (workflow
    // follow-up turns) carry a notification_kinds marker; kind comes from
    // the marker, never from the id.

    func completedSessionRun(id: String, session: String, status: String = "success") throws {
        try GraphStore.createTables(at: instanceDir)
        try GraphStore.insertSessionRunLog(
            GraphRunLog(
                id: id, nodeId: session, prompt: "p", status: "progress",
                output: nil, took: nil, createdAt: 50, completedAt: nil
            ),
            session: session, workflowId: "wf", at: instanceDir
        )
        try GraphStore.updateRunLog(
            id: id, status: status, output: "ok", took: 2, at: instanceDir
        )
    }

    func testSessionRunMarkerChangesKindAndCarriesWorkflow() throws {
        try runEnd("s1", endedAt: 100)
        try completedNodeRun(id: "rl1")
        try completedSessionRun(id: "sr1", session: "s1")
        let items = try Notifications.list(at: instanceDir)
        XCTAssertEqual(items.count, 3)
        let sessionItem = items.first { $0.refId == "sr1" }
        XCTAssertEqual(sessionItem?.kind, "session_run")
        XCTAssertEqual(sessionItem?.workflowId, "wf")
        XCTAssertEqual(sessionItem?.nodeId, "s1") // the session UUID anchor
        XCTAssertTrue(sessionItem?.success ?? false)
        // the plain node run stays a node run
        XCTAssertEqual(items.first { $0.refId == "rl1" }?.kind, "node_run")
    }

    func testSeededRunStaysInvisibleWhileSummarizing() throws {
        // Run 0 is born with completed_at set but status "summarizing" —
        // the status filter keeps it out of notifications until terminal.
        try GraphStore.createTables(at: instanceDir)
        try GraphStore.insertSessionRunLog(
            GraphRunLog(
                id: "sr0", nodeId: "s1", prompt: "p", status: "summarizing",
                output: "o", took: 1, createdAt: 50, completedAt: 51
            ),
            session: "s1", workflowId: "wf", at: instanceDir
        )
        XCTAssertEqual(try Notifications.list(at: instanceDir).count, 0)
    }

    func testMarkAllReadCoversSessionRuns() throws {
        try runEnd("s1", endedAt: 100)
        try completedSessionRun(id: "sr1", session: "s1")
        XCTAssertEqual(Notifications.unreadCount(at: instanceDir), 2)
        try Notifications.markAllRead(at: instanceDir)
        XCTAssertEqual(Notifications.unreadCount(at: instanceDir), 0)
        // read back under its OWN kind — the COALESCE join must not fold
        // session rows into node_run markers
        XCTAssertEqual(try Notifications.list(at: instanceDir).count, 2)
        XCTAssertTrue(try Notifications.list(at: instanceDir).allSatisfy { $0.read })
    }

    func testMarkReadAcceptsSessionRunKind() throws {
        try completedSessionRun(id: "sr1", session: "s1")
        try Notifications.markRead(kind: "session_run", refId: "sr1", at: instanceDir)
        let items = try Notifications.list(at: instanceDir)
        XCTAssertEqual(items.count, 1)
        XCTAssertTrue(items[0].read)
        XCTAssertEqual(Notifications.unreadCount(at: instanceDir), 0)
    }
}
