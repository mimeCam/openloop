
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import Foundation
import Subprocess

private let log = PrintLog(module: "yolo")

private let execIoLimitBytes = 10 * 1024 * 1024

public func subprocess(
//    _ name: String,
    _ name: FilePath,
    args userArgs: [String],
    chroot: FilePath?,
    stdin: String? = nil,
    env: [String: String]? = nil
) async throws -> String? {
    let verifiedChroot: String?//FilePath?
    if let folder = chroot?.string {
        let exists = PathIO.isDirectoryExistent(atPath: folder)
        assert(exists, "Subprocess fails to spawn with non-existent chroot path. Attempted path: \(folder)")

        verifiedChroot = exists ? folder : nil
    } else {
        verifiedChroot = nil
    }

    func runIt<I: InputProtocol>(
        _ userArgs: [String],
        _ stdin: I
    ) async throws -> String? {
        let environment = toEnvironment(env)
        let res = try await run(
//            executable,
            .path(name),
            arguments: .init(userArgs),
            environment: environment,
            workingDirectory: (verifiedChroot == nil) ? nil : .init(verifiedChroot!),
            input: stdin,
            output: .string(
                limit: execIoLimitBytes, encoding: UTF8.self
            )
        )

        let status = res.terminationStatus
        guard status.isSuccess else {

            let code: Int32
            switch status {
                case .exited(let exitCode):
//                    log.err("Exit code: \(exitCode).")
                    code = exitCode
                case .unhandledException(let excCode):
//                    log.err("Unhandled exception code: \(excCode).")
                    code = excCode
            }

            log.err("stdout: \(res.standardOutput ?? "<none>")")
            log.err("stderr: \(res.standardError)")

            if code == 2 {
                assertionFailure("yolo script error. Check yolo script.")
            } else if code == 127 {
                // Exit code 127 in bash means "command not found".
            } else if code == 258 {
                // Happens often recently: Exit code: 258.
                //  - 258 code means - `wait timeout` or `The wait operation timed out`.
                //  - this is prob due to some MCP tool (devbrain.read_url?) failing in timeout.
                //  - hence 258 can be ignored.
            } else {
                log.err("yolo failed. Code: \(code)")
                assertionFailure("yolo failed.")
                return nil
            }
            //
            // Often output is a valid value, yet exitCode was non-zero.
            //
            return res.standardOutput
        }

        return res.standardOutput
    }

    func callIt() async throws -> String? {
        if let stdin, stdin.notEmpty {
            return try await runIt(
                userArgs,
                .string(stdin)
            )
        } else {
            return try await runIt(userArgs, .none)
        }
    }

    func isExecutionError(_ s: String) -> Bool {
        if s.localizedCaseInsensitiveContains("Execution Error"),
           s.utf8.count < 50 {
            return true
        }

        return false
    }

    let res = try await callIt()

    func singleRetry() async throws -> String? {
        try await Task.sleep(nanoseconds: minsToNanos(2))

        return try await callIt()
    }

    //
    // "Execution error" rseponse:
    // - assuming this was anthropic's error.
    // - retrying up to 4 times (after progressive delays).
    //
    func retry(n: Int, max: Int) async throws -> String? {
        guard n < max else {
//            log.err("Not retrying yolo again. Tried \(n) times already. Max attempts allowed: \(max)")

            return nil
        }

        try await Task.sleep(
//            nanoseconds: minsToNanos(UInt64(n * 2))
            nanoseconds: secsToNanos(30)
        )

        let res = try await callIt()
//        log.err("There was 'Execution error'. After retry:\(n) got: \(res ?? "<NIL>")")

        if let res {
            if isExecutionError(res) {
                return try await retry(n: n + 1, max: max)
            } else if res.isEmpty {
                //
                // Investigate this.
                // - retrying once.
                //
                assertionFailure()

                let res = try await singleRetry()
//                log.err("Ughh, yolo returned a result but it is an empty string. This is unexpected. Retried once. Got: \(res ?? "<NIL>")")
                return res
            } else {
                // Assuming all good.
//                log.info("Good response from yolo: \(res) ... (length:\(res.utf8.count)")
                return res
            }
        } else {
            //
            // Investigate this.
            // - retrying once.
            //
            assertionFailure()

            let res = try await singleRetry()
//            log.err("Strange, yolo returned <NIL>. This is unexpected. Retried once. Got: \(res ?? "<NIL>")")
            return res
        }
    }

    guard let res, isExecutionError(res) == false,
          res.notEmpty, res.utf8.count > 1 else {
        return try await retry(n: 1, max: 10)
    }

    return res
}

private func toEnvironment(_ env: [String: String]?) -> Environment {
    guard let env else { return .inherit }
    var updates: [Environment.Key: String?] = [:]
    for (key, value) in env {
        guard let envKey = Environment.Key(rawValue: key) else { continue }
        updates[envKey] = value
    }
    return .inherit.updating(updates)
}

// MARK: -

/// Subprocess result with its termination status intact — for callers that must know the child died.
public struct ExecOutcome: Sendable {
    public let stdout: String?
    public let stderr: String
    public let exitCode: Int32
    public let success: Bool

    /// stderr + stdout concatenated (skipping empties).
    public var combinedOutput: String {
        [stdout, stderr]
            .compactMap { $0 }
            .filter { $0.notEmpty }
            .joined(separator: "\n")
    }
}

public func execDetailed(
    _ binaryFullPath: String,
    args: [String],
    chroot: String? = nil,
    env: [String: String]? = nil
) async throws -> ExecOutcome {
    let res = try await run(
        .path(.init(binaryFullPath)),
        arguments: .init(args),
        environment: toEnvironment(env),
        workingDirectory: (chroot == nil) ? nil : .init(chroot!),
        output: .string(
            limit: execIoLimitBytes, encoding: UTF8.self
        ),
        error: .string(
            limit: execIoLimitBytes, encoding: UTF8.self
        )
    )

    let code: Int32
    switch res.terminationStatus {
        case .exited(let exitCode):
//            log.err("Exit code: \(exitCode).")
            code = exitCode
        case .unhandledException(let excCode):
//            log.err("Unhandled exception code: \(excCode).")
            code = excCode
    }

    assert(res.standardError != nil, "error: .string capture must always produce a value")

    return ExecOutcome(
        stdout: res.standardOutput,
        stderr: res.standardError ?? "",
        exitCode: code,
        success: res.terminationStatus.isSuccess
    )
}

public func exec(
    _ binaryFullPath: String,
    args: [String],
    chroot: String? = nil,
    env: [String: String]? = nil
) async throws -> String? {
    let res = try await execDetailed(
        binaryFullPath, args: args, chroot: chroot, env: env
    )

    guard res.success else {
        log.err("stdout: \(res.stdout ?? "<none>")")
        log.err("stderr: \(res.stderr)")

//        assertionFailure()
        return res.stdout
    }

    return res.stdout
}
