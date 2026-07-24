import Foundation
import Security

public let credentialStoragePrefix = "t4-code:device-credentials:v1:"
public let credentialKeychainService = "com.lycaonsolutions.t4code.credentials"

public struct DeviceCredentials: Codable, Equatable, Sendable {
    public let deviceID: String
    public let deviceToken: String
    public var deviceId: String { deviceID }

    public init(deviceID: String, deviceToken: String) throws {
        guard Self.valid(deviceID, maximum: 256), Self.valid(deviceToken, maximum: 512) else { throw CredentialStoreError.invalidCredentials }
        self.deviceID = deviceID
        self.deviceToken = deviceToken
    }
    public init(deviceId: String, deviceToken: String) throws { try self.init(deviceID: deviceId, deviceToken: deviceToken) }
    private static func valid(_ value: String, maximum: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= maximum && !value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    }
}

public enum CredentialStoreError: Error, Equatable, Sendable {
    case invalidCredentials
    case invalidRecord
    case keychainFailure
    case migrationFailed
}

public protocol KeychainStore: Sendable {
    func read(service: String, account: String) throws -> Data?
    func write(_ data: Data, service: String, account: String) throws
    func delete(service: String, account: String) throws
}

public protocol CredentialStore: Sendable {
    func read(for profile: HostProfile) async throws -> DeviceCredentials?
    func write(_ credentials: DeviceCredentials, for profile: HostProfile) async throws
    func delete(for profile: HostProfile) async throws
}

public actor KeychainCredentialStore: CredentialStore {
    private let keychain: any KeychainStore
    private let service: String

    public init(keychain: any KeychainStore = SecurityKeychainStore(), service: String = credentialKeychainService) {
        self.keychain = keychain
        self.service = service
    }

    public func read(for profile: HostProfile) async throws -> DeviceCredentials? {
        let current = try keychain.read(service: service, account: Self.account(for: profile.endpointKey))
        if let current { return try decode(current) }
        guard profile.profileID == "default" else { return nil }
        let originAccount = Self.account(for: profile.origin)
        guard let origin = try keychain.read(service: service, account: originAccount) else { return nil }
        let credentials = try decode(origin)
        do {
            try keychain.write(encode(credentials), service: service, account: Self.account(for: profile.endpointKey))
            do {
                try keychain.delete(service: service, account: originAccount)
            } catch {
                try? keychain.delete(service: service, account: Self.account(for: profile.endpointKey))
                throw CredentialStoreError.migrationFailed
            }
        } catch let error as CredentialStoreError { throw error }
          catch { throw CredentialStoreError.migrationFailed }
        return credentials
    }

    public func write(_ credentials: DeviceCredentials, for profile: HostProfile) async throws {
        let currentAccount = Self.account(for: profile.endpointKey)
        do {
            try keychain.write(encode(credentials), service: service, account: currentAccount)
            if profile.profileID == "default" {
                do { try keychain.delete(service: service, account: Self.account(for: profile.origin)) }
                catch {
                    try? keychain.delete(service: service, account: currentAccount)
                    throw CredentialStoreError.migrationFailed
                }
            }
        } catch let error as CredentialStoreError { throw error }
          catch { throw CredentialStoreError.keychainFailure }
    }

    public func delete(for profile: HostProfile) async throws {
        do {
            try keychain.delete(service: service, account: Self.account(for: profile.endpointKey))
            if profile.profileID == "default" { try keychain.delete(service: service, account: Self.account(for: profile.origin)) }
        } catch { throw CredentialStoreError.keychainFailure }
    }

    public static func account(for endpointKey: String) -> String {
        let encoded = Data(endpointKey.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return credentialStoragePrefix + encoded
    }

    private struct CredentialRecord: Codable {
        let version: Int
        let deviceID: String
        let deviceToken: String
        enum CodingKeys: String, CodingKey { case version, deviceID = "deviceId", deviceToken }
        private struct AnyCodingKey: CodingKey {
            let stringValue: String
            init?(stringValue: String) { self.stringValue = stringValue }
            let intValue: Int? = nil
            init?(intValue: Int) { return nil }
        }
        init(version: Int, deviceID: String, deviceToken: String) {
            self.version = version; self.deviceID = deviceID; self.deviceToken = deviceToken
        }
        init(from decoder: Decoder) throws {
            let rawKeys = try decoder.container(keyedBy: AnyCodingKey.self).allKeys.map(\.stringValue)
            guard Set(rawKeys) == Set(["version", "deviceId", "deviceToken"]) else { throw CredentialStoreError.invalidRecord }
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.version = try c.decode(Int.self, forKey: .version)
            self.deviceID = try c.decode(String.self, forKey: .deviceID)
            self.deviceToken = try c.decode(String.self, forKey: .deviceToken)
        }
    }

    private func encode(_ credentials: DeviceCredentials) throws -> Data {
        do { return try JSONEncoder().encode(CredentialRecord(version: 1, deviceID: credentials.deviceID, deviceToken: credentials.deviceToken)) }
        catch { throw CredentialStoreError.invalidRecord }
    }

    private func decode(_ data: Data) throws -> DeviceCredentials {
        do {
            let record = try JSONDecoder().decode(CredentialRecord.self, from: data)
            guard record.version == 1 else { throw CredentialStoreError.invalidRecord }
            return try DeviceCredentials(deviceID: record.deviceID, deviceToken: record.deviceToken)
        } catch let error as CredentialStoreError { throw error }
          catch { throw CredentialStoreError.invalidRecord }
    }
}

public struct SecurityKeychainStore: KeychainStore {
    public init() {}

    public func read(service: String, account: String) throws -> Data? {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account, kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw CredentialStoreError.keychainFailure }
        return data
    }

    public func write(_ data: Data, service: String, account: String) throws {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
        let attributes: [CFString: Any] = [kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecValueData] = data
            insert[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw CredentialStoreError.keychainFailure }
        } else if status != errSecSuccess { throw CredentialStoreError.keychainFailure }
    }

    public func delete(service: String, account: String) throws {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialStoreError.keychainFailure }
    }
}
