//
// Node metadata file store — one `.openloop/nodes/<UUID>.json5` per node.
//
// Why files, not sqlite: node metadata must `git merge` across machines
// (coordination); a binary DB gives git nothing to work with. Run logs stay
// in sqlite (GraphStore) — only node metadata moved out.
//
// Format contract (merge-calm, byte-stable):
// - One key per line, 2-space indent, snake_case keys that exactly match the
//   API wire format (`parent_id`, `mcp`, …). What you PUT is what you read
//   in the file. The one deliberate split from the wire: MCP authorization
//   KEYS never live here — node files are committed, so the key goes to the
//   per-machine `.openloop/secrets.json5` (SecretStore) keyed by URL, and
//   this file keeps only the `mcp_requires_auth` marker that travels with
//   the repo. No migration ships for the pre-split plaintext-`mcp_auth` era: it
//   was never distributed — its values were moved by hand when the split
//   landed, and `mcp_auth` on disk is just another unknown key now.
// - `NodeFile.Field` (below) IS the JSON key set and order: stable identity
//   first (id/parent_id/created_at), human-merged words next, volatile
//   machine state after, the big `output` dump last — so ordinary churn
//   never buries identity in a diff.
// - `created_at`/`completed_at` are reference-date Doubles (seconds since
//   2001-01-01) — the same canonical representation as `GraphNode` in memory
//   and run-log REAL columns; the API edge converts to unix ms. ISO-8601 is
//   a v2 candidate and would require a file-format migration — do not mix.
// - No comments in files, ever (the encoder would eat them on rewrite).
//   An unchanged node must produce a byte-identical file — `git status`
//   after merely viewing the graph stays empty.
//
// Durability: writes are temp+rename (`Data.write(options: .atomic)`), so a
// crash never leaves a torn file; crash-leftover `*.tmp` is gitignored.
// Files lost SQL's field-level atomicity, so every read-modify-write goes
// through `mutate`, which serializes per-node on an NSLock (only `api`
// writes nodes, so in-process locking suffices; atomic rename protects
// concurrent readers).
//
// Corrupt-file policy: one bad file must never take the canvas down — skip
// it, keep the rest, warn with the filename. The filename is the identity:
// if the inner `id` disagrees, the filename wins and the file is skipped.
//

import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

private let nodeLog = PrintLog(module: "node-store")

/// Codable twin of `GraphNode` (Model.swift stays storage-agnostic).
/// File key set, spelling and serialization order are declared once in
/// `Field` below (kept parallel to property order for readability).
public struct NodeFile: Codable, Equatable, Sendable {
    public var id: String
    public var parentId: String?
    public var createdAt: Double
    public var agent: String
    public var took: Int?
    public var completedAt: Double?
    public var name: String?
    public var summary: String?
    public var prompt: String
    public var status: String
    public var active: Bool
    public var personas: [String]
    public var mcp: String?
    /// Repo-traveling marker: this node's MCP endpoint requires an
    /// authorization key (the key itself lives in SecretStore, keyed by `mcp`).
    public var mcpRequiresAuth: Bool
    public var output: String?

    public init(_ node: GraphNode) {
        id = node.id
        parentId = node.parentId
        createdAt = node.createdAt
        agent = node.agent
        took = node.took
        completedAt = node.completedAt
        name = node.name
        summary = node.summary
        prompt = node.prompt
        status = node.status
        active = node.active
        personas = node.personas
        mcp = node.mcp
        mcpRequiresAuth = node.mcpRequiresAuth
        output = node.output
    }

    var node: GraphNode {
        GraphNode(
            id: id, parentId: parentId, prompt: prompt, agent: agent,
            status: status, output: output, took: took, mcp: mcp,
            mcpRequiresAuth: mcpRequiresAuth, summary: summary, name: name,
            personas: personas, createdAt: createdAt,
            completedAt: completedAt, active: active
        )
    }

    /// Single source of truth for the file's keys: `rawValue` is the
    /// snake_case disk/wire spelling (`parent_id`, `mcp`, …); case
    /// order IS the serialization order — the merge-stability layout
    /// (identity first, `output` last). `jsonText` walks `allCases` and its
    /// value switch is exhaustive, so a new case without a serializer arm is
    /// a compile error; a new property that never got a case here is caught
    /// by the round-trip assert in `jsonText` on first write.
    fileprivate enum Field: String, CaseIterable, Sendable {
        case id, parentId = "parent_id", createdAt = "created_at", agent, took
        case completedAt = "completed_at", name, summary, prompt, status
        case active, personas, mcp, mcpRequiresAuth = "mcp_requires_auth", output
    }

    // Tolerant decode: `personas`/`active`/`mcp_requires_auth` may be absent
    // in hand-edited or older files; identity fields stay mandatory — a file
    // without them is a bad hand-merge and belongs on the skip+warn path.
    //
    // Trap: `dec` decodes with `.convertFromSnakeCase`, which renames JSON
    // keys BEFORE lookup (`mcp_requires_auth` arrives here as
    // `mcpRequiresAuth`) — so case names must be the POST-conversion
    // camelCase spelling, never the disk spelling
    // (`mcpRequiresAuth = "mcp_requires_auth"` would silently decode
    // nil and strand the value). (Disk spellings and file order live in
    // `Field` above — the jsonText round-trip assert keeps the two sets in
    // lockstep.)
    private enum CodingKeys: String, CodingKey {
        case id, parentId, createdAt, agent, took, completedAt
        case name, summary, prompt, status, active, personas
        case mcp, mcpRequiresAuth, output
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        createdAt = try c.decode(Double.self, forKey: .createdAt)
        agent = try c.decode(String.self, forKey: .agent)
        took = try c.decodeIfPresent(Int.self, forKey: .took)
        completedAt = try c.decodeIfPresent(Double.self, forKey: .completedAt)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        prompt = try c.decode(String.self, forKey: .prompt)
        status = try c.decode(String.self, forKey: .status)
        active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? true
        personas = try c.decodeIfPresent([String].self, forKey: .personas) ?? []
        mcp = try c.decodeIfPresent(String.self, forKey: .mcp)
        mcpRequiresAuth = try c.decodeIfPresent(Bool.self, forKey: .mcpRequiresAuth) ?? false
        output = try c.decodeIfPresent(String.self, forKey: .output)
    }
}

public struct NodeStore {

    public static func nodesDir(at instancePath: String) -> FilePath {
        FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("nodes")
    }

    public static func filePath(id: String, at instancePath: String) -> FilePath {
        nodesDir(at: instancePath).appending("\(id).\(json)")
    }

    public static func ensureDir(at instancePath: String) throws {
        let dir = nodesDir(at: instancePath)
        guard PathIO.createDirectoryIfNotExists(atPath: dir.string) else {
            throw NSError(
                domain: "openloop.node-store", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Cannot create nodes dir: \(dir)"]
            )
        }
    }

    public static func save(_ node: GraphNode, at instancePath: String) throws {
        try ensureDir(at: instancePath)
        try write(NodeFile(node), at: instancePath)
    }

    /// Single read-modify-write entry point. No-op when the file is missing
    /// (mirrors SQL `UPDATE … WHERE id = ?` on a missing row).
    public static func mutate(id: String, at instancePath: String, _ change: (inout NodeFile) -> Void) throws {
        let lock = nodeLock(for: id)
        lock.lock()
        defer { lock.unlock() }
        guard var file = readFile(id: id, at: instancePath) else { return }
        change(&file)
        try write(file, at: instancePath)
    }

    public static func load(id: String, at instancePath: String) -> GraphNode? {
        readFile(id: id, at: instancePath)?.node
    }

    /// Deterministic `(createdAt, id)` order — mirrors the frontend lane
    /// order, so columns never shuffle between polls when timestamps tie.
    public static func list(at instancePath: String) -> [GraphNode] {
        let dir = nodesDir(at: instancePath)
        let names = (try? PathIO.contentsOfDirectory(atPath: dir.string)) ?? []
        return names
            .filter { $0.hasSuffix(".\(json)") }
            .compactMap { readFile(id: String($0.dropLast(".\(json)".count)), at: instancePath) }
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
            .map(\.node)
    }

    public static func delete(id: String, at instancePath: String) throws {
        let fp = filePath(id: id, at: instancePath)
        guard PathIO.isFileExistent(atPath: fp.string) else { return }
        try FileManager.default.removeItem(atPath: fp.string)
    }
}

private extension NodeStore {

    static func readFile(id: String, at instancePath: String) -> NodeFile? {
        guard let file = decodeFile(at: filePath(id: id, at: instancePath)) else { return nil }
        guard file.id == id else {
            nodeLog.warn("node file id mismatch — filename wins, skipping: \(id).\(json) declares id \(file.id)")
            return nil
        }
        return file
    }

    static func decodeFile(at fp: FilePath) -> NodeFile? {
        guard let data = FileManager.default.contents(atPath: fp.string) else { return nil }
        guard let file = try? dec.decode(NodeFile.self, from: data) else {
            nodeLog.warn("skipping unreadable node file: \(fp.lastComponent?.string ?? fp.string)")
            return nil
        }
        assertNoUnknownKeys(in: data, at: fp)
        return file
    }

    // The other extension blindside, read side: keys on disk this build
    // doesn't know. Decoding ignores them (reads stay forward-compatible),
    // but the next `mutate` read-modify-write rewrites the file WITHOUT them
    // — silently erasing another machine's newer-format field from the repo.
    // Debug builds fail loudly at first read instead; release keeps the
    // tolerant frozen-contract behavior.
    static func assertNoUnknownKeys(in data: Data, at fp: FilePath) {
        #if DEBUG
        let unknown = unknownKeys(in: data)
        assert(
            unknown.isEmpty,
            "\(fp.string) carries keys outside NodeFile.Field: "
                + "\(unknown.joined(separator: ", ")). Extend Field, CodingKeys and "
                + "init(from:) before this build reads newer-format files — "
                + "a rewrite from here would drop them."
        )
        #endif
    }

    // Decoding `[String: Present]` yields exactly the object's key set:
    // `Present.init(from:)` reads no value, so every JSON value shape decodes.
    private enum Present: Decodable {
        case any
        init(from decoder: Decoder) throws { self = .any }
    }

    static func unknownKeys(in data: Data) -> [String] {
        guard let keys = try? dec.decode([String: Present].self, from: data) else { return [] }
        let known = Set(NodeFile.Field.allCases.map(\.rawValue))
        return keys.keys.filter { !known.contains($0) }.sorted()
    }

    /// Atomic temp+rename; skips the write entirely when bytes are unchanged
    /// (byte-stability: no rewrite churn, mtime preserved, `git status` quiet).
    static func write(_ file: NodeFile, at instancePath: String) throws {
        let fp = filePath(id: file.id, at: instancePath)
        let data = Data(jsonText(file).utf8)
        if let existing = FileManager.default.contents(atPath: fp.string), existing == data { return }
        try data.write(to: URL(fileURLWithPath: fp.string), options: .atomic)
    }

    // Deterministic serializer: JSONEncoder's object key order is unspecified
    // (hash order — reshuffled in every new process; within one process it
    // merely *looks* stable, which is why in-process tests can't catch it) —
    // unusable for files that must diff calmly and be byte-stable. Note
    // `.sortedKeys` IS byte-stable (verified Swift 6.4.1/linux) but was
    // rejected on order semantics: alphabetical ≠ the merge-stability layout
    // (identity first, `output` last), and it can't express a custom order.
    // Keys and order come from `NodeFile.Field`; values are still
    // escaped/encoded by the shared encoder — only the key layout is
    // hand-rolled.
    static func jsonText(_ f: NodeFile) -> String {
        let body = NodeFile.Field.allCases
            .map { "  \"\($0.rawValue)\" : \(scalar(of: $0, in: f))" }
            .joined(separator: ",\n")
        let text = "{\n\(body)\n}\n"
        assert(roundTrips(to: f, text: text), roundTripAssertMessage)
        return text
    }

    static let roundTripAssertMessage = """
        jsonText output no longer round-trips to the same NodeFile — typically \
        a field was added to NodeFile but never got a NodeFile.Field case (or a \
        Field rawValue drifted from the CodingKeys spelling). The file would \
        silently drop it and git would commit the data loss. Extend Field, the \
        scalar(of:in:) switch and init(from:) together.
        """

    // Field→value mapping is a switch so it cannot silently lag the enum:
    // a new Field case without an arm here is a compile error, not a
    // dropped key.
    static func scalar(of field: NodeFile.Field, in f: NodeFile) -> String {
        switch field {
        case .id: return scalar(f.id)
        case .parentId: return scalar(f.parentId)
        case .createdAt: return scalar(f.createdAt)
        case .agent: return scalar(f.agent)
        case .took: return scalar(f.took)
        case .completedAt: return scalar(f.completedAt)
        case .name: return scalar(f.name)
        case .summary: return scalar(f.summary)
        case .prompt: return scalar(f.prompt)
        case .status: return scalar(f.status)
        case .active: return scalar(f.active)
        case .personas: return scalar(f.personas)
        case .mcp: return scalar(f.mcp)
        case .mcpRequiresAuth: return scalar(f.mcpRequiresAuth)
        case .output: return scalar(f.output)
        }
    }

    // Debug tripwire (assert is compiled out of release and its autoclosure
    // costs nothing there): re-decode what we just serialized and demand
    // field-for-field equality. This closes the one hole the enum cannot
    // catch at compile time — a NodeFile property that never got a Field
    // case. The first test that saves a fully-populated node trips it,
    // instead of a field-dropping file format shipping silently.
    static func roundTrips(to f: NodeFile, text: String) -> Bool {
        guard let back = try? dec.decode(NodeFile.self, from: Data(text.utf8)) else { return false }
        return back == f
    }

    static func scalar<T: Encodable>(_ value: T?) -> String {
        guard let value, let data = try? enc.encode(value) else { return "null" }
        return String(data: data, encoding: .utf8) ?? "null"
    }

    static func nodeLock(for id: String) -> NSLock {
        nodeLocks.lock(for: id)
    }
}

// Per-node write serialization. Entries live for the process lifetime
// (keyed by UUID, bounded by node count) — removal would need its own
// locking and buys nothing at this scale.
private final class NodeLockRegistry {
    private let registry = NSLock()
    private var locks: [String: NSLock] = [:]

    func lock(for id: String) -> NSLock {
        registry.lock()
        defer { registry.unlock() }
        if let lock = locks[id] { return lock }
        let lock = NSLock()
        locks[id] = lock
        return lock
    }
}

private let nodeLocks = NodeLockRegistry()
