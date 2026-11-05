import Security
import XCTest
@testable import OrkestratorMobile

@MainActor
final class VaultReadFailureTests: XCTestCase {
    private let lockedError = KeychainError(status: errSecInteractionNotAllowed)
    private let first = connection(address: "https://one.example")
    private let second = connection(address: "https://two.example")

    /// A store whose read fails the way a locked device's does, over two saved servers.
    private func makeLockedStore() -> MemoryCredentialStore {
        let store = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
        )
        store.loadError = lockedError
        return store
    }

    func testFailedReadShowsAnEmptyListWithoutCallingItLost() {
        let store = makeLockedStore()
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())

        XCTAssertEqual(model.vault, .empty)
        XCTAssertFalse(model.requiresLaunchSelection)
        XCTAssertEqual(model.connectionError, ConnectionModelError.vaultUnreadable.errorDescription)
        XCTAssertTrue(try XCTUnwrap(model.connectionError).contains("have not been removed"))
    }

    func testConnectingWhileTheReadStillFailsRefusesTheSaveAndSaysWhy() async throws {
        let store = makeLockedStore()
        let storedVault = store.vault
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        model.draftAddress = "https://new.example"
        model.draftToken = "gateway-token-new-123"
        XCTAssertFalse(model.isShowingConnectionEditor)

        await model.connectDraft()

        XCTAssertTrue(store.savedVaults.isEmpty)
        XCTAssertEqual(store.vault, storedVault)
        XCTAssertEqual(model.vault, .empty)
        XCTAssertEqual(model.connectionError, ConnectionModelError.saveRefused.errorDescription)
        XCTAssertTrue(try XCTUnwrap(model.connectionError).contains("Nothing was saved"))
        // The user can try again after unlocking without typing the token again.
        XCTAssertEqual(model.draftToken, "gateway-token-new-123")
        XCTAssertFalse(model.isShowingConnectionEditor, "The failed launch read uses the inline editor")

        store.loadError = nil
        model.retryVaultReadIfFailed()
        XCTAssertTrue(model.isShowingConnectionEditor, "Recovery presents the saved draft above the picker")
        XCTAssertEqual(model.draftAddress, "https://new.example")
        XCTAssertEqual(model.draftToken, "gateway-token-new-123")
        XCTAssertNil(model.connectionError)
        await model.connectDraft()
        XCTAssertEqual(model.vault.connections.count, 3)
        XCTAssertEqual(model.draftToken, "")
        XCTAssertFalse(model.isShowingConnectionEditor)
    }

    func testSelectingASavedServerClearsARecoveredDraft() async {
        let store = makeLockedStore()
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        model.draftAddress = "https://new.example"
        model.draftToken = "gateway-token-new-123"
        await model.connectDraft()
        store.loadError = nil
        model.retryVaultReadIfFailed()
        model.dismissConnectionEditor()
        await model.selectConnectionForLaunch(first)
        XCTAssertEqual(model.draftToken, "")
        XCTAssertFalse(model.isShowingConnectionEditor)
        XCTAssertFalse(model.requiresLaunchSelection)
    }

    func testConnectingAfterTheReadRecoversAddsToTheSavedServers() async throws {
        let store = makeLockedStore()
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())

        store.loadError = nil
        model.draftAddress = "https://new.example"
        model.draftToken = "gateway-token-new-123"
        await model.connectDraft()

        XCTAssertNil(model.connectionError)
        XCTAssertEqual(store.savedVaults.count, 1)
        XCTAssertEqual(
            Set(store.vault.connections.map(\.address.absoluteString)),
            ["https://one.example", "https://two.example", "https://new.example"]
        )
        XCTAssertEqual(store.vault.activeConnection?.address.absoluteString, "https://new.example")
        XCTAssertEqual(model.vault, store.vault)
        XCTAssertFalse(model.requiresLaunchSelection)
    }

    func testReadIsRepeatedAfterTheChecksAwaitNotBeforeIt() async throws {
        let store = makeLockedStore()
        let validator = MockValidator()
        let model = ConnectionModel(credentialStore: store, validator: validator)
        // The device locks again while the connection is being checked.
        store.loadError = nil
        validator.checkHandler = { _, _ in store.loadError = KeychainError(status: errSecInteractionNotAllowed) }

        await assertAsyncErrorContains("Nothing was saved") {
            _ = try await model.connect(address: "https://new.example", token: "gateway-token-new-123")
        }
        XCTAssertTrue(store.savedVaults.isEmpty)
    }

    func testEveryOtherWriteIsRefusedWhileTheReadFails() async throws {
        let store = makeLockedStore()
        let storedVault = store.vault
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        let id = first.id.uuidString

        XCTAssertThrowsError(try model.forget(connectionID: id)) {
            XCTAssertEqual($0 as? ConnectionModelError, .saveRefused)
        }
        // An unknown id over an unread vault used to reach `delete()`.
        XCTAssertThrowsError(try model.forget(connectionID: UUID().uuidString)) {
            XCTAssertEqual($0 as? ConnectionModelError, .saveRefused)
        }
        XCTAssertThrowsError(try model.rename(connectionID: id, nickname: "Desk")) {
            XCTAssertEqual($0 as? ConnectionModelError, .saveRefused)
        }
        await assertAsyncErrorContains("Nothing was saved") {
            _ = try await model.use(connectionID: id)
        }
        XCTAssertEqual(store.deleteCount, 0)
        XCTAssertTrue(store.savedVaults.isEmpty)
        XCTAssertEqual(store.vault, storedVault)
    }

    func testForegroundRetryBringsTheListBackAfterAFailedAttempt() {
        let store = makeLockedStore()
        let storedVault = store.vault
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())

        model.retryVaultReadIfFailed()
        XCTAssertEqual(model.vault, .empty)
        XCTAssertEqual(model.connectionError, ConnectionModelError.vaultUnreadable.errorDescription)

        store.loadError = nil
        model.retryVaultReadIfFailed()
        XCTAssertEqual(model.vault, storedVault)
        XCTAssertTrue(model.requiresLaunchSelection)
        XCTAssertNil(model.connectionError)
        XCTAssertTrue(store.savedVaults.isEmpty, "Reading must not write")
    }

    func testForegroundRetryClearsARefusalAndKeepsAnUnrelatedError() async {
        let store = makeLockedStore()
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        model.draftAddress = "https://new.example"
        model.draftToken = "gateway-token-new-123"
        await model.connectDraft()
        XCTAssertEqual(model.connectionError, ConnectionModelError.saveRefused.errorDescription)

        model.retryVaultReadIfFailed()
        XCTAssertEqual(model.connectionError, ConnectionModelError.saveRefused.errorDescription)

        store.loadError = nil
        model.retryVaultReadIfFailed()
        XCTAssertNil(model.connectionError)

        let other = ConnectionModel(credentialStore: makeLockedStore(), validator: MockValidator())
        other.connectionError = "The gateway token was rejected."
        other.retryVaultReadIfFailed()
        XCTAssertEqual(other.connectionError, "The gateway token was rejected.")
    }

    func testForegroundRetryLeavesAWorkingModelAlone() async {
        let store = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: first.id, connections: [first])
        )
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        await model.selectConnectionForLaunch(first)
        XCTAssertFalse(model.requiresLaunchSelection)
        let vault = model.vault

        // Each return to the foreground must not send the user back to the picker.
        store.vault = .empty
        model.retryVaultReadIfFailed()

        XCTAssertEqual(model.vault, vault)
        XCTAssertFalse(model.requiresLaunchSelection)
    }

    func testForegroundRetryOfAnEmptyVaultStaysOnTheEditor() {
        let store = MemoryCredentialStore()
        store.loadError = lockedError
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())

        store.loadError = nil
        model.retryVaultReadIfFailed()

        XCTAssertFalse(model.requiresLaunchSelection)
        XCTAssertNil(model.connectionError)
    }

    func testAFailedSaveAfterARecoveredReadStillBringsTheListBack() async {
        let store = makeLockedStore()
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        store.loadError = nil
        store.saveError = TestFailure.expected

        await XCTAssertThrowsErrorAsync(
            try await model.connect(address: "https://new.example", token: "gateway-token-new-123")
        )

        // The read worked, so the list is back even though the new server was not saved.
        XCTAssertEqual(model.vault.connections.map(\.id), [first.id, second.id])
        XCTAssertTrue(model.requiresLaunchSelection)
    }

    func testMalformedDataKeepsItsDocumentedRecovery() async throws {
        let store = makeLockedStore()
        store.loadError = KeychainError.invalidData
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        XCTAssertEqual(
            model.connectionError,
            "The saved connection could not be read. Remove it and connect again."
        )

        // A foreground retry reads the same bytes and changes nothing.
        model.retryVaultReadIfFailed()
        XCTAssertEqual(
            model.connectionError,
            "The saved connection could not be read. Remove it and connect again."
        )

        _ = try await model.connect(address: "https://new.example", token: "gateway-token-new-123")

        XCTAssertEqual(store.savedVaults.count, 1)
        XCTAssertEqual(store.vault.connections.map(\.address.absoluteString), ["https://new.example"])
        XCTAssertEqual(model.vault, store.vault)
    }

    func testMalformedDataCanBeRemovedByForgetting() throws {
        let store = makeLockedStore()
        store.loadError = KeychainError.invalidData
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())

        _ = try model.forget(connectionID: UUID().uuidString)

        XCTAssertEqual(store.deleteCount, 1)
    }

    func testAFailedReadAfterMalformedDataIsStillRefused() async {
        let store = makeLockedStore()
        store.loadError = KeychainError.invalidData
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())

        // Only the read made just before the write decides; the first one is stale.
        store.loadError = lockedError
        await assertAsyncErrorContains("Nothing was saved") {
            _ = try await model.connect(address: "https://new.example", token: "gateway-token-new-123")
        }
        XCTAssertTrue(store.savedVaults.isEmpty)
    }

    func testMalformedDataInTheRealKeychainIsReplacedByConnecting() async throws {
        let keychain = KeychainCredentialStore(
            service: "dev.orkestrator.mobile.tests.\(UUID().uuidString)",
            account: "vault"
        )
        defer { try? keychain.delete() }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychain.service,
            kSecAttrAccount as String: keychain.account,
            kSecValueData as String: Data("not-json".utf8),
        ]
        XCTAssertEqual(SecItemAdd(query as CFDictionary, nil), errSecSuccess)

        let model = ConnectionModel(credentialStore: keychain, validator: MockValidator())
        XCTAssertEqual(model.vault, .empty)
        XCTAssertTrue(try XCTUnwrap(model.connectionError).contains("could not be read"))

        _ = try await model.connect(address: "https://new.example", token: "gateway-token-new-123")

        XCTAssertEqual(try keychain.load().connections.map(\.address.absoluteString), ["https://new.example"])
    }
}
