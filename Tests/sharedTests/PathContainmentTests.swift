import XCTest
import shared

// Containment is component equality, not substring matching.
final class PathContainmentTests: XCTestCase {

    func testTraversalIsRejected() {
        for p in ["..", "../x", "x/../y", "a/b/../../../c", "/etc/passwd", "//etc", "/"] {
            XCTAssertFalse(PathIO.isDescendantPath(p), "must reject: \(p)")
        }
    }

    func testContainedRelativeNamesAreAccepted() {
        for p in ["notes.md", "a/b.md", "deep/nested/ctx.md", "a..b.md", "...", "a/..b.md", "a//b"] {
            XCTAssertTrue(PathIO.isDescendantPath(p), "must accept: \(p)")
        }
    }

    func testEmptyIsNotAPath() {
        XCTAssertFalse(PathIO.isDescendantPath(""))
    }
}
