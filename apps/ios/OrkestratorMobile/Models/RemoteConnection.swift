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

    /// Metadata changes must not restart authentication or invalidate in-flight work.
    func hasSameAuthenticationIdentity(as other: RemoteConnection?) -> Bool {
        guard let other else { return false }
        return id == other.id && address == other.address && token == other.token
    }

    static let maxNicknameLength = 64

    /// Collapses whitespace and removes control characters. Blank input means
    /// "use the hostname" and returns `nil`, matching the desktop client.
    static func normalizedNickname(_ value: String?) throws -> String? {
        guard let value else { return nil }
        let space: Unicode.Scalar = " "
        let scalars = value.unicodeScalars.map { scalar in
            // Match the protocol's C0/DEL replacement and ECMAScript whitespace.
            // Foundation also classifies emoji joiners as controls and NEL as whitespace.
            let code = scalar.value
            let isWhitespace = code == 0x20 || code == 0xa0 || code == 0x1680
                || (0x2000...0x200a).contains(code) || code == 0x2028 || code == 0x2029
                || code == 0x202f || code == 0x205f || code == 0x3000 || code == 0xfeff
            return (code <= 0x1f || code == 0x7f || isWhitespace) ? space : scalar
        }
        let nickname = scalars
            .split(whereSeparator: { $0 == space })
            .map { String(String.UnicodeScalarView($0)) }
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
