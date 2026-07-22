import Foundation
import CryptoKit
import T4Protocol
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Errors raised by the native AF_UNIX WebSocket transport.
public enum UnixWebSocketTransportError: Error, Sendable, Equatable, CustomStringConvertible {
    case invalidSocketPath(String)
    case connectionFailed(Int32)
    case alreadyConnected
    case notConnected
    case handshakeTimeout
    case invalidHandshake(String)
    case protocolViolation(String)
    case messageTooLarge
    case invalidText
    case closed

    public var description: String {
        switch self {
        case .invalidSocketPath(let reason): return "invalid Unix socket path: \(reason)"
        case .connectionFailed(let code): return "Unix socket connection failed (errno \(code))"
        case .alreadyConnected: return "already connected"
        case .notConnected: return "not connected"
        case .handshakeTimeout: return "WebSocket handshake timed out"
        case .invalidHandshake(let reason): return "invalid WebSocket handshake: \(reason)"
        case .protocolViolation(let reason): return "WebSocket protocol violation: \(reason)"
        case .messageTooLarge: return "WebSocket message exceeds 1 MiB"
        case .invalidText: return "invalid UTF-8 WebSocket text"
        case .closed: return "WebSocket is closed"
        }
    }
}

private final class UnixIncomingStreamBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stream: AsyncThrowingStream<WireFrame, Error>
    private var continuation: AsyncThrowingStream<WireFrame, Error>.Continuation

    init() {
        var continuation: AsyncThrowingStream<WireFrame, Error>.Continuation!
        stream = AsyncThrowingStream { continuation = $0 }
        self.continuation = continuation
    }

    var current: AsyncThrowingStream<WireFrame, Error> {
        lock.lock(); defer { lock.unlock() }
        return stream
    }

    func replace() {
        lock.lock()
        let old = continuation
        var next: AsyncThrowingStream<WireFrame, Error>.Continuation!
        stream = AsyncThrowingStream { next = $0 }
        continuation = next
        lock.unlock()
        old.finish(throwing: UnixWebSocketTransportError.closed)
    }

    func yield(_ frame: WireFrame) {
        lock.lock(); let continuation = self.continuation; lock.unlock()
        continuation.yield(frame)
    }

    func finish(throwing error: Error? = nil) {
        lock.lock(); let continuation = self.continuation; lock.unlock()
        if let error { continuation.finish(throwing: error) } else { continuation.finish() }
    }
}

private final class UnixSocket: @unchecked Sendable {
    let fd: Int32
    private let lock = NSLock()
    private var didClose = false

    init(fd: Int32) { self.fd = fd }

    func close() {
        lock.lock()
        guard !didClose else { lock.unlock(); return }
        didClose = true
        lock.unlock()
        _ = shutdown(fd, Int32(SHUT_RDWR))
        _ = Darwin.close(fd)
    }

    func writeAll(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !didClose else { throw UnixWebSocketTransportError.closed }
        try data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            var sent = 0
            while sent < rawBuffer.count {
                let result = Darwin.send(fd, base.advanced(by: sent), rawBuffer.count - sent, 0)
                if result > 0 { sent += result; continue }
                if result < 0 && errno == EINTR { continue }
                throw UnixWebSocketTransportError.connectionFailed(errno)
            }
        }
    }
}

private enum UnixSocketEvent: Sendable {
    case frame(opcode: UInt8, fin: Bool, payload: Data)
    case closed
}

/// A concurrency-safe RFC 6455 client connected to T4's local Unix-domain
/// WebSocket endpoint. The public path initializer accepts only absolute,
/// NUL-free, sockaddr-compatible paths; tests and embedders may inject an
/// already-connected descriptor with `init(fileDescriptor:)`.
public actor UnixWebSocketTransport: T4ClientTransport {
    public static let maximumMessageBytes = 1 * 1024 * 1024
    public static let handshakeTimeout: Duration = .seconds(10)

    public static var defaultSocketPath: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".omp/run/appserver.sock").path
    }

    public nonisolated var incoming: AsyncThrowingStream<WireFrame, Error> { streamBox.current }
    private nonisolated let streamBox: UnixIncomingStreamBox
    private let socketPath: String?
    private let keyProvider: @Sendable () -> Data
    private var injectedFileDescriptor: Int32?
    private var socket: UnixSocket?
    private var receiveTask: Task<Void, Never>?
    private var generation: UInt64 = 0
    private var fragmentOpcode: UInt8?
    private var fragmentData = Data()

    /// Connect to a validated filesystem Unix socket path.
    public init(socketPath: String = UnixWebSocketTransport.defaultSocketPath,
                keyProvider: @escaping @Sendable () -> Data = UnixWebSocketTransport.randomKey) throws {
        try Self.validate(socketPath: socketPath)
        self.socketPath = socketPath
        self.keyProvider = keyProvider
        self.injectedFileDescriptor = nil
        self.streamBox = UnixIncomingStreamBox()
    }

    /// Inject an already-connected descriptor (normally one end of a
    /// `socketpair`) while retaining the normal WebSocket handshake.
    public init(fileDescriptor: Int32,
                keyProvider: @escaping @Sendable () -> Data = UnixWebSocketTransport.randomKey) {
        self.socketPath = nil
        self.keyProvider = keyProvider
        self.injectedFileDescriptor = fileDescriptor
        self.streamBox = UnixIncomingStreamBox()
    }

    public nonisolated static func randomKey() -> Data {
        Data((0..<16).map { _ in UInt8.random(in: UInt8.min...UInt8.max) })
    }

    public func connect() async throws {
        guard socket == nil else { throw UnixWebSocketTransportError.alreadyConnected }
        generation &+= 1
        let currentGeneration = generation
        fragmentOpcode = nil
        fragmentData.removeAll(keepingCapacity: false)
        streamBox.replace()

        let fd: Int32
        if let injected = injectedFileDescriptor {
            injectedFileDescriptor = nil
            fd = injected
        } else if let socketPath {
            fd = try await Task.detached(priority: .userInitiated) {
                try Self.openUnixSocket(path: socketPath)
            }.value
        } else {
            throw UnixWebSocketTransportError.invalidSocketPath("missing socket path")
        }

        let socket = UnixSocket(fd: fd)
        self.socket = socket
        do {
            let key = keyProvider()
            guard key.count == 16 else {
                throw UnixWebSocketTransportError.invalidHandshake("Sec-WebSocket-Key must be 16 bytes")
            }
            try await Task.detached(priority: .userInitiated) {
                try Self.performHandshake(socket: socket, key: key)
            }.value
            guard currentGeneration == generation, self.socket === socket else {
                socket.close()
                throw UnixWebSocketTransportError.closed
            }
            receiveTask = Task.detached(priority: .userInitiated) { [weak self, socket] in
                do {
                    while true {
                        let event = try Self.readEvent(socket: socket)
                        guard let self else { return }
                        await self.handle(event, socket: socket, generation: currentGeneration)
                        if case .closed = event { return }
                    }
                } catch {
                    guard let self else { return }
                    await self.receiveFailed(error, socket: socket, generation: currentGeneration)
                }
            }
        } catch {
            if self.socket === socket { self.socket = nil }
            socket.close()
            streamBox.finish(throwing: error)
            throw error
        }
    }

    public func send(_ frame: WireFrame) async throws {
        let data = try WireCodec.encode(frame)
        guard String(data: data, encoding: .utf8) != nil else {
            throw UnixWebSocketTransportError.invalidText
        }
        try sendPayload(data, opcode: 0x1)
    }

    /// Sends an arbitrary WebSocket data message. `send(_:)` remains the
    /// protocol-facing text path used by the client controller.
    public func send(data: Data, binary: Bool = false) async throws {
        try sendPayload(data, opcode: binary ? 0x2 : 0x1)
    }

    public func disconnect() async {
        generation &+= 1
        let socket = self.socket
        self.socket = nil
        receiveTask?.cancel()
        receiveTask = nil
        fragmentOpcode = nil
        fragmentData.removeAll(keepingCapacity: false)
        if let socket {
            do { try socket.writeAll(Self.makeFrame(payload: Data([0x03, 0xE8]), opcode: 0x8)) } catch { }
            socket.close()
        }
        streamBox.finish()
    }

    private func sendPayload(_ payload: Data, opcode: UInt8) throws {
        guard let socket else { throw UnixWebSocketTransportError.notConnected }
        try socket.writeAll(Self.makeFrame(payload: payload, opcode: opcode))
    }

    private func handle(_ event: UnixSocketEvent, socket: UnixSocket, generation currentGeneration: UInt64) {
        guard currentGeneration == generation, self.socket === socket else { return }
        switch event {
        case .closed:
            receiveFailed(UnixWebSocketTransportError.closed, socket: socket, generation: currentGeneration)
        case .frame(let opcode, let fin, let payload):
            do {
                switch opcode {
                case 0x0:
                    guard let firstOpcode = fragmentOpcode else {
                        throw UnixWebSocketTransportError.protocolViolation("unexpected continuation")
                    }
                    guard fragmentData.count + payload.count <= Self.maximumMessageBytes else {
                        throw UnixWebSocketTransportError.messageTooLarge
                    }
                    fragmentData.append(payload)
                    if fin {
                        let completed = fragmentData
                        fragmentOpcode = nil
                        fragmentData.removeAll(keepingCapacity: false)
                        try publish(completed, opcode: firstOpcode)
                    }
                case 0x1, 0x2:
                    guard fragmentOpcode == nil else {
                        throw UnixWebSocketTransportError.protocolViolation("new data frame while fragmented message is open")
                    }
                    if fin {
                        try publish(payload, opcode: opcode)
                    } else {
                        guard payload.count <= Self.maximumMessageBytes else {
                            throw UnixWebSocketTransportError.messageTooLarge
                        }
                        fragmentOpcode = opcode
                        fragmentData = payload
                    }
                case 0x8:
                    guard fin, payload.count != 1 else {
                        throw UnixWebSocketTransportError.protocolViolation("invalid close frame")
                    }
                    try? socket.writeAll(Self.makeFrame(payload: payload, opcode: 0x8))
                    closeAfterPeer(socket: socket, generation: currentGeneration)
                case 0x9:
                    guard fin, payload.count <= 125 else {
                        throw UnixWebSocketTransportError.protocolViolation("invalid ping frame")
                    }
                    try socket.writeAll(Self.makeFrame(payload: payload, opcode: 0xA))
                case 0xA:
                    guard fin, payload.count <= 125 else {
                        throw UnixWebSocketTransportError.protocolViolation("invalid pong frame")
                    }
                default:
                    throw UnixWebSocketTransportError.protocolViolation("unsupported opcode")
                }
            } catch {
                closeAfterError(error, socket: socket, generation: currentGeneration)
            }
        }
    }

    private func publish(_ payload: Data, opcode: UInt8) throws {
        guard payload.count <= Self.maximumMessageBytes else {
            throw UnixWebSocketTransportError.messageTooLarge
        }
        if opcode == 0x1, String(data: payload, encoding: .utf8) == nil {
            throw UnixWebSocketTransportError.invalidText
        }
        do {
            streamBox.yield(try WireDecoder.decode(payload))
        } catch {
            throw error
        }
    }

    private func receiveFailed(_ error: Error, socket: UnixSocket, generation currentGeneration: UInt64) {
        guard currentGeneration == generation, self.socket === socket else { return }
        self.socket = nil
        receiveTask = nil
        socket.close()
        streamBox.finish(throwing: error)
    }

    private func closeAfterPeer(socket: UnixSocket, generation currentGeneration: UInt64) {
        guard currentGeneration == generation, self.socket === socket else { return }
        generation &+= 1
        self.socket = nil
        receiveTask = nil
        fragmentOpcode = nil
        fragmentData.removeAll(keepingCapacity: false)
        socket.close()
        streamBox.finish()
    }

    private func closeAfterError(_ error: Error, socket: UnixSocket, generation currentGeneration: UInt64) {
        guard currentGeneration == generation, self.socket === socket else { return }
        generation &+= 1
        self.socket = nil
        receiveTask = nil
        socket.close()
        streamBox.finish(throwing: error)
    }
}

private extension UnixWebSocketTransport {
    nonisolated static func validate(socketPath: String) throws {
        let bytes = Array(socketPath.utf8)
        guard !bytes.isEmpty else { throw UnixWebSocketTransportError.invalidSocketPath("path is empty") }
        guard !bytes.contains(0) else { throw UnixWebSocketTransportError.invalidSocketPath("path contains NUL") }
        guard socketPath.first == "/" else { throw UnixWebSocketTransportError.invalidSocketPath("path must be absolute") }
        guard !socketPath.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." }) else {
            throw UnixWebSocketTransportError.invalidSocketPath("path traversal is not allowed")
        }
        let capacity = MemoryLayout<sockaddr_un>.size - MemoryLayout<sa_family_t>.size
        guard bytes.count + 1 <= capacity else {
            throw UnixWebSocketTransportError.invalidSocketPath("path exceeds sockaddr_un capacity")
        }
    }

    nonisolated static func openUnixSocket(path: String) throws -> Int32 {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw UnixWebSocketTransportError.connectionFailed(errno) }
        do {
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let pathBytes = Array(path.utf8) + [0]
            withUnsafeMutableBytes(of: &address.sun_path) { raw in
                raw.copyBytes(from: pathBytes)
            }
            let pathOffset = MemoryLayout<sockaddr_un>.offset(of: \.sun_path)!
            let length = socklen_t(pathOffset + pathBytes.count)
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(fd, $0, length)
                }
            }
            guard result == 0 else { throw UnixWebSocketTransportError.connectionFailed(errno) }
            return fd
        } catch {
            _ = Darwin.close(fd)
            throw error
        }
    }

    nonisolated static func performHandshake(socket: UnixSocket, key: Data) throws {
        let keyString = key.base64EncodedString()
        let request = "GET /ws HTTP/1.1\r\nHost: omp.local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: \(keyString)\r\n\r\n"
        try socket.writeAll(Data(request.utf8))
        var response = Data()
        let deadline = ContinuousClock.now.advanced(by: UnixWebSocketTransport.handshakeTimeout)
        while !(response.count >= 4 && response.suffix(4).elementsEqual([13, 10, 13, 10])) {
            if ContinuousClock.now >= deadline { throw UnixWebSocketTransportError.handshakeTimeout }
            var descriptor = pollfd(fd: socket.fd, events: Int16(POLLIN), revents: 0)
            let polled = poll(&descriptor, 1, 1_000)
            if polled == 0 { continue }
            if polled < 0 { if errno == EINTR { continue }; throw UnixWebSocketTransportError.connectionFailed(errno) }
            var byte: UInt8 = 0
            let count = Darwin.recv(socket.fd, &byte, 1, 0)
            if count == 1 { response.append(byte); if response.count > 16 * 1024 { throw UnixWebSocketTransportError.invalidHandshake("response headers too large") } }
            else if count == 0 { throw UnixWebSocketTransportError.closed }
            else if errno != EINTR { throw UnixWebSocketTransportError.connectionFailed(errno) }
        }
        guard let text = String(data: response, encoding: .utf8) else {
            throw UnixWebSocketTransportError.invalidHandshake("response is not UTF-8")
        }
        let lines = text.components(separatedBy: "\r\n")
        guard let status = lines.first?.split(separator: " "), status.count >= 2, status[0] == "HTTP/1.1", status[1] == "101" else {
            throw UnixWebSocketTransportError.invalidHandshake("expected HTTP/1.1 101")
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard !line.isEmpty else { continue }
            guard let separator = line.firstIndex(of: ":") else {
                throw UnixWebSocketTransportError.invalidHandshake("malformed header")
            }
            let name = String(line[..<separator]).trimmingCharacters(in: .whitespaces).lowercased()
            let value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { throw UnixWebSocketTransportError.invalidHandshake("empty header name") }
            headers[name] = value
        }
        guard headers["upgrade"]?.lowercased() == "websocket" else {
            throw UnixWebSocketTransportError.invalidHandshake("missing Upgrade: websocket")
        }
        guard headers["connection"]?.split(separator: ",").contains(where: { $0.trimmingCharacters(in: .whitespaces).lowercased() == "upgrade" }) == true else {
            throw UnixWebSocketTransportError.invalidHandshake("missing Connection: Upgrade")
        }
        let expected = Data(Insecure.SHA1.hash(data: Data((keyString + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
        guard headers["sec-websocket-accept"] == expected else {
            throw UnixWebSocketTransportError.invalidHandshake("Sec-WebSocket-Accept mismatch")
        }
    }

    nonisolated static func readEvent(socket: UnixSocket) throws -> UnixSocketEvent {
        let header = try readBytes(socket: socket, count: 2)
        let first = header[0]
        let second = header[1]
        guard first & 0x70 == 0 else { throw UnixWebSocketTransportError.protocolViolation("reserved bits are set") }
        let fin = first & 0x80 != 0
        let opcode = first & 0x0F
        let masked = second & 0x80 != 0
        guard !masked else { throw UnixWebSocketTransportError.protocolViolation("server frame is masked") }
        let indicator = second & 0x7F
        var length = UInt64(indicator)
        if indicator == 126 {
            let bytes = try readBytes(socket: socket, count: 2)
            length = UInt64(bytes[0]) << 8 | UInt64(bytes[1])
        } else if indicator == 127 {
            let bytes = try readBytes(socket: socket, count: 8)
            guard bytes[0] & 0x80 == 0 else { throw UnixWebSocketTransportError.protocolViolation("invalid 64-bit length") }
            length = bytes.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        }
        if opcode >= 0x8 {
            guard fin, length <= 125 else { throw UnixWebSocketTransportError.protocolViolation("invalid control frame") }
        } else if length > UInt64(UnixWebSocketTransport.maximumMessageBytes) {
            throw UnixWebSocketTransportError.messageTooLarge
        }
        guard length <= UInt64(Int.max) else { throw UnixWebSocketTransportError.messageTooLarge }
        let payload = try readBytes(socket: socket, count: Int(length))
        return .frame(opcode: opcode, fin: fin, payload: payload)
    }

    nonisolated static func readBytes(socket: UnixSocket, count: Int) throws -> Data {
        var result = Data(capacity: count)
        var remaining = count
        while remaining > 0 {
            var buffer = [UInt8](repeating: 0, count: min(remaining, 64 * 1024))
            let received = Darwin.recv(socket.fd, &buffer, buffer.count, 0)
            if received > 0 {
                result.append(contentsOf: buffer[0..<received])
                remaining -= received
            } else if received == 0 {
                throw UnixWebSocketTransportError.closed
            } else if errno != EINTR {
                throw UnixWebSocketTransportError.connectionFailed(errno)
            }
        }
        return result
    }

    nonisolated static func makeFrame(payload: Data, opcode: UInt8) -> Data {
        var frame = Data()
        frame.reserveCapacity(payload.count + 14)
        frame.append(UInt8(0x80) | opcode)
        if payload.count <= 125 {
            frame.append(UInt8(0x80) | UInt8(payload.count))
        } else if payload.count <= 65_535 {
            frame.append(UInt8(0x80 | 126))
            frame.append(UInt8((payload.count >> 8) & 0xFF))
            frame.append(UInt8(payload.count & 0xFF))
        } else {
            frame.append(UInt8(0x80 | 127))
            let value = UInt64(payload.count)
            for shift in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((value >> UInt64(shift)) & 0xFF))
            }
        }
        let mask = [UInt8](randomKey().prefix(4))
        frame.append(contentsOf: mask)
        frame.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset & 3] })
        return frame
    }
}
