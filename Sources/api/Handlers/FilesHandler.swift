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

// The @file attach list is text-only — two guards, cheapest first: the extension table, then the NUL sniff.
private let knownBinaryExtensions: Set<String> = [
    // images
    "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "tif", "tiff", "bmp", "svgz", "ico", "icns",
    // fonts
    "woff", "woff2", "ttf", "otf", "eot",
    // audio / video
    "mp3", "wav", "aac", "flac", "ogg", "m4a", "mp4", "mov", "avi", "mkv", "webm",
    // archives & executables
    "zip", "gz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "class", "dex",
    "so", "dylib", "dll", "exe", "bin", "o", "a", "lib", "wasm",
    // data blobs
    "db", "sqlite", "sqlite3", "bson", "pyc", "pkl", "pt", "onnx", "tflite", "npy", "npz", "parquet",
    // design binaries
    "psd", "ai", "sketch", "fig", "blend", "glb", "gltf", "usdz"
]

// past the caps an entry keeps its slot with lines: nil — nothing is dropped for being big
private let lineCountMaxFileBytes = 2 * 1_024 * 1_024
private let lineCountTotalBudgetBytes = 64 * 1_024 * 1_024

struct FilesHandler: Sendable {

    func listFiles(req: Request) async throws -> FilesListResponse {
        let root = try await req.validatedInstancePath()
        let walk = try walkInstanceFiles(root)
        var budget = lineCountTotalBudgetBytes
        let files = walk.files.compactMap { file -> FilesHandler.FilesListEntry? in
            let abs = (root as NSString).appendingPathComponent(file.path)
            guard isTextFile(file.path, atPath: abs) else { return nil }
            return filesListEntry(file, absPath: abs, budget: &budget)
        }
        return FilesListResponse(files: files, truncated: walk.truncated)
    }
}

private func walkInstanceFiles(_ root: String) throws -> (files: [WalkedFile], truncated: Bool) {
    try PathIO.walkFiles(atPath: root, maxDepth: maxWalkDepth, maxEntries: maxWalkEntries,
                         maxEntriesPerDir: maxEntriesPerDir, skippingDotFiles: true,
                         skippingDirs: skippedWalkDirs)
}

private func isTextFile(_ relPath: String, atPath absPath: String) -> Bool {
    if knownBinaryExtensions.contains((relPath as NSString).pathExtension.lowercased()) {
        return false
    }
    return PathIO.looksLikeTextFile(atPath: absPath)
}

private func isMarkdown(_ path: String) -> Bool {
    ["md", "mdx"].contains((path as NSString).pathExtension.lowercased())
}

private func filesListEntry(_ file: WalkedFile, absPath: String,
                            budget: inout Int) -> FilesHandler.FilesListEntry {
    var lines: Int? = nil
    if let size = file.sizeBytes, size < lineCountMaxFileBytes, Int(size) <= budget {
        budget -= Int(size)
        assert(budget >= 0)
        // +1 lets the read prove EOF for a file of exactly `size` bytes.
        lines = PathIO.countLines(atPath: absPath, readLimit: Int(size) + 1)
    }
    return FilesHandler.FilesListEntry(path: file.path, isMarkdown: isMarkdown(file.path),
                                       mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes,
                                       lines: lines)
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
        var lines: Int?
    }
}
