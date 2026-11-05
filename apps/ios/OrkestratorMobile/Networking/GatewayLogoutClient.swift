import Foundation

protocol GatewayLogoutSending: Sendable {
    /// A best effort that never throws: the server has already been forgotten, and
    /// a session this cannot revoke still ends at the backend's own expiry.
    func logOut(address: URL, sessionCookie: HTTPCookie) async
}

struct GatewayLogoutClient: GatewayLogoutSending, Sendable {
    /// The names the gateway reads a session from (`getGatewayAuthCookie`).
    static let sessionCookieNames = ["__Host-orkestrator_gateway_auth", "orkestrator_gateway_auth"]

    private let session: URLSession

    init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 5
            configuration.timeoutIntervalForResource = 5
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            self.session = URLSession(configuration: configuration)
        }
    }

    func logOut(address: URL, sessionCookie: HTTPCookie) async {
        var request = URLRequest(url: address.appending(path: "__orkestrator/logout"))
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.httpShouldHandleCookies = false
        request.setValue("\(sessionCookie.name)=\(sessionCookie.value)", forHTTPHeaderField: "Cookie")
        // The gateway answers with a redirect to its login page. The cookie is for
        // this request alone and must not travel with a followed redirect.
        _ = try? await session.data(for: request, delegate: GatewayRedirectBlocker())
    }
}
