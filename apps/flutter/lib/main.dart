import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter/foundation.dart';

import 'src/client/app_state.dart';
import 'src/client/t4_client_controller.dart';
import 'src/client/transcript_tail_store.dart';
import 'src/client/web_socket_connector.dart';
import 'src/demo/demo_app.dart';
import 'src/host/app_preferences.dart';
import 'src/host/persistent_host_stores.dart';
import 'src/platform/platform_lifecycle_controller.dart';
import 'src/ui/t4_app.dart';

void main() {
  const demoMode = bool.fromEnvironment('T4_DEMO_MODE');
  if (demoMode) {
    runApp(T4DemoApp());
    return;
  }
  final configuredEndpoint = _developmentEndpoint();
  final localEndpoint = configuredEndpoint == null
      ? platformLocalWebSocketEndpoint()
      : null;
  runApp(
    T4Bootstrap(
      developmentEndpoint: configuredEndpoint,
      localEndpoint: localEndpoint,
      manageLocalRuntime: localEndpoint != null,
    ),
  );
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
  const T4Bootstrap({
    this.developmentEndpoint,
    this.localEndpoint,
    this.manageLocalRuntime = false,
    super.key,
  });

  final Uri? developmentEndpoint;
  final Uri? localEndpoint;
  final bool manageLocalRuntime;

  @override
  State<T4Bootstrap> createState() => _T4BootstrapState();
}

final class _T4BootstrapState extends State<T4Bootstrap>
    with WidgetsBindingObserver {
  late final T4ClientController _controller;
  late final PlatformLifecycleController _platformController;
  late final bool _credentialsAreVolatile;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _credentialsAreVolatile =
        kDebugMode && defaultTargetPlatform == TargetPlatform.macOS;
    _controller = T4ClientController(
      hostDirectoryStore: PersistentHostDirectoryStore(),
      hostCredentialStore: _credentialsAreVolatile
          ? VolatileHostCredentialStore()
          : SecureHostCredentialStore(),
      appPreferenceStore: PersistentAppPreferenceStore(),
      transcriptTailStore: PersistentTranscriptTailStore(),
      developmentEndpoint: widget.developmentEndpoint,
      localEndpoint: widget.localEndpoint,
    );
    _platformController = PlatformLifecycleController();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_initialize());
    });
  }

  Future<void> _initialize() async {
    await _platformController.initialize();
    if (!mounted) return;
    if (widget.manageLocalRuntime) {
      await _platformController.ensureRuntimeReady();
      if (!mounted) return;
    }
    await _controller.initialize();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        unawaited(_controller.handleLifecyclePhase(T4LifecyclePhase.resumed));
        unawaited(_platformController.refreshPlatformState());
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        unawaited(
          _controller.handleLifecyclePhase(T4LifecyclePhase.background),
        );
      case AppLifecycleState.inactive:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge(<Listenable>[
        _controller,
        _platformController,
      ]),
      builder: (context, _) => T4App(
        state: _controller.state,
        actions: _controller,
        credentialsAreVolatile: _credentialsAreVolatile,
        platformState: _platformController.state,
        platformActions: _platformController,
      ),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.dispose();
    _platformController.dispose();
    super.dispose();
  }
}
