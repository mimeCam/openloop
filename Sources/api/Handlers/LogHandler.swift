import Vapor
import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import shared

struct LogHandler: Sendable {
    
    func getPersonaLogs(req: Request) async throws -> PersonaLogsResponse {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let personaId = req.query[String.self, at: "personaId"]
        let offset = req.query[Int.self, at: "offset"] ?? 0
        let count = req.query[Int.self, at: "count"] ?? 5

        var logs: [PersonaLogEntry] = []
        var stats: [String: PersonaStats] = [:]

        do {
            try LogManager.createTables(at: instancePath)
            let runLogs = try LogManager.fetchLogs(
                instancePath: instancePath,
                personaId: personaId,
                offset: offset,
                limit: count
            )

            for log in runLogs {
                let startDate = Date(timeIntervalSinceReferenceDate: log.startedAt)
                let endDate = Date(timeIntervalSinceReferenceDate: log.endedAt)
                let startedAtUnixMs = Int64(startDate.timeIntervalSince1970 * 1000)
                let endedAtUnixMs = Int64(endDate.timeIntervalSince1970 * 1000)

                let logEntry = PersonaLogEntry(
                    success: log.success,
                    took: log.took,
                    started_at: startedAtUnixMs,
                    ended_at: endedAtUnixMs,
                    id: log.workflowId,
                    workflowId: log.workflowId,
                    personaId: log.personaId,
                    agent: log.agent,
                    msg: PersonaLogMessage(
                        input: log.msg.input,
                        output: log.msg.output,
                        parents: log.msg.parents.map { p in
                            PersonaLogParent(id: p.id, text: p.text)
                        }
                    )
                )
                logs.append(logEntry)

                if let personaId = log.personaId {
                    if stats[personaId] == nil {
                        stats[personaId] = PersonaStats(errors: 0, success: 0, total: 0)
                    }
                    stats[personaId]?.total += 1
                    if log.success {
                        stats[personaId]?.success += 1
                    } else {
                        stats[personaId]?.errors += 1
                    }
                }
            }
        } catch {
            req.logger.error("Failed to fetch logs: \(error)")
        }

        let total = (try? LogManager.countLogs(
            instancePath: instancePath,
            personaId: personaId
        )) ?? 0
        let safeOffset = max(0, offset)

        return PersonaLogsResponse(
            instance_id: instancePath,
            logs: logs,
            stats: stats,
            offset: safeOffset,
            count: count,
            total: total
        )
    }
    
    func getSessionLogs(req: Request) async throws -> SessionLogsResponse {
        guard let rawInstancePath = req.parameters.get("id") else { throw Abort(.badRequest) }
        guard let rawSession = req.parameters.get("session") else { throw Abort(.badRequest) }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let session = rawSession.removingPercentEncoding ?? rawSession

        var logs: [SessionLogEntry] = []
        do {
            try LogManager.createTables(at: instancePath)
            let runLogs = try LogManager.fetchLogsBySession(instancePath: instancePath, session: session)
            logs = runLogs.map { toSessionLogEntry($0) }
        } catch {
            req.logger.error("Failed to fetch session logs: \(error)")
        }

        let levels = extractLevels(from: logs)
        return SessionLogsResponse(instance_id: instancePath, session: session, levels: levels, logs: logs)
    }

    private func toSessionLogEntry(_ log: RunLog) -> SessionLogEntry {
        let startedAtMs = Int64(Date(timeIntervalSinceReferenceDate: log.startedAt).timeIntervalSince1970 * 1000)
        let endedAtMs = Int64(Date(timeIntervalSinceReferenceDate: log.endedAt).timeIntervalSince1970 * 1000)
        return SessionLogEntry(
            success: log.success, took: log.took,
            started_at: startedAtMs, ended_at: endedAtMs,
            id: log.workflowId, workflowId: log.workflowId,
            personaId: log.personaId, agent: log.agent,
            level: log.level, session: log.session,
            msg: toLogMessage(log.msg)
        )
    }

    private func toLogMessage(_ msg: RunLog.Message) -> PersonaLogMessage {
        PersonaLogMessage(
            input: msg.input, output: msg.output,
            parents: msg.parents.map { PersonaLogParent(id: $0.id, text: $0.text) }
        )
    }

    private func extractLevels(from logs: [SessionLogEntry]) -> [LevelInfo] {
        var firstIndex: [Int: Int] = [:]
        for (idx, log) in logs.enumerated() {
            guard let lvl = log.level, firstIndex[lvl] == nil else { continue }
            firstIndex[lvl] = idx
        }
        return firstIndex.sorted { $0.key < $1.key }.map { lvl, logIndex in
            LevelInfo(levelIndex: lvl, label: "L\(lvl + 1)", logIndex: logIndex)
        }
    }

    func getWorkflowLogs(req: Request) async throws -> WorkflowLogsResponse {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }
        guard let rawWorkflowId = req.parameters.get("workflowId") else {
            throw Abort(.badRequest)
        }

        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let workflowId = rawWorkflowId.removingPercentEncoding ?? rawWorkflowId
        let offset = req.query[Int.self, at: "offset"] ?? 0
        let count = req.query[Int.self, at: "count"] ?? 5

        var logs: [WorkflowLogEntry] = []

        do {
            try LogManager.createTables(at: instancePath)
            let runLogs = try LogManager.fetchLogs(
                instancePath: instancePath,
                personaId: nil,
                workflowId: workflowId,
                offset: offset,
                limit: count
            )

            for log in runLogs {
                let startDate = Date(timeIntervalSinceReferenceDate: log.startedAt)
                let endDate = Date(timeIntervalSinceReferenceDate: log.endedAt)
                let startedAtUnixMs = Int64(startDate.timeIntervalSince1970 * 1000)
                let endedAtUnixMs = Int64(endDate.timeIntervalSince1970 * 1000)

                let logEntry = WorkflowLogEntry(
                    success: log.success,
                    took: log.took,
                    started_at: startedAtUnixMs,
                    ended_at: endedAtUnixMs,
                    id: log.workflowId,
                    workflowId: log.workflowId,
                    agent: log.agent,
                    session: log.session,
                    msg: PersonaLogMessage(
                        input: log.msg.input,
                        output: log.msg.output,
                        parents: log.msg.parents.map { p in
                            PersonaLogParent(id: p.id, text: p.text)
                        }
                    )
                )
                logs.append(logEntry)
            }
        } catch {
            req.logger.error("Failed to fetch workflow logs: \(error)")
        }

        let total = (try? LogManager.countLogs(
            instancePath: instancePath,
            workflowId: workflowId
        )) ?? 0
        let safeOffset = max(0, offset)

        return WorkflowLogsResponse(
            instance_id: instancePath,
            workflow_id: workflowId,
            logs: logs,
            offset: safeOffset,
            count: count,
            total: total
        )
    }
}

extension LogHandler {
    struct PersonaLogEntry: Content, Sendable {
        var success: Bool
        var took: Int
        var started_at: Int64
        var ended_at: Int64
        var id: String
        var workflowId: String
        var personaId: String?
        var agent: String
        var msg: PersonaLogMessage
    }

    struct PersonaLogMessage: Content, Sendable {
        var input: String
        var output: String
        var parents: [PersonaLogParent]
    }

    struct PersonaLogParent: Content, Sendable {
        var id: String
        var text: String
    }

    struct PersonaStats: Content, Sendable {
        var errors: Int
        var success: Int
        var total: Int
    }

    struct PersonaLogsResponse: Content, Sendable {
        var instance_id: String
        var logs: [PersonaLogEntry]
        var stats: [String: PersonaStats]
        var offset: Int
        var count: Int
        var total: Int
    }

    struct WorkflowLogEntry: Content, Sendable {
        var success: Bool
        var took: Int
        var started_at: Int64
        var ended_at: Int64
        var id: String
        var workflowId: String
        var agent: String
        var session: String?
        var msg: PersonaLogMessage
    }

    struct WorkflowLogsResponse: Content, Sendable {
        var instance_id: String
        var workflow_id: String
        var logs: [WorkflowLogEntry]
        var offset: Int
        var count: Int
        var total: Int
    }

    struct LevelInfo: Content, Sendable {
        var levelIndex: Int
        var label: String
        var logIndex: Int
    }

    struct SessionLogEntry: Content, Sendable {
        var success: Bool
        var took: Int
        var started_at: Int64
        var ended_at: Int64
        var id: String
        var workflowId: String
        var personaId: String?
        var agent: String
        var level: Int?
        var session: String?
        var msg: PersonaLogMessage
    }

    struct SessionLogsResponse: Content, Sendable {
        var instance_id: String
        var session: String
        var levels: [LevelInfo]
        var logs: [SessionLogEntry]
    }
}
