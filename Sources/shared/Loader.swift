//

#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import Foundation
import ArgumentParser

public struct FileLoader { }

public extension FileLoader {

    static func saveInstaneState(_ state: InstanceState) async throws {
        let data = try enc.encode(state)

        let fp = Paths.curDir
            .appending(Paths.dataFolderName)
            .appending("state.\(json)")

        guard await File(fp.string).write(data) else {
            throw ValidationError("Failed to write state to file: \(fp.string)")
        }
    }

    static func loadInstanceState(at instancePath: String) async throws -> InstanceState? {
        let fp = FilePath(instancePath)
            .appending(Paths.dataFolderName)
            .appending("state.\(json)")

        let exists = PathIO.isFileExistent(atPath: fp.string)

        guard exists else {
            return nil
        }

        do {
            return try await loadAtPath(fp)
        } catch {
            try? FileManager.default.removeItem(atPath: fp.string)
            throw error
        }
    }

    static func saveRunLog(
        _ log: RunLog, at instancePath: String
    ) async throws {
        let maxRetries = 3
        for attempt in 1...maxRetries {
            do {
                try LogManager.saveLog(
                    log, at: instancePath
                )
                return
            } catch {
                if attempt == maxRetries { throw error }
                try await Task.sleep(for: .milliseconds(100 * attempt))
            }
        }
    }

    static func savePersona(_ persona: Persona, at fp: FilePath) async throws {
        let data = try enc.encode(persona)

        guard await File(fp.string).write(data) else {
            throw ValidationError("Failed to write persona to file: \(fp.string)")
        }
    }

    static func saveWorkflow(_ workflow: Workflow, at fp: FilePath) async throws {
        let data = try enc.encode(workflow)

        guard await File(fp.string).write(data) else {
            throw ValidationError("Failed to write workflow to file: \(fp.string)")
        }
    }

    static func loadWorkflowById(_ id: String) async throws -> Workflow? {
        func tryLoad(in root: FilePath) async throws -> Workflow? {
            let fp = root
                .appending(Paths.dataFolderName).appending("workflows")
                .appending("\(id).\(json)")
            guard PathIO.isFileExistent(atPath: fp.string) else {
                return nil
            }

            return try await loadWorkflowAtPath(fp)
        }

        for dir in Paths.dirsToHome() {
            if let w = try await tryLoad(in: dir) {
                return w
            }
        }
        // Global workflow support (~/.local/share/openloop) disabled — re-enable by uncommenting.
        // let gfp = Paths.share.appending("openloop").appending("workflows").appending("\(id).\(json)")
        // if PathIO.isFileExistent(atPath: gfp.string) {
        //     return try await loadWorkflowAtPath(gfp)
        // }

        return nil
    }

    static func loadPersonById(_ id: String) async throws -> Persona? {
        func tryLoad(in root: FilePath) async throws -> Persona? {
            let fp = root
                .appending(Paths.dataFolderName).appending("personas")
                .appending("\(id).\(json)")
            guard PathIO.isFileExistent(atPath: fp.string) else {
                return nil
            }

            return try await loadPersonaAtPath(fp)
        }

        for dir in Paths.dirsToHome() {
            if let p = try await tryLoad(in: dir) {
                return p
            }
        }
        // Global persona support (~/.local/share/openloop) disabled — re-enable by uncommenting.
        // let gfp = Paths.share.appending("openloop").appending("personas").appending("\(id).\(json)")
        // if PathIO.isFileExistent(atPath: gfp.string) {
        //     return try await loadPersonaAtPath(gfp)
        // }

        return nil
    }

    static func loadPersonaAtPath(_ fp: FilePath) async throws -> Persona {
        try await loadAtPath(fp)
    }

    static func loadWorkflowAtPath(_ fp: FilePath) async throws -> Workflow {
        try await loadAtPath(fp)
    }


}

private func loadAtPath<T: Decodable>(_ fp: FilePath) async throws -> T {
    guard let data = await File(fp.string).read(), data.notEmpty else {
        assertionFailure("Failed to read json file contents: \(fp.string)")
        throw ValidationError("Failed to read json file contents: \(fp.string)")
//        return nil
    }

    do {
        return try dec.decode(T.self, from: data)
    } catch {
        throw ValidationError("\(error)\nFailed to read parse JSON file at: \(fp.string)")
    }
}

private let dec: JSONDecoder = {
    let dec = JSONDecoder()

    dec.keyDecodingStrategy = .convertFromSnakeCase
    dec.allowsJSON5 = true // https://developer.apple.com/documentation/foundation/jsondecoder/allowsjson5

    return dec
}()

private let enc: JSONEncoder = {
    let enc = JSONEncoder()
    enc.keyEncodingStrategy = .convertToSnakeCase
    enc.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
    return enc
}()

public let json = "json5"
