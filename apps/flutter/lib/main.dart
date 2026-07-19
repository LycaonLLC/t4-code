import 'dart:async';

import 'package:flutter/widgets.dart';

import 'src/client/proof_controller.dart';
import 'src/ui/t4_proof_app.dart';

void main() {
  runApp(ProofBootstrap(endpoint: _fixtureEndpoint()));
}

Uri? _fixtureEndpoint() {
  const configured = String.fromEnvironment('T4_FIXTURE_URL');
  if (configured.isEmpty) return null;
  final endpoint = Uri.tryParse(configured);
  if (endpoint == null ||
      (endpoint.scheme != 'ws' && endpoint.scheme != 'wss')) {
    return null;
  }
  return endpoint;
}

final class ProofBootstrap extends StatefulWidget {
  const ProofBootstrap({required this.endpoint, super.key});

  final Uri? endpoint;

  @override
  State<ProofBootstrap> createState() => _ProofBootstrapState();
}

final class _ProofBootstrapState extends State<ProofBootstrap> {
  late final ProofController _controller;

  @override
  void initState() {
    super.initState();
    _controller = ProofController(endpoint: widget.endpoint);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_controller.connect());
    });
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) =>
          T4ProofApp(state: _controller.state, actions: _controller),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}
