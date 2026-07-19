/// The only protocol version accepted by the Stage 1 client.
const String ompAppProtocolVersion = 'omp-app/1';

/// A decoding failure at the application wire boundary.
final class WireFormatException implements FormatException {
  const WireFormatException(this.message, [this.path]);

  @override
  final String message;

  /// Dot/bracket path of the invalid value, when one is available.
  final String? path;

  @override
  int? get offset => null;

  @override
  Object? get source => null;

  @override
  String toString() => path == null
      ? 'WireFormatException: $message'
      : 'WireFormatException at $path: $message';
}

/// A cursor in a session's transcript stream.
///
/// This is deliberately not assignable to [SessionIndexCursor].
final class TranscriptCursor {
  const TranscriptCursor({required this.epoch, required this.seq});

  final String epoch;
  final int seq;

  @override
  bool operator ==(Object other) =>
      other is TranscriptCursor && other.epoch == epoch && other.seq == seq;

  @override
  int get hashCode => Object.hash(epoch, seq);
}

/// A cursor in the host-wide session-index stream.
///
/// Session-index sequence numbers must never be compared with transcript
/// sequence numbers.
final class SessionIndexCursor {
  const SessionIndexCursor({required this.epoch, required this.seq});

  final String epoch;
  final int seq;

  @override
  bool operator ==(Object other) =>
      other is SessionIndexCursor && other.epoch == epoch && other.seq == seq;

  @override
  int get hashCode => Object.hash(epoch, seq);
}

final class ClientIdentity {
  const ClientIdentity({
    required this.name,
    required this.version,
    required this.build,
    required this.platform,
  });

  final String name;
  final String version;
  final String build;
  final String platform;
}

final class DeviceAuthentication {
  const DeviceAuthentication({
    required this.deviceId,
    required this.deviceToken,
  });

  final String deviceId;
  final String deviceToken;
}

final class SavedCursor {
  const SavedCursor({
    required this.hostId,
    required this.sessionId,
    required this.cursor,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor cursor;
}

/// Immutable projection of a session-index item.
final class SessionRef {
  const SessionRef({
    required this.hostId,
    required this.sessionId,
    required this.title,
    required this.revision,
    required this.status,
    required this.updatedAt,
    required this.project,
    required this.raw,
  });

  final String hostId;
  final String sessionId;
  final String title;
  final String revision;
  final String status;
  final String updatedAt;
  final Map<String, Object?> project;
  final Map<String, Object?> raw;
}

/// Immutable durable transcript entry.
final class DurableEntry {
  const DurableEntry({
    required this.id,
    required this.parentId,
    required this.hostId,
    required this.sessionId,
    required this.kind,
    required this.timestamp,
    required this.data,
    required this.raw,
  });

  final String id;
  final String? parentId;
  final String hostId;
  final String sessionId;
  final String kind;
  final String timestamp;
  final Map<String, Object?> data;
  final Map<String, Object?> raw;
}

/// Base type for all accepted inbound omp-app/1 frames.
sealed class WireFrame {
  const WireFrame({required this.raw});

  /// The complete, recursively immutable decoded frame, including additive
  /// fields not understood by this client version.
  final Map<String, Object?> raw;
}

final class WelcomeFrame extends WireFrame {
  const WelcomeFrame({
    required this.hostId,
    required this.resumed,
    required this.selectedProtocol,
    required this.epoch,
    required this.authentication,
    required this.grantedCapabilities,
    required this.grantedFeatures,
    required this.negotiatedLimits,
    required super.raw,
  });

  final String hostId;
  final bool resumed;
  final String selectedProtocol;
  final String epoch;
  final String authentication;
  final List<String> grantedCapabilities;
  final List<String> grantedFeatures;
  final Map<String, Object?> negotiatedLimits;
}

final class SessionsFrame extends WireFrame {
  const SessionsFrame({
    required this.hostId,
    required this.cursor,
    required this.sessions,
    required this.totalCount,
    required this.truncated,
    required super.raw,
  });

  final String? hostId;
  final SessionIndexCursor cursor;
  final List<SessionRef> sessions;
  final int totalCount;
  final bool truncated;
}

final class SnapshotFrame extends WireFrame {
  const SnapshotFrame({
    required this.hostId,
    required this.sessionId,
    required this.cursor,
    required this.revision,
    required this.entries,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor cursor;
  final String revision;
  final List<DurableEntry> entries;
}

final class EntryFrame extends WireFrame {
  const EntryFrame({
    required this.hostId,
    required this.sessionId,
    required this.cursor,
    required this.revision,
    required this.entry,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor cursor;
  final String revision;
  final DurableEntry entry;
}

final class EventFrame extends WireFrame {
  const EventFrame({
    required this.hostId,
    required this.sessionId,
    required this.cursor,
    required this.event,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor cursor;

  /// Raw immutable event payload. Unknown event subtypes are intentionally
  /// accepted as long as their `type` is a valid string.
  final Map<String, Object?> event;
}

final class WireResponseError {
  const WireResponseError({
    required this.code,
    required this.message,
    required this.details,
    required this.raw,
  });

  final String code;
  final String message;
  final Map<String, Object?>? details;
  final Map<String, Object?> raw;
}

final class ResponseFrame extends WireFrame {
  const ResponseFrame({
    required this.requestId,
    required this.commandId,
    required this.hostId,
    required this.sessionId,
    required this.command,
    required this.ok,
    required this.result,
    required this.error,
    required super.raw,
  });

  final String requestId;
  final String? commandId;
  final String hostId;
  final String? sessionId;
  final String? command;
  final bool ok;
  final Object? result;
  final WireResponseError? error;
}

final class ErrorFrame extends WireFrame {
  const ErrorFrame({
    required this.code,
    required this.message,
    required this.requestId,
    required this.details,
    required super.raw,
  });

  final String code;
  final String message;
  final String? requestId;
  final Map<String, Object?>? details;
}

final class GapFrame extends WireFrame {
  const GapFrame({
    required this.hostId,
    required this.sessionId,
    required this.from,
    required this.to,
    required this.reason,
    required super.raw,
  });

  final String hostId;
  final String sessionId;
  final TranscriptCursor from;
  final TranscriptCursor to;
  final String reason;
}

final class PingFrame extends WireFrame {
  const PingFrame({
    required this.nonce,
    required this.timestamp,
    required super.raw,
  });

  final String nonce;
  final String timestamp;
}

final class PongFrame extends WireFrame {
  const PongFrame({
    required this.nonce,
    required this.timestamp,
    required super.raw,
  });

  final String nonce;
  final String timestamp;
}
