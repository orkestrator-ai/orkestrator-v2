import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: ConnectionModel
    @State private var webState: WebViewState = .loading

    var body: some View {
        Group {
            if let connection = model.activeConnection {
                ZStack {
                    RemoteWebView(connection: connection, state: $webState)
                        .environmentObject(model)
                        .ignoresSafeArea(.container, edges: .bottom)

                    switch webState {
                    case .loading:
                        SecureLoadingView(host: connection.name)
                    case .failed(let message):
                        ConnectionFailureView(
                            message: message,
                            retry: { webState = .retrying(UUID()) },
                            edit: { model.showConnectionEditor(prefillActiveConnection: true, error: message) },
                            alternatives: model.vault.connections.filter { $0.id != connection.id },
                            switchConnection: switchConnection
                        )
                    case .ready, .retrying:
                        EmptyView()
                    }
                }
                .sheet(isPresented: $model.isShowingConnectionEditor) {
                    NavigationStack {
                        ConnectionEditorView(canCancel: true)
                            .environmentObject(model)
                    }
                }
            } else {
                ConnectionEditorView(canCancel: false)
            }
        }
        .onChange(of: model.activeConnection?.id) { _, _ in
            webState = .loading
        }
    }

    private func switchConnection(_ connection: RemoteConnection) {
        webState = .loading
        Task {
            do {
                try await model.use(connectionID: connection.id.uuidString)
                webState = .loading
            } catch {
                webState = .failed(error.localizedDescription)
            }
        }
    }
}

enum WebViewState: Equatable {
    case loading
    case retrying(UUID)
    case ready
    case failed(String)
}

private struct SecureLoadingView: View {
    let host: String

    var body: some View {
        VStack(spacing: 14) {
            ProgressView()
                .controlSize(.large)
                .tint(.white)
            Text("Opening \(host)")
                .font(.headline)
            Label("Signing in from iOS Keychain", systemImage: "lock.shield.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(28)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

private struct ConnectionFailureView: View {
    let message: String
    let retry: () -> Void
    let edit: () -> Void
    let alternatives: [RemoteConnection]
    let switchConnection: (RemoteConnection) -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "antenna.radiowaves.left.and.right.slash")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(Color.accentColor)
            VStack(spacing: 7) {
                Text("Remote machine unavailable")
                    .font(.title3.weight(.semibold))
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            HStack {
                Button("Edit connection", action: edit)
                    .buttonStyle(.bordered)
                Button("Try again", action: retry)
                    .buttonStyle(.borderedProminent)
            }
            if !alternatives.isEmpty {
                Menu {
                    ForEach(alternatives) { connection in
                        Button(connection.name) { switchConnection(connection) }
                    }
                } label: {
                    Label("Switch saved server", systemImage: "server.rack")
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: 360)
        .padding(28)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(24)
    }
}
