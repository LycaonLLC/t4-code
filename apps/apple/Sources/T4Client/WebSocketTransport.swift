import Foundation
import T4Protocol
/// A transport frame is kept as UTF-8 JSON bytes at the client boundary. This
/// keeps the transport independent from UI isolation and lets tests inject a
/// deterministic stream without opening a socket.
public struct TransportMessage: Sendable, Equatable {
    public let data: Data

    public init(data: Data) { self.data = data }
}

public protocol T4ClientTransport: Sendable {
    var incoming: AsyncThrowingStream<WireFrame, Error> { get }
    func connect() async throws
    func send(_ frame: WireFrame) async throws
    func disconnect() async
}

public enum WebSocketTransportError: Error, Sendable, Equatable {
    case alreadyConnected
    case notConnected
    case unsupportedMessage
    case invalidText
    case closed
}

private final class IncomingStreamBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stream: AsyncThrowingStream<WireFrame, Error>
    private var continuation: AsyncThrowingStream<WireFrame, Error>.Continuation

    init() {
        var continuation: AsyncThrowingStream<WireFrame, Error>.Continuation!
        stream = AsyncThrowingStream { continuation = $0 }
        self.continuation = continuation
    }

    var current: AsyncThrowingStream<WireFrame, Error> {
        lock.lock()
        defer { lock.unlock() }
        return stream
    }

    func replace() {
        let oldContinuation: AsyncThrowingStream<WireFrame, Error>.Continuation
        lock.lock()
        oldContinuation = continuation
        var nextContinuation: AsyncThrowingStream<WireFrame, Error>.Continuation!
        stream = AsyncThrowingStream { nextContinuation = $0 }
        continuation = nextContinuation
        lock.unlock()
        oldContinuation.finish(throwing: WebSocketTransportError.closed)
    }

    func yield(_ frame: WireFrame) {
        lock.lock()
        let continuation = self.continuation
        lock.unlock()
        continuation.yield(frame)
    }

    func finish(throwing error: Error? = nil) {
        lock.lock()
        let continuation = self.continuation
        lock.unlock()
        if let error {
            continuation.finish(throwing: error)
        } else {
            continuation.finish()
        }
    }
}

/// Actor-isolated URLSession WebSocket implementation. A receive loop is
/// associated with a monotonically increasing generation, so callbacks from a
/// task that was replaced by reconnect cannot publish old frames.
public actor WebSocketTransport: T4ClientTransport {
    public nonisolated var incoming: AsyncThrowingStream<WireFrame, Error> { streamBox.current }
    private nonisolated let streamBox: IncomingStreamBox
    private let url: URL
    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var generation: UInt64 = 0
    private var closedByUser = false

    public init(url: URL, session: URLSession = .shared) {
        self.url = url
        self.session = session
        self.streamBox = IncomingStreamBox()
    }


    public func connect() async throws {
        guard task == nil else { throw WebSocketTransportError.alreadyConnected }
        closedByUser = false
        streamBox.replace()
        generation &+= 1
        let currentGeneration = generation
        let socket = session.webSocketTask(with: url)
        task = socket
        socket.resume()
        receive(on: socket, generation: currentGeneration)
    }

    public func send(_ frame: WireFrame) async throws {
        guard let task else { throw WebSocketTransportError.notConnected }
        let data = try WireCodec.encode(frame)
        guard let text = String(data: data, encoding: .utf8) else { throw WebSocketTransportError.invalidText }
        try await task.send(.string(text))
    }

    public func disconnect() async {
        closedByUser = true
        generation &+= 1
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        streamBox.finish()
    }

    private func receive(on socket: URLSessionWebSocketTask, generation currentGeneration: UInt64) {
        socket.receive { [weak self] result in
            guard let self else { return }
            Task { await self.received(result, from: socket, generation: currentGeneration) }
        }
    }

    private func received(_ result: Result<URLSessionWebSocketTask.Message, Error>, from socket: URLSessionWebSocketTask, generation currentGeneration: UInt64) {
        guard currentGeneration == generation, task === socket, !closedByUser else { return }
        switch result {
        case .success(let message):
            switch message {
            case .string(let text):
                guard let data = text.data(using: .utf8) else {
                    streamBox.finish(throwing: WebSocketTransportError.invalidText)
                    task = nil
                    return
                }
                do { streamBox.yield(try WireDecoder.decode(data)) }
                catch { streamBox.finish(throwing: error); task = nil; return }
            case .data(let data):
                do { streamBox.yield(try WireDecoder.decode(data)) }
                catch { streamBox.finish(throwing: error); task = nil; return }
            @unknown default:
                streamBox.finish(throwing: WebSocketTransportError.unsupportedMessage)
                task = nil
                return
            }
            receive(on: socket, generation: currentGeneration)
        case .failure(let error):
            task = nil
            if !closedByUser { streamBox.finish(throwing: error) }
        }
    }
}
