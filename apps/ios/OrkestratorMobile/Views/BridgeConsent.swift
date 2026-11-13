import UIKit

/// A change to the saved servers that a page asked for through the connection
/// bridge. Everything shown is native data: a saved server's name and address,
/// or the address `connect` would save after normalisation. Nothing the page
/// wrote is shown except that address, which is exactly what would be saved.
enum BridgeConsentRequest: Equatable {
    /// `connect` for an address that is not saved yet.
    case save(address: URL, switches: Bool)
    /// `connect` for an address that is already saved: its token is replaced.
    case replaceToken(RemoteConnection, switches: Bool)
    /// `use` of a saved server.
    case switchTo(RemoteConnection)
    /// `forget` of a saved server.
    case forget(RemoteConnection)

    var title: String {
        switch self {
        case .save(_, let switches): return switches ? "Add and open a server?" : "Save a server?"
        case .replaceToken: return "Replace a saved token?"
        case .switchTo: return "Switch server?"
        case .forget: return "Forget server?"
        }
    }

    var message: String {
        let source = "The page you are viewing asks to"
        let check = "Allow this only if you just asked for it in Orkestrator."
        switch self {
        case .save(let address, let switches):
            let action = switches ? "save and open" : "save"
            return "\(source) \(action) \(address.absoluteString). \(check)"
        case .replaceToken(let connection, let switches):
            let then = switches ? ", and open it" : ""
            return "\(source) replace the token saved for \(Self.describe(connection))\(then). \(check)"
        case .switchTo(let connection):
            return "\(source) open \(Self.describe(connection)). \(check)"
        case .forget(let connection):
            return "\(source) remove \(Self.describe(connection)) and its token from this device. \(check)"
        }
    }

    var confirmTitle: String {
        switch self {
        case .save(_, let switches): return switches ? "Add and Open" : "Save"
        case .replaceToken: return "Replace"
        case .switchTo: return "Switch"
        case .forget: return "Forget"
        }
    }

    var isDestructive: Bool {
        switch self {
        case .forget: return true
        case .save, .replaceToken, .switchTo: return false
        }
    }

    /// The address is always shown: a page can rename a server without asking,
    /// so a nickname alone could name the wrong machine.
    private static func describe(_ connection: RemoteConnection) -> String {
        guard let nickname = connection.nickname else { return connection.address.absoluteString }
        return "\(nickname) (\(connection.address.absoluteString))"
    }
}

enum BridgeConsentOutcome: Equatable {
    case approved
    case declined
    case timedOut
    /// Another request was already waiting for an answer.
    case busy
}

@MainActor
protocol BridgeConsentPresenting: AnyObject {
    /// Shows `request` and calls `answer` at most once with the user's choice.
    /// Returns a closure that withdraws what was shown, or `nil` when nothing
    /// could be shown, which refuses the request.
    func present(
        _ request: BridgeConsentRequest,
        answer: @escaping @MainActor (Bool) -> Void
    ) -> (() -> Void)?
}

/// Asks the user, natively, before a page changes the saved servers. One
/// request at a time; a second one is refused rather than queued, so a page
/// cannot stack prompts. Timeout, teardown and a prompt that could not be
/// shown all refuse: an unanswered approval never approves.
@MainActor
final class BridgeConsentGate {
    private final class Pending {
        var continuation: CheckedContinuation<BridgeConsentOutcome, Never>?
        var withdraw: (() -> Void)?
        var timeoutTask: Task<Void, Never>?
    }

    var presenter: any BridgeConsentPresenting
    var timeout: Duration
    private var pending: Pending?

    init(presenter: any BridgeConsentPresenting, timeout: Duration = .seconds(60)) {
        self.presenter = presenter
        self.timeout = timeout
    }

    var isAsking: Bool { pending != nil }

    func ask(_ request: BridgeConsentRequest) async -> BridgeConsentOutcome {
        guard pending == nil else { return .busy }
        let entry = Pending()
        pending = entry
        return await withCheckedContinuation { continuation in
            entry.continuation = continuation
            let withdraw = presenter.present(request) { [weak self, weak entry] approved in
                guard let self, let entry else { return }
                self.settle(entry, approved ? .approved : .declined, withdrawPrompt: false)
            }
            // A presenter may answer before it returns.
            guard entry.continuation != nil else { return }
            guard let withdraw else {
                settle(entry, .declined, withdrawPrompt: false)
                return
            }
            entry.withdraw = withdraw
            let timeout = self.timeout
            entry.timeoutTask = Task { @MainActor [weak self, weak entry] in
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled, let self, let entry else { return }
                self.settle(entry, .timedOut, withdrawPrompt: true)
            }
        }
    }

    /// Refuses the waiting request and withdraws its prompt.
    func cancelPending() {
        guard let pending else { return }
        settle(pending, .declined, withdrawPrompt: true)
    }

    private func settle(_ entry: Pending, _ outcome: BridgeConsentOutcome, withdrawPrompt: Bool) {
        guard let continuation = entry.continuation else { return }
        entry.continuation = nil
        entry.timeoutTask?.cancel()
        entry.timeoutTask = nil
        let withdraw = entry.withdraw
        entry.withdraw = nil
        if pending === entry { pending = nil }
        if withdrawPrompt { withdraw?() }
        continuation.resume(returning: outcome)
    }
}

/// Presents a request as a `UIAlertController` above whatever the app shows.
/// The page cannot draw over it or answer it.
@MainActor
final class AlertBridgeConsentPresenter: BridgeConsentPresenting {
    private let anchor: () -> UIView?

    init(anchor: @escaping () -> UIView?) {
        self.anchor = anchor
    }

    func present(
        _ request: BridgeConsentRequest,
        answer: @escaping @MainActor (Bool) -> Void
    ) -> (() -> Void)? {
        guard var presenter = anchor()?.window?.rootViewController else { return nil }
        while let presented = presenter.presentedViewController, !presented.isBeingDismissed {
            presenter = presented
        }
        let alert = UIAlertController(title: request.title, message: request.message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in answer(false) })
        alert.addAction(UIAlertAction(
            title: request.confirmTitle,
            style: request.isDestructive ? .destructive : .default
        ) { _ in answer(true) })
        presenter.present(alert, animated: true)
        return { [weak alert] in
            // Dismissing in code runs no action, so `answer` is not called.
            guard let alert, alert.presentingViewController != nil else { return }
            alert.dismiss(animated: true)
        }
    }
}
