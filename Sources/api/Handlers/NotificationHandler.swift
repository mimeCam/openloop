import Vapor
import Foundation
import shared
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

private let defaultNotificationLimit = 100
private let maxNotificationLimit = 500

private enum NotificationKind: String {
    case workflow
    case nodeRun = "node_run"
    case sessionRun = "session_run"
}

// Per-instance: everything derives from the instance's own logs.db.
// Read state changes ONLY through the two POSTs below — opening a deep link
// never marks read.
struct NotificationHandler: Sendable {

    func list(req: Request) async throws -> NotificationsResponse {
        let instancePath = try req.routeParam("id")
        let limit = min(req.query[Int.self, at: "limit"] ?? defaultNotificationLimit, maxNotificationLimit)
        let items = try Notifications.list(limit: limit, at: instancePath)
        return NotificationsResponse(
            items: try await contents(for: items, at: instancePath),
            unread_count: items.filter { !$0.read }.count
        )
    }

    func markRead(req: Request) async throws -> Response {
        let instancePath = try req.routeParam("id")
        guard let kind = req.parameters.get("kind"),
              NotificationKind(rawValue: kind) != nil,
              let ref = req.parameters.get("ref") else {
            throw Abort(.badRequest)
        }
        try Notifications.markRead(kind: kind, refId: ref, at: instancePath)
        return Response(status: .ok)
    }

    func markAllRead(req: Request) async throws -> Response {
        try Notifications.markAllRead(at: try req.routeParam("id"))
        return Response(status: .ok)
    }

}

private extension NotificationHandler {

    func contents(
        for items: [NotificationItem], at instancePath: String
    ) async throws -> [NotificationContent] {
        var out: [NotificationContent] = []
        for item in items { out.append(try await toContent(item, at: instancePath)) }
        return out
    }

    func toContent(_ n: NotificationItem, at instancePath: String) async throws -> NotificationContent {
        NotificationContent(
            id: n.refId,
            kind: n.kind,
            instance_path: instancePath,
            session: sessionRef(of: n),
            workflow_id: n.workflowId,
            node_id: n.nodeId,
            title: try await title(of: n, at: instancePath),
            prompt: n.prompt,
            success: n.success,
            took: n.took,
            ended_at: unixMs(n.endedAt),
            read: n.read
        )
    }

    // The session the deep link targets: the run session itself (workflow
    // kind) or the workflow session a follow-up turn belongs to (session_run
    // rows anchor node_id on it). Foreign kinds deep-link nowhere.
    func sessionRef(of n: NotificationItem) -> String? {
        guard let kind = NotificationKind(rawValue: n.kind) else { return nil }
        switch kind {
        case .workflow: return n.refId
        case .sessionRun: return n.nodeId
        case .nodeRun: return nil
        }
    }

    func title(of n: NotificationItem, at instancePath: String) async throws -> String {
        guard let kind = NotificationKind(rawValue: n.kind) else { return "notification" }
        switch kind {
        case .nodeRun:
            return try nodeAgent(n.nodeId, at: instancePath) ?? "node"
        case .workflow, .sessionRun:
            return await workflowName(n.workflowId, at: instancePath) ?? n.workflowId ?? "workflow"
        }
    }

    func nodeAgent(_ nodeId: String?, at instancePath: String) throws -> String? {
        guard let nodeId else { return nil }
        let nodes = try GraphStore.fetchNodes(at: instancePath)
        return nodes.first { $0.id == nodeId }?.agent
    }

    func workflowName(_ id: String?, at instancePath: String) async -> String? {
        guard let id else { return nil }
        let fp = FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("workflows")
            .appending("\(id).\(json)")
        guard PathIO.isFileExistent(atPath: fp.string) else { return nil }
        return (try? await FileLoader.loadWorkflowAtPath(fp))?.name
    }

    func unixMs(_ refInterval: Double) -> Int64 {
        Int64(Date(timeIntervalSinceReferenceDate: refInterval).timeIntervalSince1970 * 1000)
    }
}

extension NotificationHandler {
    struct NotificationContent: Content, Sendable {
        var id: String
        var kind: String
        var instance_path: String
        var session: String?
        var workflow_id: String?
        var node_id: String?
        var title: String
        var prompt: String?
        var success: Bool
        var took: Int?
        var ended_at: Int64
        var read: Bool
    }

    struct NotificationsResponse: Content, Sendable {
        var items: [NotificationContent]
        var unread_count: Int
    }
}
