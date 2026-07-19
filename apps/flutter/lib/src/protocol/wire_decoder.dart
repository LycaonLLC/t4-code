import 'dart:collection';
import 'dart:convert';

import 'models.dart';

const int _maxInboundBytes = 4 * 1024 * 1024;
const int _maxSafeInteger = 9007199254740991;
const int _maxArrayItems = 1000;
const int _maxMapKeys = 512;
const int _maxJsonDepth = 32;
const int _maxJsonNodes = 20000;

/// Allocation-conscious boundary decoder for inbound omp-app/1 JSON frames.
abstract final class WireDecoder {
  /// Decodes one complete JSON frame.
  ///
  /// The UTF-8 size is checked without first allocating an encoded byte list.
  /// All maps and lists reachable from the returned frame are immutable views
  /// over the single object graph produced by [jsonDecode].
  static WireFrame decode(String source) {
    if (!_utf8LengthAtMost(source, _maxInboundBytes)) {
      throw const WireFormatException(
        'inbound frame exceeds the 4 MiB UTF-8 limit',
      );
    }

    final Object? decoded;
    try {
      decoded = jsonDecode(source);
    } on FormatException catch (error) {
      throw WireFormatException('invalid JSON: ${error.message}');
    }

    final frozen = _freezeJson(decoded, _JsonBudget(), 0);
    final raw = _map(frozen, 'frame');
    _exactVersion(raw);
    final type = _string(raw['type'], 'type', 128);
    return switch (type) {
      'welcome' => _decodeWelcome(raw),
      'sessions' => _decodeSessions(raw),
      'snapshot' => _decodeSnapshot(raw),
      'entry' => _decodeEntryFrame(raw),
      'event' => _decodeEvent(raw),
      'response' => _decodeResponse(raw),
      'error' => _decodeError(raw),
      'gap' => _decodeGap(raw),
      'ping' => _decodePing(raw),
      'pong' => _decodePong(raw),
      _ => throw WireFormatException('unknown top-level frame family', 'type'),
    };
  }
}

WelcomeFrame _decodeWelcome(Map<String, Object?> raw) {
  final selectedProtocol = _string(
    raw['selectedProtocol'],
    'selectedProtocol',
    64,
  );
  if (selectedProtocol != ompAppProtocolVersion) {
    throw const WireFormatException(
      'selected protocol must be omp-app/1',
      'selectedProtocol',
    );
  }
  final hostId = _id(raw['hostId'], 'hostId');
  _string(raw['ompVersion'], 'ompVersion', 64);
  _string(raw['ompBuild'], 'ompBuild', 128);
  _string(raw['appserverVersion'], 'appserverVersion', 64);
  _string(raw['appserverBuild'], 'appserverBuild', 128);
  final epoch = _string(raw['epoch'], 'epoch', 128);
  final authentication = _string(raw['authentication'], 'authentication', 32);
  if (authentication != 'local' &&
      authentication != 'pairing-required' &&
      authentication != 'paired') {
    throw const WireFormatException(
      'invalid authentication state',
      'authentication',
    );
  }
  final capabilities = _stringList(
    raw['grantedCapabilities'],
    'grantedCapabilities',
    maxItems: 128,
  );
  if (authentication == 'pairing-required' && capabilities.isNotEmpty) {
    throw const WireFormatException(
      'pairing-required welcome cannot grant capabilities',
      'grantedCapabilities',
    );
  }
  final features = _stringList(
    raw['grantedFeatures'],
    'grantedFeatures',
    maxItems: 128,
  );
  final limits = _map(raw['negotiatedLimits'], 'negotiatedLimits');
  final resumed = _bool(raw['resumed'], 'resumed');
  return WelcomeFrame(
    hostId: hostId,
    resumed: resumed,
    selectedProtocol: selectedProtocol,
    epoch: epoch,
    authentication: authentication,
    grantedCapabilities: capabilities,
    grantedFeatures: features,
    negotiatedLimits: limits,
    raw: raw,
  );
}

SessionsFrame _decodeSessions(Map<String, Object?> raw) {
  final hostId = raw.containsKey('hostId')
      ? _id(raw['hostId'], 'hostId')
      : null;
  final cursor = _sessionIndexCursor(raw['cursor'], 'cursor');
  final values = _list(raw['sessions'], 'sessions');
  final sessions = <SessionRef>[];
  for (var index = 0; index < values.length; index++) {
    sessions.add(_sessionRef(values[index], 'sessions[$index]'));
  }
  final totalCount = raw.containsKey('totalCount')
      ? _safeInteger(raw['totalCount'], 'totalCount')
      : sessions.length;
  if (totalCount < sessions.length) {
    throw const WireFormatException(
      'totalCount cannot be less than sessions length',
      'totalCount',
    );
  }
  final expectedTruncated = totalCount > sessions.length;
  final truncated = raw.containsKey('truncated')
      ? _bool(raw['truncated'], 'truncated')
      : expectedTruncated;
  if (truncated != expectedTruncated) {
    throw const WireFormatException(
      'truncated does not match totalCount',
      'truncated',
    );
  }
  return SessionsFrame(
    hostId: hostId,
    cursor: cursor,
    sessions: UnmodifiableListView<SessionRef>(sessions),
    totalCount: totalCount,
    truncated: truncated,
    raw: raw,
  );
}

SessionRef _sessionRef(Object? value, String path) {
  final raw = _map(value, path);
  final hostId = _id(raw['hostId'], '$path.hostId');
  final sessionId = _id(raw['sessionId'], '$path.sessionId');
  final project = _map(raw['project'], '$path.project');
  _id(project['projectId'], '$path.project.projectId');
  if (project.containsKey('name')) {
    _string(project['name'], '$path.project.name', 256);
  }
  final revision = _id(raw['revision'], '$path.revision');
  final title = _string(raw['title'], '$path.title', 512);
  final status = _string(raw['status'], '$path.status', 64);
  final updatedAt = _string(raw['updatedAt'], '$path.updatedAt', 128);
  if (raw.containsKey('archivedAt')) {
    _string(raw['archivedAt'], '$path.archivedAt', 128);
  }
  if (raw.containsKey('liveState')) {
    _map(raw['liveState'], '$path.liveState');
  }
  if (raw.containsKey('model')) {
    _string(raw['model'], '$path.model', 256);
  }
  if (raw.containsKey('thinking')) {
    _string(raw['thinking'], '$path.thinking', 256);
  }
  if (raw.containsKey('pendingApproval')) {
    _bool(raw['pendingApproval'], '$path.pendingApproval');
  }
  if (raw.containsKey('pendingUserInput')) {
    _bool(raw['pendingUserInput'], '$path.pendingUserInput');
  }
  if (raw.containsKey('proposedPlan')) {
    _string(raw['proposedPlan'], '$path.proposedPlan', 4096);
  }
  return SessionRef(
    hostId: hostId,
    sessionId: sessionId,
    title: title,
    revision: revision,
    status: status,
    updatedAt: updatedAt,
    project: project,
    raw: raw,
  );
}

SnapshotFrame _decodeSnapshot(Map<String, Object?> raw) {
  final hostId = _id(raw['hostId'], 'hostId');
  final sessionId = _id(raw['sessionId'], 'sessionId');
  final cursor = _transcriptCursor(raw['cursor'], 'cursor');
  final revision = _id(raw['revision'], 'revision');
  final values = _list(raw['entries'], 'entries');
  final entries = <DurableEntry>[];
  for (var index = 0; index < values.length; index++) {
    final entry = _durableEntry(values[index], 'entries[$index]');
    if (entry.hostId != hostId || entry.sessionId != sessionId) {
      throw WireFormatException(
        'entry belongs to another session',
        'entries[$index]',
      );
    }
    entries.add(entry);
  }
  return SnapshotFrame(
    hostId: hostId,
    sessionId: sessionId,
    cursor: cursor,
    revision: revision,
    entries: UnmodifiableListView<DurableEntry>(entries),
    raw: raw,
  );
}

EntryFrame _decodeEntryFrame(Map<String, Object?> raw) {
  final hostId = _id(raw['hostId'], 'hostId');
  final sessionId = _id(raw['sessionId'], 'sessionId');
  final entry = _durableEntry(raw['entry'], 'entry');
  if (entry.hostId != hostId || entry.sessionId != sessionId) {
    throw const WireFormatException(
      'entry belongs to another session',
      'entry',
    );
  }
  return EntryFrame(
    hostId: hostId,
    sessionId: sessionId,
    cursor: _transcriptCursor(raw['cursor'], 'cursor'),
    revision: _id(raw['revision'], 'revision'),
    entry: entry,
    raw: raw,
  );
}

DurableEntry _durableEntry(Object? value, String path) {
  final raw = _map(value, path);
  final id = _id(raw['id'], '$path.id');
  if (!raw.containsKey('parentId')) {
    throw WireFormatException('parentId is required', '$path.parentId');
  }
  final parentId = raw['parentId'] == null
      ? null
      : _id(raw['parentId'], '$path.parentId');
  final hostId = _id(raw['hostId'], '$path.hostId');
  final sessionId = _id(raw['sessionId'], '$path.sessionId');
  final kind = _string(raw['kind'], '$path.kind', 128);
  final timestamp = _string(raw['timestamp'], '$path.timestamp', 128);
  final data = _map(raw['data'], '$path.data');
  return DurableEntry(
    id: id,
    parentId: parentId,
    hostId: hostId,
    sessionId: sessionId,
    kind: kind,
    timestamp: timestamp,
    data: data,
    raw: raw,
  );
}

EventFrame _decodeEvent(Map<String, Object?> raw) {
  final event = _map(raw['event'], 'event');
  _string(event['type'], 'event.type', 128);
  return EventFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    cursor: _transcriptCursor(raw['cursor'], 'cursor'),
    event: event,
    raw: raw,
  );
}

ResponseFrame _decodeResponse(Map<String, Object?> raw) {
  final requestId = _id(raw['requestId'], 'requestId');
  final commandId = raw.containsKey('commandId')
      ? _id(raw['commandId'], 'commandId')
      : null;
  final hostId = _id(raw['hostId'], 'hostId');
  final sessionId = raw.containsKey('sessionId')
      ? _id(raw['sessionId'], 'sessionId')
      : null;
  final command = raw.containsKey('command')
      ? _string(raw['command'], 'command', 128)
      : null;
  final ok = _bool(raw['ok'], 'ok');
  final hasResult = raw.containsKey('result');
  WireResponseError? error;
  if (ok) {
    if (raw.containsKey('error')) {
      throw const WireFormatException(
        'successful response cannot have an error',
        'error',
      );
    }
    if (hasResult && command == null) {
      throw const WireFormatException(
        'successful response result requires command correlation',
        'command',
      );
    }
  } else {
    if (hasResult) {
      throw const WireFormatException(
        'failed response cannot have a result',
        'result',
      );
    }
    final errorRaw = _map(raw['error'], 'error');
    error = WireResponseError(
      code: _string(errorRaw['code'], 'error.code', 128),
      message: _nonemptyText(errorRaw['message'], 'error.message', 1024),
      details: errorRaw.containsKey('details')
          ? _map(errorRaw['details'], 'error.details')
          : null,
      raw: errorRaw,
    );
  }
  return ResponseFrame(
    requestId: requestId,
    commandId: commandId,
    hostId: hostId,
    sessionId: sessionId,
    command: command,
    ok: ok,
    result: hasResult ? raw['result'] : null,
    error: error,
    raw: raw,
  );
}

ErrorFrame _decodeError(Map<String, Object?> raw) {
  return ErrorFrame(
    code: _string(raw['code'], 'code', 128),
    message: _string(raw['message'], 'message', 2048),
    requestId: raw.containsKey('requestId')
        ? _id(raw['requestId'], 'requestId')
        : null,
    details: raw.containsKey('details')
        ? _map(raw['details'], 'details')
        : null,
    raw: raw,
  );
}

GapFrame _decodeGap(Map<String, Object?> raw) {
  final from = _transcriptCursor(raw['from'], 'from');
  final to = _transcriptCursor(raw['to'], 'to');
  if (from.epoch != to.epoch || to.seq < from.seq) {
    throw const WireFormatException('invalid gap cursor range', 'to');
  }
  return GapFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    from: from,
    to: to,
    reason: _string(raw['reason'], 'reason', 256),
    raw: raw,
  );
}

PingFrame _decodePing(Map<String, Object?> raw) => PingFrame(
  nonce: _string(raw['nonce'], 'nonce', 128),
  timestamp: _string(raw['timestamp'], 'timestamp', 128),
  raw: raw,
);

PongFrame _decodePong(Map<String, Object?> raw) => PongFrame(
  nonce: _string(raw['nonce'], 'nonce', 128),
  timestamp: _string(raw['timestamp'], 'timestamp', 128),
  raw: raw,
);

TranscriptCursor _transcriptCursor(Object? value, String path) {
  final cursor = _map(value, path);
  return TranscriptCursor(
    epoch: _string(cursor['epoch'], '$path.epoch', 128),
    seq: _safeInteger(cursor['seq'], '$path.seq'),
  );
}

SessionIndexCursor _sessionIndexCursor(Object? value, String path) {
  final cursor = _map(value, path);
  return SessionIndexCursor(
    epoch: _string(cursor['epoch'], '$path.epoch', 128),
    seq: _safeInteger(cursor['seq'], '$path.seq'),
  );
}

void _exactVersion(Map<String, Object?> raw) {
  if (raw['v'] != ompAppProtocolVersion) {
    throw const WireFormatException(
      'protocol version must be exactly omp-app/1',
      'v',
    );
  }
}

Map<String, Object?> _map(Object? value, String path) {
  if (value is! Map<String, Object?>) {
    throw WireFormatException('expected object', path);
  }
  return value;
}

List<Object?> _list(Object? value, String path, [int max = _maxArrayItems]) {
  if (value is! List<Object?> || value.length > max) {
    throw WireFormatException('expected array with at most $max items', path);
  }
  return value;
}

List<String> _stringList(
  Object? value,
  String path, {
  int maxItems = _maxArrayItems,
}) {
  final values = _list(value, path, maxItems);
  for (var index = 0; index < values.length; index++) {
    _string(values[index], '$path[$index]', 256);
  }
  return values.cast<String>();
}

String _id(Object? value, String path) => _string(value, path, 256);

String _string(Object? value, String path, int maxBytes) {
  if (value is! String ||
      value.isEmpty ||
      !_utf8LengthAtMost(value, maxBytes) ||
      _hasControlCharacter(value)) {
    throw WireFormatException('expected bounded non-empty string', path);
  }
  return value;
}

String _nonemptyText(Object? value, String path, int maxBytes) {
  if (value is! String ||
      value.isEmpty ||
      !_utf8LengthAtMost(value, maxBytes)) {
    throw WireFormatException('expected bounded non-empty text', path);
  }
  return value;
}

bool _bool(Object? value, String path) {
  if (value is! bool) {
    throw WireFormatException('expected boolean', path);
  }
  return value;
}

int _safeInteger(Object? value, String path) {
  if (value is! num ||
      !value.isFinite ||
      value < 0 ||
      value > _maxSafeInteger ||
      value.truncateToDouble() != value) {
    throw WireFormatException('expected a safe nonnegative integer', path);
  }
  return value.toInt();
}

bool _hasControlCharacter(String value) {
  for (final codeUnit in value.codeUnits) {
    if (codeUnit <= 0x1f || codeUnit == 0x7f) {
      return true;
    }
  }
  return false;
}

bool _utf8LengthAtMost(String value, int maximum) {
  var bytes = 0;
  for (var index = 0; index < value.length; index++) {
    final codeUnit = value.codeUnitAt(index);
    if (codeUnit <= 0x7f) {
      bytes++;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 < value.length) {
        final next = value.codeUnitAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index++;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximum) {
      return false;
    }
  }
  return true;
}

final class _JsonBudget {
  int nodes = 0;
}

Object? _freezeJson(Object? value, _JsonBudget budget, int depth) {
  budget.nodes++;
  if (budget.nodes > _maxJsonNodes) {
    throw const WireFormatException('JSON value has too many nodes');
  }
  if (depth > _maxJsonDepth) {
    throw const WireFormatException('JSON value is nested too deeply');
  }
  if (value is Map<String, dynamic>) {
    if (value.length > _maxMapKeys) {
      throw const WireFormatException('JSON object has too many keys');
    }
    value.updateAll((_, child) => _freezeJson(child, budget, depth + 1));
    return UnmodifiableMapView<String, Object?>(value);
  }
  if (value is List<dynamic>) {
    if (value.length > _maxArrayItems) {
      throw const WireFormatException('JSON array has too many items');
    }
    for (var index = 0; index < value.length; index++) {
      value[index] = _freezeJson(value[index], budget, depth + 1);
    }
    return UnmodifiableListView<Object?>(value);
  }
  return value;
}
