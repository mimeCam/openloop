//
// SecretStore — `.openloop/secrets.json5`: per-machine MCP authorization
// keys, keyed by endpoint URL.
//
// Why a separate file: node files are COMMITTED on purpose (the graph
// travels with the repo — the entire point of the file store), so a secret
// must never live in one. Here instead: one flat map, URL → Authorization
// header value, resolved at run-config time by URL (dedup for free — two
// nodes on one endpoint share one key, and setting it once fixes both).
//
// Properties:
// - gitignored: `prepareFolders` writes `secrets.json5` into
//   `.openloop/.gitignore` (and patches older instances) — a public repo
//   must never see a key.
// - 0600 from birth: the temp file is created owner-only, then rename(2)'d
//   over the destination — no world-readable window, no torn file. A
//   hand-created file with looser perms is tightened on first read.
// - Deterministic bytes (sorted keys, one per line): inspection is stable
//   and a no-change write never touches the file.
//
// Split with node files: node files carry only the `mcp_requires_auth`
// marker (repo-traveling hint "this endpoint requires a key"); whether
// THIS machine actually holds the key is answered by this file at read time
// (`mcp_auth_local` on the wire). Clone on a new machine → marker true,
// local false → the UI says "set the key here". No migration code ships:
// the pre-split plaintext era was never distributed — its values were
// moved into this file by hand when the split landed.
//
// Corrupt-file policy: reads stay alive (warn once per path, return empty;
// DEBUG traps via assertionFailure — a silent empty here would strip auth
// headers from runs). A subsequent write then replaces the file wholesale;
// it is machine-owned, and the warn already named it.
//

import Foundation
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

private let secretLog = PrintLog(module: "secret-store")

private let secretFilePermissions = 0o600

public struct SecretStore {

    public static func secretsPath(at instancePath: String) -> FilePath {
        FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("secrets.\(json)")
    }

    /// Tolerant read for the MISSING case only: no file → empty map (fresh
    /// clone — legitimate). A file that EXISTS but cannot be read or decoded
    /// is a broken machine state, not a fresh state: warn once per path (the
    /// 5s graph poll reads this on every GET) and trap in DEBUG — silently
    /// returning `[:]` here would strip auth headers from runs.
    public static func load(at instancePath: String) -> [String: String] {
        let fp = secretsPath(at: instancePath)
        guard PathIO.isFileExistent(atPath: fp.string) else { return [:] }
        guard let data = FileManager.default.contents(atPath: fp.string) else {
            assertionFailure("secrets file exists but is unreadable: \(fp.string)")
            warnOnce("secrets file exists but is unreadable: \(fp.string)")
            return [:]
        }
        guard let map = try? secretDec.decode([String: String].self, from: data) else {
            assertionFailure("undecodable secrets file: \(fp.string)")
            warnOnce("skipping undecodable secrets file: \(fp.string)")
            return [:]
        }
        tightenPermissions(of: fp)
        return map
    }

    public static func secret(for url: String, at instancePath: String) -> String? {
        load(at: instancePath)[url]
    }

    /// Set (`value` non-empty) or remove (nil/empty) the key for one URL.
    /// No write when the stored value already matches — same byte-stability
    /// rule as NodeStore. The file disappears when the last entry goes.
    public static func setSecret(_ value: String?, for url: String, at instancePath: String) throws {
        var map = load(at: instancePath)
        let newValue = (value?.notEmpty == true) ? value : nil
        guard map[url] != newValue else { return }
        if let newValue { map[url] = newValue } else { map.removeValue(forKey: url) }
        try write(map, at: instancePath)
    }
}

private extension SecretStore {

    static func write(_ map: [String: String], at instancePath: String) throws {
        let fp = secretsPath(at: instancePath)
        guard !map.isEmpty else {
            if PathIO.isFileExistent(atPath: fp.string) {
                try FileManager.default.removeItem(atPath: fp.string)
            }
            return
        }
        guard let body = try? secretEnc.encode(map) else {
            throw secretError("Cannot encode secrets file: \(fp)", code: 1)
        }
        try writeAtomic0600(body + Data("\n".utf8), to: fp)
    }

    // Owner-only from birth: create the temp file with 0600, then rename(2)
    // over the destination — atomic (no torn file) with no world-readable
    // window. Crash leftovers are `<uuid>.tmp` — gitignored via `*.tmp`.
    static func writeAtomic0600(_ data: Data, to fp: FilePath) throws {
        let tmp = FilePath("\(fp.string).\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(atPath: tmp.string) }
        guard FileManager.default.createFile(
            atPath: tmp.string, contents: data,
            attributes: [.posixPermissions: secretFilePermissions]
        ) else {
            throw secretError("Cannot create secrets tmp file: \(tmp)", code: 2)
        }
        guard rename(tmp.string, fp.string) == 0 else {
            throw secretError("Cannot replace secrets file \(fp): \(String(cString: strerror(errno)))", code: 3)
        }
    }

    // A hand-created file (vi, a sync tool) may arrive world-readable —
    // tighten it on first read; the warn teaches the 0600 rule.
    static func tightenPermissions(of fp: FilePath) {
        guard let perms = (try? FileManager.default.attributesOfItem(atPath: fp.string))?[.posixPermissions] as? Int,
              perms & 0o777 != secretFilePermissions else { return }
        do {
            try FileManager.default.setAttributes([.posixPermissions: secretFilePermissions], ofItemAtPath: fp.string)
        } catch {
            assertionFailure("cannot tighten \(fp.string) to 0600: \(error)")
        }
        warnOnce("tightened \(fp.lastComponent?.string ?? fp.string) to owner-only (0600)")
    }

    static func secretError(_ msg: String, code: Int) -> NSError {
        NSError(
            domain: "openloop.secret-store", code: code,
            userInfo: [NSLocalizedDescriptionKey: msg]
        )
    }

    static func warnOnce(_ msg: String) {
        secretWarnRegistry.warnOnce(msg)
    }
}

// Flat URL→secret map: `.sortedKeys` is byte-stable and alphabetical IS
// the wanted order here (unlike node files, a flat key set carries no
// field-order semantics worth hand-rolling a serializer for). No key
// coding strategy on either codec — URL keys must round-trip verbatim
// (snake_case conversion would rewrite "my_host" → "myHost").
private let secretEnc: JSONEncoder = {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys]
    return enc
}()

private let secretDec: JSONDecoder = {
    let dec = JSONDecoder()
    dec.allowsJSON5 = true
    return dec
}()

// The graph poll reads the secrets file on every GET — a corrupt file
// must warn once, not every 5 seconds. Registry-guarded like NodeStore's
// lock map (worst-case race = a doubled line, never a crash).
private final class WarnOnceRegistry {
    private let registry = NSLock()
    private var messages: Set<String> = []

    func warnOnce(_ msg: String) {
        registry.lock()
        let first = !messages.contains(msg)
        if first { messages.insert(msg) }
        registry.unlock()
        if first { secretLog.warn(msg) }
    }
}

private let secretWarnRegistry = WarnOnceRegistry()