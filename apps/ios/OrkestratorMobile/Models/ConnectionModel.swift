import Foundation

@MainActor
final class ConnectionModel: ObservableObject {
    @Published private(set) var vault: ConnectionVault
    @Published var isShowingConnectionEditor = false
    @Published var draftAddress = ""
    @Published var draftToken = ""
    @Published var isConnecting = false
    @Published var connectionError: String?

    private let credentialStore: KeychainCredentialStore
    private let validator: GatewayConnectionValidator

    init(
        credentialStore: KeychainCredentialStore = KeychainCredentialStore(),
        validator: GatewayConnectionValidator = GatewayConnectionValidator()
    ) {
        self.credentialStore = credentialStore
        self.validator = validator
        do {
            vault = try credentialStore.load()
        } catch {
            vault = .empty
            connectionError = error.localizedDescription
        }
    }

    var activeConnection: RemoteConnection? { vault.activeConnection }

    func showConnectionEditor(prefillActiveConnection: Bool = false, error: String? = nil) {
        if prefillActiveConnection, let activeConnection {
            draftAddress = activeConnection.address.absoluteString
            draftToken = activeConnection.token
        } else {
            draftAddress = ""
            draftToken = ""
        }
        connectionError = error
        isShowingConnectionEditor = true
    }

    func dismissConnectionEditor() {
        guard !isConnecting else { return }
        isShowingConnectionEditor = false
        connectionError = nil
    }

    func connectDraft() async {
        isConnecting = true
        connectionError = nil
        defer { isConnecting = false }
        do {
            _ = try await connect(address: draftAddress, token: draftToken)
            draftToken = ""
            isShowingConnectionEditor = false
        } catch {
            connectionError = error.localizedDescription
        }
    }

    @discardableResult
    func connect(address addressValue: String, token tokenValue: String) async throws -> ConnectionListPayload {
        let address = try validator.normalizedAddress(addressValue)
        let token = try validator.normalizedToken(tokenValue)
        try await validator.check(address: address, token: token)

        var nextVault = vault
        if let index = nextVault.connections.firstIndex(where: { $0.address == address }) {
            nextVault.connections[index].token = token
            nextVault.connections[index].lastConnectedAt = Date()
            nextVault.activeConnectionID = nextVault.connections[index].id
        } else {
            let connection = RemoteConnection(
                id: UUID(),
                address: address,
                token: token,
                lastConnectedAt: Date()
            )
            nextVault.connections.insert(connection, at: 0)
            nextVault.activeConnectionID = connection.id
        }
        nextVault.connections.sort { $0.lastConnectedAt > $1.lastConnectedAt }
        try credentialStore.save(nextVault)
        vault = nextVault
        return connectionListPayload()
    }

    @discardableResult
    func use(connectionID: String) throws -> ConnectionListPayload {
        guard let id = UUID(uuidString: connectionID),
              vault.connections.contains(where: { $0.id == id }) else {
            throw ConnectionModelError.missingConnection
        }
        var nextVault = vault
        nextVault.activeConnectionID = id
        if let index = nextVault.connections.firstIndex(where: { $0.id == id }) {
            nextVault.connections[index].lastConnectedAt = Date()
        }
        try credentialStore.save(nextVault)
        vault = nextVault
        return connectionListPayload()
    }

    @discardableResult
    func forget(connectionID: String) throws -> ConnectionListPayload {
        guard let id = UUID(uuidString: connectionID) else { throw ConnectionModelError.missingConnection }
        var nextVault = vault
        nextVault.connections.removeAll { $0.id == id }
        if nextVault.activeConnectionID == id {
            nextVault.activeConnectionID = nextVault.connections.first?.id
        }
        if nextVault.connections.isEmpty {
            try credentialStore.delete()
        } else {
            try credentialStore.save(nextVault)
        }
        vault = nextVault
        return connectionListPayload()
    }

    func connectionListPayload() -> ConnectionListPayload {
        let activeID = vault.activeConnectionID?.uuidString ?? ""
        let formatter = ISO8601DateFormatter()
        return ConnectionListPayload(
            activeConnectionId: activeID,
            connections: vault.connections.map { connection in
                ConnectionListPayload.Summary(
                    id: connection.id.uuidString,
                    name: connection.name,
                    address: connection.address.absoluteString,
                    active: connection.id == vault.activeConnectionID,
                    lastConnectedAt: formatter.string(from: connection.lastConnectedAt)
                )
            }
        )
    }
}

enum ConnectionModelError: LocalizedError {
    case missingConnection

    var errorDescription: String? {
        "That saved connection no longer exists."
    }
}
