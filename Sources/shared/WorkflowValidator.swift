#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import Foundation
import ArgumentParser

public struct WorkflowValidationError: Sendable {
    public let path: [String]
    public let message: String

    public init(path: [String], message: String) {
        self.path = path
        self.message = message
    }

    public var description: String {
        if path.isEmpty { return message }
        return "Inner workflow " + path.joined(separator: " \u{2192} ") + ": " + message
    }
}

public struct WorkflowValidator {

    private static let maxDepth = 10

    public static func validate(
        workflowId: String,
        ask: String? = nil,
        roots: [FilePath],
        visited: Set<String> = [],
        depth: Int = 0
    ) async -> [WorkflowValidationError] {
        if depth > maxDepth {
            return [.init(path: [], message: "Maximum workflow nesting depth (\(maxDepth)) exceeded")]
        }
        if visited.contains(workflowId) {
            return [.init(path: [], message: "Circular dependency: \(workflowId)")]
        }

        let workflow: Workflow
        do {
            guard let w = try await loadWorkflow(workflowId, in: roots) else {
                return [.init(path: [], message: "Workflow not found: \"\(workflowId)\"")]
            }
            workflow = w
        } catch {
            return [.init(path: [], message: "Failed to load workflow \"\(workflowId)\": \(error.localizedDescription)")]
        }

        var errors: [WorkflowValidationError] = []

        let hasAsk = (ask?.notEmpty == true) || workflow.ask.notEmpty
        if !hasAsk {
            errors.append(.init(path: [], message: "No task description (ask) provided and workflow has no default"))
        }

        if !workflow.agent.notEmpty {
            errors.append(.init(path: [], message: "Workflow has empty \"agent\" value"))
        } else {
            let agentName = "openloop_\(workflow.agent)"
            if !PathIO.isFileExistent(atPath: Paths.bin.appending(agentName).string) {
                errors.append(.init(path: [], message: "Agent \"\(agentName)\" not found"))
            }
        }

        var nextVisited = visited
        nextVisited.insert(workflowId)
        let effectiveAsk = (ask?.notEmpty == true) ? ask : (workflow.ask.notEmpty ? workflow.ask : nil)

        for level in workflow.levels where level.notEmpty {
            for entry in level where entry.notEmpty {
                if entry.hasPrefix(":") {
                    let innerId = String(entry.trimmingPrefix(":"))
                    let innerErrors = await validate(
                        workflowId: innerId,
                        ask: effectiveAsk,
                        roots: roots,
                        visited: nextVisited,
                        depth: depth + 1
                    )
                    errors.append(contentsOf: innerErrors.map { e in
                        .init(
                            path: ["\"\(innerId)\""] + e.path,
                            message: e.message
                        )
                    })
                } else {
                    let personaId = stripRWSuffix(entry)
                    errors.append(contentsOf: await validatePersona(personaId, roots: roots))
                }
            }
        }

        return errors
    }

    private static func validatePersona(
        _ id: String, roots: [FilePath]
    ) async -> [WorkflowValidationError] {
        let persona: Persona
        do {
            guard let p = try await loadPersona(id, in: roots) else {
                return [.init(path: [], message: "Persona not found: \"\(id)\"")]
            }
            persona = p
        } catch {
            return [.init(path: [], message: "Failed to load persona \"\(id)\": \(error.localizedDescription)")]
        }

        if !isProjectBinAgent(persona.agent, roots: roots) {
            if !knowledgePathExists(for: id, roots: roots) {
                return [.init(path: [], message: "Persona \"\(id)\": no knowledge folder found (expected \(Paths.dataFolderName)/knowledge/\(id))")]
            }
        }
        return []
    }

    private static func isProjectBinAgent(_ agentName: String?, roots: [FilePath]) -> Bool {
        guard let pa = agentName, pa.notEmpty else { return false }
        let shortName = String(pa.trimmingPrefix("openloop_"))
        return roots.contains { dir in
            PathIO.isFileExistent(atPath: dir.appending(Paths.dataFolderName).appending("bin").appending(shortName).string)
        }
    }

    private static func knowledgePathExists(for id: String, roots: [FilePath]) -> Bool {
        for root in roots {
            let path = root.appending(Paths.dataFolderName).appending("knowledge").appending(id)
            if PathIO.isDirectoryExistent(atPath: path.string) { return true }
        }
        // Last-resort lookup: user-global (system-wide) knowledge.
        let share = Paths.globalOpenloop.appending("knowledge").appending(id)
        return PathIO.isDirectoryExistent(atPath: share.string)
    }

    private static func loadWorkflow(_ id: String, in roots: [FilePath]) async throws -> Workflow? {
        let fileName = "\(id).\(json)"
        for root in roots {
            let fp = root.appending(Paths.dataFolderName).appending("workflows").appending(fileName)
            if PathIO.isFileExistent(atPath: fp.string) {
                return try await FileLoader.loadWorkflowAtPath(fp)
            }
        }
        // Last-resort lookup: user-global (system-wide) workflows.
        let gfp = Paths.globalOpenloop.appending("workflows").appending(fileName)
        if PathIO.isFileExistent(atPath: gfp.string) {
            return try await FileLoader.loadWorkflowAtPath(gfp)
        }
        return nil
    }

    private static func loadPersona(_ id: String, in roots: [FilePath]) async throws -> Persona? {
        let fileName = "\(id).\(json)"
        for root in roots {
            let fp = root.appending(Paths.dataFolderName).appending("personas").appending(fileName)
            if PathIO.isFileExistent(atPath: fp.string) {
                return try await FileLoader.loadPersonaAtPath(fp)
            }
        }
        // Last-resort lookup: user-global (system-wide) personas.
        let gfp = Paths.globalOpenloop.appending("personas").appending(fileName)
        if PathIO.isFileExistent(atPath: gfp.string) {
            return try await FileLoader.loadPersonaAtPath(gfp)
        }
        return nil
    }

    private static func stripRWSuffix(_ input: String) -> String {
        if input.hasSuffix(":rw"), input.count > 3 {
            return String(input.dropLast(3))
        }
        return input
    }
}
