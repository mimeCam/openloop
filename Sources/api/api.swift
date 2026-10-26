import Vapor
import shared
#if canImport(System)
@preconcurrency import System
#else
@preconcurrency import SystemPackage
#endif

@main
struct api {
    static func main() async throws {
        try await Launcher.registerAPI(
            binaryPath: Paths.bin.appending("openloop-api"),
            port: 54321
        )

        var env = try Environment.detect()
        try LoggingSystem.bootstrap(from: &env)

        let app = try await Application.make(env)

        do {
            try await configure(app)
            try await app.execute()
        } catch {
            app.logger.report(error: error)
            try? await app.asyncShutdown()
            throw error
        }

        try await app.asyncShutdown()
    }
}

private func configure(_ app: Application) async throws {
    app.routes.defaultMaxBodySize = "2mb"

    let publicPath: String
#if DEBUG
    let local = NSHomeDirectory() + "/dev/sven/opensource/openloop/Sources/api/Public/" // TODO: - change to actual path
    if isDirectoryExistent(atPath: local) {
        publicPath = local
    } else {
        fatalError("Could not find Public directory")
    }
#else
    publicPath = NSHomeDirectory() + "/.local/bin/Public/"
#endif

    app.logger.info("app.directory.publicDirectory: \(app.directory.publicDirectory)")
    app.logger.info("publicPath: \(publicPath)")

    app.middleware.use(FileMiddleware(publicDirectory: publicPath))

    app.get { req async throws in //req async -> Response in
        try await req.fileio.asyncStreamFile(
            at: publicPath + "index.html"
        )
    }

    let api = app.grouped("api")
    let instances = api.grouped("instances")

    // Instances endpoints
    instances.get { req async throws in
        try await InstanceHandler().getAll(req: req)
    }
    instances.post(":id", "launch") { req async throws in
        try await InstanceHandler().launch(req: req)
    }
    instances.delete(":id") { req async throws in
        try await InstanceHandler().unload(req: req)
    }
    instances.post(":id", "disable") { req async throws in
        try await InstanceHandler().disable(req: req)
    }
    instances.post(":id", "stop") { req async throws in
        try await InstanceHandler().stop(req: req)
    }
    instances.delete(":id", "delete") { req async throws in
        try await InstanceHandler().delete(req: req)
    }
    // Old-log purge + VACUUM — the db-size gauge's remedy
    instances.post(":id", "clean") { req async throws in
        try await InstanceHandler().clean(req: req)
    }
    // Global-share provisioning — the home page's create cell POSTs here
    // when no worker is registered at the share (the handler re-checks and
    // 409s otherwise, so the route is safe to call blind).
    instances.post("global", "create") { req async throws in
        try await InstanceHandler().createGlobalShare(req: req)
    }

    // Workflows endpoints
    instances.grouped(":id", "workflows").get { req async throws in
        try await WorkflowHandler().getAll(req: req)
    }
    instances.grouped(":id", "workflows").post { req async throws in
        try await WorkflowHandler().create(req: req)
    }
    instances.grouped(":id", "workflows", ":wid").get { req async throws in
        try await WorkflowHandler().getOne(req: req)
    }
    instances.grouped(":id", "workflows", ":wid").put { req async throws in
        try await WorkflowHandler().update(req: req)
    }

    // Runs endpoints
    instances.grouped(":id", "workflows", ":wid", "runs").get { req async throws in
        try await RunHandler().getAll(req: req)
    }

    // Personas endpoints
    instances.grouped(":id", "personas").get { req async throws in
        try await PersonaHandler().getAll(req: req)
    }
    instances.grouped(":id", "personas").post { req async throws in
        try await PersonaHandler().create(req: req)
    }
    instances.grouped(":id", "personas", ":pid").get { req async throws in
        try await PersonaHandler().getOne(req: req)
    }
    instances.grouped(":id", "personas", ":pid").put { req async throws in
        try await PersonaHandler().update(req: req)
    }
    instances.grouped(":id", "personas", ":pid").delete { req async throws in
        try await PersonaHandler().delete(req: req)
    }

    // Persona logs endpoint
    instances.grouped(":id", "logs", "personas").get { req async throws in
        try await LogHandler().getPersonaLogs(req: req)
    }

    // Workflow logs endpoint
    instances.grouped(":id", "logs", "workflows", ":workflowId").get { req async throws in
        try await LogHandler().getWorkflowLogs(req: req)
    }

    // Session logs endpoint
    instances.grouped(":id", "logs", "sessions", ":session").get { req async throws in
        try await LogHandler().getSessionLogs(req: req)
    }

    // Workflow delete endpoint
    instances.grouped(":id", "workflows", ":wid").delete { req async throws in
        try await WorkflowHandler().delete(req: req)
    }

    // Instance files endpoint
    instances.get(":id", "files") { req async throws in
        try await FilesHandler().listFiles(req: req)
    }

    // Knowledge file endpoints
    let knowledgeBase = instances.grouped(":id", "personas", ":pid", "knowledge")
    knowledgeBase.get { req async throws in
        try await KnowledgeHandler().listFiles(req: req)
    }
    knowledgeBase.get("**") { req async throws in
        try await KnowledgeHandler().readFile(req: req)
    }
    knowledgeBase.put("**") { req async throws in
        try await KnowledgeHandler().writeFile(req: req)
    }
    knowledgeBase.delete("**") { req async throws in
        try await KnowledgeHandler().deleteFile(req: req)
    }

    // Graph endpoints
    api.get("agents") { req async throws in
        try await GraphHandler().agents(req: req)
    }
    let graph = instances.grouped(":id", "graph")
    graph.get { req async throws in
        try await GraphHandler().list(req: req)
    }
    graph.post { req async throws in
        try await GraphHandler().create(req: req)
    }
    instances.grouped(":id", "graph", ":nid").put { req async throws in
        try await GraphHandler().update(req: req)
    }
    instances.grouped(":id", "graph", ":nid").post("summary") { req async throws in
        try await GraphHandler().regenSummary(req: req)
    }
    instances.grouped(":id", "graph", ":nid").post("run") { req async throws in
        try await GraphHandler().run(req: req)
    }
    instances.grouped(":id", "graph", ":nid").put("runs", ":rid") { req async throws in
        try await GraphHandler().updateRun(req: req)
    }
    instances.grouped(":id", "graph", ":nid").post("runs", ":rid", "retry") { req async throws in
        try await GraphHandler().retryRun(req: req)
    }
    instances.grouped(":id", "graph", ":nid").delete("runs", ":rid") { req async throws in
        try await GraphHandler().deleteRun(req: req)
    }
    instances.grouped(":id", "graph", ":nid").get("logs") { req async throws in
        try await GraphHandler().logs(req: req)
    }
    instances.grouped(":id", "graph", ":nid").delete { req async throws in
        try await GraphHandler().delete(req: req)
    }

    // Workflow session follow-up endpoints — runs live in graph_run_logs
    // anchored on the session UUID (node_id), so they hang off the graph
    // namespace, NOT the node one (":nid" routes 404 on session UUIDs).
    instances.grouped(":id", "graph", "sessions", ":sid").get("logs") { req async throws in
        try await GraphHandler().sessionLogs(req: req)
    }
    instances.grouped(":id", "graph", "sessions", ":sid").post("run") { req async throws in
        try await GraphHandler().sessionRun(req: req)
    }
    instances.grouped(":id", "graph", "sessions", ":sid").post("seed") { req async throws in
        try await GraphHandler().sessionSeed(req: req)
    }
    instances.grouped(":id", "graph", "sessions", ":sid").post("runs", ":rid", "retry") { req async throws in
        try await GraphHandler().sessionRetryRun(req: req)
    }
    instances.grouped(":id", "graph", "sessions", ":sid").delete("runs", ":rid") { req async throws in
        try await GraphHandler().sessionDeleteRun(req: req)
    }

    // Manual workflows endpoints
    instances.grouped(":id", "manual-workflows", "validate").post { req async throws in
        try await ManualWorkflowHandler().validate(req: req)
    }
    instances.grouped(":id", "manual-workflows").get { req async throws in
        try await ManualWorkflowHandler().getAll(req: req)
    }
    instances.grouped(":id", "manual-workflows").post { req async throws in
        try await ManualWorkflowHandler().launch(req: req)
    }
    instances.grouped(":id", "manual-workflows", ":runid").get { req async throws in
        try await ManualWorkflowHandler().getOne(req: req)
    }
    instances.grouped(":id", "manual-workflows", ":runid").delete { req async throws in
        try await ManualWorkflowHandler().delete(req: req)
    }

    // Notifications endpoints (per instance — derived from its logs.db;
    // powers /notifications.html + the home header badge)
    instances.grouped(":id", "notifications").get { req async throws in
        try await NotificationHandler().list(req: req)
    }
    instances.grouped(":id", "notifications", "read-all").post { req async throws in
        try await NotificationHandler().markAllRead(req: req)
    }
    instances.grouped(":id", "notifications", ":kind", ":ref", "read").post { req async throws in
        try await NotificationHandler().markRead(req: req)
    }
}

private func isDirectoryExistent(atPath path: String) -> Bool {
    var isDirectory = ObjCBool(false)
    let exists = FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
    return exists && isDirectory.boolValue
}
