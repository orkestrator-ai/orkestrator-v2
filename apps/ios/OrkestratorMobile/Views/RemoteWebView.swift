import SwiftUI
import UIKit
import WebKit

struct RemoteWebView: UIViewRepresentable {
    @EnvironmentObject private var model: ConnectionModel
    let connection: RemoteConnection
    @Binding var state: WebViewState

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model, state: $state)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(context.coordinator, name: Coordinator.messageHandlerName)
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: Coordinator.connectionBridgeScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.04, green: 0.045, blue: 0.055, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.webView = webView
        context.coordinator.authenticate(connection)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.state = $state
        if case .retrying = state {
            context.coordinator.authenticate(connection)
            return
        }
        guard context.coordinator.authenticatedConnection != connection,
              !context.coordinator.isSwitchingThroughBridge else { return }
        context.coordinator.authenticate(connection)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.messageHandlerName)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        static let messageHandlerName = "orkestratorConnections"
        static let connectionBridgeScript = #"""
        (() => {
          const pending = new Map();
          const call = (action, payload = {}) => new Promise((resolve, reject) => {
            const id = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
            pending.set(id, { resolve, reject });
            window.webkit.messageHandlers.orkestratorConnections.postMessage({ id, action, ...payload });
          });
          const connections = {
            list: () => call("list"),
            connect: (input) => call("connect", input || {}),
            use: (connectionId) => call("use", { connectionId }),
            forget: (connectionId) => call("forget", { connectionId }),
          };
          window.__orkestratorNativeConnectionReply = (id, ok, value) => {
            const callback = pending.get(id);
            if (!callback) return;
            pending.delete(id);
            ok ? callback.resolve(value) : callback.reject(new Error(value));
          };
          let gateway;
          Object.defineProperty(window, "orkestrator", {
            configurable: true,
            get: () => gateway,
            set: (value) => {
              gateway = value;
              if (gateway) gateway.connections = connections;
            },
          });
        })();
        """#

        private let model: ConnectionModel
        var state: Binding<WebViewState>
        weak var webView: WKWebView?
        var authenticatedConnection: RemoteConnection?
        var isSwitchingThroughBridge = false
        private var requestedConnection: RemoteConnection?
        private var authenticationTask: Task<Void, Never>?

        init(model: ConnectionModel, state: Binding<WebViewState>) {
            self.model = model
            self.state = state
        }

        func authenticate(_ connection: RemoteConnection) {
            guard requestedConnection != connection || state.wrappedValue != .loading else { return }
            authenticationTask?.cancel()
            requestedConnection = connection
            authenticatedConnection = nil
            state.wrappedValue = .loading
            authenticationTask = Task { [weak self, weak webView] in
                guard let self, let webView else { return }
                do {
                    let cookie = try await self.loginCookie(for: connection)
                    try Task.checkCancellation()
                    guard self.requestedConnection == connection else { return }
                    await self.set(cookie: cookie, in: webView)
                    try Task.checkCancellation()
                    guard self.requestedConnection == connection else { return }

                    var request = URLRequest(
                        url: connection.address,
                        cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
                        timeoutInterval: 20
                    )
                    request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
                    webView.load(request)
                } catch is CancellationError {
                    return
                } catch {
                    guard self.requestedConnection == connection else { return }
                    self.state.wrappedValue = .failed(error.localizedDescription)
                }
            }
        }

        private func loginCookie(for connection: RemoteConnection) async throws -> HTTPCookie {
            let loginURL = connection.address.appending(path: "__orkestrator/login")
            var components = URLComponents()
            components.queryItems = [URLQueryItem(name: "token", value: connection.token)]

            var request = URLRequest(
                url: loginURL,
                cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
                timeoutInterval: 20
            )
            request.httpMethod = "POST"
            request.httpBody = components.percentEncodedQuery?.data(using: .utf8)
            request.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.setValue("no-store", forHTTPHeaderField: "Cache-Control")

            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.timeoutIntervalForRequest = 20
            let redirectBlocker = LoginRedirectBlocker()
            let session = URLSession(configuration: configuration, delegate: redirectBlocker, delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }

            let response: URLResponse
            do {
                (_, response) = try await session.data(for: request)
            } catch let error as URLError {
                switch error.code {
                case .timedOut:
                    throw NativeGatewayLoginError.timedOut
                case .serverCertificateUntrusted, .serverCertificateHasBadDate,
                     .serverCertificateHasUnknownRoot, .secureConnectionFailed:
                    throw NativeGatewayLoginError.untrustedConnection
                default:
                    throw NativeGatewayLoginError.unreachable
                }
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                throw NativeGatewayLoginError.invalidResponse
            }
            if httpResponse.statusCode == 401 { throw NativeGatewayLoginError.rejectedToken }
            if httpResponse.statusCode == 403 { throw NativeGatewayLoginError.originRejected }
            guard httpResponse.statusCode == 303 else {
                throw NativeGatewayLoginError.httpFailure(httpResponse.statusCode)
            }

            let headers = httpResponse.allHeaderFields.reduce(into: [String: String]()) { result, field in
                guard let name = field.key as? String else { return }
                result[name] = String(describing: field.value)
            }
            guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: loginURL)
                .first(where: { $0.name == "orkestrator_gateway_auth" }) else {
                throw NativeGatewayLoginError.missingCookie
            }
            return cookie
        }

        private func set(cookie: HTTPCookie, in webView: WKWebView) async {
            await withCheckedContinuation { continuation in
                webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                    continuation.resume()
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard let requestedConnection,
                  webView.url?.host == requestedConnection.address.host else { return }
            authenticatedConnection = requestedConnection
            state.wrappedValue = .ready
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            if let response = navigationResponse.response as? HTTPURLResponse,
               response.statusCode == 401,
               navigationResponse.isForMainFrame {
                state.wrappedValue = .failed("The saved gateway token was rejected.")
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if navigationAction.targetFrame == nil {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            if let requestedConnection,
               let scheme = url.scheme?.lowercased(),
               (scheme == "http" || scheme == "https"),
               !sameOrigin(url, requestedConnection.address) {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleNavigationError(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            handleNavigationError(error)
        }

        private func handleNavigationError(_ error: Error) {
            let nsError = error as NSError
            guard nsError.code != NSURLErrorCancelled else { return }
            state.wrappedValue = .failed("The remote app could not be loaded. Check Tailscale and try again.")
        }

        private func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
            func effectivePort(_ url: URL) -> Int? {
                if let port = url.port { return port }
                if url.scheme?.lowercased() == "https" { return 443 }
                if url.scheme?.lowercased() == "http" { return 80 }
                return nil
            }
            return lhs.scheme?.lowercased() == rhs.scheme?.lowercased()
                && lhs.host?.lowercased() == rhs.host?.lowercased()
                && effectivePort(lhs) == effectivePort(rhs)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url { UIApplication.shared.open(url) }
            return nil
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == Self.messageHandlerName,
                  let body = message.body as? [String: Any],
                  let requestID = body["id"] as? String,
                  let action = body["action"] as? String else { return }

            Task { @MainActor in
                do {
                    switch action {
                    case "list":
                        try await reply(id: requestID, result: model.connectionListPayload())
                    case "connect":
                        guard let address = body["address"] as? String,
                              let token = body["token"] as? String else {
                            throw ConnectionBridgeError.invalidInput
                        }
                        isSwitchingThroughBridge = true
                        let result = try await model.connect(address: address, token: token)
                        try await reply(id: requestID, result: result)
                        finishBridgeSwitch()
                    case "use":
                        guard let connectionID = body["connectionId"] as? String else {
                            throw ConnectionBridgeError.invalidInput
                        }
                        isSwitchingThroughBridge = true
                        let result = try model.use(connectionID: connectionID)
                        try await reply(id: requestID, result: result)
                        finishBridgeSwitch()
                    case "forget":
                        guard let connectionID = body["connectionId"] as? String else {
                            throw ConnectionBridgeError.invalidInput
                        }
                        let result = try model.forget(connectionID: connectionID)
                        try await reply(id: requestID, result: result)
                    default:
                        throw ConnectionBridgeError.unsupportedAction
                    }
                } catch {
                    isSwitchingThroughBridge = false
                    await reply(id: requestID, error: error.localizedDescription)
                }
            }
        }

        private func finishBridgeSwitch() {
            isSwitchingThroughBridge = false
            if let activeConnection = model.activeConnection {
                authenticate(activeConnection)
            }
        }

        private func reply<T: Encodable>(id: String, result: T) async throws {
            let value = try jsonLiteral(result)
            let idLiteral = try jsonLiteral(id)
            try await webView?.evaluateJavaScript(
                "window.__orkestratorNativeConnectionReply(\(idLiteral), true, \(value))"
            )
        }

        private func reply(id: String, error: String) async {
            guard let idLiteral = try? jsonLiteral(id),
                  let errorLiteral = try? jsonLiteral(error) else { return }
            _ = try? await webView?.evaluateJavaScript(
                "window.__orkestratorNativeConnectionReply(\(idLiteral), false, \(errorLiteral))"
            )
        }

        private func jsonLiteral<T: Encodable>(_ value: T) throws -> String {
            let data = try JSONEncoder().encode(value)
            guard let json = String(data: data, encoding: .utf8) else {
                throw ConnectionBridgeError.encodingFailed
            }
            return json
        }
    }
}

private final class LoginRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

enum NativeGatewayLoginError: LocalizedError {
    case timedOut
    case untrustedConnection
    case unreachable
    case rejectedToken
    case originRejected
    case invalidResponse
    case missingCookie
    case httpFailure(Int)

    var errorDescription: String? {
        switch self {
        case .timedOut: return "The remote machine did not respond within 20 seconds."
        case .untrustedConnection: return "The server’s HTTPS certificate could not be trusted."
        case .unreachable: return "The remote machine could not be reached. Check Tailscale and try again."
        case .rejectedToken: return "The saved gateway token was rejected."
        case .originRejected: return "The remote machine rejected the native login request."
        case .invalidResponse: return "The remote machine returned an invalid login response."
        case .missingCookie: return "The remote machine did not create a secure web session."
        case .httpFailure(let status): return "The secure login failed with HTTP \(status)."
        }
    }
}

enum ConnectionBridgeError: LocalizedError {
    case invalidInput
    case unsupportedAction
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .invalidInput: return "The connection details were incomplete."
        case .unsupportedAction: return "That connection action is not supported."
        case .encodingFailed: return "The saved connections could not be encoded."
        }
    }
}
