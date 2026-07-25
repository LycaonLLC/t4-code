import Foundation
import XCTest
@testable import T4Protocol

final class WireCodecTests: XCTestCase {
    private func fixture(_ object: [String: JSONValue]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object.mapValues { $0.toFoundation() }, options: [])
    }

    func testVersionBoundaryRejectsOtherProtocol() throws {
        let data = try fixture(["v": .string("omp-app/2"), "type": .string("event")])
        XCTAssertThrowsError(try WireDecoder.decode(data)) { error in
            let error = error as? WireFormatError
            XCTAssertEqual(error?.path, "v")
            XCTAssertEqual(error?.message, "protocol version must be exactly omp-app/1")
        }
    }

    func testAdditiveEventDataAndEnvelopeArePreserved() throws {
        let data = try fixture([
            "v": .string(WireLimits.protocolVersion), "type": .string("event"),
            "hostId": .string("host"), "sessionId": .string("session"),
            "cursor": .object(["epoch": .string("e"), "seq": .number(2)]),
            "event": .object(["type": .string("future.message"), "futureData": .object(["enabled": .bool(true), "labels": .array([.string("kept")])])]),
            "futureEnvelopeData": .object(["generation": .number(2)]),
        ])
        guard case let .event(frame) = try WireDecoder.decode(data) else {
            return XCTFail("expected event")
        }
        XCTAssertEqual(frame.event["futureData"], .object(["enabled": .bool(true), "labels": .array([.string("kept")])]))
        XCTAssertEqual(frame.raw["futureEnvelopeData"], .object(["generation": .number(2)]))
    }

    func testStrictLimitsRejectOversizedInputAndDeepValues() throws {
        XCTAssertThrowsError(try WireDecoder.decode(Data(repeating: 0x20, count: WireLimits.maxFrameBytes + 1)))
        let nested = String(repeating: "[", count: WireLimits.maxDepth + 2) + "0" + String(repeating: "]", count: WireLimits.maxDepth + 2)
        XCTAssertThrowsError(try WireDecoder.decode(Data(nested.utf8)))
    }

    func testCursorsHaveDistinctTypes() throws {
        let transcript = TranscriptCursor(epoch: "t", seq: 1)
        let index = SessionIndexCursor(epoch: "i", seq: 1)
        XCTAssertNotEqual(String(describing: type(of: transcript)), String(describing: type(of: index)))
    }

    func testEncoderProducesPinnedCommandAndPingFrames() throws {
        let command = try WireEncoder.list(requestId: "r", commandId: "c", hostId: "h")
        guard case let .command(frame) = try WireDecoder.decode(command) else { return XCTFail("expected command") }
        XCTAssertEqual(frame.command, "session.list")
        let ping = try WireEncoder.ping(nonce: "n", timestamp: "now")
        guard case let .ping(frame) = try WireDecoder.decode(ping) else { return XCTFail("expected ping") }
        XCTAssertEqual(frame.nonce, "n")
    }
}
