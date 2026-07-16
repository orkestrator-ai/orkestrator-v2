import Foundation

protocol GatewayConnectionValidating: Sendable {
    func normalizedAddress(_ value: String) throws -> URL
    func normalizedToken(_ value: String) throws -> String
    func check(address: URL, token: String) async throws
}

struct GatewayConnectionValidator: GatewayConnectionValidating, Sendable {
    static let minimumTokenLength = 16
    static let maximumTokenLength = 1_024
    static let maximumCookieBytes = 4_096

    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 10
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            self.session = URLSession(configuration: configuration)
        }
    }

    func normalizedAddress(_ value: String) throws -> URL {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ConnectionValidationError.emptyAddress }

        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let components = URLComponents(string: candidate),
              components.scheme?.lowercased() == "https",
              let host = components.host,
              !host.isEmpty else {
            throw ConnectionValidationError.invalidAddress
        }
        guard components.user == nil, components.password == nil else {
            throw ConnectionValidationError.credentialsInAddress
        }
        guard (components.path.isEmpty || components.path == "/"),
              components.query == nil,
              components.fragment == nil else {
            throw ConnectionValidationError.originOnly
        }

        var origin = URLComponents()
        origin.scheme = "https"
        origin.host = host.lowercased()
        origin.port = components.port
        guard let url = origin.url else { throw ConnectionValidationError.invalidAddress }
        return url
    }

    func normalizedToken(_ value: String) throws -> String {
        let token = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let length = token.utf16.count
        guard length >= Self.minimumTokenLength else { throw ConnectionValidationError.shortToken }
        guard length <= Self.maximumTokenLength else { throw ConnectionValidationError.longToken }

        let encoded = token.utf8.map { byte -> String in
            let scalar = UnicodeScalar(byte)
            if CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
                .contains(scalar) {
                return String(scalar)
            }
            return String(format: "%%%02X", byte)
        }.joined()
        let cookie = "orkestrator_gateway_auth=\(encoded); HttpOnly; SameSite=Strict; Path=/"
        guard cookie.utf8.count <= Self.maximumCookieBytes else {
            throw ConnectionValidationError.cookieTooLarge
        }
        return token
    }

    func check(address: URL, token: String) async throws {
        let statusURL = address.appending(path: "__orkestrator/status")
        var request = URLRequest(url: statusURL, timeoutInterval: 10)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .cancelled where Task.isCancelled:
                throw CancellationError()
            case .timedOut:
                throw ConnectionValidationError.timedOut
            case .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateHasUnknownRoot, .secureConnectionFailed:
                throw ConnectionValidationError.untrustedConnection
            default:
                throw ConnectionValidationError.unreachable
            }
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw ConnectionValidationError.invalidResponse
        }
        if httpResponse.statusCode == 401 { throw ConnectionValidationError.rejectedToken }
        if httpResponse.statusCode == 403 { throw ConnectionValidationError.originRejected }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw ConnectionValidationError.httpFailure(httpResponse.statusCode)
        }

        let payload = try? JSONDecoder().decode(StatusPayload.self, from: data)
        guard payload?.ok == true else { throw ConnectionValidationError.invalidResponse }
    }

    private struct StatusPayload: Decodable {
        let ok: Bool?
    }
}

enum ConnectionValidationError: LocalizedError {
    case emptyAddress
    case invalidAddress
    case credentialsInAddress
    case originOnly
    case shortToken
    case longToken
    case cookieTooLarge
    case timedOut
    case untrustedConnection
    case unreachable
    case rejectedToken
    case originRejected
    case invalidResponse
    case httpFailure(Int)

    var errorDescription: String? {
        switch self {
        case .emptyAddress: return "Enter the remote machine address."
        case .invalidAddress: return "Use a valid HTTPS address, such as https://workstation.tailnet.ts.net."
        case .credentialsInAddress: return "Put the gateway token in the token field, not in the address."
        case .originOnly: return "Use the server origin only, without a path, query, or fragment."
        case .shortToken: return "The gateway token must be at least 16 characters."
        case .longToken: return "The gateway token must be 1,024 characters or fewer."
        case .cookieTooLarge: return "The gateway token is too large for the secure web session."
        case .timedOut: return "The remote machine did not respond within 10 seconds."
        case .untrustedConnection: return "The server’s HTTPS certificate could not be trusted."
        case .unreachable: return "The remote machine could not be reached. Check Tailscale and the HTTPS address."
        case .rejectedToken: return "The gateway token was rejected."
        case .originRejected: return "The remote machine refused this connection. Check its web access settings."
        case .invalidResponse: return "The server did not return a valid Orkestrator status response."
        case .httpFailure(let status): return "The connection check failed with HTTP \(status)."
        }
    }
}
