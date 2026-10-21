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
        let readSets = readSets(at: instancePath)
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

    static func rawItems(at instancePath: String) throws -> [NotificationItem] {
        try workflowItems(at: instancePath) + nodeRunItems(at: instancePath)
    }

    static func readSets(at instancePath: String) -> [String: Set<String>] {
        [
            "workflow": (try? LogManager.fetchReadNotificationRefs(kind: "workflow", at: instancePath)) ?? [],
            "node_run": (try? LogManager.fetchReadNotificationRefs(kind: "node_run", at: instancePath)) ?? [],
            "session_run": (try? LogManager.fetchReadNotificationRefs(kind: "session_run", at: instancePath)) ?? []
        ]
    }

    static func marked(
        _ item: NotificationItem, readSets: [String: Set<String>]
    ) -> NotificationItem {
        NotificationItem(
            kind: item.kind, refId: item.refId, workflowId: item.workflowId,
            nodeId: item.nodeId, prompt: item.prompt, success: item.success,
            took: item.took, endedAt: item.endedAt,
            read: readSets[item.kind]?.contains(item.refId) ?? false
        )
    }

    static func workflowItems(at instancePath: String) throws -> [NotificationItem] {
        try LogManager.fetchRunEnds(since: 0, at: instancePath).map { end in
            NotificationItem(
                kind: "workflow", refId: end.session, workflowId: end.workflowId,
                nodeId: nil, prompt: ask(forSession: end.session, at: instancePath),
                success: end.success, took: end.took, endedAt: end.endedAt, read: false
            )
        }
    }

    static func ask(forSession session: String, at instancePath: String) -> String? {
        (try? LogManager.fetchFirstAsk(session: session, at: instancePath)).flatMap { $0 }
    }

    static func nodeRunItems(at instancePath: String) throws -> [NotificationItem] {
        guard let logs = try? GraphStore.fetchTerminalRunLogs(since: 0, at: instancePath) else { return [] }
        guard logs.notEmpty else { return [] }
        // Kind lives with the notification, not the run log: session-anchored
        // rows (workflow follow-ups) carry a persisted marker written at
        // insert time; marker-less rows are node runs.
        guard let markers = try? LogManager.fetchNotificationKinds(at: instancePath) else {
            assertionFailure("notification_kinds must exist — list() created it via LogManager.createTables")
            return []
        }
        return logs.map { log in
            let marker = markers[log.id]
            return NotificationItem(
                kind: marker?.kind ?? "node_run", refId: log.id,
                workflowId: marker?.workflowId,
                nodeId: log.nodeId, prompt: log.prompt,
                success: log.status == "success", took: log.took,
                endedAt: log.completedAt ?? log.createdAt, read: false
            )
        }
    }
}
