import Vapor
import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import shared
import Subprocess

// Actor to manage state for manually launched workflows
actor ManualWorkflowRegistry {
    static let shared = ManualWorkflowRegistry()

    private var activeWorkflows: [String: ManualWorkflowInfo] = [:]

    func add(_ workflow: ManualWorkflowInfo) {
        activeWorkflows[workflow.id] = workflow
    }

    func remove(id: String) {
        activeWorkflows.removeValue(forKey: id)
    }

    func getAll() -> [ManualWorkflowInfo] {
        Array(activeWorkflows.values)
    }

    func get(id: String) -> ManualWorkflowInfo? {
        activeWorkflows[id]
    }

    func updateStatus(id: String, status: String, output: String?) {
        if var workflow = activeWorkflows[id] {
            workflow.status = status
            if let output = output {
                workflow.output = output
            }
            activeWorkflows[id] = workflow
        }
    }

    /// Remove completed/failed workflows older than the given interval.
    /// Prevents stale "done" counts from accumulating indefinitely (RAM-only state).
    func sweepCompletedOlderThan(_ interval: TimeInterval = 3600) {
        let cutoff = Date().addingTimeInterval(-interval)
        activeWorkflows = activeWorkflows.filter { _, info in
            info.status == "running" || info.startedAt > cutoff
        }
    }
}

struct ManualWorkflowInfo: Sendable, Content {
    var id: String
    var instancePath: String
    var workflowId: String
    var ask: String
    var startedAt: Date
    var status: String  // "running", "completed", "failed"
    var output: String?
}

struct ManualWorkflowHandler: Sendable {

    func validate(req: Request) async throws -> Response {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }
        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        try throwIfGlobalShare(instancePath)
        let body = try req.content.decode(ManualWorkflowLaunchRequest.self)

        let roots = Paths.dirsToHome(from: FilePath(instancePath))
        let errors = await WorkflowValidator.validate(
            workflowId: body.workflow_id,
            ask: body.ask,
            roots: roots
        )

        let result = ManualWorkflowValidationResponse(
            valid: errors.isEmpty,
            errors: errors.map(\.description)
        )
        let response = Response(status: errors.isEmpty ? .ok : .unprocessableEntity)
        try response.content.encode(result)
        return response
    }

    func launch(req: Request) async throws -> ManualWorkflowResponse {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        try throwIfGlobalShare(instancePath)
        let launchRequest = try req.content.decode(ManualWorkflowLaunchRequest.self)

        // Validate workflow exists
        let workflowId = launchRequest.workflow_id
        let filePath = resolveWorkflowFile(
            id: workflowId, instancePath: instancePath
        )

        guard let filePath,
              let workflow = try? await FileLoader.loadWorkflowAtPath(filePath) else {
            throw Abort(.notFound, reason: "Workflow not found: \(workflowId)")
        }

        // Generate unique run ID
        let runId = UUID().uuidString

        // Create workflow info
        let workflowInfo = ManualWorkflowInfo(
            id: runId,
            instancePath: instancePath,
            workflowId: workflowId,
            ask: launchRequest.ask ?? workflow.ask,
            startedAt: Date(),
            status: "running",
            output: nil
        )

        // Register the workflow
        await ManualWorkflowRegistry.shared.add(workflowInfo)

        // Launch in detached task
        Task.detached {
            do {
                let output = try await runManualWorkflow(
                    instancePath: instancePath,
                    workflowId: workflowId,
                    ask: launchRequest.ask ?? workflow.ask
                )

                await ManualWorkflowRegistry.shared.updateStatus(
                    id: runId,
                    status: "completed",
                    output: output
                )
            } catch {
                await ManualWorkflowRegistry.shared.updateStatus(
                    id: runId,
                    status: "failed",
                    output: "Error: \(error.descriptiveMessage)"
                )
            }
        }

        return ManualWorkflowResponse(
            id: runId,
            workflow_id: workflowId,
            ask: workflowInfo.ask,
            started_at: workflowInfo.startedAt,
            status: "running",
            output: nil
        )
    }

    func getAll(req: Request) async throws -> ManualWorkflowListResponse {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }
        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath

        let allWorkflows = await ManualWorkflowRegistry.shared.getAll()
        let workflows = allWorkflows.filter { $0.instancePath == instancePath }

        return ManualWorkflowListResponse(
            workflows: workflows.map { info in
                ManualWorkflowResponse(
                    id: info.id,
                    workflow_id: info.workflowId,
                    ask: info.ask,
                    started_at: info.startedAt,
                    status: info.status,
                    output: info.output
                )
            }
        )
    }

    func getOne(req: Request) async throws -> ManualWorkflowResponse {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }
        guard let rawId = req.parameters.get("runid") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath

        guard let info = await ManualWorkflowRegistry.shared.get(id: rawId),
              info.instancePath == instancePath else {
            throw Abort(.notFound)
        }

        return ManualWorkflowResponse(
            id: info.id,
            workflow_id: info.workflowId,
            ask: info.ask,
            started_at: info.startedAt,
            status: info.status,
            output: info.output
        )
    }

    func delete(req: Request) async throws -> HTTPStatus {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }
        guard let rawId = req.parameters.get("runid") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath

        guard let info = await ManualWorkflowRegistry.shared.get(id: rawId),
              info.instancePath == instancePath else {
            throw Abort(.notFound)
        }

        await ManualWorkflowRegistry.shared.remove(id: rawId)
        return .noContent
    }
}

private struct ManualRunError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

private extension Error {
    // `localizedDescription` on bridged errors is useless text like "(ArgumentParser.ValidationError error 1.)" — prefer the error's own description.
    var descriptiveMessage: String {
        (self as CustomStringConvertible).description
    }
}

// The global share is a shared library, never a run target — runs execute in the launching project's `.openloop`.
private func throwIfGlobalShare(_ instancePath: String) throws {
    assert(instancePath.notEmpty)
    guard FilePath(instancePath) != Paths.globalOpenloop else {
        throw Abort(
            .conflict,
            reason: "Global share is a shared library, not a run target — launch the workflow from a project instance so it runs and logs in that project"
        )
    }
}

// Same ladder as WorkflowValidator/loadWorkflowById: project-local `.openloop` folders nearest-first, then the user-global root.
private func resolveWorkflowFile(id: String, instancePath: String) -> FilePath? {
    assert(id.notEmpty)
    assert(instancePath.notEmpty)
    let fileName = "\(id).\(json)"
    for root in Paths.dirsToHome(from: FilePath(instancePath)) {
        let fp = root
            .appending(Paths.dataFolderName)
            .appending("workflows")
            .appending(fileName)
        if PathIO.isFileExistent(atPath: fp.string) {
            return fp
        }
    }
    let gfp = Paths.globalOpenloop.appending("workflows").appending(fileName)
    return PathIO.isFileExistent(atPath: gfp.string) ? gfp : nil
}

private func runManualWorkflow(
    instancePath: String,
    workflowId: String,
    ask: String
) async throws -> String {
    assert(instancePath.notEmpty)
    assert(workflowId.notEmpty)

    let runnerPath = Paths.bin.appending("openloop-runner")

    guard PathIO.isFileExistent(atPath: runnerPath.string) else {
        throw Abort(.internalServerError, reason: "Runner not found at \(runnerPath.string)")
    }

    let args = [workflowId, ask]

    // A dead runner must read as failed, not completed — `exec` returns stdout even on non-zero exit.
    let res = try await execDetailed(
        runnerPath.string,
        args: args, chroot: instancePath
    )

    guard res.success else {
        let detail = res.combinedOutput
        throw ManualRunError(
            message:
                "Runner exited with code \(res.exitCode)" +
                (detail.notEmpty ? ":\n\(detail)" : ".")
        )
    }

    guard let output = res.stdout, output.notEmpty else {
        throw ManualRunError(message: "Runner finished without output.")
    }

    return output
}

extension ManualWorkflowHandler {
    struct ManualWorkflowResponse: Content, Sendable {
        var id: String
        var workflow_id: String
        var ask: String
        var started_at: Date
        var status: String
        var output: String?
    }

    struct ManualWorkflowListResponse: Content, Sendable {
        var workflows: [ManualWorkflowResponse]
    }

    struct ManualWorkflowLaunchRequest: Content, Sendable {
        var workflow_id: String
        var ask: String?
    }

    struct ManualWorkflowValidationResponse: Content, Sendable {
        var valid: Bool
        var errors: [String]
    }
}
