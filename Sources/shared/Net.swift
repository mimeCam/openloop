
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private let log = PrintLog(module: "net")

public enum NetError: Error, CustomStringConvertible {
    case invalidResponse
    case invalidURL(String)

    public var description: String {
        switch self {
        case .invalidResponse: return "invalid HTTP response"
        case .invalidURL(let s): return "invalid URL: \(s)"
        }
    }
}

// Multiplatform HTTP helpers built on URLSession's completion-handler API
// (wrapped in continuations), since `URLSession.shared.data(for:)` is unreliable
// on Linux corelibs. GET/POST return the raw body + status so callers can react.
public enum Net {

    public static func get(
        _ url: URL,
        headers: [String: String] = [:],
        timeout: TimeInterval? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: url)
        for (k, v) in headers {
            req.setValue(v, forHTTPHeaderField: k)
        }
        return try await send(req, timeout: timeout)
    }

    public static func post(
        _ url: URL,
        body: Data?,
        headers: [String: String] = [:],
        timeout: TimeInterval? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.httpBody = body
        if req.value(forHTTPHeaderField: "Content-Type") == nil {
            req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }
        for (k, v) in headers {
            req.setValue(v, forHTTPHeaderField: k)
        }
        return try await send(req, timeout: timeout)
    }

    @discardableResult
    public static func send(
        _ req: URLRequest,
        timeout: TimeInterval? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        let bench = TimedBenchmark()

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await withCheckedThrowingContinuation { continuation in
                let session = timeout.map { ephemeralSession(with: $0) } ?? ephemeralSession
                let task = session.dataTask(with: req) { d, r, err in
                    if let err {
                        continuation.resume(throwing: err)
                    } else if let d, let http = r as? HTTPURLResponse {
                        continuation.resume(returning: (d, http))
                    } else {
                        continuation.resume(throwing: NetError.invalidResponse)
                    }
                }
                task.resume()
            }
        } catch {
            log.err("\(req.httpMethod ?? "GET") \(req.url?.path ?? "") failed: \(error)")
            throw error
        }

        log.info("\(req.httpMethod ?? "GET") \(req.url?.path ?? "") -> \(response.statusCode) (\(bench.intervalSinceInitialized.time2)s)")
        return (data, response)
    }
}

private var ephemeralSession: URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 60
    cfg.timeoutIntervalForResource = 50
    return URLSession(configuration: cfg)
}

private func ephemeralSession(with timeout: TimeInterval) -> URLSession {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 5 + timeout
    cfg.timeoutIntervalForResource = timeout
    return URLSession(configuration: cfg)
}
