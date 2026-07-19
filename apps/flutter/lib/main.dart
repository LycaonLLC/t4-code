import 'dart:async';

import 'package:flutter/widgets.dart';

import 'src/client/t4_client_controller.dart';
import 'src/host/persistent_host_stores.dart';
import 'src/ui/t4_app.dart';

void main() {
  runApp(T4Bootstrap(developmentEndpoint: _developmentEndpoint()));
}

Uri? _developmentEndpoint() {
  const configured = String.fromEnvironment('T4_DEVELOPMENT_ENDPOINT');
  if (configured.isEmpty) return null;
  final endpoint = Uri.tryParse(configured);
  if (endpoint == null ||
      (endpoint.scheme != 'ws' && endpoint.scheme != 'wss')) {
    return null;
  }
  return endpoint;
}

final class T4Bootstrap extends StatefulWidget {
  const T4Bootstrap({this.developmentEndpoint, super.key});

  final Uri? developmentEndpoint;

  @override
  State<T4Bootstrap> createState() => _T4BootstrapState();
}

final class _T4BootstrapState extends State<T4Bootstrap> {
  late final T4ClientController _controller;

  @override
  void initState() {
    super.initState();
    _controller = T4ClientController(
      hostDirectoryStore: PersistentHostDirectoryStore(),
      hostCredentialStore: SecureHostCredentialStore(),
      developmentEndpoint: widget.developmentEndpoint,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_controller.initialize());
    });
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) =>
          T4App(state: _controller.state, actions: _controller),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}
