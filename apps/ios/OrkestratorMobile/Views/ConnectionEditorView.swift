import SwiftUI

struct ConnectionEditorView: View {
    @EnvironmentObject private var model: ConnectionModel
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focusedField: Field?

    let canCancel: Bool

    private enum Field { case address, token }

    var body: some View {
        ZStack {
            Color(red: 0.043, green: 0.051, blue: 0.063)
                .ignoresSafeArea()
            RouteBackdrop()
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    credentialCard
                    securityNote
                }
                .frame(maxWidth: 520)
                .padding(.horizontal, 22)
                .padding(.top, canCancel ? 22 : 48)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .interactiveDismissDisabled(model.isConnecting)
        .toolbar {
            if canCancel {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        model.dismissConnectionEditor()
                        dismiss()
                    }
                    .disabled(model.isConnecting)
                }
            }
        }
        .onAppear {
            if model.draftAddress.isEmpty { focusedField = .address }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 12) {
                Image("BrandMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 42, height: 42)
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text("ORKESTRATOR")
                        .font(.system(.caption, design: .rounded, weight: .bold))
                        .tracking(1.7)
                        .foregroundStyle(.white)
                    Text("Secure remote")
                        .font(.caption)
                        .foregroundStyle(Color(red: 0.49, green: 0.89, blue: 0.72))
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Your workstation,\nthrough one private route.")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .tracking(-0.8)
                    .foregroundStyle(.white)
                Text("Connect over tailnet HTTPS. After this check, iOS unlocks the saved credential for you.")
                    .font(.system(.body, design: .rounded))
                    .foregroundStyle(Color(white: 0.68))
                    .lineSpacing(3)
            }
        }
        .padding(.bottom, 28)
    }

    private var credentialCard: some View {
        VStack(alignment: .leading, spacing: 20) {
            routeIndicator

            VStack(alignment: .leading, spacing: 8) {
                Label("Remote machine", systemImage: "desktopcomputer")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(white: 0.75))
                TextField("https://workstation.tailnet.ts.net", text: $model.draftAddress)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .address)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .token }
                    .fieldStyle()
            }

            VStack(alignment: .leading, spacing: 8) {
                Label("Gateway token", systemImage: "key.horizontal.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(white: 0.75))
                SecureField("Token from gateway-auth.json", text: $model.draftToken)
                    .textInputAutocapitalization(.never)
                    .textContentType(.password)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .token)
                    .submitLabel(.go)
                    .onSubmit { connect() }
                    .fieldStyle()
            }

            if let error = model.connectionError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Color(red: 1, green: 0.60, blue: 0.50))
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Connection error: \(error)")
            }

            Button(action: connect) {
                HStack {
                    if model.isConnecting {
                        ProgressView().tint(.black)
                    } else {
                        Image(systemName: "arrow.up.right")
                    }
                    Text(model.isConnecting ? "Checking private route…" : "Connect securely")
                        .fontWeight(.bold)
                    Spacer()
                    if !model.isConnecting { Image(systemName: "arrow.right") }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 18)
                .frame(height: 54)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.black)
            .background(Color(red: 0.96, green: 0.55, blue: 0.27), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .disabled(model.isConnecting || model.draftAddress.isEmpty || model.draftToken.isEmpty)
            .opacity(model.isConnecting || model.draftAddress.isEmpty || model.draftToken.isEmpty ? 0.55 : 1)
        }
        .padding(20)
        .background(Color(red: 0.078, green: 0.090, blue: 0.106).opacity(0.97), in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(Color.white.opacity(0.09), lineWidth: 1)
        }
    }

    private var routeIndicator: some View {
        HStack(spacing: 12) {
            Label("This iPhone", systemImage: "iphone")
            Rectangle()
                .fill(Color(red: 0.49, green: 0.89, blue: 0.72).opacity(0.55))
                .frame(height: 1)
                .overlay(alignment: .trailing) {
                    Circle()
                        .fill(Color(red: 0.49, green: 0.89, blue: 0.72))
                        .frame(width: 6, height: 6)
                        .shadow(color: Color(red: 0.49, green: 0.89, blue: 0.72), radius: 5)
                }
            Label("Workstation", systemImage: "desktopcomputer")
        }
        .font(.system(.caption2, design: .monospaced, weight: .medium))
        .foregroundStyle(Color(white: 0.64))
    }

    private var securityNote: some View {
        Label {
            Text("The address and token are stored in Keychain, available only while this device is unlocked, and never included in device backups.")
        } icon: {
            Image(systemName: "lock.shield.fill")
                .foregroundStyle(Color(red: 0.49, green: 0.89, blue: 0.72))
        }
        .font(.footnote)
        .foregroundStyle(Color(white: 0.60))
        .padding(.horizontal, 6)
        .padding(.top, 18)
    }

    private func connect() {
        guard !model.isConnecting, !model.draftAddress.isEmpty, !model.draftToken.isEmpty else { return }
        focusedField = nil
        Task { await model.connectDraft() }
    }
}

private struct RouteBackdrop: View {
    var body: some View {
        GeometryReader { proxy in
            Path { path in
                path.move(to: CGPoint(x: proxy.size.width * 0.62, y: -20))
                path.addCurve(
                    to: CGPoint(x: proxy.size.width + 40, y: proxy.size.height * 0.42),
                    control1: CGPoint(x: proxy.size.width * 0.92, y: proxy.size.height * 0.08),
                    control2: CGPoint(x: proxy.size.width * 0.72, y: proxy.size.height * 0.31)
                )
            }
            .stroke(
                LinearGradient(
                    colors: [Color.orange.opacity(0), Color.orange.opacity(0.28), Color.orange.opacity(0)],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                style: StrokeStyle(lineWidth: 1, dash: [5, 9])
            )
        }
        .accessibilityHidden(true)
    }
}

private extension View {
    func fieldStyle() -> some View {
        self
            .font(.system(.body, design: .monospaced))
            .padding(.horizontal, 14)
            .frame(height: 50)
            .background(Color.black.opacity(0.34), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.white.opacity(0.10), lineWidth: 1)
            }
    }
}
