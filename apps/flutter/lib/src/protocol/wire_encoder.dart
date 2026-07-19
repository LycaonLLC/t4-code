import 'dart:convert';

import 'models.dart';

const int _maxSafeInteger = 9007199254740991;
const int _maxSavedCursors = 128;

/// Explicit builders for the outbound Stage 1 omp-app/1 frames.
abstract final class WireEncoder {
  static String hello({
    required ClientIdentity client,
    Iterable<String> requestedFeatures = const <String>[],
    Iterable<SavedCursor> savedCursors = const <SavedCursor>[],
    Iterable<String> capabilities = const <String>[],
    DeviceAuthentication? authentication,
  }) {
    final features = requestedFeatures.toList(growable: false);
    final cursors = savedCursors.toList(growable: false);
    final requestedCapabilities = capabilities.toList(growable: false);
    _boundedStrings(features, 'requestedFeatures', 128);
    _boundedStrings(requestedCapabilities, 'capabilities', 128);
    if (cursors.length > _maxSavedCursors) {
      throw ArgumentError.value(
        cursors.length,
        'savedCursors',
        'must contain at most $_maxSavedCursors cursors',
      );
    }

    final clientJson = <String, Object?>{
      'name': _controlString(client.name, 'client.name', 128),
      'version': _controlString(client.version, 'client.version', 64),
      'build': _controlString(client.build, 'client.build', 128),
      'platform': _controlString(client.platform, 'client.platform', 128),
    };
    final cursorJson = <Map<String, Object?>>[];
    for (var index = 0; index < cursors.length; index++) {
      final saved = cursors[index];
      cursorJson.add(<String, Object?>{
        'hostId': _id(saved.hostId, 'savedCursors[$index].hostId'),
        'sessionId': _id(saved.sessionId, 'savedCursors[$index].sessionId'),
        'cursor': _cursorJson(saved.cursor, 'savedCursors[$index].cursor'),
      });
    }

    final frame = <String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'hello',
      'protocol': <String, String>{
        'min': ompAppProtocolVersion,
        'max': ompAppProtocolVersion,
      },
      'client': clientJson,
      'requestedFeatures': features,
      'savedCursors': cursorJson,
      if (requestedCapabilities.isNotEmpty)
        'capabilities': <String, Object?>{'client': requestedCapabilities},
      if (authentication != null)
        'authentication': <String, String>{
          'deviceId': _id(authentication.deviceId, 'authentication.deviceId'),
          'deviceToken': _deviceToken(authentication.deviceToken),
        },
    };
    return jsonEncode(frame);
  }

  static String sessionAttach({
    required String requestId,
    required String commandId,
    required String hostId,
    required String sessionId,
    TranscriptCursor? cursor,
  }) {
    return _command(
      requestId: requestId,
      commandId: commandId,
      hostId: hostId,
      sessionId: sessionId,
      command: 'session.attach',
      args: <String, Object?>{
        if (cursor != null) 'cursor': _cursorJson(cursor, 'cursor'),
      },
    );
  }

  static String sessionPrompt({
    required String requestId,
    required String commandId,
    required String hostId,
    required String sessionId,
    required String expectedRevision,
    required String text,
  }) {
    return _command(
      requestId: requestId,
      commandId: commandId,
      hostId: hostId,
      sessionId: sessionId,
      command: 'session.prompt',
      expectedRevision: _id(expectedRevision, 'expectedRevision'),
      args: <String, Object?>{'message': _boundedText(text, 'text', 65536)},
    );
  }

  static String pong({required String nonce, String? timestamp}) {
    return jsonEncode(<String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'pong',
      'nonce': _controlString(nonce, 'nonce', 128),
      'timestamp': _controlString(
        timestamp ?? DateTime.now().toUtc().toIso8601String(),
        'timestamp',
        128,
      ),
    });
  }

  static String _command({
    required String requestId,
    required String commandId,
    required String hostId,
    required String sessionId,
    required String command,
    required Map<String, Object?> args,
    String? expectedRevision,
  }) {
    return jsonEncode(<String, Object?>{
      'v': ompAppProtocolVersion,
      'type': 'command',
      'requestId': _id(requestId, 'requestId'),
      'commandId': _id(commandId, 'commandId'),
      'hostId': _id(hostId, 'hostId'),
      'sessionId': _id(sessionId, 'sessionId'),
      'command': command,
      'expectedRevision': ?expectedRevision,
      'args': args,
    });
  }
}

Map<String, Object?> _cursorJson(TranscriptCursor cursor, String path) {
  if (cursor.seq < 0 || cursor.seq > _maxSafeInteger) {
    throw ArgumentError.value(
      cursor.seq,
      '$path.seq',
      'must be a safe nonnegative integer',
    );
  }
  return <String, Object?>{
    'epoch': _controlString(cursor.epoch, '$path.epoch', 128),
    'seq': cursor.seq,
  };
}

void _boundedStrings(List<String> values, String path, int maxItems) {
  if (values.length > maxItems) {
    throw ArgumentError.value(
      values.length,
      path,
      'must contain at most $maxItems values',
    );
  }
  for (var index = 0; index < values.length; index++) {
    _controlString(values[index], '$path[$index]', 256);
  }
}

String _id(String value, String path) => _controlString(value, path, 256);

String _deviceToken(String value) {
  final canonical = RegExp(r'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$');
  if (!canonical.hasMatch(value)) {
    throw ArgumentError.value(
      value,
      'authentication.deviceToken',
      'must be canonical base64url for exactly 32 bytes',
    );
  }
  return value;
}

String _controlString(String value, String path, int maxBytes) {
  if (value.isEmpty ||
      !_utf8LengthAtMost(value, maxBytes) ||
      _hasControlCharacter(value)) {
    throw ArgumentError.value(
      value,
      path,
      'must be a bounded non-empty string',
    );
  }
  return value;
}

String _boundedText(String value, String path, int maxBytes) {
  if (!_utf8LengthAtMost(value, maxBytes)) {
    throw ArgumentError.value(value, path, 'exceeds the UTF-8 byte limit');
  }
  return value;
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
