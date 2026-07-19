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
      'agent' => _decodeAgent(raw),
      'terminal' => _decodeTerminal(raw),
      'files' => _decodeFiles(raw),
      'review' => _decodeReview(raw),
      'audit' => _decodeAudit(raw),
      'confirmation' => _decodeConfirmation(raw),
      'pair.ok' => _decodePairOk(raw),
      'pair.error' => _decodePairError(raw),
      'response' => _decodeResponse(raw),
      'gap' => _decodeGap(raw),
      'error' => _decodeError(raw),
      'pong' => _decodePong(raw),
      'bye' => _decodeBye(raw),
      'host.watch' ||
      'session.watch' ||
      'session.state' ||
      'session.delta' => _decodeWatch(raw, type),
      'lease' || 'prompt.lease' => _decodeLease(raw, type),
      'agent.state' ||
      'agent.lifecycle' ||
      'agent.progress' ||
      'agent.event' ||
      'agent.transcript' => _decodeAgentAdditive(raw, type),
      'terminal.output' => _decodeTerminalOutput(raw),
      'terminal.exit' => _decodeTerminalExit(raw),
      'files.list' ||
      'files.read' ||
      'files.write' ||
      'files.patch' ||
      'files.diff' => _decodeFilesAdditive(raw, type),
      'audit.tail' => _decodeAuditTail(raw),
      'audit.event' => _decodeAuditEventFrame(raw),
      'catalog' => _decodeCatalog(raw),
      'settings' => _decodeSettings(raw),
      'preview.launch' ||
      'preview.state' ||
      'preview.navigation' ||
      'preview.capture' ||
      'preview.error' => _decodePreview(raw, type),
      _ => throw WireFormatException('unknown top-level frame family', 'type'),
    };
  }

  /// Strictly decodes an authoritative host.list/session.list result payload.
  ///
  /// A recursively immutable copy is returned and [value] is never mutated.
  static SessionListResult decodeSessionListResult(Object? value) {
    final frozen = _freezeJsonCopy(value, _JsonBudget(), 0);
    return _decodeSessionListResult(_map(frozen, 'result'));
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

SessionListResult _decodeSessionListResult(Map<String, Object?> raw) {
  final cursor = _sessionIndexCursor(raw['cursor'], 'result.cursor');
  final values = _list(raw['sessions'], 'result.sessions');
  final sessions = <SessionRef>[];
  for (var index = 0; index < values.length; index++) {
    sessions.add(_sessionRef(values[index], 'result.sessions[$index]'));
  }
  final totalCount = raw.containsKey('totalCount')
      ? _safeInteger(raw['totalCount'], 'result.totalCount')
      : sessions.length;
  if (totalCount < sessions.length) {
    throw const WireFormatException(
      'totalCount cannot be less than sessions length',
      'result.totalCount',
    );
  }
  final expectedTruncated = totalCount > sessions.length;
  final truncated = raw.containsKey('truncated')
      ? _bool(raw['truncated'], 'result.truncated')
      : expectedTruncated;
  if (truncated != expectedTruncated) {
    throw const WireFormatException(
      'truncated does not match totalCount',
      'result',
    );
  }
  return SessionListResult(
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
  Object? result;
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
    if (hasResult) {
      result = command == 'session.list' || command == 'host.list'
          ? _decodeSessionListResult(_map(raw['result'], 'result'))
          : raw['result'];
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
    result: result,
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

AgentFrame _decodeAgent(Map<String, Object?> raw) {
  final progress = raw.containsKey('progress')
      ? _finiteNumber(raw['progress'], 'progress')
      : null;
  if (progress != null && (progress < 0 || progress > 1)) {
    throw const WireFormatException(
      'progress must be between zero and one',
      'progress',
    );
  }
  return AgentFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    agentId: _id(raw['agentId'], 'agentId'),
    state: _string(raw['state'], 'state', 64),
    progress: progress,
    detail: raw.containsKey('detail') ? _map(raw['detail'], 'detail') : null,
    raw: raw,
  );
}

TerminalFrame _decodeTerminal(Map<String, Object?> raw) {
  final stream = _enumString(raw['stream'], 'stream', const {
    'stdout',
    'stderr',
    'exit',
  });
  String? data;
  int? exitCode;
  if (stream == 'exit') {
    if (raw.containsKey('data')) {
      throw const WireFormatException('terminal exit cannot have data', 'data');
    }
    exitCode = _signedSafeInteger(raw['exitCode'], 'exitCode');
  } else {
    data = _boundedText(raw['data'], 'data', 256000);
    if (raw.containsKey('exitCode')) {
      throw const WireFormatException(
        'terminal output cannot have exitCode',
        'exitCode',
      );
    }
  }
  return TerminalFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    terminalId: _id(raw['terminalId'], 'terminalId'),
    stream: stream,
    data: data,
    exitCode: exitCode,
    raw: raw,
  );
}

FilesFrame _decodeFiles(Map<String, Object?> raw) {
  return FilesFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    path: _safeRelativePath(raw['path'], 'path'),
    content: raw.containsKey('content')
        ? _boundedText(raw['content'], 'content', 768 * 1024)
        : null,
    truncated: raw.containsKey('truncated')
        ? _bool(raw['truncated'], 'truncated')
        : null,
    raw: raw,
  );
}

ReviewFrame _decodeReview(Map<String, Object?> raw) {
  final values = _list(raw['findings'], 'findings');
  final findings = <Map<String, Object?>>[];
  for (var index = 0; index < values.length; index++) {
    findings.add(_map(values[index], 'findings[$index]'));
  }
  return ReviewFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    reviewId: _id(raw['reviewId'], 'reviewId'),
    status: _string(raw['status'], 'status', 64),
    path: raw.containsKey('path')
        ? _safeRelativePath(raw['path'], 'path')
        : null,
    findings: List<Map<String, Object?>>.unmodifiable(findings),
    raw: raw,
  );
}

AuditFrame _decodeAudit(Map<String, Object?> raw) {
  return AuditFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: raw.containsKey('sessionId')
        ? _id(raw['sessionId'], 'sessionId')
        : null,
    action: _string(raw['action'], 'action', 128),
    actor: _string(raw['actor'], 'actor', 256),
    timestamp: _string(raw['timestamp'], 'timestamp', 128),
    detail: raw.containsKey('detail') ? _map(raw['detail'], 'detail') : null,
    raw: raw,
  );
}

ConfirmationFrame _decodeConfirmation(Map<String, Object?> raw) {
  return ConfirmationFrame(
    confirmationId: _id(raw['confirmationId'], 'confirmationId'),
    commandId: _id(raw['commandId'], 'commandId'),
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: raw.containsKey('sessionId')
        ? _id(raw['sessionId'], 'sessionId')
        : null,
    commandHash: _string(raw['commandHash'], 'commandHash', 256),
    revision: _id(raw['revision'], 'revision'),
    expiresAt: _string(raw['expiresAt'], 'expiresAt', 128),
    summary: _nonemptyText(raw['summary'], 'summary', 2048),
    preview: raw.containsKey('preview')
        ? _nonemptyText(raw['preview'], 'preview', 8192)
        : null,
    raw: raw,
  );
}

PairOkFrame _decodePairOk(Map<String, Object?> raw) {
  final token = _string(raw['deviceToken'], 'deviceToken', 512);
  if (!RegExp(r'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$').hasMatch(token)) {
    throw const WireFormatException(
      'device token must be canonical base64url for 32 bytes',
      'deviceToken',
    );
  }
  return PairOkFrame(
    requestId: _id(raw['requestId'], 'requestId'),
    pairingId: _id(raw['pairingId'], 'pairingId'),
    deviceId: _id(raw['deviceId'], 'deviceId'),
    deviceName: _string(raw['deviceName'], 'deviceName', 256),
    platform: _string(raw['platform'], 'platform', 128),
    requestedCapabilities: _capabilityList(
      raw['requestedCapabilities'],
      'requestedCapabilities',
    ),
    grantedCapabilities: _capabilityList(
      raw['grantedCapabilities'],
      'grantedCapabilities',
    ),
    deviceToken: token,
    expiresAt: _string(raw['expiresAt'], 'expiresAt', 128),
    raw: raw,
  );
}

PairErrorFrame _decodePairError(Map<String, Object?> raw) {
  return PairErrorFrame(
    code: _string(raw['code'], 'code', 128),
    message: _nonemptyText(raw['message'], 'message', 1024),
    requestId: raw.containsKey('requestId')
        ? _id(raw['requestId'], 'requestId')
        : null,
    raw: raw,
  );
}

ByeFrame _decodeBye(Map<String, Object?> raw) => ByeFrame(
  code: _string(raw['code'], 'code', 128),
  reason: _string(raw['reason'], 'reason', 1024),
  retryable: _bool(raw['retryable'], 'retryable'),
  raw: raw,
);

WatchFrame _decodeWatch(Map<String, Object?> raw, String type) {
  final hostId = _id(raw['hostId'], 'hostId');
  final revision = _id(raw['revision'], 'revision');
  if (type == 'host.watch') {
    return HostWatchFrame(
      watchId: _id(raw['watchId'], 'watchId'),
      hostId: hostId,
      cursor: _sessionIndexCursor(raw['cursor'], 'cursor'),
      state: _enumString(raw['state'], 'state', const {
        'started',
        'stopped',
        'ready',
      }),
      revision: revision,
      raw: raw,
    );
  }
  final sessionId = _id(raw['sessionId'], 'sessionId');
  final cursor = _transcriptCursor(raw['cursor'], 'cursor');
  if (type == 'session.watch') {
    return SessionWatchFrame(
      watchId: _id(raw['watchId'], 'watchId'),
      hostId: hostId,
      sessionId: sessionId,
      cursor: cursor,
      state: _enumString(raw['state'], 'state', const {
        'started',
        'stopped',
        'ready',
      }),
      revision: revision,
      raw: raw,
    );
  }
  if (type == 'session.state') {
    return SessionStateFrame(
      hostId: hostId,
      sessionId: sessionId,
      cursor: cursor,
      state: _string(raw['state'], 'state', 128),
      revision: revision,
      raw: raw,
    );
  }
  SessionRef? upsert;
  String? remove;
  if (raw.containsKey('upsert')) {
    upsert = _sessionRef(raw['upsert'], 'upsert');
  }
  if (raw.containsKey('remove')) {
    remove = _id(raw['remove'], 'remove');
  }
  if ((upsert == null) == (remove == null)) {
    throw const WireFormatException(
      'session delta requires exactly one of upsert or remove',
      'delta',
    );
  }
  if (upsert != null &&
      (upsert.hostId != hostId || upsert.sessionId != sessionId)) {
    throw const WireFormatException(
      'upsert belongs to another session',
      'upsert',
    );
  }
  if (remove != null && remove != sessionId) {
    throw const WireFormatException(
      'remove belongs to another session',
      'remove',
    );
  }
  return SessionDeltaFrame(
    hostId: hostId,
    sessionId: sessionId,
    cursor: cursor,
    revision: revision,
    upsert: upsert,
    remove: remove,
    raw: raw,
  );
}

LeaseFrame _decodeLease(Map<String, Object?> raw, String type) {
  final expectedKind = type == 'lease' ? 'controller' : 'prompt';
  if (raw['kind'] != expectedKind) {
    throw const WireFormatException('lease kind does not match type', 'kind');
  }
  return LeaseFrame(
    frameType: type,
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    leaseId: _id(raw['leaseId'], 'leaseId'),
    cursor: _transcriptCursor(raw['cursor'], 'cursor'),
    kind: expectedKind,
    state: _enumString(raw['state'], 'state', const {
      'acquired',
      'renewed',
      'released',
      'expired',
    }),
    owner: _id(raw['owner'], 'owner'),
    expiresAt: _string(raw['expiresAt'], 'expiresAt', 128),
    revision: raw.containsKey('revision')
        ? _id(raw['revision'], 'revision')
        : null,
    raw: raw,
  );
}

AgentAdditiveFrame _decodeAgentAdditive(Map<String, Object?> raw, String type) {
  String? state;
  String? lifecycle;
  double? progress;
  String? event;
  Map<String, Object?>? detail;
  Map<String, Object?>? data;
  List<DurableEntry>? entries;
  const states = {
    'created',
    'started',
    'running',
    'completed',
    'failed',
    'cancelled',
  };
  switch (type) {
    case 'agent.state':
      state = _enumString(raw['state'], 'state', states);
      break;
    case 'agent.lifecycle':
      lifecycle = _enumString(raw['lifecycle'], 'lifecycle', states);
      break;
    case 'agent.progress':
      progress = _finiteNumber(raw['progress'], 'progress');
      if (progress < 0 || progress > 1) {
        throw const WireFormatException(
          'progress must be between zero and one',
          'progress',
        );
      }
      if (raw.containsKey('detail')) {
        detail = _map(raw['detail'], 'detail');
      }
      break;
    case 'agent.event':
      event = _string(raw['event'], 'event', 128);
      if (raw.containsKey('data')) {
        data = _map(raw['data'], 'data');
      }
      break;
    case 'agent.transcript':
      final values = _list(raw['entries'], 'entries');
      final decoded = <DurableEntry>[];
      for (var index = 0; index < values.length; index++) {
        decoded.add(_durableEntry(values[index], 'entries[$index]'));
      }
      entries = List<DurableEntry>.unmodifiable(decoded);
      break;
  }
  final hostId = _id(raw['hostId'], 'hostId');
  final sessionId = _id(raw['sessionId'], 'sessionId');
  if (entries != null) {
    for (final entry in entries) {
      if (entry.hostId != hostId || entry.sessionId != sessionId) {
        throw const WireFormatException(
          'transcript entry belongs to another session',
          'entries',
        );
      }
    }
  }
  return AgentAdditiveFrame(
    frameType: type,
    hostId: hostId,
    sessionId: sessionId,
    agentId: _id(raw['agentId'], 'agentId'),
    cursor: _transcriptCursor(raw['cursor'], 'cursor'),
    revision: _id(raw['revision'], 'revision'),
    state: state,
    lifecycle: lifecycle,
    progress: progress,
    event: event,
    detail: detail,
    data: data,
    entries: entries,
    raw: raw,
  );
}

TerminalOutputFrame _decodeTerminalOutput(Map<String, Object?> raw) {
  final encoding = raw.containsKey('encoding')
      ? _enumString(raw['encoding'], 'encoding', const {'utf8', 'base64'})
      : null;
  final data = encoding == 'base64'
      ? _base64(raw['data'], 'data', 256000)
      : _boundedText(raw['data'], 'data', 256000);
  return TerminalOutputFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    terminalId: _id(raw['terminalId'], 'terminalId'),
    cursor: _transcriptCursor(raw['cursor'], 'cursor'),
    stream: _enumString(raw['stream'], 'stream', const {'stdout', 'stderr'}),
    data: data,
    encoding: encoding,
    raw: raw,
  );
}

TerminalExitFrame _decodeTerminalExit(Map<String, Object?> raw) {
  return TerminalExitFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    terminalId: _id(raw['terminalId'], 'terminalId'),
    cursor: _transcriptCursor(raw['cursor'], 'cursor'),
    exitCode: _signedSafeInteger(raw['exitCode'], 'exitCode'),
    signal: raw.containsKey('signal')
        ? _string(raw['signal'], 'signal', 128)
        : null,
    raw: raw,
  );
}

FilesAdditiveFrame _decodeFilesAdditive(Map<String, Object?> raw, String type) {
  List<FileListEntry>? entries;
  String? content;
  String? encoding;
  String? patch;
  String? diff;
  TranscriptCursor? cursor;
  String? revision;
  String? fromRevision;
  String? toRevision;
  switch (type) {
    case 'files.list':
      final values = _list(raw['entries'], 'entries');
      final decoded = <FileListEntry>[];
      for (var index = 0; index < values.length; index++) {
        decoded.add(_fileListEntry(values[index], 'entries[$index]'));
      }
      entries = List<FileListEntry>.unmodifiable(decoded);
      if (raw.containsKey('cursor')) {
        cursor = _transcriptCursor(raw['cursor'], 'cursor');
      }
      if (raw.containsKey('revision')) {
        revision = _id(raw['revision'], 'revision');
      }
      break;
    case 'files.read':
      encoding = raw.containsKey('encoding')
          ? _enumString(raw['encoding'], 'encoding', const {'utf8', 'base64'})
          : null;
      content = encoding == 'base64'
          ? _base64(raw['content'], 'content', 768 * 1024)
          : _boundedText(raw['content'], 'content', 768 * 1024);
      if (raw.containsKey('revision')) {
        revision = _id(raw['revision'], 'revision');
      }
      break;
    case 'files.write':
      encoding = raw.containsKey('encoding')
          ? _enumString(raw['encoding'], 'encoding', const {'utf8', 'base64'})
          : null;
      content = encoding == 'base64'
          ? _base64(raw['content'], 'content', 768 * 1024)
          : _boundedText(raw['content'], 'content', 768 * 1024);
      revision = _id(raw['revision'], 'revision');
      break;
    case 'files.patch':
      patch = _boundedText(raw['patch'], 'patch', 768 * 1024);
      revision = _id(raw['revision'], 'revision');
      break;
    case 'files.diff':
      diff = _boundedText(raw['diff'], 'diff', 768 * 1024);
      if (raw.containsKey('fromRevision')) {
        fromRevision = _id(raw['fromRevision'], 'fromRevision');
      }
      if (raw.containsKey('toRevision')) {
        toRevision = _id(raw['toRevision'], 'toRevision');
      }
      break;
  }
  return FilesAdditiveFrame(
    frameType: type,
    hostId: _id(raw['hostId'], 'hostId'),
    sessionId: _id(raw['sessionId'], 'sessionId'),
    path: _safeRelativePath(raw['path'], 'path'),
    entries: entries,
    content: content,
    encoding: encoding,
    patch: patch,
    diff: diff,
    cursor: cursor,
    revision: revision,
    fromRevision: fromRevision,
    toRevision: toRevision,
    raw: raw,
  );
}

FileListEntry _fileListEntry(Object? value, String path) {
  final raw = _map(value, path);
  final size = raw.containsKey('size')
      ? _safeInteger(raw['size'], '$path.size')
      : null;
  if (size != null && size > 768 * 1024 * 1024) {
    throw WireFormatException('file size exceeds limit', '$path.size');
  }
  return FileListEntry(
    path: _safeRelativePath(raw['path'], '$path.path'),
    kind: _enumString(raw['kind'], '$path.kind', const {
      'file',
      'directory',
      'symlink',
    }),
    size: size,
    revision: raw.containsKey('revision')
        ? _id(raw['revision'], '$path.revision')
        : null,
    raw: raw,
  );
}

AuditTailFrame _decodeAuditTail(Map<String, Object?> raw) {
  final hostId = _id(raw['hostId'], 'hostId');
  final values = _list(raw['events'], 'events');
  final events = <AuditEvent>[];
  for (var index = 0; index < values.length; index++) {
    final event = _auditEvent(values[index], 'events[$index]');
    if (event.hostId != hostId) {
      throw const WireFormatException(
        'audit event belongs to another host',
        'events',
      );
    }
    events.add(event);
  }
  return AuditTailFrame(
    hostId: hostId,
    cursor: _transcriptCursor(raw['cursor'], 'cursor'),
    events: List<AuditEvent>.unmodifiable(events),
    raw: raw,
  );
}

AuditEventFrame _decodeAuditEventFrame(Map<String, Object?> raw) {
  final hostId = _id(raw['hostId'], 'hostId');
  final event = _auditEvent(raw['event'], 'event');
  if (event.hostId != hostId) {
    throw const WireFormatException(
      'audit event belongs to another host',
      'event.hostId',
    );
  }
  return AuditEventFrame(
    hostId: hostId,
    cursor: _transcriptCursor(raw['cursor'], 'cursor'),
    event: event,
    raw: raw,
  );
}

AuditEvent _auditEvent(Object? value, String path) {
  final raw = _map(value, path);
  return AuditEvent(
    eventId: _id(raw['eventId'], '$path.eventId'),
    hostId: _id(raw['hostId'], '$path.hostId'),
    sessionId: raw.containsKey('sessionId')
        ? _id(raw['sessionId'], '$path.sessionId')
        : null,
    action: _string(raw['action'], '$path.action', 128),
    actor: _string(raw['actor'], '$path.actor', 256),
    timestamp: _string(raw['timestamp'], '$path.timestamp', 128),
    detail: raw.containsKey('detail')
        ? _map(raw['detail'], '$path.detail')
        : null,
    raw: raw,
  );
}

CatalogFrame _decodeCatalog(Map<String, Object?> raw) {
  final values = _list(raw['items'], 'items');
  final items = <CatalogItem>[];
  for (var index = 0; index < values.length; index++) {
    items.add(_catalogItem(values[index], 'items[$index]'));
  }
  return CatalogFrame(
    hostId: _id(raw['hostId'], 'hostId'),
    revision: _id(raw['revision'], 'revision'),
    items: List<CatalogItem>.unmodifiable(items),
    raw: raw,
  );
}

CatalogItem _catalogItem(Object? value, String path) {
  final raw = _map(value, path);
  return CatalogItem(
    id: _id(raw['id'], '$path.id'),
    kind: _enumString(raw['kind'], '$path.kind', const {
      'tool',
      'model',
      'command',
      'setting',
      'skill',
      'agent',
      'provider',
      'mode',
    }),
    name: _string(raw['name'], '$path.name', 256),
    description: raw.containsKey('description')
        ? _boundedText(raw['description'], '$path.description', 4096)
        : null,
    capabilities: raw.containsKey('capabilities')
        ? _stringList(raw['capabilities'], '$path.capabilities', maxItems: 128)
        : null,
    supported: raw.containsKey('supported')
        ? _bool(raw['supported'], '$path.supported')
        : null,
    reason: raw.containsKey('reason')
        ? _boundedText(raw['reason'], '$path.reason', 2048)
        : null,
    metadata: raw.containsKey('metadata')
        ? _map(raw['metadata'], '$path.metadata')
        : null,
    raw: raw,
  );
}

SettingsFrame _decodeSettings(Map<String, Object?> raw) => SettingsFrame(
  hostId: _id(raw['hostId'], 'hostId'),
  revision: _id(raw['revision'], 'revision'),
  settings: _map(raw['settings'], 'settings'),
  raw: raw,
);

PreviewFrame _decodePreview(Map<String, Object?> raw, String type) {
  final hostId = _id(raw['hostId'], 'hostId');
  final sessionId = _id(raw['sessionId'], 'sessionId');
  if (type == 'preview.error') {
    return PreviewFrame(
      frameType: type,
      hostId: hostId,
      sessionId: sessionId,
      snapshot: null,
      previewId: _id(raw['previewId'], 'previewId'),
      cursor: _transcriptCursor(raw['cursor'], 'cursor'),
      revision: _id(raw['revision'], 'revision'),
      code: _string(raw['code'], 'code', 128),
      message: _boundedText(raw['message'], 'message', 2048),
      error: null,
      raw: raw,
    );
  }
  final snapshot = _previewSnapshot(raw);
  if (type == 'preview.capture' && snapshot.capture == null) {
    throw const WireFormatException(
      'preview capture frame requires capture metadata',
      'capture',
    );
  }
  return PreviewFrame(
    frameType: type,
    hostId: hostId,
    sessionId: sessionId,
    snapshot: snapshot,
    previewId: snapshot.previewId,
    cursor: snapshot.cursor,
    revision: snapshot.revision,
    code: null,
    message: null,
    error: type == 'preview.state' && raw.containsKey('error')
        ? _boundedText(raw['error'], 'error', 2048)
        : null,
    raw: raw,
  );
}

PreviewSnapshot _previewSnapshot(Map<String, Object?> raw) {
  final url = _string(raw['url'], 'preview.url', 4096);
  final uri = Uri.tryParse(url);
  if (uri == null ||
      !uri.hasScheme ||
      (uri.scheme != 'http' && uri.scheme != 'https') ||
      uri.userInfo.isNotEmpty) {
    throw const WireFormatException(
      'preview URL must be http(s) without credentials',
      'preview.url',
    );
  }
  Map<String, Object?>? viewport;
  if (raw.containsKey('viewport')) {
    viewport = _map(raw['viewport'], 'preview.viewport');
    final width = _safeInteger(viewport['width'], 'preview.viewport.width');
    final height = _safeInteger(viewport['height'], 'preview.viewport.height');
    if (width == 0 || height == 0 || width * height > 16 * 1024 * 1024) {
      throw const WireFormatException(
        'preview viewport dimensions exceed limit',
        'preview.viewport',
      );
    }
    if (viewport.containsKey('deviceScaleFactor')) {
      final scale = _finiteNumber(
        viewport['deviceScaleFactor'],
        'preview.viewport.deviceScaleFactor',
      );
      if (scale <= 0 || scale > 8) {
        throw const WireFormatException(
          'preview device scale factor exceeds limit',
          'preview.viewport.deviceScaleFactor',
        );
      }
    }
  }
  final capture = raw.containsKey('capture')
      ? _previewCapture(raw['capture'], 'preview.capture')
      : null;
  final authority = raw.containsKey('authority')
      ? _previewAuthority(raw['authority'], 'preview.authority')
      : null;
  List<String>? actions;
  if (raw.containsKey('availableActions')) {
    actions = _stringList(
      raw['availableActions'],
      'preview.availableActions',
      maxItems: 15,
    );
    const allowed = {
      'activate',
      'navigate',
      'back',
      'forward',
      'reload',
      'close',
      'capture',
      'click',
      'fill',
      'type',
      'press',
      'scroll',
      'select',
      'upload',
      'handoff',
    };
    if (actions.any((action) => !allowed.contains(action)) ||
        actions.toSet().length != actions.length) {
      throw const WireFormatException(
        'preview actions must be known and unique',
        'preview.availableActions',
      );
    }
  }
  return PreviewSnapshot(
    previewId: _id(raw['previewId'], 'preview.previewId'),
    state: _enumString(raw['state'], 'preview.state', const {
      'launching',
      'ready',
      'running',
      'stopped',
      'failed',
    }),
    url: url,
    revision: _id(raw['revision'], 'preview.revision'),
    cursor: _transcriptCursor(raw['cursor'], 'preview.cursor'),
    title: raw.containsKey('title')
        ? _boundedText(raw['title'], 'preview.title', 512)
        : null,
    canGoBack: raw.containsKey('canGoBack')
        ? _bool(raw['canGoBack'], 'preview.canGoBack')
        : null,
    canGoForward: raw.containsKey('canGoForward')
        ? _bool(raw['canGoForward'], 'preview.canGoForward')
        : null,
    viewport: viewport,
    capture: capture,
    authority: authority,
    availableActions: actions,
  );
}

Map<String, Object?> _previewCapture(Object? value, String path) {
  final raw = _map(value, path);
  _id(raw['captureId'], '$path.captureId');
  _enumString(raw['mimeType'], '$path.mimeType', const {
    'image/png',
    'image/jpeg',
    'image/webp',
  });
  final size = _safeInteger(raw['size'], '$path.size');
  final width = _safeInteger(raw['width'], '$path.width');
  final height = _safeInteger(raw['height'], '$path.height');
  if (size == 0 || size > 8 * 1024 * 1024) {
    throw WireFormatException(
      'preview capture size exceeds limit',
      '$path.size',
    );
  }
  if (width == 0 || height == 0 || width * height > 16 * 1024 * 1024) {
    throw WireFormatException('preview capture dimensions exceed limit', path);
  }
  _safeInteger(raw['capturedAt'], '$path.capturedAt');
  final digest = _string(raw['sha256'], '$path.sha256', 64);
  if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(digest)) {
    throw WireFormatException(
      'preview capture digest must be lowercase sha256',
      '$path.sha256',
    );
  }
  return raw;
}

Map<String, Object?> _previewAuthority(Object? value, String path) {
  final raw = _map(value, path);
  _string(raw['id'], '$path.id', 128);
  _boundedText(raw['label'], '$path.label', 256);
  _enumString(raw['kind'], '$path.kind', const {
    'isolated-session',
    'authenticated-profile',
  });
  _bool(raw['requiresExplicitOptIn'], '$path.requiresExplicitOptIn');
  return raw;
}

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

const Set<String> _deviceCapabilities = {
  'sessions.read',
  'sessions.prompt',
  'sessions.control',
  'sessions.manage',
  'bash.run',
  'term.open',
  'term.input',
  'term.resize',
  'files.read',
  'files.write',
  'files.list',
  'files.diff',
  'agents.control',
  'audit.read',
  'config.read',
  'catalog.read',
  'config.write',
  'broker.read',
  'usage.read',
  'preview.read',
  'preview.control',
  'preview.input',
};

List<String> _capabilityList(Object? value, String path) {
  final capabilities = _stringList(value, path, maxItems: 128);
  for (var index = 0; index < capabilities.length; index++) {
    if (!_deviceCapabilities.contains(capabilities[index])) {
      throw WireFormatException('unknown device capability', '$path[$index]');
    }
  }
  return capabilities;
}

String _enumString(Object? value, String path, Set<String> allowed) {
  final result = _string(value, path, 128);
  if (!allowed.contains(result)) {
    throw WireFormatException('unknown discriminant $result', path);
  }
  return result;
}

String _boundedText(Object? value, String path, int maxBytes) {
  if (value is! String || !_utf8LengthAtMost(value, maxBytes)) {
    throw WireFormatException('expected bounded text', path);
  }
  return value;
}

double _finiteNumber(Object? value, String path) {
  if (value is! num || !value.isFinite) {
    throw WireFormatException('expected finite number', path);
  }
  return value.toDouble();
}

int _signedSafeInteger(Object? value, String path) {
  if (value is! num ||
      !value.isFinite ||
      value.abs() > _maxSafeInteger ||
      value.truncateToDouble() != value) {
    throw WireFormatException('expected a safe integer', path);
  }
  return value.toInt();
}

String _base64(Object? value, String path, int maxDecodedBytes) {
  final text = _boundedText(
    value,
    path,
    ((maxDecodedBytes * 4) / 3).ceil() + 4,
  );
  final valid = RegExp(
    r'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
  );
  if (text.length % 4 != 0 || !valid.hasMatch(text)) {
    throw WireFormatException('invalid base64 payload', path);
  }
  late final List<int> decoded;
  try {
    decoded = base64.decode(text);
  } on FormatException {
    throw WireFormatException('invalid base64 payload', path);
  }
  if (decoded.length > maxDecodedBytes) {
    throw WireFormatException('decoded payload exceeds protocol limit', path);
  }
  return text;
}

String _safeRelativePath(Object? value, String path) {
  final result = _string(value, path, 4096);
  if (result.contains(r'\') ||
      result.startsWith('/') ||
      RegExp(r'^[A-Za-z]:').hasMatch(result) ||
      result.startsWith('~')) {
    throw WireFormatException('path must be a safe relative POSIX path', path);
  }
  final parts = result.split('/');
  if (parts.any((part) => part.isEmpty || part == '.' || part == '..')) {
    throw WireFormatException('path contains an unsafe segment', path);
  }
  return result;
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

Object? _freezeJsonCopy(Object? value, _JsonBudget budget, int depth) {
  budget.nodes++;
  if (budget.nodes > _maxJsonNodes) {
    throw const WireFormatException('JSON value has too many nodes');
  }
  if (depth > _maxJsonDepth) {
    throw const WireFormatException('JSON value is nested too deeply');
  }
  if (value is Map<String, Object?>) {
    if (value.length > _maxMapKeys) {
      throw const WireFormatException('JSON object has too many keys');
    }
    final copy = <String, Object?>{};
    for (final entry in value.entries) {
      copy[entry.key] = _freezeJsonCopy(entry.value, budget, depth + 1);
    }
    return UnmodifiableMapView<String, Object?>(copy);
  }
  if (value is List<Object?>) {
    if (value.length > _maxArrayItems) {
      throw const WireFormatException('JSON array has too many items');
    }
    return UnmodifiableListView<Object?>(
      value
          .map((child) => _freezeJsonCopy(child, budget, depth + 1))
          .toList(growable: false),
    );
  }
  if (value == null || value is bool || value is String) {
    return value;
  }
  if (value is num && value.isFinite) {
    return value;
  }
  throw const WireFormatException('expected JSON-compatible value');
}
