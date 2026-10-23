//

#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
#if canImport(Glibc)
import Glibc
#else
import Darwin
#endif
import Foundation
import CoreFoundation
import Subprocess
import Crypto

private let log = PrintLog(module: "utils")

public struct Paths {
#if DEBUG
    public static let curDir: FilePath = {
        let cd = FilePath(
           FileManager.default.currentDirectoryPath
        )

        let isRunningUnderXcodeWithShittyDefaultDir: Bool
        if cd.string.localizedCaseInsensitiveContains("DerivedData") {
            isRunningUnderXcodeWithShittyDefaultDir = true
        } else if cd.string.localizedCaseInsensitiveContains("Products/openloop") {
            isRunningUnderXcodeWithShittyDefaultDir = true
        } else {
            isRunningUnderXcodeWithShittyDefaultDir = false
        }

        if isRunningUnderXcodeWithShittyDefaultDir {
            return Paths.share
        } else {
            return cd
        }
    }()
#else
    public static let curDir = FilePath(
        FileManager.default.currentDirectoryPath

    )
#endif

    public static let local = FilePath(NSHomeDirectory())
        .appending(".local")
    public static let bin = local
        .appending("bin")

//    public static let state = local
//        .appending("state")
    public static let share = local
        .appending("share")

    public static let globalShare = share

    // User-global (system-wide) objects root, last-resort lookup — no `.openloop` wrapper inside it.
    public static let globalOpenloop = share.appending("openloop")

    // `<instance>/.openloop` for projects; the root itself for the synthetic global-share instance.
    public static func objectsRoot(forInstance instancePath: String) -> FilePath {
        assert(instancePath.notEmpty)
        return FilePath(instancePath) == globalOpenloop
            ? globalOpenloop
            : FilePath(instancePath).appending(dataFolderName)
    }

    public static let tmpRoot = local
        .appending("state")
        .appending("tmp")

    // Per-project data folder. Hidden so AI agents stop treating it as part
    // of the host project. `legacyDataFolderName` is the pre-rename name,
    // kept only for the migration guard below.
    public static let dataFolderName = ".openloop"
    public static let legacyDataFolderName = "openloop"

    // No auto-migration: if a legacy "openloop/" folder exists but ".openloop/"
    // does not, print manual-migration steps and exit early. Called from the
    // openloop and runner entry points before any folder/DB access.
    public static func exitIfLegacyDataFolderExists() {
        let legacy = Paths.legacyDataFolderName
        let modern = Paths.dataFolderName

        let legacyDir = Paths.curDir.appending(legacy)
        let modernDir = Paths.curDir.appending(modern)

        guard PathIO.isDirectoryExistent(atPath: legacyDir.string),
              !PathIO.isDirectoryExistent(atPath: modernDir.string) else {
            return
        }

        let msg = """

        openloop: the data folder was renamed from \"\(legacy)\" to \"\(modern)\" (hidden), so AI agents stop treating it as part of your project.

        A legacy \"\(legacy)/\" folder exists here, but \"\(modern)/\" does not.

        Manual migration required:
          1. Rename the folder in this project:
               mv \(legacy) \(modern)
          2. If any parent project folder (on the path from here to your home directory) also contains an \"\(legacy)/\" folder, rename it too:
               mv <parent>/\(legacy) <parent>/\(modern)
          3. If you run docker-based agents (openloop_cc_docker / openloop_oc_docker / openloop_mv_docker), their launchers now mount \"\(modern)\" — make sure no container still references \"\(legacy)\".

        After renaming, re-run this command.
        """

        FileHandle.standardError.write((msg + "\n").data(using: .utf8) ?? Data())
        Foundation.exit(1)
    }

    public static func dirsToHome() -> [FilePath] {
        dirsToHome(from: curDir)
    }

    public static func dirsToHome(from start: FilePath) -> [FilePath] {
        let home = FilePath(NSHomeDirectory())
        var cur = start
        var result: [FilePath] = []
        while cur != home {
            result.append(cur)
            let parent = cur.removingLastComponent()
            guard parent != cur else { break }
            cur = parent
        }
        return result
    }
}

// MARK: -

public struct TimedBenchmark {
    public init() {}

    public let startTime = CFAbsoluteTimeGetCurrent()
    public var now: CFAbsoluteTime {
        CFAbsoluteTimeGetCurrent()
    }

    public var intervalSinceInitialized: CFAbsoluteTime {
        now - startTime
    }
}

public extension String {

    static func timeN(_ v: Double, _ n: Int = 2) -> String {
        guard v.isValid else { return "Invalid/NaN/Infinity" }

        return String(format: "%.\(n)f", v)
    }
    static func timeN(_ v: Float, _ n: Int = 2) -> String {
        guard v.isValid else { return "Invalid/NaN/Infinity" }

        return String(format: "%.\(n)f", v)
    }
}

public extension Double {
    var time5: String {
        String.timeN(self, 5)
    }

    var time2: String {
        String.timeN(self, 2)
    }

    var time0: String {
        guard isValid else { return "Invalid/NaN/Infinity" }

        return String(Int(self))
    }
}

public extension Float {
    var time5: String {
        String.timeN(self, 2)
    }
}

extension FloatingPoint {

    var isValid: Bool {
        if isNaN { return false }
        if isInfinite { return false }

        return true
    }

}

// MARK: -

public final class PathIO { }

public extension PathIO {
    static func isFileExistent(atPath path: String) -> Bool {
        var isDirectory = false
        let exists = isExistent(atPath: path, isDirectory: &isDirectory)

        return exists && !isDirectory
    }

    static func isDirectoryExistent(atPath path: String) -> Bool {
        var isDirectory = false
        let exists = isExistent(atPath: path, isDirectory: &isDirectory)

        if exists && isDirectory {
            return true
        }

        var s = stat()
        guard stat(path, &s) == 0 else {
            return false
        }
        return (s.st_mode & S_IFMT) == S_IFDIR
    }

    static func createDirectoryIfNotExists(atPath inputPath: String) -> Bool {
        var created: Bool
        let path = removingFileProtocolPrefix(path: inputPath)

        if isDirectoryExistent(atPath: path) {
            created = true
        } else {
            do {
                try FileManager.default.createDirectory(
                    atPath: path,
                    withIntermediateDirectories: true,
                    attributes: nil
                )

                created = true
            } catch let error as NSError {
                log.err("Failed to create directory at path: \(path). \(error)")

                created = false
            }
        }

        return created
    }

    static func contentsOfDirectory(atPath path: String) throws -> [String] {
        try fm.contentsOfDirectory(
            atPath: removingFileProtocolPrefix(path: path)
        )
    }

    static func modificationDate(atPath path: String) -> Date? {
        let attrs = try? fm.attributesOfItem(atPath: removingFileProtocolPrefix(path: path))
        return attrs?[.modificationDate] as? Date
    }

    // internal (not the extension's public default): shared-module only — Database's db-size gauge.
    internal static func fileSize(atPath path: String) -> Int64? {
        var s = stat()
        guard stat(path, &s) == 0 else { return nil }
        return Int64(s.st_size)
    }

    static func deleteDirectoryAndItsContents(atPath inputPath: String) -> Bool {
        let path = removingFileProtocolPrefix(path: inputPath)

        var didDeleteAllContent = true
//        let files = fm.enumerator(atPath: path)

        // Aparently FileManager does recursive deletions for dirs.
//        while let itemName = files?.nextObject() as? String {
//            let itemPath = path.appending("/\(itemName)")
//
//            var isDirectory = ObjCBool(false)
//            fm.fileExists(atPath: itemPath, isDirectory: &isDirectory)
//
//            let isDeleted: Bool
//            if isDirectory.boolValue {
//                isDeleted = deleteDirectoryAndItsContents(atPath: itemPath)
//            } else {
//                do {
//                    try fm.removeItem(atPath: itemPath)
//
//                    isDeleted = true
//                } catch {
//                    isDeleted = false
//                }
//            }
//
//            didDeleteAllContent = didDeleteAllContent && isDeleted
//        }

        do {
            try fm.removeItem(atPath: path)
        } catch {
            assertionFailure()
            didDeleteAllContent = false
        }

        if !didDeleteAllContent {
            log.err("Failed to recursively delete directory at path: \(path)")
        }

        return didDeleteAllContent
    }

    static func copy(_ src: String, _ dest: String) throws {
        try fm.copyItem(atPath: src, toPath: dest)
    }
}

private let fm = FileManager.default


private extension PathIO {

    static func removingFileProtocolPrefix(path inputPath: String) -> String {
//        inputPath.replacingOccurrences(of: "file:///", with: "/")
        inputPath.replacingOccurrences(of: "file://", with: "")
    }

    static func isExistent(atPath inputPath: String, isDirectory: inout Bool) -> Bool {
//        path.suffix(from: )
//        path.starts(with: "file:///")
        let path = removingFileProtocolPrefix(path: inputPath)

        var directory = ObjCBool(false)
        let exists = FileManager.default.fileExists(
            atPath: path,
            isDirectory: &directory
        )

        isDirectory = directory.boolValue
        return exists
    }
}

// MARK: -

public extension Collection {

    @inlinable
    var notEmpty: Bool {
        !isEmpty
    }

}

// MARK: -

@inlinable
public func minsToNanos(_ m: UInt64) -> UInt64 {
    secsToNanos(60 * m)
}

@inlinable
public func secsToNanos(_ s: UInt64) -> UInt64 {
    s * 1_000_000_000
//    s * 1_000 * 1_000 * 1_000
}

@inlinable
public func millisToNanos(_ s: UInt64) -> UInt64 {
    s * 1_000_000
}

// MARK: -

public extension String {

    var md5: String? {
        guard let data = self.data(using: .utf8) else {
            assertionFailure()
            return nil
        }

        return data.md5String
    }

}

public extension Data {

    var md5: Data? {
        Data(Insecure.MD5.hash(data: self))
    }

    var md5String: String? {
        guard let hash = self.md5 else { return nil }
        var result = ""
        result.reserveCapacity(32) // MD5 is always 16 bytes = 32 hex chars
        for byte in hash {
            result += String(format: "%02hhx", byte)
        }
        return result
    }

}

// MARK: -

public extension PathIO {

    static func isDescendantPath(_ decoded: String) -> Bool {
        decoded.notEmpty && decoded.first != "/" && !decoded.split(separator: "/").contains("..")
    }
}

// MARK: - Bounded tree walk

public struct WalkedFile: Sendable, Equatable {
    public let path: String
    public let mtimeMs: Double?
    public let sizeBytes: Int64?

    public init(path: String, mtimeMs: Double? = nil, sizeBytes: Int64? = nil) {
        self.path = path
        self.mtimeMs = mtimeMs
        self.sizeBytes = sizeBytes
    }
}

public extension PathIO {

    /// Dir symlinks are never followed (cycle safety); file symlinks are reported.
    static func walkFiles(
        atPath root: String,
        maxDepth: Int,
        maxEntries: Int,
        maxEntriesPerDir: Int? = nil,
        skippingDotFiles: Bool,
        skippingDirs: Set<String>
    ) throws -> (files: [WalkedFile], truncated: Bool) {
        var state = WalkState(maxDepth: maxDepth, maxEntries: maxEntries,
                              maxEntriesPerDir: maxEntriesPerDir)
        try walkDir(FilePath(root), prefix: "", depth: 0,
                    skipDot: skippingDotFiles, skipDirs: skippingDirs, state: &state)
        return (state.files.sorted { $0.path < $1.path }, state.truncated)
    }
}

private struct WalkState {
    var files: [WalkedFile] = []
    var truncated = false
    let maxDepth: Int
    let maxEntries: Int
    let maxEntriesPerDir: Int?
}

private func walkDir(_ dir: FilePath, prefix: String, depth: Int,
                     skipDot: Bool, skipDirs: Set<String>, state: inout WalkState) throws {
    guard depth <= state.maxDepth else { state.truncated = true; return }
    let names = try PathIO.contentsOfDirectory(atPath: dir.string).sorted()
    try walkNames(dir, names: names, prefix: prefix, depth: depth,
                  skipDot: skipDot, skipDirs: skipDirs, state: &state)
}

private func walkNames(_ dir: FilePath, names: [String], prefix: String, depth: Int,
                       skipDot: Bool, skipDirs: Set<String>, state: inout WalkState) throws {
    var emitted = 0
    for name in names {
        guard state.files.count < state.maxEntries else { state.truncated = true; return }
        if try walkEntry(dir.appending(name), prefix: prefix, name: name, depth: depth,
                         skipDot: skipDot, skipDirs: skipDirs,
                         acceptingFiles: dirAcceptsFiles(emitted, state: state),
                         state: &state) { emitted += 1 }
    }
}

private func dirAcceptsFiles(_ emitted: Int, state: WalkState) -> Bool {
    guard let maxEntriesPerDir = state.maxEntriesPerDir else { return true }
    return emitted < maxEntriesPerDir
}

private func walkEntry(_ entry: FilePath, prefix: String, name: String, depth: Int, skipDot: Bool,
                       skipDirs: Set<String>, acceptingFiles: Bool, state: inout WalkState) throws -> Bool {
    guard !skippedEntry(name, entry: entry, skipDot: skipDot, skipDirs: skipDirs) else { return false }
    let rel = prefix.isEmpty ? name : "\(prefix)/\(name)"
    guard PathIO.isDirectoryExistent(atPath: entry.string) else {
        return emitFile(entry, rel: rel, accepting: acceptingFiles, state: &state)
    }
    try walkDir(entry, prefix: rel, depth: depth + 1, skipDot: skipDot, skipDirs: skipDirs, state: &state)
    return false
}

private func skippedEntry(_ name: String, entry: FilePath, skipDot: Bool, skipDirs: Set<String>) -> Bool {
    (skipDot && name.hasPrefix(".")) || skipDirs.contains(name)
        || (isSymlink(entry.string) && PathIO.isDirectoryExistent(atPath: entry.string))
}

private func emitFile(_ entry: FilePath, rel: String, accepting: Bool, state: inout WalkState) -> Bool {
    guard PathIO.isFileExistent(atPath: entry.string) else { return false }
    guard accepting else { state.truncated = true; return false }
    state.files.append(walkedFile(entry.string, rel: rel))
    return true
}

private func walkedFile(_ absPath: String, rel: String) -> WalkedFile {
    WalkedFile(path: rel,
               mtimeMs: PathIO.modificationDate(atPath: absPath).map { $0.timeIntervalSince1970 * 1000 },
               sizeBytes: PathIO.fileSize(atPath: absPath))
}

private func isSymlink(_ path: String) -> Bool {
    var s = stat()
    return lstat(path, &s) == 0 && (s.st_mode & S_IFMT) == S_IFLNK
}
