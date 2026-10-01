import Foundation

struct RemoteConnection: Codable, Equatable, Identifiable, Sendable {
    let id: UUID
    var address: URL
    var token: String
    var lastConnectedAt: Date
    /// User-assigned display name. `nil` shows the hostname.
    var nickname: String? = nil

    var hostname: String {
        address.host(percentEncoded: false) ?? address.absoluteString
    }

    var name: String {
        nickname ?? hostname
    }

    static let maxNicknameLength = 64

    /// Collapses whitespace and removes control characters. Blank input means
    /// "use the hostname" and returns `nil`, matching the desktop client.
    static func normalizedNickname(_ value: String?) throws -> String? {
        guard let value else { return nil }
        let space: Unicode.Scalar = " "
        let scalars = value.unicodeScalars.map { scalar in
            CharacterSet.controlCharacters.contains(scalar) ? space : scalar
        }
        let cleaned = String(String.UnicodeScalarView(scalars))
        let nickname = cleaned
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        guard !nickname.isEmpty else { return nil }
        guard nickname.unicodeScalars.count <= maxNicknameLength else {
            throw RemoteConnectionError.nicknameTooLong
        }
        return nickname
    }
}

enum RemoteConnectionError: LocalizedError, Equatable {
    case nicknameTooLong

    var errorDescription: String? {
        switch self {
        case .nicknameTooLong:
            return "Use a nickname of \(RemoteConnection.maxNicknameLength) characters or fewer."
        }
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
        var nickname: String? = nil
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
