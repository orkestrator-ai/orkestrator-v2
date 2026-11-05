import Network
import SwiftUI
import WebKit
import XCTest
@testable import OrkestratorMobile

/// Records each logout, optionally holding it open until the test lets it go.
@MainActor
private final class FakeLogoutSender: GatewayLogoutSending, @unchecked Sendable {
    struct Request {
        let address: URL
        let cookie: HTTPCookie
    }

    var holdsRequests = false
    private(set) var requests: [Request] = []
    private var held: [CheckedContinuation<Void, Never>] = []

    nonisolated func logOut(address: URL, sessionCookie: HTTPCookie) async {
        await record(address: address, cookie: sessionCookie)
    }

    private func record(address: URL, cookie: HTTPCookie) async {
        requests.append(Request(address: address, cookie: cookie))
        guard holdsRequests else { return }
        await withCheckedContinuation { held.append($0) }
    }

    func releaseHeldRequests() {
        held.forEach { $0.resume() }
        held = []
    }
}

/// A stand-in gateway on loopback, so a request can be observed on the wire.
private final class FakeGateway: @unchecked Sendable {
    enum Reply: Sendable { case redirectToLogin, serverError, never }

    private let reply: Reply
    private let listener: NWListener
    private let queue = DispatchQueue(label: "dev.orkestrator.mobile.tests.fake-gateway")
    private var received: [String] = []
    private var connections: [NWConnection] = []

    init(reply: Reply) throws {
        self.reply = reply
        listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { [weak self] connection in
            self?.serve(connection)
        }
    }

    private func serve(_ connection: NWConnection) {
        connections.append(connection)
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, _, _ in
            guard let self, let data, !data.isEmpty else { return }
            received.append(String(decoding: data, as: UTF8.self))
            let head: String
            switch reply {
            case .never: return
            case .serverError: head = "HTTP/1.1 500 Internal Server Error"
            case .redirectToLogin: head = "HTTP/1.1 303 See Other\r\nLocation: /__orkestrator/login"
            }
            connection.send(
                content: Data("\(head)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8),
                completion: .contentProcessed { _ in connection.cancel() }
            )
        }
    }

    func start() async throws -> URL {
        let listener = listener
        let ready = AsyncStream<UInt16> { continuation in
            listener.stateUpdateHandler = { state in
                if case .ready = state, let port = listener.port?.rawValue {
                    continuation.yield(port)
                    continuation.finish()
                }
            }
            listener.start(queue: queue)
        }
        for await port in ready {
            return try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)"))
        }
        throw TestFailure.expected
    }

    var requests: [String] { queue.sync { received } }

    func stop() {
        queue.sync {
            listener.newConnectionHandler = nil
            connections.forEach { $0.cancel() }
            listener.cancel()
        }
    }
}

@MainActor
final class SessionEndTests: XCTestCase {
    private var retainedWebViews: [WKWebView] = []
    private var model: ConnectionModel!

    override func tearDown() async throws {
        retainedWebViews = []
        model = nil
    }

    private func webCookie(
        name: String = "orkestrator_gateway_auth",
        value: String = "session-value",
        domain: String
    ) throws -> HTTPCookie {
        try XCTUnwrap(HTTPCookie(properties: [
            .name: name,
            .value: value,
            .domain: domain,
            .path: "/",
        ]))
    }

    private func makeCoordinator(
        store: MemoryCredentialStore,
        cookies: [HTTPCookie],
        logoutSender: any GatewayLogoutSending
    ) async -> (RemoteWebView.Coordinator, WKHTTPCookieStore) {
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        self.model = model
        let coordinator = RemoteWebView.Coordinator(
            model: model,
            state: Binding(get: { .ready }, set: { _ in })
        )
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        retainedWebViews.append(webView)
        coordinator.webView = webView
        coordinator.logoutSender = logoutSender
        coordinator.javaScriptEvaluator = { _ in nil }
        let cookieStore = configuration.websiteDataStore.httpCookieStore
        for cookie in cookies {
            await cookieStore.setCookie(cookie)
        }
        return (coordinator, cookieStore)
    }

    private func vault(_ connections: RemoteConnection..., active: RemoteConnection? = nil) -> ConnectionVault {
        ConnectionVault(activeConnectionID: (active ?? connections.first)?.id, connections: connections)
    }

    func testForgettingRemovesTheHostsCookiesAndLogsOutWithTheSessionCookieOnly() async throws {
        let forgotten = connection(address: "https://desk.example")
        let other = connection(address: "https://other.example")
        let logout = FakeLogoutSender()
        let (coordinator, cookieStore) = await makeCoordinator(
            store: MemoryCredentialStore(vault: vault(forgotten, other, active: other)),
            cookies: [
                try webCookie(value: "desk-session", domain: "desk.example"),
                try webCookie(name: "page-preference", value: "dark", domain: "desk.example"),
                try webCookie(value: "other-session", domain: "other.example"),
            ],
            logoutSender: logout
        )

        await coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": forgotten.id.uuidString]
        )
        await coordinator.sessionEndTask?.value

        let remaining = await cookieStore.allCookies()
        XCTAssertEqual(remaining.map(\.domain), ["other.example"])
        XCTAssertEqual(remaining.map(\.value), ["other-session"])
        XCTAssertEqual(logout.requests.map(\.address), [forgotten.address])
        XCTAssertEqual(logout.requests.map(\.cookie.value), ["desk-session"])
    }

    func testAHungLogoutNeitherDelaysNorChangesTheForget() async throws {
        let forgotten = connection(address: "https://desk.example")
        let other = connection(address: "https://other.example")
        let store = MemoryCredentialStore(vault: vault(forgotten, other))
        let logout = FakeLogoutSender()
        logout.holdsRequests = true
        let (coordinator, cookieStore) = await makeCoordinator(
            store: store,
            cookies: [try webCookie(domain: "desk.example")],
            logoutSender: logout
        )
        var replies: [String] = []
        coordinator.javaScriptEvaluator = {
            replies.append($0)
            return nil
        }

        // This returning at all, with the logout parked, is the point of the test.
        await coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": forgotten.id.uuidString]
        )

        XCTAssertTrue(try XCTUnwrap(replies.last).contains(#""forget-id", true"#))
        XCTAssertEqual(store.vault.connections.map(\.id), [other.id])
        XCTAssertEqual(model.vault, store.vault)

        // The forget stands whatever the parked request does, and the cookie goes first.
        while logout.requests.isEmpty { await Task.yield() }
        let whileHeld = await cookieStore.allCookies()
        XCTAssertTrue(whileHeld.isEmpty)
        logout.releaseHeldRequests()
        await coordinator.sessionEndTask?.value
        XCTAssertEqual(store.vault.connections.map(\.id), [other.id])
    }

    func testARefusedForgetKeepsTheSession() async throws {
        let forgotten = connection(address: "https://desk.example")
        let store = MemoryCredentialStore(vault: vault(forgotten))
        store.deleteError = TestFailure.expected
        let logout = FakeLogoutSender()
        let (coordinator, cookieStore) = await makeCoordinator(
            store: store,
            cookies: [try webCookie(domain: "desk.example")],
            logoutSender: logout
        )

        await coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": forgotten.id.uuidString]
        )

        XCTAssertNil(coordinator.sessionEndTask)
        let remaining = await cookieStore.allCookies()
        XCTAssertEqual(remaining.count, 1)
        XCTAssertTrue(logout.requests.isEmpty)
    }

    func testNoSessionMeansNoLogout() async throws {
        let forgotten = connection(address: "https://desk.example")
        let other = connection(address: "https://other.example")
        let logout = FakeLogoutSender()
        let (coordinator, _) = await makeCoordinator(
            store: MemoryCredentialStore(vault: vault(forgotten, other, active: other)),
            cookies: [try webCookie(name: "page-preference", value: "dark", domain: "desk.example")],
            logoutSender: logout
        )

        await coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": forgotten.id.uuidString]
        )
        await coordinator.sessionEndTask?.value

        XCTAssertTrue(logout.requests.isEmpty)
    }

    func testTheSessionStillEndsWhenTheViewIsTornDown() async throws {
        let forgotten = connection(address: "https://desk.example")
        let logout = FakeLogoutSender()
        let (coordinator, cookieStore) = await makeCoordinator(
            store: MemoryCredentialStore(vault: vault(forgotten)),
            cookies: [try webCookie(domain: "desk.example")],
            logoutSender: logout
        )

        await coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": forgotten.id.uuidString]
        )
        // Forgetting the last server sends SwiftUI straight to the editor.
        coordinator.teardown()
        await coordinator.sessionEndTask?.value

        let remaining = await cookieStore.allCookies()
        XCTAssertTrue(remaining.isEmpty)
        XCTAssertEqual(logout.requests.count, 1)
    }

    func testForgettingTheServerBeingSignedInStopsTheSignIn() async throws {
        let forgotten = connection(address: "https://desk.example")
        let other = connection(address: "https://other.example")
        let (coordinator, _) = await makeCoordinator(
            store: MemoryCredentialStore(vault: vault(forgotten, other)),
            cookies: [],
            logoutSender: FakeLogoutSender()
        )
        coordinator.beginAuthenticationState(for: forgotten)
        let signIn = Task<Void, Never> {
            try? await Task.sleep(for: .seconds(30))
        }
        coordinator.authenticationTask = signIn

        await coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": forgotten.id.uuidString]
        )

        XCTAssertTrue(signIn.isCancelled)
    }

    func testASavedServerOnTheSameHostKeepsItsSession() async throws {
        let forgotten = connection(address: "https://desk.example:8443")
        let sibling = connection(address: "https://desk.example")
        let logout = FakeLogoutSender()
        let (coordinator, cookieStore) = await makeCoordinator(
            store: MemoryCredentialStore(vault: vault(forgotten, sibling, active: sibling)),
            cookies: [try webCookie(value: "sibling-session", domain: "desk.example")],
            logoutSender: logout
        )
        coordinator.beginAuthenticationState(for: sibling)

        await coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": forgotten.id.uuidString]
        )
        await coordinator.sessionEndTask?.value

        let remaining = await cookieStore.allCookies()
        XCTAssertEqual(remaining.map(\.value), ["sibling-session"])
        XCTAssertTrue(logout.requests.isEmpty, "Another server's session must not be sent to this one")
    }

    func testTheSignedInServerEndsItsSessionEvenWithASavedServerOnTheSameHost() {
        let forgotten = connection(address: "https://desk.example:8443")
        let sibling = connection(address: "https://DESK.example")
        let unrelated = connection(address: "https://other.example")
        let coordinator = RemoteWebView.Coordinator.self

        XCTAssertTrue(coordinator.cookiesHoldSession(of: forgotten, isRequested: true, remaining: [sibling]))
        XCTAssertFalse(coordinator.cookiesHoldSession(of: forgotten, isRequested: false, remaining: [sibling]))
        XCTAssertTrue(coordinator.cookiesHoldSession(of: forgotten, isRequested: false, remaining: [unrelated]))
    }

    func testCookieHostMatchingIsExact() throws {
        let address = try XCTUnwrap(URL(string: "https://desk.example:8443"))
        let coordinator = RemoteWebView.Coordinator.self

        XCTAssertTrue(coordinator.cookie(try webCookie(domain: "desk.example"), belongsToHostOf: address))
        XCTAssertTrue(coordinator.cookie(try webCookie(domain: "DESK.example"), belongsToHostOf: address))
        XCTAssertTrue(coordinator.cookie(try webCookie(domain: ".desk.example"), belongsToHostOf: address))
        XCTAssertFalse(coordinator.cookie(try webCookie(domain: "example"), belongsToHostOf: address))
        XCTAssertFalse(coordinator.cookie(try webCookie(domain: "notdesk.example"), belongsToHostOf: address))
        XCTAssertFalse(coordinator.cookie(try webCookie(domain: "sub.desk.example"), belongsToHostOf: address))
    }
}

/// `GatewayLogoutClient` against a loopback gateway: what actually goes on the wire.
final class GatewayLogoutClientTests: XCTestCase {
    private func sessionCookie(host: String = "127.0.0.1") throws -> HTTPCookie {
        try XCTUnwrap(HTTPCookie(properties: [
            .name: "orkestrator_gateway_auth",
            .value: "session-value",
            .domain: host,
            .path: "/",
        ]))
    }

    private func shortLivedClient() -> GatewayLogoutClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 0.3
        configuration.timeoutIntervalForResource = 0.3
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        return GatewayLogoutClient(session: URLSession(configuration: configuration))
    }

    func testTheCookieReachesTheGatewayAndTheRedirectIsNotFollowed() async throws {
        let gateway = try FakeGateway(reply: .redirectToLogin)
        defer { gateway.stop() }
        let address = try await gateway.start()

        await GatewayLogoutClient().logOut(address: address, sessionCookie: try sessionCookie())

        XCTAssertEqual(gateway.requests.count, 1, "The redirect to the login page must not be followed")
        let request = try XCTUnwrap(gateway.requests.first)
        XCTAssertTrue(request.hasPrefix("POST /__orkestrator/logout HTTP/1.1\r\n"), request)
        XCTAssertTrue(request.lowercased().contains("cookie: orkestrator_gateway_auth=session-value\r\n"))
    }

    func testAServerErrorIsAbsorbed() async throws {
        let gateway = try FakeGateway(reply: .serverError)
        defer { gateway.stop() }
        let address = try await gateway.start()

        await GatewayLogoutClient().logOut(address: address, sessionCookie: try sessionCookie())

        XCTAssertEqual(gateway.requests.count, 1)
    }

    func testASilentGatewayEndsAtTheTimeout() async throws {
        let gateway = try FakeGateway(reply: .never)
        defer { gateway.stop() }
        let address = try await gateway.start()

        let started = ContinuousClock.now
        await shortLivedClient().logOut(address: address, sessionCookie: try sessionCookie())

        XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
    }

    func testAnUnreachableGatewayIsAbsorbed() async throws {
        // Nothing listens on the port a stopped gateway just released.
        let gateway = try FakeGateway(reply: .never)
        let address = try await gateway.start()
        gateway.stop()

        await shortLivedClient().logOut(address: address, sessionCookie: try sessionCookie())
    }

    @MainActor
    func testForgettingEndsTheSessionEndToEndAgainstAFakeGateway() async throws {
        let gateway = try FakeGateway(reply: .redirectToLogin)
        defer { gateway.stop() }
        let address = try await gateway.start()
        let forgotten = connection(address: address.absoluteString)
        let other = connection(address: "https://other.example")
        let store = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: other.id, connections: [forgotten, other])
        )
        let coordinator = RemoteWebView.Coordinator(
            model: ConnectionModel(credentialStore: store, validator: MockValidator()),
            state: Binding(get: { .ready }, set: { _ in })
        )
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        coordinator.webView = webView
        coordinator.javaScriptEvaluator = { _ in nil }
        await configuration.websiteDataStore.httpCookieStore.setCookie(try sessionCookie())

        await coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": forgotten.id.uuidString]
        )
        await coordinator.sessionEndTask?.value

        let remaining = await configuration.websiteDataStore.httpCookieStore.allCookies()
        XCTAssertTrue(remaining.isEmpty)
        let request = try XCTUnwrap(gateway.requests.first)
        XCTAssertTrue(request.lowercased().contains("cookie: orkestrator_gateway_auth=session-value\r\n"))
    }
}
