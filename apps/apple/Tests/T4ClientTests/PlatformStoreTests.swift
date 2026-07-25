import Foundation
import XCTest
@testable import T4Platform
final class PlatformStoreTests: XCTestCase {
    private func profile(_ id: String = "default") throws -> HostProfile {
        try HostProfile.parseTailnetAddress("machine.example.ts.net", profileID: id)
    }

    func testUserDefaultsStoreUsesV3KeyAndRemovesEmptyDirectory() async throws {
        let suite = "PlatformStoreTests.\(UUID().uuidString)"
        let store = UserDefaultsHostProfileStore(
            defaults: try XCTUnwrap(UserDefaults(suiteName: suite))
        )
        let profile = try profile()
        let directory = try HostDirectory(profiles: [profile], activeEndpointKey: profile.endpointKey)
        try await store.save(directory)
        XCTAssertNotNil(UserDefaults(suiteName: suite)?.data(forKey: hostDirectoryStorageKey))
        XCTAssertNil(UserDefaults(suiteName: suite)?.data(forKey: "t4-code:mobile-backends:v2"))
        let empty = try HostDirectory()
        try await store.save(empty)
        XCTAssertNil(UserDefaults(suiteName: suite)?.data(forKey: hostDirectoryStorageKey))
        let loaded = try await store.load()
        XCTAssertEqual(loaded, .empty)
        UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
    }

    func testUserDefaultsStoreRejectsInconsistentAndUnsupportedRecords() async throws {
        let suite = "PlatformStoreTests.\(UUID().uuidString)"
        let seed = try XCTUnwrap(UserDefaults(suiteName: suite))
        seed.set(Data(#"{"version":2,"activeEndpointKey":"x","backends":[]}"#.utf8), forKey: hostDirectoryStorageKey)
        let store = UserDefaultsHostProfileStore(
            defaults: try XCTUnwrap(UserDefaults(suiteName: suite))
        )
        do { _ = try await store.load(); XCTFail("future records must be rejected") }
        catch { XCTAssertEqual(error as? HostProfileStoreError, .invalidSavedData) }
        UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
    }

    func testCredentialAccountIsVersionedUnpaddedBase64URL() throws {
        let account = KeychainCredentialStore.account(for: "https://machine.ts.net#profile=default")
        XCTAssertTrue(account.hasPrefix(credentialStoragePrefix))
        XCTAssertFalse(account.contains("=")); XCTAssertFalse(account.contains("+")); XCTAssertFalse(account.contains("/"))
        XCTAssertEqual(account, "t4-code:device-credentials:v1:aHR0cHM6Ly9tYWNoaW5lLnRzLm5ldCNwcm9maWxlPWRlZmF1bHQ")
    }

    func testDefaultOriginMigrationRollsBackCurrentRecordWhenCleanupFails() async throws {
        let host = try profile()
        let keychain = MemoryKeychain(failDeleteAccount: KeychainCredentialStore.account(for: host.origin))
        let store = KeychainCredentialStore(keychain: keychain)
        let old = try DeviceCredentials(deviceID: "device", deviceToken: "token")
        try keychain.write(try JSONEncoder().encode(MemoryCredentialRecord(version: 1, deviceId: old.deviceID, deviceToken: old.deviceToken)), service: credentialKeychainService, account: KeychainCredentialStore.account(for: host.origin))
        do { _ = try await store.read(for: host); XCTFail("migration should report cleanup failure") }
        catch { XCTAssertEqual(error as? CredentialStoreError, .migrationFailed) }
        XCTAssertNil(try keychain.read(service: credentialKeychainService, account: KeychainCredentialStore.account(for: host.endpointKey)))
        XCTAssertNotNil(try keychain.read(service: credentialKeychainService, account: KeychainCredentialStore.account(for: host.origin)))
    }

    func testLifecycleSerializesOperationsAndProvidesBoundedRedactedFailures() async throws {
        let process = RecordingProcess()
        process.result = PlatformProcessResult(status: 1, stderr: "token=secret-value " + String(repeating: "x", count: 700))
        let service = PlatformLifecycleService(process: process, serviceLabel: "com.test.host", definitionURL: URL(fileURLWithPath: "/tmp/missing-t4.plist"))
#if os(macOS)
        do { _ = try await service.start(); XCTFail("start should fail") }
        catch let error as PlatformLifecycleError {
            guard case .processFailed(let message) = error else { return XCTFail("unexpected error") }
            XCTAssertFalse(message.contains("secret-value")); XCTAssertLessThanOrEqual(message.count, 512)
        }
        XCTAssertEqual(process.commands.count, 1)
#else
        do { _ = try await service.start(); XCTFail("iOS lifecycle must be unsupported") }
        catch { XCTAssertEqual(error as? PlatformLifecycleError, .unsupported) }
#endif
    }
}

private struct MemoryCredentialRecord: Codable { let version: Int; let deviceId: String; let deviceToken: String }

private final class MemoryKeychain: KeychainStore, @unchecked Sendable {
    private var values: [String: Data] = [:]
    private let failDeleteAccount: String?
    init(failDeleteAccount: String? = nil) { self.failDeleteAccount = failDeleteAccount }
    func read(service: String, account: String) throws -> Data? { values[service + "\n" + account] }
    func write(_ data: Data, service: String, account: String) throws { values[service + "\n" + account] = data }
    func delete(service: String, account: String) throws { if account == failDeleteAccount { throw CredentialStoreError.keychainFailure }; values.removeValue(forKey: service + "\n" + account) }
}

private final class RecordingProcess: PlatformProcessFacade, @unchecked Sendable {
    var commands: [[String]] = []
    var result = PlatformProcessResult(status: 0)
    func run(executable: String, arguments: [String]) throws -> PlatformProcessResult { commands.append([executable] + arguments); return result }
}
