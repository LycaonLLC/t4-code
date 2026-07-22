import Foundation

public enum LocalHostSupervisorError: Error, Equatable, Sendable {
    case unsupported
    case invalidResource(String)
    case invalidPath(String)
    case launchFailed(String)
    case processExited(Int32, String)
    case timedOut(String)
}

public enum LocalHostPhase: String, Equatable, Sendable {
    case unsupported
    case stopped
    case starting
    case running
    case failed
}

public struct LocalHostSupervisorStatus: Equatable, Sendable {
    public let supported: Bool
    public let phase: LocalHostPhase
    public let socketURL: URL
    public let ownsProcess: Bool
    public let diagnostics: String

    public init(supported: Bool, phase: LocalHostPhase, socketURL: URL, ownsProcess: Bool, diagnostics: String = "") {
        self.supported = supported
        self.phase = phase
        self.socketURL = socketURL
        self.ownsProcess = ownsProcess
        self.diagnostics = LocalHostSupervisorDiagnostics.redacted(diagnostics)
    }

    public static func unsupported(socketURL: URL) -> Self {
        Self(supported: false, phase: .unsupported, socketURL: socketURL, ownsProcess: false, diagnostics: "Local host management is available on macOS only.")
    }
}

public protocol LocalHostFileSystem: Sendable {
    func homeDirectoryURL() -> URL
    func isRegularFile(at url: URL) -> Bool
    func isExecutableFile(at url: URL) -> Bool
    func isSymbolicLink(at url: URL) -> Bool
}

public protocol LocalHostProcessHandle: AnyObject, Sendable {
    var isRunning: Bool { get }
    var terminationStatus: Int32 { get }
    var diagnostics: String { get }
    func launch() throws
    func terminate()
}

public protocol LocalHostProcessFactory: Sendable {
    func makeProcess(executableURL: URL, arguments: [String]) -> any LocalHostProcessHandle
}

public protocol LocalHostSocketProbe: Sendable {
    func isHealthy(at socketURL: URL) -> Bool
}

public actor LocalHostSupervisor {
    public static let defaultProfile = "default"
    public static let defaultWaitNanoseconds: UInt64 = 15_000_000_000
    public static let defaultPollNanoseconds: UInt64 = 100_000_000

    private let t4HostURL: URL?
    private let ompURL: URL?
    private let profile: String
    private let stateRootURL: URL
    private let socketURL: URL
    private let fileSystem: any LocalHostFileSystem
    private let processFactory: any LocalHostProcessFactory
    private let socketProbe: any LocalHostSocketProbe
    private let waitNanoseconds: UInt64
    private let pollNanoseconds: UInt64
    private var ownedProcess: (any LocalHostProcessHandle)?
    private var lastDiagnostics = ""

    public init(
        bundle: Bundle = .main,
        profile: String = LocalHostSupervisor.defaultProfile,
        fileSystem: any LocalHostFileSystem = DefaultLocalHostFileSystem(),
        processFactory: any LocalHostProcessFactory = DefaultLocalHostProcessFactory(),
        socketProbe: any LocalHostSocketProbe = DefaultLocalHostSocketProbe(),
        waitNanoseconds: UInt64 = LocalHostSupervisor.defaultWaitNanoseconds,
        pollNanoseconds: UInt64 = LocalHostSupervisor.defaultPollNanoseconds
    ) {
        self.init(
            t4HostURL: bundle.url(forResource: "t4-host", withExtension: nil, subdirectory: "T4Runtime"),
            ompURL: bundle.url(forResource: "omp", withExtension: nil, subdirectory: "T4Runtime"),
            profile: profile,
            fileSystem: fileSystem,
            processFactory: processFactory,
            socketProbe: socketProbe,
            waitNanoseconds: waitNanoseconds,
            pollNanoseconds: pollNanoseconds
        )
    }

    public init(
        t4HostURL: URL?,
        ompURL: URL?,
        profile: String = LocalHostSupervisor.defaultProfile,
        stateRootURL: URL? = nil,
        socketURL: URL? = nil,
        homeDirectoryURL: URL? = nil,
        fileSystem: any LocalHostFileSystem = DefaultLocalHostFileSystem(),
        processFactory: any LocalHostProcessFactory = DefaultLocalHostProcessFactory(),
        socketProbe: any LocalHostSocketProbe = DefaultLocalHostSocketProbe(),
        waitNanoseconds: UInt64 = LocalHostSupervisor.defaultWaitNanoseconds,
        pollNanoseconds: UInt64 = LocalHostSupervisor.defaultPollNanoseconds
    ) {
        let home = homeDirectoryURL ?? fileSystem.homeDirectoryURL()
        self.t4HostURL = t4HostURL
        self.ompURL = ompURL
        self.profile = profile
        self.stateRootURL = stateRootURL ?? home.appendingPathComponent(".t4-code/host", isDirectory: true)
        self.socketURL = socketURL ?? home.appendingPathComponent(".omp/run/appserver.sock", isDirectory: false)
        self.fileSystem = fileSystem
        self.processFactory = processFactory
        self.socketProbe = socketProbe
        self.waitNanoseconds = min(waitNanoseconds, Self.defaultWaitNanoseconds)
        self.pollNanoseconds = pollNanoseconds
    }

    public func status() -> LocalHostSupervisorStatus {
#if os(macOS)
        let healthy = socketProbe.isHealthy(at: socketURL)
        if let process = ownedProcess {
            if process.isRunning {
                return status(phase: healthy ? .running : .starting, ownsProcess: true)
            }
            ownedProcess = nil
            if healthy { return status(phase: .running, ownsProcess: false) }
        }
        return status(phase: healthy ? .running : .stopped, ownsProcess: false)
#else
        return .unsupported(socketURL: socketURL)
#endif
    }

    public func start() async throws -> LocalHostSupervisorStatus {
#if os(macOS)
        if let process = ownedProcess {
            if !process.isRunning {
                ownedProcess = nil
            } else {
                do { return try await waitUntilReady(process: process) }
                catch { throw error }
            }
        }

        // A healthy socket is deliberately never claimed. It may belong to a
        // service started by launchd, another T4 instance, or an administrator.
        if socketProbe.isHealthy(at: socketURL) {
            lastDiagnostics = ""
            return status(phase: .running, ownsProcess: false)
        }

        guard let t4HostURL else { throw invalidResource("Missing bundled t4-host executable.") }
        guard let ompURL else { throw invalidResource("Missing bundled omp executable.") }
        try validateExecutable(t4HostURL, name: "t4-host")
        try validateExecutable(ompURL, name: "omp")
        guard !profile.isEmpty, !profile.contains("\0"), !profile.contains("/") else {
            throw LocalHostSupervisorError.invalidPath("Invalid host profile.")
        }
        try validatePath(stateRootURL, name: "state root")
        try validatePath(socketURL, name: "socket")

        let arguments = [
            "serve", "--omp", ompURL.path,
            "--profile", profile,
            "--state-root", stateRootURL.path,
        ]
        let process = processFactory.makeProcess(executableURL: t4HostURL, arguments: arguments)
        do {
            try process.launch()
        } catch {
            throw launchFailed(process.diagnostics.isEmpty ? String(describing: error) : process.diagnostics)
        }
        // Assign ownership only after launch succeeds. From this point onward
        // every stop/restart operation can identify the exact Process object.
        ownedProcess = process
        do {
            return try await waitUntilReady(process: process)
        } catch {
            if ownedProcess === process {
                process.terminate()
                ownedProcess = nil
            }
            throw error
        }
#else
        throw LocalHostSupervisorError.unsupported
#endif
    }

    public func stop() async throws -> LocalHostSupervisorStatus {
#if os(macOS)
        if let process = ownedProcess {
            if process.isRunning { process.terminate() }
            ownedProcess = nil
            lastDiagnostics = ""
        }
        // Never terminate or claim a process solely because this socket is live.
        return status()
#else
        throw LocalHostSupervisorError.unsupported
#endif
    }

    public func restart() async throws -> LocalHostSupervisorStatus {
#if os(macOS)
        if let process = ownedProcess {
            if process.isRunning { process.terminate() }
            ownedProcess = nil
        }
        return try await start()
#else
        throw LocalHostSupervisorError.unsupported
#endif
    }

#if os(macOS)
    private func waitUntilReady(process: any LocalHostProcessHandle) async throws -> LocalHostSupervisorStatus {
        let started = DispatchTime.now().uptimeNanoseconds
        let deadline = started.addingReportingOverflow(waitNanoseconds).partialValue
        while true {
            guard ownedProcess === process else {
                throw LocalHostSupervisorError.launchFailed("Host ownership was lost while starting.")
            }
            if socketProbe.isHealthy(at: socketURL) {
                lastDiagnostics = ""
                return status(phase: .running, ownsProcess: true)
            }
            if !process.isRunning {
                let detail = process.diagnostics
                let message = LocalHostSupervisorDiagnostics.redacted(detail.isEmpty ? "The bundled host exited before its socket became ready." : detail)
                ownedProcess = nil
                throw LocalHostSupervisorError.processExited(process.terminationStatus, message)
            }
            let now = DispatchTime.now().uptimeNanoseconds
            if now >= deadline {
                let detail = process.diagnostics
                let message = LocalHostSupervisorDiagnostics.redacted(detail.isEmpty ? "The local host did not become ready before the timeout." : detail)
                throw LocalHostSupervisorError.timedOut(message)
            }
            let remaining = deadline - now
            let delay = min(pollNanoseconds, remaining)
            if delay == 0 { await Task.yield() }
            else { try await Task.sleep(nanoseconds: delay) }
        }
    }

    private func validateExecutable(_ url: URL, name: String) throws {
        try validatePath(url, name: name)
        guard fileSystem.isRegularFile(at: url), !fileSystem.isSymbolicLink(at: url), fileSystem.isExecutableFile(at: url) else {
            throw invalidResource("Bundled \(name) is not a regular executable file.")
        }
        // Reject symlinked ancestors as well; a bundle resource must not be
        // redirected to an executable outside the signed app bundle.
        guard url.resolvingSymlinksInPath().standardizedFileURL.path == url.standardizedFileURL.path else {
            throw invalidResource("Bundled \(name) uses an unsafe symbolic-link path.")
        }
    }

    private func validatePath(_ url: URL, name: String) throws {
        guard url.isFileURL, !url.path.isEmpty, url.path.hasPrefix("/"), !url.path.contains("\0"), !url.pathComponents.contains("..") else {
            throw LocalHostSupervisorError.invalidPath("Invalid \(name) path.")
        }
    }

    private func invalidResource(_ message: String) -> LocalHostSupervisorError {
        .invalidResource(LocalHostSupervisorDiagnostics.redacted(message))
    }

    private func launchFailed(_ message: String) -> LocalHostSupervisorError {
        .launchFailed(LocalHostSupervisorDiagnostics.redacted(message))
    }

    private func status(phase: LocalHostPhase, ownsProcess: Bool) -> LocalHostSupervisorStatus {
        LocalHostSupervisorStatus(supported: true, phase: phase, socketURL: socketURL, ownsProcess: ownsProcess, diagnostics: lastDiagnostics)
    }
#endif
}

public enum LocalHostSupervisorDiagnostics {
    public static let maximumLength = 4096

    public static func redacted(_ value: String) -> String {
        var result = String(value.prefix(maximumLength))
        result = result.replacingOccurrences(
            of: "(?i)(authorization|cookie|token|password|secret|api[_-]?key)[=:][^\\s,;]+",
            with: "$1=<redacted>",
            options: .regularExpression
        )
        result = result.replacingOccurrences(of: "(?i)https?://[^\\s/?#]+[^\\s]*", with: "<url-redacted>", options: .regularExpression)
        return String(result.prefix(maximumLength))
    }
}

public struct DefaultLocalHostFileSystem: LocalHostFileSystem {
    public init() {}
    public func homeDirectoryURL() -> URL { FileManager.default.homeDirectoryForCurrentUser }
    public func isRegularFile(at url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
    }
    public func isExecutableFile(at url: URL) -> Bool { FileManager.default.isExecutableFile(atPath: url.path) }
    public func isSymbolicLink(at url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true
    }
}

#if os(macOS)
public struct DefaultLocalHostProcessFactory: LocalHostProcessFactory {
    public init() {}
    public func makeProcess(executableURL: URL, arguments: [String]) -> any LocalHostProcessHandle {
        FoundationLocalHostProcess(executableURL: executableURL, arguments: arguments)
    }
}

private final class FoundationLocalHostProcess: LocalHostProcessHandle, @unchecked Sendable {
    private let process: Process
    private let output: Pipe
    private let errors: Pipe
    private let lock = NSLock()
    private var outputText = ""
    private var errorText = ""

    init(executableURL: URL, arguments: [String]) {
        process = Process()
        output = Pipe()
        errors = Pipe()
        process.executableURL = executableURL
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in self?.append(handle.availableData, toErrors: false) }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in self?.append(handle.availableData, toErrors: true) }
    }

    var isRunning: Bool { process.isRunning }
    var terminationStatus: Int32 { process.terminationStatus }
    var diagnostics: String {
        lock.lock(); defer { lock.unlock() }
        return LocalHostSupervisorDiagnostics.redacted([outputText, errorText].filter { !$0.isEmpty }.joined(separator: "\n"))
    }
    func launch() throws {
        do { try process.run() }
        catch { throw LocalHostSupervisorError.launchFailed("Unable to launch the bundled local host.") }
    }
    func terminate() {
        if process.isRunning { process.terminate() }
    }
    private func append(_ data: Data, toErrors: Bool) {
        guard !data.isEmpty else { return }
        let text = String(decoding: data, as: UTF8.self)
        lock.lock(); defer { lock.unlock() }
        if toErrors { errorText = String((errorText + text).suffix(LocalHostSupervisorDiagnostics.maximumLength)) }
        else { outputText = String((outputText + text).suffix(LocalHostSupervisorDiagnostics.maximumLength)) }
    }
}

public struct DefaultLocalHostSocketProbe: LocalHostSocketProbe {
    public init() {}
    public func isHealthy(at socketURL: URL) -> Bool {
        guard socketURL.isFileURL, socketURL.path.utf8.count < 104 else { return false }
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        var address = sockaddr_un()
        address.sun_family = UInt8(AF_UNIX)
        let pathLength = socketURL.path.withCString { pointer in
            withUnsafeMutableBytes(of: &address.sun_path) { buffer in
                let length = min(strlen(pointer), buffer.count - 1)
                buffer.copyBytes(from: UnsafeRawBufferPointer(start: pointer, count: length))
                buffer[length] = 0
                return length
            }
        }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        _ = pathLength
        return result == 0
    }
}
#else
public struct DefaultLocalHostProcessFactory: LocalHostProcessFactory {
    public init() {}
    public func makeProcess(executableURL: URL, arguments: [String]) -> any LocalHostProcessHandle {
        UnsupportedLocalHostProcess()
    }
}

private final class UnsupportedLocalHostProcess: LocalHostProcessHandle, @unchecked Sendable {
    var isRunning: Bool { false }
    var terminationStatus: Int32 { -1 }
    var diagnostics: String { "Local host management is available on macOS only." }
    func launch() throws { throw LocalHostSupervisorError.unsupported }
    func terminate() {}
}

public struct DefaultLocalHostSocketProbe: LocalHostSocketProbe {
    public init() {}
    public func isHealthy(at socketURL: URL) -> Bool { false }
}
#endif
