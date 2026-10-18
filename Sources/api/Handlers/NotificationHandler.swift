import Vapor
import Foundation
import shared
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

// Per-instance: everything derives from the instance's own logs.db.
// Read state changes ONLY through the two POSTs below — opening a deep link
// never marks read.
struct NotificationHandler: Sendable {

    func list(req: Request) async throws -> NotificationsResponse {
        let instancePath = try rawInstancePath(req)
        let limit = min(req.query[Int.self, at: "limit"] ?? 100, 500)
        let items = (try? Notifications.list(limit: limit, at: instancePath)) ?? []
        return NotificationsResponse(
            items: await items.mapAsync { await toContent($0, at: instancePath) },
            unread_count: items.filter { !$0.read }.count
        )
    }

    func markRead(req: Request) async throws -> Response {
        let instancePath = try rawInstancePath(req)
        guard let kind = req.parameters.get("kind"),
              let ref = req.parameters.get("ref"),
              ["workflow", "node_run", "session_run"].contains(kind) else {
            throw Abort(.badRequest)
        }
        try Notifications.markRead(kind: kind, refId: ref, at: instancePath)
        return Response(status: .ok)
    }

    func markAllRead(req: Request) async throws -> Response {
        try Notifications.markAllRead(at: try rawInstancePath(req))
        return Response(status: .ok)
    }

    func rawInstancePath(_ req: Request) throws -> String {
        guard let raw = req.parameters.get("id") else { throw Abort(.badRequest) }
        return raw.removingPercentEncoding ?? raw
    }

    func toContent(_ n: NotificationItem, at instancePath: String) async -> NotificationContent {
        NotificationContent(
            id: n.refId,
            kind: n.kind,
            instance_path: instancePath,
            // The session the deep link targets: the run session itself
            // (workflow kind) or the workflow session a follow-up turn
            // belongs to (session_run rows anchor node_id on it).
            session: sessionRef(of: n),
            workflow_id: n.workflowId,
            node_id: n.nodeId,
            title: await title(of: n, at: instancePath),
            prompt: n.prompt,
            success: n.success,
            took: n.took,
            ended_at: unixMs(n.endedAt),
            read: n.read
        )
    }

    func sessionRef(of n: NotificationItem) -> String? {
        switch n.kind {
        case "workflow": return n.refId
        case "session_run": return n.nodeId
        default: return nil
        }
    }

    func title(of n: NotificationItem, at instancePath: String) async -> String {
        if n.kind == "node_run" {
            return nodeAgent(n.nodeId, at: instancePath) ?? "node"
        }
        // workflow and session_run are both titled by their workflow name.
        return await workflowName(n.workflowId, at: instancePath) ?? n.workflowId ?? "workflow"
    }

    func nodeAgent(_ nodeId: String?, at instancePath: String) -> String? {
        guard let nodeId else { return nil }
        let nodes = (try? GraphStore.fetchNodes(at: instancePath)) ?? []
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

extension Sequence {
    func mapAsync<T>(
        _ transform: (Element) async -> T
    ) async -> [T] {
        var out: [T] = []
        for element in self { out.append(await transform(element)) }
        return out
    }
}
