import XCTest
import shared

// The read-side rules behind the @file attach picker: binaries drop (looksLikeTextFile), text files count (countLines).
final class TextSniffTests: XCTestCase {

    var root: String!

    override func setUpWithError() throws {
        root = NSTemporaryDirectory() + "openloop-sniff-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(atPath: root)
    }

    // text vs binary (git's rule: NUL in the head)

    func testNulByteInHeadMarksBinary() throws {
        try write("a\0b", to: "nul-inside")
        XCTAssertFalse(PathIO.looksLikeTextFile(atPath: abs("nul-inside")),
                       "a NUL in the head is the binary verdict")
    }

    func testNulBytePastSniffLimitStaysText() throws {
        try write(String(repeating: "a", count: 100) + "\0", to: "late-nul")
        XCTAssertTrue(PathIO.looksLikeTextFile(atPath: abs("late-nul"), sniffLimit: 8),
                      "clean head is text — a NUL buried past the sniff window doesn't spoil it")
    }

    func testEmptyFileIsText() throws {
        XCTAssertTrue(FileManager.default.createFile(atPath: abs("empty"), contents: nil))
        XCTAssertTrue(PathIO.looksLikeTextFile(atPath: abs("empty")),
                      "an empty file is a (zero-line) text file")
    }

    func testUnopenablePathIsNotText() {
        XCTAssertFalse(PathIO.looksLikeTextFile(atPath: abs("nope")),
                       "cannot open → dropped, not crashed on")
    }

    // line counting (editor semantics, not wc -l)

    func testLineCountMatchesTheEditorNotWc() throws {
        XCTAssertEqual(try count("a\nb"), 2, "no trailing newline — the tail is still a line")
        XCTAssertEqual(try count("a\nb\n"), 2, "trailing newline — wc agrees, so does the editor")
        XCTAssertEqual(try count("\n\n\n"), 3, "three bare newlines are three lines")
        XCTAssertEqual(try count("abc"), 1, "one unterminated line")
        XCTAssertEqual(try count(""), 0, "empty file — zero lines, not one")
        XCTAssertEqual(try count("a\r\nb"), 2, "CRLF counts by its \\n")
    }

    func testLineCountAcrossTheChunkBoundary() throws {
        // straddle countLines' 64 KiB chunk and land mid-line
        let body = String(repeating: "x\n", count: 40_000) + "dangling"
        XCTAssertEqual(try count(body, limit: 200_000), 40_001,
                       "a file bigger than one read chunk still counts whole")
    }

    func testReadLimitWithoutProvenEofAnswersNil() throws {
        try write("abc", to: "cap")
        XCTAssertNil(try countFile("cap", limit: 2), "cap before EOF — nil, never a partial count")
        XCTAssertNil(try countFile("cap", limit: 3), "exact-cap boundary — EOF unprovable, nil")
        XCTAssertEqual(try countFile("cap", limit: 4), 1, "one byte of headroom proves EOF")
        XCTAssertNil(PathIO.countLines(atPath: abs("cap"), readLimit: 0), "a zero cap answers nothing")
    }

    func testUnopenablePathCountsNothing() {
        XCTAssertNil(PathIO.countLines(atPath: abs("nope"), readLimit: 64))
    }

    // helpers

    private func write(_ body: String, to name: String) throws {
        try body.write(toFile: abs(name), atomically: true, encoding: .utf8)
    }

    private func count(_ body: String, limit: Int = 1_024) throws -> Int? {
        try write(body, to: "probe")
        return PathIO.countLines(atPath: abs("probe"), readLimit: limit)
    }

    private func countFile(_ name: String, limit: Int) throws -> Int? {
        PathIO.countLines(atPath: abs(name), readLimit: limit)
    }

    private func abs(_ name: String) -> String {
        (root as NSString).appendingPathComponent(name)
    }
}
