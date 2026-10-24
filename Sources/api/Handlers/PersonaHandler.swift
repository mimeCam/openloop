import Vapor
import Foundation
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif
import shared

struct PersonaHandler: Sendable {
    
    func getAll(req: Request) async throws -> PersonaListResponse {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }
        
        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        
        let personasPath = Paths.objectsRoot(forInstance: instancePath)
            .appending("personas")
        
        guard PathIO.isDirectoryExistent(atPath: personasPath.string) else {
            return PersonaListResponse(instance_id: instancePath, personas: [])
        }
        
        var personas: [PersonaInfo] = []
        
        let files = try PathIO.contentsOfDirectory(atPath: personasPath.string)
        let json5Files = files.filter { $0.hasSuffix(".\(json)") }
        
        for fileName in json5Files {
            let personaId = String(fileName.dropLast(".\(json)".count))
            let filePath = personasPath.appending(fileName)
            
            if let persona = try? await FileLoader.loadPersonaAtPath(filePath) {
                personas.append(PersonaInfo(
                    id: personaId,
                    name: persona.name,
                    role: persona.role,
                    avatar: persona.avatar
                ))
            }
        }
        
        return PersonaListResponse(instance_id: instancePath, personas: personas)
    }
    
    func getOne(req: Request) async throws -> PersonaResponse {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawPersonaId = req.parameters.get("pid") else {
            throw Abort(.badRequest)
        }
        
        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let personaId = rawPersonaId.removingPercentEncoding ?? rawPersonaId
        
        let filePath = Paths.objectsRoot(forInstance: instancePath)
            .appending("personas")
            .appending("\(personaId).\(json)")

        guard PathIO.isFileExistent(atPath: filePath.string),
              let persona = try? await FileLoader.loadPersonaAtPath(filePath) else {
            throw Abort(.notFound)
        }
        
        return PersonaResponse(
            instance_id: instancePath,
            persona_id: personaId,
            name: persona.name,
            role: persona.role,
            about: persona.about,
            task: persona.task,
            avatar: persona.avatar,
            agent: persona.agent
        )
    }
    
    func update(req: Request) async throws -> PersonaResponse {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawPersonaId = req.parameters.get("pid") else {
            throw Abort(.badRequest)
        }
        
        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let personaId = rawPersonaId.removingPercentEncoding ?? rawPersonaId
        
        let updateRequest = try req.content.decode(PersonaUpdateRequest.self)
        
        let filePath = Paths.objectsRoot(forInstance: instancePath)
            .appending("personas")
            .appending("\(personaId).\(json)")

        guard PathIO.isFileExistent(atPath: filePath.string),
              let existingPersona = try? await FileLoader.loadPersonaAtPath(filePath) else {
            throw Abort(.notFound)
        }
        
        let updatedPersona = Persona(
            name: updateRequest.name ?? existingPersona.name,
            role: updateRequest.role ?? existingPersona.role,
            about: updateRequest.about ?? existingPersona.about,
            task: updateRequest.task ?? existingPersona.task,
            avatar: updateRequest.avatar ?? existingPersona.avatar,
            agent: updateRequest.agent ?? existingPersona.agent
        )
        
        try await FileLoader.savePersona(updatedPersona, at: filePath)
        
        return PersonaResponse(
            instance_id: instancePath,
            persona_id: personaId,
            name: updatedPersona.name,
            role: updatedPersona.role,
            about: updatedPersona.about,
            task: updatedPersona.task,
            avatar: updatedPersona.avatar,
            agent: updatedPersona.agent
        )
    }
    
    func create(req: Request) async throws -> PersonaResponse {
        guard let rawInstancePath = req.parameters.get("id") else {
            throw Abort(.badRequest)
        }
        
        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        
        let createRequest = try req.content.decode(PersonaCreateRequest.self)
        let personaId = createRequest.id ?? UUID().uuidString
        
        let filePath = Paths.objectsRoot(forInstance: instancePath)
            .appending("personas")
            .appending("\(personaId).\(json)")

        let personasDir = filePath.removingLastComponent()
        _ = PathIO.createDirectoryIfNotExists(atPath: personasDir.string)

        let persona = Persona(
            name: createRequest.name ?? "New Persona",
            role: createRequest.role ?? "",
            about: createRequest.about ?? "",
            task: createRequest.task ?? "",
            avatar: createRequest.avatar,
            agent: createRequest.agent
        )
        
        try await FileLoader.savePersona(persona, at: filePath)
        
        let knowledgeDir = Paths.objectsRoot(forInstance: instancePath)
            .appending("knowledge")
            .appending(personaId)
        guard PathIO.createDirectoryIfNotExists(atPath: knowledgeDir.string) else {
            throw Abort(.internalServerError, reason: "failed to create knowledge folder: \(knowledgeDir.string)")
        }
        
        return PersonaResponse(
            instance_id: instancePath,
            persona_id: personaId,
            name: persona.name,
            role: persona.role,
            about: persona.about,
            task: persona.task,
            avatar: persona.avatar,
            agent: persona.agent
        )
    }
    
    func delete(req: Request) async throws -> HTTPStatus {
        guard let rawInstancePath = req.parameters.get("id"),
              let rawPersonaId = req.parameters.get("pid") else {
            throw Abort(.badRequest)
        }
        
        let instancePath = rawInstancePath.removingPercentEncoding ?? rawInstancePath
        let personaId = rawPersonaId.removingPercentEncoding ?? rawPersonaId
        
        let filePath = Paths.objectsRoot(forInstance: instancePath)
            .appending("personas")
            .appending("\(personaId).\(json)")

        guard PathIO.isFileExistent(atPath: filePath.string) else {
            throw Abort(.notFound)
        }
        
        try FileManager.default.removeItem(atPath: filePath.string)
        return .noContent
    }
}

extension PersonaHandler {
    struct PersonaInfo: Content, Sendable {
        var id: String
        var name: String
        var role: String
        var avatar: String?
    }

    struct PersonaListResponse: Content, Sendable {
        var instance_id: String
        var personas: [PersonaInfo]
    }

    struct PersonaResponse: Content, Sendable {
        var instance_id: String
        var persona_id: String
        var name: String
        var role: String
        var about: String
        var task: String
        var avatar: String?
        var agent: String?
    }

    struct PersonaUpdateRequest: Content, Sendable {
        var name: String?
        var role: String?
        var about: String?
        var task: String?
        var avatar: String?
        var agent: String?
    }

    struct PersonaCreateRequest: Content, Sendable {
        var id: String?
        var name: String?
        var role: String?
        var about: String?
        var task: String?
        var avatar: String?
        var agent: String?
    }
}
