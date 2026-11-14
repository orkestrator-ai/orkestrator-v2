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
        holdsRequests = false
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

/// Controlled native login response; never uses a real gateway or credential.
final class SessionLoginProtocol: URLProtocol, @unchecked Sendable {
    static var onStart: ((SessionLoginProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.onStart?(self) }
    override func stopLoading() {}
    func respond(value: String = "test-session") {
        let response = HTTPURLResponse(url: request.url!, statusCode: 303, httpVersion: nil, headerFields: [
            "Set-Cookie": "orkestrator_gateway_auth=\(value); Path=/; HttpOnly; Secure",
        ])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
final class SessionEndTests: XCTestCase {
    private var retainedWebViews: [WKWebView] = []
    private var model: ConnectionModel!

    override func tearDown() async throws {
        retainedWebViews = []
        model = nil
        SessionLoginProtocol.onStart = nil
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
        logoutSender: any GatewayLogoutSending,
        recordIssuers: Bool = true
    ) async -> (RemoteWebView.Coordinator, WKHTTPCookieStore) {
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        self.model = model
        let coordinator = RemoteWebView.Coordinator(
            model: model,
            state: Binding(get: { .ready }, set: { _ in })
        )
        coordinator.consentGate.presenter = ScriptedConsentPresenter(.approve)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        retainedWebViews.append(webView)
        coordinator.webView = webView
        coordinator.logoutSender = logoutSender
        coordinator.javaScriptEvaluator = { _ in nil }
        let cookieStore = configuration.websiteDataStore.httpCookieStore
        for cookie in cookies {
            if recordIssuers, GatewayLogoutClient.sessionCookieNames.contains(cookie.name),
               let owner = store.vault.connections.first(where: { Self.matches(cookie, $0) }) {
                coordinator.beginAuthenticationState(for: owner)
                await coordinator.installLoginCookie(cookie, for: owner, in: webView)
            } else {
                await cookieStore.setCookie(cookie)
            }
        }
        if let active = model.activeConnection { coordinator.beginAuthenticationState(for: active) }
        return (coordinator, cookieStore)
    }

    private static func matches(_ cookie: HTTPCookie, _ connection: RemoteConnection) -> Bool {
        RemoteWebView.Coordinator.cookie(cookie, belongsToHostOf: connection.address)
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Expected asynchronous operation did not arrive within two seconds")
        throw TestFailure.expected
    }

    private func forget(_ connection: RemoteConnection, using coordinator: RemoteWebView.Coordinator) async {
        await coordinator.handleBridgeRequest(id: UUID().uuidString, action: "forget", body: ["connectionId": connection.id.uuidString])
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

        // Cleanup is armed before dispatch, including if the handler regresses
        // to awaiting logout. Releasing also lets any late request pass through.
        defer { logout.releaseHeldRequests() }
        let returned = expectation(description: "Forget returns while logout is held")
        let forgetTask = Task {
            await coordinator.handleBridgeRequest(
                id: "forget-id",
                action: "forget",
                body: ["connectionId": forgotten.id.uuidString]
            )
            returned.fulfill()
        }
        await fulfillment(of: [returned], timeout: 2)
        // Always release and drain before assertions that can throw. A broken
        // handler therefore fails at the deadline without stranding its task.
        logout.releaseHeldRequests()
        await forgetTask.value

        XCTAssertTrue(try XCTUnwrap(replies.last).contains(#""forget-id", true"#))
        XCTAssertEqual(store.vault.connections.map(\.id), [other.id])
        XCTAssertEqual(model.vault, store.vault)

        // The forget still stands after the parked request is released.
        try await waitUntil { !logout.requests.isEmpty }
        let remainingCookies = await cookieStore.allCookies()
        XCTAssertTrue(remainingCookies.isEmpty)
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
        weak var releasedView = retainedWebViews.first
        RemoteWebView.dismantleUIView(try XCTUnwrap(retainedWebViews.first), coordinator: coordinator)
        retainedWebViews.removeAll()
        try await waitUntil { releasedView == nil }
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
            store: MemoryCredentialStore(vault: vault(sibling, forgotten, active: sibling)),
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

    func testSequentialSameHostForgetsNeverSendTheFirstCookieToTheSecondPort() async throws {
        for knownIssuer in [false, true] {
            let a = connection(address: "https://desk.example")
            let b = connection(address: "https://desk.example:8443")
            let c = connection(address: "https://other.example")
            let logout = FakeLogoutSender()
            let (coordinator, cookieStore) = await makeCoordinator(
                store: MemoryCredentialStore(vault: vault(a, b, c, active: c)),
                cookies: [try webCookie(value: "a-session", domain: "desk.example")],
                logoutSender: logout, recordIssuers: knownIssuer
            )
            await forget(a, using: coordinator)
            await coordinator.sessionEndTask?.value
            await forget(b, using: coordinator)
            await coordinator.sessionEndTask?.value
            XCTAssertFalse(logout.requests.contains { $0.address == b.address })
            XCTAssertEqual(logout.requests.map(\.address), knownIssuer ? [a.address] : [])
            let remaining = await cookieStore.allCookies()
            XCTAssertTrue(remaining.isEmpty)
        }
    }

    func testLoginAfterSkippedUnknownCleanupUpdatesTheIssuer() async throws {
        let a = connection(address: "https://desk.example")
        let b = connection(address: "https://desk.example:8443")
        let c = connection(address: "https://other.example")
        let logout = FakeLogoutSender()
        let (coordinator, cookieStore) = await makeCoordinator(
            store: MemoryCredentialStore(vault: vault(a, b, c, active: c)),
            cookies: [try webCookie(value: "unknown-session", domain: "desk.example")],
            logoutSender: logout, recordIssuers: false
        )
        await forget(a, using: coordinator)
        await coordinator.sessionEndTask?.value
        XCTAssertTrue(logout.requests.isEmpty)
        let preserved = await cookieStore.allCookies()
        XCTAssertEqual(preserved.map(\.value), ["unknown-session"])

        SessionLoginProtocol.onStart = { $0.respond(value: "b-session") }
        coordinator.loginProtocolClasses = [SessionLoginProtocol.self]
        coordinator.requestLoader = { _, _ in }
        coordinator.authenticate(b)
        await coordinator.authenticationTask?.value
        await forget(b, using: coordinator)
        await coordinator.sessionEndTask?.value
        XCTAssertEqual(logout.requests.map(\.address), [b.address])
        XCTAssertEqual(logout.requests.map(\.cookie.value), ["b-session"])
    }

    func testForgettingDuringARealLoginResponseNeverInstallsItsCookie() async throws {
        let a = connection(address: "https://desk.example")
        let c = connection(address: "https://other.example")
        let logout = FakeLogoutSender()
        let (coordinator, cookieStore) = await makeCoordinator(
            store: MemoryCredentialStore(vault: vault(a, c)), cookies: [], logoutSender: logout
        )
        let started = expectation(description: "Native login POST started")
        SessionLoginProtocol.onStart = { _ in started.fulfill() }
        coordinator.loginProtocolClasses = [SessionLoginProtocol.self]
        coordinator.requestLoader = { _, _ in XCTFail("Forgotten login must never load a page") }
        // Make authenticate start even though the fixture marked A requested.
        coordinator.beginAuthenticationState(for: c)
        coordinator.authenticate(a)
        let signIn = try XCTUnwrap(coordinator.authenticationTask)
        await fulfillment(of: [started], timeout: 2)
        await forget(a, using: coordinator)
        await signIn.value
        await coordinator.sessionEndTask?.value
        let remaining = await cookieStore.allCookies()
        XCTAssertTrue(signIn.isCancelled)
        XCTAssertTrue(remaining.isEmpty)
        XCTAssertTrue(logout.requests.isEmpty)
    }

    func testForgetWaitsForAnInflightWKWriteAndPreservesTheNextSameHostLogin() async throws {
        let a = connection(address: "https://desk.example")
        let b = connection(address: "https://desk.example:8443")
        let logout = FakeLogoutSender()
        logout.holdsRequests = true
        defer { logout.releaseHeldRequests() }
        let (coordinator, cookieStore) = await makeCoordinator(
            store: MemoryCredentialStore(vault: vault(a, b)), cookies: [], logoutSender: logout
        )
        var releaseWrite: CheckedContinuation<Void, Never>?
        coordinator.cookieWriter = { cookie, store in
            if cookie.value == "a-session" {
                await withCheckedContinuation { releaseWrite = $0 }
            }
            await store.setCookie(cookie)
        }
        defer { releaseWrite?.resume() }
        SessionLoginProtocol.onStart = { request in
            request.respond(value: request.request.url?.port == 8443 ? "b-session" : "a-session")
        }
        coordinator.loginProtocolClasses = [SessionLoginProtocol.self]
        coordinator.requestLoader = { _, _ in }
        coordinator.beginAuthenticationState(for: b)
        coordinator.authenticate(a)
        let firstSignIn = try XCTUnwrap(coordinator.authenticationTask)
        try await waitUntil { releaseWrite != nil }
        await forget(a, using: coordinator)
        let cleanup = coordinator.sessionEndTask
        coordinator.authenticate(b)
        let secondSignIn = try XCTUnwrap(coordinator.authenticationTask)
        let signedIn = expectation(description: "Later same-host login finishes while logout is held")
        let observeSignIn = Task {
            await secondSignIn.value
            signedIn.fulfill()
        }
        releaseWrite?.resume()
        releaseWrite = nil
        await fulfillment(of: [signedIn], timeout: 2)
        // The cookie write must have finished even though logout cannot finish.
        let whileHeld = await cookieStore.allCookies()
        XCTAssertEqual(whileHeld.map(\.value), ["b-session"])
        try await waitUntil { !logout.requests.isEmpty }
        XCTAssertTrue(logout.holdsRequests)
        logout.releaseHeldRequests()
        await observeSignIn.value
        await firstSignIn.value
        await cleanup?.value
        let remaining = await cookieStore.allCookies()
        XCTAssertEqual(remaining.map(\.value), ["b-session"])
        XCTAssertEqual(logout.requests.map(\.address), [a.address])
        XCTAssertEqual(logout.requests.map(\.cookie.value), ["a-session"])
        await forget(b, using: coordinator)
        await coordinator.sessionEndTask?.value
        XCTAssertEqual(logout.requests.map(\.address), [a.address, b.address])
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

    func testTheDefaultClientBoundsASilentGatewayToFiveSeconds() async throws {
        let gateway = try FakeGateway(reply: .never)
        defer { gateway.stop() }
        let address = try await gateway.start()
        let cookie = try sessionCookie()
        let finished = expectation(description: "Production logout timeout expires")
        let started = ContinuousClock.now
        let logout = Task {
            await GatewayLogoutClient().logOut(address: address, sessionCookie: cookie)
            finished.fulfill()
        }
        await fulfillment(of: [finished], timeout: 8)
        let elapsed = ContinuousClock.now - started
        // Close the connection even on timeout so a missing production bound
        // cannot strand the task for URLSession's much longer default timeout.
        gateway.stop()
        await logout.value
        XCTAssertEqual(gateway.requests.count, 1)
        XCTAssertGreaterThanOrEqual(elapsed, .seconds(4))
        XCTAssertLessThan(elapsed, .seconds(8))
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
        coordinator.consentGate.presenter = ScriptedConsentPresenter(.approve)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        coordinator.webView = webView
        coordinator.javaScriptEvaluator = { _ in nil }
        coordinator.beginAuthenticationState(for: forgotten)
        await coordinator.installLoginCookie(try sessionCookie(), for: forgotten, in: webView)

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
