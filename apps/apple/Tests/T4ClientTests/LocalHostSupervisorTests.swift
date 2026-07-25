import Foundation
import XCTest
@testable import T4Platform

final class LocalHostSupervisorTests: XCTestCase {
    func testHealthySocketIsReadyWithoutLaunchingOrClaimingProcess() async throws {
#if os(macOS)
        let fixture = Fixture(socketHealthy: true)
        let supervisor = fixture.supervisor()

        let started = try await supervisor.start()
        XCTAssertEqual(started.phase, .running)
        XCTAssertFalse(started.ownsProcess)
        XCTAssertEqual(fixture.factory.processes.count, 0)

        let stopped = try await supervisor.stop()
        XCTAssertEqual(stopped.phase, .running)
        XCTAssertEqual(fixture.factory.processes.count, 0)
#else
        let fixture = Fixture(socketHealthy: true)
        do { _ = try await fixture.supervisor().start(); XCTFail("iOS must be unsupported") }
        catch { XCTAssertEqual(error as? LocalHostSupervisorError, .unsupported) }
#endif
    }

    func testStartUsesOnlyLocalArgumentsAndWaitsForSocket() async throws {
#if os(macOS)
        let fixture = Fixture(socketHealthy: false)
        fixture.probe.responses = [false, false, true]
        let supervisor = fixture.supervisor()

        let result = try await supervisor.start()
        XCTAssertEqual(result.phase, .running)
        XCTAssertTrue(result.ownsProcess)
        XCTAssertEqual(fixture.factory.processes.count, 1)
        XCTAssertEqual(fixture.factory.processes[0].arguments, [
            "serve", "--omp", fixture.omp.path,
            "--profile", "default",
            "--state-root", fixture.stateRoot.path,
        ])
        XCTAssertEqual(fixture.factory.processes[0].executableURL, fixture.t4Host)
        XCTAssertFalse(fixture.factory.processes[0].arguments.contains("--port"))
        XCTAssertFalse(fixture.factory.processes[0].arguments.contains("--origin"))
#else
        do { _ = try await Fixture().supervisor().start(); XCTFail("iOS must be unsupported") }
        catch { XCTAssertEqual(error as? LocalHostSupervisorError, .unsupported) }
#endif
    }

    func testStopAndRestartOnlyTerminateOwnedProcess() async throws {
#if os(macOS)
        let fixture = Fixture(socketHealthy: false)
        fixture.probe.responses = [false, true, false, true]
        let supervisor = fixture.supervisor()

        _ = try await supervisor.start()
        let first = fixture.factory.processes[0]
        _ = try await supervisor.restart()
        XCTAssertEqual(first.terminateCount, 1)
        XCTAssertEqual(fixture.factory.processes.count, 2)
        XCTAssertEqual(fixture.factory.processes[1].terminateCount, 0)

        _ = try await supervisor.stop()
        XCTAssertEqual(fixture.factory.processes[1].terminateCount, 1)
#else
        do { _ = try await Fixture().supervisor().restart(); XCTFail("iOS must be unsupported") }
        catch { XCTAssertEqual(error as? LocalHostSupervisorError, .unsupported) }
#endif
    }

    func testInvalidResourcesAreRejectedBeforeLaunch() async throws {
#if os(macOS)
        let fixture = Fixture(socketHealthy: false)
        fixture.fileSystem.symbolicLinks.insert(fixture.t4Host.path)
        let supervisor = fixture.supervisor()

        do { _ = try await supervisor.start(); XCTFail("a symlinked executable must be rejected") }
        catch let error as LocalHostSupervisorError {
            guard case .invalidResource = error else { return XCTFail("unexpected error: \\(error)") }
        }
        XCTAssertTrue(fixture.factory.processes.isEmpty)
#else
        do { _ = try await Fixture().supervisor().start(); XCTFail("iOS must be unsupported") }
        catch { XCTAssertEqual(error as? LocalHostSupervisorError, .unsupported) }
#endif
    }

    func testTimeoutStopsOwnedProcessAndRedactsDiagnostics() async throws {
#if os(macOS)
        let fixture = Fixture(socketHealthy: false)
        fixture.processDiagnostics = "token=super-secret-value " + String(repeating: "x", count: 6000)
        let supervisor = fixture.supervisor(waitNanoseconds: 2_000_000, pollNanoseconds: 0)

        do { _ = try await supervisor.start(); XCTFail("socket readiness should time out") }
        catch let error as LocalHostSupervisorError {
            guard case .timedOut(let message) = error else { return XCTFail("unexpected error: \\(error)") }
            XCTAssertFalse(message.contains("super-secret-value"))
            XCTAssertLessThanOrEqual(message.count, LocalHostSupervisorDiagnostics.maximumLength)
        }
        XCTAssertEqual(fixture.factory.processes.count, 1)
        XCTAssertEqual(fixture.factory.processes[0].terminateCount, 1)
    #else
        do { _ = try await Fixture().supervisor().start(); XCTFail("iOS must be unsupported") }
        catch { XCTAssertEqual(error as? LocalHostSupervisorError, .unsupported) }
#endif
    }
}

private final class Fixture: @unchecked Sendable {
    let home = URL(fileURLWithPath: "/tmp/t4-local-host-tests/home", isDirectory: true)
    let t4Host = URL(fileURLWithPath: "/tmp/t4-local-host-tests/app/t4-host")
    let omp = URL(fileURLWithPath: "/tmp/t4-local-host-tests/app/omp")
    let stateRoot = URL(fileURLWithPath: "/tmp/t4-local-host-tests/home/.t4-code/host", isDirectory: true)
    let socket = URL(fileURLWithPath: "/tmp/t4-local-host-tests/home/.omp/run/appserver.sock")
    let fileSystem = FakeFileSystem()
    let factory = FakeProcessFactory()
    let probe: FakeSocketProbe
    var processDiagnostics = ""

    init(socketHealthy: Bool = false) {
        probe = FakeSocketProbe(defaultValue: socketHealthy)
        fileSystem.regularFiles = [t4Host.path, omp.path]
        fileSystem.executableFiles = [t4Host.path, omp.path]
    }

    func supervisor(waitNanoseconds: UInt64 = LocalHostSupervisor.defaultWaitNanoseconds, pollNanoseconds: UInt64 = 0) -> LocalHostSupervisor {
        factory.diagnostics = { [weak self] in self?.processDiagnostics ?? "" }
        return LocalHostSupervisor(
            t4HostURL: t4Host,
            ompURL: omp,
            stateRootURL: stateRoot,
            socketURL: socket,
            homeDirectoryURL: home,
            fileSystem: fileSystem,
            processFactory: factory,
            socketProbe: probe,
            waitNanoseconds: waitNanoseconds,
            pollNanoseconds: pollNanoseconds
        )
    }
}

private final class FakeFileSystem: LocalHostFileSystem, @unchecked Sendable {
    var regularFiles = Set<String>()
    var executableFiles = Set<String>()
    var symbolicLinks = Set<String>()
    var home = URL(fileURLWithPath: "/tmp/t4-local-host-tests/home", isDirectory: true)
    func homeDirectoryURL() -> URL { home }
    func isRegularFile(at url: URL) -> Bool { regularFiles.contains(url.path) }
    func isExecutableFile(at url: URL) -> Bool { executableFiles.contains(url.path) }
    func isSymbolicLink(at url: URL) -> Bool { symbolicLinks.contains(url.path) }
}

private final class FakeSocketProbe: LocalHostSocketProbe, @unchecked Sendable {
    let defaultValue: Bool
    var responses: [Bool] = []
    init(defaultValue: Bool) { self.defaultValue = defaultValue }
    func isHealthy(at socketURL: URL) -> Bool {
        if responses.isEmpty { return defaultValue }
        return responses.removeFirst()
    }
}

private final class FakeProcessFactory: LocalHostProcessFactory, @unchecked Sendable {
    var processes: [FakeProcess] = []
    var diagnostics: () -> String = { "" }
    func makeProcess(executableURL: URL, arguments: [String]) -> any LocalHostProcessHandle {
        let process = FakeProcess(executableURL: executableURL, arguments: arguments, diagnostics: diagnostics)
        processes.append(process)
        return process
    }
}

private final class FakeProcess: LocalHostProcessHandle, @unchecked Sendable {
    let executableURL: URL
    let arguments: [String]
    private let diagnosticsProvider: () -> String
    var isRunning = false
    var terminationStatus: Int32 = 0
    var launchCount = 0
    var terminateCount = 0

    init(executableURL: URL, arguments: [String], diagnostics: @escaping () -> String) {
        self.executableURL = executableURL
        self.arguments = arguments
        diagnosticsProvider = diagnostics
    }
    var diagnostics: String { diagnosticsProvider() }
    func launch() throws { launchCount += 1; isRunning = true }
    func terminate() { terminateCount += 1; isRunning = false }
}
