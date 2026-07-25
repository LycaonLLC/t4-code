import Foundation

public enum WireLimits {
    public static let protocolVersion = "omp-app/1"
    public static let maxFrameBytes = 4 * 1024 * 1024
    public static let maxDepth = 32
    public static let maxNodes = 20_000
    public static let maxMapKeys = 512
    public static let maxArrayItems = 1_000
    public static let maxSafeInteger = 9_007_199_254_740_991.0
    public static let maxSavedCursors = 128
    public static let maxStringBytes = 65_536
    public static let maxIdBytes = 256
    public static let maxTerminalBytes = 256_000
}

public struct WireFormatError: Error, Sendable, Equatable, CustomStringConvertible {
    public let message: String
    public let path: String?

    public init(_ message: String, path: String? = nil) {
        self.message = message
        self.path = path
    }

    public var description: String {
        if let path { return "WireFormatError at \(path): \(message)" }
        return "WireFormatError: \(message)"
    }
}
public typealias WireCodecError = WireFormatError
public typealias WireFormatException = WireFormatError

public struct TranscriptCursor: Sendable, Equatable, Hashable {
    public let epoch: String
    public let seq: Int
    public init(epoch: String, seq: Int) { self.epoch = epoch; self.seq = seq }
}

public struct SessionIndexCursor: Sendable, Equatable, Hashable {
    public let epoch: String
    public let seq: Int
    public init(epoch: String, seq: Int) { self.epoch = epoch; self.seq = seq }
}

public struct SavedCursor: Sendable, Equatable {
    public let hostId: String
    public let sessionId: String
    public let cursor: TranscriptCursor
    public init(hostId: String, sessionId: String, cursor: TranscriptCursor) {
        self.hostId = hostId; self.sessionId = sessionId; self.cursor = cursor
    }
}

public struct ClientIdentity: Sendable, Equatable {
    public let name: String
    public let version: String
    public let build: String
    public let platform: String
    public init(name: String, version: String, build: String, platform: String) {
        self.name = name; self.version = version; self.build = build; self.platform = platform
    }
}

public struct DeviceAuthentication: Sendable, Equatable {
    public let deviceId: String
    public let deviceToken: String
    public init(deviceId: String, deviceToken: String) {
        self.deviceId = deviceId; self.deviceToken = deviceToken
    }
}

public struct HelloFrame: Sendable, Equatable {
    public let raw: [String: JSONValue]
    public init(raw: [String: JSONValue]) { self.raw = raw }
}

public struct CommandFrame: Sendable, Equatable {
    public let requestId: String
    public let commandId: String
    public let hostId: String
    public let sessionId: String?
    public let command: String
    public let expectedRevision: String?
    public let confirmationId: String?
    public let args: JSONValue
    public let raw: [String: JSONValue]
    public init(requestId: String, commandId: String, hostId: String, sessionId: String? = nil,
                command: String, expectedRevision: String? = nil, confirmationId: String? = nil,
                args: JSONValue = .object([:]), raw: [String: JSONValue] = [:]) {
        self.requestId = requestId; self.commandId = commandId; self.hostId = hostId
        self.sessionId = sessionId; self.command = command; self.expectedRevision = expectedRevision
        self.confirmationId = confirmationId; self.args = args; self.raw = raw
    }
}

public struct ConfirmFrame: Sendable, Equatable {
    public let requestId: String; public let confirmationId: String; public let commandId: String
    public let hostId: String; public let sessionId: String?; public let decision: String
    public let raw: [String: JSONValue]
    public init(requestId: String, confirmationId: String, commandId: String, hostId: String,
                decision: String, sessionId: String? = nil, raw: [String: JSONValue] = [:]) {
        self.requestId = requestId; self.confirmationId = confirmationId; self.commandId = commandId
        self.hostId = hostId; self.decision = decision; self.sessionId = sessionId; self.raw = raw
    }
}

public struct PairStartFrame: Sendable, Equatable {
    public let requestId: String; public let code: String; public let deviceId: String
    public let deviceName: String; public let platform: String; public let requestedCapabilities: [String]
    public let raw: [String: JSONValue]
    public init(requestId: String, code: String, deviceId: String, deviceName: String,
                platform: String, requestedCapabilities: [String] = [], raw: [String: JSONValue] = [:]) {
        self.requestId = requestId; self.code = code; self.deviceId = deviceId; self.deviceName = deviceName
        self.platform = platform; self.requestedCapabilities = requestedCapabilities; self.raw = raw
    }
}

public struct TerminalInputFrame: Sendable, Equatable {
    public let hostId: String; public let sessionId: String; public let terminalId: String
    public let data: String; public let encoding: String?; public let raw: [String: JSONValue]
    public init(hostId: String, sessionId: String, terminalId: String, data: String,
                encoding: String? = nil, raw: [String: JSONValue] = [:]) {
        self.hostId = hostId; self.sessionId = sessionId; self.terminalId = terminalId
        self.data = data; self.encoding = encoding; self.raw = raw
    }
}

public struct TerminalResizeFrame: Sendable, Equatable {
    public let hostId: String; public let sessionId: String; public let terminalId: String
    public let cols: Int; public let rows: Int; public let raw: [String: JSONValue]
    public init(hostId: String, sessionId: String, terminalId: String, cols: Int, rows: Int,
                raw: [String: JSONValue] = [:]) {
        self.hostId = hostId; self.sessionId = sessionId; self.terminalId = terminalId
        self.cols = cols; self.rows = rows; self.raw = raw
    }
}

public struct TerminalCloseFrame: Sendable, Equatable {
    public let hostId: String; public let sessionId: String; public let terminalId: String
    public let reason: String?; public let raw: [String: JSONValue]
    public init(hostId: String, sessionId: String, terminalId: String, reason: String? = nil,
                raw: [String: JSONValue] = [:]) {
        self.hostId = hostId; self.sessionId = sessionId; self.terminalId = terminalId
        self.reason = reason; self.raw = raw
    }
}

public struct PingFrame: Sendable, Equatable {
    public let nonce: String; public let timestamp: String; public let raw: [String: JSONValue]
    public init(nonce: String, timestamp: String, raw: [String: JSONValue] = [:]) {
        self.nonce = nonce; self.timestamp = timestamp; self.raw = raw
    }
}

public struct WelcomeFrame: Sendable, Equatable {
    public let hostId: String; public let selectedProtocol: String; public let epoch: String
    public let authentication: String; public let resumed: Bool
    public let grantedCapabilities: [String]; public let grantedFeatures: [String]
    public let negotiatedLimits: [String: JSONValue]; public let raw: [String: JSONValue]
    public init(hostId: String, selectedProtocol: String, epoch: String, authentication: String, resumed: Bool, grantedCapabilities: [String], grantedFeatures: [String], negotiatedLimits: [String: JSONValue], raw: [String: JSONValue]) {
        self.hostId = hostId; self.selectedProtocol = selectedProtocol; self.epoch = epoch; self.authentication = authentication; self.resumed = resumed
        self.grantedCapabilities = grantedCapabilities; self.grantedFeatures = grantedFeatures; self.negotiatedLimits = negotiatedLimits; self.raw = raw
    }
}

public struct SessionReference: Sendable, Equatable {
    public let hostId: String; public let sessionId: String; public let title: String
    public let revision: String; public let status: String; public let updatedAt: String
    public let project: [String: JSONValue]; public let raw: [String: JSONValue]
    public init(hostId: String, sessionId: String, title: String, revision: String, status: String, updatedAt: String, project: [String: JSONValue], raw: [String: JSONValue]) {
        self.hostId = hostId; self.sessionId = sessionId; self.title = title; self.revision = revision; self.status = status; self.updatedAt = updatedAt; self.project = project; self.raw = raw
    }
}

public struct SessionsFrame: Sendable, Equatable {
    public let hostId: String?; public let cursor: SessionIndexCursor; public let sessions: [SessionReference]
    public let totalCount: Int; public let truncated: Bool; public let raw: [String: JSONValue]
    public init(hostId: String?, cursor: SessionIndexCursor, sessions: [SessionReference], totalCount: Int, truncated: Bool, raw: [String: JSONValue]) {
        self.hostId = hostId; self.cursor = cursor; self.sessions = sessions; self.totalCount = totalCount; self.truncated = truncated; self.raw = raw
    }
}

public struct SnapshotFrame: Sendable, Equatable {
    public let hostId: String; public let sessionId: String; public let cursor: TranscriptCursor
    public let revision: String; public let entries: [[String: JSONValue]]; public let raw: [String: JSONValue]
    public init(hostId: String, sessionId: String, cursor: TranscriptCursor, revision: String, entries: [[String: JSONValue]], raw: [String: JSONValue]) {
        self.hostId = hostId; self.sessionId = sessionId; self.cursor = cursor; self.revision = revision; self.entries = entries; self.raw = raw
    }
}

public struct EntryFrame: Sendable, Equatable {
    public let hostId: String; public let sessionId: String; public let cursor: TranscriptCursor
    public let revision: String; public let entry: [String: JSONValue]; public let raw: [String: JSONValue]
    public init(hostId: String, sessionId: String, cursor: TranscriptCursor, revision: String, entry: [String: JSONValue], raw: [String: JSONValue]) {
        self.hostId = hostId; self.sessionId = sessionId; self.cursor = cursor; self.revision = revision; self.entry = entry; self.raw = raw
    }
}

public struct EventFrame: Sendable, Equatable {
    public let hostId: String; public let sessionId: String; public let cursor: TranscriptCursor
    /// Complete event payload, including fields unknown to this client version.
    public let event: [String: JSONValue]; public let raw: [String: JSONValue]
    public init(hostId: String, sessionId: String, cursor: TranscriptCursor, event: [String: JSONValue], raw: [String: JSONValue]) {
        self.hostId = hostId; self.sessionId = sessionId; self.cursor = cursor; self.event = event; self.raw = raw
    }
}
public struct ResponseFrame: Sendable, Equatable {
    public let requestId: String; public let commandId: String?; public let hostId: String?
    public let sessionId: String?; public let command: String?; public let ok: Bool
    public let result: JSONValue?; public let error: [String: JSONValue]?; public let raw: [String: JSONValue]
    public init(requestId: String, commandId: String?, hostId: String?, sessionId: String?, command: String?, ok: Bool, result: JSONValue?, error: [String: JSONValue]?, raw: [String: JSONValue]) {
        self.requestId = requestId; self.commandId = commandId; self.hostId = hostId; self.sessionId = sessionId; self.command = command; self.ok = ok; self.result = result; self.error = error; self.raw = raw
    }
}
public struct ErrorFrame: Sendable, Equatable {
    public let code: String; public let message: String; public let requestId: String?
    public let raw: [String: JSONValue]
    public init(code: String, message: String, requestId: String?, raw: [String: JSONValue]) {
        self.code = code; self.message = message; self.requestId = requestId; self.raw = raw
    }
}

public struct PongFrame: Sendable, Equatable {
    public let nonce: String; public let timestamp: String?; public let raw: [String: JSONValue]
    public init(nonce: String, timestamp: String?, raw: [String: JSONValue]) {
        self.nonce = nonce; self.timestamp = timestamp; self.raw = raw
    }
}

public struct GapFrame: Sendable, Equatable {
    public let hostId: String; public let sessionId: String; public let from: TranscriptCursor
    public let to: TranscriptCursor?; public let reason: String?; public let raw: [String: JSONValue]
    public init(hostId: String, sessionId: String, from: TranscriptCursor, to: TranscriptCursor?, reason: String?, raw: [String: JSONValue]) {
        self.hostId = hostId; self.sessionId = sessionId; self.from = from; self.to = to; self.reason = reason; self.raw = raw
    }
}

public struct ConfirmationFrame: Sendable, Equatable {
    public let confirmationId: String; public let raw: [String: JSONValue]
    public init(confirmationId: String, raw: [String: JSONValue]) { self.confirmationId = confirmationId; self.raw = raw }
}

public struct PairOKFrame: Sendable, Equatable {
    public let pairingId: String; public let raw: [String: JSONValue]
    public init(pairingId: String, raw: [String: JSONValue]) { self.pairingId = pairingId; self.raw = raw }
}

public struct PairErrorFrame: Sendable, Equatable {
    public let message: String; public let raw: [String: JSONValue]
    public init(message: String, raw: [String: JSONValue]) { self.message = message; self.raw = raw }
}

/// A known additive server family whose detailed schema is intentionally
/// carried losslessly until a later protocol revision models it.
public struct AdditiveServerFrame: Sendable, Equatable {
    public let type: String; public let raw: [String: JSONValue]
    public init(type: String, raw: [String: JSONValue]) { self.type = type; self.raw = raw }
}

public enum WireFrame: Sendable, Equatable {
    case hello(HelloFrame)
    case command(CommandFrame)
    case confirm(ConfirmFrame)
    case pairStart(PairStartFrame)
    case terminalInput(TerminalInputFrame)
    case terminalResize(TerminalResizeFrame)
    case terminalClose(TerminalCloseFrame)
    case ping(PingFrame)
    case welcome(WelcomeFrame)
    case sessions(SessionsFrame)
    case snapshot(SnapshotFrame)
    case entry(EntryFrame)
    case event(EventFrame)
    case response(ResponseFrame)
    case error(ErrorFrame)
    case pong(PongFrame)
    case gap(GapFrame)
    case confirmation(ConfirmationFrame)
    case pairOK(PairOKFrame)
    case pairError(PairErrorFrame)
    case additive(AdditiveServerFrame)

    public var type: String {
        switch self {
        case .hello: "hello"; case .command: "command"; case .confirm: "confirm"
        case .pairStart: "pair.start"; case .terminalInput: "terminal.input"
        case .terminalResize: "terminal.resize"; case .terminalClose: "terminal.close"
        case .ping: "ping"; case .welcome: "welcome"; case .sessions: "sessions"
        case .snapshot: "snapshot"; case .entry: "entry"; case .event: "event"
        case .response: "response"; case .error: "error"; case .pong: "pong"
        case .gap: "gap"; case .confirmation: "confirmation"; case .pairOK: "pair.ok"
        case .pairError: "pair.error"; case let .additive(frame): frame.type
        }
    }

    public var raw: [String: JSONValue] {
        switch self {
        case let .hello(frame): frame.raw; case let .command(frame): frame.raw; case let .confirm(frame): frame.raw
        case let .pairStart(frame): frame.raw; case let .terminalInput(frame): frame.raw
        case let .terminalResize(frame): frame.raw; case let .terminalClose(frame): frame.raw
        case let .ping(frame): frame.raw; case let .welcome(frame): frame.raw; case let .sessions(frame): frame.raw
        case let .snapshot(frame): frame.raw; case let .entry(frame): frame.raw; case let .event(frame): frame.raw
        case let .response(frame): frame.raw; case let .error(frame): frame.raw; case let .pong(frame): frame.raw
        case let .gap(frame): frame.raw; case let .confirmation(frame): frame.raw; case let .pairOK(frame): frame.raw
        case let .pairError(frame): frame.raw; case let .additive(frame): frame.raw
        }
    }
}
