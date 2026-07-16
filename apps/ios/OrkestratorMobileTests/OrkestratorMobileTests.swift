import Foundation
import Security
import SwiftUI
import WebKit
import XCTest
@testable import OrkestratorMobile

private enum TestFailure: Error, Equatable {
    case expected
}

private final class MemoryCredentialStore: ConnectionCredentialStoring, @unchecked Sendable {
    var vault: ConnectionVault
    var loadError: Error?
    var saveError: Error?
    var deleteError: Error?
    private(set) var savedVaults: [ConnectionVault] = []
    private(set) var deleteCount = 0

    init(vault: ConnectionVault = .empty) {
        self.vault = vault
    }

    func load() throws -> ConnectionVault {
        if let loadError { throw loadError }
        return vault
    }

    func save(_ vault: ConnectionVault) throws {
        if let saveError { throw saveError }
        self.vault = vault
        savedVaults.append(vault)
    }

    func delete() throws {
        if let deleteError { throw deleteError }
        vault = .empty
        deleteCount += 1
    }
}

private final class MockValidator: GatewayConnectionValidating, @unchecked Sendable {
    var checkError: Error?
    var checkHandler: ((URL, String) async throws -> Void)?
    private(set) var checks: [(URL, String)] = []
    private let real = GatewayConnectionValidator()

    func normalizedAddress(_ value: String) throws -> URL {
        try real.normalizedAddress(value)
    }

    func normalizedToken(_ value: String) throws -> String {
        try real.normalizedToken(value)
    }

    func check(address: URL, token: String) async throws {
        checks.append((address, token))
        if let checkError { throw checkError }
        if let checkHandler {
            self.checkHandler = nil
            try await checkHandler(address, token)
        }
    }
}

private func connection(
    id: UUID = UUID(),
    address: String = "https://desk.example",
    token: String = "gateway-token-123456",
    date: Date = Date(timeIntervalSince1970: 1_700_000_000)
) -> RemoteConnection {
    RemoteConnection(id: id, address: URL(string: address)!, token: token, lastConnectedAt: date)
}

@MainActor
final class ConnectionModelTests: XCTestCase {
    func testInitializesFromStorageAndReportsLoadFailure() {
        let saved = connection()
        let store = MemoryCredentialStore(vault: ConnectionVault(activeConnectionID: saved.id, connections: [saved]))
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        XCTAssertEqual(model.activeConnection, saved)

        let brokenStore = MemoryCredentialStore()
        brokenStore.loadError = TestFailure.expected
        let broken = ConnectionModel(credentialStore: brokenStore, validator: MockValidator())
        XCTAssertEqual(broken.vault, .empty)
        XCTAssertNotNil(broken.connectionError)
    }

    func testEditorStatePrefillsAndClearsCredentials() {
        let saved = connection()
        let store = MemoryCredentialStore(vault: ConnectionVault(activeConnectionID: saved.id, connections: [saved]))
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())

        model.showConnectionEditor(prefillActiveConnection: true, error: "offline")
        XCTAssertEqual(model.draftAddress, saved.address.absoluteString)
        XCTAssertEqual(model.draftToken, saved.token)
        XCTAssertEqual(model.connectionError, "offline")

        model.isConnecting = true
        model.dismissConnectionEditor()
        XCTAssertTrue(model.isShowingConnectionEditor)
        XCTAssertEqual(model.connectionError, "offline")

        model.isConnecting = false
        model.dismissConnectionEditor()
        XCTAssertFalse(model.isShowingConnectionEditor)
        XCTAssertNil(model.connectionError)

        model.showConnectionEditor()
        XCTAssertEqual(model.draftAddress, "")
        XCTAssertEqual(model.draftToken, "")
    }

    func testConnectAddsUpdatesAndSortsConnections() async throws {
        let older = connection(address: "https://old.example", date: .distantPast)
        let store = MemoryCredentialStore(vault: ConnectionVault(activeConnectionID: older.id, connections: [older]))
        let validator = MockValidator()
        let model = ConnectionModel(credentialStore: store, validator: validator)

        let result = try await model.connect(address: " NEW.example ", token: " gateway-token-new-123 ")
        XCTAssertEqual(model.activeConnection?.address.absoluteString, "https://new.example")
        XCTAssertEqual(result.connections.first?.address, "https://new.example")
        XCTAssertEqual(validator.checks.count, 1)

        let activeID = try XCTUnwrap(model.activeConnection?.id)
        _ = try await model.connect(address: "https://new.example/", token: "gateway-token-updated")
        XCTAssertEqual(model.activeConnection?.id, activeID)
        XCTAssertEqual(model.activeConnection?.token, "gateway-token-updated")
        XCTAssertEqual(model.vault.connections.count, 2)
    }

    func testConnectDraftReportsFailureAndClearsTokenOnSuccess() async {
        let validator = MockValidator()
        validator.checkError = TestFailure.expected
        let model = ConnectionModel(credentialStore: MemoryCredentialStore(), validator: validator)
        model.draftAddress = "https://desk.example"
        model.draftToken = "gateway-token-123456"
        model.isShowingConnectionEditor = true

        await model.connectDraft()
        XCTAssertNotNil(model.connectionError)
        XCTAssertTrue(model.isShowingConnectionEditor)

        validator.checkError = nil
        await model.connectDraft()
        XCTAssertNil(model.connectionError)
        XCTAssertEqual(model.draftToken, "")
        XCTAssertFalse(model.isShowingConnectionEditor)
        XCTAssertFalse(model.isConnecting)
    }

    func testUseValidatesBeforeChangingActiveConnection() async throws {
        let first = connection(address: "https://one.example")
        let second = connection(address: "https://two.example")
        let vault = ConnectionVault(activeConnectionID: first.id, connections: [first, second])
        let store = MemoryCredentialStore(vault: vault)
        let validator = MockValidator()
        let model = ConnectionModel(credentialStore: store, validator: validator)

        validator.checkError = TestFailure.expected
        await XCTAssertThrowsErrorAsync(try await model.use(connectionID: second.id.uuidString))
        XCTAssertEqual(model.activeConnection?.id, first.id)
        XCTAssertTrue(store.savedVaults.isEmpty)

        validator.checkError = nil
        let payload = try await model.use(connectionID: second.id.uuidString)
        XCTAssertEqual(model.activeConnection?.id, second.id)
        XCTAssertEqual(payload.activeConnectionId, second.id.uuidString)
        await XCTAssertThrowsErrorAsync(try await model.use(connectionID: "missing"))
        await XCTAssertThrowsErrorAsync(try await model.use(connectionID: UUID().uuidString))
    }

    func testUseRejectsCredentialChangedDuringValidation() async throws {
        let first = connection(address: "https://one.example")
        let second = connection(address: "https://two.example")
        let store = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
        )
        let validator = MockValidator()
        let model = ConnectionModel(credentialStore: store, validator: validator)
        validator.checkHandler = { _, _ in
            _ = try await model.connect(
                address: second.address.absoluteString,
                token: "gateway-token-replaced"
            )
            _ = try await model.use(connectionID: first.id.uuidString)
        }

        do {
            _ = try await model.use(connectionID: second.id.uuidString)
            XCTFail("Expected a changed-credential error")
        } catch ConnectionModelError.changedConnection {
            XCTAssertEqual(
                ConnectionModelError.changedConnection.localizedDescription,
                "That saved connection changed while it was being checked. Try again."
            )
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertEqual(model.activeConnection?.id, first.id)
        XCTAssertEqual(model.vault.connections.first(where: { $0.id == second.id })?.token, "gateway-token-replaced")
    }

    func testForgetUpdatesActiveConnectionAndDeletesLastVault() throws {
        let first = connection(address: "https://one.example")
        let second = connection(address: "https://two.example")
        let store = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
        )
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())

        _ = try model.forget(connectionID: first.id.uuidString)
        XCTAssertEqual(model.activeConnection?.id, second.id)
        _ = try model.forget(connectionID: second.id.uuidString)
        XCTAssertNil(model.activeConnection)
        XCTAssertEqual(store.deleteCount, 1)
        XCTAssertThrowsError(try model.forget(connectionID: "invalid"))
    }

    func testStorageFailuresDoNotPublishUnpersistedState() async {
        let store = MemoryCredentialStore()
        store.saveError = TestFailure.expected
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        await XCTAssertThrowsErrorAsync(
            try await model.connect(address: "https://desk.example", token: "gateway-token-123456")
        )
        XCTAssertEqual(model.vault, .empty)

        let current = connection(address: "https://current.example")
        let alternative = connection(address: "https://alternative.example")
        let useStore = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: current.id, connections: [current, alternative])
        )
        useStore.saveError = TestFailure.expected
        let useModel = ConnectionModel(credentialStore: useStore, validator: MockValidator())
        await XCTAssertThrowsErrorAsync(try await useModel.use(connectionID: alternative.id.uuidString))
        XCTAssertEqual(useModel.activeConnection?.id, current.id)

        let saved = connection()
        store.vault = ConnectionVault(activeConnectionID: saved.id, connections: [saved])
        let deleteModel = ConnectionModel(credentialStore: store, validator: MockValidator())
        store.saveError = nil
        store.deleteError = TestFailure.expected
        XCTAssertThrowsError(try deleteModel.forget(connectionID: saved.id.uuidString))
        XCTAssertEqual(deleteModel.activeConnection?.id, saved.id)
    }
}

final class RemoteConnectionTests: XCTestCase {
    func testDerivedNameActiveLookupAndPayloadEncoding() throws {
        let saved = connection(address: "https://Desk.Example:8443")
        let vault = ConnectionVault(activeConnectionID: saved.id, connections: [saved])
        XCTAssertEqual(saved.name.lowercased(), "desk.example")
        XCTAssertEqual(vault.activeConnection, saved)
        XCTAssertNil(ConnectionVault(activeConnectionID: UUID(), connections: [saved]).activeConnection)

        let payload = ConnectionListPayload(
            activeConnectionId: saved.id.uuidString,
            connections: [
                .init(
                    id: saved.id.uuidString,
                    name: saved.name,
                    address: saved.address.absoluteString,
                    active: true,
                    lastConnectedAt: "2024-01-01T00:00:00Z"
                ),
            ]
        )
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        XCTAssertEqual(object?["credentialStorage"] as? String, "secure")
        let summary = (object?["connections"] as? [[String: Any]])?.first
        XCTAssertEqual(summary?["kind"] as? String, "remote")
        XCTAssertEqual(summary?["requiresToken"] as? Bool, false)
    }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (URLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let (response, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class GatewayConnectionValidatorTests: XCTestCase {
    private func validator() -> GatewayConnectionValidator {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return GatewayConnectionValidator(session: URLSession(configuration: configuration))
    }

    func testNormalizesValidAddressesAndRejectsUnsafeForms() throws {
        let validator = GatewayConnectionValidator()
        XCTAssertEqual(try validator.normalizedAddress(" Desk.Example:8443 ").absoluteString, "https://desk.example:8443")
        XCTAssertThrowsError(try validator.normalizedAddress(""))
        XCTAssertThrowsError(try validator.normalizedAddress("http://desk.example"))
        XCTAssertThrowsError(try validator.normalizedAddress("https://user:pass@desk.example"))
        XCTAssertThrowsError(try validator.normalizedAddress("https://desk.example/path"))
        XCTAssertThrowsError(try validator.normalizedAddress("https://desk.example?query=1"))
        XCTAssertThrowsError(try validator.normalizedAddress("https://desk.example#fragment"))
    }

    func testTokenBoundariesUnicodeAndCookieSize() throws {
        let validator = GatewayConnectionValidator()
        XCTAssertEqual(try validator.normalizedToken(" 1234567890123456 "), "1234567890123456")
        XCTAssertEqual(try validator.normalizedToken(String(repeating: "a", count: 1_024)).count, 1_024)
        XCTAssertThrowsError(try validator.normalizedToken("short"))
        XCTAssertThrowsError(try validator.normalizedToken(String(repeating: "a", count: 1_025)))
        XCTAssertThrowsError(try validator.normalizedToken(String(repeating: "😀", count: 512)))
    }

    func testCheckSendsBearerCredentialsAndAcceptsValidStatus() async throws {
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/__orkestrator/status")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer gateway-token-123456")
            return (
                HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                Data(#"{"ok":true}"#.utf8)
            )
        }
        try await validator().check(address: URL(string: "https://desk.example")!, token: "gateway-token-123456")
    }

    func testCheckMapsHTTPAndMalformedResponses() async {
        for (status, expected) in [(401, "rejected"), (403, "refused"), (500, "HTTP 500")] {
            StubURLProtocol.handler = { request in
                (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, Data())
            }
            await assertAsyncErrorContains(expected) {
                try await self.validator().check(address: URL(string: "https://desk.example")!, token: "gateway-token-123456")
            }
        }

        StubURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, Data(#"{"ok":false}"#.utf8))
        }
        await assertAsyncErrorContains("valid Orkestrator") {
            try await self.validator().check(address: URL(string: "https://desk.example")!, token: "gateway-token-123456")
        }

        StubURLProtocol.handler = { request in (URLResponse(url: request.url!, mimeType: nil, expectedContentLength: 0, textEncodingName: nil), Data()) }
        await assertAsyncErrorContains("valid Orkestrator") {
            try await self.validator().check(address: URL(string: "https://desk.example")!, token: "gateway-token-123456")
        }
    }

    func testCheckMapsTransportErrors() async {
        for (code, expected) in [
            (URLError.timedOut, "10 seconds"),
            (URLError.serverCertificateUntrusted, "certificate"),
            (URLError.notConnectedToInternet, "could not be reached"),
        ] {
            StubURLProtocol.handler = { _ in throw URLError(code) }
            await assertAsyncErrorContains(expected) {
                try await self.validator().check(address: URL(string: "https://desk.example")!, token: "gateway-token-123456")
            }
        }
    }
}

final class KeychainCredentialStoreTests: XCTestCase {
    private var store: KeychainCredentialStore!

    override func setUpWithError() throws {
        store = KeychainCredentialStore(
            service: "dev.orkestrator.mobile.tests.\(UUID().uuidString)",
            account: "vault"
        )
    }

    override func tearDownWithError() throws {
        try? store.delete()
        store = nil
    }

    func testEmptySaveLoadUpdateAndDeleteRoundTrip() throws {
        XCTAssertEqual(try store.load(), .empty)
        let first = connection()
        try store.save(ConnectionVault(activeConnectionID: first.id, connections: [first]))
        XCTAssertEqual(try store.load().activeConnection, first)

        let second = connection(address: "https://two.example")
        try store.save(ConnectionVault(activeConnectionID: second.id, connections: [second]))
        XCTAssertEqual(try store.load().activeConnection, second)
        try store.delete()
        XCTAssertEqual(try store.load(), .empty)
        XCTAssertNoThrow(try store.delete())
    }

    func testMalformedStoredDataProducesSafeError() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: store.service,
            kSecAttrAccount as String: store.account,
            kSecValueData as String: Data("not-json".utf8),
        ]
        XCTAssertEqual(SecItemAdd(query as CFDictionary, nil), errSecSuccess)
        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(error.localizedDescription, "The saved connection could not be read. Remove it and connect again.")
        }
    }

    func testKeychainErrorDescriptionsAreActionable() {
        XCTAssertTrue(KeychainError.invalidData.localizedDescription.contains("could not be read"))
        XCTAssertTrue(KeychainError(status: errSecAuthFailed).localizedDescription.contains("Secure credential storage failed"))
    }
}

@MainActor
final class RemoteWebViewPolicyTests: XCTestCase {
    private let saved = connection(address: "https://desk.example")

    func testOriginComparisonIncludesSchemeHostAndPort() {
        XCTAssertTrue(RemoteWebView.Coordinator.sameOrigin(URL(string: "https://DESK.example/path")!, saved.address))
        XCTAssertFalse(RemoteWebView.Coordinator.sameOrigin(URL(string: "http://desk.example")!, saved.address))
        XCTAssertFalse(RemoteWebView.Coordinator.sameOrigin(URL(string: "https://desk.example:8443")!, saved.address))
    }

    func testBridgeRequiresMainFrameAndExactOrigin() {
        XCTAssertTrue(RemoteWebView.Coordinator.isTrustedBridgeOrigin(
            isMainFrame: true, scheme: "https", host: "desk.example", port: 443, connection: saved
        ))
        XCTAssertFalse(RemoteWebView.Coordinator.isTrustedBridgeOrigin(
            isMainFrame: false, scheme: "https", host: "desk.example", port: 443, connection: saved
        ))
        XCTAssertFalse(RemoteWebView.Coordinator.isTrustedBridgeOrigin(
            isMainFrame: true, scheme: "https", host: "iframe.example", port: 443, connection: saved
        ))
        XCTAssertFalse(RemoteWebView.Coordinator.isTrustedBridgeOrigin(
            isMainFrame: true, scheme: "https", host: "desk.example", port: 8443, connection: saved
        ))
        XCTAssertFalse(RemoteWebView.Coordinator.isTrustedBridgeOrigin(
            isMainFrame: true, scheme: "https", host: "desk.example", port: 443, connection: nil
        ))
    }

    func testNavigationPolicyKeepsOnlySameOriginWebPagesInProcess() {
        let policy = RemoteWebView.Coordinator.self
        XCTAssertEqual(policy.navigationDisposition(
            for: URL(string: "https://desk.example/projects")!, targetFrameExists: true,
            targetFrameIsMain: true, connection: saved
        ), .allow)
        XCTAssertEqual(policy.navigationDisposition(
            for: URL(string: "https://other.example")!, targetFrameExists: true,
            targetFrameIsMain: true, connection: saved
        ), .openExternally)
        XCTAssertEqual(policy.navigationDisposition(
            for: URL(string: "https://other.example")!, targetFrameExists: false,
            targetFrameIsMain: false, connection: saved
        ), .openExternally)
        XCTAssertEqual(policy.navigationDisposition(
            for: URL(string: "data:text/html,unsafe")!, targetFrameExists: true,
            targetFrameIsMain: true, connection: saved
        ), .cancel)
        XCTAssertEqual(policy.navigationDisposition(
            for: URL(string: "javascript:alert(1)")!, targetFrameExists: true,
            targetFrameIsMain: true, connection: saved
        ), .cancel)
        XCTAssertEqual(policy.navigationDisposition(
            for: URL(string: "https://frame.example")!, targetFrameExists: true,
            targetFrameIsMain: false, connection: saved
        ), .allow)
    }

    func testTeardownCancelsAuthenticationAndClearsCoordinatorState() {
        var state = WebViewState.loading
        let binding = Binding(get: { state }, set: { state = $0 })
        let model = ConnectionModel(credentialStore: MemoryCredentialStore(), validator: MockValidator())
        let coordinator = RemoteWebView.Coordinator(model: model, state: binding)
        let task = Task<Void, Never> { try? await Task.sleep(for: .seconds(10)) }
        coordinator.authenticationTask = task
        coordinator.authenticatedConnection = saved
        coordinator.isSwitchingThroughBridge = true

        coordinator.teardown()

        XCTAssertTrue(task.isCancelled)
        XCTAssertNil(coordinator.authenticationTask)
        XCTAssertNil(coordinator.requestedConnection)
        XCTAssertNil(coordinator.authenticatedConnection)
        XCTAssertFalse(coordinator.isSwitchingThroughBridge)
    }

    func testBridgeScriptExposesOnlyConnectionSummaries() {
        let script = RemoteWebView.Coordinator.connectionBridgeScript
        XCTAssertTrue(script.contains("list: () => call(\"list\")"))
        XCTAssertTrue(script.contains("forget: (connectionId)"))
        XCTAssertFalse(script.contains("activeConnection.token"))
    }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected expression to throw", file: file, line: line)
    } catch {}
}

private func assertAsyncErrorContains(
    _ expected: String,
    operation: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await operation()
        XCTFail("Expected expression to throw", file: file, line: line)
    } catch {
        XCTAssertTrue(error.localizedDescription.contains(expected), "Unexpected error: \(error)", file: file, line: line)
    }
}
