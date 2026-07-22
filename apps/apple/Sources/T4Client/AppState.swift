import Foundation
import Observation
import T4Protocol

/// Connection lifecycle exposed to native surfaces.
public enum T4ConnectionState: String, Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case failed
}

public enum T4AuthenticationState: String, Sendable, Equatable {
    case unknown
    case local
    case pairingRequired
    case paired
    case failed
}

public struct T4Profile: Identifiable, Sendable, Equatable {
    public let id: String
    public var label: String
    public var targetID: String
    public var isEnabled: Bool
    public var isSelected: Bool

    public init(id: String, label: String, targetID: String = "local", isEnabled: Bool = true, isSelected: Bool = false) {
        self.id = id
        self.label = label
        self.targetID = targetID
        self.isEnabled = isEnabled
        self.isSelected = isSelected
    }
}

public struct T4Session: Identifiable, Sendable, Equatable {
    public let id: String
    public var hostID: String
    public var title: String
    public var status: String
    public var updatedAt: Date?
    public var isSelected: Bool

    public init(id: String, hostID: String, title: String = "", status: String = "", updatedAt: Date? = nil, isSelected: Bool = false) {
        self.id = id
        self.hostID = hostID
        self.title = title
        self.status = status
        self.updatedAt = updatedAt
        self.isSelected = isSelected
    }
}

public struct T4TranscriptItem: Identifiable, Sendable, Equatable {
    public let id: String
    public var role: String
    public var text: String
    public var cursor: TranscriptCursor?
    public var revision: String?

    public init(id: String, role: String, text: String, cursor: TranscriptCursor? = nil, revision: String? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.cursor = cursor
        self.revision = revision
    }
}

public struct T4AttentionItem: Identifiable, Sendable, Equatable {
    public let id: String
    public var kind: String
    public var title: String
    public var detail: String
    public var commandID: String?

    public init(id: String, kind: String, title: String, detail: String = "", commandID: String? = nil) {
        self.id = id
        self.kind = kind
        self.title = title
        self.detail = detail
        self.commandID = commandID
    }
}

public struct T4ComposerState: Sendable, Equatable {
    public var text = ""
    public var isSending = false
    public var queuedCount = 0
    public var error: String?

    public init() {}
}

public struct T4DeveloperState: Sendable, Equatable {
    public var isEnabled = false
    public var lastRequestID: String?
    public var lastCommandID: String?
    public var messages: [String] = []

    public init() {}
}

public struct T4SettingsState: Sendable, Equatable {
    public var values: [String: String] = [:]

    public init(values: [String: String] = [:]) {
        self.values = values
    }
}

/// The disposable native projection. It intentionally keeps host-index and live
/// transcript cursors separate: they have independent ordering domains.
@Observable @MainActor
public final class AppState {
    public var connection: T4ConnectionState = .disconnected
    public var authentication: T4AuthenticationState = .unknown
    public var profiles: [T4Profile] = []
    public var selectedProfileID: String?
    public var sessions: [T4Session] = []
    public var selectedSessionID: String?
    public var transcript: [T4TranscriptItem] = []
    public var transcriptCursor: TranscriptCursor?
    public var sessionIndexCursor: SessionIndexCursor?
    public var composer = T4ComposerState()
    public var attention: [T4AttentionItem] = []
    public var developer = T4DeveloperState()
    public var settings = T4SettingsState()
    public var errorMessage: String?
    public private(set) var generation: UInt64 = 0

    public init() {}

    func beginGeneration() -> UInt64 {
        generation &+= 1
        return generation
    }

    func resetConnection(retainSelection: Bool = true) {
        connection = .disconnected
        authentication = .unknown
        errorMessage = nil
        composer.isSending = false
        if !retainSelection {
            sessions.removeAll(keepingCapacity: true)
            transcript.removeAll(keepingCapacity: true)
            transcriptCursor = nil
            sessionIndexCursor = nil
            composer.queuedCount = 0
            attention.removeAll(keepingCapacity: true)
        }
        if !retainSelection {
            selectedProfileID = nil
            selectedSessionID = nil
            profiles = profiles.map { T4Profile(id: $0.id, label: $0.label, targetID: $0.targetID, isEnabled: $0.isEnabled) }
        }
    }
}
