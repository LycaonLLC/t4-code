import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../host/host_profile.dart';
import '../protocol/protocol.dart';
import 'app_state.dart';
import 'web_socket_connector.dart';

final class T4ClientController extends ChangeNotifier implements T4Actions {
  T4ClientController({
    required this.hostDirectoryStore,
    required this.hostCredentialStore,
    WebSocketConnector? webSocketConnector,
    this.developmentEndpoint,
  }) : _webSocketConnector = webSocketConnector ?? connectPlatformWebSocket;

  final HostDirectoryStore hostDirectoryStore;
  final HostCredentialStore hostCredentialStore;
  final WebSocketConnector _webSocketConnector;
  final Uri? developmentEndpoint;

  final LinkedHashMap<String, TranscriptMessage> _messages = LinkedHashMap();
  final Map<String, TranscriptCursor> _savedCursors =
      <String, TranscriptCursor>{};
  final Map<String, _PendingCommand> _pendingCommands =
      <String, _PendingCommand>{};

  HostDirectory _hostDirectory = const HostDirectory.empty();
  WebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  WebSocketChannel? _hostProbe;
  Timer? _reconnectTimer;
  List<SessionSummary> _sessions = const <SessionSummary>[];
  ConnectionPhase _phase = ConnectionPhase.disconnected;
  AuthenticationPhase _authenticationPhase = AuthenticationPhase.unknown;
  String? _selectedSessionId;
  String? _errorMessage;
  String? _hostId;
  _PendingPair? _pendingPair;
  Set<String> _grantedCapabilities = const <String>{};
  Set<String> _grantedFeatures = const <String>{};
  Future<void>? _initialization;
  bool _initialized = false;
  bool _hostOperationPending = false;
  bool _submitting = false;
  bool _directoryLoaded = false;
  bool _disposed = false;
  int _connectionGeneration = 0;
  int _hostOperationGeneration = 0;
  int? _hostProbeOperation;
  bool _reconnectEnabled = true;
  int _bootstrapGeneration = -1;
  int _commandOrdinal = 0;
  int _reconnectAttempt = 0;

  T4ViewState get state => T4ViewState(
    connectionPhase: _phase,
    sessions: List<SessionSummary>.unmodifiable(_sessions),
    selectedSessionId: _selectedSessionId,
    messages: List<TranscriptMessage>.unmodifiable(_messages.values),
    errorMessage: _errorMessage,
    hostDirectory: _hostDirectory,
    authenticationPhase: _authenticationPhase,
    grantedCapabilities: Set<String>.unmodifiable(_grantedCapabilities),
    grantedFeatures: Set<String>.unmodifiable(_grantedFeatures),
    targetConfigured: developmentEndpoint != null || _activeProfile != null,
    hostOperationPending: _hostOperationPending,
    submitting: _submitting,
  );

  Future<void> initialize() => _initialization ??= _initialize();

  Future<void> _initialize() async {
    try {
      final directory = await hostDirectoryStore.load();
      if (_disposed) return;
      _hostDirectory = directory;
      _initialized = true;
      _directoryLoaded = true;
      _errorMessage = null;
      _publish();
      await _connectCurrent();
    } on Object catch (error) {
      if (_disposed) return;
      _initialized = true;
      _fail('Could not load saved hosts: $error');
    }
  }

  @override
  Future<void> connect() async {
    _reconnectEnabled = true;
    if (!_initialized) {
      await initialize();
      return;
    }
    await _connectCurrent();
  }

  @override
  Future<void> disconnect() async {
    _reconnectEnabled = false;
    _connectionGeneration += 1;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final previousSubscription = _subscription;
    final previousChannel = _channel;
    _subscription = null;
    _channel = null;
    _pendingCommands.clear();
    _pendingPair = null;
    _submitting = false;
    _hostId = null;
    _grantedCapabilities = const <String>{};
    _grantedFeatures = const <String>{};
    _bootstrapGeneration = -1;
    _reconnectAttempt = 0;
    _phase = ConnectionPhase.disconnected;
    _authenticationPhase = AuthenticationPhase.unknown;
    _errorMessage = null;
    _publish();
    await previousSubscription?.cancel();
    await previousChannel?.sink.close();
  }

  @override
  void cancelHostProbe() {
    final operation = _hostProbeOperation;
    if (operation == null) return;
    _hostOperationGeneration += 1;
    _hostProbeOperation = null;
    final probe = _hostProbe;
    _hostProbe = null;
    _hostOperationPending = false;
    _errorMessage = null;
    _publish();
    if (probe != null) unawaited(probe.sink.close());
  }

  Future<void> _connectCurrent() async {
    final profile = developmentEndpoint == null ? _activeProfile : null;
    final target = developmentEndpoint ?? profile?.webSocketUrl;
    final generation = ++_connectionGeneration;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    final previousSubscription = _subscription;
    final previousChannel = _channel;
    _subscription = null;
    _channel = null;
    await previousSubscription?.cancel();
    await previousChannel?.sink.close();
    if (_disposed || generation != _connectionGeneration) return;

    if (target == null) {
      _phase = ConnectionPhase.disconnected;
      _authenticationPhase = AuthenticationPhase.unknown;
      _errorMessage = 'Add a host to connect.';
      _publish();
      return;
    }

    _phase = _reconnectAttempt == 0
        ? ConnectionPhase.connecting
        : ConnectionPhase.retrying;
    _authenticationPhase = AuthenticationPhase.unknown;
    _grantedCapabilities = const <String>{};
    _grantedFeatures = const <String>{};
    _errorMessage = null;
    _publish();

    WebSocketChannel? connectingChannel;
    try {
      final credentials = profile == null
          ? null
          : await hostCredentialStore.read(profile);
      if (_disposed || generation != _connectionGeneration) return;

      connectingChannel = await _webSocketConnector(target);
      await connectingChannel.ready;
      if (_disposed || generation != _connectionGeneration) {
        await connectingChannel.sink.close();
        return;
      }
      _channel = connectingChannel;
      _subscription = connectingChannel.stream.listen(
        (message) => unawaited(_handlePayload(generation, message)),
        onError: (Object error, StackTrace stackTrace) =>
            _handleTransportLoss(generation, error),
        onDone: () => _handleTransportLoss(generation),
        cancelOnError: true,
      );
      _phase = ConnectionPhase.synchronizing;
      _publish();
      connectingChannel.sink.add(_hello(credentials));
    } on Object catch (error) {
      if (connectingChannel != null && connectingChannel != _channel) {
        await connectingChannel.sink.close();
      }
      _handleTransportLoss(generation, error);
    }
  }

  String _hello(DeviceCredentials? credentials) => WireEncoder.hello(
    client: ClientIdentity(
      name: 'T4 Code',
      version: '0.1.24',
      build: 'flutter',
      platform: defaultTargetPlatform.name,
    ),
    requestedFeatures: const <String>['resume', 'host.watch'],
    capabilities: t4RequestedCapabilities,
    authentication: credentials == null
        ? null
        : DeviceAuthentication(
            deviceId: credentials.deviceId,
            deviceToken: credentials.deviceToken,
          ),
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
  );

  HostProfile? get _activeProfile => _hostDirectory.activeProfile;

  @override
  Future<void> addHost(
    String address, {
    String profileId = defaultHostProfileId,
  }) async {
    if (!_initialized) await initialize();
    if (_disposed || !_directoryLoaded) {
      throw StateError('Saved hosts are unavailable.');
    }
    if (_hostOperationPending) return;
    final operation = ++_hostOperationGeneration;
    _hostProbeOperation = operation;
    _hostOperationPending = true;
    _errorMessage = null;
    _publish();
    WebSocketChannel? probe;
    try {
      final profile = HostProfile.parseTailnetAddress(
        address,
        profileId: profileId,
      );
      probe = await _webSocketConnector(profile.webSocketUrl);
      if (!_acceptHostOperation(operation)) {
        await probe.sink.close();
        return;
      }
      _hostProbe = probe;
      await probe.ready;
      await probe.sink.close();
      probe = null;
      _hostProbe = null;
      if (!_acceptHostOperation(operation)) return;

      final next = _hostDirectory.upsert(profile);
      await hostDirectoryStore.save(next);
      if (!_acceptHostOperation(operation)) return;
      final switched = _hostDirectory.activeEndpointKey != profile.endpointKey;
      _hostDirectory = next;
      if (switched) _clearTargetProjection();
      _hostOperationPending = false;
      _reconnectEnabled = true;
      _publish();
      await _connectCurrent();
    } on Object catch (error) {
      if (probe != null) await probe.sink.close();
      if (!_acceptHostOperation(operation)) return;
      _hostOperationPending = false;
      _errorMessage = 'Could not add host: $error';
      _publish();
      rethrow;
    } finally {
      if (_hostProbeOperation == operation) _hostProbeOperation = null;
      if (identical(_hostProbe, probe)) _hostProbe = null;
    }
  }

  @override
  Future<void> activateHost(String endpointKey) async {
    if (!_initialized) await initialize();
    if (_disposed || !_directoryLoaded) {
      throw StateError('Saved hosts are unavailable.');
    }
    if (_hostOperationPending ||
        endpointKey == _hostDirectory.activeEndpointKey) {
      return;
    }
    final operation = ++_hostOperationGeneration;
    _hostOperationPending = true;
    _errorMessage = null;
    _publish();
    try {
      final next = _hostDirectory.activate(endpointKey);
      await hostDirectoryStore.save(next);
      if (!_acceptHostOperation(operation)) return;
      _hostDirectory = next;
      _clearTargetProjection();
      _hostOperationPending = false;
      _publish();
      _reconnectEnabled = true;
      await _connectCurrent();
    } on Object catch (error) {
      if (!_acceptHostOperation(operation)) return;
      _hostOperationPending = false;
      _errorMessage = 'Could not switch hosts: $error';
      _publish();
      rethrow;
    }
  }

  @override
  Future<void> removeHost(String endpointKey) async {
    if (!_initialized) await initialize();
    if (_disposed || !_directoryLoaded) {
      throw StateError('Saved hosts are unavailable.');
    }
    if (_hostOperationPending) return;
    HostProfile? profile;
    for (final candidate in _hostDirectory.profiles) {
      if (candidate.endpointKey == endpointKey) profile = candidate;
    }
    if (profile == null) return;

    final operation = ++_hostOperationGeneration;
    final previous = _hostDirectory;
    final next = previous.remove(endpointKey);
    final removedActive = previous.activeEndpointKey == endpointKey;
    _hostOperationPending = true;
    _errorMessage = null;
    _publish();
    try {
      await hostDirectoryStore.save(next);
      if (!_acceptHostOperation(operation)) return;
      try {
        await hostCredentialStore.delete(profile);
      } on Object {
        await hostDirectoryStore.save(previous);
        if (!_acceptHostOperation(operation)) return;
        throw StateError(
          'Could not remove host credentials; the host was restored.',
        );
      }
      if (!_acceptHostOperation(operation)) return;
      _hostDirectory = next;
      if (removedActive) _clearTargetProjection();
      _hostOperationPending = false;
      _publish();
      if (removedActive) await _connectCurrent();
    } on Object catch (error) {
      if (!_acceptHostOperation(operation)) return;
      _hostOperationPending = false;
      _errorMessage = 'Could not remove host: $error';
      _publish();
      rethrow;
    }
  }

  bool _acceptHostOperation(int operation) =>
      !_disposed && operation == _hostOperationGeneration;

  @override
  Future<void> pairHost(String code) async {
    if (!RegExp(r'^\d{6}$').hasMatch(code)) {
      _errorMessage = 'Enter the six-digit pairing code.';
      _publish();
      return;
    }
    final profile = developmentEndpoint == null ? _activeProfile : null;
    if (profile == null ||
        _authenticationPhase != AuthenticationPhase.pairingRequired ||
        _pendingPair != null) {
      return;
    }
    final ids = _nextCommandIds('pair');
    final deviceId = _newDeviceId();
    final pending = _PendingPair(
      requestId: ids.requestId,
      endpointKey: profile.endpointKey,
      deviceId: deviceId,
      deviceName: 'T4 Code',
      platform: defaultTargetPlatform.name,
      requestedCapabilities: t4RequestedCapabilities,
    );
    _pendingPair = pending;
    _authenticationPhase = AuthenticationPhase.pairing;
    _errorMessage = null;
    _publish();
    _send(
      WireEncoder.pairStart(
        requestId: pending.requestId,
        code: code,
        deviceId: pending.deviceId,
        deviceName: pending.deviceName,
        platform: pending.platform,
        requestedCapabilities: pending.requestedCapabilities,
      ),
    );
  }

  String _newDeviceId() {
    final random = Random.secure();
    final bytes = List<int>.generate(24, (_) => random.nextInt(256));
    return base64Url.encode(bytes).replaceAll('=', '');
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
      sessionId: session.sessionId,
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

  Future<void> _handlePayload(int generation, Object? payload) async {
    if (_disposed || generation != _connectionGeneration) return;
    try {
      final encoded = switch (payload) {
        String value => value,
        List<int> value => utf8.decode(value, allowMalformed: false),
        _ => throw const FormatException('unsupported websocket payload'),
      };
      final frame = WireDecoder.decode(encoded);
      if (frame case PairOkFrame()) {
        await _applyPairOk(generation, frame);
      } else {
        _applyFrame(frame);
      }
    } on Object catch (error) {
      if (_disposed || generation != _connectionGeneration) return;
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
        _authenticationPhase = switch (frame.authentication) {
          'local' => AuthenticationPhase.local,
          'pairing-required' => AuthenticationPhase.pairingRequired,
          'paired' => AuthenticationPhase.paired,
          _ => throw const FormatException('unknown authentication state'),
        };
        _grantedCapabilities = frame.grantedCapabilities.toSet();
        _grantedFeatures = frame.grantedFeatures.toSet();
        if (_authenticationPhase != AuthenticationPhase.pairingRequired &&
            !_grantedCapabilities.contains('sessions.read')) {
          _phase = ConnectionPhase.ready;
          _errorMessage =
              'This device cannot read sessions. Pair again with '
              'sessions.read permission.';
          _publish();
          return;
        }
        _publish();
        if (_grantedCapabilities.contains('sessions.read') &&
            _authenticationPhase != AuthenticationPhase.pairingRequired &&
            _bootstrapGeneration != _connectionGeneration) {
          _bootstrapGeneration = _connectionGeneration;
          _sendSessionList();
        }
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
      case PairErrorFrame():
        _applyPairError(frame);
      case ErrorFrame():
        _errorMessage = frame.message;
        _submitting = false;
        _publish();
      case GapFrame():
        _phase = ConnectionPhase.synchronizing;
        _errorMessage = 'Recovering transcript continuity…';
        _publish();
      default:
        break;
    }
  }

  Future<void> _applyPairOk(int generation, PairOkFrame frame) async {
    final pending = _pendingPair;
    if (pending == null || frame.requestId != pending.requestId) {
      throw const FormatException('pairing response correlation mismatch');
    }
    final requested = pending.requestedCapabilities.toSet();
    final expiration = DateTime.tryParse(frame.expiresAt);
    if (frame.deviceId != pending.deviceId ||
        frame.deviceName != pending.deviceName ||
        frame.platform != pending.platform ||
        frame.requestedCapabilities.any(
          (value) => !requested.contains(value),
        ) ||
        frame.grantedCapabilities.any((value) => !requested.contains(value)) ||
        expiration == null ||
        !expiration.isAfter(DateTime.now().toUtc())) {
      throw const FormatException('pairing response identity mismatch');
    }
    final profile = _activeProfile;
    if (profile == null || profile.endpointKey != pending.endpointKey) return;
    _pendingPair = null;
    await hostCredentialStore.write(
      profile,
      DeviceCredentials(
        deviceId: frame.deviceId,
        deviceToken: frame.deviceToken,
      ),
    );
    if (_disposed ||
        generation != _connectionGeneration ||
        _activeProfile?.endpointKey != pending.endpointKey) {
      return;
    }
    _authenticationPhase = AuthenticationPhase.paired;
    _publish();
    await _connectCurrent();
  }

  void _applyPairError(PairErrorFrame frame) {
    final pending = _pendingPair;
    if (pending == null ||
        (frame.requestId != null && frame.requestId != pending.requestId)) {
      throw const FormatException('pairing error correlation mismatch');
    }
    _pendingPair = null;
    _authenticationPhase = AuthenticationPhase.pairingRequired;
    _errorMessage =
        'Pairing failed (${frame.code}). Check the code and try again.';
    _publish();
  }

  void _applySessions(SessionsFrame frame) {
    _applySessionRefs(frame.sessions);
  }

  void _applySessionRefs(List<SessionRef> sessions) {
    _sessions = sessions
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
        pending.command != frame.command ||
        (pending.sessionId != null && pending.sessionId != frame.sessionId)) {
      throw const FormatException('response correlation mismatch');
    }
    if (pending.command == 'session.attach' &&
        pending.sessionId != _selectedSessionId) {
      return;
    }
    if (!frame.ok) {
      _submitting = false;
      _errorMessage = frame.error?.message ?? 'Command failed.';
      _publish();
      return;
    }
    if (frame.command == 'session.list') {
      final sessions = frame.sessionListResult;
      if (sessions == null) {
        throw const FormatException('session.list result is missing');
      }
      _applySessionRefs(sessions.sessions);
      if (_grantedFeatures.contains('host.watch')) {
        _sendHostWatch(sessions.cursor);
      }
      return;
    }
    if (frame.command == 'session.attach' &&
        pending.sessionId == _selectedSessionId &&
        (_messages.isNotEmpty ||
            _savedCursors.containsKey(_selectedSessionId))) {
      _phase = ConnectionPhase.ready;
    }
    _publish();
  }

  void _sendSessionList() {
    final hostId = _hostId;
    if (hostId == null) return;
    final ids = _nextCommandIds('session-list');
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: 'session.list',
    );
    _send(
      WireEncoder.sessionList(
        requestId: ids.requestId,
        commandId: ids.commandId,
        hostId: hostId,
      ),
    );
  }

  void _sendHostWatch(SessionIndexCursor cursor) {
    final hostId = _hostId;
    if (hostId == null) return;
    final ids = _nextCommandIds('host-watch');
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: 'host.watch',
    );
    _send(
      WireEncoder.hostWatch(
        requestId: ids.requestId,
        commandId: ids.commandId,
        hostId: hostId,
        cursor: cursor,
      ),
    );
  }

  void _sendAttach(String sessionId, {TranscriptCursor? cursor}) {
    final session = _sessions
        .where((item) => item.sessionId == sessionId)
        .firstOrNull;
    if (session == null ||
        _pendingCommands.values.any(
          (pending) =>
              pending.command == 'session.attach' &&
              pending.sessionId == sessionId,
        )) {
      return;
    }
    final ids = _nextCommandIds('attach');
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: 'session.attach',
      sessionId: sessionId,
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

  void _clearTargetProjection() {
    _connectionGeneration += 1;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    unawaited(_subscription?.cancel());
    unawaited(_channel?.sink.close());
    _subscription = null;
    _channel = null;
    _sessions = const <SessionSummary>[];
    _messages.clear();
    _savedCursors.clear();
    _pendingCommands.clear();
    _pendingPair = null;
    _selectedSessionId = null;
    _hostId = null;
    _submitting = false;
    _grantedCapabilities = const <String>{};
    _grantedFeatures = const <String>{};
    _bootstrapGeneration = -1;
    _reconnectAttempt = 0;
    _phase = ConnectionPhase.disconnected;
    _authenticationPhase = AuthenticationPhase.unknown;
  }

  void _handleTransportLoss(int generation, [Object? error]) {
    if (_disposed || generation != _connectionGeneration) return;
    _subscription = null;
    _channel = null;
    _pendingCommands.clear();
    _pendingPair = null;
    _submitting = false;
    if (!_reconnectEnabled) {
      _phase = ConnectionPhase.disconnected;
      _authenticationPhase = AuthenticationPhase.unknown;
      _errorMessage = null;
      _publish();
      return;
    }
    _reconnectAttempt += 1;
    final exponent = (_reconnectAttempt - 1).clamp(0, 4);
    final delay = Duration(milliseconds: 500 * (1 << exponent));
    _phase = ConnectionPhase.retrying;
    _authenticationPhase = AuthenticationPhase.unknown;
    _errorMessage = error == null
        ? 'Connection closed. Retrying…'
        : 'Connection lost: $error';
    _publish();
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () {
      if (!_disposed &&
          _reconnectEnabled &&
          generation == _connectionGeneration) {
        unawaited(_connectCurrent());
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
    _reconnectEnabled = false;
    _hostProbeOperation = null;
    final hostProbe = _hostProbe;
    _hostProbe = null;
    if (hostProbe != null) unawaited(hostProbe.sink.close());
    _connectionGeneration += 1;
    _hostOperationGeneration += 1;
    _reconnectTimer?.cancel();
    unawaited(_subscription?.cancel());
    unawaited(_channel?.sink.close());
    super.dispose();
  }
}

final class _PendingCommand {
  const _PendingCommand({
    required this.commandId,
    required this.command,
    this.sessionId,
  });

  final String commandId;
  final String command;
  final String? sessionId;
}

final class _PendingPair {
  const _PendingPair({
    required this.requestId,
    required this.endpointKey,
    required this.deviceId,
    required this.deviceName,
    required this.platform,
    required this.requestedCapabilities,
  });

  final String requestId;
  final String endpointKey;
  final String deviceId;
  final String deviceName;
  final String platform;
  final List<String> requestedCapabilities;
}
