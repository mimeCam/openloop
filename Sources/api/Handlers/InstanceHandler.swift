import Vapor
import Foundation
import shared
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
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

            // A worker registered AT the share IS the global instance — it
            // carries the flag (other projects' home-page views render it as
            // the "Global (system-wide)" section; its own cell renders like
            // any other project) instead of the dropped synthetic row.
            let isGlobalShare = FilePath(path) == Paths.globalShareRoot

            instances.append(InstanceInfo(
                path: path,
                parentPath: nil,
                state: stateInfo,
                manualActive: manualActive,
                manualCompleted: manualCompleted,
                unreadNotifications: Notifications.unreadCount(at: path),
                isGlobalShare: isGlobalShare,
                configEnabled: svcStatus.configEnabled,
                processRunning: svcStatus.processRunning,
                graphMcpAuthMissing: GraphStore.mcpAuthMissingCount(at: path),
                runningGraphRuns: runningRuns.node,
                runningSessionRuns: runningRuns.session,
                dbSizeBytes: dbSize,
                needsClean: dbSize >= LogManager.cleanThresholdBytes
            ))
        }

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

    /// The home page's create cell (shown when no worker sits at the share):
    /// makes the machine-wide share a real project. The api only creates the
    /// empty share folder (service configs refuse a missing working
    /// directory) and registers + starts the worker — the `openloop` binary
    /// the service manager starts, exactly like the launch route's Start
    /// button, does the provisioning itself: the `.openloop` skeleton, then
    /// the worker loop. Nothing else ever manufactures the share.
    func createGlobalShare(req: Request) async throws -> Response {
        let workers = try await Launcher.listWorkers()
        let alreadyRegistered = workers.contains { FilePath($0) == Paths.globalShareRoot }
        guard !alreadyRegistered else {
            throw Abort(.conflict, reason: "Global share worker is already registered")
        }

        // A pre-rename leftover makes the worker exit at boot with migration
        // steps nobody would ever see (its stderr log cannot even exist yet)
        // — surface it here instead.
        let legacy = Paths.globalShareRoot.appending(Paths.legacyDataFolderName)
        let modern = Paths.globalShareRoot.appending(Paths.dataFolderName)
        if PathIO.isDirectoryExistent(atPath: legacy.string),
           !PathIO.isDirectoryExistent(atPath: modern.string) {
            throw Abort(.conflict, reason: "Legacy \(legacy.string) exists — rename it to \(modern.string) first, then create again")
        }

        let binary = Paths.bin.appending("openloop")
        guard PathIO.isFileExistent(atPath: binary.string) else {
            throw Abort(.internalServerError, reason: "openloop binary not found at \(binary.string)")
        }

        guard PathIO.createDirectoryIfNotExists(atPath: Paths.globalShareRoot.string) else {
            throw Abort(.internalServerError, reason: "Could not create \(Paths.globalShareRoot.string)")
        }

        try await Launcher.registerWorker(
            workingDirectory: Paths.globalShareRoot,
            binaryPath: binary
        )
        try await Launcher.launchWorker(workingDirectory: Paths.globalShareRoot.string)
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
