import XCTest
import shared

// `.openloop/secrets.json5` — the per-machine MCP key store: roundtrip,
// owner-only permissions, deterministic bytes, empty-map disappearance and
// the read policy (missing file → empty map; corrupt/unreadable traps in
// DEBUG — a silent empty map would strip auth headers from runs).
final class SecretStoreTests: XCTestCase {

    var path: String!

    override func setUpWithError() throws {
        path = NSTemporaryDirectory() + "openloop-secretStore-\(UUID().uuidString)"
        try FileManager.default.createDirectory(
            atPath: (path as NSString).appendingPathComponent(Paths.dataFolderName),
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(atPath: path)
    }

    func secretsFile() -> String {
        SecretStore.secretsPath(at: path).string
    }

    func fileBytes() throws -> Data {
        try XCTUnwrap(FileManager.default.contents(atPath: secretsFile()))
    }

    func testSetLoadRemoveRoundtrip() throws {
        XCTAssertNil(SecretStore.secret(for: "https://mcp.example", at: path)) // no file yet
        try SecretStore.setSecret("Bearer k", for: "https://mcp.example", at: path)
        XCTAssertEqual(SecretStore.secret(for: "https://mcp.example", at: path), "Bearer k")
        XCTAssertEqual(SecretStore.load(at: path), ["https://mcp.example": "Bearer k"])
        try SecretStore.setSecret(nil, for: "https://mcp.example", at: path)
        XCTAssertNil(SecretStore.secret(for: "https://mcp.example", at: path))
        // last entry gone → the file disappears, not an empty husk
        XCTAssertFalse(PathIO.isFileExistent(atPath: secretsFile()))
    }

    func testEmptyAndBlankValuesNeverStoreAnEntry() throws {
        try SecretStore.setSecret("", for: "https://mcp.example", at: path)
        XCTAssertTrue(SecretStore.load(at: path).isEmpty)
        XCTAssertFalse(PathIO.isFileExistent(atPath: secretsFile()))
    }

    func testSecondKeyKeepsTheFirst() throws {
        try SecretStore.setSecret("k1", for: "https://one.example", at: path)
        try SecretStore.setSecret("k2", for: "https://two.example", at: path)
        XCTAssertEqual(SecretStore.secret(for: "https://one.example", at: path), "k1")
        try SecretStore.setSecret(nil, for: "https://one.example", at: path)
        XCTAssertEqual(SecretStore.secret(for: "https://two.example", at: path), "k2")
    }

    func testFileIsOwnerOnlyFromBirth() throws {
        try SecretStore.setSecret("k", for: "https://mcp.example", at: path)
        let perms = try XCTUnwrap(
            (try FileManager.default.attributesOfItem(atPath: secretsFile()))[.posixPermissions] as? Int
        )
        XCTAssertEqual(perms & 0o777, 0o600)
    }

    func testLooseHandCreatedFileIsTightenedOnRead() throws {
        try Data("{\"https://mcp.example\" : \"k\"}".utf8)
            .write(to: URL(fileURLWithPath: secretsFile()))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: secretsFile())
        XCTAssertEqual(SecretStore.load(at: path), ["https://mcp.example": "k"])
        let perms = try XCTUnwrap(
            (try FileManager.default.attributesOfItem(atPath: secretsFile()))[.posixPermissions] as? Int
        )
        XCTAssertEqual(perms & 0o777, 0o600)
    }

    func testBytesAreDeterministicRegardlessOfWriteOrder() throws {
        try SecretStore.setSecret("k1", for: "https://b.example", at: path)
        try SecretStore.setSecret("k2", for: "https://a.example", at: path)
        let first = try fileBytes()

        try SecretStore.setSecret(nil, for: "https://a.example", at: path)
        try SecretStore.setSecret(nil, for: "https://b.example", at: path)
        try SecretStore.setSecret("k2", for: "https://a.example", at: path) // reverse order
        try SecretStore.setSecret("k1", for: "https://b.example", at: path)

        XCTAssertEqual(try fileBytes(), first, "sorted keys: insertion order must never reach the bytes")
    }

    func testUnchangedSetIsNotRewritten() throws {
        try SecretStore.setSecret("k", for: "https://mcp.example", at: path)
        let before = try fileBytes()
        let mtime = PathIO.modificationDate(atPath: secretsFile())
        try SecretStore.setSecret("k", for: "https://mcp.example", at: path) // same value
        XCTAssertEqual(try fileBytes(), before)
        XCTAssertEqual(PathIO.modificationDate(atPath: secretsFile()), mtime)
    }

    // Corrupt files are no longer read-tolerant: DEBUG traps in
    // SecretStore.load (a silent empty map would strip auth headers from
    // runs), so the old corrupt-file test cannot run in a debug test build.
    // Missing file stays the one legitimate empty case; a later write still
    // creates the machine-owned file from scratch.
    func testMissingFileReadsEmptyWithoutThrowing() throws {
        XCTAssertTrue(SecretStore.load(at: path).isEmpty)
        try SecretStore.setSecret("k", for: "https://mcp.example", at: path)
        XCTAssertEqual(SecretStore.secret(for: "https://mcp.example", at: path), "k")
    }

    func testKeysWithUnderscoresRoundtripVerbatim() throws {
        // no snake_case codec gymnastics on this file — URL keys are opaque
        try SecretStore.setSecret("k", for: "https://my_host.example/mcp", at: path)
        XCTAssertEqual(SecretStore.secret(for: "https://my_host.example/mcp", at: path), "k")
    }

    func testNoTmpDebrisAfterWrite() throws {
        try SecretStore.setSecret("k", for: "https://mcp.example", at: path)
        let debris = try PathIO.contentsOfDirectory(
            atPath: (path as NSString).appendingPathComponent(Paths.dataFolderName)
        ).filter { $0.hasSuffix(".tmp") }
        XCTAssertTrue(debris.isEmpty)
    }
}