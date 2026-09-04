import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: ConnectionModel
    @State private var webState: WebViewState = .loading

    var body: some View {
        Group {
            switch rootDestination(
                requiresLaunchSelection: model.requiresLaunchSelection,
                activeConnection: model.activeConnection
            ) {
            case .launchSelection:
                LaunchConnectionPickerView()
            case .remote(let connection):
                ZStack {
                    RemoteWebView(connection: connection, state: $webState)
                        .environmentObject(model)
                        .ignoresSafeArea(.container, edges: .bottom)

                    switch webState {
                    case .loading, .retrying:
                        SecureLoadingView(host: connection.name)
                    case .failed(let message):
                        ConnectionFailureView(
                            message: message,
                            retry: { webState = .retrying(UUID()) },
                            edit: { model.showConnectionEditor(prefillActiveConnection: true, error: message) },
                            alternatives: model.vault.connections.filter { $0.id != connection.id },
                            switchConnection: switchConnection
                        )
                    case .ready:
                        EmptyView()
                    }
                }
            case .connectionEditor:
                ConnectionEditorView(canCancel: false)
            }
        }
        .sheet(isPresented: $model.isShowingConnectionEditor) {
            NavigationStack {
                ConnectionEditorView(canCancel: true)
                    .environmentObject(model)
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

enum RootDestination: Equatable {
    case launchSelection
    case remote(RemoteConnection)
    case connectionEditor
}

func rootDestination(
    requiresLaunchSelection: Bool,
    activeConnection: RemoteConnection?
) -> RootDestination {
    if requiresLaunchSelection { return .launchSelection }
    if let activeConnection { return .remote(activeConnection) }
    return .connectionEditor
}

private struct LaunchConnectionPickerView: View {
    @EnvironmentObject private var model: ConnectionModel
    @State private var selectedConnectionID: UUID?

    var body: some View {
        ZStack {
            Color(red: 0.043, green: 0.051, blue: 0.063)
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    HStack(spacing: 12) {
                        Image("BrandMark")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 42, height: 42)
                            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Orkestrator")
                                .font(.system(.headline, design: .rounded, weight: .bold))
                            Text("Secure remote")
                                .font(.caption)
                                .foregroundStyle(Color(red: 0.49, green: 0.89, blue: 0.72))
                        }
                    }

                    VStack(alignment: .leading, spacing: 9) {
                        Text("Where do you want to work?")
                            .font(.system(size: 31, weight: .bold, design: .rounded))
                            .tracking(-0.6)
                        Text("Choose a saved server for this session.")
                            .font(.system(.body, design: .rounded))
                            .foregroundStyle(Color(white: 0.68))
                    }

                    VStack(spacing: 12) {
                        ForEach(model.vault.connections) { connection in
                            connectionButton(connection)
                        }
                    }

                    if let error = model.connectionError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(Color(red: 1, green: 0.60, blue: 0.50))
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
                    }

                    Button {
                        model.showConnectionEditor()
                    } label: {
                        Label("Add another server", systemImage: "plus")
                            .font(.system(.body, design: .rounded, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .frame(height: 50)
                    }
                    .buttonStyle(.bordered)
                    .tint(.white)
                    .disabled(model.isConnecting)
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 22)
                .padding(.vertical, 34)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func connectionButton(_ connection: RemoteConnection) -> some View {
        Button {
            selectedConnectionID = connection.id
            Task {
                await model.selectConnectionForLaunch(connection)
                selectedConnectionID = nil
            }
        } label: {
            HStack(spacing: 16) {
                ZStack {
                    Circle()
                        .fill(Color(red: 0.49, green: 0.89, blue: 0.72).opacity(0.12))
                        .frame(width: 44, height: 44)
                    Image(systemName: "server.rack")
                        .foregroundStyle(Color(red: 0.49, green: 0.89, blue: 0.72))
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(connection.name)
                        .font(.system(.headline, design: .rounded, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(connection.address.absoluteString)
                        .font(.caption.monospaced())
                        .foregroundStyle(Color(white: 0.58))
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                if model.isConnecting, selectedConnectionID == connection.id {
                    ProgressView()
                        .tint(Color(red: 0.96, green: 0.55, blue: 0.27))
                } else {
                    Image(systemName: "arrow.up.right")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(Color(red: 0.96, green: 0.55, blue: 0.27))
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 78)
            .background(
                Color(red: 0.078, green: 0.090, blue: 0.106),
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(Color.white.opacity(0.09), lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.isConnecting)
        .accessibilityHint("Checks this server, then opens it")
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
