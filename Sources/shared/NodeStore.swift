//
// Node metadata file store — one `.openloop/nodes/<UUID>.json5` per node.
// Files (not sqlite) so node metadata git-merges across machines; run logs stay in sqlite (GraphStore).
// Byte-stable format: one key per line, snake_case keys = wire format, order declared once in `NodeFile.Field` (identity first, `output` last).
// MCP auth KEYS never live here — per-machine SecretStore keyed by URL; this file keeps only the `mcp_requires_auth` marker.
// `created_at`/`completed_at` are reference-date Doubles; no comments in files; unchanged node ⇒ byte-identical file (git status stays quiet).
// Writes are atomic temp+rename; `mutate` serializes read-modify-write per-node.
// Corrupt file ⇒ skip + warn, keep the rest; filename wins over a disagreeing inner id.
//

import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

private let nodeLog = PrintLog(module: "node-store")

/// Codable twin of `GraphNode`; key set and serialization order declared once in `Field` below.
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
    /// Repo-traveling marker: endpoint requires an auth key (the key itself lives in SecretStore, keyed by `mcp`).
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

    /// `rawValue` is the disk/wire spelling; case order IS the serialization order — the merge-stability layout.
    fileprivate enum Field: String, CaseIterable, Sendable {
        case id, parentId = "parent_id", createdAt = "created_at", agent, took
        case completedAt = "completed_at", name, summary, prompt, status
        case active, personas, mcp, mcpRequiresAuth = "mcp_requires_auth", output
    }

    // Tolerant decode for `personas`/`active`/`mcp_requires_auth`; identity fields stay mandatory.
    // Trap: `dec` uses .convertFromSnakeCase, so case names must be the POST-conversion camelCase spelling.
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

    /// Single read-modify-write entry point; no-op on missing file (SQL UPDATE parity).
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

    /// Deterministic `(createdAt, id)` order — columns never shuffle between polls when timestamps tie.
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

    // Unknown on-disk keys would be silently dropped by the next mutate rewrite — DEBUG fails loudly at first read instead.
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

    // Decoding `[String: Present]` yields exactly the object's key set — `Present.init(from:)` reads no value.
    private enum Present: Decodable {
        case any
        init(from decoder: Decoder) throws { self = .any }
    }

    static func unknownKeys(in data: Data) -> [String] {
        guard let keys = try? dec.decode([String: Present].self, from: data) else { return [] }
        let known = Set(NodeFile.Field.allCases.map(\.rawValue))
        return keys.keys.filter { !known.contains($0) }.sorted()
    }

    /// Atomic temp+rename; skips the write when bytes are unchanged (byte-stability: mtime preserved, git quiet).
    static func write(_ file: NodeFile, at instancePath: String) throws {
        let fp = filePath(id: file.id, at: instancePath)
        let data = Data(jsonText(file).utf8)
        if let existing = FileManager.default.contents(atPath: fp.string), existing == data { return }
        try data.write(to: URL(fileURLWithPath: fp.string), options: .atomic)
    }

    // Deterministic serializer: JSONEncoder's key order is unspecified hash order; `.sortedKeys` is stable but alphabetical ≠ merge-stability layout.
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

    // Field→value mapping is a switch: a new Field case without an arm here is a compile error, not a dropped key.
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

    // Debug tripwire: re-decode what we just serialized and demand equality — catches a property that never got a Field case.
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

// Per-node write serialization; entries live for the process lifetime (keyed by UUID, bounded by node count).
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
