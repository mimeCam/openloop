//

import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

public struct InstanceState: Codable {

    public let lastLoopAt: Double
    public let activeRunningWorkflows: Int
    public let inactiveWorkflows: Int
    public let pid: Int

    public init(
        lastLoopAt: Double,
        activeRunningWorkflows: Int,
        inactiveWorkflows: Int,
        pid: Int
    ) {
        self.lastLoopAt = lastLoopAt
        self.activeRunningWorkflows = activeRunningWorkflows
        self.inactiveWorkflows = inactiveWorkflows
        self.pid = pid
    }

}

public struct Workflow: Codable {

    public let name: String
    public let desc: String
    public let everySecs: Int
    public let agent: String
    public let ask: String
    public let levels: [[String]]

    public init(name: String, desc: String, everySecs: Int, agent: String, ask: String, levels: [[String]]) {
        self.name = name
        self.desc = desc
        self.everySecs = everySecs
        self.agent = agent
        self.ask = ask
        self.levels = levels
    }
}

public struct WorkflowResult: Codable {
}

// MARK: -

public struct Persona: Codable {
    public let name: String
    public let role: String
    public let about: String
    public let task: String
    public let avatar: String?
    public let agent: String?

    public init(
        name: String, role: String, about: String, task: String,
        avatar: String?, agent: String?
    ) {
        self.name = name
        self.role = role
        self.about = about
        self.task = task
        self.avatar = avatar
        self.agent = agent
    }
}

// MARK: -

public struct RunLog: Codable {
    public let success: Bool
    public let took: Int
    public let startedAt: Double
    public let endedAt: Double

    public let workflowId: String
    public let personaId: String?

    public let agent: String
    public let msg: Message
    public let session: String?
    public let level: Int?

    public struct Message: Codable {
        public let input: String
        public let output: String
        public let parents: [Parent]

        public init(
            input: String, output: String,
            parents: [Parent]
        ) {
            self.input = input
            self.output = output
            self.parents = parents
        }

        public struct Parent: Codable {
            public let id: String // Persona-ID (of the parent persona) when `runner` executes a Persona. Workflow-ID when `openloop` executes a workflow.
            public let text: String

            public init(id: String, text: String) {
                self.id = id
                self.text = text
            }
        }
    }

    public init(
        success: Bool,
        took: Int, startedAt: Double, endedAt: Double,
        workflowId: String, personaId: String?,
        agent: String, msg: Message,
        session: String? = nil,
        level: Int? = nil
    ) {
        self.success = success
        self.took = took
        self.startedAt = startedAt
        self.endedAt = endedAt

        self.workflowId = workflowId
        self.personaId = personaId

        self.agent = agent
        self.msg = msg
        self.session = session
        self.level = level
    }

}

/// NOTE: -  The only difference between PersonaRunLog and WorkflowRunLog is ID what goes into `parents.[idx].id`.
public typealias PersonaRunLog = RunLog
public typealias WorkflowRunLog = RunLog

/// One row per TOP-LEVEL workflow run ending (nested levels reuse the session
/// and never write here). Feeds per-instance notifications.
/// Time contract: `startedAt`/`endedAt` are reference-date Doubles (like
/// `logs.started_at`); convert to unix ms only at the API edge.
public struct RunEnd: Sendable {

    public let session: String
    public let workflowId: String
    public let success: Bool
    public let took: Int
    public let startedAt: Double
    public let endedAt: Double

    public init(
        session: String,
        workflowId: String,
        success: Bool,
        took: Int,
        startedAt: Double,
        endedAt: Double
    ) {
        self.session = session
        self.workflowId = workflowId
        self.success = success
        self.took = took
        self.startedAt = startedAt
        self.endedAt = endedAt
    }
}
