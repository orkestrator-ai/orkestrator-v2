import Foundation
import Security

protocol ConnectionCredentialStoring: Sendable {
    func load() throws -> ConnectionVault
    func save(_ vault: ConnectionVault) throws
    func delete() throws
}

struct KeychainCredentialStore: ConnectionCredentialStoring, Sendable {
    let service: String
    let account: String

    init(
        service: String = "dev.orkestrator.mobile.remote-connections",
        account: String = "connection-vault"
    ) {
        self.service = service
        self.account = account
    }

    func load() throws -> ConnectionVault {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return .empty }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        guard let data = result as? Data else { throw KeychainError.invalidData }

        do {
            return try JSONDecoder().decode(ConnectionVault.self, from: data)
        } catch {
            throw KeychainError.invalidData
        }
    }

    func save(_ vault: ConnectionVault) throws {
        let data = try JSONEncoder().encode(vault)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw KeychainError(status: updateStatus) }

        var item = baseQuery
        attributes.forEach { item[$0.key] = $0.value }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
    }

    func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

enum KeychainError: LocalizedError {
    case invalidData
    case operationFailed(OSStatus)

    init(status: OSStatus) {
        self = .operationFailed(status)
    }

    var errorDescription: String? {
        switch self {
        case .invalidData:
            return "The saved connection could not be read. Remove it and connect again."
        case .operationFailed(let status):
            let detail = SecCopyErrorMessageString(status, nil) as String? ?? "Unknown Keychain error"
            return "Secure credential storage failed: \(detail)."
        }
    }
}
