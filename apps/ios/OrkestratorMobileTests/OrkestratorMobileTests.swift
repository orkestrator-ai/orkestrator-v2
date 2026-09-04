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
        XCTAssertTrue(model.requiresLaunchSelection)

        let brokenStore = MemoryCredentialStore()
        brokenStore.loadError = TestFailure.expected
        let broken = ConnectionModel(credentialStore: brokenStore, validator: MockValidator())
        XCTAssertEqual(broken.vault, .empty)
        XCTAssertNotNil(broken.connectionError)
        XCTAssertFalse(broken.requiresLaunchSelection)
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
        XCTAssertFalse(model.requiresLaunchSelection)
    }

    func testLaunchSelectionValidatesAndOnlyDismissesAfterSuccess() async throws {
        let first = connection(address: "https://one.example")
        let second = connection(address: "https://two.example")
        let store = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
        )
        let validator = MockValidator()
        let model = ConnectionModel(credentialStore: store, validator: validator)

        validator.checkError = TestFailure.expected
        await model.selectConnectionForLaunch(second)
        XCTAssertTrue(model.requiresLaunchSelection)
        XCTAssertEqual(model.activeConnection?.id, first.id)
        XCTAssertNotNil(model.connectionError)

        validator.checkError = nil
        await model.selectConnectionForLaunch(second)
        XCTAssertFalse(model.requiresLaunchSelection)
        XCTAssertEqual(model.activeConnection?.id, second.id)
        XCTAssertNil(model.connectionError)
    }

    func testLaunchSelectionIgnoresConcurrentAndSettledRequests() async {
        let first = connection(address: "https://one.example")
        let second = connection(address: "https://two.example")
        let validator = MockValidator()
        let model = ConnectionModel(
            credentialStore: MemoryCredentialStore(
                vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
            ),
            validator: validator
        )

        model.isConnecting = true
        await model.selectConnectionForLaunch(second)
        XCTAssertTrue(validator.checks.isEmpty)
        XCTAssertTrue(model.requiresLaunchSelection)
        XCTAssertEqual(model.activeConnection?.id, first.id)

        model.isConnecting = false
        await model.selectConnectionForLaunch(second)
        XCTAssertEqual(validator.checks.count, 1)
        XCTAssertFalse(model.requiresLaunchSelection)
        XCTAssertEqual(model.activeConnection?.id, second.id)

        await model.selectConnectionForLaunch(first)
        XCTAssertEqual(validator.checks.count, 1)
        XCTAssertEqual(model.activeConnection?.id, second.id)
    }

    func testAddingServerFromLaunchSelectionDismissesPickerOnlyAfterSuccess() async {
        let saved = connection(address: "https://saved.example")
        let validator = MockValidator()
        let model = ConnectionModel(
            credentialStore: MemoryCredentialStore(
                vault: ConnectionVault(activeConnectionID: saved.id, connections: [saved])
            ),
            validator: validator
        )
        model.showConnectionEditor()
        model.draftAddress = "https://new.example"
        model.draftToken = "gateway-token-new-123"

        validator.checkError = TestFailure.expected
        await model.connectDraft()
        XCTAssertTrue(model.requiresLaunchSelection)
        XCTAssertTrue(model.isShowingConnectionEditor)

        validator.checkError = nil
        await model.connectDraft()
        XCTAssertFalse(model.requiresLaunchSelection)
        XCTAssertFalse(model.isShowingConnectionEditor)
        XCTAssertEqual(model.activeConnection?.address.absoluteString, "https://new.example")
    }

    func testRootDestinationAndEditorCancellationPreserveLaunchSelection() {
        let saved = connection()
        let model = ConnectionModel(
            credentialStore: MemoryCredentialStore(
                vault: ConnectionVault(activeConnectionID: saved.id, connections: [saved])
            ),
            validator: MockValidator()
        )

        XCTAssertEqual(
            rootDestination(
                requiresLaunchSelection: model.requiresLaunchSelection,
                activeConnection: model.activeConnection
            ),
            .launchSelection
        )
        model.showConnectionEditor()
        model.dismissConnectionEditor()
        XCTAssertTrue(model.requiresLaunchSelection)
        XCTAssertEqual(rootDestination(requiresLaunchSelection: false, activeConnection: saved), .remote(saved))
        XCTAssertEqual(rootDestination(requiresLaunchSelection: false, activeConnection: nil), .connectionEditor)
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

    func testProbeValidatesWithoutChangingTheActiveConnection() async throws {
        let first = connection(address: "https://one.example")
        let second = connection(address: "https://two.example")
        let validator = MockValidator()
        let model = ConnectionModel(
            credentialStore: MemoryCredentialStore(
                vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
            ),
            validator: validator
        )

        let available = try await model.probe(connectionID: second.id.uuidString)
        XCTAssertTrue(available)
        XCTAssertEqual(model.activeConnection?.id, first.id)
        XCTAssertEqual(validator.checks.last?.0, second.address)

        validator.checkError = TestFailure.expected
        await XCTAssertThrowsErrorAsync(try await model.probe(connectionID: second.id.uuidString))
        await XCTAssertThrowsErrorAsync(try await model.probe(connectionID: "missing"))
        XCTAssertEqual(model.activeConnection?.id, first.id)
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

/// `URLProtocol` hands the body back as a stream, so `httpBody` alone is not
/// enough to see what a request actually sent.
private func httpBody(of request: URLRequest) -> String {
    if let body = request.httpBody { return String(decoding: body, as: UTF8.self) }
    guard let stream = request.httpBodyStream else { return "" }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 1_024)
    while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        data.append(contentsOf: buffer[0..<read])
    }
    return String(decoding: data, as: UTF8.self)
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

    private final class StateBox {
        var value: WebViewState
        private(set) var bindingWriteCount = 0

        init(_ value: WebViewState) {
            self.value = value
        }

        func publish(_ value: WebViewState) {
            self.value = value
            bindingWriteCount += 1
        }
    }

    private struct FailingEncodable: Encodable {
        func encode(to encoder: Encoder) throws {
            throw TestFailure.expected
        }
    }

    private func makeCoordinator(
        model: ConnectionModel? = nil,
        initialState: WebViewState = .loading,
        stubAuthentication: Bool = true
    ) -> (RemoteWebView.Coordinator, StateBox) {
        let state = StateBox(initialState)
        let binding = Binding(
            get: { state.value },
            set: { state.publish($0) }
        )
        let coordinator = RemoteWebView.Coordinator(
            model: model ?? ConnectionModel(
                credentialStore: MemoryCredentialStore(),
                validator: MockValidator()
            ),
            state: binding
        )
        if stubAuthentication {
            coordinator.authenticationStarter = { [weak coordinator] connection in
                coordinator?.beginAuthenticationState(for: connection)
            }
        }
        return (coordinator, state)
    }

    private func replyScript(id: String, ok: Bool, literal: String) -> String {
        "window.__orkestratorNativeConnectionReply(\"\(id)\", \(ok), \(literal))"
    }

    private func rejectionScript(id: String, error: Error) throws -> String {
        let coordinator = RemoteWebView.Coordinator(
            model: ConnectionModel(credentialStore: MemoryCredentialStore(), validator: MockValidator()),
            state: Binding(get: { .loading }, set: { _ in })
        )
        return replyScript(
            id: id,
            ok: false,
            literal: try coordinator.jsonLiteral(error.localizedDescription)
        )
    }

    func testPlatformMappingAndInjectedScriptsAreOrderedAndMainFrameOnly() throws {
        XCTAssertEqual(RemoteWebView.Coordinator.clientPlatform(for: .phone), "iphone-wkwebview")
        XCTAssertEqual(RemoteWebView.Coordinator.clientPlatform(for: .pad), "ipad-wkwebview")
        XCTAssertEqual(RemoteWebView.Coordinator.clientPlatform(for: .unspecified), "ios-wkwebview")
        XCTAssertEqual(RemoteWebView.Coordinator.clientPlatform(for: .tv), "ios-wkwebview")

        let scripts = RemoteWebView.Coordinator.userScripts(for: .pad)
        XCTAssertEqual(scripts.count, 2)
        XCTAssertEqual(
            scripts[0].source,
            #"window.__orkestratorClientPlatform = "ipad-wkwebview";"#
        )
        XCTAssertEqual(scripts[1].source, RemoteWebView.Coordinator.connectionBridgeScript)
        XCTAssertTrue(scripts.allSatisfy { $0.injectionTime == .atDocumentStart })
        XCTAssertTrue(scripts.allSatisfy(\.isForMainFrameOnly))

        let quoted = RemoteWebView.Coordinator.quotedJavaScriptString("quote\" slash\\\n\u{2028}😀")
        let decoded = try JSONDecoder().decode(String.self, from: Data(quoted.utf8))
        XCTAssertEqual(decoded, "quote\" slash\\\n\u{2028}😀")
    }

    func testLoginTransportErrorsPreserveCancellationAndMapFailures() {
        let cancelled = RemoteWebView.Coordinator.loginTransportError(
            for: URLError(.cancelled),
            taskIsCancelled: true
        )
        XCTAssertTrue(cancelled is CancellationError)

        let externallyCancelled = RemoteWebView.Coordinator.loginTransportError(
            for: URLError(.cancelled),
            taskIsCancelled: false
        )
        XCTAssertTrue(externallyCancelled.localizedDescription.contains("could not be reached"))

        for (code, message) in [
            (URLError.timedOut, "20 seconds"),
            (URLError.serverCertificateUntrusted, "certificate"),
            (URLError.serverCertificateHasBadDate, "certificate"),
            (URLError.serverCertificateHasUnknownRoot, "certificate"),
            (URLError.secureConnectionFailed, "certificate"),
            (URLError.notConnectedToInternet, "could not be reached"),
        ] {
            let error = RemoteWebView.Coordinator.loginTransportError(
                for: URLError(code),
                taskIsCancelled: false
            )
            XCTAssertTrue(error.localizedDescription.contains(message), "Unexpected error: \(error)")
        }
    }

    func testLoginResponseMapsHTTPFailuresAndRequiresAuthenticationCookie() throws {
        let loginURL = URL(string: "https://desk.example/__orkestrator/login")!
        func response(_ status: Int, headers: [String: String]? = nil) -> HTTPURLResponse {
            HTTPURLResponse(
                url: loginURL,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
        }

        let valid = response(303, headers: [
            "Set-Cookie": "orkestrator_gateway_auth=session-value; Path=/; Secure; HttpOnly; SameSite=Strict",
        ])
        XCTAssertEqual(
            try RemoteWebView.Coordinator.loginCookie(from: valid, loginURL: loginURL).value,
            "session-value"
        )

        let invalid = URLResponse(
            url: loginURL,
            mimeType: nil,
            expectedContentLength: 0,
            textEncodingName: nil
        )
        XCTAssertThrowsError(try RemoteWebView.Coordinator.loginCookie(from: invalid, loginURL: loginURL)) {
            XCTAssertTrue($0.localizedDescription.contains("invalid login response"))
        }

        for (status, message) in [
            (401, "token was rejected"),
            (403, "rejected the native login"),
            (500, "HTTP 500"),
        ] {
            XCTAssertThrowsError(
                try RemoteWebView.Coordinator.loginCookie(from: response(status), loginURL: loginURL)
            ) {
                XCTAssertTrue($0.localizedDescription.contains(message), "Unexpected error: \($0)")
            }
        }

        XCTAssertThrowsError(
            try RemoteWebView.Coordinator.loginCookie(from: response(303), loginURL: loginURL)
        ) {
            XCTAssertTrue($0.localizedDescription.contains("did not create a secure web session"))
        }
    }

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

    func testNavigationStateTransitionsForFinishResponseAndFailures() async {
        let (coordinator, state) = makeCoordinator()
        coordinator.javaScriptEvaluator = { _ in true }
        coordinator.beginAuthenticationState(for: saved)

        coordinator.navigationDidFinish(at: URL(string: "https://other.example"))
        XCTAssertEqual(state.value, .loading)
        XCTAssertNil(coordinator.authenticatedConnection)

        coordinator.navigationDidFinish(at: URL(string: "https://desk.example/projects"))
        await coordinator.readinessTask?.value
        XCTAssertEqual(state.value, .ready)
        XCTAssertEqual(coordinator.authenticatedConnection, saved)

        state.value = .ready
        XCTAssertEqual(
            coordinator.navigationResponsePolicy(statusCode: 401, isMainFrame: false),
            .allow
        )
        XCTAssertEqual(state.value, .ready)
        XCTAssertEqual(
            coordinator.navigationResponsePolicy(statusCode: 403, isMainFrame: true),
            .allow
        )
        XCTAssertEqual(
            coordinator.navigationResponsePolicy(statusCode: 401, isMainFrame: true),
            .cancel
        )
        XCTAssertEqual(state.value, .failed("The saved gateway token was rejected."))

        state.value = .ready
        coordinator.handleNavigationError(URLError(.cancelled))
        XCTAssertEqual(state.value, .ready)
        coordinator.handleNavigationError(URLError(.cannotConnectToHost))
        XCTAssertEqual(
            state.value,
            .failed("The remote app could not be loaded. Check Tailscale and try again.")
        )

        state.value = .ready
        coordinator.handleNavigationError(
            NSError(domain: "unrelated", code: NSURLErrorCancelled)
        )
        XCTAssertEqual(
            state.value,
            .failed("The remote app could not be loaded. Check Tailscale and try again.")
        )
    }

    func testReadinessRequiresConsecutiveChecksAndAcceptsNSNumberBooleans() async {
        let (coordinator, state) = makeCoordinator()
        coordinator.beginAuthenticationState(for: saved)
        coordinator.readinessCheckDelay = .zero
        var results: [Any] = [true, false, NSNumber(value: true), true]
        coordinator.javaScriptEvaluator = { _ in results.removeFirst() }

        coordinator.navigationDidFinish(at: URL(string: "https://desk.example/projects"))
        await coordinator.readinessTask?.value

        XCTAssertEqual(results.count, 0)
        XCTAssertEqual(state.value, .ready)
    }

    func testReadinessRetriesEvaluationErrorsAndTimesOut() async {
        let (recovering, recoveringState) = makeCoordinator()
        recovering.beginAuthenticationState(for: saved)
        recovering.readinessCheckDelay = .zero
        var checks = 0
        recovering.javaScriptEvaluator = { _ in
            checks += 1
            if checks == 1 { throw TestFailure.expected }
            return NSNumber(value: true)
        }

        recovering.navigationDidFinish(at: saved.address)
        await recovering.readinessTask?.value
        XCTAssertEqual(checks, 3)
        XCTAssertEqual(recoveringState.value, .ready)

        let (timingOut, timingOutState) = makeCoordinator()
        timingOut.beginAuthenticationState(for: saved)
        timingOut.readinessCheckLimit = 3
        timingOut.readinessCheckDelay = .zero
        var timeoutChecks = 0
        timingOut.javaScriptEvaluator = { _ in
            timeoutChecks += 1
            return false
        }

        timingOut.navigationDidFinish(at: saved.address)
        await timingOut.readinessTask?.value
        XCTAssertEqual(timeoutChecks, 3)
        XCTAssertEqual(
            timingOutState.value,
            .failed("The remote app opened but did not finish starting. Try again.")
        )
    }

    func testCancelledReadinessErrorCannotOverwriteContentProcessFailure() async {
        let (coordinator, state) = makeCoordinator()
        coordinator.beginAuthenticationState(for: saved)
        var continuation: CheckedContinuation<Any?, Error>?
        coordinator.javaScriptEvaluator = { _ in
            try await withCheckedThrowingContinuation { continuation = $0 }
        }

        coordinator.navigationDidFinish(at: saved.address)
        while continuation == nil { await Task.yield() }
        let cancelledTask = coordinator.readinessTask
        coordinator.webViewWebContentProcessDidTerminate(WKWebView())
        continuation?.resume(throwing: TestFailure.expected)
        await cancelledTask?.value

        XCTAssertEqual(
            state.value,
            .failed("The remote app stopped unexpectedly. Try again.")
        )
    }

    func testNavigationFailureInvalidatesSuspendedReadinessResult() async {
        let (coordinator, state) = makeCoordinator()
        coordinator.beginAuthenticationState(for: saved)
        coordinator.readinessCheckDelay = .zero
        var continuation: CheckedContinuation<Any?, Error>?
        coordinator.javaScriptEvaluator = { _ in
            try await withCheckedThrowingContinuation { continuation = $0 }
        }

        coordinator.navigationDidFinish(at: saved.address)
        while continuation == nil { await Task.yield() }
        let cancelledTask = coordinator.readinessTask
        coordinator.javaScriptEvaluator = { _ in true }
        coordinator.handleNavigationError(URLError(.cannotConnectToHost))
        continuation?.resume(returning: true)
        await cancelledTask?.value

        XCTAssertEqual(
            state.value,
            .failed("The remote app could not be loaded. Check Tailscale and try again.")
        )
    }

    func testAuthenticationInvalidatesSuspendedReadinessResult() async {
        let (coordinator, state) = makeCoordinator()
        coordinator.beginAuthenticationState(for: saved)
        coordinator.readinessCheckDelay = .zero
        var continuation: CheckedContinuation<Any?, Error>?
        coordinator.javaScriptEvaluator = { _ in
            try await withCheckedThrowingContinuation { continuation = $0 }
        }

        coordinator.navigationDidFinish(at: saved.address)
        while continuation == nil { await Task.yield() }
        let cancelledTask = coordinator.readinessTask
        let retryID = UUID()
        state.value = .retrying(retryID)
        coordinator.javaScriptEvaluator = { _ in true }
        coordinator.authenticate(saved)
        continuation?.resume(returning: true)
        await cancelledTask?.value
        await coordinator.authenticationTask?.value

        XCTAssertEqual(state.value, .retrying(retryID))
        XCTAssertEqual(coordinator.handledRetryID, retryID)
    }

    func testLaterNavigationSupersedesSuspendedReadinessPollForSameConnection() async {
        let (coordinator, state) = makeCoordinator()
        coordinator.beginAuthenticationState(for: saved)
        coordinator.readinessCheckLimit = 2
        coordinator.readinessCheckDelay = .zero
        var continuation: CheckedContinuation<Any?, Error>?
        var checks = 0
        coordinator.javaScriptEvaluator = { _ in
            checks += 1
            return try await withCheckedThrowingContinuation { continuation = $0 }
        }

        coordinator.navigationDidFinish(at: saved.address)
        while continuation == nil { await Task.yield() }
        let supersededTask = coordinator.readinessTask
        coordinator.javaScriptEvaluator = { _ in
            checks += 1
            return false
        }
        coordinator.navigationDidFinish(at: saved.address)
        let currentTask = coordinator.readinessTask
        continuation?.resume(returning: true)
        await supersededTask?.value
        await currentTask?.value

        XCTAssertEqual(checks, 3)
        XCTAssertEqual(
            state.value,
            .failed("The remote app opened but did not finish starting. Try again.")
        )
    }

    func testWebContentTerminationBecomesVisibleFailure() {
        let (coordinator, state) = makeCoordinator(initialState: .ready)
        coordinator.webViewWebContentProcessDidTerminate(WKWebView())
        XCTAssertEqual(
            state.value,
            .failed("The remote app stopped unexpectedly. Try again.")
        )
    }

    func testBridgeListConnectUseAndForgetActionsReturnEncodedReplies() async throws {
        let first = connection(address: "https://one.example", token: "gateway-token-one-0001")
        let second = connection(address: "https://two.example", token: "gateway-token-two-0002")
        let store = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
        )
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        let (coordinator, _) = makeCoordinator(model: model, initialState: .ready)
        var scripts: [String] = []
        coordinator.javaScriptEvaluator = {
            scripts.append($0)
            return nil
        }

        func assertRedactsTokens(_ script: String, _ tokens: [String], line: UInt = #line) {
            for token in tokens {
                XCTAssertFalse(
                    script.contains(token),
                    "A bridge reply leaked a gateway token",
                    line: line
                )
            }
        }

        await coordinator.handleBridgeRequest(id: "list-id", action: "list", body: [:])
        XCTAssertTrue(try XCTUnwrap(scripts.last).contains(#""list-id", true"#))
        XCTAssertTrue(try XCTUnwrap(scripts.last).contains(#""credentialStorage":"secure""#))
        assertRedactsTokens(try XCTUnwrap(scripts.last), [first.token, second.token])

        await coordinator.handleBridgeRequest(
            id: "probe-id",
            action: "probe",
            body: ["connectionId": first.id.uuidString]
        )
        XCTAssertEqual(try XCTUnwrap(scripts.last), replyScript(id: "probe-id", ok: true, literal: "true"))

        await coordinator.handleBridgeRequest(
            id: "use-id",
            action: "use",
            body: ["connectionId": second.id.uuidString]
        )
        XCTAssertEqual(model.activeConnection?.id, second.id)
        XCTAssertEqual(coordinator.requestedConnection?.id, second.id)
        XCTAssertFalse(coordinator.isSwitchingThroughBridge)
        XCTAssertTrue(try XCTUnwrap(scripts.last).contains(#""use-id", true"#))
        assertRedactsTokens(try XCTUnwrap(scripts.last), [first.token, second.token])

        await coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": first.id.uuidString]
        )
        XCTAssertEqual(model.vault.connections.map(\.id), [second.id])
        XCTAssertTrue(try XCTUnwrap(scripts.last).contains(#""forget-id", true"#))
        assertRedactsTokens(try XCTUnwrap(scripts.last), [first.token, second.token])

        let emptyModel = ConnectionModel(
            credentialStore: MemoryCredentialStore(),
            validator: MockValidator()
        )
        let (connectCoordinator, _) = makeCoordinator(model: emptyModel)
        var connectScripts: [String] = []
        connectCoordinator.javaScriptEvaluator = {
            connectScripts.append($0)
            return nil
        }
        await connectCoordinator.handleBridgeRequest(
            id: "connect-id",
            action: "connect",
            body: [
                "address": "https://new.example",
                "token": "gateway-token-new-123",
            ]
        )
        XCTAssertEqual(emptyModel.activeConnection?.address.absoluteString, "https://new.example")
        XCTAssertEqual(connectCoordinator.requestedConnection, emptyModel.activeConnection)
        XCTAssertFalse(connectCoordinator.isSwitchingThroughBridge)
        XCTAssertTrue(try XCTUnwrap(connectScripts.last).contains(#""connect-id", true"#))
        assertRedactsTokens(try XCTUnwrap(connectScripts.last), ["gateway-token-new-123"])
    }

    func testBridgeRejectsInvalidAndUnsupportedRequests() async throws {
        let (coordinator, _) = makeCoordinator()
        var scripts: [String] = []
        coordinator.javaScriptEvaluator = {
            scripts.append($0)
            return nil
        }

        // Every rejected request must leave the bridge switch flag clear, or a
        // SwiftUI update would be ignored forever. Arm it before each request so
        // the assertion observes the failure path clearing it.
        for request in [
            ("bad-connect", "connect", ["address": "https://desk.example"]),
            ("bad-probe", "probe", [:]),
            ("bad-use", "use", [:]),
            ("bad-forget", "forget", [:]),
            ("bad-action", "destroy", [:]),
        ] as [(String, String, [String: Any])] {
            coordinator.isSwitchingThroughBridge = true
            await coordinator.handleBridgeRequest(id: request.0, action: request.1, body: request.2)
            XCTAssertFalse(
                coordinator.isSwitchingThroughBridge,
                "\(request.1) left the bridge switch armed"
            )
            XCTAssertNil(coordinator.requestedConnection)
        }

        XCTAssertEqual(scripts.count, 5)
        XCTAssertTrue(scripts[0].contains(#""bad-connect", false"#))
        XCTAssertTrue(scripts[0].contains("connection details were incomplete"))
        XCTAssertTrue(scripts[1].contains(#""bad-probe", false"#))
        XCTAssertTrue(scripts[2].contains(#""bad-use", false"#))
        XCTAssertTrue(scripts[3].contains(#""bad-forget", false"#))
        XCTAssertTrue(scripts[4].contains(#""bad-action", false"#))
        XCTAssertTrue(scripts[4].contains("action is not supported"))
    }

    func testBridgeRecoversSwitchWhenJavaScriptEvaluationFails() async throws {
        let model = ConnectionModel(
            credentialStore: MemoryCredentialStore(),
            validator: MockValidator()
        )
        let (coordinator, state) = makeCoordinator(model: model, initialState: .ready)
        var evaluations = 0
        var scripts: [String] = []
        coordinator.javaScriptEvaluator = {
            evaluations += 1
            scripts.append($0)
            throw TestFailure.expected
        }

        await coordinator.handleBridgeRequest(
            id: "connect-id",
            action: "connect",
            body: [
                "address": "https://new.example",
                "token": "gateway-token-new-123",
            ]
        )

        XCTAssertEqual(evaluations, 2)
        XCTAssertFalse(coordinator.isSwitchingThroughBridge)
        XCTAssertEqual(coordinator.requestedConnection, model.activeConnection)
        XCTAssertEqual(state.value, .loading)
        XCTAssertNil(coordinator.authenticatedConnection)

        XCTAssertEqual(scripts.count, 2)
        XCTAssertTrue(
            scripts[0].hasPrefix(#"window.__orkestratorNativeConnectionReply("connect-id", true, {"#),
            "Unexpected resolve script: \(scripts[0])"
        )
        XCTAssertEqual(
            scripts[1],
            try rejectionScript(id: "connect-id", error: TestFailure.expected)
        )
    }

    func testBridgeRecoversUseSwitchWhenJavaScriptEvaluationFails() async throws {
        let first = connection(address: "https://one.example")
        let second = connection(address: "https://two.example")
        let model = ConnectionModel(
            credentialStore: MemoryCredentialStore(
                vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
            ),
            validator: MockValidator()
        )
        let (coordinator, state) = makeCoordinator(model: model, initialState: .ready)
        var scripts: [String] = []
        coordinator.javaScriptEvaluator = {
            scripts.append($0)
            throw TestFailure.expected
        }

        await coordinator.handleBridgeRequest(
            id: "use-id",
            action: "use",
            body: ["connectionId": second.id.uuidString]
        )

        XCTAssertFalse(coordinator.isSwitchingThroughBridge)
        XCTAssertEqual(coordinator.requestedConnection?.id, second.id)
        XCTAssertEqual(coordinator.requestedConnection, model.activeConnection)
        XCTAssertEqual(state.value, .loading)
        XCTAssertNil(coordinator.authenticatedConnection)

        XCTAssertEqual(scripts.count, 2)
        XCTAssertTrue(
            scripts[0].hasPrefix(#"window.__orkestratorNativeConnectionReply("use-id", true, {"#),
            "Unexpected resolve script: \(scripts[0])"
        )
        XCTAssertEqual(
            scripts[1],
            try rejectionScript(id: "use-id", error: TestFailure.expected)
        )
    }

    func testBridgeClearsSwitchWhenTheConnectionModelFailsBeforeReplying() async throws {
        let first = connection(address: "https://one.example")
        let second = connection(address: "https://two.example")
        let validator = MockValidator()
        let model = ConnectionModel(
            credentialStore: MemoryCredentialStore(
                vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
            ),
            validator: validator
        )
        let (coordinator, state) = makeCoordinator(model: model, initialState: .ready)
        var scripts: [String] = []
        coordinator.javaScriptEvaluator = {
            scripts.append($0)
            return nil
        }
        validator.checkError = TestFailure.expected

        // `connect` throws before its `defer` is installed, so only the `catch`
        // can clear the switch, and nothing may be re-authenticated.
        await coordinator.handleBridgeRequest(
            id: "connect-id",
            action: "connect",
            body: [
                "address": "https://new.example",
                "token": "gateway-token-new-123",
            ]
        )
        XCTAssertFalse(coordinator.isSwitchingThroughBridge)
        XCTAssertNil(coordinator.requestedConnection)
        XCTAssertEqual(state.value, .ready)
        XCTAssertEqual(model.activeConnection?.id, first.id)
        XCTAssertEqual(scripts.count, 1)
        XCTAssertEqual(scripts[0], try rejectionScript(id: "connect-id", error: TestFailure.expected))

        await coordinator.handleBridgeRequest(
            id: "use-id",
            action: "use",
            body: ["connectionId": second.id.uuidString]
        )
        XCTAssertFalse(coordinator.isSwitchingThroughBridge)
        XCTAssertNil(coordinator.requestedConnection)
        XCTAssertEqual(state.value, .ready)
        XCTAssertEqual(model.activeConnection?.id, first.id)
        XCTAssertEqual(scripts.count, 2)
        XCTAssertEqual(scripts[1], try rejectionScript(id: "use-id", error: TestFailure.expected))
    }

    func testBridgeSwitchAuthenticatesTheNewActiveConnectionForReal() async throws {
        let model = ConnectionModel(
            credentialStore: MemoryCredentialStore(),
            validator: MockValidator()
        )
        // No `authenticationStarter`, so the production branch of
        // `finishBridgeSwitch` runs `authenticate(_:)` itself.
        let (coordinator, state) = makeCoordinator(
            model: model,
            initialState: .ready,
            stubAuthentication: false
        )
        coordinator.javaScriptEvaluator = { _ in nil }

        await coordinator.handleBridgeRequest(
            id: "connect-id",
            action: "connect",
            body: [
                "address": "https://new.example",
                "token": "gateway-token-new-123",
            ]
        )

        XCTAssertFalse(coordinator.isSwitchingThroughBridge)
        XCTAssertEqual(coordinator.requestedConnection, model.activeConnection)
        XCTAssertNil(coordinator.authenticatedConnection)
        XCTAssertEqual(state.value, .loading)

        // The login never leaves the process: the coordinator has no web view,
        // so the task exits without touching the network or the state.
        await coordinator.authenticationTask?.value
        XCTAssertEqual(state.value, .loading)
    }

    func testBridgeJSONEncodingFailureIsNormalizedAndJavaScriptStringsAreSafe() throws {
        let (coordinator, _) = makeCoordinator()
        XCTAssertThrowsError(try coordinator.jsonLiteral(FailingEncodable())) {
            guard case ConnectionBridgeError.encodingFailed = $0 else {
                return XCTFail("Unexpected error: \($0)")
            }
        }

        let literal = try coordinator.jsonLiteral("id\"\\\n</script>\u{2028}")
        XCTAssertEqual(
            try JSONDecoder().decode(String.self, from: Data(literal.utf8)),
            "id\"\\\n</script>\u{2028}"
        )
    }

    func testTeardownCancelsAuthenticationAndClearsCoordinatorState() {
        var state = WebViewState.loading
        let binding = Binding(get: { state }, set: { state = $0 })
        let model = ConnectionModel(credentialStore: MemoryCredentialStore(), validator: MockValidator())
        let coordinator = RemoteWebView.Coordinator(model: model, state: binding)
        coordinator.state.wrappedValue = .retrying(UUID())
        coordinator.authenticate(saved)
        let task = Task<Void, Never> { try? await Task.sleep(for: .seconds(10)) }
        let readinessTask = Task<Void, Never> { try? await Task.sleep(for: .seconds(10)) }
        coordinator.authenticationTask = task
        coordinator.readinessTask = readinessTask
        coordinator.authenticatedConnection = saved
        coordinator.isSwitchingThroughBridge = true
        coordinator.javaScriptEvaluator = { _ in nil }
        coordinator.authenticationStarter = { _ in }

        coordinator.teardown()

        XCTAssertTrue(task.isCancelled)
        XCTAssertTrue(readinessTask.isCancelled)
        XCTAssertNil(coordinator.authenticationTask)
        XCTAssertNil(coordinator.readinessTask)
        XCTAssertNil(coordinator.handledRetryID)
        XCTAssertNil(coordinator.requestedConnection)
        XCTAssertNil(coordinator.authenticatedConnection)
        XCTAssertFalse(coordinator.isSwitchingThroughBridge)
        XCTAssertNil(coordinator.javaScriptEvaluator)
        XCTAssertNil(coordinator.authenticationStarter)
    }

    func testAuthenticateIgnoresRedundantRequestsAndCancelsThePreviousAttempt() async {
        let other = connection(address: "https://other.example")
        let (coordinator, state) = makeCoordinator(initialState: .ready)
        let inFlight = Task<Void, Never> { try? await Task.sleep(for: .seconds(30)) }
        coordinator.authenticationTask = inFlight
        coordinator.beginAuthenticationState(for: saved)
        XCTAssertEqual(state.value, .loading)

        // The same connection while it is already loading must not restart.
        coordinator.authenticate(saved)
        XCTAssertFalse(inFlight.isCancelled)
        XCTAssertEqual(coordinator.requestedConnection, saved)

        // A retry of the same connection from a settled state does restart, and
        // the superseded attempt is cancelled rather than left racing.
        state.value = .ready
        coordinator.authenticate(saved)
        XCTAssertTrue(inFlight.isCancelled)
        XCTAssertEqual(state.value, .loading)
        XCTAssertEqual(coordinator.requestedConnection, saved)
        XCTAssertNil(coordinator.authenticatedConnection)
        await coordinator.authenticationTask?.value

        // A different connection restarts even while the current one is loading.
        let superseded = Task<Void, Never> { try? await Task.sleep(for: .seconds(30)) }
        coordinator.authenticationTask = superseded
        XCTAssertEqual(state.value, .loading)
        coordinator.authenticate(other)
        XCTAssertTrue(superseded.isCancelled)
        XCTAssertEqual(coordinator.requestedConnection, other)
        await coordinator.authenticationTask?.value
    }

    func testAuthenticateReportsLoginFailureAsATerminalState() async {
        let (coordinator, state) = makeCoordinator(initialState: .ready)
        let webView = WKWebView()
        coordinator.webView = webView
        coordinator.loginProtocolClasses = [StubURLProtocol.self]
        var loginRequests = 0
        StubURLProtocol.handler = { request in
            loginRequests += 1
            return (
                HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: "HTTP/1.1", headerFields: nil)!,
                Data()
            )
        }

        coordinator.authenticate(saved)
        XCTAssertEqual(state.value, .loading)
        await coordinator.authenticationTask?.value

        XCTAssertEqual(loginRequests, 1)
        XCTAssertEqual(state.value, .failed("The saved gateway token was rejected."))
        XCTAssertNil(coordinator.authenticatedConnection)
        XCTAssertEqual(coordinator.requestedConnection, saved)
        withExtendedLifetime(webView) {}
    }

    func testAuthenticateAbandonsAFailureForASupersededConnection() async {
        let other = connection(address: "https://other.example")
        let (coordinator, state) = makeCoordinator(initialState: .ready)
        let webView = WKWebView()
        coordinator.webView = webView
        coordinator.loginProtocolClasses = [StubURLProtocol.self]
        StubURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }

        coordinator.authenticate(saved)
        let attempt = coordinator.authenticationTask
        // The user switches server before the first login resolves.
        coordinator.beginAuthenticationState(for: other)
        await attempt?.value

        XCTAssertEqual(state.value, .loading)
        XCTAssertEqual(coordinator.requestedConnection, other)
        withExtendedLifetime(webView) {}
    }

    func testViewUpdatesRetryEagerlyAndYieldToBridgeSwitches() async {
        let other = connection(address: "https://other.example")

        // Already showing the requested connection: no reload.
        let (settled, settledState) = makeCoordinator(initialState: .ready)
        settled.authenticatedConnection = saved
        settled.synchronizeAuthentication(with: saved)
        XCTAssertNil(settled.requestedConnection)
        XCTAssertEqual(settled.authenticatedConnection, saved)
        XCTAssertEqual(settledState.value, .ready)

        // A different connection reloads.
        settled.synchronizeAuthentication(with: other)
        XCTAssertEqual(settled.requestedConnection, other)
        XCTAssertNil(settled.authenticatedConnection)
        XCTAssertEqual(settledState.value, .loading)
        await settled.authenticationTask?.value

        // A bridge switch owns authentication; a SwiftUI update must not race it.
        let (switching, switchingState) = makeCoordinator(initialState: .ready)
        switching.isSwitchingThroughBridge = true
        switching.synchronizeAuthentication(with: saved)
        XCTAssertNil(switching.requestedConnection)
        XCTAssertEqual(switchingState.value, .ready)

        // Retrying reloads even when that connection is already authenticated.
        let (retrying, retryingState) = makeCoordinator(initialState: .ready)
        retrying.authenticatedConnection = saved
        let retryID = UUID()
        retryingState.value = .retrying(retryID)
        retrying.synchronizeAuthentication(with: saved)
        XCTAssertEqual(retrying.requestedConnection, saved)
        XCTAssertNil(retrying.authenticatedConnection)
        XCTAssertEqual(retryingState.value, .retrying(retryID))
        XCTAssertEqual(retrying.handledRetryID, retryID)
        let firstAttempt = Task<Void, Never> { try? await Task.sleep(for: .seconds(30)) }
        retrying.authenticationTask = firstAttempt
        retrying.synchronizeAuthentication(with: saved)
        XCTAssertFalse(firstAttempt.isCancelled)

        // The token is scoped to the connection it started. A connection
        // change with the same token must still begin a new attempt.
        retrying.synchronizeAuthentication(with: other)
        XCTAssertTrue(firstAttempt.isCancelled)
        XCTAssertEqual(retrying.requestedConnection, other)

        let secondAttempt = Task<Void, Never> { try? await Task.sleep(for: .seconds(30)) }
        retrying.authenticationTask = secondAttempt
        let nextRetryID = UUID()
        retryingState.value = .retrying(nextRetryID)
        retrying.synchronizeAuthentication(with: other)
        XCTAssertTrue(secondAttempt.isCancelled)
        XCTAssertEqual(retrying.handledRetryID, nextRetryID)
        await retrying.authenticationTask?.value
    }

    func testBeginAuthenticationStateAvoidsRedundantLoadingAndRetryWrites() {
        let (loading, loadingState) = makeCoordinator()
        loading.beginAuthenticationState(for: saved)
        XCTAssertEqual(loadingState.value, .loading)
        XCTAssertEqual(loadingState.bindingWriteCount, 0)

        let retryID = UUID()
        let (retrying, retryingState) = makeCoordinator(initialState: .retrying(retryID))
        retrying.beginAuthenticationState(for: saved)
        XCTAssertEqual(retryingState.value, .retrying(retryID))
        XCTAssertEqual(retryingState.bindingWriteCount, 0)

        let (settled, settledState) = makeCoordinator(initialState: .ready)
        settled.beginAuthenticationState(for: saved)
        XCTAssertEqual(settledState.value, .loading)
        XCTAssertEqual(settledState.bindingWriteCount, 1)
    }

    func testLoginExchangePostsTheTokenInTheBodyAndReturnsTheSessionCookie() async throws {
        let target = connection(address: "https://desk.example", token: "gateway-token-secret-01")
        let (coordinator, _) = makeCoordinator()
        coordinator.loginProtocolClasses = [StubURLProtocol.self]
        var captured: URLRequest?
        StubURLProtocol.handler = { request in
            captured = request
            return (
                HTTPURLResponse(url: request.url!, statusCode: 303, httpVersion: "HTTP/1.1", headerFields: [
                    "Location": "https://desk.example/",
                    "Set-Cookie": "orkestrator_gateway_auth=session-value; Path=/; Secure; HttpOnly; SameSite=Strict",
                ])!,
                Data()
            )
        }

        let cookie = try await coordinator.loginCookie(for: target)
        XCTAssertEqual(cookie.name, "orkestrator_gateway_auth")
        XCTAssertEqual(cookie.value, "session-value")

        let request = try XCTUnwrap(captured)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://desk.example/__orkestrator/login"
        )
        // The token must never reach a server log or a Referer header.
        XCTAssertNil(request.url?.query)
        XCTAssertFalse(try XCTUnwrap(request.url?.absoluteString).contains(target.token))
        XCTAssertEqual(httpBody(of: request), "token=gateway-token-secret-01")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Content-Type"),
            "application/x-www-form-urlencoded; charset=utf-8"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
    }

    func testLoginExchangeSurfacesRejectedTokensAndTransportFailures() async {
        let target = connection(address: "https://desk.example", token: "gateway-token-secret-01")
        let (coordinator, _) = makeCoordinator()
        coordinator.loginProtocolClasses = [StubURLProtocol.self]

        StubURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: "HTTP/1.1", headerFields: nil)!, Data())
        }
        await assertAsyncErrorContains("token was rejected") {
            _ = try await coordinator.loginCookie(for: target)
        }

        StubURLProtocol.handler = { _ in throw URLError(.timedOut) }
        await assertAsyncErrorContains("20 seconds") {
            _ = try await coordinator.loginCookie(for: target)
        }

        StubURLProtocol.handler = { _ in throw URLError(.serverCertificateUntrusted) }
        await assertAsyncErrorContains("certificate") {
            _ = try await coordinator.loginCookie(for: target)
        }
    }

    func testLoginRedirectBlockerRefusesToFollowRedirects() {
        let loginURL = URL(string: "https://desk.example/__orkestrator/login")!
        let blocker = LoginRedirectBlocker()
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: loginURL)
        let redirect = HTTPURLResponse(
            url: loginURL,
            statusCode: 307,
            httpVersion: "HTTP/1.1",
            headerFields: ["Location": "https://attacker.example/collect"]
        )!

        var handled = false
        var followed: URLRequest? = URLRequest(url: URL(string: "https://attacker.example/collect")!)
        blocker.urlSession(
            session,
            task: task,
            willPerformHTTPRedirection: redirect,
            newRequest: URLRequest(url: URL(string: "https://attacker.example/collect")!)
        ) { request in
            handled = true
            followed = request
        }

        XCTAssertTrue(handled)
        // A followed 307 would replay the POST body, and the token with it.
        XCTAssertNil(followed)
    }

    func testBridgeScriptExposesOnlyConnectionSummaries() {
        let script = RemoteWebView.Coordinator.connectionBridgeScript
        XCTAssertTrue(script.contains("list: () => call(\"list\")"))
        XCTAssertTrue(script.contains("probe: (connectionId) => call(\"probe\""))
        XCTAssertTrue(script.contains("forget: (connectionId)"))

        let actions = script
            .components(separatedBy: "call(\"")
            .dropFirst()
            .map { String($0.prefix(while: { $0 != "\"" })) }
        XCTAssertEqual(actions, ["list", "probe", "connect", "use", "forget"])
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
