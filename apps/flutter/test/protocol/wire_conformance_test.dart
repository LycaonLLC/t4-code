import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/protocol/protocol.dart';

const _corpusPath =
    '../../packages/client/test/fixtures/protocol/omp-app-v1-corpus.json';

void main() {
  final corpus = _loadCorpus();

  group('inbound wire conformance', () {
    final supportedFamilies = <String, Matcher>{
      'welcome': isA<WelcomeFrame>(),
      'successful-response': isA<ResponseFrame>(),
      'authorization-error': isA<ErrorFrame>(),
      'session-list': isA<SessionsFrame>(),
      'transcript-snapshot': isA<SnapshotFrame>(),
      'streaming-event': isA<EventFrame>(),
      'continuity-gap': isA<GapFrame>(),
      'heartbeat-pong': isA<PongFrame>(),
    };

    for (final entry in supportedFamilies.entries) {
      test('${entry.key} decodes to its sealed frame family', () {
        final fixture = _namedCase(corpus, 'inbound', entry.key);

        expect(
          WireDecoder.decode(jsonEncode(fixture['wire'])),
          entry.value,
          reason: entry.key,
        );
      });
    }

    test('every canonical invalidInbound case is rejected', () {
      final invalidCases = _caseList(corpus, 'invalidInbound');

      expect(invalidCases, isNotEmpty);
      for (final fixture in invalidCases) {
        final name = fixture['name']! as String;
        expect(
          () => WireDecoder.decode(jsonEncode(fixture['wire'])),
          throwsA(isA<WireFormatException>()),
          reason: name,
        );
      }
    });

    test('additive and unknown event data is preserved but immutable', () {
      final fixture = _namedCase(corpus, 'inbound', 'streaming-event');
      final wire = _cloneMap(fixture['wire']);
      final event = _asMap(wire['event']);
      event['type'] = 'future.message.decorated';
      event['futureData'] = <String, Object?>{
        'enabled': true,
        'labels': <Object?>['preserved'],
      };
      wire['futureEnvelopeData'] = <String, Object?>{'generation': 2};
      final expectedEvent = _cloneMap(event);

      final frame = WireDecoder.decode(jsonEncode(wire));

      expect(frame, isA<EventFrame>());
      final eventFrame = frame as EventFrame;
      expect(eventFrame.event, expectedEvent);
      expect(eventFrame.raw['futureEnvelopeData'], <String, Object?>{
        'generation': 2,
      });
      expect(() => eventFrame.event['added'] = true, throwsUnsupportedError);
      final futureData = _asMap(eventFrame.event['futureData']);
      expect(() => futureData['enabled'] = false, throwsUnsupportedError);
      final labels = futureData['labels']! as List<Object?>;
      expect(() => labels.add('changed'), throwsUnsupportedError);
      expect(
        () => eventFrame.raw['futureEnvelopeData'] = null,
        throwsUnsupportedError,
      );
    });

    test('wrong protocol version fails at the version boundary', () {
      final fixture = _namedCase(corpus, 'inbound', 'welcome');
      final wire = _cloneMap(fixture['wire'])..['v'] = 'omp-app/2';

      expect(
        () => WireDecoder.decode(jsonEncode(wire)),
        throwsA(
          isA<WireFormatException>()
              .having((error) => error.path, 'path', 'v')
              .having(
                (error) => error.message,
                'message',
                'protocol version must be exactly omp-app/1',
              ),
        ),
      );
    });

    test('unknown top-level frame family fails at the type boundary', () {
      final fixture = _namedCase(corpus, 'inbound', 'heartbeat-pong');
      final wire = _cloneMap(fixture['wire'])..['type'] = 'future.frame';

      expect(
        () => WireDecoder.decode(jsonEncode(wire)),
        throwsA(
          isA<WireFormatException>()
              .having((error) => error.path, 'path', 'type')
              .having(
                (error) => error.message,
                'message',
                'unknown top-level frame family',
              ),
        ),
      );
    });

    test('inbound frames larger than 4 MiB are rejected before parsing', () {
      final oversizedFrame = ''.padRight(4 * 1024 * 1024 + 1, 'x');

      expect(
        () => WireDecoder.decode(oversizedFrame),
        throwsA(
          isA<WireFormatException>().having(
            (error) => error.message,
            'message',
            'inbound frame exceeds the 4 MiB UTF-8 limit',
          ),
        ),
      );
    });
  });

  group('outbound wire conformance', () {
    test('hello matches the canonical correlated frame without mutation', () {
      final fixture = _namedCase(
        corpus,
        'outbound',
        'hello-with-resume-and-authentication',
      );
      final message = _asMap(fixture['message']);
      final client = _asMap(message['client']);
      final authentication = _asMap(message['authentication']);
      final requestedFeatures = _strings(message['requestedFeatures']);
      final capabilities = _strings(message['capabilities']);
      final savedCursors = (_asList(message['savedCursors'])).map((value) {
        final saved = _asMap(value);
        final cursor = _asMap(saved['cursor']);
        return SavedCursor(
          hostId: saved['hostId']! as String,
          sessionId: saved['sessionId']! as String,
          cursor: TranscriptCursor(
            epoch: cursor['epoch']! as String,
            seq: cursor['seq']! as int,
          ),
        );
      }).toList();
      final requestedFeaturesBefore = List<String>.of(requestedFeatures);
      final capabilitiesBefore = List<String>.of(capabilities);
      final savedCursorsBefore = List<SavedCursor>.of(savedCursors);

      final encoded = WireEncoder.hello(
        client: ClientIdentity(
          name: client['name']! as String,
          version: client['version']! as String,
          build: client['build']! as String,
          platform: client['platform']! as String,
        ),
        requestedFeatures: requestedFeatures,
        savedCursors: savedCursors,
        capabilities: capabilities,
        authentication: DeviceAuthentication(
          deviceId: authentication['deviceId']! as String,
          deviceToken: authentication['deviceToken']! as String,
        ),
      );

      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(requestedFeatures, requestedFeaturesBefore);
      expect(capabilities, capabilitiesBefore);
      expect(savedCursors, savedCursorsBefore);
    });

    test('session prompt matches the canonical correlated command', () {
      final fixture = _namedCase(corpus, 'outbound', 'session-prompt-command');
      final message = _asMap(fixture['message']);
      final args = _asMap(message['args']);
      final before = jsonEncode(message);

      final encoded = WireEncoder.sessionPrompt(
        requestId: message['requestId']! as String,
        commandId: message['commandId']! as String,
        hostId: message['hostId']! as String,
        sessionId: message['sessionId']! as String,
        expectedRevision: message['expectedRevision']! as String,
        text: args['text']! as String,
      );

      expect(
        jsonDecode(encoded),
        fixture['wire'],
        reason: fixture['name']! as String,
      );
      expect(jsonEncode(message), before);
    });

    test(
      'session attach uses canonical command correlation and cursor JSON',
      () {
        final commandFixture = _namedCase(
          corpus,
          'outbound',
          'session-prompt-command',
        );
        final snapshotFixture = _namedCase(
          corpus,
          'inbound',
          'transcript-snapshot',
        );
        final command = _asMap(commandFixture['message']);
        final snapshotWire = _asMap(snapshotFixture['wire']);
        final cursorJson = _asMap(snapshotWire['cursor']);
        final cursor = TranscriptCursor(
          epoch: cursorJson['epoch']! as String,
          seq: cursorJson['seq']! as int,
        );
        final commandBefore = jsonEncode(command);
        final cursorBefore = _cloneMap(cursorJson);
        final expected = _cloneMap(commandFixture['wire']);
        expected
          ..remove('expectedRevision')
          ..['command'] = 'session.attach'
          ..['args'] = <String, Object?>{'cursor': _cloneMap(cursorJson)};

        final encoded = WireEncoder.sessionAttach(
          requestId: command['requestId']! as String,
          commandId: command['commandId']! as String,
          hostId: command['hostId']! as String,
          sessionId: command['sessionId']! as String,
          cursor: cursor,
        );

        expect(jsonDecode(encoded), expected);
        expect(jsonEncode(command), commandBefore);
        expect(cursorJson, cursorBefore);
        expect(
          cursor,
          TranscriptCursor(
            epoch: cursorBefore['epoch']! as String,
            seq: cursorBefore['seq']! as int,
          ),
        );
      },
    );

    test('pong echoes the canonical nonce and timestamp without mutation', () {
      final fixture = _namedCase(corpus, 'inbound', 'heartbeat-pong');
      final wire = _asMap(fixture['wire']);
      final before = jsonEncode(wire);

      final encoded = WireEncoder.pong(
        nonce: wire['nonce']! as String,
        timestamp: wire['timestamp']! as String,
      );

      expect(jsonDecode(encoded), wire, reason: fixture['name']! as String);
      expect(jsonEncode(wire), before);
    });
  });
}

Map<String, Object?> _loadCorpus() {
  final file = File(_corpusPath);
  if (!file.existsSync()) {
    throw StateError('Canonical protocol corpus not found at $_corpusPath');
  }
  return jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
}

List<Map<String, Object?>> _caseList(
  Map<String, Object?> corpus,
  String section,
) => _asList(corpus[section]).map(_asMap).toList(growable: false);

Map<String, Object?> _namedCase(
  Map<String, Object?> corpus,
  String section,
  String name,
) => _caseList(
  corpus,
  section,
).singleWhere((fixture) => fixture['name'] == name);

Map<String, Object?> _cloneMap(Object? value) =>
    jsonDecode(jsonEncode(value)) as Map<String, Object?>;

Map<String, Object?> _asMap(Object? value) => value! as Map<String, Object?>;

List<Object?> _asList(Object? value) => value! as List<Object?>;

List<String> _strings(Object? value) => _asList(value).cast<String>().toList();
