import Vapor
import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import shared

struct WorkflowHandler: Sendable {

    func getAll(req: Request) async throws -> WorkflowListResponse {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath

        let workflowsPath = Paths.objectsRoot(forInstance: instancePath)
            .appending("workflows")

        guard PathIO.isDirectoryExistent(atPath: workflowsPath.string) else {
            return WorkflowListResponse(instance_id: instancePath, workflows: [])
        }

        var workflows: [WorkflowInfo] = []

        let files = try PathIO.contentsOfDirectory(atPath: workflowsPath.string)
        let json5Files = files.filter { $0.hasSuffix(".\(json)") }

        for fileName in json5Files {
            let workflowId = String(fileName.dropLast(".\(json)".count))
            let filePath = workflowsPath.appending(fileName)

            if let workflow = try? await FileLoader.loadWorkflowAtPath(filePath) {
                workflows.append(WorkflowInfo(
                    id: workflowId,
                    name: workflow.name,
                    desc: workflow.desc,
                    ask: workflow.ask
                ))
            }
        }

        return WorkflowListResponse(instance_id: instancePath, workflows: workflows)
    }

    func getOne(req: Request) async throws -> WorkflowResponse {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawWorkflowId = req.parameters.get("wid") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let workflowId = rawWorkflowId.removingPercentEncoding ?? rawWorkflowId

        let filePath = Paths.objectsRoot(forInstance: instancePath)
            .appending("workflows")
            .appending("\(workflowId).\(json)")

        guard PathIO.isFileExistent(atPath: filePath.string),
              let workflow = try? await FileLoader.loadWorkflowAtPath(filePath) else {
            throw Abort(.notFound)
        }

        return WorkflowResponse(
            instance_id: instancePath,
            workflow_id: workflowId,
            name: workflow.name,
            desc: workflow.desc,
            every_secs: workflow.everySecs,
            agent: workflow.agent,
            ask: workflow.ask,
            levels: workflow.levels
        )
    }

    func update(req: Request) async throws -> WorkflowResponse {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawWorkflowId = req.parameters.get("wid") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let workflowId = rawWorkflowId.removingPercentEncoding ?? rawWorkflowId

        let updateRequest = try req.content.decode(WorkflowUpdateRequest.self)

        let filePath = Paths.objectsRoot(forInstance: instancePath)
            .appending("workflows")
            .appending("\(workflowId).\(json)")

        guard PathIO.isFileExistent(atPath: filePath.string),
              let existingWorkflow = try? await FileLoader.loadWorkflowAtPath(filePath) else {
            throw Abort(.notFound)
        }

        let updatedWorkflow = Workflow(
            name: updateRequest.name ?? existingWorkflow.name,
            desc: updateRequest.desc ?? existingWorkflow.desc,
            everySecs: updateRequest.every_secs ?? existingWorkflow.everySecs,
            agent: updateRequest.agent ?? existingWorkflow.agent,
            ask: updateRequest.ask ?? existingWorkflow.ask,
            levels: updateRequest.levels ?? existingWorkflow.levels
        )

        try await FileLoader.saveWorkflow(updatedWorkflow, at: filePath)

        return WorkflowResponse(
            instance_id: instancePath,
            workflow_id: workflowId,
            name: updatedWorkflow.name,
            desc: updatedWorkflow.desc,
            every_secs: updatedWorkflow.everySecs,
            agent: updatedWorkflow.agent,
            ask: updatedWorkflow.ask,
            levels: updatedWorkflow.levels
        )
    }

    func create(req: Request) async throws -> WorkflowResponse {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath

        let createRequest = try req.content.decode(WorkflowCreateRequest.self)
        
        if let id = createRequest.id {
            let validId = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
            guard id.unicodeScalars.allSatisfy({ validId.contains($0) }) else {
                throw Abort(.badRequest, reason: "ID can only contain letters, digits, underscores and hyphens")
            }
        }
        
        let workflowId = createRequest.id ?? UUID().uuidString

        let filePath = Paths.objectsRoot(forInstance: instancePath)
            .appending("workflows")
            .appending("\(workflowId).\(json)")

        let workflowsDir = filePath.removingLastComponent()
        _ = PathIO.createDirectoryIfNotExists(atPath: workflowsDir.string)

        let workflow = Workflow(
            name: createRequest.name ?? "New Workflow",
            desc: createRequest.desc ?? "",
            everySecs: createRequest.every_secs ?? 0,
            agent: createRequest.agent ?? "",
            ask: createRequest.ask ?? "",
            levels: createRequest.levels ?? [[]]
        )

        try await FileLoader.saveWorkflow(workflow, at: filePath)

        return WorkflowResponse(
            instance_id: instancePath,
            workflow_id: workflowId,
            name: workflow.name,
            desc: workflow.desc,
            every_secs: workflow.everySecs,
            agent: workflow.agent,
            ask: workflow.ask,
            levels: workflow.levels
        )
    }

    func delete(req: Request) async throws -> HTTPStatus {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawWorkflowId = req.parameters.get("wid") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let workflowId = rawWorkflowId.removingPercentEncoding ?? rawWorkflowId

        let filePath = Paths.objectsRoot(forInstance: instancePath)
            .appending("workflows")
            .appending("\(workflowId).\(json)")

        guard PathIO.isFileExistent(atPath: filePath.string) else {
            throw Abort(.notFound)
        }

        try FileManager.default.removeItem(atPath: filePath.string)
        return .noContent
    }
}

extension WorkflowHandler {
    struct WorkflowInfo: Content, Sendable {
        var id: String
        var name: String
        var desc: String
        var ask: String
    }

    struct WorkflowListResponse: Content, Sendable {
        var instance_id: String
        var workflows: [WorkflowInfo]
    }

    struct WorkflowResponse: Content, Sendable {
        var instance_id: String
        var workflow_id: String
        var name: String
        var desc: String
        var every_secs: Int
        var agent: String
        var ask: String
        var levels: [[String]]
    }

    struct WorkflowUpdateRequest: Content, Sendable {
        var name: String?
        var desc: String?
        var levels: [[String]]?
        var every_secs: Int?
        var agent: String?
        var ask: String?
    }

    struct WorkflowCreateRequest: Content, Sendable {
        var id: String?
        var name: String?
        var desc: String?
        var every_secs: Int?
        var agent: String?
        var ask: String?
        var levels: [[String]]?
    }
}
