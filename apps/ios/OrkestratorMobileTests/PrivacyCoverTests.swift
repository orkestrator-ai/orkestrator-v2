import Security
import SwiftUI
import UIKit
import XCTest
@testable import OrkestratorMobile

/// Stands in for the scene, which a unit test cannot move through its real phases.
@MainActor
private final class ScenePhaseBox: ObservableObject {
    @Published var phase: ScenePhase

    init(_ phase: ScenePhase) {
        self.phase = phase
    }
}

private struct PhasedRoot: View {
    @ObservedObject var box: ScenePhaseBox
    let model: ConnectionModel

    var body: some View {
        RootView()
            .environmentObject(model)
            .environment(\.scenePhase, box.phase)
            .preferredColorScheme(.dark)
    }
}

@MainActor
final class PrivacyCoverTests: XCTestCase {
    private var windows: [UIWindow] = []

    override func tearDown() async throws {
        windows.forEach { $0.isHidden = true }
        windows = []
    }

    private func show(_ root: some View) throws -> UIWindow {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = UIHostingController(rootView: root)
        window.isHidden = false
        windows.append(window)
        return window
    }

    /// Allows for the sheet's presentation, which animates.
    private func settledImage(of window: UIWindow) async throws -> Data {
        try await Task.sleep(for: .milliseconds(900))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        return try XCTUnwrap(image.pngData())
    }

    private func makeModel(servers addresses: [String]) -> ConnectionModel {
        let connections = addresses.map { connection(address: $0) }
        return ConnectionModel(
            credentialStore: MemoryCredentialStore(
                vault: ConnectionVault(activeConnectionID: connections.first?.id, connections: connections)
            ),
            validator: MockValidator()
        )
    }

    func testTheCoverHidesEveryPhaseButActiveAndTheAppShowsNormallyOnReturn() async throws {
        let box = ScenePhaseBox(.active)
        let window = try show(PhasedRoot(box: box, model: makeModel(servers: ["https://secret-one.example"])))
        let shown = try await settledImage(of: window)

        box.phase = .inactive
        let inactive = try await settledImage(of: window)
        XCTAssertNotEqual(inactive, shown)

        box.phase = .background
        let background = try await settledImage(of: window)
        XCTAssertEqual(background, inactive)

        box.phase = .active
        let returned = try await settledImage(of: window)
        XCTAssertEqual(returned, shown)
    }

    func testNothingOfTheScreenShowsThroughTheCover() async throws {
        let one = try show(PhasedRoot(box: ScenePhaseBox(.active), model: makeModel(servers: ["https://secret-one.example"])))
        let two = try show(PhasedRoot(box: ScenePhaseBox(.active), model: makeModel(servers: ["https://secret-two.example"])))
        let shownOne = try await settledImage(of: one)
        let shownTwo = try await settledImage(of: two)
        XCTAssertNotEqual(shownOne, shownTwo)

        let coveredOne = try show(PhasedRoot(box: ScenePhaseBox(.inactive), model: makeModel(servers: ["https://secret-one.example"])))
        let coveredTwo = try show(PhasedRoot(box: ScenePhaseBox(.inactive), model: makeModel(servers: ["https://secret-two.example"])))
        let imageOne = try await settledImage(of: coveredOne)
        let imageTwo = try await settledImage(of: coveredTwo)
        XCTAssertEqual(imageOne, imageTwo)
    }

    func testTheCoverReachesAPresentedSheet() async throws {
        func editor(address: String, phase: ScenePhase) throws -> UIWindow {
            let model = makeModel(servers: ["https://saved.example"])
            model.draftAddress = address
            model.isShowingConnectionEditor = true
            return try show(PhasedRoot(box: ScenePhaseBox(phase), model: model))
        }

        let shownOne = try await settledImage(of: try editor(address: "https://secret-one.example", phase: .active))
        let shownTwo = try await settledImage(of: try editor(address: "https://secret-two.example", phase: .active))
        XCTAssertNotEqual(shownOne, shownTwo, "The sheet should be on screen and show the draft")

        let coveredOne = try await settledImage(of: try editor(address: "https://secret-one.example", phase: .inactive))
        let coveredTwo = try await settledImage(of: try editor(address: "https://secret-two.example", phase: .inactive))
        XCTAssertEqual(coveredOne, coveredTwo)
    }

    func testReturningToTheForegroundRereadsAVaultThatCouldNotBeRead() async throws {
        let saved = connection(address: "https://saved.example")
        let store = MemoryCredentialStore(
            vault: ConnectionVault(activeConnectionID: saved.id, connections: [saved])
        )
        store.loadError = KeychainError(status: errSecInteractionNotAllowed)
        let model = ConnectionModel(credentialStore: store, validator: MockValidator())
        let box = ScenePhaseBox(.background)
        _ = try show(PhasedRoot(box: box, model: model))
        try await Task.sleep(for: .milliseconds(100))

        // Going inactive is not a return, and the read would still fail anyway.
        store.loadError = nil
        box.phase = .inactive
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.vault, .empty)

        box.phase = .active
        for _ in 0..<100 where model.vault == .empty {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(model.vault.connections.map(\.id), [saved.id])
        XCTAssertTrue(model.requiresLaunchSelection)
    }
}
