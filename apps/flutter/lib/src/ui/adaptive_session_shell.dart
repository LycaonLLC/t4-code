part of 't4_app.dart';

final class _AdaptiveSessionShell extends StatefulWidget {
  const _AdaptiveSessionShell({required this.state, required this.actions});

  final T4ViewState state;
  final T4Actions actions;

  @override
  State<_AdaptiveSessionShell> createState() => _AdaptiveSessionShellState();
}

final class _AdaptiveSessionShellState extends State<_AdaptiveSessionShell> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  String? _selectingSessionId;
  bool _connecting = false;
  bool _disconnecting = false;
  bool _showHostManager = false;

  Future<void> _connect() async {
    if (_connecting) return;
    setState(() => _connecting = true);
    try {
      await widget.actions.connect();
    } on Object {
      if (!mounted) return;
      _showActionFailure('Could not connect. Try again.');
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Future<void> _disconnect() async {
    if (_disconnecting) return;
    setState(() => _disconnecting = true);
    try {
      await widget.actions.disconnect();
    } on Object {
      if (!mounted) return;
      _showActionFailure('Could not disconnect. Try again.');
    } finally {
      if (mounted) setState(() => _disconnecting = false);
    }
  }

  Future<void> _runConnectionAction() =>
      widget.state.connectionPhase.canDisconnect ? _disconnect() : _connect();

  Future<void> _selectSession(
    String sessionId, {
    required bool closeDrawer,
  }) async {
    if (_selectingSessionId != null) return;
    if (sessionId == widget.state.selectedSessionId) {
      setState(() => _showHostManager = false);
      if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
      return;
    }

    setState(() {
      _showHostManager = false;
      _selectingSessionId = sessionId;
    });
    try {
      await widget.actions.selectSession(sessionId);
      if (!mounted) return;
      if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
    } on Object {
      if (!mounted) return;
      _showActionFailure('Could not open that session. Try again.');
    } finally {
      if (mounted) setState(() => _selectingSessionId = null);
    }
  }

  void _showActionFailure(String message) {
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _openNavigation() => _scaffoldKey.currentState?.openDrawer();

  void _openHostManager({required bool closeDrawer}) {
    setState(() => _showHostManager = true);
    if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
  }

  void _closeHostManager() => setState(() => _showHostManager = false);

  Widget _primaryContent({required bool showHeader}) {
    if (_showHostManager) {
      return _HostManagerPane(
        state: widget.state,
        actions: widget.actions,
        onDone: _closeHostManager,
      );
    }

    if (widget.state.authenticationPhase ==
            AuthenticationPhase.pairingRequired ||
        widget.state.authenticationPhase == AuthenticationPhase.pairing) {
      return _PairingPane(state: widget.state, actions: widget.actions);
    }

    return _ConversationPane(
      state: widget.state,
      actions: widget.actions,
      showHeader: showHeader,
      onConnect: _connect,
      onOpenSessions: showHeader ? null : _openNavigation,
    );
  }

  @override
  Widget build(BuildContext context) {
    final needsOnboarding =
        !widget.state.targetConfigured &&
        widget.state.hostDirectory.profiles.isEmpty &&
        widget.state.connectionPhase == ConnectionPhase.disconnected;
    if (needsOnboarding) {
      return _HostOnboardingPage(state: widget.state, actions: widget.actions);
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= _T4Breakpoints.wide) {
          return _buildWide(context);
        }
        return _buildCompact(context);
      },
    );
  }

  Widget _buildWide(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Row(
          children: [
            SizedBox(
              width: _T4Layout.sessionRailWidth,
              child: _SessionNavigation(
                state: widget.state,
                mode: _SessionNavigationMode.rail,
                connecting: _connecting,
                disconnecting: _disconnecting,
                selectingSessionId: _selectingSessionId,
                showingHostManager: _showHostManager,
                onConnect: _connect,
                onDisconnect: _disconnect,
                onManageHosts: () => _openHostManager(closeDrawer: false),
                onSelectSession: (sessionId) =>
                    _selectSession(sessionId, closeDrawer: false),
              ),
            ),
            const VerticalDivider(width: _T4Size.divider),
            Expanded(child: _primaryContent(showHeader: true)),
          ],
        ),
      ),
    );
  }

  Widget _buildCompact(BuildContext context) {
    final phase = widget.state.connectionPhase;
    final actionLabel = phase.actionLabel;

    return Scaffold(
      key: _scaffoldKey,
      appBar: AppBar(
        toolbarHeight: _T4Layout.compactToolbarHeight,
        leading: IconButton(
          onPressed: _openNavigation,
          tooltip: 'Open navigation',
          icon: const Icon(Icons.menu),
        ),
        titleSpacing: 0,
        title: _showHostManager
            ? Text('Hosts', style: Theme.of(context).textTheme.titleMedium)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    _displaySessionTitle(widget.state.selectedSession),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: _T4Space.xxs),
                  _CompactConnectionLabel(
                    phase: phase,
                    actionPending: _connecting,
                  ),
                ],
              ),
        actions: [
          if (!_showHostManager)
            IconButton(
              onPressed: _connecting || _disconnecting
                  ? null
                  : () => unawaited(_runConnectionAction()),
              tooltip: actionLabel,
              icon: Icon(
                phase.canDisconnect
                    ? Icons.link_off
                    : phase == ConnectionPhase.failed
                    ? Icons.refresh
                    : Icons.power_settings_new,
              ),
            ),
          const SizedBox(width: _T4Space.xxs),
        ],
      ),
      drawer: Drawer(
        child: _SessionNavigation(
          state: widget.state,
          mode: _SessionNavigationMode.drawer,
          connecting: _connecting,
          selectingSessionId: _selectingSessionId,
          disconnecting: _disconnecting,
          showingHostManager: _showHostManager,
          onConnect: _connect,
          onDisconnect: _disconnect,
          onManageHosts: () => _openHostManager(closeDrawer: true),
          onSelectSession: (sessionId) =>
              _selectSession(sessionId, closeDrawer: true),
          onClose: () => _scaffoldKey.currentState?.closeDrawer(),
        ),
      ),
      body: _primaryContent(showHeader: false),
    );
  }
}

final class _CompactConnectionLabel extends StatelessWidget {
  const _CompactConnectionLabel({
    required this.phase,
    required this.actionPending,
  });

  final ConnectionPhase phase;
  final bool actionPending;

  @override
  Widget build(BuildContext context) {
    final active = phase.isActive || actionPending;
    final scheme = Theme.of(context).colorScheme;

    return Semantics(
      label: 'Connection status: ${phase.label}',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox.square(
            dimension: _T4Space.sm,
            child: active
                ? CircularProgressIndicator(
                    strokeWidth: _T4Size.thinStroke,
                    color: scheme.primary,
                    semanticsLabel: phase.label,
                  )
                : Icon(
                    Icons.circle,
                    size: _T4Space.xs,
                    color: phase == ConnectionPhase.ready
                        ? scheme.primary
                        : scheme.outline,
                  ),
          ),
          const SizedBox(width: _T4Space.xs),
          Text(
            phase.label,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
