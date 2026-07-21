import 'dart:async';
import 'dart:io';

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

final Uri _localEndpoint = Uri.parse('ws://omp.local/ws');

Uri? platformLocalWebSocketEndpoint() {
  if (!Platform.isMacOS) return null;
  final home = Platform.environment['HOME'];
  if (home == null || !home.startsWith('/') || home.contains('\u0000')) {
    return null;
  }
  return _localEndpoint;
}

String _defaultLocalSocketPath() {
  final home = Platform.environment['HOME'];
  if (home == null || !home.startsWith('/') || home.contains('\u0000')) {
    throw const FileSystemException('A safe home directory is unavailable.');
  }
  return '$home/.omp/run/appserver.sock';
}

Future<WebSocketChannel> connectPlatformWebSocket(Uri endpoint) async {
  if (Platform.isMacOS && endpoint == _localEndpoint) {
    return connectUnixWebSocket(_defaultLocalSocketPath());
  }
  return IOWebSocketChannel.connect(
    endpoint,
    headers: const <String, String>{'Origin': 'https://localhost'},
  );
}

Future<WebSocketChannel> connectUnixWebSocket(String socketPath) async {
  if (!socketPath.startsWith('/') ||
      socketPath.contains('\u0000') ||
      socketPath.length > 4096) {
    throw const FileSystemException('The local T4 socket path is invalid.');
  }
  final type = await FileSystemEntity.type(socketPath, followLinks: true);
  if (type != FileSystemEntityType.unixDomainSock) {
    throw FileSystemException(
      'The local T4 service socket is unavailable.',
      socketPath,
    );
  }
  final address = InternetAddress(socketPath, type: InternetAddressType.unix);
  final client = HttpClient();
  client.findProxy = (_) => 'DIRECT';
  client.connectionFactory = (_, proxyHost, proxyPort) {
    if (proxyHost != null || proxyPort != null) {
      throw StateError('The local T4 socket cannot use a proxy.');
    }
    return Socket.startConnect(address, 0);
  };
  final channel = IOWebSocketChannel.connect(
    _localEndpoint,
    headers: const <String, String>{'Origin': 'https://localhost'},
    customClient: client,
    connectTimeout: const Duration(seconds: 5),
  );
  unawaited(channel.ready.whenComplete(client.close));
  return channel;
}
