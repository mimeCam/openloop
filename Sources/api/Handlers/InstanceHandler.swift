import Vapor
import Foundation
import shared
#if canImport(Glibc)
import Glibc
#endif

struct InstanceHandler: Sendable {

    func getAll(req: Request) async throws -> InstanceListResponse {
        let workerPaths = try await Launcher.listWorkers()

        // Fetch all manual workflows once (RAM-only, cheap)
        let allManual = await ManualWorkflowRegistry.shared.getAll()

        var instances: [InstanceInfo] = []
        for path in workerPaths {
            let state = try? await FileLoader.loadInstanceState(at: path)
            var stateInfo: InstanceStateInfo? = nil

            if let s = state {
                let date = Date(timeIntervalSinceReferenceDate: s.lastLoopAt)
                let unixMs = Int64(date.timeIntervalSince1970 * 1000)
                stateInfo = InstanceStateInfo(
                    lastLoopAtUnixMs: unixMs,
                    activeRunningWorkflows: s.activeRunningWorkflows,
                    inactiveWorkflows: s.inactiveWorkflows
                )
            }

            let instanceManual = allManual.filter { $0.instancePath == path }
            let manualActive = instanceManual.filter { $0.status == "running" }.count
            let manualCompleted = instanceManual.filter { $0.status == "completed" || $0.status == "failed" }.count

            let svcStatus = computeServiceStatus(
                workingDirectory: path, state: state
            )
            let runningRuns = GraphStore.countRunningRunLogs(at: path)
            let dbSize = LogManager.dbFilesSize(at: path)

            instances.append(InstanceInfo(
                path: path,
                parentPath: nil,
                state: stateInfo,
                manualActive: manualActive,
                manualCompleted: manualCompleted,
                unreadNotifications: Notifications.unreadCount(at: path),
                configEnabled: svcStatus.configEnabled,
                processRunning: svcStatus.processRunning,
                graphMcpAuthMissing: GraphStore.mcpAuthMissingCount(at: path),
                runningGraphRuns: runningRuns.node,
                runningSessionRuns: runningRuns.session,
                dbSizeBytes: dbSize,
                needsClean: dbSize >= LogManager.cleanThresholdBytes
            ))
        }

        // Synthetic instance for user-global shared personas/workflows
        let globalDbSize = LogManager.dbFilesSize(at: Paths.globalOpenloop.string)
        instances.append(InstanceInfo(
            path: Paths.globalOpenloop.string,
            parentPath: nil,
            state: nil,
            manualActive: 0,
            manualCompleted: 0,
            isGlobalShare: true,
            dbSizeBytes: globalDbSize,
            needsClean: globalDbSize >= LogManager.cleanThresholdBytes
        ))

        let parentPaths = computeParentPaths(
            instances.map { $0.path }
        )
        assert(parentPaths.count == instances.count, "computeParentPaths returns one parent per instance")
        for i in instances.indices {
            instances[i].parentPath = parentPaths[i]
        }

        return InstanceListResponse(instances: instances)
    }

    func launch(req: Request) async throws -> Response {
        let id = try extractValidatedId(req: req)
        try await Launcher.launchWorker(workingDirectory: id)
        return Response(status: .ok)
    }

    func unload(req: Request) async throws -> Response {
        let id = try extractValidatedId(req: req)
        try await Launcher.stopWorker(workingDirectory: id)
        return Response(status: .ok)
    }

    func disable(req: Request) async throws -> Response {
        let id = try extractValidatedId(req: req)
        try await Launcher.disableWorker(workingDirectory: id)
        return Response(status: .ok)
    }

    func stop(req: Request) async throws -> Response {
        let id = try extractValidatedId(req: req)
        let state = try await FileLoader.loadInstanceState(at: id)
        guard let state else { throw Abort(.conflict) }
        try verifyAndKillProcess(pid: state.pid)
        return Response(status: .ok)
    }

    func delete(req: Request) async throws -> Response {
        let id = try extractValidatedId(req: req)
        try await Launcher.deleteWorker(workingDirectory: id)
        return Response(status: .ok)
    }

    func clean(req: Request) async throws -> CleanResponse {
        let id = try extractValidatedId(req: req)
        let outcome = try LogManager.cleanOldLogs(at: id)
        return CleanResponse(
            dbSizeBytes: outcome.sizeAfter,
            vacuumed: outcome.vacuumed,
            bytesReclaimed: outcome.bytesReclaimed
        )
    }

    private func extractValidatedId(req: Request) throws -> String {
        let id = try req.routeParam("id")
        guard PathIO.isDirectoryExistent(atPath: id) else {
            throw Abort(.notFound, headers: [:])
        }
        guard id.md5 != nil else {
            throw Abort(.badRequest, headers: [:])
        }
        return id
    }

    private func verifyAndKillProcess(pid: Int) throws {
        let p = pid_t(pid)
        guard kill(p, 0) == 0 else { throw Abort(.gone) }
        kill(p, SIGTERM)
    }
}

// MARK: - instance-list derivations (file-local)

private struct ServiceStatus: Sendable {
    var configEnabled: Bool
    var processRunning: Bool
}

private let workerHeartbeatStaleSeconds = 120.0

private func computeServiceStatus(
    workingDirectory: String,
    state: InstanceState?
) -> ServiceStatus {
    let enabled = Launcher.isWorkerEnabled(workingDirectory: workingDirectory)
    let running: Bool
    if let s = state {
        let age = Date().timeIntervalSinceReferenceDate - s.lastLoopAt
        running = age < workerHeartbeatStaleSeconds
    } else {
        running = false
    }
    return ServiceStatus(configEnabled: enabled, processRunning: running)
}

// O(n²) on instance count — fine for typical n < 20
private func computeParentPaths(_ paths: [String]) -> [String?] {
    let sorted = paths.sorted { $0.count < $1.count }
    return paths.map { path in findParent(for: path, among: sorted) }
}

private func findParent(for path: String, among candidates: [String]) -> String? {
    candidates
        .filter { isStrictParentPath($0, of: path) }
        .max(by: { $0.count < $1.count })
}

private func isStrictParentPath(_ candidate: String, of path: String) -> Bool {
    guard path.hasPrefix(candidate), candidate != path else { return false }
    let idx = candidate.endIndex
    return candidate.last == "/" || path[idx] == "/"
}

extension InstanceHandler {
    struct InstanceInfo: Content, Sendable {
        var path: String
        var parentPath: String?
        var state: InstanceStateInfo?
        var manualActive: Int
        var manualCompleted: Int
        var unreadNotifications: Int = 0
        var isGlobalShare: Bool = false
        var configEnabled: Bool?
        var processRunning: Bool?
        /// Graph nodes whose MCP was configured with a key this machine's
        /// secrets store doesn't hold — the home page badges the cell so the
        /// user opens the graph knowing a key is due (0 = nothing to say).
        var graphMcpAuthMissing: Int = 0
        var runningGraphRuns: Int = 0
        var runningSessionRuns: Int = 0
        var dbSizeBytes: Int64 = 0
        var needsClean: Bool = false
    }

    struct CleanResponse: Content, Sendable {
        var dbSizeBytes: Int64
        var vacuumed: Bool
        var bytesReclaimed: Int64
    }

    struct InstanceListResponse: Content, Sendable {
        var instances: [InstanceInfo]
    }

    struct InstanceStateInfo: Content, Sendable {
        var lastLoopAtUnixMs: Int64
        var activeRunningWorkflows: Int
        var inactiveWorkflows: Int
    }
}
