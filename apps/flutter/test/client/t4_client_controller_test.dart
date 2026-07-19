import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/app_state.dart';
import 'package:t4code/src/client/t4_client_controller.dart';
import 'package:t4code/src/client/web_socket_connector.dart';
import 'package:t4code/src/host/host_profile.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

void main() {
  test(
    'loads credentials before connecting and sends authenticated hello',
    () async {
      final profile = _profile('alpha');
      final events = <String>[];
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
        events: events,
      );
      final credentials = _MemoryCredentialStore(events: events)
        ..values[profile.endpointKey] = DeviceCredentials(
          deviceId: 'device-alpha',
          deviceToken: _token,
        );
      final connector = _FakeConnector(events: events);
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);

      await controller.initialize();
      await _flush();

      expect(events.take(3), <String>[
        'load',
        'read:${profile.endpointKey}',
        'connect:${profile.webSocketUrl}',
      ]);
      final hello = connector.channels.single.sentJson.single;
      expect(hello['type'], 'hello');
      expect(hello['capabilities'], <String, Object?>{
        'client': <String>[
          'sessions.read',
          'sessions.prompt',
          'sessions.control',
          'sessions.manage',
        ],
      });
      expect(hello['authentication'], <String, Object?>{
        'deviceId': 'device-alpha',
        'deviceToken': _token,
      });
    },
  );

  test(
    'probes before saving a host and then connects to the saved profile',
    () async {
      final events = <String>[];
      final directory = _MemoryDirectoryStore(events: events);
      final credentials = _MemoryCredentialStore(events: events);
      final connector = _FakeConnector(events: events);
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      await controller.initialize();

      await controller.addHost('alpha.example.ts.net');

      final saveIndex = events.indexWhere((event) => event.startsWith('save:'));
      final probeIndex = events.indexOf(
        'connect:wss://alpha.example.ts.net/v1/ws',
      );
      final probeCloseIndex = events.indexOf('close:0');
      expect(probeIndex, greaterThanOrEqualTo(0));
      expect(probeCloseIndex, greaterThan(probeIndex));
      expect(saveIndex, greaterThan(probeCloseIndex));
      expect(connector.uris, hasLength(2));
      expect(
        directory.directory.activeProfile?.webSocketUrl,
        connector.uris.last,
      );
    },
  );

  test(
    'welcome bootstraps session.list then host.watch with index cursor',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final credentials = _MemoryCredentialStore();
      final connector = _FakeConnector();
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;

      final hello = channel.sentJson.single;
      final requestedFeatures = (hello['requestedFeatures']! as List<Object?>)
          .cast<String>();
      expect(requestedFeatures, containsAll(<String>['resume', 'host.watch']));
      channel.emit(_welcome('host-alpha', features: requestedFeatures));
      await _flush();
      expect(
        controller.state.grantedCapabilities,
        containsAll(<String>['sessions.read']),
      );
      expect(controller.state.grantedFeatures, containsAll(requestedFeatures));
      final list = channel.sentJson.last;
      expect(list, containsPair('command', 'session.list'));

      channel.emit(
        _response(
          list,
          command: 'session.list',
          result: _sessionListResult(
            'host-alpha',
            epoch: 'index-epoch',
            seq: 7,
          ),
        ),
      );
      await _flush();

      final watch = channel.sentJson.last;
      expect(watch, containsPair('command', 'host.watch'));
      expect(watch['args'], <String, Object?>{
        'cursor': <String, Object?>{'epoch': 'index-epoch', 'seq': 7},
      });
      expect(controller.state.sessions.single.sessionId, 'session-alpha');
    },
  );

  test(
    'duplicate inventories share an attach while a new selection stays isolated',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final connector = _FakeConnector();
      final controller = _controller(
        directory,
        _MemoryCredentialStore(),
        connector,
      );
      addTearDown(controller.dispose);
      await controller.initialize();
      final channel = connector.channels.single;

      channel.emit(_welcome('host-alpha'));
      await _flush();
      final list = channel.sentJson.last;
      final inventory = _sessionListResultFor('host-alpha', const <String>[
        'session-alpha',
        'session-beta',
      ]);
      channel.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'sessions',
        'hostId': 'host-alpha',
        ...inventory,
      });
      await _flush();
      final firstAttach = channel.sentJson.singleWhere(
        (frame) =>
            frame['command'] == 'session.attach' &&
            frame['sessionId'] == 'session-alpha',
      );

      channel.emit(_response(list, command: 'session.list', result: inventory));
      await _flush();
      expect(
        channel.sentJson.where(
          (frame) =>
              frame['command'] == 'session.attach' &&
              frame['sessionId'] == 'session-alpha',
        ),
        hasLength(1),
      );

      await controller.selectSession('session-beta');
      expect(
        channel.sentJson.where((frame) => frame['command'] == 'session.attach'),
        hasLength(2),
      );
      expect(channel.sentJson.last['sessionId'], 'session-beta');
      expect(controller.state.connectionPhase, ConnectionPhase.synchronizing);

      channel.emit(
        _response(
          firstAttach,
          command: 'session.attach',
          result: const <String, Object?>{},
        ),
      );
      await _flush();
      expect(controller.state.selectedSessionId, 'session-beta');
      expect(controller.state.connectionPhase, ConnectionPhase.synchronizing);
    },
  );

  test(
    'switching hosts clears projections without deleting credentials',
    () async {
      final alpha = _profile('alpha');
      final beta = _profile('beta');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(beta).upsert(alpha),
      );
      final credentials = _MemoryCredentialStore();
      final connector = _FakeConnector();
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      await controller.initialize();
      final first = connector.channels.single;
      first.emit(_welcome('host-alpha'));
      first.emit(_sessions('host-alpha'));
      await _flush();
      expect(controller.state.sessions, isNotEmpty);

      await controller.activateHost(beta.endpointKey);

      expect(
        controller.state.hostDirectory.activeEndpointKey,
        beta.endpointKey,
      );
      expect(controller.state.sessions, isEmpty);
      expect(controller.state.messages, isEmpty);
      expect(controller.state.selectedSessionId, isNull);
      expect(credentials.deleted, isEmpty);
      expect(connector.uris.last, beta.webSocketUrl);
    },
  );

  test('deliberate disconnect cancels an automatic reconnect', () async {
    final profile = _profile('alpha');
    final directory = _MemoryDirectoryStore(
      directory: const HostDirectory.empty().upsert(profile),
    );
    final connector = _FakeConnector();
    final controller = _controller(
      directory,
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final first = connector.channels.single;
    first.fail(StateError('network lost'));
    await _flush();
    expect(controller.state.connectionPhase, ConnectionPhase.retrying);

    await controller.disconnect();
    await Future<void>.delayed(const Duration(milliseconds: 600));

    expect(controller.state.connectionPhase, ConnectionPhase.disconnected);
    expect(connector.channels, hasLength(1));
    await controller.connect();
    expect(connector.channels, hasLength(2));
  });

  test('cancelling a pending host probe never saves it', () async {
    final readyGate = Completer<void>();
    final directory = _MemoryDirectoryStore();
    final connector = _FakeConnector(readyGate: readyGate);
    final controller = _controller(
      directory,
      _MemoryCredentialStore(),
      connector,
    );
    addTearDown(controller.dispose);
    await controller.initialize();

    final adding = controller.addHost('alpha.example.ts.net');
    await _until(() => connector.channels.isNotEmpty);
    expect(controller.state.hostOperationPending, isTrue);
    controller.cancelHostProbe();
    readyGate.complete();
    await adding;

    expect(controller.state.hostOperationPending, isFalse);
    expect(directory.saved, isEmpty);
    expect(directory.directory.profiles, isEmpty);
  });

  test('credential deletion failure rolls host metadata back', () async {
    final alpha = _profile('alpha');
    final beta = _profile('beta');
    final original = const HostDirectory.empty().upsert(beta).upsert(alpha);
    final events = <String>[];
    final directory = _MemoryDirectoryStore(
      directory: original,
      events: events,
    );
    final credentials = _MemoryCredentialStore(events: events)
      ..deleteError = StateError('vault unavailable');
    final connector = _FakeConnector();
    final controller = _controller(directory, credentials, connector);
    addTearDown(controller.dispose);
    await controller.initialize();

    await expectLater(
      controller.removeHost(beta.endpointKey),
      throwsA(isA<StateError>()),
    );

    expect(directory.saved, hasLength(2));
    expect(directory.saved.first.profiles, isNot(contains(beta)));
    expect(directory.saved.last.activeEndpointKey, original.activeEndpointKey);
    final firstSave = events.indexWhere((event) => event.startsWith('save:'));
    final deletion = events.indexOf('delete:${beta.endpointKey}');
    final rollbackSave = events.lastIndexWhere(
      (event) => event.startsWith('save:'),
    );
    expect(deletion, greaterThan(firstSave));
    expect(rollbackSave, greaterThan(deletion));
    expect(
      directory.directory.profiles.map((item) => item.endpointKey),
      original.profiles.map((item) => item.endpointKey),
    );
    expect(controller.state.hostDirectory.profiles, original.profiles);
    expect(controller.state.errorMessage, contains('host was restored'));
  });

  test(
    'pairing persists scoped credentials and reconnects authenticated',
    () async {
      final profile = _profile('alpha');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(profile),
      );
      final credentials = _MemoryCredentialStore();
      final connector = _FakeConnector();
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      await controller.initialize();
      final first = connector.channels.single;
      first.emit(
        _welcome(
          'host-alpha',
          authentication: 'pairing-required',
          capabilities: const <String>[],
        ),
      );
      await _flush();

      await controller.pairHost('12345');
      expect(controller.state.errorMessage, contains('six-digit'));
      final sentBeforePair = first.sent.length;
      await controller.pairHost('123456');
      final pair = first.sentJson.last;
      expect(first.sent, hasLength(sentBeforePair + 1));
      expect(pair['type'], 'pair.start');
      expect(pair['code'], '123456');
      expect(pair['deviceId'], matches(RegExp(r'^[A-Za-z0-9_-]{32}$')));

      first.emit(<String, Object?>{
        'v': 'omp-app/1',
        'type': 'pair.ok',
        'requestId': pair['requestId'],
        'pairingId': 'pair-alpha',
        'deviceId': pair['deviceId'],
        'deviceName': pair['deviceName'],
        'platform': pair['platform'],
        'requestedCapabilities': pair['requestedCapabilities'],
        'grantedCapabilities': pair['requestedCapabilities'],
        'deviceToken': _token,
        'expiresAt': DateTime.now()
            .toUtc()
            .add(const Duration(hours: 1))
            .toIso8601String(),
      });
      await _until(() => connector.channels.length == 2);

      final saved = credentials.values[profile.endpointKey];
      expect(saved?.deviceId, pair['deviceId']);
      expect(saved?.deviceToken, _token);
      final authenticatedHello = connector.channels.last.sentJson.single;
      expect(authenticatedHello['authentication'], <String, Object?>{
        'deviceId': pair['deviceId'],
        'deviceToken': _token,
      });
    },
  );

  test(
    'stale credential read cannot connect the previous active host',
    () async {
      final alpha = _profile('alpha');
      final beta = _profile('beta');
      final directory = _MemoryDirectoryStore(
        directory: const HostDirectory.empty().upsert(beta).upsert(alpha),
      );
      final delayedRead = Completer<DeviceCredentials?>();
      final credentials = _MemoryCredentialStore()
        ..delayedReads[alpha.endpointKey] = delayedRead;
      final connector = _FakeConnector();
      final controller = _controller(directory, credentials, connector);
      addTearDown(controller.dispose);
      final initializing = controller.initialize();
      await _until(() => credentials.readProfiles.contains(alpha.endpointKey));

      await controller.activateHost(beta.endpointKey);
      delayedRead.complete(null);
      await initializing;
      await _flush();

      expect(connector.uris, <Uri>[beta.webSocketUrl]);
      expect(
        controller.state.hostDirectory.activeEndpointKey,
        beta.endpointKey,
      );
    },
  );
  test('IO transport sends the exact native Origin', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final origin = Completer<String?>();
    final accepted = Completer<WebSocket>();
    server.listen((request) async {
      if (!origin.isCompleted) {
        origin.complete(request.headers.value('origin'));
      }
      final socket = await WebSocketTransformer.upgrade(request);
      accepted.complete(socket);
    });
    addTearDown(() async {
      if (accepted.isCompleted) (await accepted.future).close();
      await server.close(force: true);
    });

    final channel = await connectPlatformWebSocket(
      Uri.parse('ws://127.0.0.1:${server.port}/v1/ws'),
    );
    await channel.ready;
    expect(await origin.future, 'https://localhost');
    await channel.sink.close();
  });
}

const String _token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

T4ClientController _controller(
  HostDirectoryStore directory,
  HostCredentialStore credentials,
  _FakeConnector connector,
) => T4ClientController(
  hostDirectoryStore: directory,
  hostCredentialStore: credentials,
  webSocketConnector: connector.call,
);

HostProfile _profile(String name) =>
    HostProfile.parseTailnetAddress('$name.example.ts.net');

Map<String, Object?> _welcome(
  String hostId, {
  String authentication = 'paired',
  List<String> capabilities = const <String>['sessions.read'],
  List<String> features = const <String>[],
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'welcome',
  'selectedProtocol': 'omp-app/1',
  'hostId': hostId,
  'ompVersion': 'test',
  'ompBuild': 'test',
  'appserverVersion': 'test',
  'appserverBuild': 'test',
  'epoch': 'host-epoch',
  'authentication': authentication,
  'grantedCapabilities': capabilities,
  'grantedFeatures': features,
  'negotiatedLimits': <String, Object?>{},
  'resumed': false,
};

Map<String, Object?> _sessions(String hostId) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'sessions',
  'hostId': hostId,
  ..._sessionListResult(hostId),
};

Map<String, Object?> _sessionListResult(
  String hostId, {
  String epoch = 'index',
  int seq = 1,
}) => _sessionListResultFor(
  hostId,
  const <String>['session-alpha'],
  epoch: epoch,
  seq: seq,
);

Map<String, Object?> _sessionListResultFor(
  String hostId,
  List<String> sessionIds, {
  String epoch = 'index',
  int seq = 1,
}) => <String, Object?>{
  'cursor': <String, Object?>{'epoch': epoch, 'seq': seq},
  'sessions': sessionIds
      .map(
        (sessionId) => <String, Object?>{
          'hostId': hostId,
          'sessionId': sessionId,
          'project': <String, Object?>{'projectId': 'project-$sessionId'},
          'revision': 'revision-$sessionId',
          'title': '$sessionId title',
          'status': 'idle',
          'updatedAt': '2026-07-19T00:00:00.000Z',
        },
      )
      .toList(growable: false),
  'totalCount': sessionIds.length,
  'truncated': false,
};

Map<String, Object?> _response(
  Map<String, Object?> request, {
  required String command,
  required Object? result,
}) => <String, Object?>{
  'v': 'omp-app/1',
  'type': 'response',
  'requestId': request['requestId'],
  'commandId': request['commandId'],
  'hostId': request['hostId'],
  if (request['sessionId'] != null) 'sessionId': request['sessionId'],
  'command': command,
  'ok': true,
  'result': result,
};

Future<void> _flush() async {
  await Future<void>.delayed(Duration.zero);
  await Future<void>.delayed(Duration.zero);
}

Future<void> _until(bool Function() predicate) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Future<void>.delayed(Duration.zero);
  }
  fail('condition was not reached');
}

final class _MemoryDirectoryStore implements HostDirectoryStore {
  _MemoryDirectoryStore({
    this.directory = const HostDirectory.empty(),
    List<String>? events,
  }) : events = events ?? <String>[];

  HostDirectory directory;
  final List<String> events;
  final List<HostDirectory> saved = <HostDirectory>[];

  @override
  Future<HostDirectory> load() async {
    events.add('load');
    return directory;
  }

  @override
  Future<void> save(HostDirectory directory) async {
    events.add('save:${directory.activeEndpointKey}');
    saved.add(directory);
    this.directory = directory;
  }
}

final class _MemoryCredentialStore implements HostCredentialStore {
  _MemoryCredentialStore({List<String>? events})
    : events = events ?? <String>[];

  final List<String> events;
  final Map<String, DeviceCredentials> values = <String, DeviceCredentials>{};
  final Map<String, Completer<DeviceCredentials?>> delayedReads =
      <String, Completer<DeviceCredentials?>>{};
  final List<String> readProfiles = <String>[];
  final List<String> deleted = <String>[];
  Object? deleteError;

  @override
  Future<DeviceCredentials?> read(HostProfile profile) async {
    events.add('read:${profile.endpointKey}');
    readProfiles.add(profile.endpointKey);
    final delayed = delayedReads[profile.endpointKey];
    if (delayed != null) return delayed.future;
    return values[profile.endpointKey];
  }

  @override
  Future<void> write(HostProfile profile, DeviceCredentials credentials) async {
    values[profile.endpointKey] = credentials;
  }

  @override
  Future<void> delete(HostProfile profile) async {
    deleted.add(profile.endpointKey);
    events.add('delete:${profile.endpointKey}');
    final error = deleteError;
    if (error != null) throw error;
    values.remove(profile.endpointKey);
  }
}

final class _FakeConnector {
  _FakeConnector({List<String>? events, this.readyGate})
    : events = events ?? <String>[];

  final Completer<void>? readyGate;
  // Constructor is declared above so tests can delay a probe handshake.

  final List<String> events;
  final List<Uri> uris = <Uri>[];
  final List<_FakeWebSocketChannel> channels = <_FakeWebSocketChannel>[];

  Future<WebSocketChannel> call(Uri uri) async {
    events.add('connect:$uri');
    uris.add(uri);
    final channel = _FakeWebSocketChannel(
      channels.length,
      events,
      readyGate: readyGate,
    );
    channels.add(channel);
    return channel;
  }
}

final class _FakeWebSocketChannel implements WebSocketChannel {
  _FakeWebSocketChannel(this.index, this.events, {this.readyGate})
    : sink = _FakeWebSocketSink(index, events);

  final int index;
  final List<String> events;
  final Completer<void>? readyGate;
  final StreamController<Object?> _incoming = StreamController<Object?>();
  @override
  final _FakeWebSocketSink sink;

  List<String> get sent => sink.sent.cast<String>();
  List<Map<String, Object?>> get sentJson => sent
      .map((value) => (jsonDecode(value) as Map<String, Object?>))
      .toList(growable: false);

  void emit(Map<String, Object?> frame) => _incoming.add(jsonEncode(frame));
  void fail(Object error) => _incoming.addError(error);

  @override
  Future<void> get ready => readyGate?.future ?? Future<void>.value();
  @override
  Stream<Object?> get stream => _incoming.stream;
  @override
  String? get protocol => null;
  @override
  int? get closeCode => null;
  @override
  String? get closeReason => null;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final class _FakeWebSocketSink implements WebSocketSink {
  _FakeWebSocketSink(this.index, this.events);

  final int index;
  final List<String> events;
  final List<Object?> sent = <Object?>[];
  final Completer<void> _done = Completer<void>();

  @override
  void add(Object? data) => sent.add(data);
  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      _done.completeError(error, stackTrace);
  @override
  Future<void> addStream(Stream<Object?> stream) async =>
      sent.addAll(await stream.toList());
  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    events.add('close:$index');
    if (!_done.isCompleted) _done.complete();
  }

  @override
  Future<void> get done => _done.future;
}
