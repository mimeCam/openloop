import Vapor
import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import shared

private let maxWalkDepth = 20
private let maxWalkEntries = 10_000
private let maxEntriesPerDir = 200
private let skippedWalkDirs: Set<String> = [
    "node_modules", "vendor", "Pods", "build", "target", "dist", ".build"
]

struct FilesHandler: Sendable {

    func listFiles(req: Request) async throws -> FilesListResponse {
        let walk = try walkInstanceFiles(try await req.validatedInstancePath())
        return FilesListResponse(files: walk.files.map(filesListEntry), truncated: walk.truncated)
    }
}

private func walkInstanceFiles(_ root: String) throws -> (files: [WalkedFile], truncated: Bool) {
    try PathIO.walkFiles(atPath: root, maxDepth: maxWalkDepth, maxEntries: maxWalkEntries,
                         maxEntriesPerDir: maxEntriesPerDir, skippingDotFiles: true,
                         skippingDirs: skippedWalkDirs)
}

private func isMarkdown(_ path: String) -> Bool {
    ["md", "mdx"].contains((path as NSString).pathExtension.lowercased())
}

private func filesListEntry(_ file: WalkedFile) -> FilesHandler.FilesListEntry {
    FilesHandler.FilesListEntry(path: file.path, isMarkdown: isMarkdown(file.path),
                                mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes)
}

extension FilesHandler {

    struct FilesListResponse: Content, Sendable {
        var files: [FilesListEntry]
        var truncated: Bool
    }

    struct FilesListEntry: Content, Sendable {
        var path: String
        var isMarkdown: Bool
        var mtimeMs: Double?
        var sizeBytes: Int64?
    }
}
