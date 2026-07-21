import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/web_socket_connector_io.dart';

void main() {
  test('connects to the local T4 WebSocket over a Unix socket', () async {
    final directory = await Directory.systemTemp.createTemp(
      't4-flutter-local-socket-',
    );
    final backingSocketPath = '${directory.path}/.appserver-test.sock';
    final socketPath = '${directory.path}/appserver.sock';
    final server = await HttpServer.bind(
      InternetAddress(backingSocketPath, type: InternetAddressType.unix),
      0,
    );
    await Link(socketPath).create(backingSocketPath);
    addTearDown(() async {
      await server.close(force: true);
      await directory.delete(recursive: true);
    });
    final origin = Completer<String?>();
    server.listen((request) async {
      if (!origin.isCompleted) origin.complete(request.headers.value('origin'));
      final socket = await WebSocketTransformer.upgrade(request);
      socket.listen(socket.add);
    });

    final channel = await connectUnixWebSocket(socketPath);
    addTearDown(channel.sink.close);
    await channel.ready;
    channel.sink.add('local transport');

    expect(await channel.stream.first, 'local transport');
    expect(await origin.future, 'https://localhost');
  });

  final liveSocket = Platform.environment['T4_LIVE_UNIX_SOCKET'];
  test(
    'connects to a live local T4 host when requested',
    () async {
      final channel = await connectUnixWebSocket(liveSocket!);
      addTearDown(channel.sink.close);
      await channel.ready.timeout(const Duration(seconds: 10));
    },
    skip: liveSocket == null ? 'Set T4_LIVE_UNIX_SOCKET for a live smoke test.' : false,
  );
}
