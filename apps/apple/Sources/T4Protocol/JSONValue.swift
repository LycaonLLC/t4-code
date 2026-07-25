import Foundation

/// A recursively Sendable JSON value used at the omp-app/1 boundary.
public indirect enum JSONValue: Sendable, Equatable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public static func integer(_ value: Int) -> JSONValue {
        .number(Double(value))
    }

    public var objectValue: [String: JSONValue]? {
        guard case let .object(value) = self else { return nil }
        return value
    }

    public var stringValue: String? {
        guard case let .string(value) = self else { return nil }
        return value
    }

    public func toFoundation() -> Any {
        switch self {
        case .null: NSNull()
        case let .bool(value): value
        case let .number(value): value
        case let .string(value): value
        case let .array(value): value.map { $0.toFoundation() }
        case let .object(value): value.mapValues { $0.toFoundation() }
        }
    }

    public func encodedData() throws -> Data {
        guard JSONSerialization.isValidJSONObject(["value": toFoundation()]) else {
            throw JSONValueError.invalidValue
        }
        return try JSONSerialization.data(withJSONObject: toFoundation(), options: [.fragmentsAllowed])
    }
}

public enum JSONValueError: Error, Equatable, Sendable {
    case invalidValue
    case invalidJSON
    case inputTooLarge
    case depthExceeded
    case nodeLimitExceeded
    case mapLimitExceeded
    case arrayLimitExceeded
    case unsafeNumber
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            guard value.isFinite, abs(value) <= 9_007_199_254_740_991 else {
                throw JSONValueError.unsafeNumber
            }
            self = .number(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw JSONValueError.invalidJSON
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value):
            guard value.isFinite, abs(value) <= 9_007_199_254_740_991 else {
                throw JSONValueError.unsafeNumber
            }
            try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

extension JSONValue {
    /// Parses and validates one bounded JSON value. This is intentionally the
    /// only untrusted-input entry point used by `WireCodec`.
    func validateBounded() throws {
        var nodes = 0
        try validate(depth: 0, nodes: &nodes)
    }

    private func validate(depth: Int, nodes: inout Int) throws {
        guard depth <= WireLimits.maxDepth else { throw JSONValueError.depthExceeded }
        nodes += 1
        guard nodes <= WireLimits.maxNodes else { throw JSONValueError.nodeLimitExceeded }
        switch self {
        case .null, .bool, .string:
            return
        case .number(let value):
            guard value.isFinite, abs(value) <= WireLimits.maxSafeInteger else { throw JSONValueError.unsafeNumber }
        case .array(let values):
            guard values.count <= WireLimits.maxArrayItems else { throw JSONValueError.arrayLimitExceeded }
            for value in values { try value.validate(depth: depth + 1, nodes: &nodes) }
        case .object(let values):
            guard values.count <= WireLimits.maxMapKeys else { throw JSONValueError.mapLimitExceeded }
            for value in values.values { try value.validate(depth: depth + 1, nodes: &nodes) }
        }
    }

    static func parseBounded(_ source: String) throws -> JSONValue {
        try parseBounded(Data(source.utf8))
    }

    static func parseBounded(_ data: Data) throws -> JSONValue {
        guard data.count <= WireLimits.maxFrameBytes else {
            throw JSONValueError.inputTooLarge
        }
        let value: JSONValue
        do {
            value = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw JSONValueError.invalidJSON
        }
        try value.validateBounded()
        return value
    }

    private static func convert(_ value: Any, depth: Int, nodes: inout Int) throws -> JSONValue {
        guard depth <= WireLimits.maxDepth else { throw JSONValueError.depthExceeded }
        nodes += 1
        guard nodes <= WireLimits.maxNodes else { throw JSONValueError.nodeLimitExceeded }
        if value is NSNull { return .null }
        if let value = value as? NSNumber {
            if CFGetTypeID(value) == CFBooleanGetTypeID() {
                return .bool(value.boolValue)
            }
            let number = value.doubleValue
            guard number.isFinite, abs(number) <= WireLimits.maxSafeInteger else {
                throw JSONValueError.unsafeNumber
            }
            return .number(number)
        }
        if let value = value as? [Any] {
            guard value.count <= WireLimits.maxArrayItems else { throw JSONValueError.arrayLimitExceeded }
            return .array(try value.map { try convert($0, depth: depth + 1, nodes: &nodes) })
        }
        if let value = value as? [String: Any] {
            guard value.count <= WireLimits.maxMapKeys else { throw JSONValueError.mapLimitExceeded }
            var result = [String: JSONValue](minimumCapacity: value.count)
            for (key, child) in value {
                result[key] = try convert(child, depth: depth + 1, nodes: &nodes)
            }
            return .object(result)
        }
        throw JSONValueError.invalidJSON
    }
}
