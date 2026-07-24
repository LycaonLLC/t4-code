import Foundation
import Observation
@_exported import T4Protocol

public struct T4CommandResponse: Sendable, Equatable {
    public let requestID: String
    public let commandID: String?
    public let command: String?
    public let hostID: String
    public let sessionID: String?
    public let result: [String: JSONValue]?
    public let errorCode: String?
    public let errorMessage: String?

    public var isSuccess: Bool { errorCode == nil }

    public init(requestID: String, commandID: String? = nil, command: String? = nil, hostID: String, sessionID: String? = nil, result: [String: JSONValue]? = nil, errorCode: String? = nil, errorMessage: String? = nil) {
        self.requestID = requestID
        self.commandID = commandID
        self.command = command
        self.hostID = hostID
        self.sessionID = sessionID
        self.result = result
        self.errorCode = errorCode
        self.errorMessage = errorMessage
    }
}

public struct T4ReconnectPolicy: Sendable, Equatable {
    public var baseDelay: Duration
    public var maximumDelay: Duration
    public var maximumAttempts: Int?

    public init(baseDelay: Duration = .milliseconds(250), maximumDelay: Duration = .seconds(8), maximumAttempts: Int? = nil) {
        self.baseDelay = baseDelay
        self.maximumDelay = maximumDelay
        self.maximumAttempts = maximumAttempts
    }
}

public enum T4ClientControllerError: Error, Sendable, Equatable {
    case disconnected
    case staleGeneration
    case invalidFrame
    case remote(code: String, message: String)
    case transport(String)
}

/// Main-actor supervisor for the native app. The controller owns no durable
/// data: state can be discarded on disconnect while selected profile/session
/// identity and cursors are retained for reconnect recovery.
@Observable
@MainActor
public final class T4ClientController {
    public let state: AppState
    public let transport: any T4ClientTransport
    public private(set) var hostID: String?
    public private(set) var generation: UInt64 = 0

    private let reconnectPolicy: T4ReconnectPolicy
    private var listenTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var connectTask: Task<Void, Never>?
    private var userDisconnected = false
    private var reconnectAttempt = 0
    private var pending: [String: PendingRequest] = [:]
    private var commandIDs: [String: String] = [:]
    private var welcomeWaiter: WelcomeWaiter?
    private var grantedFeatures: Set<String> = []

    private struct PendingRequest {
        let requestID: String
        let commandID: String?
        let generation: UInt64
        let continuation: CheckedContinuation<T4CommandResponse, Error>
    }

    private struct WelcomeWaiter {
        let generation: UInt64
        let continuation: CheckedContinuation<String, Error>
    }

    public init(transport: any T4ClientTransport, state: AppState = AppState(), reconnectPolicy: T4ReconnectPolicy = T4ReconnectPolicy()) {
        self.transport = transport
        self.state = state
        self.reconnectPolicy = reconnectPolicy
    }


    public func connect() async {
        if let existing = connectTask {
            existing.cancel()
            await transport.disconnect()
            await existing.value
            connectTask = nil
        }
        userDisconnected = false
        reconnectTask?.cancel()
        reconnectTask = nil
        reconnectAttempt = 0
        let currentGeneration = nextGeneration()
        state.connection = .connecting
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performConnect(generation: currentGeneration)
        }
        connectTask = task
        await withTaskCancellationHandler(operation: {
            await task.value
        }, onCancel: {
            task.cancel()
        })
    }

    private func performConnect(generation currentGeneration: UInt64) async {
        defer {
            if generation == currentGeneration {
                connectTask = nil
            }
        }
        do {
            try Task.checkCancellation()
            try await transport.connect()
            try Task.checkCancellation()
            guard currentGeneration == generation, !userDisconnected else { return }
            startListening(for: currentGeneration)
            _ = try await negotiateWelcome(generation: currentGeneration)
            try await bootstrap(generation: currentGeneration)
        } catch {
            guard currentGeneration == generation, !userDisconnected else { return }
            if error is CancellationError { return }
            failWelcomeWaiter(for: currentGeneration, with: error)
            failPending(for: currentGeneration, with: error)
            state.connection = .failed
            state.errorMessage = message(for: error)
            scheduleReconnect()
        }
    }

    public func disconnect() async {
        userDisconnected = true
        let reconnect = reconnectTask
        reconnectTask?.cancel()
        reconnectTask = nil
        let listener = listenTask
        listenTask?.cancel()
        listenTask = nil
        let connector = connectTask
        connectTask?.cancel()
        connectTask = nil
        failWelcomeWaiter(with: T4ClientControllerError.disconnected)
        _ = nextGeneration()
        failPending(with: T4ClientControllerError.disconnected)
        await transport.disconnect()
        await reconnect?.value
        await connector?.value
        await listener?.value
        state.resetConnection(retainSelection: true)
    }


    public func selectProfile(_ profileID: String?) {
        selectedProfileID = profileID
        for index in state.profiles.indices {
            state.profiles[index].isSelected = state.profiles[index].id == profileID
        }
    }

    public func selectSession(_ sessionID: String?) async {
        selectedSessionID = sessionID
        for index in state.sessions.indices {
            state.sessions[index].isSelected = state.sessions[index].id == sessionID
        }
        state.transcript.removeAll(keepingCapacity: true)
        state.transcriptCursor = nil
        guard let sessionID, let hostID, state.connection == .connected else { return }
        do {
            _ = try await command("session.attach", hostID: hostID, sessionID: sessionID, args: attachArguments())
        } catch {
            state.errorMessage = message(for: error)
        }
    }

    @discardableResult
    public func prompt(_ text: String) async throws -> T4CommandResponse {
        guard let sessionID = selectedSessionID else { throw T4ClientControllerError.disconnected }
        state.composer.isSending = true
        defer { state.composer.isSending = false }
        do {
            let response = try await command("session.prompt", sessionID: sessionID, args: ["message": .string(text)])
            state.composer.text = ""
            state.composer.error = nil
            return response
        } catch {
            state.composer.error = message(for: error)
            throw error
        }
    }

    @discardableResult
    public func queue(_ text: String) async throws -> T4CommandResponse {
        guard let sessionID = selectedSessionID else { throw T4ClientControllerError.disconnected }
        let response = try await command("session.queue", sessionID: sessionID, args: ["message": .string(text)])
        state.composer.queuedCount += 1
        return response
    }
    @discardableResult
    public func cancel(commandID: String? = nil) async throws -> T4CommandResponse {
        guard let sessionID = selectedSessionID else { throw T4ClientControllerError.disconnected }
        var args: [String: JSONValue] = [:]
        if let commandID { args["commandId"] = .string(commandID) }
        return try await command("session.cancel", sessionID: sessionID, args: args)
    }

    @discardableResult
    public func command(_ name: String, hostID explicitHostID: String? = nil, sessionID explicitSessionID: String? = nil, expectedRevision: String? = nil, args: [String: JSONValue] = [:]) async throws -> T4CommandResponse {
        guard state.connection == .connected, let hostID = explicitHostID ?? hostID else { throw T4ClientControllerError.disconnected }
        let sessionID = explicitSessionID
        let requestID = UUID().uuidString.lowercased()
        let commandID = UUID().uuidString.lowercased()
        var object: [String: JSONValue] = [
            "v": .string(WireLimits.protocolVersion), "type": .string("command"), "requestId": .string(requestID),
            "commandId": .string(commandID), "hostId": .string(hostID), "command": .string(name), "args": .object(args)
        ]
        if let sessionID { object["sessionId"] = .string(sessionID) }
        if let expectedRevision { object["expectedRevision"] = .string(expectedRevision) }
        let frame = try WireDecoder.decode(try JSONValue.object(object).encodedData())
        let currentGeneration = generation
        let response = try await withCheckedThrowingContinuation { continuation in
            pending[requestID] = PendingRequest(requestID: requestID, commandID: commandID, generation: currentGeneration, continuation: continuation)
            commandIDs[requestID] = commandID
            Task { @MainActor [weak self] in
                guard let self else { return }
                do { try await self.transport.send(frame) }
                catch {
                    guard let pending = self.pending.removeValue(forKey: requestID) else { return }
                    self.commandIDs.removeValue(forKey: requestID)
                    pending.continuation.resume(throwing: T4ClientControllerError.transport(self.message(for: error)))
                }
            }
        }
        guard currentGeneration == generation else { throw T4ClientControllerError.staleGeneration }
        return response
    }

    /// Convenience spelling for mutations that must carry an optimistic
    /// revision. It does not retry stale revisions or unknown outcomes.
    @discardableResult
    public func revisionedCommand(_ name: String, expectedRevision: String, args: [String: JSONValue] = [:]) async throws -> T4CommandResponse {
        try await command(name, sessionID: selectedSessionID, expectedRevision: expectedRevision, args: args)
    }

    private var selectedProfileID: String? {
        get { state.selectedProfileID }
        set { selectProfileWithoutSideEffects(newValue: newValue) }
    }

    private var selectedSessionID: String? {
        get { state.selectedSessionID }
        set { state.selectedSessionID = newValue }
    }

    private func selectProfileWithoutSideEffects(newValue: String?) {
        state.selectedProfileID = newValue
    }

    private func nextGeneration() -> UInt64 {
        failWelcomeWaiter(with: T4ClientControllerError.staleGeneration)
        failPending(with: T4ClientControllerError.staleGeneration)
        generation &+= 1
        _ = state.beginGeneration()
        return generation
    }

    private func startListening(for currentGeneration: UInt64) {
        listenTask?.cancel()
        listenTask = Task { @MainActor [weak self, transport] in
            defer {
                if let self, self.generation == currentGeneration {
                    self.listenTask = nil
                }
            }
            do {
                for try await frame in transport.incoming {
                    guard let self, self.generation == currentGeneration, !self.userDisconnected else { return }
                    self.handle(frame, generation: currentGeneration)
                }
                guard let self, self.generation == currentGeneration, !self.userDisconnected else { return }
                let error = T4ClientControllerError.transport("Transport closed.")
                self.failWelcomeWaiter(for: currentGeneration, with: error)
                self.failPending(for: currentGeneration, with: error)
                self.scheduleReconnect()
            } catch {
                guard let self, self.generation == currentGeneration, !self.userDisconnected else { return }
                if error is CancellationError { return }
                let transportError = T4ClientControllerError.transport(self.message(for: error))
                self.failWelcomeWaiter(for: currentGeneration, with: transportError)
                self.failPending(for: currentGeneration, with: transportError)
                self.state.connection = .reconnecting
                self.scheduleReconnect()
            }
        }
    }


    private func sendHello(generation currentGeneration: UInt64) async throws {
        var saved: [SavedCursor] = []
        if let hostID, let sessionID = selectedSessionID, let cursor = state.transcriptCursor {
            saved.append(SavedCursor(hostId: hostID, sessionId: sessionID, cursor: cursor))
        }
        let client = ClientIdentity(name: "t4-apple", version: "1", build: "native", platform: "apple")
        guard generation == currentGeneration else { throw T4ClientControllerError.staleGeneration }
        let data = try WireEncoder.hello(client: client, requestedFeatures: ["resume", "host.watch", "session.watch"], savedCursors: saved)
        try await transport.send(try WireDecoder.decode(data))
    }

    private func negotiateWelcome(generation currentGeneration: UInt64) async throws -> String {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                guard generation == currentGeneration, !userDisconnected else {
                    continuation.resume(throwing: userDisconnected ? T4ClientControllerError.disconnected : T4ClientControllerError.staleGeneration)
                    return
                }
                welcomeWaiter = WelcomeWaiter(generation: currentGeneration, continuation: continuation)
                Task { @MainActor in
                    do {
                        try await self.sendHello(generation: currentGeneration)
                    } catch {
                        self.failWelcomeWaiter(for: currentGeneration, with: error)
                    }
                }
            }
        }, onCancel: {
            Task { @MainActor [weak self] in
                self?.failWelcomeWaiter(for: currentGeneration, with: CancellationError())
            }
        })
    }

    private func bootstrap(generation currentGeneration: UInt64) async throws {
        guard generation == currentGeneration else { throw T4ClientControllerError.staleGeneration }
        guard let hostID else { throw T4ClientControllerError.disconnected }
        let list = try await command("session.list", hostID: hostID, sessionID: nil, args: [:])
        guard generation == currentGeneration else { throw T4ClientControllerError.staleGeneration }
        applySessionList(list.result)
        if grantedFeatures.contains("host.watch"), let cursor = state.sessionIndexCursor {
            _ = try await command("host.watch", hostID: hostID, sessionID: nil, args: ["cursor": cursorJSON(cursor)])
        }
        guard generation == currentGeneration else { throw T4ClientControllerError.staleGeneration }
        if let selectedSessionID {
            _ = try await command("session.attach", hostID: hostID, sessionID: selectedSessionID, args: attachArguments())
        }
    }

    private func attachArguments() -> [String: JSONValue] {
        guard let cursor = state.transcriptCursor else { return [:] }
        return ["cursor": cursorJSON(cursor)]
    }

    private func scheduleReconnect() {
        guard !userDisconnected, reconnectTask == nil else { return }
        if let maximumAttempts = reconnectPolicy.maximumAttempts, reconnectAttempt >= maximumAttempts {
            state.connection = .failed
            return
        }
        state.connection = .reconnecting
        let attempt = reconnectAttempt
        reconnectAttempt += 1
        let delay = reconnectDelay(attempt: attempt)
        reconnectTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard let self, !self.userDisconnected else { return }
            self.reconnectTask = nil
            await self.connect()
        }
    }

    private func reconnectDelay(attempt: Int) -> Duration {
        var delay = reconnectPolicy.baseDelay
        if attempt > 0 {
            for _ in 0..<min(attempt, 20) { delay = minDuration(delay + delay, reconnectPolicy.maximumDelay) }
        }
        return minDuration(delay, reconnectPolicy.maximumDelay)
    }

    private func minDuration(_ lhs: Duration, _ rhs: Duration) -> Duration { lhs < rhs ? lhs : rhs }

    private func handle(_ frame: WireFrame, generation currentGeneration: UInt64) {
        guard currentGeneration == generation else { return }
        switch frame {
        case let .welcome(welcome):
            guard welcomeWaiter?.generation == currentGeneration else { return }
            hostID = welcome.hostId
            state.authentication = T4AuthenticationState(rawValue: welcome.authentication.camelized) ?? .unknown
            grantedFeatures = Set(welcome.grantedFeatures)
            state.connection = .connected
            resumeWelcomeWaiter(hostID: welcome.hostId, generation: currentGeneration)
        case let .response(response):
            handleResponse(response, generation: currentGeneration)
        case let .sessions(sessions):
            applySessions(sessions.raw.mapValues { $0.toFoundation() })
        case let .snapshot(snapshot):
            applySnapshot(snapshot.raw.mapValues { $0.toFoundation() })
        case let .entry(entry):
            applyEntry(entry.raw.mapValues { $0.toFoundation() })
        case let .event(event):
            applyEvent(event.event.mapValues { $0.toFoundation() }, cursor: event.cursor)
        case let .confirmation(confirmation):
            applyAttention(confirmation.raw.mapValues { $0.toFoundation() })
        case let .additive(additive) where additive.type == "settings":
            applySettings(additive.raw.mapValues { $0.toFoundation() })
        case let .error(error):
            if let requestID = error.requestId {
                settleError(error, requestID: requestID)
            } else {
                failWelcomeWaiter(for: currentGeneration, with: T4ClientControllerError.remote(code: error.code, message: error.message))
            }
        default:
            break
        }
    }

    private func handleResponse(_ frame: ResponseFrame, generation currentGeneration: UInt64) {
        guard let pendingRequest = pending[frame.requestId], pendingRequest.generation == currentGeneration else { return }
        if let expectedCommandID = pendingRequest.commandID {
            guard let actual = frame.commandId, expectedCommandID == actual else { return }
        }
        pending.removeValue(forKey: frame.requestId)
        commandIDs.removeValue(forKey: frame.requestId)
        let host = frame.hostId ?? hostID ?? ""
        if frame.ok {
            let result = frame.result?.objectValue
            let response = T4CommandResponse(
                requestID: frame.requestId,
                commandID: frame.commandId,
                command: frame.command,
                hostID: host,
                sessionID: frame.sessionId,
                result: result
            )
            pendingRequest.continuation.resume(returning: response)
            return
        }
        let code = frame.error?["code"]?.stringValue ?? "remote_error"
        let message = frame.error?["message"]?.stringValue ?? "The host rejected the command."
        pendingRequest.continuation.resume(throwing: T4ClientControllerError.remote(code: code, message: message))
    }

    private func settleError(_ frame: ErrorFrame, requestID: String) {
        guard let pendingRequest = pending.removeValue(forKey: requestID) else { return }
        commandIDs.removeValue(forKey: requestID)
        pendingRequest.continuation.resume(throwing: T4ClientControllerError.remote(code: frame.code, message: frame.message))
    }

    private func failWelcomeWaiter(with error: Error) {
        guard let waiter = welcomeWaiter else { return }
        welcomeWaiter = nil
        waiter.continuation.resume(throwing: error)
    }

    private func failWelcomeWaiter(for currentGeneration: UInt64, with error: Error) {
        guard welcomeWaiter?.generation == currentGeneration else { return }
        failWelcomeWaiter(with: error)
    }

    private func resumeWelcomeWaiter(hostID: String, generation currentGeneration: UInt64) {
        guard let waiter = welcomeWaiter, waiter.generation == currentGeneration else { return }
        welcomeWaiter = nil
        waiter.continuation.resume(returning: hostID)
    }

    private func failPending(with error: Error) {
        let requests = pending.values
        pending.removeAll(keepingCapacity: true)
        commandIDs.removeAll(keepingCapacity: true)
        for request in requests { request.continuation.resume(throwing: error) }
    }

    private func failPending(for currentGeneration: UInt64, with error: Error) {
        let requests = pending.values.filter { $0.generation == currentGeneration }
        for request in requests {
            pending.removeValue(forKey: request.requestID)
            commandIDs.removeValue(forKey: request.requestID)
            request.continuation.resume(throwing: error)
        }
    }
    


    private func applySessionList(_ result: [String: JSONValue]?) {
        guard let result else { return }
        let object = result.compactMapValues(AnyJSONValue.value)
        applySessions(object)
        if let cursor = makeSessionIndexCursor(object["cursor"]) { state.sessionIndexCursor = cursor }
    }

    private func applySessions(_ object: [String: Any]) {
        guard let values = object["sessions"] as? [[String: Any]] else { return }
        state.sessions = values.compactMap { value in
            guard let id = (value["sessionId"] ?? value["id"]) as? String else { return nil }
            let host = value["hostId"] as? String ?? hostID ?? ""
            return T4Session(id: id, hostID: host, title: value["title"] as? String ?? value["name"] as? String ?? "", status: value["status"] as? String ?? "", isSelected: id == state.selectedSessionID)
        }
    }

    private func applySnapshot(_ object: [String: Any]) {
        guard let entries = object["entries"] as? [[String: Any]] else { return }
        state.transcript = entries.compactMap(makeTranscriptItem)
        state.transcriptCursor = makeTranscriptCursor(object["cursor"])
    }

    private func applyEntry(_ object: [String: Any]) {
        guard let item = makeTranscriptItem(object["entry"] as? [String: Any] ?? object) else { return }
        if !state.transcript.contains(where: { $0.id == item.id }) { state.transcript.append(item) }
        state.transcriptCursor = makeTranscriptCursor(object["cursor"]) ?? state.transcriptCursor
    }

    private func applyEvent(_ object: [String: Any], cursor: TranscriptCursor? = nil) {
        let id = object["eventId"] as? String ?? object["id"] as? String ?? UUID().uuidString
        let text = object["message"] as? String ?? object["text"] as? String ?? ""
        guard !text.isEmpty else { return }
        let itemCursor = cursor ?? makeTranscriptCursor(object["cursor"])
        state.transcript.append(T4TranscriptItem(id: id, role: object["role"] as? String ?? object["author"] as? String ?? "event", text: text, cursor: itemCursor))
        state.transcriptCursor = itemCursor ?? state.transcriptCursor
    }

    private func makeTranscriptItem(_ object: [String: Any]?) -> T4TranscriptItem? {
        guard let object, let id = (object["id"] ?? object["entryId"]) as? String else { return nil }
        let text = object["text"] as? String ?? object["message"] as? String ?? ""
        return T4TranscriptItem(id: id, role: object["role"] as? String ?? object["author"] as? String ?? "assistant", text: text, cursor: makeTranscriptCursor(object["cursor"]), revision: object["revision"] as? String)
    }

    private func applyAttention(_ object: [String: Any]) {
        guard let id = (object["requestId"] ?? object["confirmationId"] ?? object["id"]) as? String else { return }
        state.attention.removeAll { $0.id == id }
        state.attention.append(T4AttentionItem(id: id, kind: object["kind"] as? String ?? "confirmation", title: object["title"] as? String ?? "Action required", detail: object["summary"] as? String ?? object["message"] as? String ?? "", commandID: object["commandId"] as? String))
    }

    private func applySettings(_ object: [String: Any]) {
        let values = (object["values"] as? [String: Any] ?? object["settings"] as? [String: Any] ?? [:]).compactMapValues { value in
            if let string = value as? String { return string }
            if let bool = value as? Bool { return bool ? "true" : "false" }
            if let number = value as? NSNumber { return number.stringValue }
            return nil
        }
        state.settings = T4SettingsState(values: values)
    }

    private func makeTranscriptCursor(_ value: Any?) -> TranscriptCursor? {
        guard let object = value as? [String: Any], let epoch = object["epoch"] as? String, let seq = integer(object["seq"]) else { return nil }
        return TranscriptCursor(epoch: epoch, seq: seq)
    }

    private func makeSessionIndexCursor(_ value: Any?) -> SessionIndexCursor? {
        guard let object = value as? [String: Any], let epoch = object["epoch"] as? String, let seq = integer(object["seq"]) else { return nil }
        return SessionIndexCursor(epoch: epoch, seq: seq)
    }

    private func integer(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        guard let value = value as? Double, value.isFinite, value.rounded() == value,
              value >= Double(Int.min), value <= Double(Int.max) else { return nil }
        return Int(value)
    }

    private func cursorJSON<C: Sendable>(_ cursor: C) -> JSONValue {
        if let transcript = cursor as? TranscriptCursor { return .object(["epoch": .string(transcript.epoch), "seq": .number(Double(transcript.seq))]) }
        if let index = cursor as? SessionIndexCursor { return .object(["epoch": .string(index.epoch), "seq": .number(Double(index.seq))]) }
        return .null
    }

    private func message(for error: Error) -> String { String(describing: error) }
}

private enum AnyJSONValue {
    static func value(_ value: JSONValue) -> Any? {
        switch value {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value): return value
        case .string(let value): return value
        case .array(let values): return values.compactMap { Self.value($0) }
        case .object(let values): return values.compactMapValues { Self.value($0) }
        }
    }
}


private extension String {
    var camelized: String {
        switch self {
        case "pairing-required": return "pairingRequired"
        default: return self
        }
    }
}
