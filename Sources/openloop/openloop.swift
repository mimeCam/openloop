
import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import Dispatch
import shared
import ArgumentParser

private let log = PrintLog(module: "openloop")

@main
struct openloop: ParsableCommand {

    func run() throws {
        Task.detached {
            do {
                try await prepare()

                if try await detectDuplicateInstance() { return }

                func openControlFlightWeb() async {
                    let success = try? await exec(
                        "/usr/bin/open",
                        args: ["http://localhost:54321"]
                    )
                    if success == nil {
                        _ = try? await exec(
                            "/usr/bin/xdg-open",
                            args: ["http://localhost:54321"]
                        )

                        log.info("Open control-plane in the browser: http://localhost:54321")
                    }
                }
//                await openControlFlightWeb() // Disabled ffs

                while true {
                    try await loop()

                    try await Task.sleep(
                        nanoseconds: loopIntervalSecs * 1_000_000_000
                    )
                }
            } catch {
                openloop.exit(withError: error)
            }
        }

        dispatchMain()
    }
}

private func prepare() async throws {
    Paths.exitIfLegacyDataFolderExists()

    prepareFolders()

    try await Launcher.registerWorker(
        workingDirectory: Paths.curDir,
        binaryPath: Paths.bin.appending("openloop")
    )
}

private let dotGitignoreContent = """
*.log
logs*
state.json5
*.tmp
secrets.json5
"""

private func prepareFolders() {
    let created0 = PathIO.createDirectoryIfNotExists(
        atPath: Paths.bin.string
    )
    assert(created0)

    let curDirOpenloop = Paths.curDir.appending(Paths.dataFolderName)
    let created10 = PathIO.createDirectoryIfNotExists(
        atPath: curDirOpenloop.string
    )
    assert(created10)

    let gitignorePath = curDirOpenloop.appending(".gitignore")
    if !PathIO.isFileExistent(atPath: gitignorePath.string) {
        let createdGitignore = FileManager.default.createFile(
            atPath: gitignorePath.string,
            contents: Data(dotGitignoreContent.utf8)
        )
        assert(createdGitignore)
    } else {
        // Older instances: patch in `*.tmp` (node-store atomic-write debris)
        // and `secrets.json5` (per-machine MCP auth keys — must never be
        // committed) without touching user-added lines.
        ensureGitignoreLine("*.tmp", at: gitignorePath)
        ensureGitignoreLine("secrets.json5", at: gitignorePath)
    }

    let created11 = PathIO.createDirectoryIfNotExists(
        atPath: curDirOpenloop.appending("workflows").string
    )
    assert(created11)
    let created12 = PathIO.createDirectoryIfNotExists(
        atPath: curDirOpenloop.appending("personas").string
    )
    assert(created12)
    let created13 = PathIO.createDirectoryIfNotExists(
        atPath: curDirOpenloop.appending("knowledge").string
    )
    assert(created13)
    let created14 = PathIO.createDirectoryIfNotExists(
        atPath: curDirOpenloop.appending("bin").string
    )
    assert(created14)
    let created15 = PathIO.createDirectoryIfNotExists(
        atPath: curDirOpenloop.appending("nodes").string
    )
    assert(created15)

    // Global (Paths.share) data folder support disabled — re-enable by uncommenting.
    // let shareOpenloop = Paths.share.appending("openloop")
    // let created20 = PathIO.createDirectoryIfNotExists(
    //     atPath: shareOpenloop.string
    // )
    // assert(created20)
    // let created21 = PathIO.createDirectoryIfNotExists(
    //     atPath: shareOpenloop.appending("workflows").string
    // )
    // assert(created21)
    // let created22 = PathIO.createDirectoryIfNotExists(
    //     atPath: shareOpenloop.appending("personas").string
    // )
    // assert(created22)
    // let created23 = PathIO.createDirectoryIfNotExists(
    //     atPath: shareOpenloop.appending("knowledge").string
    // )
    // assert(created23)
}

private let loopIntervalSecs: UInt64 = 60

/// Append `line` to an existing `.openloop/.gitignore` if it is not there
/// yet. Read-check-append — never rewrites content the user added.
private func ensureGitignoreLine(_ line: String, at path: FilePath) {
    guard let text = try? String(contentsOfFile: path.string, encoding: .utf8) else { return }
    guard !text.split(separator: "\n").map(String.init).contains(line) else { return }
    let patched = text.hasSuffix("\n") ? text + line + "\n" : text + "\n" + line + "\n"
    try? patched.write(toFile: path.string, atomically: true, encoding: .utf8)
}

private func detectDuplicateInstance() async throws -> Bool {
    guard let existing = try await FileLoader.loadInstanceState(at: Paths.curDir.string) else {
        return false
    }

    let elapsed = Date().timeIntervalSinceReferenceDate - existing.lastLoopAt
    guard elapsed < Double(loopIntervalSecs + 10) else {
        return false
    }

    let tsBefore = existing.lastLoopAt

    try await Task.sleep(nanoseconds: (loopIntervalSecs + 10) * 1_000_000_000)

    guard let recheck = try await FileLoader.loadInstanceState(at: Paths.curDir.string) else {
        return false
    }

    if recheck.lastLoopAt != tsBefore {
        log.warn("Another openloop instance is active (pid \(recheck.pid)). Exiting.")
        return true
    }

    return false
}

private func checkDuplicateInLoop() async throws -> Bool {
    guard let existing = try await FileLoader.loadInstanceState(at: Paths.curDir.string) else {
        return false
    }

    let myPid = ProcessInfo.processInfo.processIdentifier
    let elapsed = Date().timeIntervalSinceReferenceDate - existing.lastLoopAt

    if existing.pid != Int(myPid) && elapsed < Double(loopIntervalSecs + 10) {
        log.warn("Another openloop instance is active (pid \(existing.pid)). Exiting.")
        return true
    }

    return false
}

public func isRunOnceWorkflow(_ w: Workflow) -> Bool {
    w.everySecs == -1
}

private func loop() async throws {
    if try await checkDuplicateInLoop() { Foundation.exit(0) }

    let all = try await readWorkflows()

    if all.isEmpty {
        log.info("Open http://localhost:54321 to create or edit workflows. Currently have 0.")
    }

    var skipped = 0
    for (id, w) in all {
        if isRunOnceWorkflow(w) {
            if await state.launchedOnce(id) {
                continue
            }
        } else {
            guard w.everySecs > 0 else {
                skipped += 1
                continue
            }

            if await state.isRunning(id) {
                continue
            }
            let last = await state.lastLaunch(id)
            guard Int(Date().timeIntervalSince(last)) > w.everySecs else {
                continue
            }
        }

        await state.markLaunched(id)
        if isRunOnceWorkflow(w) {
            await state.markLaunchedOnce(id)
        }
        Task.detached {
            defer {
                Task {
                    await state.markCompleted(id)
                }
            }

            _ = try await runWorkflow(id, w)
        }
    }

    if skipped > 0 {
        log.info("Skipped \(skipped) manual workflows (everySecs = 0)")
    }

    try await FileLoader.saveInstaneState(
        InstanceState(
            lastLoopAt: Date().timeIntervalSinceReferenceDate,
            activeRunningWorkflows: await state.countRunnint(),
            inactiveWorkflows: skipped,
            pid: Int(ProcessInfo.processInfo.processIdentifier)
        )
    )
}

private func runWorkflow(
    _ id: String, _ w: Workflow
) async throws -> WorkflowResult? {
    log.info("Start workflow: \(id)")

    let res = try await subprocess(
        FilePath(NSHomeDirectory())
            .appending(".local")
            .appending("bin")
            .appending("openloop-runner"),
        args: [id, w.ask],
        chroot: .init(Paths.curDir)
    )

    guard let res, res.notEmpty else {
        assertionFailure("Workflow returned empty or no response: \(id)")
        return nil
    }

    log.info("Workflow \(id): \(res)")

    return nil
}

private let state = State()

private final actor State {

    func isRunning(_ id: String) -> Bool {
        running.contains(id)
    }

    func lastLaunch(_ id: String) -> Date {
        ts[id] ?? Date.distantPast
    }

    func markLaunched(_ id: String) {
        running.insert(id)
        ts[id] = Date()
    }

    func markCompleted(_ id: String) {
        running.remove(id)
    }

    func countRunnint() -> Int {
        running.count
    }

    func launchedOnce(_ id: String) -> Bool {
        launchedOnceSet.contains(id)
    }

    func markLaunchedOnce(_ id: String) {
        launchedOnceSet.insert(id)
    }

    private var running: Set<String> = []
    private var ts: [String : Date] = [:]
    private var launchedOnceSet: Set<String> = []

}

private func readWorkflows() async throws -> [String: Workflow] {
    let root = Paths.curDir.appending(Paths.dataFolderName).appending("workflows")

    struct IdAndPath {
        let id: String
        let path: FilePath
    }

    var idAndPaths: [IdAndPath] = []
    let files = try PathIO.contentsOfDirectory(atPath: root.string)
    for file in files {
        let parts = file.components(separatedBy: ".")
        guard parts.count == 2, parts.last == shared.json, let id = parts.first else {
            continue
        }
        let path = root.appending(file)
        guard PathIO.isFileExistent(atPath: path.string) else {
            continue
        }
        idAndPaths.append(IdAndPath(id: id, path: path))
    }

    var result: [String: Workflow] = [:]
    for idAndPath in idAndPaths {
        let w: Workflow
        do {
            w = try await FileLoader.loadWorkflowAtPath(idAndPath.path)
        } catch {
            throw ValidationError("Workflow '\(idAndPath.id)' at: \(idAndPath.path) has invalid JSON. Error: \(error.localizedDescription)")
        }

        result[idAndPath.id] = w
    }

    return result
}
