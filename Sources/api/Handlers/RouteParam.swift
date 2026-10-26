import Vapor
import shared

// Vapor hands route params over RAW (undecoded).
extension Request {

    func routeParam(_ name: String) throws -> String {
        guard let raw = parameters.get(name) else { throw Abort(.badRequest) }
        guard let decoded = raw.removingPercentEncoding else {
            throw Abort(.badRequest, reason: "Malformed percent-encoding in route param `\(name)`")
        }
        return decoded
    }

    func validatedInstancePath() async throws -> String {
        let id = try routeParam("id")
        var known = try await Launcher.listWorkers()
        // The share folder is a legal instance even with no worker
        // registered there (bookmarked graph/persona editing) — as an
        // INSTANCE dir, not its `.openloop` (handlers append the wrapper).
        known.append(Paths.globalShareRoot.string)
        guard known.contains(id), PathIO.isDirectoryExistent(atPath: id) else { throw Abort(.notFound) }
        return id
    }
}
