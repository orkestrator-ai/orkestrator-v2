import SwiftUI
import WebKit
import XCTest
@testable import OrkestratorMobile

/// Safari's Web Inspector follows the page's renderer debug logging (to-do 6300 (retired) task 3).
@MainActor
final class WebInspectorTests: XCTestCase {
    private func makeCoordinator() -> (RemoteWebView.Coordinator, WKWebView, () -> [String]) {
        let coordinator = RemoteWebView.Coordinator(
            model: ConnectionModel(credentialStore: MemoryCredentialStore(), validator: MockValidator()),
            state: Binding(get: { .loading }, set: { _ in })
        )
        let webView = WKWebView(frame: .zero)
        coordinator.webView = webView
        var scripts: [String] = []
        coordinator.javaScriptEvaluator = {
            scripts.append($0)
            return nil
        }
        return (coordinator, webView, { scripts })
    }

    func testThePageTurnsInspectionOnAndOffThroughTheBridge() async throws {
        let (coordinator, webView, scripts) = makeCoordinator()
        XCTAssertFalse(webView.isInspectable)

        await coordinator.handleBridgeRequest(id: "on-id", action: "set-inspectable", body: ["enabled": true])
        XCTAssertTrue(webView.isInspectable)
        XCTAssertEqual(
            try XCTUnwrap(scripts().last),
            #"window.__orkestratorNativeConnectionReply("on-id", true, true)"#
        )

        await coordinator.handleBridgeRequest(id: "off-id", action: "set-inspectable", body: ["enabled": false])
        XCTAssertFalse(webView.isInspectable)
        XCTAssertTrue(try XCTUnwrap(scripts().last).contains(#""off-id", true, false"#))
    }

    func testAMalformedRequestIsRefusedAndChangesNothing() async throws {
        let (coordinator, webView, scripts) = makeCoordinator()
        for value: Any in ["yes", 1 as Int, NSNull()] {
            await coordinator.handleBridgeRequest(id: "bad-id", action: "set-inspectable", body: ["enabled": value])
            XCTAssertTrue(try XCTUnwrap(scripts().last).contains(#""bad-id", false"#))
        }
        await coordinator.handleBridgeRequest(id: "missing-id", action: "set-inspectable", body: [:])
        XCTAssertTrue(try XCTUnwrap(scripts().last).contains(#""missing-id", false"#))
        XCTAssertFalse(webView.isInspectable)
    }

    func testEveryNewDocumentStartsUninspectable() async {
        let (coordinator, webView, _) = makeCoordinator()
        await coordinator.handleBridgeRequest(id: "on-id", action: "set-inspectable", body: ["enabled": true])
        XCTAssertTrue(webView.isInspectable)
        coordinator.navigationDidCommit()
        XCTAssertFalse(webView.isInspectable)
    }

    func testTheBridgeScriptExposesOnlyABooleanSwitch() {
        let script = RemoteWebView.Coordinator.connectionBridgeScript
        XCTAssertTrue(script.contains("window.orkestratorNativeShell = Object.freeze({"))
        XCTAssertTrue(script.contains(#"call("set-inspectable", { enabled: enabled === true })"#))
    }
}
