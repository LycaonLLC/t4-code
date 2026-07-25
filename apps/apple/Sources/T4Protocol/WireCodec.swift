import Foundation

public enum WireDecoder {
    public static func decode(_ data: Data) throws -> WireFrame {
        guard data.count <= WireLimits.maxFrameBytes else {
            throw WireFormatError("inbound frame exceeds the 4 MiB UTF-8 limit")
        }
        guard String(data: data, encoding: .utf8) != nil else {
            throw WireFormatError("inbound frame is not valid UTF-8")
        }
        do {
            let value = try JSONValue.parseBounded(data)
            return try decode(value)
        } catch let error as WireFormatError { throw error }
        catch let error as JSONValueError { throw map(error) }
        catch { throw WireFormatError("invalid JSON") }
    }

    public static func decode(_ source: String) throws -> WireFrame {
        try decode(Data(source.utf8))
    }

    private static func decode(_ value: JSONValue) throws -> WireFrame {
        let raw = try object(value, "frame")
        guard try string(raw["v"], "v") == WireLimits.protocolVersion else {
            throw WireFormatError("protocol version must be exactly omp-app/1", path: "v")
        }
        let type = try string(raw["type"], "type")
        switch type {
        case "hello": return .hello(HelloFrame(raw: raw))
        case "command": return .command(try command(raw))
        case "confirm": return .confirm(try confirm(raw))
        case "pair.start": return .pairStart(try pairStart(raw))
        case "terminal.input": return .terminalInput(try terminalInput(raw))
        case "terminal.resize": return .terminalResize(try terminalResize(raw))
        case "terminal.close": return .terminalClose(try terminalClose(raw))
        case "ping": return .ping(try ping(raw))
        case "welcome": return .welcome(try welcome(raw))
        case "sessions": return .sessions(try sessions(raw))
        case "snapshot": return .snapshot(try snapshot(raw))
        case "entry": return .entry(try entry(raw))
        case "event": return .event(try event(raw))
        case "response": return .response(try response(raw))
        case "error": return .error(try errorFrame(raw))
        case "pong": return .pong(try pong(raw))
        case "gap": return .gap(try gap(raw))
        case "confirmation": return .confirmation(try confirmation(raw))
        case "pair.ok": return .pairOK(try pairOK(raw))
        case "pair.error": return .pairError(try pairError(raw))
        case "agent", "terminal", "files", "review", "audit", "bye",
             "host.watch", "session.watch", "session.state", "session.delta",
             "lease", "prompt.lease", "agent.state", "agent.lifecycle", "agent.progress",
             "agent.event", "agent.transcript", "terminal.output", "terminal.exit",
             "files.list", "files.read", "files.write", "files.patch", "files.diff",
             "audit.tail", "audit.event", "catalog", "settings", "preview.launch",
             "preview.state", "preview.navigation", "preview.capture", "preview.error":
            return .additive(AdditiveServerFrame(type: type, raw: raw))
        default:
            throw WireFormatError("unknown top-level frame family", path: "type")
        }
    }

    private static func welcome(_ raw: [String: JSONValue]) throws -> WelcomeFrame {
        let selected = try string(raw["selectedProtocol"], "selectedProtocol")
        guard selected == WireLimits.protocolVersion else {
            throw WireFormatError("selected protocol must be omp-app/1", path: "selectedProtocol")
        }
        let host = try id(raw["hostId"], "hostId")
        let epoch = try string(raw["epoch"], "epoch")
        let auth = try string(raw["authentication"], "authentication")
        guard ["local", "pairing-required", "paired"].contains(auth) else {
            throw WireFormatError("invalid authentication state", path: "authentication")
        }
        let capabilities = try strings(raw["grantedCapabilities"], "grantedCapabilities")
        if auth == "pairing-required", !capabilities.isEmpty {
            throw WireFormatError("pairing-required welcome cannot grant capabilities", path: "grantedCapabilities")
        }
        return WelcomeFrame(hostId: host, selectedProtocol: selected, epoch: epoch, authentication: auth,
                            resumed: try bool(raw["resumed"], "resumed"),
                            grantedCapabilities: capabilities,
                            grantedFeatures: try strings(raw["grantedFeatures"], "grantedFeatures"),
                            negotiatedLimits: try object(raw["negotiatedLimits"], "negotiatedLimits"), raw: raw)
    }

    private static func sessions(_ raw: [String: JSONValue]) throws -> SessionsFrame {
        let values = try array(raw["sessions"], "sessions")
        let sessions = try values.enumerated().map { try sessionReference($0.element, "sessions[\($0.offset)]") }
        let total = raw["totalCount"] == nil ? sessions.count : try integer(raw["totalCount"], "totalCount")
        guard total >= sessions.count else { throw WireFormatError("totalCount cannot be less than sessions length", path: "totalCount") }
        let truncated = raw["truncated"] == nil ? total > sessions.count : try bool(raw["truncated"], "truncated")
        guard truncated == (total > sessions.count) else { throw WireFormatError("truncated does not match totalCount", path: "truncated") }
        return SessionsFrame(hostId: raw["hostId"] == nil ? nil : try id(raw["hostId"], "hostId"),
                             cursor: try sessionCursor(raw["cursor"], "cursor"), sessions: sessions,
                             totalCount: total, truncated: truncated, raw: raw)
    }

    private static func sessionReference(_ value: JSONValue, _ path: String) throws -> SessionReference {
        let raw = try object(value, path)
        return SessionReference(hostId: try id(raw["hostId"], "\(path).hostId"), sessionId: try id(raw["sessionId"], "\(path).sessionId"),
                                title: try string(raw["title"], "\(path).title"), revision: try id(raw["revision"], "\(path).revision"),
                                status: try string(raw["status"], "\(path).status"), updatedAt: try string(raw["updatedAt"], "\(path).updatedAt"),
                                project: try object(raw["project"], "\(path).project"), raw: raw)
    }

    private static func snapshot(_ raw: [String: JSONValue]) throws -> SnapshotFrame {
        let values = try array(raw["entries"], "entries")
        return SnapshotFrame(hostId: try id(raw["hostId"], "hostId"), sessionId: try id(raw["sessionId"], "sessionId"),
                             cursor: try transcriptCursor(raw["cursor"], "cursor"), revision: try id(raw["revision"], "revision"),
                             entries: try values.enumerated().map { try object($0.element, "entries[\($0.offset)]") }, raw: raw)
    }

    private static func entry(_ raw: [String: JSONValue]) throws -> EntryFrame {
        let host = try id(raw["hostId"], "hostId"); let session = try id(raw["sessionId"], "sessionId")
        let item = try object(raw["entry"], "entry")
        guard try id(item["hostId"], "entry.hostId") == host, try id(item["sessionId"], "entry.sessionId") == session else {
            throw WireFormatError("entry belongs to another session", path: "entry")
        }
        return EntryFrame(hostId: host, sessionId: session, cursor: try transcriptCursor(raw["cursor"], "cursor"),
                          revision: try id(raw["revision"], "revision"), entry: item, raw: raw)
    }

    private static func event(_ raw: [String: JSONValue]) throws -> EventFrame {
        let payload = try object(raw["event"], "event")
        _ = try string(payload["type"], "event.type")
        return EventFrame(hostId: try id(raw["hostId"], "hostId"), sessionId: try id(raw["sessionId"], "sessionId"),
                          cursor: try transcriptCursor(raw["cursor"], "cursor"), event: payload, raw: raw)
    }

    private static func response(_ raw: [String: JSONValue]) throws -> ResponseFrame {
        ResponseFrame(requestId: try id(raw["requestId"], "requestId"), commandId: raw["commandId"] == nil ? nil : try id(raw["commandId"], "commandId"),
                      hostId: raw["hostId"] == nil ? nil : try id(raw["hostId"], "hostId"), sessionId: raw["sessionId"] == nil ? nil : try id(raw["sessionId"], "sessionId"),
                      command: raw["command"] == nil ? nil : try string(raw["command"], "command"), ok: try bool(raw["ok"], "ok"),
                      result: raw["result"], error: raw["error"] == nil ? nil : try object(raw["error"], "error"), raw: raw)
    }

    private static func command(_ raw: [String: JSONValue]) throws -> CommandFrame {
        CommandFrame(requestId: try id(raw["requestId"], "requestId"), commandId: try id(raw["commandId"], "commandId"),
                     hostId: try id(raw["hostId"], "hostId"), sessionId: raw["sessionId"] == nil ? nil : try id(raw["sessionId"], "sessionId"),
                     command: try string(raw["command"], "command"), expectedRevision: raw["expectedRevision"] == nil ? nil : try id(raw["expectedRevision"], "expectedRevision"),
                     confirmationId: raw["confirmationId"] == nil ? nil : try id(raw["confirmationId"], "confirmationId"), args: raw["args"] ?? .object([:]), raw: raw)
    }

    private static func confirm(_ raw: [String: JSONValue]) throws -> ConfirmFrame {
        let decision = try string(raw["decision"], "decision")
        guard decision == "approve" || decision == "deny" else { throw WireFormatError("decision must be approve or deny", path: "decision") }
        return ConfirmFrame(requestId: try id(raw["requestId"], "requestId"), confirmationId: try id(raw["confirmationId"], "confirmationId"), commandId: try id(raw["commandId"], "commandId"), hostId: try id(raw["hostId"], "hostId"), decision: decision, sessionId: raw["sessionId"] == nil ? nil : try id(raw["sessionId"], "sessionId"), raw: raw)
    }

    private static func pairStart(_ raw: [String: JSONValue]) throws -> PairStartFrame {
        let code = try string(raw["code"], "code")
        guard code.utf8.count == 6, code.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { throw WireFormatError("code must be exactly six digits", path: "code") }
        return PairStartFrame(requestId: try id(raw["requestId"], "requestId"), code: code, deviceId: try id(raw["deviceId"], "deviceId"), deviceName: try string(raw["deviceName"], "deviceName"), platform: try string(raw["platform"], "platform"), requestedCapabilities: try strings(raw["requestedCapabilities"], "requestedCapabilities"), raw: raw)
    }

    private static func terminalInput(_ raw: [String: JSONValue]) throws -> TerminalInputFrame {
        TerminalInputFrame(hostId: try id(raw["hostId"], "hostId"), sessionId: try id(raw["sessionId"], "sessionId"), terminalId: try id(raw["terminalId"], "terminalId"), data: try string(raw["data"], "data"), encoding: raw["encoding"] == nil ? nil : try string(raw["encoding"], "encoding"), raw: raw)
    }

    private static func terminalResize(_ raw: [String: JSONValue]) throws -> TerminalResizeFrame {
        TerminalResizeFrame(hostId: try id(raw["hostId"], "hostId"), sessionId: try id(raw["sessionId"], "sessionId"), terminalId: try id(raw["terminalId"], "terminalId"), cols: try integer(raw["cols"], "cols"), rows: try integer(raw["rows"], "rows"), raw: raw)
    }

    private static func terminalClose(_ raw: [String: JSONValue]) throws -> TerminalCloseFrame {
        TerminalCloseFrame(hostId: try id(raw["hostId"], "hostId"), sessionId: try id(raw["sessionId"], "sessionId"), terminalId: try id(raw["terminalId"], "terminalId"), reason: raw["reason"] == nil ? nil : try string(raw["reason"], "reason"), raw: raw)
    }

    private static func ping(_ raw: [String: JSONValue]) throws -> PingFrame { PingFrame(nonce: try string(raw["nonce"], "nonce"), timestamp: try string(raw["timestamp"], "timestamp"), raw: raw) }
    private static func errorFrame(_ raw: [String: JSONValue]) throws -> ErrorFrame { ErrorFrame(code: try string(raw["code"], "code"), message: try string(raw["message"], "message"), requestId: raw["requestId"] == nil ? nil : try id(raw["requestId"], "requestId"), raw: raw) }
    private static func pong(_ raw: [String: JSONValue]) throws -> PongFrame { PongFrame(nonce: try string(raw["nonce"], "nonce"), timestamp: raw["timestamp"] == nil ? nil : try string(raw["timestamp"], "timestamp"), raw: raw) }
    private static func confirmation(_ raw: [String: JSONValue]) throws -> ConfirmationFrame { ConfirmationFrame(confirmationId: try id(raw["confirmationId"], "confirmationId"), raw: raw) }
    private static func pairOK(_ raw: [String: JSONValue]) throws -> PairOKFrame { PairOKFrame(pairingId: try id(raw["pairingId"], "pairingId"), raw: raw) }
    private static func pairError(_ raw: [String: JSONValue]) throws -> PairErrorFrame { PairErrorFrame(message: try string(raw["message"], "message"), raw: raw) }
    private static func gap(_ raw: [String: JSONValue]) throws -> GapFrame {
        let from = try transcriptCursor(raw["from"], "from")
        let to = raw["to"] == nil ? nil : try transcriptCursor(raw["to"], "to")
        if let to, from.epoch != to.epoch || to.seq < from.seq {
            throw WireFormatError("invalid gap cursor range", path: "to")
        }
        return GapFrame(hostId: try id(raw["hostId"], "hostId"),
                        sessionId: try id(raw["sessionId"], "sessionId"),
                        from: from, to: to,
                        reason: raw["reason"] == nil ? nil : try string(raw["reason"], "reason"),
                        raw: raw)
    }

    private static func transcriptCursor(_ value: JSONValue?, _ path: String) throws -> TranscriptCursor {
        let object = try object(value, path)
        let seq = try integer(object["seq"], "\(path).seq")
        guard seq >= 0 else { throw WireFormatError("cursor sequence must be nonnegative", path: "\(path).seq") }
        return TranscriptCursor(epoch: try string(object["epoch"], "\(path).epoch"), seq: seq)
    }
    private static func sessionCursor(_ value: JSONValue?, _ path: String) throws -> SessionIndexCursor {
        let object = try object(value, path)
        let seq = try integer(object["seq"], "\(path).seq")
        guard seq >= 0 else { throw WireFormatError("cursor sequence must be nonnegative", path: "\(path).seq") }
        return SessionIndexCursor(epoch: try string(object["epoch"], "\(path).epoch"), seq: seq)
    }
    private static func object(_ value: JSONValue?, _ path: String) throws -> [String: JSONValue] { guard case let .object(value) = value else { throw WireFormatError("expected object", path: path) }; return value }
    private static func array(_ value: JSONValue?, _ path: String) throws -> [JSONValue] { guard case let .array(value) = value else { throw WireFormatError("expected array", path: path) }; return value }
    private static func string(_ value: JSONValue?, _ path: String) throws -> String { guard case let .string(value) = value else { throw WireFormatError("expected string", path: path) }; return value }
    private static func bool(_ value: JSONValue?, _ path: String) throws -> Bool { guard case let .bool(value) = value else { throw WireFormatError("expected boolean", path: path) }; return value }
    private static func integer(_ value: JSONValue?, _ path: String) throws -> Int { guard case let .number(value) = value, value.isFinite, value.rounded() == value, abs(value) <= WireLimits.maxSafeInteger, value >= Double(Int.min), value <= Double(Int.max) else { throw WireFormatError("expected safe integer", path: path) }; return Int(value) }
    private static func id(_ value: JSONValue?, _ path: String) throws -> String { let value = try string(value, path); guard !value.isEmpty, value.utf8.count <= WireLimits.maxIdBytes, !value.unicodeScalars.contains(where: { $0.value < 0x20 }) else { throw WireFormatError("invalid identifier", path: path) }; return value }
    private static func strings(_ value: JSONValue?, _ path: String) throws -> [String] { try array(value, path).enumerated().map { try string($0.element, "\(path)[\($0.offset)]") } }
    private static func map(_ error: JSONValueError) -> WireFormatError {
        switch error { case .inputTooLarge: return WireFormatError("inbound frame exceeds the 4 MiB UTF-8 limit"); case .depthExceeded: return WireFormatError("JSON nesting exceeds the depth limit"); case .nodeLimitExceeded: return WireFormatError("JSON node count exceeds the limit"); case .mapLimitExceeded: return WireFormatError("JSON object exceeds the key limit"); case .arrayLimitExceeded: return WireFormatError("JSON array exceeds the item limit"); case .unsafeNumber: return WireFormatError("number is outside the safe integer range"); default: return WireFormatError("invalid JSON") }
    }
}

public enum WireEncoder {
    public static func hello(client: ClientIdentity, requestedFeatures: [String] = [], savedCursors: [SavedCursor] = [], capabilities: [String] = [], authentication: DeviceAuthentication? = nil) throws -> Data {
        guard savedCursors.count <= WireLimits.maxSavedCursors else { throw WireFormatError("savedCursors exceeds the limit", path: "savedCursors") }
        let clientValue: [String: JSONValue] = ["name": .string(client.name), "version": .string(client.version), "build": .string(client.build), "platform": .string(client.platform)]
        var frame: [String: JSONValue] = ["v": .string(WireLimits.protocolVersion), "type": .string("hello"), "protocol": .object(["min": .string(WireLimits.protocolVersion), "max": .string(WireLimits.protocolVersion)]), "client": .object(clientValue), "requestedFeatures": .array(requestedFeatures.map(JSONValue.string)), "savedCursors": .array(savedCursors.map { .object(["hostId": .string($0.hostId), "sessionId": .string($0.sessionId), "cursor": transcriptCursorValue($0.cursor)]) })]
        if !capabilities.isEmpty { frame["capabilities"] = .object(["client": .array(capabilities.map(JSONValue.string))]) }
        if let authentication { frame["authentication"] = .object(["deviceId": .string(authentication.deviceId), "deviceToken": .string(authentication.deviceToken)]) }
        return try encode(frame)
    }

    public static func sessionList(requestId: String, commandId: String, hostId: String) throws -> Data { try command(requestId: requestId, commandId: commandId, hostId: hostId, command: "session.list", args: .object([:])) }
    public static func list(requestId: String, commandId: String, hostId: String) throws -> Data { try sessionList(requestId: requestId, commandId: commandId, hostId: hostId) }
    public static func hostWatch(requestId: String, commandId: String, hostId: String, cursor: SessionIndexCursor) throws -> Data { try command(requestId: requestId, commandId: commandId, hostId: hostId, command: "host.watch", args: .object(["cursor": cursorValue(cursor)])) }
    public static func watch(requestId: String, commandId: String, hostId: String, cursor: SessionIndexCursor) throws -> Data { try hostWatch(requestId: requestId, commandId: commandId, hostId: hostId, cursor: cursor) }
    public static func sessionAttach(requestId: String, commandId: String, hostId: String, sessionId: String, cursor: TranscriptCursor? = nil) throws -> Data { try command(requestId: requestId, commandId: commandId, hostId: hostId, command: "session.attach", args: .object(cursor.map { ["cursor": transcriptCursorValue($0)] } ?? [:]), sessionId: sessionId) }
    public static func attach(requestId: String, commandId: String, hostId: String, sessionId: String, cursor: TranscriptCursor? = nil) throws -> Data { try sessionAttach(requestId: requestId, commandId: commandId, hostId: hostId, sessionId: sessionId, cursor: cursor) }
    public static func sessionPrompt(requestId: String, commandId: String, hostId: String, sessionId: String, expectedRevision: String, text: String, imageIds: [String] = []) throws -> Data {
        guard !text.isEmpty || !imageIds.isEmpty else { throw WireFormatError("text must not be empty without images", path: "text") }
        guard imageIds.count <= 8 else { throw WireFormatError("imageIds exceeds the limit", path: "imageIds") }
        let images = imageIds.map { JSONValue.object(["imageId": .string($0)]) }
        return try command(requestId: requestId, commandId: commandId, hostId: hostId, command: "session.prompt", args: .object(["message": .string(text), "images": .array(images)]), sessionId: sessionId, expectedRevision: expectedRevision)
    }
    public static func prompt(requestId: String, commandId: String, hostId: String, sessionId: String, expectedRevision: String, text: String, imageIds: [String] = []) throws -> Data { try sessionPrompt(requestId: requestId, commandId: commandId, hostId: hostId, sessionId: sessionId, expectedRevision: expectedRevision, text: text, imageIds: imageIds) }
    public static func command(requestId: String, commandId: String, hostId: String, command commandName: String, args: JSONValue, sessionId: String? = nil, expectedRevision: String? = nil, confirmationId: String? = nil) throws -> Data {
        guard knownCommands.contains(commandName) else { throw WireFormatError("command is not a pinned command", path: "command") }
        var frame: [String: JSONValue] = ["v": .string(WireLimits.protocolVersion), "type": .string("command"), "requestId": .string(requestId), "commandId": .string(commandId), "hostId": .string(hostId), "command": .string(commandName), "args": args]
        if let sessionId { frame["sessionId"] = .string(sessionId) }; if let expectedRevision { frame["expectedRevision"] = .string(expectedRevision) }; if let confirmationId { frame["confirmationId"] = .string(confirmationId) }
        return try encode(frame)
    }
    public static func command(requestId: String, commandId: String, hostId: String, command commandName: String, args: [String: JSONValue], sessionId: String? = nil, expectedRevision: String? = nil, confirmationId: String? = nil) throws -> Data {
        try Self.command(requestId: requestId, commandId: commandId, hostId: hostId, command: commandName, args: .object(args), sessionId: sessionId, expectedRevision: expectedRevision, confirmationId: confirmationId)
    }
    public static func terminal(hostId: String, sessionId: String, terminalId: String, data: String, encoding: String? = nil) throws -> Data {
        try terminalInput(hostId: hostId, sessionId: sessionId, terminalId: terminalId, data: data, encoding: encoding)
    }
    public static func confirm(requestId: String, confirmationId: String, commandId: String, hostId: String, decision: String, sessionId: String? = nil) throws -> Data {
        guard decision == "approve" || decision == "deny" else { throw WireFormatError("decision must be approve or deny", path: "decision") }
        var frame: [String: JSONValue] = ["v": .string(WireLimits.protocolVersion), "type": .string("confirm"), "requestId": .string(requestId), "confirmationId": .string(confirmationId), "commandId": .string(commandId), "hostId": .string(hostId), "decision": .string(decision)]
        if let sessionId { frame["sessionId"] = .string(sessionId) }; return try encode(frame)
    }
    public static func pairStart(requestId: String, code: String, deviceId: String, deviceName: String, platform: String, requestedCapabilities: [String] = []) throws -> Data {
        guard code.utf8.count == 6, code.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { throw WireFormatError("code must be exactly six digits", path: "code") }
        return try encode(["v": .string(WireLimits.protocolVersion), "type": .string("pair.start"), "requestId": .string(requestId), "code": .string(code), "deviceId": .string(deviceId), "deviceName": .string(deviceName), "platform": .string(platform), "requestedCapabilities": .array(requestedCapabilities.map(JSONValue.string))])
    }
    public static func pair(requestId: String, code: String, deviceId: String, deviceName: String, platform: String, requestedCapabilities: [String] = []) throws -> Data { try pairStart(requestId: requestId, code: code, deviceId: deviceId, deviceName: deviceName, platform: platform, requestedCapabilities: requestedCapabilities) }
    public static func terminalInput(hostId: String, sessionId: String, terminalId: String, data: String, encoding: String? = nil) throws -> Data { try encode(["v": .string(WireLimits.protocolVersion), "type": .string("terminal.input"), "hostId": .string(hostId), "sessionId": .string(sessionId), "terminalId": .string(terminalId), "data": .string(data), "encoding": encoding.map(JSONValue.string) ?? .null].filterNulls()) }
    public static func terminalResize(hostId: String, sessionId: String, terminalId: String, cols: Int, rows: Int) throws -> Data { guard (1...1000).contains(cols), (1...500).contains(rows) else { throw WireFormatError("terminal dimensions are out of range") }; return try encode(["v": .string(WireLimits.protocolVersion), "type": .string("terminal.resize"), "hostId": .string(hostId), "sessionId": .string(sessionId), "terminalId": .string(terminalId), "cols": .number(Double(cols)), "rows": .number(Double(rows))]) }
    public static func terminalClose(hostId: String, sessionId: String, terminalId: String, reason: String? = nil) throws -> Data { try encode(["v": .string(WireLimits.protocolVersion), "type": .string("terminal.close"), "hostId": .string(hostId), "sessionId": .string(sessionId), "terminalId": .string(terminalId), "reason": reason.map(JSONValue.string) ?? .null].filterNulls()) }
    public static func ping(nonce: String, timestamp: String) throws -> Data { try encode(["v": .string(WireLimits.protocolVersion), "type": .string("ping"), "nonce": .string(nonce), "timestamp": .string(timestamp)]) }

    private static func transcriptCursorValue(_ value: TranscriptCursor) -> JSONValue { .object(["epoch": .string(value.epoch), "seq": .number(Double(value.seq))]) }
    private static func cursorValue(_ value: SessionIndexCursor) -> JSONValue { .object(["epoch": .string(value.epoch), "seq": .number(Double(value.seq))]) }
    private static func encode(_ object: [String: JSONValue]) throws -> Data {
        do {
            try JSONValue.object(object).validateBounded()
        } catch {
            throw WireFormatError("outbound JSON exceeds protocol bounds: \(String(describing: error))")
        }
        let data = try JSONSerialization.data(withJSONObject: object.mapValues { $0.toFoundation() }, options: [.withoutEscapingSlashes])
        guard data.count <= WireLimits.maxFrameBytes else { throw WireFormatError("outbound frame exceeds the 4 MiB UTF-8 limit") }
        return data
    }
    private static let knownCommands: Set<String> = ["host.list", "session.list", "transcript.search", "transcript.context", "transcript.page", "session.create", "session.attach", "session.prompt", "session.state.get", "session.watch", "host.watch", "session.cancel", "session.close", "files.read", "files.write", "files.patch", "files.list", "files.diff", "audit.read", "audit.tail", "settings.read", "settings.write", "catalog.get", "usage.read", "term.open", "bash.run", "agent.cancel", "preview.launch", "preview.state", "preview.navigate", "preview.capture"]
}

private extension Dictionary where Key == String, Value == JSONValue {
    func filterNulls() -> [String: JSONValue] { filter { if case .null = $0.value { return false }; return true } }
}

/// Compatibility facade for clients that prefer one codec namespace.
public enum WireCodec {
    public static func decode(_ data: Data) throws -> WireFrame { try WireDecoder.decode(data) }
    public static func encode(_ frame: WireFrame) throws -> Data {
        let data = try JSONSerialization.data(withJSONObject: frame.raw.mapValues { $0.toFoundation() }, options: [.withoutEscapingSlashes])
        guard data.count <= WireLimits.maxFrameBytes else { throw WireFormatError("outbound frame exceeds the 4 MiB UTF-8 limit") }
        return data
    }
}
