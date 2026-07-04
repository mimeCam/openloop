import Vapor
import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import shared

struct KnowledgeHandler: Sendable {

    private func knowledgeDir(instancePath: String, personaId: String) -> FilePath {
        FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("knowledge")
            .appending(personaId)
    }

    private func validatePath(_ path: String) throws {
        guard !path.contains("../") else {
            throw Abort(.forbidden, reason: "Path traversal not allowed")
        }
        guard !path.contains("/..") else {
            throw Abort(.forbidden, reason: "Path traversal not allowed")
        }
    }

    func listFiles(req: Request) async throws -> KnowledgeFileListResponse {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawPersonaId = req.parameters.get("pid") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let personaId = rawPersonaId.removingPercentEncoding ?? rawPersonaId

        let dir = knowledgeDir(instancePath: instancePath, personaId: personaId)

        guard PathIO.isDirectoryExistent(atPath: dir.string) else {
            return KnowledgeFileListResponse(files: [])
        }

        let allItems = (try? PathIO.contentsOfDirectory(atPath: dir.string)) ?? []
        let files = allItems.filter { name in
            let fp = dir.appending(name)
            return PathIO.isFileExistent(atPath: fp.string)
        }

        return KnowledgeFileListResponse(files: files)
    }

    func readFile(req: Request) async throws -> Response {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawPersonaId = req.parameters.get("pid") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let personaId = rawPersonaId.removingPercentEncoding ?? rawPersonaId

        let filePath = req.parameters.getCatchall().joined(separator: "/")
        guard !filePath.isEmpty else {
            throw Abort(.badRequest)
        }

        try validatePath(filePath)

        let fullPath = knowledgeDir(instancePath: instancePath, personaId: personaId)
            .appending(filePath)

        guard PathIO.isFileExistent(atPath: fullPath.string) else {
            throw Abort(.notFound)
        }

        guard let data = await File(fullPath.string).read() else {
            throw Abort(.internalServerError, reason: "Failed to read file")
        }

        let body = Response.Body(data: data)
        var headers = HTTPHeaders()
        headers.contentType = .plainText
        return Response(status: .ok, headers: headers, body: body)
    }

    func writeFile(req: Request) async throws -> HTTPStatus {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawPersonaId = req.parameters.get("pid") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let personaId = rawPersonaId.removingPercentEncoding ?? rawPersonaId

        let filePath = req.parameters.getCatchall().joined(separator: "/")
        guard !filePath.isEmpty else {
            throw Abort(.badRequest)
        }

        try validatePath(filePath)

        let dir = knowledgeDir(instancePath: instancePath, personaId: personaId)
        let fullPath = dir.appending(filePath)

        let parentDir = fullPath.removingLastComponent()
        _ = PathIO.createDirectoryIfNotExists(atPath: parentDir.string)

        let buffer = req.body.data
        let data = buffer.map { Data(buffer: $0) } ?? Data()

        guard await File(fullPath.string).write(data) else {
            throw Abort(.internalServerError, reason: "Failed to write file")
        }

        return .ok
    }

    func deleteFile(req: Request) async throws -> HTTPStatus {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawPersonaId = req.parameters.get("pid") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let personaId = rawPersonaId.removingPercentEncoding ?? rawPersonaId

        let filePath = req.parameters.getCatchall().joined(separator: "/")
        guard !filePath.isEmpty else {
            throw Abort(.badRequest)
        }

        try validatePath(filePath)

        let fullPath = knowledgeDir(instancePath: instancePath, personaId: personaId)
            .appending(filePath)

        guard PathIO.isFileExistent(atPath: fullPath.string) else {
            throw Abort(.notFound)
        }

        try FileManager.default.removeItem(atPath: fullPath.string)
        return .noContent
    }
}

extension KnowledgeHandler {
    struct KnowledgeFileListResponse: Content, Sendable {
        var files: [String]
    }
}
