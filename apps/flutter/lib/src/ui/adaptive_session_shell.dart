part of 't4_proof_app.dart';

final class _AdaptiveSessionShell extends StatefulWidget {
  const _AdaptiveSessionShell({required this.state, required this.actions});

  final ProofViewState state;
  final ProofActions actions;

  @override
  State<_AdaptiveSessionShell> createState() => _AdaptiveSessionShellState();
}

final class _AdaptiveSessionShellState extends State<_AdaptiveSessionShell> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  String? _selectingSessionId;
  bool _connecting = false;

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

  Future<void> _selectSession(
    String sessionId, {
    required bool closeDrawer,
  }) async {
    if (_selectingSessionId != null) return;
    if (sessionId == widget.state.selectedSessionId) {
      if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
      return;
    }

    setState(() => _selectingSessionId = sessionId);
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

  void _openSessions() => _scaffoldKey.currentState?.openDrawer();

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= _ProofBreakpoints.wide) {
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
              width: _ProofLayout.sessionRailWidth,
              child: _SessionNavigation(
                state: widget.state,
                mode: _SessionNavigationMode.rail,
                connecting: _connecting,
                selectingSessionId: _selectingSessionId,
                onConnect: _connect,
                onSelectSession: (sessionId) =>
                    _selectSession(sessionId, closeDrawer: false),
              ),
            ),
            const VerticalDivider(width: _ProofSize.divider),
            Expanded(
              child: _ConversationPane(
                state: widget.state,
                actions: widget.actions,
                showHeader: true,
                onConnect: _connect,
              ),
            ),
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
        toolbarHeight: _ProofLayout.compactToolbarHeight,
        leading: IconButton(
          onPressed: _openSessions,
          tooltip: 'Open sessions',
          icon: const Icon(Icons.menu),
        ),
        titleSpacing: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _displaySessionTitle(widget.state.selectedSession),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: _ProofSpace.xxs),
            _CompactConnectionLabel(phase: phase, actionPending: _connecting),
          ],
        ),
        actions: [
          if (actionLabel != null)
            IconButton(
              onPressed: _connecting ? null : () => unawaited(_connect()),
              tooltip: actionLabel,
              icon: Icon(
                phase == ConnectionPhase.failed
                    ? Icons.refresh
                    : Icons.power_settings_new,
              ),
            ),
          const SizedBox(width: _ProofSpace.xxs),
        ],
      ),
      drawer: Drawer(
        child: _SessionNavigation(
          state: widget.state,
          mode: _SessionNavigationMode.drawer,
          connecting: _connecting,
          selectingSessionId: _selectingSessionId,
          onConnect: _connect,
          onSelectSession: (sessionId) =>
              _selectSession(sessionId, closeDrawer: true),
          onClose: () => _scaffoldKey.currentState?.closeDrawer(),
        ),
      ),
      body: _ConversationPane(
        state: widget.state,
        actions: widget.actions,
        showHeader: false,
        onConnect: _connect,
        onOpenSessions: _openSessions,
      ),
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
            dimension: _ProofSpace.sm,
            child: active
                ? CircularProgressIndicator(
                    strokeWidth: _ProofSize.thinStroke,
                    color: scheme.primary,
                    semanticsLabel: phase.label,
                  )
                : Icon(
                    Icons.circle,
                    size: _ProofSpace.xs,
                    color: phase == ConnectionPhase.ready
                        ? scheme.primary
                        : scheme.outline,
                  ),
          ),
          const SizedBox(width: _ProofSpace.xs),
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
