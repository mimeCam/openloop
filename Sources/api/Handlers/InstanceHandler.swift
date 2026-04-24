import Vapor
import Foundation
import shared
#if canImport(Glibc)
import Glibc
#endif

private let log = PrintLog(module: "instance-handler")

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

            let svcStatus = InstanceHandler.computeServiceStatus(
                workingDirectory: path, state: state
            )

            instances.append(InstanceInfo(
                path: path,
                parentPath: nil,
                state: stateInfo,
                manualActive: manualActive,
                manualCompleted: manualCompleted,
                configEnabled: svcStatus.configEnabled,
                processRunning: svcStatus.processRunning
            ))
        }

        // Synthetic instance for user-global shared personas/workflows
        let globalSharePath = Paths.globalShare.string
        instances.append(InstanceInfo(
            path: globalSharePath,
            parentPath: nil,
            state: nil,
            manualActive: 0,
            manualCompleted: 0,
            isGlobalShare: true
        ))

        let parentPaths = InstanceHandler.computeParentPaths(
            instances.map { $0.path }
        )
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

    private func extractValidatedId(req: Request) throws -> String {
        guard let rawId = req.parameters.get("id") else {
            throw Abort(.badRequest, headers: [:])
        }
        let id = rawId.removingPercentEncoding ?? rawId
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

    struct ServiceStatus: Content, Sendable {
        var configEnabled: Bool
        var processRunning: Bool
    }

    static func computeServiceStatus(
        workingDirectory: String,
        state: InstanceState?
    ) -> ServiceStatus {
        let enabled = Launcher.isWorkerEnabled(workingDirectory: workingDirectory)
        let running: Bool
        if let s = state {
            let age = Date().timeIntervalSinceReferenceDate - s.lastLoopAt
            running = age < 120
        } else {
            running = false
        }
        return ServiceStatus(configEnabled: enabled, processRunning: running)
    }
}

extension InstanceHandler {
    struct InstanceInfo: Content, Sendable {
        var path: String
        var parentPath: String?
        var state: InstanceStateInfo?
        var manualActive: Int
        var manualCompleted: Int
        var isGlobalShare: Bool = false
        var configEnabled: Bool?
        var processRunning: Bool?
    }

    struct InstanceListResponse: Content, Sendable {
        var instances: [InstanceInfo]
    }

    struct InstanceResponse: Content, Sendable {
        var path: String
    }

    struct InstanceStateInfo: Content, Sendable {
        var lastLoopAtUnixMs: Int64
        var activeRunningWorkflows: Int
        var inactiveWorkflows: Int
    }

    // O(n²) on instance count — fine for typical n < 20
    static func computeParentPaths(_ paths: [String]) -> [String?] {
        let sorted = paths.sorted { $0.count < $1.count }
        return paths.map { path in findParent(for: path, among: sorted) }
    }

    static func findParent(for path: String, among candidates: [String]) -> String? {
        candidates
            .filter { isStrictParentPath($0, of: path) }
            .max(by: { $0.count < $1.count })
    }

    static func isStrictParentPath(_ candidate: String, of path: String) -> Bool {
        guard path.hasPrefix(candidate), candidate != path else { return false }
        let idx = candidate.endIndex
        return candidate.last == "/" || path[idx] == "/"
    }
}
