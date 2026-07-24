import Foundation
#if os(macOS)
import Darwin
#endif

public struct PlatformProcessResult: Equatable, Sendable {
    public let status: Int32
    public let stdout: String
    public let stderr: String
    public init(status: Int32, stdout: String = "", stderr: String = "") { self.status = status; self.stdout = stdout; self.stderr = stderr }
}

public protocol PlatformProcessFacade: Sendable {
    func run(executable: String, arguments: [String]) throws -> PlatformProcessResult
}

public enum PlatformLifecycleError: Error, Equatable, Sendable {
    case unsupported
    case invalidConfiguration
    case processFailed(String)
}

public enum RuntimeServicePhase: String, Codable, Sendable { case stopped, starting, running, failed, unknown }
public enum RuntimeDefinitionState: String, Codable, Sendable { case missing, current, drifted }

public struct RuntimeServiceStatus: Equatable, Sendable {
    public let supported: Bool
    public let available: Bool
    public let definition: RuntimeDefinitionState
    public let service: RuntimeServicePhase
    public let diagnostics: String
    public let executable: String?
    public let issueCode: String?
    public let message: String?

    public init(supported: Bool, available: Bool, definition: RuntimeDefinitionState, service: RuntimeServicePhase, diagnostics: String, executable: String? = nil, issueCode: String? = nil, message: String? = nil) {
        self.supported = supported; self.available = available; self.definition = definition; self.service = service; self.diagnostics = Self.bounded(diagnostics, maximum: 4096); self.executable = executable.map { Self.bounded($0, maximum: 1024) }; self.issueCode = issueCode.map { Self.bounded($0, maximum: 128) }; self.message = message.map { Self.bounded($0, maximum: 512) }
    }
    public static var unsupported: RuntimeServiceStatus { RuntimeServiceStatus(supported: false, available: false, definition: .missing, service: .unknown, diagnostics: "Local OMP service management is available on macOS only.", issueCode: "unsupported_platform", message: "Unsupported on this platform.") }
    private static func bounded(_ value: String, maximum: Int) -> String { String(value.prefix(maximum)) }
}

public protocol PlatformLifecycle: Sendable {
    func status() async -> RuntimeServiceStatus
    func install() async throws -> RuntimeServiceStatus
    func start() async throws -> RuntimeServiceStatus

    func stop() async throws -> RuntimeServiceStatus
    func restart() async throws -> RuntimeServiceStatus
    func uninstall() async throws -> RuntimeServiceStatus
}
public typealias ProcessFacade = any PlatformProcessFacade

public actor PlatformLifecycleService: PlatformLifecycle {
    public static let defaultServiceLabel = "dev.oh-my-pi.appserver"
    private let process: any PlatformProcessFacade
    private let serviceLabel: String
    private let executableURL: URL?
    private let definitionURL: URL?
    private var cachedStatus: RuntimeServiceStatus = .unsupported

#if os(macOS)
    private var launchDomain: String { "gui/\(getuid())" }
    private var launchTarget: String { "\(launchDomain)/\(serviceLabel)" }
#endif
    public init(process: (any PlatformProcessFacade)? = nil, serviceLabel: String = PlatformLifecycleService.defaultServiceLabel, executableURL: URL? = nil, definitionURL: URL? = nil) {
        self.process = process ?? PlatformLifecycleService.defaultFacade
        self.serviceLabel = serviceLabel
        self.executableURL = executableURL
        self.definitionURL = definitionURL
#if os(macOS)
        self.cachedStatus = RuntimeServiceStatus(supported: true, available: false, definition: .missing, service: .unknown, diagnostics: "The local T4 host service has not been inspected.", executable: executableURL?.path)
#endif
    }

    private static var defaultFacade: any PlatformProcessFacade {
#if os(macOS)
        MacPlatformProcessFacade()
#else
        UnsupportedPlatformProcessFacade()
#endif
    }

    public func status() async -> RuntimeServiceStatus {
#if os(macOS)
        do {
            let result = try process.run(executable: "/bin/launchctl", arguments: ["print", launchTarget])
            let running = result.status == 0
            let definition: RuntimeDefinitionState = definitionURL.map { FileManager.default.fileExists(atPath: $0.path) ? .current : .missing } ?? .missing
            cachedStatus = RuntimeServiceStatus(supported: true, available: running, definition: definition, service: running ? .running : .stopped, diagnostics: sanitize(result.stderr.isEmpty ? result.stdout : result.stderr), executable: executableURL?.path, issueCode: running ? nil : "service_stopped")
        } catch {
            cachedStatus = RuntimeServiceStatus(supported: true, available: false, definition: .missing, service: .unknown, diagnostics: sanitize(String(describing: error)), executable: executableURL?.path, issueCode: "inspection_failed", message: "Unable to inspect the local host service.")
        }
        return cachedStatus
#else
        return .unsupported
#endif
    }

    public func inspectRuntime() async -> RuntimeServiceStatus { await status() }
    public func installRuntime() async throws -> RuntimeServiceStatus { try await install() }
    public func startRuntime() async throws -> RuntimeServiceStatus { try await start() }
    public func stopRuntime() async throws -> RuntimeServiceStatus { try await stop() }
    public func restartRuntime() async throws -> RuntimeServiceStatus { try await restart() }
    public func uninstallRuntime() async throws -> RuntimeServiceStatus { try await uninstall() }

    public func install() async throws -> RuntimeServiceStatus {
#if os(macOS)
        guard let definitionURL else { throw PlatformLifecycleError.invalidConfiguration }
        try runChecked("bootstrap", [launchDomain, definitionURL.path])
        return await status()
#else
        throw PlatformLifecycleError.unsupported
#endif
    }

    public func start() async throws -> RuntimeServiceStatus {
#if os(macOS)
        try runChecked("kickstart", ["-k", launchTarget])
        return await status()
#else
        throw PlatformLifecycleError.unsupported
#endif
    }

    public func stop() async throws -> RuntimeServiceStatus {
#if os(macOS)
        try runChecked("kill", ["SIGTERM", launchTarget])
        return await status()
#else
        throw PlatformLifecycleError.unsupported
#endif
    }

    public func restart() async throws -> RuntimeServiceStatus {
#if os(macOS)
        try runChecked("kickstart", ["-k", launchTarget])
        return await status()
#else
        throw PlatformLifecycleError.unsupported
#endif
    }

    public func uninstall() async throws -> RuntimeServiceStatus {
#if os(macOS)
        try runChecked("bootout", [launchTarget])
        return await status()
#else
        throw PlatformLifecycleError.unsupported
#endif
    }

#if os(macOS)
    private func runChecked(_ command: String, _ arguments: [String]) throws {
        do {
            let result = try process.run(executable: "/bin/launchctl", arguments: [command] + arguments)
            guard result.status == 0 else { throw PlatformLifecycleError.processFailed(Self.sanitize(result.stderr.isEmpty ? result.stdout : result.stderr)) }
        } catch let error as PlatformLifecycleError { throw error }
          catch { throw PlatformLifecycleError.processFailed(Self.sanitize(String(describing: error))) }
    }
#endif

    private static func sanitize(_ value: String) -> String {
        var result = String(value.prefix(512))
        result = result.replacingOccurrences(of: "(?i)(authorization|cookie|token|password|secret)[=:][^\\s,;]+", with: "$1=<redacted>", options: .regularExpression)
        result = result.replacingOccurrences(of: "(?i)(https?://[^\\s/?#]+)[^\\s]*", with: "$1", options: .regularExpression)
        return result
    }
    private func sanitize(_ value: String) -> String { Self.sanitize(value) }
}

public struct UnsupportedPlatformProcessFacade: PlatformProcessFacade {
    public init() {}
    public func run(executable: String, arguments: [String]) throws -> PlatformProcessResult { throw PlatformLifecycleError.unsupported }
}

#if os(macOS)
public struct MacPlatformProcessFacade: PlatformProcessFacade {
    public init() {}
    public func run(executable: String, arguments: [String]) throws -> PlatformProcessResult {
        let process = Process()
        let output = Pipe(); let errors = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = output; process.standardError = errors
        do { try process.run(); process.waitUntilExit() } catch { throw PlatformLifecycleError.processFailed("Unable to launch the service manager.") }
        let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return PlatformProcessResult(status: process.terminationStatus, stdout: stdout, stderr: stderr)
    }
}
#endif

public typealias UnsupportedProcessFacade = UnsupportedPlatformProcessFacade
#if os(macOS)
public typealias MacProcessFacade = MacPlatformProcessFacade
#endif
