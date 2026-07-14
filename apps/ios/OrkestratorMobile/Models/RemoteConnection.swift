import Foundation

struct RemoteConnection: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    var address: URL
    var token: String
    var lastConnectedAt: Date

    var name: String {
        address.host(percentEncoded: false) ?? address.absoluteString
    }
}

struct ConnectionVault: Codable, Equatable, Sendable {
    var activeConnectionID: UUID?
    var connections: [RemoteConnection]

    static let empty = ConnectionVault(activeConnectionID: nil, connections: [])

    var activeConnection: RemoteConnection? {
        guard let activeConnectionID else { return nil }
        return connections.first { $0.id == activeConnectionID }
    }
}

struct ConnectionListPayload: Encodable, Sendable {
    struct Summary: Encodable, Sendable {
        let id: String
        let name: String
        let address: String
        let kind = "remote"
        let active: Bool
        let requiresToken = false
        let lastConnectedAt: String
    }

    let activeConnectionId: String
    let connections: [Summary]
    let credentialStorage = "secure"
}
