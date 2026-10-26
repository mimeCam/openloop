import XCTest
import SystemPackage
import shared

// `Paths.contextLookupDirs` — the persona-context instance ladder: start
// folder, parents toward home, the user-global share LAST (nearest wins),
// with the never-twice guard for a worker registered AT the share and for
// projects nested under it. All entries are instance folders — no
// `.openloop` suffix (each consumer appends the wrapper itself).
final class ContextLadderTests: XCTestCase {

    private var tmp: String!
    private var inst: String!
    private var parentProject: String!
    private var global: String!

    override func setUpWithError() throws {
        tmp = NSTemporaryDirectory() + "openloop-ctx-ladder-\(UUID().uuidString)"
        parentProject = tmp + "/root"
        inst = parentProject + "/inst"
        global = tmp + "/global" // plays the share folder
        for d in [parentProject!, inst!, global!] {
            try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
        }
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(atPath: tmp)
    }

    private func dirs(from start: String) -> [FilePath] {
        Paths.contextLookupDirs(from: FilePath(start), globalRoot: FilePath(global))
    }

    func testAppendsGlobalShareLastWhenWalkMissesIt() {
        let walked = dirs(from: inst)
        XCTAssertEqual(walked.first?.string, inst, "nearest first")
        XCTAssertEqual(walked.last?.string, global, "global share is the last-resort stop")
        XCTAssertEqual(walked.filter { $0.string == global }.count, 1)
    }

    func testStartAtGlobalShareReadsItExactlyOnce() {
        // The share worker's own walk starts at the share — the explicit
        // append must not read the global content a second time.
        let walked = dirs(from: global)
        XCTAssertEqual(walked.first?.string, global)
        XCTAssertEqual(walked.filter { $0.string == global }.count, 1)
    }

    func testProjectNestedUnderGlobalShareDoesNotDoubleAppend() {
        let nested = global + "/proj"
        let walked = dirs(from: nested)
        XCTAssertEqual(walked.filter { $0.string == global }.count, 1)
        XCTAssertEqual(walked.first?.string, nested, "nearest first, reached via the walk itself")
    }

    func testNearestOrderIsPreservedWithGlobalAppend() {
        let walked = dirs(from: inst)
        let strings = walked.map(\.string)
        XCTAssertEqual(strings.firstIndex(of: inst), 0)
        XCTAssertEqual(strings.firstIndex(of: parentProject), 1)
        XCTAssertEqual(strings.firstIndex(of: global), strings.count - 1)
    }
}
