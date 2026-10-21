//
// SecretStore — `.openloop/secrets.json5`: per-machine MCP authorization keys, keyed by endpoint URL.
// Node files are committed on purpose, so a secret must never live in one; one flat map here instead (dedup: one key serves every node on a URL).
// Gitignored (prepareFolders patches `.openloop/.gitignore`); 0600 from birth; deterministic sorted bytes.
// Split with node files: nodes carry only the `mcp_requires_auth` marker; whether THIS machine holds the key is answered here at read time.
// Corrupt file ⇒ warn once per path, return empty, DEBUG traps; the file disappears when the last entry goes.
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

    /// Missing file → empty map (fresh clone); EXISTING but unreadable/undecodable → warn once + DEBUG trap.
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

    /// Set (non-empty) or remove (nil/empty) the key for one URL; no write when unchanged (byte-stability, as NodeStore).
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

    // Owner-only from birth: temp file 0600, then rename(2) over the destination — atomic, no world-readable window.
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

    // A hand-created file may arrive world-readable — tighten it on first read.
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

// Flat URL→secret map: `.sortedKeys` is byte-stable and alphabetical IS the wanted order here.
// No key coding strategy on either codec — URL keys must round-trip verbatim (snake_case would rewrite "my_host" → "myHost").
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

// The graph poll reads the secrets file on every GET — a corrupt file must warn once, not every 5 seconds.
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