import Foundation

public let hostProfileSchemaVersion = 3
public let hostDirectoryStorageKey = "t4-code:mobile-backends:v3"
public let maximumSavedHosts = 16
public let maximumHostURLLength = 2_048
public let maximumHostLabelLength = 128
public let maximumProfileIDLength = 64

public enum HostProfileStoreError: Error, Equatable, Sendable {
    case invalidSavedData
    case unsupportedVersion
    case emptyDirectory
    case tooManyProfiles
    case duplicateProfile
    case invalidProfile
}

public struct HostProfile: Codable, Equatable, Hashable, Sendable {
    public let endpointKey: String
    public let origin: String
    public let profileID: String
    public let webSocketURL: URL
    public let label: String

    public var profileId: String { profileID }
    public var wsURL: URL { webSocketURL }

    public init(endpointKey: String, origin: String, profileID: String, webSocketURL: URL, label: String) throws {
        self.endpointKey = endpointKey
        self.origin = origin
        self.profileID = profileID
        self.webSocketURL = webSocketURL
        self.label = label
        try validate()
    }

    public init(endpointKey: String, origin: String, profileId: String, webSocketURL: URL, label: String) throws {
        try self.init(endpointKey: endpointKey, origin: origin, profileID: profileId, webSocketURL: webSocketURL, label: label)
    }

    public static func parseTailnetAddress(_ value: String, profileID: String = "default") throws -> HostProfile {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= maximumHostURLLength else { throw HostProfileStoreError.invalidProfile }
        let normalizedID = try normalizeProfileID(profileID)
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let components = URLComponents(string: candidate), components.scheme?.lowercased() == "https",
              let host = components.host?.lowercased(), host != "ts.net", host.hasSuffix(".ts.net"), !host.isEmpty,
              components.user == nil, components.password == nil,
              (components.path.isEmpty || components.path == "/"), components.query == nil, components.fragment == nil else {
            throw HostProfileStoreError.invalidProfile
        }
        let port = components.port.map { $0 == 443 ? "" : ":\($0)" } ?? ""
        let canonicalOrigin = "https://\(host)\(port)"
        let path = normalizedID == "default" ? "/v1/ws" : "/v1/profiles/\(normalizedID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? normalizedID)/ws"
        guard let wsURL = URL(string: "wss://\(host)\(port)\(path)") else { throw HostProfileStoreError.invalidProfile }
        let firstLabel = host.split(separator: ".", maxSplits: 1).first.map(String.init) ?? host
        let profile = try HostProfile(endpointKey: "\(canonicalOrigin)#profile=\(normalizedID)", origin: canonicalOrigin, profileID: normalizedID, webSocketURL: wsURL, label: "T4 on \(firstLabel)")
        return profile
    }

    public static func normalizeProfileID(_ value: String) throws -> String {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return "default" }
        guard value.utf8.count <= maximumProfileIDLength,
              value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", options: .regularExpression) != nil else {
            throw HostProfileStoreError.invalidProfile
        }
        return value
    }

    private enum CodingKeys: String, CodingKey { case version, endpointKey, origin, profileId, wsUrl, label }
    private struct AnyCodingKey: CodingKey {
        let stringValue: String
        init?(stringValue: String) { self.stringValue = stringValue }
        let intValue: Int? = nil
        init?(intValue: Int) { return nil }
    }

    public init(from decoder: Decoder) throws {
        let rawKeys = try decoder.container(keyedBy: AnyCodingKey.self).allKeys.map(\.stringValue)
        guard Set(rawKeys) == Set(["version", "endpointKey", "origin", "profileId", "wsUrl", "label"]) else { throw HostProfileStoreError.invalidSavedData }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard try container.decode(Int.self, forKey: .version) == hostProfileSchemaVersion else { throw HostProfileStoreError.unsupportedVersion }
        self.endpointKey = try container.decode(String.self, forKey: .endpointKey)
        self.origin = try container.decode(String.self, forKey: .origin)
        self.profileID = try container.decode(String.self, forKey: .profileId)
        self.webSocketURL = try container.decode(URL.self, forKey: .wsUrl)
        self.label = try container.decode(String.self, forKey: .label)
        try validate()
        let canonical = try Self.parseTailnetAddress(origin, profileID: profileID)
        guard canonical.endpointKey == endpointKey, canonical.webSocketURL == webSocketURL, canonical.label == label else { throw HostProfileStoreError.invalidSavedData }
    }

    public func encode(to encoder: Encoder) throws {
        try validate()
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hostProfileSchemaVersion, forKey: .version)
        try container.encode(endpointKey, forKey: .endpointKey)
        try container.encode(origin, forKey: .origin)
        try container.encode(profileID, forKey: .profileId)
        try container.encode(webSocketURL, forKey: .wsUrl)
        try container.encode(label, forKey: .label)
    }

    private func validate() throws {
        guard !endpointKey.isEmpty, endpointKey.utf8.count <= maximumHostURLLength,
              !origin.isEmpty, origin.utf8.count <= maximumHostURLLength,
              !label.isEmpty, label.utf8.count <= maximumHostLabelLength,
              !profileID.isEmpty, profileID.utf8.count <= maximumProfileIDLength,
              webSocketURL.scheme?.lowercased() == "wss" else { throw HostProfileStoreError.invalidProfile }
        for text in [endpointKey, origin, profileID, label] where text.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { throw HostProfileStoreError.invalidProfile }
    }
}

public struct HostDirectory: Codable, Equatable, Sendable {
    public let profiles: [HostProfile]
    public let activeEndpointKey: String?

    public init(profiles: [HostProfile] = [], activeEndpointKey: String? = nil) throws {
        guard profiles.count <= maximumSavedHosts else { throw HostProfileStoreError.tooManyProfiles }
        let keys = profiles.map(\.endpointKey)
        guard Set(keys).count == keys.count else { throw HostProfileStoreError.duplicateProfile }
        guard profiles.isEmpty ? activeEndpointKey == nil : (activeEndpointKey.map { keys.contains($0) } ?? false) else { throw HostProfileStoreError.invalidSavedData }
        self.profiles = profiles
        self.activeEndpointKey = activeEndpointKey
    }

    public static let empty = try! HostDirectory()

    public var activeProfile: HostProfile? { profiles.first { $0.endpointKey == activeEndpointKey } }

    public func upserting(_ profile: HostProfile) throws -> HostDirectory {
        var next = profiles.filter { $0.endpointKey != profile.endpointKey }
        if next.count >= maximumSavedHosts { throw HostProfileStoreError.tooManyProfiles }
        next.append(profile)
        return try HostDirectory(profiles: next, activeEndpointKey: profile.endpointKey)
    }

    public func activating(endpointKey: String) throws -> HostDirectory { guard profiles.contains(where: { $0.endpointKey == endpointKey }) else { throw HostProfileStoreError.invalidSavedData }; return try HostDirectory(profiles: profiles, activeEndpointKey: endpointKey) }

    public func removing(endpointKey: String) throws -> HostDirectory {
        let next = profiles.filter { $0.endpointKey != endpointKey }
        guard next.count != profiles.count else { return self }
        let active = activeEndpointKey == endpointKey ? next.first?.endpointKey : activeEndpointKey
        return try HostDirectory(profiles: next, activeEndpointKey: active)
    }

    private enum CodingKeys: String, CodingKey { case version, activeEndpointKey, backends }
    private struct AnyCodingKey: CodingKey {
        let stringValue: String
        init?(stringValue: String) { self.stringValue = stringValue }
        let intValue: Int? = nil
        init?(intValue: Int) { return nil }
    }
    public init(from decoder: Decoder) throws {
        let rawKeys = try decoder.container(keyedBy: AnyCodingKey.self).allKeys.map(\.stringValue)
        guard Set(rawKeys) == Set(["version", "activeEndpointKey", "backends"]) else { throw HostProfileStoreError.invalidSavedData }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decode(Int.self, forKey: .version) == hostProfileSchemaVersion else { throw HostProfileStoreError.unsupportedVersion }
        let active = try c.decodeIfPresent(String.self, forKey: .activeEndpointKey)
        let profiles = try c.decode([HostProfile].self, forKey: .backends)
        guard !profiles.isEmpty else { throw HostProfileStoreError.emptyDirectory }
        try self.init(profiles: profiles, activeEndpointKey: active)
    }
    public func encode(to encoder: Encoder) throws {
        guard !profiles.isEmpty, let activeEndpointKey else { throw HostProfileStoreError.emptyDirectory }
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(hostProfileSchemaVersion, forKey: .version)
        try c.encode(activeEndpointKey, forKey: .activeEndpointKey)
        try c.encode(profiles, forKey: .backends)
    }
}

public protocol HostProfileStore: Sendable {
    func load() async throws -> HostDirectory
    func save(_ directory: HostDirectory) async throws
}

public actor UserDefaultsHostProfileStore: HostProfileStore {
    private let defaults: UserDefaults
    private let key: String
    public init(defaults: UserDefaults = .standard, key: String = hostDirectoryStorageKey) { self.defaults = defaults; self.key = key }

    public func load() async throws -> HostDirectory {
        guard let data = defaults.data(forKey: key) else { return .empty }
        do { return try JSONDecoder().decode(HostDirectory.self, from: data) } catch { throw HostProfileStoreError.invalidSavedData }
    }

    public func save(_ directory: HostDirectory) async throws {
        if directory.profiles.isEmpty { defaults.removeObject(forKey: key); return }
        do { defaults.set(try JSONEncoder().encode(directory), forKey: key) } catch { throw HostProfileStoreError.invalidSavedData }
    }
}
