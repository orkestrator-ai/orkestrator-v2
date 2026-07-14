import SwiftUI

@main
struct OrkestratorMobileApp: App {
    @StateObject private var connectionModel = ConnectionModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(connectionModel)
                .preferredColorScheme(.dark)
        }
    }
}
