import Foundation
import SQLite
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

/// One notification derived from an instance's own logs.db:
/// kind "workflow" → refId is the run session (run_ends row)
/// kind "node_run" → refId is the graph_run_logs row id
/// kind "session_run" → refId is the graph_run_logs row id of a workflow
/// follow-up turn; nodeId holds the workflow session UUID
public struct NotificationItem: Sendable, Equatable {

    public let kind: String
    public let refId: String
    public let workflowId: String?
    public let nodeId: String?
    public let prompt: String?
    public let success: Bool
    public let took: Int?
    public let endedAt: Double
    public let read: Bool

    public init(
        kind: String, refId: String, workflowId: String?, nodeId: String?,
        prompt: String?, success: Bool, took: Int?, endedAt: Double, read: Bool
    ) {
        self.kind = kind
        self.refId = refId
        self.workflowId = workflowId
        self.nodeId = nodeId
        self.prompt = prompt
        self.success = success
        self.took = took
        self.endedAt = endedAt
        self.read = read
    }
}

/// Persisted kind discriminator for a graph run-log row (notification_kinds
/// table in logs.db), written transactionally by the producer at run-log
/// insert time — GraphStore.insertSessionRunLog. `graph_run_logs.node_id` is
/// a single overloaded anchor column (node id or workflow session UUID), so
/// the kind cannot be inferred from the id later; the marker is the source of
/// truth. Absence of a marker means "node_run".
public struct NotificationKindMarker: Sendable, Equatable {
    public let runId: String
    public let kind: String
    public let session: String?
    public let workflowId: String?

    public init(runId: String, kind: String, session: String?, workflowId: String?) {
        self.runId = runId
        self.kind = kind
        self.session = session
        self.workflowId = workflowId
    }
}

/// Reads notifications straight out of the per-instance logs.db
/// (run_ends + terminal graph_run_logs, minus notification_reads markers).
/// No separate ledger, no poller — requests derive everything on the fly.
public enum Notifications {

    public static func list(limit: Int = 100, at instancePath: String) throws -> [NotificationItem] {
        guard PathIO.isFileExistent(atPath: try LogManager.logsDbPath(at: instancePath)) else {
            return []
        }
        try LogManager.createTables(at: instancePath)
        var items = try rawItems(at: instancePath).sorted { $0.endedAt > $1.endedAt }
        let readSets = try readSets(at: instancePath)
        for i in items.indices {
            items[i] = marked(items[i], readSets: readSets)
        }
        return Array(items.prefix(limit))
    }

    public static func unreadCount(at instancePath: String) -> Int {
        ((try? list(at: instancePath)) ?? []).filter { !$0.read }.count
    }

    public static func markRead(
        kind: String, refId: String, at instancePath: String
    ) throws {
        guard PathIO.isFileExistent(atPath: try LogManager.logsDbPath(at: instancePath)) else {
            return
        }
        try LogManager.createTables(at: instancePath)
        try LogManager.markNotificationRead(kind: kind, refId: refId, at: instancePath)
    }

    public static func markAllRead(at instancePath: String) throws {
        guard PathIO.isFileExistent(atPath: try LogManager.logsDbPath(at: instancePath)) else {
            return
        }
        try LogManager.createTables(at: instancePath)
        try LogManager.markAllNotificationsRead(at: instancePath)
    }

    private static func rawItems(at instancePath: String) throws -> [NotificationItem] {
        try workflowItems(at: instancePath) + nodeRunItems(at: instancePath)
    }

    private static func readSets(at instancePath: String) throws -> [String: Set<String>] {
        [
            "workflow": try LogManager.fetchReadNotificationRefs(kind: "workflow", at: instancePath),
            "node_run": try LogManager.fetchReadNotificationRefs(kind: "node_run", at: instancePath),
            "session_run": try LogManager.fetchReadNotificationRefs(kind: "session_run", at: instancePath)
        ]
    }

    private static func marked(
        _ item: NotificationItem, readSets: [String: Set<String>]
    ) -> NotificationItem {
        let read: Bool
        switch readSets[item.kind] {
        case .some(let refs): read = refs.contains(item.refId)
        case nil: read = false // a kind readSets does not carry is unknown to this build — unread
        }
        return NotificationItem(
            kind: item.kind, refId: item.refId, workflowId: item.workflowId,
            nodeId: item.nodeId, prompt: item.prompt, success: item.success,
            took: item.took, endedAt: item.endedAt, read: read
        )
    }

    private static func workflowItems(at instancePath: String) throws -> [NotificationItem] {
        try LogManager.fetchRunEnds(since: 0, at: instancePath).map { end in
            NotificationItem(
                kind: "workflow", refId: end.session, workflowId: end.workflowId,
                nodeId: nil, prompt: ask(forSession: end.session, at: instancePath),
                success: end.success, took: end.took, endedAt: end.endedAt, read: false
            )
        }
    }

    private static func ask(forSession session: String, at instancePath: String) -> String? {
        (try? LogManager.fetchFirstAsk(session: session, at: instancePath)).flatMap { $0 }
    }

    private static func nodeRunItems(at instancePath: String) throws -> [NotificationItem] {
        guard let logs = try? GraphStore.fetchTerminalRunLogs(since: 0, at: instancePath) else { return [] }
        guard logs.notEmpty else { return [] }
        guard let markers = try? LogManager.fetchNotificationKinds(at: instancePath) else {
            assertionFailure("notification_kinds must exist — list() created it via LogManager.createTables")
            return []
        }
        // "Latest wins": collapse BEFORE sort/limit — a busy thread can't eat the budget.
        return latestPerCollapseKey(logs, markers: markers)
            .map { item(for: $0, marker: markers[$0.id]) }
    }
}

// MARK: "Latest wins" collapse pipeline

// Kind lives with the notification, not the run log: session-anchored
// rows (workflow follow-ups) carry a persisted marker written at
// insert time; marker-less rows are node runs.
private func item(
    for log: GraphRunLog, marker: NotificationKindMarker?
) -> NotificationItem {
    NotificationItem(
        kind: markerKind(marker), refId: log.id,
        workflowId: marker?.workflowId,
        nodeId: log.nodeId, prompt: log.prompt,
        success: log.status == "success", took: log.took,
        endedAt: endedAt(log), read: false
    )
}

// Absence of a marker means "node_run" (NotificationKindMarker doc).
private func markerKind(_ marker: NotificationKindMarker?) -> String {
    switch marker?.kind {
    case .some(let kind): return kind
    case nil: return "node_run"
    }
}

// One card per parent item — latest wins; adding a kind → extend the switch, pin with a test.
private func collapseKey(
    _ log: GraphRunLog, marker: NotificationKindMarker?
) -> String {
    switch marker?.kind {
    case .some("session_run"):
        return "session_run:" + sessionAnchor(log, marker)
    case nil, .some("node_run"):
        return "node_run:" + nodeRunKey(log)
    case .some(let kind):
        return "\(kind):\(log.id)" // unknown kind — never collapse
    }
}

// NULL root = a legacy row — it keys alone, never merges.
private func nodeRunKey(_ log: GraphRunLog) -> String {
    switch log.rootRunId {
    case .some(let root): return root
    case nil: return log.id
    }
}

// insertSessionRunLog writes the session UUID into the marker in the SAME transaction — nil = contract break.
private func sessionAnchor(
    _ log: GraphRunLog, _ marker: NotificationKindMarker?
) -> String {
    guard let session = marker?.session else {
        assertionFailure("session_run marker on run \(log.id) lacks its session UUID")
        return log.nodeId // release path: the node_id anchor holds the same UUID
    }
    return session
}

private func latestPerCollapseKey(
    _ logs: [GraphRunLog], markers: [String: NotificationKindMarker]
) -> [GraphRunLog] {
    Dictionary(grouping: logs, by: { collapseKey($0, marker: markers[$0.id]) })
        .compactMap { $0.value.max { endedAt($0) < endedAt($1) } }
}

private func endedAt(_ log: GraphRunLog) -> Double {
    guard let completedAt = log.completedAt else {
        assertionFailure("fetchTerminalRunLogs guarantees completed_at (IS NOT NULL) — contract broke for \(log.id)")
        return log.createdAt
    }
    return completedAt
}

#if ISOLATED_RUN_NOTIF
// Isolated sanity run — toggle the (normally commented) ISOLATED_RUN_NOTIF + ISOLATED_RUN defines in Package.swift.
public func testNotificationCollapseFeature() throws {
    let dir = try isolatedNotifSetup()
    defer { try? FileManager.default.removeItem(atPath: dir) }
    try isolatedNotifOneConversationOneDing(dir)
    try isolatedNotifRunsStaySeparate(dir)
    try isolatedNotifReDing(dir)
    try isolatedNotifMarkAll(dir)
    print("OK. ISOLATED_RUN_NOTIF completed. C5.")
}

private func isolatedNotifSetup() throws -> String {
    print("OK. ISOLATED_RUN_NOTIF started.")
    let dir = NSTemporaryDirectory() + "openloop-isolated-notif-\(UUID().uuidString)"
    try FileManager.default.createDirectory(
        atPath: dir + "/.openloop", withIntermediateDirectories: true
    )
    try LogManager.createTables(at: dir)
    print("OK. ISOLATED_RUN_NOTIF C0: temp instance + tables.")
    return dir
}

// updateRunLog stamps the wall clock — seed sessions above it via now + offsets, or the sort hides them.
private let isolatedNotifT0 = Date().timeIntervalSinceReferenceDate

private func isolatedNotifOneConversationOneDing(_ dir: String) throws {
    for (i, at) in [10.0, 20.0, 30.0].enumerated() {
        try isolatedNotifSessionTurn("t\(i)", session: "s1", at: isolatedNotifT0 + at, dir: dir)
    }
    let items = try Notifications.list(at: dir)
    assert(items.count == 1 && items[0].refId == "t2")
    assert(Notifications.unreadCount(at: dir) == 1)
    print("OK. ISOLATED_RUN_NOTIF C1: 3 turns on one session → 1 item (t2), unread=1.")
}

private func isolatedNotifRunsStaySeparate(_ dir: String) throws {
    for i in 0...1 {
        try isolatedNotifNodeTurn("r\(i)", root: "r\(i)", dir: dir)
        try isolatedNotifNodeTurn("r\(i)a", root: "r\(i)", dir: dir)
    }
    let runs = try Notifications.list(at: dir).filter { $0.kind == "node_run" }
    assert(
        runs.count == 2 && runs.allSatisfy { $0.refId.hasSuffix("a") },
        "got \(runs.map { "\($0.refId)@\($0.endedAt)" })"
    )
    print("OK. ISOLATED_RUN_NOTIF C2: 2 Runs of one node → 2 items, one per Run.")
}

private func isolatedNotifReDing(_ dir: String) throws {
    try Notifications.markAllRead(at: dir)
    assert(Notifications.unreadCount(at: dir) == 0)
    try isolatedNotifSessionTurn("t3", session: "s1", at: isolatedNotifT0 + 60, dir: dir)
    let top = try Notifications.list(at: dir).first
    assert(top?.refId == "t3" && top?.read == false, "top = \(String(describing: top?.refId))")
    assert(Notifications.unreadCount(at: dir) == 1)
    print("OK. ISOLATED_RUN_NOTIF C3: all read → new turn re-dings the ONE card (t3).")
}

private func isolatedNotifMarkAll(_ dir: String) throws {
    try Notifications.markAllRead(at: dir)
    assert(Notifications.unreadCount(at: dir) == 0)
    try isolatedNotifSessionTurn("u1", session: "s2", at: isolatedNotifT0 + 70, dir: dir)
    let unread = try Notifications.list(at: dir).filter { !$0.read }
    assert(unread.count == 1 && unread[0].refId == "u1")
    print("OK. ISOLATED_RUN_NOTIF C4: markAllRead holds; 2nd conversation → 1 new unread.")
}

private func isolatedNotifSessionTurn(
    _ id: String, session: String, at: Double, dir: String
) throws {
    try GraphStore.createTables(at: dir)
    try GraphStore.insertSessionRunLog(
        GraphRunLog(
            id: id, nodeId: session, prompt: "p", status: "success",
            output: "o", took: 1, createdAt: at, completedAt: at
        ),
        session: session, workflowId: "wf", at: dir
    )
}

// insertRunLog drops completed_at — the terminal stamp comes from updateRunLog (wall clock).
private func isolatedNotifNodeTurn(_ id: String, root: String, dir: String) throws {
    try GraphStore.insertRunLog(
        GraphRunLog(
            id: id, nodeId: "n1", prompt: "p", status: "progress",
            output: nil, took: nil, createdAt: isolatedNotifT0, completedAt: nil,
            rootRunId: root
        ),
        at: dir
    )
    try GraphStore.updateRunLog(id: id, status: "success", output: "o", took: 1, at: dir)
}
#endif
