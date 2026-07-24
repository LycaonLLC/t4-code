import Foundation
import XCTest
@testable import T4Client

@MainActor
final class T4ClientControllerTests: XCTestCase {
    func testStaleResponseFromPreviousGenerationDoesNotMutateState() async throws {
        let transport = TestTransport()
        let controller = T4ClientController(transport: transport, reconnectPolicy: .init(baseDelay: .milliseconds(1), maximumDelay: .milliseconds(1)))
        let connect = Task { await controller.connect() }
        try await transport.waitFor(type: "hello")
        transport.emit(Self.welcome(host: "host-a"))
        let list = try await transport.waitFor(command: "session.list")
        await controller.disconnect()
        transport.emit(Self.response(requestID: list.requestID, commandID: list.commandID, command: "session.list", host: "host-a", result: ["sessions": []]))
        await connect.value
        XCTAssertEqual(controller.state.connection, .disconnected)
        XCTAssertTrue(controller.state.sessions.isEmpty)
    }

    func testBootstrapListsAndWatchesWithIndependentIndexCursor() async throws {
        let transport = TestTransport()
        let controller = T4ClientController(transport: transport)
        let connect = Task { await controller.connect() }
        try await transport.waitFor(type: "hello")
        transport.emit(Self.welcome(host: "host-a"))
        let list = try await transport.waitFor(command: "session.list")
        transport.emit(Self.response(requestID: list.requestID, commandID: list.commandID, command: "session.list", host: "host-a", result: [
            "cursor": ["epoch": "index", "seq": 4],
            "sessions": [["sessionId": "s1", "hostId": "host-a", "title": "One"]]
        ]))
        let watch = try await transport.waitFor(command: "host.watch")
        XCTAssertEqual((watch.args["cursor"] as? [String: Any])?["epoch"] as? String, "index")
        transport.emit(Self.response(requestID: watch.requestID, commandID: watch.commandID, command: "host.watch", host: "host-a", result: [:]))
        await connect.value
        await controller.disconnect()
        XCTAssertEqual(controller.state.sessions.map(\.id), ["s1"])
        XCTAssertEqual(controller.state.sessionIndexCursor, SessionIndexCursor(epoch: "index", seq: 4))
        XCTAssertNil(controller.state.transcriptCursor)
    }

    func testReconnectRetainsSelectionAndReattachesWithTranscriptCursor() async throws {
        let transport = TestTransport()
        let controller = T4ClientController(transport: transport, reconnectPolicy: .init(baseDelay: .milliseconds(1), maximumDelay: .milliseconds(1), maximumAttempts: 2))
        controller.state.selectedSessionID = "s1"
        controller.state.transcriptCursor = TranscriptCursor(epoch: "stream", seq: 9)
        let connect = Task { await controller.connect() }
        try await transport.waitFor(type: "hello")
        transport.emit(Self.welcome(host: "host-a"))
        let list = try await transport.waitFor(command: "session.list")
        transport.emit(Self.response(requestID: list.requestID, commandID: list.commandID, command: "session.list", host: "host-a", result: ["sessions": []]))
        let attach = try await transport.waitFor(command: "session.attach")
        transport.emit(Self.response(requestID: attach.requestID, commandID: attach.commandID, command: "session.attach", host: "host-a", session: "s1", result: ["attached": true]))
        await connect.value
        transport.drop()
        try await transport.waitFor(type: "hello")
        transport.emit(Self.welcome(host: "host-a"))
        let relist = try await transport.waitFor(command: "session.list")
        transport.emit(Self.response(requestID: relist.requestID, commandID: relist.commandID, command: "session.list", host: "host-a", result: ["sessions": []]))
        let reattach = try await transport.waitFor(command: "session.attach")
        XCTAssertEqual((reattach.args["cursor"] as? [String: Any])?["epoch"] as? String, "stream")
        transport.emit(Self.response(requestID: reattach.requestID, commandID: reattach.commandID, command: "session.attach", host: "host-a", session: "s1", result: ["attached": true]))
        await controller.disconnect()
        XCTAssertEqual(controller.state.selectedSessionID, "s1")
    }

    func testMismatchedCommandCorrelationLeavesRequestPending() async throws {
        let transport = TestTransport()
        let controller = T4ClientController(transport: transport)
        let connect = Task { await controller.connect() }
        try await transport.waitFor(type: "hello")
        transport.emit(Self.welcome(host: "host-a"))
        let list = try await transport.waitFor(command: "session.list")
        transport.emit(Self.response(requestID: list.requestID, commandID: list.commandID, command: "session.list", host: "host-a", result: ["sessions": []]))
        await connect.value
        let command = Task { try await controller.command("session.cancel", hostID: "host-a", sessionID: "s1") }
        let frame = try await transport.waitFor(command: "session.cancel")
        transport.emit(Self.response(requestID: frame.requestID, commandID: "wrong", command: "session.cancel", host: "host-a", session: "s1", result: [:]))
        transport.emit(Self.response(requestID: frame.requestID, commandID: frame.commandID, command: "session.cancel", host: "host-a", session: "s1", result: [:]))
        let response = try await command.value
        XCTAssertEqual(response.commandID, frame.commandID)
        await controller.disconnect()
    }

    private static func welcome(host: String) -> WireFrame {
        try! WireDecoder.decode(try! JSONSerialization.data(withJSONObject: ["v": "omp-app/1", "type": "welcome", "selectedProtocol": "omp-app/1", "hostId": host, "authentication": "local", "grantedCapabilities": [], "grantedFeatures": ["host.watch"], "negotiatedLimits": [:], "epoch": "host", "resumed": false]))
    }

    private static func response(requestID: String, commandID: String?, command: String, host: String, session: String? = nil, result: [String: Any]) -> WireFrame {
        var value: [String: Any] = ["v": "omp-app/1", "type": "response", "requestId": requestID, "commandId": commandID ?? "", "command": command, "hostId": host, "ok": true, "result": result]
        if let session { value["sessionId"] = session }
        return try! WireDecoder.decode(try! JSONSerialization.data(withJSONObject: value))
    }
}
private final class TestTransport: T4ClientTransport, @unchecked Sendable {
    var incoming: AsyncThrowingStream<WireFrame, Error>
    private var continuation: AsyncThrowingStream<WireFrame, Error>.Continuation
    private var recreateOnConnect = false
    private var streamFinished = false
    private var waitOffsets: [String: Int] = [:]
    private var typeWaiters: [String: [CheckedContinuation<Void, Error>]] = [:]
    private var commandWaiters: [String: [CheckedContinuation<SentCommand, Error>]] = [:]
    private(set) var sent: [WireFrame] = []
    private(set) var connected = false

    init() {
        let stream = Self.makeStream()
        incoming = stream.stream
        continuation = stream.continuation
    }

    func connect() async throws {
        if recreateOnConnect {
            let stream = Self.makeStream()
            incoming = stream.stream
            continuation = stream.continuation
            streamFinished = false
            recreateOnConnect = false
        }
        connected = true
    }

    func disconnect() async {
        connected = false
        recreateOnConnect = true
        failWaiters()
        finishCurrentStream(with: TestTransportError.disconnected)
    }

    func send(_ frame: WireFrame) async throws {
        guard connected else { throw TestTransportError.disconnected }
        let index = sent.endIndex
        sent.append(frame)
        let object = frame.raw.mapValues { $0.toFoundation() }
        fulfillTypeWaiter(for: frame.type, index: index)
        guard frame.type == "command", let command = object["command"] as? String else { return }
        guard var waiters = commandWaiters[command], !waiters.isEmpty else { return }
        let waiter = waiters.removeFirst()
        advanceOffset(for: "command:\(command)", past: index)
        if waiters.isEmpty {
            commandWaiters.removeValue(forKey: command)
        } else {
            commandWaiters[command] = waiters
        }
        waiter.resume(returning: Self.sentCommand(from: object))
    }

    func emit(_ frame: WireFrame) {
        _ = continuation.yield(frame)
    }

    func drop() {
        connected = false
        recreateOnConnect = true
        failWaiters()
        finishCurrentStream(with: T4ClientControllerError.transport("dropped"))
    }

    func waitFor(type: String) async throws {
        let key = "type:\(type)"
        let start = waitOffsets[key, default: 0]
        if let index = sent[start...].firstIndex(where: { $0.type == type }) {
            advanceOffset(for: key, past: index)
            return
        }
        try await withCheckedThrowingContinuation { continuation in
            typeWaiters[type, default: []].append(continuation)
        }
    }

    func waitFor(command: String) async throws -> SentCommand {
        let key = "command:\(command)"
        let start = waitOffsets[key, default: 0]
        if let index = sent[start...].firstIndex(where: { Self.command(in: $0) == command }) {
            advanceOffset(for: key, past: index)
            return Self.sentCommand(from: sent[index].raw.mapValues { $0.toFoundation() })
        }
        return try await withCheckedThrowingContinuation { continuation in
            commandWaiters[command, default: []].append(continuation)
        }
    }

    private func fulfillTypeWaiter(for type: String, index: Int) {
        guard var waiters = typeWaiters[type], !waiters.isEmpty else { return }
        let waiter = waiters.removeFirst()
        advanceOffset(for: "type:\(type)", past: index)
        if waiters.isEmpty {
            typeWaiters.removeValue(forKey: type)
        } else {
            typeWaiters[type] = waiters
        }
        waiter.resume()
    }

    private func failWaiters() {
        let typeWaiters = self.typeWaiters
        let commandWaiters = self.commandWaiters
        self.typeWaiters.removeAll()
        self.commandWaiters.removeAll()
        for waiters in typeWaiters.values {
            for waiter in waiters {
                waiter.resume(throwing: TestTransportError.disconnected)
            }
        }
        for waiters in commandWaiters.values {
            for waiter in waiters {
                waiter.resume(throwing: TestTransportError.disconnected)
            }
        }
    }

    private func advanceOffset(for key: String, past index: Int) {
        waitOffsets[key] = max(waitOffsets[key, default: 0], index + 1)
    }

    private func finishCurrentStream(with error: Error) {
        guard !streamFinished else { return }
        streamFinished = true
        continuation.finish(throwing: error)
    }

    private static func makeStream() -> (stream: AsyncThrowingStream<WireFrame, Error>, continuation: AsyncThrowingStream<WireFrame, Error>.Continuation) {
        var continuation: AsyncThrowingStream<WireFrame, Error>.Continuation!
        let stream = AsyncThrowingStream<WireFrame, Error> { continuation = $0 }
        return (stream, continuation)
    }

    private static func command(in frame: WireFrame) -> String? {
        guard frame.type == "command" else { return nil }
        return frame.raw["command"]?.stringValue
    }

    private static func sentCommand(from object: [String: Any]) -> SentCommand {
        SentCommand(
            requestID: object["requestId"] as? String ?? "",
            commandID: object["commandId"] as? String,
            args: object["args"] as? [String: Any] ?? [:]
        )
    }

    private enum TestTransportError: Error {
        case disconnected
    }

    struct SentCommand {
        let requestID: String
        let commandID: String?
        let args: [String: Any]
    }
}
