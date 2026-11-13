import SwiftUI
import WebKit
import XCTest
@testable import OrkestratorMobile

/// Stands in for the native alert. `.wait` holds the question until the test
/// answers it, or until the gate withdraws it.
@MainActor
final class ScriptedConsentPresenter: BridgeConsentPresenting {
    enum Behaviour {
        case approve
        case decline
        case cannotShow
        case wait
    }

    var behaviour: Behaviour
    private(set) var requests: [BridgeConsentRequest] = []
    private(set) var withdrawals = 0
    private var heldAnswer: (@MainActor (Bool) -> Void)?

    init(_ behaviour: Behaviour) {
        self.behaviour = behaviour
    }

    var isShowing: Bool { heldAnswer != nil }

    func present(
        _ request: BridgeConsentRequest,
        answer: @escaping @MainActor (Bool) -> Void
    ) -> (() -> Void)? {
        requests.append(request)
        switch behaviour {
        case .approve:
            answer(true)
            return {}
        case .decline:
            answer(false)
            return {}
        case .cannotShow:
            return nil
        case .wait:
            heldAnswer = answer
            return { [weak self] in
                self?.withdrawals += 1
                self?.heldAnswer = nil
            }
        }
    }

    /// Answers as the user would; does nothing once the question is gone.
    func answer(_ approved: Bool) {
        let answer = heldAnswer
        heldAnswer = nil
        answer?(approved)
    }
}

/// To-do 5600 (retired): a page changes the saved servers only after the user agrees
/// natively, and a token for another server is typed into the native editor.
@MainActor
final class BridgeConsentTests: XCTestCase {
    private let first = connection(address: "https://desk.example", token: "gateway-token-first-1")
    private let second = connection(address: "https://studio.example", token: "gateway-token-second-2")

    private struct Harness {
        let coordinator: RemoteWebView.Coordinator
        let model: ConnectionModel
        let store: MemoryCredentialStore
        let validator: MockValidator
        let presenter: ScriptedConsentPresenter
        let scripts: () -> [String]
    }

    private func makeHarness(_ behaviour: ScriptedConsentPresenter.Behaviour) -> Harness {
        let store = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: first.id, connections: [first, second])
        )
        let validator = MockValidator()
        let model = ConnectionModel(credentialStore: store, validator: validator)
        let coordinator = RemoteWebView.Coordinator(
            model: model,
            state: Binding(get: { .ready }, set: { _ in })
        )
        let presenter = ScriptedConsentPresenter(behaviour)
        coordinator.consentGate.presenter = presenter
        coordinator.authenticationStarter = { [weak coordinator] connection in
            coordinator?.beginAuthenticationState(for: connection)
        }
        coordinator.beginAuthenticationState(for: first)
        var scripts: [String] = []
        coordinator.javaScriptEvaluator = {
            scripts.append($0)
            return nil
        }
        return Harness(
            coordinator: coordinator,
            model: model,
            store: store,
            validator: validator,
            presenter: presenter,
            scripts: { scripts }
        )
    }

    private func refusal(_ id: String, _ error: ConnectionBridgeError) -> String {
        "window.__orkestratorNativeConnectionReply(\"\(id)\", false, \"\(error.errorDescription!)\")"
    }

    // MARK: The gate

    func testTheGateReturnsTheUsersAnswer() async {
        let approving = BridgeConsentGate(presenter: ScriptedConsentPresenter(.approve))
        let approved = await approving.ask(.forget(first))
        XCTAssertEqual(approved, .approved)

        let declining = BridgeConsentGate(presenter: ScriptedConsentPresenter(.decline))
        let declined = await declining.ask(.forget(first))
        XCTAssertEqual(declined, .declined)
        XCTAssertFalse(declining.isAsking)
    }

    func testAPromptThatCannotBeShownRefuses() async {
        let presenter = ScriptedConsentPresenter(.cannotShow)
        let gate = BridgeConsentGate(presenter: presenter)
        let outcome = await gate.ask(.switchTo(second))
        XCTAssertEqual(outcome, .declined)
        XCTAssertEqual(presenter.requests, [.switchTo(second)])
        XCTAssertFalse(gate.isAsking)
    }

    func testAnUnansweredPromptTimesOutAsARefusalAndIsWithdrawn() async {
        let presenter = ScriptedConsentPresenter(.wait)
        let gate = BridgeConsentGate(presenter: presenter, timeout: .milliseconds(50))
        let outcome = await gate.ask(.forget(first))
        XCTAssertEqual(outcome, .timedOut)
        XCTAssertEqual(presenter.withdrawals, 1)
        XCTAssertFalse(presenter.isShowing)
        XCTAssertFalse(gate.isAsking)
        // A tap that lands after the timeout changes nothing.
        presenter.answer(true)
        XCTAssertFalse(gate.isAsking)
    }

    func testASecondRequestIsRefusedWhileOneIsWaiting() async {
        let presenter = ScriptedConsentPresenter(.wait)
        let gate = BridgeConsentGate(presenter: presenter)
        let waiting = Task { await gate.ask(.forget(first)) }
        while !presenter.isShowing { await Task.yield() }

        let secondOutcome = await gate.ask(.forget(second))
        XCTAssertEqual(secondOutcome, .busy)
        XCTAssertEqual(presenter.requests, [.forget(first)])

        presenter.answer(true)
        let firstOutcome = await waiting.value
        XCTAssertEqual(firstOutcome, .approved)
        XCTAssertFalse(gate.isAsking)
    }

    func testCancellingRefusesAndWithdrawsTheWaitingPrompt() async {
        let presenter = ScriptedConsentPresenter(.wait)
        let gate = BridgeConsentGate(presenter: presenter)
        let waiting = Task { await gate.ask(.save(address: URL(string: "https://new.example")!, switches: true)) }
        while !presenter.isShowing { await Task.yield() }

        gate.cancelPending()
        let outcome = await waiting.value
        XCTAssertEqual(outcome, .declined)
        XCTAssertEqual(presenter.withdrawals, 1)
        gate.cancelPending()
        XCTAssertEqual(presenter.withdrawals, 1)
    }

    func testThePromptNamesTheAddressAndMarksOnlyForgetAsDestructive() {
        var named = second
        named.nickname = "Studio"
        let forget = BridgeConsentRequest.forget(named)
        XCTAssertTrue(forget.message.contains("Studio (https://studio.example)"))
        XCTAssertEqual(forget.confirmTitle, "Forget")
        XCTAssertTrue(forget.isDestructive)

        let save = BridgeConsentRequest.save(address: URL(string: "https://new.example")!, switches: false)
        XCTAssertTrue(save.message.contains("save https://new.example."))
        XCTAssertEqual(save.confirmTitle, "Save")
        XCTAssertFalse(save.isDestructive)

        let replace = BridgeConsentRequest.replaceToken(first, switches: true)
        XCTAssertTrue(replace.message.contains("https://desk.example, and open it"))
        XCTAssertFalse(replace.isDestructive)
        XCTAssertFalse(BridgeConsentRequest.switchTo(second).isDestructive)
    }

    // MARK: The bridge

    func testADeclinedConnectSavesNothingAndContactsNoServer() async {
        let harness = makeHarness(.decline)
        await harness.coordinator.handleBridgeRequest(
            id: "connect-id",
            action: "connect",
            body: ["address": "NEW.example", "token": "gateway-token-new-123"]
        )
        XCTAssertEqual(
            harness.presenter.requests,
            [.save(address: URL(string: "https://new.example")!, switches: true)]
        )
        XCTAssertTrue(harness.validator.checks.isEmpty)
        XCTAssertTrue(harness.store.savedVaults.isEmpty)
        XCTAssertEqual(harness.model.vault.connections, [first, second])
        XCTAssertFalse(harness.coordinator.isSwitchingThroughBridge)
        XCTAssertEqual(harness.scripts().last, refusal("connect-id", .declined))
    }

    func testConnectToASavedAddressAsksToReplaceItsToken() async {
        let harness = makeHarness(.approve)
        await harness.coordinator.handleBridgeRequest(
            id: "connect-id",
            action: "connect",
            body: ["address": "https://studio.example", "token": "gateway-token-new-123", "select": false]
        )
        XCTAssertEqual(harness.presenter.requests, [.replaceToken(second, switches: false)])
        XCTAssertEqual(
            harness.model.vault.connections.first { $0.id == second.id }?.token,
            "gateway-token-new-123"
        )
        XCTAssertEqual(harness.model.activeConnection?.id, first.id)
        XCTAssertTrue(try XCTUnwrap(harness.scripts().last).contains(#""connect-id", true"#))
    }

    func testAMalformedConnectIsRefusedWithoutAsking() async {
        let harness = makeHarness(.approve)
        await harness.coordinator.handleBridgeRequest(
            id: "short-id",
            action: "connect",
            body: ["address": "https://new.example", "token": "short"]
        )
        await harness.coordinator.handleBridgeRequest(
            id: "http-id",
            action: "connect",
            body: ["address": "http://new.example", "token": "gateway-token-new-123"]
        )
        XCTAssertTrue(harness.presenter.requests.isEmpty)
        XCTAssertTrue(try XCTUnwrap(harness.scripts().first).contains(#""short-id", false"#))
        XCTAssertTrue(try XCTUnwrap(harness.scripts().last).contains(#""http-id", false"#))
    }

    func testADeclinedSwitchKeepsTheCurrentServer() async {
        let harness = makeHarness(.decline)
        await harness.coordinator.handleBridgeRequest(
            id: "use-id",
            action: "use",
            body: ["connectionId": second.id.uuidString]
        )
        XCTAssertEqual(harness.presenter.requests, [.switchTo(second)])
        XCTAssertEqual(harness.model.activeConnection?.id, first.id)
        XCTAssertEqual(harness.coordinator.requestedConnection?.id, first.id)
        XCTAssertTrue(harness.validator.checks.isEmpty)
        XCTAssertFalse(harness.coordinator.isSwitchingThroughBridge)
        XCTAssertEqual(harness.scripts().last, refusal("use-id", .declined))
    }

    func testUsingTheServerAlreadyOpenDoesNotAsk() async {
        let harness = makeHarness(.decline)
        await harness.coordinator.handleBridgeRequest(
            id: "use-id",
            action: "use",
            body: ["connectionId": first.id.uuidString]
        )
        XCTAssertTrue(harness.presenter.requests.isEmpty)
        XCTAssertTrue(try XCTUnwrap(harness.scripts().last).contains(#""use-id", true"#))
    }

    func testADeclinedForgetKeepsTheServerAndItsSession() async {
        let harness = makeHarness(.decline)
        await harness.coordinator.handleBridgeRequest(
            id: "forget-id",
            action: "forget",
            body: ["connectionId": second.id.uuidString]
        )
        XCTAssertEqual(harness.presenter.requests, [.forget(second)])
        XCTAssertEqual(harness.model.vault.connections, [first, second])
        XCTAssertTrue(harness.store.savedVaults.isEmpty)
        XCTAssertNil(harness.coordinator.sessionEndTask)
        XCTAssertEqual(harness.scripts().last, refusal("forget-id", .declined))
    }

    func testAnApprovedSwitchOpensTheChosenServer() async {
        let harness = makeHarness(.approve)
        await harness.coordinator.handleBridgeRequest(
            id: "use-id",
            action: "use",
            body: ["connectionId": second.id.uuidString]
        )
        XCTAssertEqual(harness.model.activeConnection?.id, second.id)
        XCTAssertEqual(harness.coordinator.requestedConnection?.id, second.id)
        XCTAssertFalse(harness.coordinator.isSwitchingThroughBridge)
    }

    func testReadingAndRenamingNeverAsk() async {
        let harness = makeHarness(.decline)
        await harness.coordinator.handleBridgeRequest(id: "list-id", action: "list", body: [:])
        await harness.coordinator.handleBridgeRequest(
            id: "probe-id",
            action: "probe",
            body: ["connectionId": second.id.uuidString]
        )
        await harness.coordinator.handleBridgeRequest(
            id: "rename-id",
            action: "rename",
            body: ["connectionId": second.id.uuidString, "nickname": "Studio"]
        )
        XCTAssertTrue(harness.presenter.requests.isEmpty)
        XCTAssertEqual(harness.scripts().filter { $0.contains(", true, ") }.count, 3)
    }

    func testANavigationWithdrawsTheQuestionAndRefusesTheRequest() async {
        let harness = makeHarness(.wait)
        let request = Task {
            await harness.coordinator.handleBridgeRequest(
                id: "forget-id",
                action: "forget",
                body: ["connectionId": second.id.uuidString]
            )
        }
        while !harness.presenter.isShowing { await Task.yield() }
        harness.coordinator.navigationDidCommit()
        await request.value

        XCTAssertEqual(harness.presenter.withdrawals, 1)
        XCTAssertEqual(harness.model.vault.connections, [first, second])
        XCTAssertEqual(harness.scripts().last, refusal("forget-id", .declined))
    }

    func testTeardownRefusesTheWaitingRequest() async {
        let harness = makeHarness(.wait)
        let request = Task {
            await harness.coordinator.handleBridgeRequest(
                id: "use-id",
                action: "use",
                body: ["connectionId": second.id.uuidString]
            )
        }
        while !harness.presenter.isShowing { await Task.yield() }
        harness.coordinator.teardown()
        await request.value

        XCTAssertEqual(harness.presenter.withdrawals, 1)
        XCTAssertEqual(harness.model.activeConnection?.id, first.id)
    }

    func testOnlyOneQuestionIsShownAtATime() async {
        let harness = makeHarness(.wait)
        let waiting = Task {
            await harness.coordinator.handleBridgeRequest(
                id: "forget-id",
                action: "forget",
                body: ["connectionId": second.id.uuidString]
            )
        }
        while !harness.presenter.isShowing { await Task.yield() }
        await harness.coordinator.handleBridgeRequest(
            id: "use-id",
            action: "use",
            body: ["connectionId": second.id.uuidString]
        )
        XCTAssertEqual(harness.scripts().last, refusal("use-id", .consentBusy))

        harness.presenter.answer(false)
        await waiting.value
        XCTAssertEqual(harness.presenter.requests, [.forget(second)])
    }

    // MARK: Native token entry

    func testThePageOpensTheNativeEditorWithoutSeeingAToken() async {
        let harness = makeHarness(.decline)
        await harness.coordinator.handleBridgeRequest(id: "editor-id", action: "open-editor", body: [:])
        XCTAssertTrue(harness.model.isShowingConnectionEditor)
        XCTAssertEqual(harness.model.draftAddress, "")
        XCTAssertEqual(harness.model.draftToken, "")
        XCTAssertTrue(harness.presenter.requests.isEmpty)
        XCTAssertEqual(
            harness.scripts().last,
            #"window.__orkestratorNativeConnectionReply("editor-id", true, true)"#
        )
    }

    func testOpeningTheEditorAgainKeepsWhatTheUserTyped() async {
        let harness = makeHarness(.decline)
        await harness.coordinator.handleBridgeRequest(id: "editor-1", action: "open-editor", body: [:])
        harness.model.draftAddress = "https://typed.example"
        harness.model.draftToken = "gateway-token-typed-1"
        await harness.coordinator.handleBridgeRequest(id: "editor-2", action: "open-editor", body: [:])
        XCTAssertEqual(harness.model.draftAddress, "https://typed.example")
        XCTAssertEqual(harness.model.draftToken, "gateway-token-typed-1")
    }

    func testTheBridgeScriptOffersTheNativeEditor() {
        let script = RemoteWebView.Coordinator.connectionBridgeScript
        XCTAssertTrue(script.contains(#"addInNativeEditor: () => call("open-editor")"#))
    }
}
