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
        for script in Coordinator.userScripts(for: UIDevice.current.userInterfaceIdiom) {
            configuration.userContentController.addUserScript(script)
        }

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
        context.coordinator.synchronizeAuthentication(with: connection)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.teardown()
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.messageHandlerName)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        static let messageHandlerName = "orkestratorConnections"

        static func clientPlatform(for idiom: UIUserInterfaceIdiom) -> String {
            switch idiom {
            case .pad:
                return "ipad-wkwebview"
            case .phone:
                return "iphone-wkwebview"
            default:
                return "ios-wkwebview"
            }
        }

        static func quotedJavaScriptString(_ value: String) -> String {
            guard let data = try? JSONEncoder().encode(value),
                  let json = String(data: data, encoding: .utf8) else {
                return "\"\""
            }
            return json
        }

        static func userScripts(for idiom: UIUserInterfaceIdiom) -> [WKUserScript] {
            [
                WKUserScript(
                    source: "window.__orkestratorClientPlatform = \(quotedJavaScriptString(clientPlatform(for: idiom)));",
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                ),
                WKUserScript(
                    source: connectionBridgeScript,
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                ),
            ]
        }
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
        private(set) var requestedConnection: RemoteConnection?
        var authenticationTask: Task<Void, Never>?
        var javaScriptEvaluator: ((String) async throws -> Any?)?
        var authenticationStarter: ((RemoteConnection) -> Void)?
        /// Injected only by tests so the login exchange can be stubbed without
        /// reaching the network. Nil in production.
        var loginProtocolClasses: [AnyClass]?

        init(model: ConnectionModel, state: Binding<WebViewState>) {
            self.model = model
            self.state = state
        }

        /// The body of `updateUIView`, kept on the coordinator because a
        /// `UIViewRepresentableContext` cannot be constructed outside SwiftUI.
        /// `state` has already been rebound by the caller.
        func synchronizeAuthentication(with connection: RemoteConnection) {
            if case .retrying = state.wrappedValue {
                authenticate(connection)
                return
            }
            guard authenticatedConnection != connection,
                  !isSwitchingThroughBridge else { return }
            authenticate(connection)
        }

        func authenticate(_ connection: RemoteConnection) {
            guard requestedConnection != connection || state.wrappedValue != .loading else { return }
            authenticationTask?.cancel()
            beginAuthenticationState(for: connection)
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

        func beginAuthenticationState(for connection: RemoteConnection) {
            requestedConnection = connection
            authenticatedConnection = nil
            state.wrappedValue = .loading
        }

        func teardown() {
            authenticationTask?.cancel()
            authenticationTask = nil
            requestedConnection = nil
            authenticatedConnection = nil
            isSwitchingThroughBridge = false
            javaScriptEvaluator = nil
            authenticationStarter = nil
            webView = nil
        }

        func loginCookie(for connection: RemoteConnection) async throws -> HTTPCookie {
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
            if let loginProtocolClasses { configuration.protocolClasses = loginProtocolClasses }
            let redirectBlocker = LoginRedirectBlocker()
            let session = URLSession(configuration: configuration, delegate: redirectBlocker, delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }

            let response: URLResponse
            do {
                (_, response) = try await session.data(for: request)
            } catch let error as URLError {
                throw Self.loginTransportError(for: error, taskIsCancelled: Task.isCancelled)
            }

            return try Self.loginCookie(from: response, loginURL: loginURL)
        }

        static func loginTransportError(for error: URLError, taskIsCancelled: Bool) -> Error {
            switch error.code {
            case .cancelled where taskIsCancelled:
                return CancellationError()
            case .timedOut:
                return NativeGatewayLoginError.timedOut
            case .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateHasUnknownRoot, .secureConnectionFailed:
                return NativeGatewayLoginError.untrustedConnection
            default:
                return NativeGatewayLoginError.unreachable
            }
        }

        static func loginCookie(from response: URLResponse, loginURL: URL) throws -> HTTPCookie {
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
            navigationDidFinish(at: webView.url)
        }

        func navigationDidFinish(at url: URL?) {
            guard let requestedConnection, let url,
                  Self.sameOrigin(url, requestedConnection.address) else { return }
            authenticatedConnection = requestedConnection
            state.wrappedValue = .ready
        }

        enum NavigationResponseDisposition: Equatable {
            case allow
            case rejectToken
        }

        static func navigationResponseDisposition(
            statusCode: Int?,
            isMainFrame: Bool
        ) -> NavigationResponseDisposition {
            statusCode == 401 && isMainFrame ? .rejectToken : .allow
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            let statusCode = (navigationResponse.response as? HTTPURLResponse)?.statusCode
            decisionHandler(navigationResponsePolicy(
                statusCode: statusCode,
                isMainFrame: navigationResponse.isForMainFrame
            ))
        }

        func navigationResponsePolicy(
            statusCode: Int?,
            isMainFrame: Bool
        ) -> WKNavigationResponsePolicy {
            if Self.navigationResponseDisposition(
                statusCode: statusCode,
                isMainFrame: isMainFrame
            ) == .rejectToken {
                state.wrappedValue = .failed("The saved gateway token was rejected.")
                return .cancel
            }
            return .allow
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
            switch Self.navigationDisposition(
                for: url,
                targetFrameExists: navigationAction.targetFrame != nil,
                targetFrameIsMain: navigationAction.targetFrame?.isMainFrame == true,
                connection: requestedConnection
            ) {
            case .allow:
                decisionHandler(.allow)
            case .openExternally:
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            case .cancel:
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleNavigationError(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            handleNavigationError(error)
        }

        func handleNavigationError(_ error: Error) {
            guard let message = Self.navigationFailureMessage(for: error) else { return }
            state.wrappedValue = .failed(message)
        }

        static func navigationFailureMessage(for error: Error) -> String? {
            let nsError = error as NSError
            guard nsError.domain != NSURLErrorDomain || nsError.code != NSURLErrorCancelled else {
                return nil
            }
            return "The remote app could not be loaded. Check Tailscale and try again."
        }

        static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
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

        enum NavigationDisposition: Equatable {
            case allow
            case openExternally
            case cancel
        }

        static func navigationDisposition(
            for url: URL,
            targetFrameExists: Bool,
            targetFrameIsMain: Bool,
            connection: RemoteConnection?
        ) -> NavigationDisposition {
            guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
                return .cancel
            }
            guard targetFrameExists else { return .openExternally }
            guard targetFrameIsMain else { return .allow }
            guard let connection else { return .cancel }
            return sameOrigin(url, connection.address) ? .allow : .openExternally
        }

        static func isTrustedBridgeOrigin(
            isMainFrame: Bool,
            scheme: String,
            host: String,
            port: Int,
            connection: RemoteConnection?
        ) -> Bool {
            guard isMainFrame, let connection else { return false }
            var components = URLComponents()
            components.scheme = scheme
            components.host = host
            components.port = port > 0 ? port : nil
            guard let source = components.url else { return false }
            return sameOrigin(source, connection.address)
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url,
               Self.navigationDisposition(
                for: url,
                targetFrameExists: false,
                targetFrameIsMain: false,
                connection: requestedConnection
               ) == .openExternally {
                UIApplication.shared.open(url)
            }
            return nil
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == Self.messageHandlerName,
                  Self.isTrustedBridgeOrigin(
                    isMainFrame: message.frameInfo.isMainFrame,
                    scheme: message.frameInfo.securityOrigin.protocol,
                    host: message.frameInfo.securityOrigin.host,
                    port: message.frameInfo.securityOrigin.port,
                    connection: requestedConnection
                  ),
                  let body = message.body as? [String: Any],
                  let requestID = body["id"] as? String,
                  let action = body["action"] as? String else { return }

            Task { @MainActor in
                await handleBridgeRequest(id: requestID, action: action, body: body)
            }
        }

        func handleBridgeRequest(id requestID: String, action: String, body: [String: Any]) async {
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
                    defer { finishBridgeSwitch() }
                    try await reply(id: requestID, result: result)
                case "use":
                    guard let connectionID = body["connectionId"] as? String else {
                        throw ConnectionBridgeError.invalidInput
                    }
                    isSwitchingThroughBridge = true
                    let result = try await model.use(connectionID: connectionID)
                    defer { finishBridgeSwitch() }
                    try await reply(id: requestID, result: result)
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

        private func finishBridgeSwitch() {
            isSwitchingThroughBridge = false
            if let activeConnection = model.activeConnection {
                if let authenticationStarter {
                    authenticationStarter(activeConnection)
                } else {
                    authenticate(activeConnection)
                }
            }
        }

        private func reply<T: Encodable>(id: String, result: T) async throws {
            let value = try jsonLiteral(result)
            let idLiteral = try jsonLiteral(id)
            _ = try await evaluateJavaScript(
                "window.__orkestratorNativeConnectionReply(\(idLiteral), true, \(value))"
            )
        }

        private func reply(id: String, error: String) async {
            guard let idLiteral = try? jsonLiteral(id),
                  let errorLiteral = try? jsonLiteral(error) else { return }
            _ = try? await evaluateJavaScript(
                "window.__orkestratorNativeConnectionReply(\(idLiteral), false, \(errorLiteral))"
            )
        }

        private func evaluateJavaScript(_ script: String) async throws -> Any? {
            if let javaScriptEvaluator {
                return try await javaScriptEvaluator(script)
            }
            return try await webView?.evaluateJavaScript(script)
        }

        func jsonLiteral<T: Encodable>(_ value: T) throws -> String {
            let data: Data
            do {
                data = try JSONEncoder().encode(value)
            } catch {
                throw ConnectionBridgeError.encodingFailed
            }
            guard let json = String(data: data, encoding: .utf8) else {
                throw ConnectionBridgeError.encodingFailed
            }
            return json
        }
    }
}

final class LoginRedirectBlocker: NSObject, URLSessionTaskDelegate {
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
