import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
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
  final Map<String, _PendingCommand> _pendingSessionOperations =
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
  List<CatalogItem> _catalogItems = const <CatalogItem>[];
  Future<void>? _initialization;
  bool _initialized = false;
  bool _hostOperationPending = false;
  bool _submitting = false;
  bool _sessionOperationPending = false;
  bool _directoryLoaded = false;
  bool _disposed = false;
  int _connectionGeneration = 0;
  int _hostOperationGeneration = 0;
  int? _hostProbeOperation;
  bool _reconnectEnabled = true;
  int _bootstrapGeneration = -1;
  int _commandOrdinal = 0;
  int _localPromptOrdinal = 0;
  String? _sessionIndexEpoch;
  int? _sessionIndexSeq;
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
    sessionOperationPending: _sessionOperationPending,
    composer: _composerState,
  );

  SessionComposerState get _composerState {
    final session = _sessions
        .where((candidate) => candidate.sessionId == _selectedSessionId)
        .firstOrNull;
    if (session == null) return const SessionComposerState();
    final choices = <ComposerModelChoice>[];
    final seen = <String>{};
    final slashCommands = <ComposerSlashCommand>[];
    for (final item in _catalogItems) {
      if (item.kind == 'model') {
        final selector = _modelSelector(item);
        if (selector == null || !seen.add(selector)) continue;
        choices.add(
          ComposerModelChoice(
            label: item.name,
            selector: selector,
            supported: item.supported != false,
            reason: item.reason,
          ),
        );
        continue;
      }
      if (item.kind != 'command') continue;
      final bareName = item.name.replaceFirst(RegExp(r'^/+'), '');
      final missingCapability = item.capabilities
          ?.where((capability) => !_grantedCapabilities.contains(capability))
          .firstOrNull;
      final disabledReason = item.supported == false
          ? item.reason ?? 'Not available on this host'
          : missingCapability == null
          ? null
          : 'Not granted on this host';
      slashCommands.add(
        ComposerSlashCommand(
          name: '/$bareName',
          description: item.description ?? '',
          insert: '/$bareName ',
          disabledReason: disabledReason,
        ),
      );
    }
    final levels = <String>[
      'off',
      'auto',
      ...session.thinkingLevels.where(
        (level) => level != 'off' && level != 'auto',
      ),
    ];
    return SessionComposerState(
      modelLabel: session.modelDisplayName ?? session.modelSelector,
      modelSelector: session.modelSelector,
      modelChoices: List<ComposerModelChoice>.unmodifiable(choices),
      slashCommands: List<ComposerSlashCommand>.unmodifiable(slashCommands),
      thinking: session.thinking,
      thinkingLevels: List<String>.unmodifiable(levels),
      fastEnabled: session.fast,
      fastAvailable: session.fastAvailable,
      turnActive: session.turnActive || _submitting,
      queuedFollowUpCount: session.queuedFollowUpCount,
    );
  }

  String? _modelSelector(CatalogItem item) {
    final metadata = item.metadata;
    final provider = metadata?['provider'];
    final modelId = metadata?['modelId'];
    if (provider is String &&
        provider.isNotEmpty &&
        modelId is String &&
        modelId.isNotEmpty) {
      return '$provider/$modelId';
    }
    return item.name.contains('/') ? item.name : null;
  }

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
    _cancelPendingCommands(
      StateError('connection closed before the command completed'),
    );
    _pendingPair = null;
    _submitting = false;
    _sessionOperationPending = false;
    _hostId = null;
    _grantedCapabilities = const <String>{};
    _grantedFeatures = const <String>{};
    _catalogItems = const <CatalogItem>[];
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
    _catalogItems = const <CatalogItem>[];
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
  Future<void> createSession(String projectId, {String? title}) async {
    final normalizedProjectId = projectId.trim();
    if (normalizedProjectId.isEmpty) {
      throw ArgumentError.value(projectId, 'projectId', 'must not be empty');
    }
    final normalizedTitle = title?.trim();
    final frame = await _runSessionOperation(
      prefix: 'create-session',
      command: 'session.create',
      capability: 'sessions.manage',
      args: <String, Object?>{
        'projectId': normalizedProjectId,
        if (normalizedTitle != null && normalizedTitle.isNotEmpty)
          'title': normalizedTitle,
      },
    );
    final result = frame.result;
    if (result is! Map<String, Object?> || !result.containsKey('session')) {
      throw const FormatException('session.create result is missing');
    }
    final created = WireDecoder.decodeSessionRef(result['session']);
    if (created.hostId != _hostId ||
        created.project['projectId'] != normalizedProjectId) {
      throw const FormatException('session.create returned another project');
    }
    _upsertSession(created);
    await selectSession(created.sessionId);
  }

  @override
  Future<void> renameSession(String sessionId, String title) async {
    final normalized = title.trim();
    if (normalized.isEmpty) {
      throw ArgumentError.value(title, 'title', 'must not be empty');
    }
    await _runLifecycleCommand(
      sessionId,
      command: 'session.rename',
      args: <String, Object?>{'name': normalized},
    );
  }

  @override
  Future<void> terminateSession(String sessionId) => _runLifecycleCommand(
    sessionId,
    command: 'session.close',
    confirmationExpected: true,
  );

  @override
  Future<void> archiveSession(String sessionId) async {
    await _runLifecycleCommand(sessionId, command: 'session.archive');
    if (_selectedSessionId == sessionId) {
      final replacement = _sessions
          .where((session) => !session.archived)
          .firstOrNull;
      if (replacement == null) {
        _selectedSessionId = null;
        _messages.clear();
        _publish();
      } else {
        await selectSession(replacement.sessionId);
      }
    }
  }

  @override
  Future<void> restoreSession(String sessionId) =>
      _runLifecycleCommand(sessionId, command: 'session.restore');

  @override
  Future<void> deleteSession(String sessionId) => _runLifecycleCommand(
    sessionId,
    command: 'session.delete',
    confirmationExpected: true,
  );

  Future<ResponseFrame> _runLifecycleCommand(
    String sessionId, {
    required String command,
    Map<String, Object?> args = const <String, Object?>{},
    bool confirmationExpected = false,
  }) {
    final session = _sessions
        .where((candidate) => candidate.sessionId == sessionId)
        .firstOrNull;
    if (session == null) {
      throw ArgumentError.value(sessionId, 'sessionId', 'is not indexed');
    }
    return _runSessionOperation(
      prefix: command.replaceAll('.', '-'),
      command: command,
      capability: 'sessions.manage',
      session: session,
      args: args,
      confirmationExpected: confirmationExpected,
    );
  }

  Future<ResponseFrame> _runSessionOperation({
    required String prefix,
    required String command,
    required String capability,
    SessionSummary? session,
    Map<String, Object?> args = const <String, Object?>{},
    bool confirmationExpected = false,
  }) async {
    if (_sessionOperationPending) {
      throw StateError('another session action is already running');
    }
    final hostId = _hostId;
    if (_phase != ConnectionPhase.ready || hostId == null) {
      throw StateError('connect before managing sessions');
    }
    if (!_grantedCapabilities.contains(capability)) {
      throw StateError('this device was not granted $capability');
    }
    final ids = _nextCommandIds(prefix);
    final completer = Completer<ResponseFrame>();
    final pending = _PendingCommand(
      commandId: ids.commandId,
      command: command,
      sessionId: session?.sessionId,
      completer: completer,
      expectedRevision: session?.revision,
      confirmationExpected: confirmationExpected,
    );
    _pendingSessionOperations[ids.requestId] = pending;
    _sessionOperationPending = true;
    _errorMessage = null;
    _publish();
    try {
      _send(
        WireEncoder.command(
          requestId: ids.requestId,
          commandId: ids.commandId,
          hostId: hostId,
          sessionId: session?.sessionId,
          command: command,
          expectedRevision: session?.revision,
          args: args,
        ),
      );
      final frame = await completer.future.timeout(
        const Duration(seconds: 10),
        onTimeout: () => throw TimeoutException('$command timed out'),
      );
      if (!frame.ok) {
        throw StateError(frame.error?.message ?? '$command failed');
      }
      return frame;
    } on Object catch (error) {
      _errorMessage = 'Session action failed: $error';
      _publish();
      rethrow;
    } finally {
      _pendingSessionOperations.remove(ids.requestId);
      _sessionOperationPending = false;
      _publish();
    }
  }

  @override
  Future<bool> submitPrompt(
    String message, {
    List<PromptImageAttachment> images = const <PromptImageAttachment>[],
  }) async {
    final text = message.trim();
    final session = state.selectedSession;
    if (session == null || _phase != ConnectionPhase.ready) return false;
    if (text.isEmpty && images.isEmpty) return false;
    if (state.composer.turnActive) {
      if (images.isNotEmpty) {
        throw StateError('Images cannot be added while a turn is active.');
      }
      return _sendPromptText('session.steer', text);
    }
    if (images.length > 8) {
      throw ArgumentError.value(images.length, 'images', 'maximum is 8');
    }

    final optimisticId =
        'local-prompt:${session.sessionId}:${_localPromptOrdinal++}';
    _messages[optimisticId] = TranscriptMessage(
      id: optimisticId,
      role: MessageRole.user,
      text: text,
    );
    _submitting = true;
    _publish();
    final uploaded = <String>[];
    try {
      for (final image in images) {
        uploaded.add(await _uploadImage(session, image));
      }
      final frame = await _runComposerCommand(
        prefix: 'prompt',
        command: 'session.prompt',
        session: session,
        expectedRevision: session.revision,
        args: <String, Object?>{
          'message': text,
          if (uploaded.isNotEmpty)
            'images': <Map<String, String>>[
              for (final imageId in uploaded)
                <String, String>{'imageId': imageId},
            ],
        },
      );
      final result = frame.result;
      return result is Map<String, Object?> && result['accepted'] == true;
    } on Object {
      await _discardUploadedImages(session, uploaded);
      _messages.remove(optimisticId);
      _submitting = false;
      _publish();
      rethrow;
    }
  }

  @override
  Future<bool> queuePrompt(String message) =>
      _sendPromptText('session.followUp', message.trim());

  Future<bool> _sendPromptText(String command, String text) async {
    final session = state.selectedSession;
    if (text.isEmpty || session == null || _phase != ConnectionPhase.ready) {
      return false;
    }
    final frame = await _runComposerCommand(
      prefix: command.replaceAll('.', '-'),
      command: command,
      session: session,
      expectedRevision: session.revision,
      args: <String, Object?>{'message': text},
    );
    final result = frame.result;
    return result is Map<String, Object?> && result['accepted'] == true;
  }

  @override
  Future<void> cancelTurn() async {
    final session = state.selectedSession;
    if (session == null || !state.composer.turnActive) return;
    await _runSessionOperation(
      prefix: 'session-cancel',
      command: 'session.cancel',
      capability: 'sessions.control',
      session: session,
      confirmationExpected: true,
    );
  }

  @override
  Future<void> setSessionModel(String selector) async {
    final session = state.selectedSession;
    if (session == null) return;
    await _runSessionOperation(
      prefix: 'session-model',
      command: 'session.model.set',
      capability: 'sessions.manage',
      session: session,
      args: <String, Object?>{'selector': selector, 'persistence': 'session'},
    );
  }

  @override
  Future<void> setSessionThinking(String level) async {
    final session = state.selectedSession;
    if (session == null) return;
    await _runSessionOperation(
      prefix: 'session-thinking',
      command: 'session.thinking.set',
      capability: 'sessions.manage',
      session: session,
      args: <String, Object?>{'level': level},
    );
  }

  @override
  Future<void> setSessionFast(bool enabled) async {
    final session = state.selectedSession;
    if (session == null) return;
    await _runSessionOperation(
      prefix: 'session-fast',
      command: 'session.fast.set',
      capability: 'sessions.manage',
      session: session,
      args: <String, Object?>{'enabled': enabled},
    );
  }

  @override
  Future<Uint8List> readTranscriptImage(
    String entryId,
    TranscriptImageMetadata image,
  ) async {
    final session = state.selectedSession;
    if (session == null) {
      throw StateError('choose a session before loading transcript images');
    }
    final bytes = BytesBuilder(copy: false);
    var offset = 0;
    int? expectedSize;
    while (true) {
      final frame = await _runComposerCommand(
        prefix: 'image-read',
        command: 'session.image.read',
        session: session,
        capability: 'sessions.read',
        args: <String, Object?>{
          'entryId': entryId,
          'sha256': image.sha256,
          'offset': offset,
        },
      );
      final result = frame.result;
      if (result is! Map<String, Object?> ||
          result['sha256'] != image.sha256 ||
          result['mimeType'] != image.mimeType ||
          result['size'] is! int ||
          result['offset'] != offset ||
          result['nextOffset'] is! int ||
          result['complete'] is! bool ||
          result['content'] is! String) {
        throw const FormatException('session.image.read result is invalid');
      }
      final size = result['size']! as int;
      expectedSize ??= size;
      if (size != expectedSize || size <= 0 || size > 20 * 1024 * 1024) {
        throw const FormatException('transcript image size changed');
      }
      final nextOffset = result['nextOffset']! as int;
      final chunk = base64Decode(result['content']! as String);
      if (nextOffset <= offset || nextOffset - offset != chunk.length) {
        throw const FormatException('transcript image offsets are invalid');
      }
      bytes.add(chunk);
      offset = nextOffset;
      final complete = result['complete']! as bool;
      if (complete != (offset == size)) {
        throw const FormatException('transcript image completion is invalid');
      }
      if (complete) break;
    }
    final value = bytes.takeBytes();
    if (value.length != expectedSize ||
        sha256.convert(value).toString() != image.sha256) {
      throw const FormatException('transcript image integrity check failed');
    }
    return value;
  }

  Future<String> _uploadImage(
    SessionSummary session,
    PromptImageAttachment attachment,
  ) async {
    if (!const <String>{
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    }.contains(attachment.mimeType)) {
      throw ArgumentError.value(
        attachment.mimeType,
        'mimeType',
        'is not supported',
      );
    }
    if (attachment.bytes.isEmpty ||
        attachment.bytes.length > 20 * 1024 * 1024) {
      throw ArgumentError.value(
        attachment.bytes.length,
        'bytes',
        'image must be between 1 byte and 20 MiB',
      );
    }
    final begin = await _runComposerCommand(
      prefix: 'image-begin',
      command: 'session.image.begin',
      session: session,
      args: <String, Object?>{
        'mimeType': attachment.mimeType,
        'size': attachment.bytes.length,
        'sha256': sha256.convert(attachment.bytes).toString(),
      },
    );
    final beginResult = begin.result;
    if (beginResult is! Map<String, Object?> ||
        beginResult['imageId'] is! String ||
        beginResult['chunkBytes'] is! int) {
      throw const FormatException('session.image.begin result is invalid');
    }
    final imageId = beginResult['imageId']! as String;
    final chunkBytes = beginResult['chunkBytes']! as int;
    if (chunkBytes <= 0) {
      throw const FormatException('session.image.begin chunk size is invalid');
    }
    for (
      var offset = 0;
      offset < attachment.bytes.length;
      offset += chunkBytes
    ) {
      final end = min(offset + chunkBytes, attachment.bytes.length);
      final chunk = Uint8List.sublistView(attachment.bytes, offset, end);
      final response = await _runComposerCommand(
        prefix: 'image-chunk',
        command: 'session.image.chunk',
        session: session,
        args: <String, Object?>{
          'imageId': imageId,
          'offset': offset,
          'content': base64Encode(chunk),
        },
      );
      final result = response.result;
      if (result is! Map<String, Object?> ||
          result['imageId'] != imageId ||
          result['received'] != end ||
          result['complete'] != (end == attachment.bytes.length)) {
        throw const FormatException('session.image.chunk result is invalid');
      }
    }
    return imageId;
  }

  Future<void> _discardUploadedImages(
    SessionSummary session,
    List<String> imageIds,
  ) async {
    for (final imageId in imageIds) {
      try {
        await _runComposerCommand(
          prefix: 'image-discard',
          command: 'session.image.discard',
          session: session,
          args: <String, Object?>{'imageId': imageId},
        );
      } on Object {
        // The original upload failure remains the actionable error.
      }
    }
  }

  Future<ResponseFrame> _runComposerCommand({
    required String prefix,
    required String command,
    required SessionSummary session,
    required Map<String, Object?> args,
    String? expectedRevision,
    String capability = 'sessions.prompt',
  }) async {
    if (_phase != ConnectionPhase.ready || _hostId == null) {
      throw StateError('connect before sending a prompt');
    }
    if (!_grantedCapabilities.contains(capability)) {
      throw StateError('this device was not granted $capability');
    }
    final ids = _nextCommandIds(prefix);
    final completer = Completer<ResponseFrame>();
    _pendingCommands[ids.requestId] = _PendingCommand(
      commandId: ids.commandId,
      command: command,
      sessionId: session.sessionId,
      completer: completer,
    );
    _errorMessage = null;
    _publish();
    try {
      _send(
        WireEncoder.command(
          requestId: ids.requestId,
          commandId: ids.commandId,
          hostId: session.hostId,
          sessionId: session.sessionId,
          command: command,
          expectedRevision: expectedRevision,
          args: args,
        ),
      );
      final frame = await completer.future.timeout(
        const Duration(seconds: 30),
        onTimeout: () => throw TimeoutException('$command timed out'),
      );
      if (!frame.ok) {
        throw StateError(frame.error?.message ?? '$command failed');
      }
      return frame;
    } finally {
      _pendingCommands.remove(ids.requestId);
    }
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
          _applyEvent(frame.event, frame.cursor);
          _publish();
        }
      case ResponseFrame():
        _applyResponse(frame);
      case SessionDeltaFrame():
        _applySessionDelta(frame);
      case ConfirmationFrame():
        _applyConfirmation(frame);
      case PairErrorFrame():
        _applyPairError(frame);
      case CatalogFrame():
        if (frame.hostId == _hostId) {
          _catalogItems = List<CatalogItem>.unmodifiable(frame.items);
          _publish();
        }
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
    _applySessionListCursor(frame.cursor);
    _applySessionRefs(frame.sessions);
  }

  void _applySessionListCursor(SessionIndexCursor cursor) {
    _sessionIndexEpoch = cursor.epoch;
    _sessionIndexSeq = cursor.seq;
  }

  void _applySessionRefs(List<SessionRef> sessions) {
    _sessions = sessions.map(_summaryFromRef).toList(growable: false)
      ..sort(_compareSessions);
    final selectedStillExists = _sessions.any(
      (session) => session.sessionId == _selectedSessionId,
    );
    if (!selectedStillExists) {
      _selectedSessionId =
          _sessions
              .where((session) => !session.archived)
              .firstOrNull
              ?.sessionId ??
          _sessions.firstOrNull?.sessionId;
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

  SessionSummary _summaryFromRef(SessionRef session) {
    final projectId = session.project['projectId'];
    final projectName = session.project['name'];
    final archivedAt = session.raw['archivedAt'];
    final pendingApproval = session.raw['pendingApproval'];
    final pendingUserInput = session.raw['pendingUserInput'];
    final rawLiveState = session.raw['liveState'];
    final liveState = rawLiveState is Map<String, Object?>
        ? rawLiveState
        : const <String, Object?>{};
    final rawModel = liveState['model'];
    String? modelSelector;
    String? modelDisplayName;
    if (rawModel is String && rawModel.isNotEmpty) {
      modelSelector = rawModel;
    } else if (rawModel is Map<String, Object?>) {
      final selector = rawModel['selector'];
      final provider = rawModel['provider'];
      final id = rawModel['id'];
      if (selector is String && selector.isNotEmpty) {
        modelSelector = selector;
      } else if (provider is String &&
          provider.isNotEmpty &&
          id is String &&
          id.isNotEmpty) {
        modelSelector = '$provider/$id';
      }
      final displayName = rawModel['displayName'];
      if (displayName is String && displayName.isNotEmpty) {
        modelDisplayName = displayName;
      }
    }
    final refModel = session.raw['model'];
    if (modelSelector == null && refModel is String && refModel.isNotEmpty) {
      modelSelector = refModel;
    }
    final rawThinking = liveState['thinking'] ?? session.raw['thinking'];
    final thinking = rawThinking is String ? rawThinking : null;
    final thinkingLevels = switch (liveState['thinkingLevels']) {
      final List<Object?> values => values.whereType<String>().toList(
        growable: false,
      ),
      _ => const <String>[],
    };
    final queuedCount = switch (liveState['queuedMessageCount']) {
      final int count when count >= 0 => count,
      _ => _queuedMessageCount(liveState['queuedMessages']),
    };
    final streaming = liveState['isStreaming'] == true;
    return SessionSummary(
      hostId: session.hostId,
      sessionId: session.sessionId,
      title: session.title,
      revision: session.revision,
      status: session.status,
      projectId: projectId is String ? projectId : 'unknown-project',
      projectName: projectName is String && projectName.trim().isNotEmpty
          ? projectName
          : 'Project',
      updatedAt: session.updatedAt,
      archivedAt: archivedAt is String ? archivedAt : null,
      working:
          session.status == 'active' ||
          pendingApproval == true ||
          pendingUserInput == true ||
          streaming,
      modelSelector: modelSelector,
      modelDisplayName: modelDisplayName,
      thinking: thinking,
      thinkingLevels: thinkingLevels,
      fast: liveState['fast'] == true,
      fastAvailable: liveState['fastAvailable'] == true,
      turnActive:
          streaming || pendingApproval == true || pendingUserInput == true,
      queuedFollowUpCount: queuedCount,
    );
  }

  int _queuedMessageCount(Object? value) {
    if (value is! Map<String, Object?>) return 0;
    var count = 0;
    for (final messages in value.values) {
      if (messages is List<Object?>) count += messages.length;
    }
    return count;
  }

  int _compareSessions(SessionSummary left, SessionSummary right) {
    final updated = right.updatedAt.compareTo(left.updatedAt);
    return updated != 0 ? updated : left.sessionId.compareTo(right.sessionId);
  }

  void _upsertSession(SessionRef ref) {
    final next = _summaryFromRef(ref);
    final index = _sessions.indexWhere(
      (session) => session.sessionId == next.sessionId,
    );
    final sessions = _sessions.toList(growable: true);
    if (index < 0) {
      sessions.add(next);
    } else {
      sessions[index] = next;
    }
    sessions.sort(_compareSessions);
    _sessions = List<SessionSummary>.unmodifiable(sessions);
    _publish();
  }

  void _applySessionDelta(SessionDeltaFrame frame) {
    final cursor = frame.cursor;
    final currentEpoch = _sessionIndexEpoch;
    final currentSeq = _sessionIndexSeq;
    if (currentEpoch != null && currentSeq != null) {
      if (cursor.epoch == currentEpoch && cursor.seq <= currentSeq) return;
      if (cursor.epoch != currentEpoch || cursor.seq != currentSeq + 1) {
        _sendSessionList();
        return;
      }
    }
    _sessionIndexEpoch = cursor.epoch;
    _sessionIndexSeq = cursor.seq;
    final upsert = frame.upsert;
    if (upsert != null) {
      _upsertSession(upsert);
      return;
    }
    final removed = frame.remove;
    if (removed == null) return;
    final wasSelected = _selectedSessionId == removed;
    _sessions = _sessions
        .where((session) => session.sessionId != removed)
        .toList(growable: false);
    _savedCursors.remove(removed);
    if (!wasSelected) {
      _publish();
      return;
    }
    _messages.clear();
    final replacement =
        _sessions.where((session) => !session.archived).firstOrNull ??
        _sessions.firstOrNull;
    _selectedSessionId = replacement?.sessionId;
    if (replacement == null) {
      _phase = ConnectionPhase.ready;
      _publish();
      return;
    }
    _phase = ConnectionPhase.synchronizing;
    _publish();
    _sendAttach(
      replacement.sessionId,
      cursor: _savedCursors[replacement.sessionId],
    );
  }

  void _applyConfirmation(ConfirmationFrame frame) {
    final pending = _pendingSessionOperations.values
        .where((candidate) => candidate.commandId == frame.commandId)
        .firstOrNull;
    if (pending == null) return;
    if (!pending.confirmationExpected ||
        pending.confirmationSent ||
        frame.hostId != _hostId ||
        frame.sessionId != pending.sessionId ||
        frame.summary != pending.command ||
        frame.revision != pending.expectedRevision) {
      throw const FormatException('confirmation correlation mismatch');
    }
    final expiresAt = DateTime.tryParse(frame.expiresAt);
    if (expiresAt == null || !expiresAt.isAfter(DateTime.now().toUtc())) {
      throw const FormatException('confirmation is expired');
    }
    pending.confirmationSent = true;
    final ids = _nextCommandIds('confirm');
    _send(
      WireEncoder.confirm(
        requestId: ids.requestId,
        confirmationId: frame.confirmationId,
        commandId: frame.commandId,
        hostId: frame.hostId,
        sessionId: frame.sessionId,
        decision: 'approve',
      ),
    );
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
                  projectId: session.projectId,
                  projectName: session.projectName,
                  updatedAt: session.updatedAt,
                  archivedAt: session.archivedAt,
                  working: session.working,
                  modelSelector: session.modelSelector,
                  modelDisplayName: session.modelDisplayName,
                  thinking: session.thinking,
                  thinkingLevels: session.thinkingLevels,
                  fast: session.fast,
                  fastAvailable: session.fastAvailable,
                  turnActive: session.turnActive,
                  queuedFollowUpCount: session.queuedFollowUpCount,
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
    if (entry.kind == 'message') {
      final text = data['text'];
      if (text is! String) return;
      _messages[entry.id] = TranscriptMessage(
        id: entry.id,
        role: _messageRole(data['role']),
        text: text,
        reasoning: data['reasoning'] is String
            ? data['reasoning']! as String
            : '',
        images: _entryImages(data['images']),
      );
      return;
    }
    if (entry.kind == 'tool-use') {
      final result = data['result'];
      final resultMap = result is Map<String, Object?> ? result : null;
      final output = resultMap?['output'];
      final isError = resultMap?['isError'];
      _messages[entry.id] = TranscriptMessage(
        id: entry.id,
        role: MessageRole.tool,
        kind: TranscriptKind.tool,
        text: '',
        toolName: data['tool'] is String ? data['tool']! as String : 'tool',
        toolTitle: data['title'] is String ? data['title']! as String : null,
        toolArguments: _jsonDisplay(data['args']),
        toolOutput: output is String ? output : _jsonDisplay(result),
        toolSucceeded: isError is bool ? !isError : data['ok'] as bool?,
        images: _entryImages(data['images']),
      );
      return;
    }
    if (entry.kind == 'compaction') {
      final summary = data['summary'];
      if (summary is! String) return;
      _messages[entry.id] = TranscriptMessage(
        id: entry.id,
        role: MessageRole.system,
        kind: TranscriptKind.compaction,
        text: summary,
      );
    }
  }

  List<TranscriptImageMetadata> _entryImages(Object? value) {
    if (value is! List<Object?>) return const <TranscriptImageMetadata>[];
    final images = <TranscriptImageMetadata>[];
    for (final item in value) {
      if (item is! Map<String, Object?>) continue;
      final sha256 = item['sha256'];
      final mimeType = item['mimeType'];
      if (sha256 is String && mimeType is String) {
        images.add(TranscriptImageMetadata(sha256: sha256, mimeType: mimeType));
      }
    }
    return List<TranscriptImageMetadata>.unmodifiable(images);
  }

  String? _jsonDisplay(Object? value) {
    if (value == null) return null;
    if (value is String) return value;
    try {
      return const JsonEncoder.withIndent('  ').convert(value);
    } on Object {
      return value.toString();
    }
  }

  String _eventItemId(TranscriptCursor cursor, String suffix) =>
      'event-${cursor.epoch}-${cursor.seq}-$suffix';

  void _applyEvent(Map<String, Object?> event, TranscriptCursor cursor) {
    switch (event['type']) {
      case 'message.update':
        final entryId = event['entryId'];
        final text = event['text'];
        if (entryId is String && text is String) {
          if (event['role'] == 'user') {
            _messages.removeWhere(
              (id, message) => id.startsWith('local-prompt:'),
            );
          }
          _messages[entryId] = TranscriptMessage(
            id: entryId,
            role: _messageRole(event['role']),
            text: text,
            reasoning: event['reasoning'] is String
                ? event['reasoning']! as String
                : '',
            streaming: true,
          );
        }
      case 'message.settled':
        final transientEntryId = event['transientEntryId'];
        if (transientEntryId is String) _messages.remove(transientEntryId);
      case 'message.discarded':
        final transientEntryId = event['transientEntryId'];
        if (transientEntryId is String) _messages.remove(transientEntryId);
      case 'tool.start':
        final callId = event['callId'];
        if (callId is String) {
          _messages['tool:$callId'] = TranscriptMessage(
            id: 'tool:$callId',
            role: MessageRole.tool,
            kind: TranscriptKind.tool,
            text: '',
            toolName: event['tool'] is String
                ? event['tool']! as String
                : 'tool',
            toolTitle: event['title'] is String
                ? event['title']! as String
                : null,
            toolArguments: _jsonDisplay(event['args']),
            toolRunning: true,
          );
        }
      case 'tool.progress':
        final callId = event['callId'];
        final current = callId is String ? _messages['tool:$callId'] : null;
        if (callId is String && current != null) {
          final note = event['note'];
          final chunk = event['chunk'];
          final appended = <String>[
            if (current.toolOutput case final output? when output.isNotEmpty)
              output,
            if (chunk is String && chunk.isNotEmpty) chunk,
          ].join();
          _messages['tool:$callId'] = TranscriptMessage(
            id: current.id,
            role: current.role,
            kind: current.kind,
            text: note is String && note.isNotEmpty ? note : current.text,
            toolName: current.toolName,
            toolTitle: current.toolTitle,
            toolArguments: current.toolArguments,
            toolOutput: appended.isEmpty ? null : appended,
            toolRunning: true,
            toolProgress: switch (event['progress']) {
              final num progress => progress.toDouble().clamp(0, 1),
              _ => current.toolProgress,
            },
          );
        }
      case 'tool.result':
        final callId = event['callId'];
        final current = callId is String ? _messages['tool:$callId'] : null;
        if (callId is String) {
          _messages['tool:$callId'] = TranscriptMessage(
            id: 'tool:$callId',
            role: MessageRole.tool,
            kind: TranscriptKind.tool,
            text: current?.text ?? '',
            toolName: current?.toolName ?? 'tool',
            toolTitle: current?.toolTitle,
            toolArguments: current?.toolArguments,
            toolOutput: _jsonDisplay(event['result']),
            toolSucceeded: event['ok'] is bool ? event['ok']! as bool : null,
          );
        }
      case 'turn.start':
      case 'agent.start':
        _submitting = true;
      case 'turn.end':
      case 'agent.end':
        _submitting = false;
      case 'turn.error':
        _submitting = false;
        final message = event['message'];
        final text = message is String ? message : 'The agent turn failed.';
        _errorMessage = text;
        _messages[_eventItemId(cursor, 'error')] = TranscriptMessage(
          id: _eventItemId(cursor, 'error'),
          role: MessageRole.system,
          kind: TranscriptKind.notice,
          text: text,
        );
      case 'notice':
        final message = event['message'];
        if (message is String) {
          _messages[_eventItemId(cursor, 'notice')] = TranscriptMessage(
            id: _eventItemId(cursor, 'notice'),
            role: MessageRole.system,
            kind: TranscriptKind.notice,
            text: message,
          );
        }
    }
  }

  void _applyResponse(ResponseFrame frame) {
    final operation = _pendingSessionOperations.remove(frame.requestId);
    if (operation != null) {
      if (operation.commandId != frame.commandId ||
          operation.command != frame.command ||
          operation.sessionId != frame.sessionId) {
        throw const FormatException('session operation correlation mismatch');
      }
      operation.completer!.complete(frame);
      return;
    }
    final pending = _pendingCommands.remove(frame.requestId);
    if (pending == null ||
        pending.commandId != frame.commandId ||
        pending.command != frame.command ||
        (pending.sessionId != null && pending.sessionId != frame.sessionId)) {
      throw const FormatException('response correlation mismatch');
    }
    final completer = pending.completer;
    if (completer != null) {
      completer.complete(frame);
      return;
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
      _applySessionListCursor(sessions.cursor);
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
    if (hostId == null ||
        _pendingCommands.values.any(
          (pending) => pending.command == 'session.list',
        )) {
      return;
    }
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
    _cancelPendingCommands(StateError('active host changed'));
    _pendingPair = null;
    _selectedSessionId = null;
    _hostId = null;
    _submitting = false;
    _sessionOperationPending = false;
    _grantedCapabilities = const <String>{};
    _sessionIndexEpoch = null;
    _sessionIndexSeq = null;
    _grantedFeatures = const <String>{};
    _catalogItems = const <CatalogItem>[];
    _bootstrapGeneration = -1;
    _reconnectAttempt = 0;
    _phase = ConnectionPhase.disconnected;
    _authenticationPhase = AuthenticationPhase.unknown;
  }

  void _handleTransportLoss(int generation, [Object? error]) {
    if (_disposed || generation != _connectionGeneration) return;
    _subscription = null;
    _channel = null;
    _cancelPendingCommands(StateError('connection lost'));
    _pendingPair = null;
    _submitting = false;
    _sessionOperationPending = false;
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

  void _cancelPendingCommands(Object error) {
    for (final pending in _pendingSessionOperations.values) {
      final completer = pending.completer;
      if (completer != null && !completer.isCompleted) {
        completer.completeError(error);
      }
    }
    for (final pending in _pendingCommands.values) {
      final completer = pending.completer;
      if (completer != null && !completer.isCompleted) {
        completer.completeError(error);
      }
    }
    _pendingSessionOperations.clear();
    _pendingCommands.clear();
  }

  void _fail(String message) {
    _cancelPendingCommands(StateError(message));
    _phase = ConnectionPhase.failed;
    _errorMessage = message;
    _submitting = false;
    _sessionOperationPending = false;
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
    _cancelPendingCommands(StateError('controller disposed'));
    unawaited(_subscription?.cancel());
    unawaited(_channel?.sink.close());
    super.dispose();
  }
}

final class _PendingCommand {
  _PendingCommand({
    required this.commandId,
    required this.command,
    this.sessionId,
    this.completer,
    this.expectedRevision,
    this.confirmationExpected = false,
  });

  final String commandId;
  final String command;
  final String? sessionId;
  final Completer<ResponseFrame>? completer;
  final String? expectedRevision;
  final bool confirmationExpected;
  bool confirmationSent = false;
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
