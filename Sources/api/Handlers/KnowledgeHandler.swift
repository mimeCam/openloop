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
        Paths.objectsRoot(forInstance: instancePath)
            .appending("knowledge")
            .appending(personaId)
    }

    private func knowledgeRoot(_ req: Request) async throws -> FilePath {
        knowledgeDir(instancePath: try await req.validatedInstancePath(),
                     personaId: try safeRelativePath(try req.routeParam("pid")))
    }

    private func safeRelativePath(_ decoded: String) throws -> String {
        guard !decoded.isEmpty else { throw Abort(.badRequest) }
        guard PathIO.isDescendantPath(decoded) else {
            throw Abort(.forbidden, reason: "Path escapes the knowledge folder")
        }
        return decoded
    }

    // Vapor hands catch-all segments over RAW (undecoded).
    private func knowledgeFilePath(_ req: Request) throws -> String {
        let parts = try req.parameters.getCatchall().map { part in
            guard let decoded = part.removingPercentEncoding else {
                throw Abort(.badRequest, reason: "Malformed percent-encoding in path")
            }
            return decoded
        }
        return try safeRelativePath(parts.joined(separator: "/"))
    }

    private func plainText(_ data: Data) -> Response {
        var headers = HTTPHeaders()
        headers.contentType = .plainText
        return Response(status: .ok, headers: headers, body: Response.Body(data: data))
    }

    func listFiles(req: Request) async throws -> KnowledgeFileListResponse {
        let dir = try await knowledgeRoot(req)
        guard PathIO.isDirectoryExistent(atPath: dir.string) else {
            return KnowledgeFileListResponse(files: [])
        }
        let files = try PathIO.contentsOfDirectory(atPath: dir.string)
            .filter { PathIO.isFileExistent(atPath: dir.appending($0).string) }
        return KnowledgeFileListResponse(files: files)
    }

    func readFile(req: Request) async throws -> Response {
        let fullPath = try await knowledgeRoot(req).appending(try knowledgeFilePath(req))
        guard PathIO.isFileExistent(atPath: fullPath.string) else { throw Abort(.notFound) }
        guard let data = await File(fullPath.string).read() else {
            throw Abort(.internalServerError, reason: "Failed to read file")
        }
        return plainText(data)
    }

    func writeFile(req: Request) async throws -> HTTPStatus {
        let fullPath = try await knowledgeRoot(req).appending(try knowledgeFilePath(req))
        _ = PathIO.createDirectoryIfNotExists(atPath: fullPath.removingLastComponent().string)
        let buffer = req.body.data
        let data = buffer.map { Data(buffer: $0) } ?? Data()
        guard await File(fullPath.string).write(data) else {
            throw Abort(.internalServerError, reason: "Failed to write file")
        }
        return .ok
    }

    func deleteFile(req: Request) async throws -> HTTPStatus {
        let fullPath = try await knowledgeRoot(req).appending(try knowledgeFilePath(req))
        guard PathIO.isFileExistent(atPath: fullPath.string) else { throw Abort(.notFound) }
        try FileManager.default.removeItem(atPath: fullPath.string)
        return .noContent
    }
}

extension KnowledgeHandler {
    struct KnowledgeFileListResponse: Content, Sendable {
        var files: [String]
    }
}
