import XCTest
import shared

final class FileWalkerTests: XCTestCase {

    var root: String!

    override func setUpWithError() throws {
        root = NSTemporaryDirectory() + "openloop-walker-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(atPath: root)
    }

    func testEmptyDirYieldsNoFilesAndNoTruncation() throws {
        let r = try walk()
        XCTAssertEqual(r.files, [])
        XCTAssertFalse(r.truncated, "empty dir: no cap tripped, no truncation lie")
    }

    func testNestedDirsReportRelativePosixPathsSortedWithAttrs() throws {
        try write("README.md")
        try write("docs/plan.md", "twelve bytes")
        try write("docs/specs/deep.txt", "x")
        let r = try walk()
        XCTAssertEqual(r.files, ["README.md", "docs/plan.md", "docs/specs/deep.txt"])
        let plan = try fullWalk().files.first { $0.path == "docs/plan.md" }
        XCTAssertEqual(plan?.sizeBytes, 12, "size follows the file, not the name")
        XCTAssertNotNil(plan?.mtimeMs, "mtime present — the ranking's recency tiebreak")
    }

    func testDotEntriesAreSkippedWhole() throws {
        try write(".git/config")
        try write(".DS_Store")
        try write(".openloop/nodes/x.json5")
        try write("docs/.hidden.md")
        try write("keep.md")
        XCTAssertEqual(try walk().files, ["keep.md"])
    }

    func testJunkDirsAreSkipped() throws {
        try write("node_modules/pkg/index.js")
        try write("dist/bundle.js")
        try write("src/main.swift")
        XCTAssertEqual(try walk(skipDirs: ["node_modules", ".build", "dist"]).files, ["src/main.swift"])
    }

    // Pin cycle termination with a real loop — don't trust the enumerator docs.
    func testSymlinkCycleTerminatesAndNeverLeaksTheLoop() throws {
        try write("a/real.md")
        try write("a/deeper/anchor.md") // ensures a/deeper exists — links get no mkdir
        try FileManager.default.createSymbolicLink(
            atPath: root + "/a/loop", withDestinationPath: "..")           // a/loop -> a's parent (root)
        try FileManager.default.createSymbolicLink(
            atPath: root + "/a/deeper/loop2", withDestinationPath: "../..") // two-level cycle
        try write("a/linked-file.md")
        try FileManager.default.createSymbolicLink(
            atPath: root + "/a/file-link.md", withDestinationPath: "linked-file.md")
        let r = try walk()
        XCTAssertEqual(r.files, ["a/deeper/anchor.md", "a/file-link.md", "a/linked-file.md", "a/real.md"],
                       "dir symlinks skipped whole; file symlinks reported")
        XCTAssertFalse(r.truncated, "a skipped cycle must not masquerade as a cap")
    }

    func testEntryCapTripsTruncated() throws {
        for i in 0..<5 { try write("f\(i).md") }
        let r = try walk(maxEntries: 3)
        XCTAssertEqual(r.files.count, 3)
        XCTAssertTrue(r.truncated, "entry cap tripped — the honest signal")
        XCTAssertEqual(r.files, ["f0.md", "f1.md", "f2.md"], "deterministic prefix under the cap")
    }

    func testDepthCapTripsTruncated() throws {
        try write("d1/d2/d3/deep.md")
        XCTAssertTrue(try walk(maxDepth: 2).truncated)
        XCTAssertEqual(try walk(maxDepth: 3).files, ["d1/d2/d3/deep.md"])
    }

    func testWalkOrderIsDeterministicRegardlessOfCreationOrder() throws {
        for name in ["zebra.md", "alpha.md", "mid/echo.md"] { try write(name) }
        XCTAssertEqual(try walk().files, try walk().files)
        XCTAssertEqual(try walk().files, ["alpha.md", "mid/echo.md", "zebra.md"])
    }

    func testPerDirQuotaKeepsLaterDirsReachable() throws {
        for i in 0..<4 { try write("a00-huge/f\(i).md") } // sorts before b00/
        try write("b00-small/keep.md")
        let r = try fullWalk(maxEntriesPerDir: 2)
        XCTAssertEqual(r.files.map(\.path),
                       ["a00-huge/f0.md", "a00-huge/f1.md", "b00-small/keep.md"])
        XCTAssertTrue(r.truncated, "withheld files must flag truncation")
    }

    func testPerDirQuotaSparesSubdirsAndExactQuotaDoesNotLie() throws {
        try write("big/f0.md")
        try write("big/f1.md")
        try write("big/sub/deep.md")
        let r = try fullWalk(maxEntriesPerDir: 2)
        XCTAssertEqual(r.files.map(\.path), ["big/f0.md", "big/f1.md", "big/sub/deep.md"])
        XCTAssertFalse(r.truncated, "quota met exactly, nothing withheld — no truncation lie")
    }

    // ── helpers ───────────────────────────────────────────────────────────

    private func write(_ rel: String, _ body: String = "x") throws {
        let abs = (root as NSString).appendingPathComponent(rel)
        try FileManager.default.createDirectory(
            atPath: (abs as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        try body.write(toFile: abs, atomically: true, encoding: .utf8)
    }

    private func walk(maxDepth: Int = 10, maxEntries: Int = 10_000,
                      skipDirs: Set<String> = []) throws -> (files: [String], truncated: Bool) {
        let r = try fullWalk(maxDepth: maxDepth, maxEntries: maxEntries, skipDirs: skipDirs)
        return (r.files.map(\.path), r.truncated)
    }

    private func fullWalk(maxDepth: Int = 10, maxEntries: Int = 10_000,
                          maxEntriesPerDir: Int? = nil,
                          skipDirs: Set<String> = []) throws -> (files: [WalkedFile], truncated: Bool) {
        try PathIO.walkFiles(atPath: root, maxDepth: maxDepth, maxEntries: maxEntries,
                             maxEntriesPerDir: maxEntriesPerDir,
                             skippingDotFiles: true, skippingDirs: skipDirs)
    }
}
