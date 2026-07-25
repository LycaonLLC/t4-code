import Foundation
import XCTest
import CryptoKit
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif
@testable import T4Client
@testable import T4Protocol

final class UnixWebSocketTransportTests: XCTestCase {
    func testHandshakeUsesPinnedEndpointAndMasksOutboundText() async throws {
        let (client, server) = try makeSocketPair()
        defer { close(server) }
        let transport = UnixWebSocketTransport(fileDescriptor: client, keyProvider: { Data(repeating: 7, count: 16) })
        let serverTask = Task.detached { () throws -> RawWebSocketFrame in
            try completeHandshake(server)
            return try readRawFrame(server)
        }
        try await transport.connect()
        try await transport.send(data: Data("hello".utf8))
        let frame = try await serverTask.value
        XCTAssertEqual(frame.opcode, 1)
        XCTAssertTrue(frame.masked)
        XCTAssertEqual(frame.payload, Data("hello".utf8))
        await transport.disconnect()
    }

    func testFragmentationPingPongAndClose() async throws {
        let (client, server) = try makeSocketPair()
        defer { close(server) }
        let transport = UnixWebSocketTransport(fileDescriptor: client, keyProvider: { Data(repeating: 2, count: 16) })
        let handshake = Task.detached { () throws -> Void in try completeHandshake(server) }
        try await transport.connect()
        try await handshake.value
        let incoming = transport.incoming
        let payload = try WireEncoder.ping(nonce: "n", timestamp: "t")
        let split = payload.count / 2
        try writeAll(server, serverFrame(fin: false, opcode: 1, payload: Data(payload.prefix(split))))
        try writeAll(server, serverFrame(fin: true, opcode: 0, payload: Data(payload.dropFirst(split))))
        let received = try await Task.detached { () throws -> WireFrame in
            for try await frame in incoming { return frame }
            throw UnixWebSocketTransportError.closed
        }.value
        guard case .ping(let ping) = received else { return XCTFail("expected ping") }
        XCTAssertEqual(ping.nonce, "n")
        try writeAll(server, serverFrame(fin: true, opcode: 9, payload: Data("x".utf8)))
        let pong = try readRawFrame(server)
        XCTAssertEqual(pong.opcode, 10)
        XCTAssertEqual(pong.payload, Data("x".utf8))
        try writeAll(server, serverFrame(fin: true, opcode: 8, payload: Data([0x03, 0xE8])))
        await transport.disconnect()
    }

    func testInboundMessagesAreBoundedToOneMiB() async throws {
        let (client, server) = try makeSocketPair()
        defer { close(server) }
        let transport = UnixWebSocketTransport(fileDescriptor: client, keyProvider: { Data(repeating: 3, count: 16) })
        let handshake = Task.detached { () throws -> Void in try completeHandshake(server) }
        try await transport.connect()
        try await handshake.value
        let incoming = transport.incoming
        let oversized = Data([0x82, 0x7F, 0, 0, 0, 0, 0, 0x10, 0, 0x01])
        try writeAll(server, oversized)
        do {
            for try await _ in incoming { }
            XCTFail("expected oversized frame to terminate stream")
        } catch let error as UnixWebSocketTransportError {
            XCTAssertEqual(error, .messageTooLarge)
        }
        await transport.disconnect()
    }

    func testRejectsUnsafePathAndMalformedAccept() async throws {
        XCTAssertThrowsError(try UnixWebSocketTransport(socketPath: "relative.sock"))
        XCTAssertThrowsError(try UnixWebSocketTransport(socketPath: "/tmp/../socket"))
        let (client, server) = try makeSocketPair()
        defer { close(server) }
        let transport = UnixWebSocketTransport(fileDescriptor: client, keyProvider: { Data(repeating: 1, count: 16) })
        let serverTask = Task.detached {
            _ = try? readUntil(server, marker: Data([13, 10, 13, 10]))
            try? writeAll(server, Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n".utf8))
        }
        do {
            try await transport.connect()
            XCTFail("expected malformed accept to fail")
        } catch let error as UnixWebSocketTransportError {
            XCTAssertEqual(error, .invalidHandshake("Sec-WebSocket-Accept mismatch"))
        }
        await serverTask.value
    }
}

private struct RawWebSocketFrame: Sendable {
    let opcode: UInt8
    let masked: Bool
    let payload: Data
}

private func makeSocketPair() throws -> (Int32, Int32) {
    var fds: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else {
        throw UnixWebSocketTransportError.connectionFailed(errno)
    }
    return (fds[0], fds[1])
}

private func completeHandshake(_ fd: Int32) throws {
    let request = try readUntil(fd, marker: Data([13, 10, 13, 10]))
    let text = String(decoding: request, as: UTF8.self)
    guard let line = text.components(separatedBy: "\r\n").first(where: { $0.hasPrefix("Sec-WebSocket-Key:") }) else {
        throw UnixWebSocketTransportError.invalidHandshake("test request did not include key")
    }
    let key = String(line.split(separator: ":", maxSplits: 1)[1]).trimmingCharacters(in: .whitespaces)
    let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
    try writeAll(fd, Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8))
}

private func readUntil(_ fd: Int32, marker: Data) throws -> Data {
    var data = Data()
    while data.range(of: marker) == nil {
        var byte: UInt8 = 0
        let count = recv(fd, &byte, 1, 0)
        guard count == 1 else { throw UnixWebSocketTransportError.closed }
        data.append(byte)
    }
    return data
}

private func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var offset = 0
        while offset < raw.count {
            let count = send(fd, base.advanced(by: offset), raw.count - offset, 0)
            guard count > 0 else { throw UnixWebSocketTransportError.closed }
            offset += count
        }
    }
}

private func readRawFrame(_ fd: Int32) throws -> RawWebSocketFrame {
    let first = try readExactly(fd, 1)[0]
    let second = try readExactly(fd, 1)[0]
    let masked = second & 0x80 != 0
    var length = Int(second & 0x7F)
    if length == 126 { length = try readExactly(fd, 2).reduce(0) { ($0 << 8) | Int($1) } }
    if length == 127 { throw UnixWebSocketTransportError.messageTooLarge }
    let mask = masked ? try readExactly(fd, 4) : Data()
    var payload = try readExactly(fd, length)
    if masked {
        payload = Data(payload.enumerated().map { $0.element ^ mask[$0.offset & 3] })
    }
    return RawWebSocketFrame(opcode: first & 0x0F, masked: masked, payload: payload)
}

private func serverFrame(fin: Bool, opcode: UInt8, payload: Data) -> Data {
    Data([fin ? (UInt8(0x80) | opcode) : opcode, UInt8(payload.count)]) + payload
}

private func readExactly(_ fd: Int32, _ count: Int) throws -> Data {
    var data = Data()
    while data.count < count {
        var bytes = [UInt8](repeating: 0, count: count - data.count)
        let received = recv(fd, &bytes, bytes.count, 0)
        guard received > 0 else { throw UnixWebSocketTransportError.closed }
        data.append(contentsOf: bytes[0..<received])
    }
    return data
}
