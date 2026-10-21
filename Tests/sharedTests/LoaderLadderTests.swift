import XCTest
import SystemPackage
import shared

final class LoaderLadderTests: XCTestCase {

    private var tmp: String!
    private var inst: String!
    private var parentProject: String!
    private var global: String!

    override func setUpWithError() throws {
        tmp = NSTemporaryDirectory() + "openloop-ladder-\(UUID().uuidString)"
        parentProject = tmp + "/root"
        inst = parentProject + "/inst"
        global = tmp + "/global"
        for d in [parentProject!, inst!, global!] {
            try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        }
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(atPath: tmp)
    }

    private func mkdir(_ path: String) throws {
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    private func touch(_ path: String) throws {
        try mkdir((path as NSString).deletingLastPathComponent)
        try "{}".write(toFile: path, atomically: true, encoding: .utf8)
    }

    func testPersonaFilePrefersNearestInstanceCopy() throws {
        try touch(inst + "/.openloop/personas/p1.json5")
        try touch(parentProject + "/.openloop/personas/p1.json5")
        try touch(global + "/personas/p1.json5")
        let hit = FileLoader.resolvePersonaFile(id: "p1", from: FilePath(inst), globalRoot: FilePath(global))
        XCTAssertEqual(hit?.string, inst + "/.openloop/personas/p1.json5")
    }

    func testPersonaFileFallsBackToParentProject() throws {
        try touch(parentProject + "/.openloop/personas/p1.json5")
        let hit = FileLoader.resolvePersonaFile(id: "p1", from: FilePath(inst), globalRoot: FilePath(global))
        XCTAssertEqual(hit?.string, parentProject + "/.openloop/personas/p1.json5")
    }

    func testPersonaFileGlobalRootFallback() throws {
        try touch(global + "/personas/p2.json5")
        let hit = FileLoader.resolvePersonaFile(id: "p2", from: FilePath(inst), globalRoot: FilePath(global))
        XCTAssertEqual(hit?.string, global + "/personas/p2.json5")
    }

    func testKnowledgeDirPrefersNearestInstanceCopy() throws {
        try mkdir(inst + "/.openloop/knowledge/k1")
        try mkdir(parentProject + "/.openloop/knowledge/k1")
        try mkdir(global + "/knowledge/k1")
        let hit = FileLoader.resolveKnowledgeDir(id: "k1", from: FilePath(inst), globalRoot: FilePath(global))
        XCTAssertEqual(hit?.string, inst + "/.openloop/knowledge/k1")
    }

    func testKnowledgeDirGlobalRootFallback() throws {
        try mkdir(global + "/knowledge/k2")
        let hit = FileLoader.resolveKnowledgeDir(id: "k2", from: FilePath(inst), globalRoot: FilePath(global))
        XCTAssertEqual(hit?.string, global + "/knowledge/k2")
    }

    func testMissReturnsNilOnBothLadders() throws {
        XCTAssertNil(FileLoader.resolvePersonaFile(id: "nope", from: FilePath(inst), globalRoot: FilePath(global)))
        XCTAssertNil(FileLoader.resolveKnowledgeDir(id: "nope", from: FilePath(inst), globalRoot: FilePath(global)))
    }
}
