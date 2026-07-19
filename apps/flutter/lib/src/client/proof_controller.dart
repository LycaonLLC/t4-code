import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../protocol/protocol.dart';
import 'proof_state.dart';

final class ProofController extends ChangeNotifier implements ProofActions {
  ProofController({required this.endpoint});

  final Uri? endpoint;

  final LinkedHashMap<String, TranscriptMessage> _messages = LinkedHashMap();
  final Map<String, TranscriptCursor> _savedCursors =
      <String, TranscriptCursor>{};
  final Map<String, _PendingCommand> _pendingCommands =
      <String, _PendingCommand>{};

  WebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  Timer? _reconnectTimer;
  List<SessionSummary> _sessions = const <SessionSummary>[];
  ConnectionPhase _phase = ConnectionPhase.disconnected;
  String? _selectedSessionId;
  String? _errorMessage;
  String? _hostId;
  bool _submitting = false;
  bool _disposed = false;
  int _connectionGeneration = 0;
  int _commandOrdinal = 0;
  int _reconnectAttempt = 0;

  ProofViewState get state => ProofViewState(
    connectionPhase: _phase,
    sessions: List<SessionSummary>.unmodifiable(_sessions),
    selectedSessionId: _selectedSessionId,
    messages: List<TranscriptMessage>.unmodifiable(_messages.values),
    errorMessage: _errorMessage,
    submitting: _submitting,
  );

  @override
  Future<void> connect() async {
    final target = endpoint;
    if (target == null) {
      _fail(
        'No fixture endpoint was supplied. Start the fixture server and pass T4_FIXTURE_URL.',
      );
      return;
    }

    final generation = ++_connectionGeneration;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final previousSubscription = _subscription;
    _subscription = null;
    await previousSubscription?.cancel();
    await _channel?.sink.close();
    if (_disposed || generation != _connectionGeneration) return;

    _phase = _reconnectAttempt == 0
        ? ConnectionPhase.connecting
        : ConnectionPhase.retrying;
    _errorMessage = null;
    _publish();

    try {
      final channel = WebSocketChannel.connect(target);
      _channel = channel;
      await channel.ready;
      if (_disposed || generation != _connectionGeneration) {
        await channel.sink.close();
        return;
      }
      _subscription = channel.stream.listen(
        (message) => _handlePayload(generation, message),
        onError: (Object error, StackTrace stackTrace) =>
            _handleTransportLoss(generation, error),
        onDone: () => _handleTransportLoss(generation),
        cancelOnError: true,
      );
      _phase = ConnectionPhase.synchronizing;
      _publish();
      channel.sink.add(
        WireEncoder.hello(
          client: ClientIdentity(
            name: 'T4 Code',
            version: '0.1.24',
            build: 'flutter-stage1',
            platform: defaultTargetPlatform.name,
          ),
          requestedFeatures: const <String>['resume'],
          savedCursors: _savedCursors.entries
              .map((entry) {
                final session = _sessions
                    .where((candidate) => candidate.sessionId == entry.key)
                    .firstOrNull;
                return SavedCursor(
                  hostId: session?.hostId ?? _hostId ?? '',
                  sessionId: entry.key,
                  cursor: entry.value,
                );
              })
              .where((cursor) => cursor.hostId.isNotEmpty),
        ),
      );
    } on Object catch (error) {
      _handleTransportLoss(generation, error);
    }
  }

  @override
  Future<void> selectSession(String sessionId) async {
    if (_selectedSessionId == sessionId && _phase == ConnectionPhase.ready) {
      return;
    }
    final known = _sessions.any((session) => session.sessionId == sessionId);
    if (!known) return;
    _selectedSessionId = sessionId;
    _messages.clear();
    _phase = ConnectionPhase.synchronizing;
    _errorMessage = null;
    _publish();
    _sendAttach(sessionId, cursor: _savedCursors[sessionId]);
  }

  @override
  Future<void> submitPrompt(String message) async {
    final text = message.trim();
    final session = state.selectedSession;
    if (text.isEmpty ||
        session == null ||
        _phase != ConnectionPhase.ready ||
        _submitting) {
      return;
    }

    final ids = _nextCommandIds('prompt');
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: 'session.prompt',
    );
    _messages['local-${ids.commandId}'] = TranscriptMessage(
      id: 'local-${ids.commandId}',
      role: MessageRole.user,
      text: text,
    );
    _submitting = true;
    _errorMessage = null;
    _publish();
    _send(
      WireEncoder.sessionPrompt(
        requestId: ids.requestId,
        commandId: ids.commandId,
        hostId: session.hostId,
        sessionId: session.sessionId,
        expectedRevision: session.revision,
        text: text,
      ),
    );
  }

  void _handlePayload(int generation, Object? payload) {
    if (_disposed || generation != _connectionGeneration) return;
    try {
      final encoded = switch (payload) {
        String value => value,
        List<int> value => utf8.decode(value, allowMalformed: false),
        _ => throw const FormatException('unsupported websocket payload'),
      };
      _applyFrame(WireDecoder.decode(encoded));
    } on Object catch (error) {
      _connectionGeneration += 1;
      _reconnectTimer?.cancel();
      _fail('Protocol error: $error');
      unawaited(_subscription?.cancel());
      unawaited(_channel?.sink.close());
    }
  }

  void _applyFrame(WireFrame frame) {
    switch (frame) {
      case WelcomeFrame():
        _hostId = frame.hostId;
        _reconnectAttempt = 0;
      case SessionsFrame():
        _applySessions(frame);
      case SnapshotFrame():
        _applySnapshot(frame);
      case EntryFrame():
        if (_acceptTranscriptCursor(frame.sessionId, frame.cursor)) {
          _upsertEntry(frame.entry);
          _publish();
        }
      case EventFrame():
        if (_acceptTranscriptCursor(frame.sessionId, frame.cursor)) {
          _applyEvent(frame.event);
          _publish();
        }
      case ResponseFrame():
        _applyResponse(frame);
      case ErrorFrame():
        _errorMessage = frame.message;
        _submitting = false;
        _publish();
      case GapFrame():
        _phase = ConnectionPhase.synchronizing;
        _errorMessage = 'Recovering transcript continuity…';
        _publish();
      case PingFrame():
        _send(WireEncoder.pong(nonce: frame.nonce, timestamp: frame.timestamp));
      case PongFrame():
        break;
    }
  }

  void _applySessions(SessionsFrame frame) {
    _sessions = frame.sessions
        .map(
          (session) => SessionSummary(
            hostId: session.hostId,
            sessionId: session.sessionId,
            title: session.title,
            revision: session.revision,
            status: session.status,
          ),
        )
        .toList(growable: false);
    final selectedStillExists = _sessions.any(
      (session) => session.sessionId == _selectedSessionId,
    );
    if (!selectedStillExists) {
      _selectedSessionId = _sessions.firstOrNull?.sessionId;
    }
    final selected = _selectedSessionId;
    if (selected == null) {
      _phase = ConnectionPhase.ready;
      _publish();
      return;
    }
    _publish();
    _sendAttach(selected, cursor: _savedCursors[selected]);
  }

  void _applySnapshot(SnapshotFrame frame) {
    if (_selectedSessionId != frame.sessionId) return;
    _messages.clear();
    for (final entry in frame.entries) {
      _upsertEntry(entry);
    }
    _savedCursors[frame.sessionId] = frame.cursor;
    _sessions = _sessions
        .map(
          (session) => session.sessionId == frame.sessionId
              ? SessionSummary(
                  hostId: session.hostId,
                  sessionId: session.sessionId,
                  title: session.title,
                  revision: frame.revision,
                  status: session.status,
                )
              : session,
        )
        .toList(growable: false);
    _phase = ConnectionPhase.ready;
    _errorMessage = null;
    _publish();
  }

  bool _acceptTranscriptCursor(String sessionId, TranscriptCursor next) {
    final current = _savedCursors[sessionId];
    if (current == null) {
      _savedCursors[sessionId] = next;
      return true;
    }
    if (next.epoch == current.epoch && next.seq <= current.seq) return false;
    if (next.epoch != current.epoch || next.seq != current.seq + 1) {
      _phase = ConnectionPhase.synchronizing;
      _errorMessage = 'Transcript continuity changed; waiting for a snapshot.';
      _publish();
      return false;
    }
    _savedCursors[sessionId] = next;
    return true;
  }

  void _upsertEntry(DurableEntry entry) {
    final data = entry.data;
    final text = data['text'];
    if (entry.kind != 'message' || text is! String) return;
    _messages[entry.id] = TranscriptMessage(
      id: entry.id,
      role: _messageRole(data['role']),
      text: text,
    );
  }

  void _applyEvent(Map<String, Object?> event) {
    switch (event['type']) {
      case 'message.update':
        final entryId = event['entryId'];
        final text = event['text'];
        if (entryId is String && text is String) {
          _messages[entryId] = TranscriptMessage(
            id: entryId,
            role: _messageRole(event['role']),
            text: text,
            streaming: true,
          );
        }
      case 'message.settled':
        final transientEntryId = event['transientEntryId'];
        if (transientEntryId is String) _messages.remove(transientEntryId);
      case 'agent.start':
        _submitting = true;
      case 'agent.end':
        _submitting = false;
      case 'turn.error':
        _submitting = false;
        final message = event['message'];
        _errorMessage = message is String ? message : 'The agent turn failed.';
    }
  }

  void _applyResponse(ResponseFrame frame) {
    final pending = _pendingCommands.remove(frame.requestId);
    if (pending == null ||
        pending.commandId != frame.commandId ||
        pending.command != frame.command) {
      throw const FormatException('response correlation mismatch');
    }
    if (!frame.ok) {
      _submitting = false;
      _errorMessage = frame.error?.message ?? 'Command failed.';
      _publish();
      return;
    }
    if (frame.command == 'session.attach') {
      if (_messages.isNotEmpty ||
          _savedCursors.containsKey(_selectedSessionId)) {
        _phase = ConnectionPhase.ready;
      }
    }
    _publish();
  }

  void _sendAttach(String sessionId, {TranscriptCursor? cursor}) {
    final session = _sessions
        .where((item) => item.sessionId == sessionId)
        .firstOrNull;
    if (session == null) return;
    final ids = _nextCommandIds('attach');
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: 'session.attach',
    );
    _send(
      WireEncoder.sessionAttach(
        requestId: ids.requestId,
        commandId: ids.commandId,
        hostId: session.hostId,
        sessionId: session.sessionId,
        cursor: cursor,
      ),
    );
  }

  ({String requestId, String commandId}) _nextCommandIds(String prefix) {
    final ordinal = ++_commandOrdinal;
    return (
      requestId: '$prefix-request-$ordinal',
      commandId: '$prefix-command-$ordinal',
    );
  }

  void _send(String encoded) {
    final channel = _channel;
    if (channel == null) throw StateError('websocket is not connected');
    channel.sink.add(encoded);
  }

  void _handleTransportLoss(int generation, [Object? error]) {
    if (_disposed || generation != _connectionGeneration) return;
    _subscription = null;
    _channel = null;
    _pendingCommands.clear();
    _submitting = false;
    _reconnectAttempt += 1;
    final exponent = (_reconnectAttempt - 1).clamp(0, 4);
    final delay = Duration(milliseconds: 500 * (1 << exponent));
    _phase = ConnectionPhase.retrying;
    _errorMessage = error == null
        ? 'Connection closed. Retrying…'
        : 'Connection lost: $error';
    _publish();
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () {
      if (!_disposed && generation == _connectionGeneration) {
        unawaited(connect());
      }
    });
  }

  MessageRole _messageRole(Object? role) => switch (role) {
    'user' => MessageRole.user,
    'system' => MessageRole.system,
    'tool' => MessageRole.tool,
    _ => MessageRole.assistant,
  };

  void _fail(String message) {
    _phase = ConnectionPhase.failed;
    _errorMessage = message;
    _submitting = false;
    _publish();
  }

  void _publish() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _connectionGeneration += 1;
    _reconnectTimer?.cancel();
    unawaited(_subscription?.cancel());
    unawaited(_channel?.sink.close());
    super.dispose();
  }
}

final class _PendingCommand {
  const _PendingCommand({required this.commandId, required this.command});

  final String commandId;
  final String command;
}
