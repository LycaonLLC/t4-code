part of 't4_app.dart';

final class _AdaptiveSessionShell extends StatefulWidget {
  const _AdaptiveSessionShell({
    required this.state,
    required this.actions,
    required this.platformState,
    required this.platformActions,
  });

  final T4ViewState state;
  final T4Actions actions;
  final PlatformLifecycleViewState platformState;
  final PlatformLifecycleActions? platformActions;

  @override
  State<_AdaptiveSessionShell> createState() => _AdaptiveSessionShellState();
}

final class _AdaptiveSessionShellState extends State<_AdaptiveSessionShell> {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();
  String? _selectingSessionId;
  bool _connecting = false;
  bool _disconnecting = false;
  bool _showHostManager = false;
  bool _showAttention = false;
  bool _showDeveloper = false;
  bool _showSettings = false;
  bool _showSearch = false;
  bool _showUsage = false;
  bool _showContextPanel = false;
  int _developerInitialTab = 0;

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
      setState(() {
        _showHostManager = false;
        _showAttention = false;
        _showDeveloper = false;
        _showSettings = false;
        _showSearch = false;
        _showUsage = false;
      });
      if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
      return;
    }

    setState(() {
      _showHostManager = false;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = false;
      _showSearch = false;
      _showUsage = false;
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
    setState(() {
      _showHostManager = true;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = false;
      _showSearch = false;
      _showUsage = false;
    });
    if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
  }

  void _closeHostManager() => setState(() => _showHostManager = false);

  void _openAttention() => setState(() {
    _showHostManager = false;
    _showDeveloper = false;
    _showSettings = false;
    _showSearch = false;
    _showUsage = false;
    _showAttention = true;
  });

  void _closeAttention() => setState(() => _showAttention = false);

  void _openDeveloper({int initialTab = 0}) => setState(() {
    _showHostManager = false;
    _showAttention = false;
    _showDeveloper = true;
    _developerInitialTab = initialTab;
    _showSettings = false;
    _showSearch = false;
    _showUsage = false;
  });

  void _closeDeveloper() => setState(() => _showDeveloper = false);

  bool get _canQuickOpen =>
      widget.state.connectionPhase == ConnectionPhase.ready &&
      widget.state.selectedSession != null &&
      widget.state.grantedCapabilities.contains('files.list') &&
      widget.state.grantedCapabilities.contains('files.read') &&
      widget.state.grantedFeatures.contains('files.search');

  Future<void> _openQuickOpen() async {
    if (!_canQuickOpen) return;
    final path = await showDialog<String>(
      context: context,
      builder: (context) => _QuickOpenDialog(actions: widget.actions),
    );
    if (path == null || !mounted) return;
    try {
      await widget.actions.readFile(path);
      if (mounted) _openDeveloper(initialTab: 1);
    } on Object {
      if (mounted) _showActionFailure('Could not open that project file.');
    }
  }

  void _openSettings({required bool closeDrawer}) {
    setState(() {
      _showHostManager = false;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = true;
      _showSearch = false;
      _showUsage = false;
    });
    if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
  }

  void _closeSettings() => setState(() => _showSettings = false);

  void _openSearch({required bool closeDrawer}) {
    setState(() {
      _showHostManager = false;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = false;
      _showUsage = false;
      _showSearch = true;
    });
    if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
  }

  void _closeSearch() => setState(() => _showSearch = false);

  void _openUsage({required bool closeDrawer}) {
    setState(() {
      _showHostManager = false;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = false;
      _showSearch = false;
      _showUsage = true;
    });
    if (closeDrawer) _scaffoldKey.currentState?.closeDrawer();
  }

  void _closeUsage() => setState(() => _showUsage = false);

  void _toggleContextPanel() =>
      setState(() => _showContextPanel = !_showContextPanel);

  void _toggleSearch() {
    if (_showSearch) {
      _closeSearch();
    } else {
      _openSearch(closeDrawer: false);
    }
  }

  void _toggleSettings() {
    if (_showSettings) {
      _closeSettings();
    } else {
      _openSettings(closeDrawer: false);
    }
  }

  void _toggleDeveloper() {
    if (_showDeveloper) {
      _closeDeveloper();
    } else {
      _openDeveloper();
    }
  }

  /// Escape: returns to the conversation when any takeover surface is open.
  void _dismissTakeovers() {
    if (!_showHostManager &&
        !_showAttention &&
        !_showDeveloper &&
        !_showSettings &&
        !_showSearch &&
        !_showUsage) {
      return;
    }
    setState(() {
      _showHostManager = false;
      _showAttention = false;
      _showDeveloper = false;
      _showSettings = false;
      _showSearch = false;
      _showUsage = false;
    });
  }

  /// Selects the Nth session of the list the rail renders by default
  /// (non-archived, unfiltered), using the same select action as the rail.
  void _selectSessionAt(int index) {
    final visible = widget.state.sessions
        .where((session) => !session.archived)
        .toList(growable: false);
    if (index < 0 || index >= visible.length) return;
    unawaited(_selectSession(visible[index].sessionId, closeDrawer: false));
  }

  /// Same create flow (gate + dialog) as the session rail's new-session
  /// button, reachable from the keyboard.
  Future<void> _createSessionFromShortcut() async {
    final canCreate =
        widget.state.connectionPhase == ConnectionPhase.ready &&
        widget.state.grantedCapabilities.contains('sessions.manage') &&
        !widget.state.sessionOperationPending &&
        widget.state.sessions.isNotEmpty;
    if (!canCreate) return;
    final projects = <String, String>{};
    for (final session in widget.state.sessions) {
      projects.putIfAbsent(session.projectId, () => session.projectName);
    }
    if (projects.isEmpty) return;
    await showDialog<bool>(
      context: context,
      builder: (context) =>
          _CreateSessionDialog(actions: widget.actions, projects: projects),
    );
  }

  Map<ShortcutActivator, VoidCallback> _shortcutBindings() {
    final useMeta =
        defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.iOS;
    SingleActivator mod(LogicalKeyboardKey key, {bool shift = false}) =>
        SingleActivator(key, meta: useMeta, control: !useMeta, shift: shift);

    const digits = <LogicalKeyboardKey>[
      LogicalKeyboardKey.digit1,
      LogicalKeyboardKey.digit2,
      LogicalKeyboardKey.digit3,
      LogicalKeyboardKey.digit4,
      LogicalKeyboardKey.digit5,
      LogicalKeyboardKey.digit6,
      LogicalKeyboardKey.digit7,
      LogicalKeyboardKey.digit8,
      LogicalKeyboardKey.digit9,
    ];

    return <ShortcutActivator, VoidCallback>{
      mod(LogicalKeyboardKey.keyK): () => unawaited(_openQuickOpen()),
      mod(LogicalKeyboardKey.keyN): () =>
          unawaited(_createSessionFromShortcut()),
      mod(LogicalKeyboardKey.keyF, shift: true): _toggleSearch,
      mod(LogicalKeyboardKey.comma): _toggleSettings,
      mod(LogicalKeyboardKey.keyJ): _toggleDeveloper,
      mod(LogicalKeyboardKey.keyI): _toggleContextPanel,
      mod(LogicalKeyboardKey.keyP, shift: true): () =>
          unawaited(_openCommandPalette()),
      for (var i = 0; i < digits.length; i++)
        mod(digits[i]): () => _selectSessionAt(i),
      const SingleActivator(LogicalKeyboardKey.escape): _dismissTakeovers,
    };
  }

  /// mod+shift+P: command palette over the shell's global actions. The
  /// shortcut labels mirror the platform modifier used by [_shortcutBindings].
  Future<void> _openCommandPalette() async {
    final useMeta =
        defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.iOS;
    final mod = useMeta ? '\u2318' : 'Ctrl+';
    await showCommandPalette(
      context,
      commands: [
        PaletteCommand(
          id: 'quick-open',
          title: 'Quick open project file',
          shortcutLabel: '${mod}K',
          enabled: _canQuickOpen,
          run: () => unawaited(_openQuickOpen()),
        ),
        PaletteCommand(
          id: 'new-session',
          title: 'New session',
          shortcutLabel: '${mod}N',
          enabled:
              widget.state.connectionPhase == ConnectionPhase.ready &&
              widget.state.grantedCapabilities.contains('sessions.manage'),
          run: () => unawaited(_createSessionFromShortcut()),
        ),
        PaletteCommand(
          id: 'search-transcripts',
          title: 'Search transcripts',
          shortcutLabel: '$mod\u21e7F',
          run: _toggleSearch,
        ),
        PaletteCommand(
          id: 'developer-tools',
          title: 'Toggle developer tools',
          shortcutLabel: '${mod}J',
          run: _toggleDeveloper,
        ),
        PaletteCommand(
          id: 'context-panel',
          title: 'Toggle context panel',
          shortcutLabel: '${mod}I',
          run: _toggleContextPanel,
        ),
        PaletteCommand(
          id: 'usage',
          title: 'Usage and accounts',
          run: () => _openUsage(closeDrawer: false),
        ),
        PaletteCommand(
          id: 'settings',
          title: 'Settings',
          shortcutLabel: '$mod,',
          run: _toggleSettings,
        ),
        PaletteCommand(
          id: 'manage-hosts',
          title: 'Manage hosts',
          run: () => _openHostManager(closeDrawer: false),
        ),
      ],
    );
  }

  Widget _contextRow(BuildContext context, String label, String value) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: _T4Space.xxs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 88,
            child: Text(
              label,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }

  /// Section list for the right context panel. Wave 4 extends this with
  /// richer sections; keep it as the single mount point.
  List<ContextPanelSection> _buildContextSections(BuildContext context) {
    final session = widget.state.selectedSession;
    final profile = widget.state.hostDirectory.activeProfile;
    final modelLabel = widget.state.composer.modelLabel;
    final capabilities = widget.state.grantedCapabilities;
    final ready =
        widget.state.connectionPhase == ConnectionPhase.ready &&
        session != null;
    return [
      ContextPanelSection(
        id: 'session',
        title: 'Session',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _contextRow(context, 'Title', _displaySessionTitle(session)),
            if (session != null)
              _contextRow(context, 'Project', session.projectName),
            if (session != null && session.status.trim().isNotEmpty)
              _contextRow(context, 'Status', session.status),
            _contextRow(
              context,
              'Connection',
              widget.state.connectionPhase.label,
            ),
            if (profile != null) _contextRow(context, 'Host', profile.label),
            if (modelLabel != null) _contextRow(context, 'Model', modelLabel),
          ],
        ),
      ),
      if (ready && capabilities.contains('files.diff'))
        ContextPanelSection(
          id: 'review',
          title: 'Review',
          child: SizedBox(
            height: 380,
            child: ReviewPanelBody(
              state: widget.state,
              actions: widget.actions,
            ),
          ),
        ),
      if (ready &&
          capabilities.contains('files.list') &&
          capabilities.contains('files.read'))
        ContextPanelSection(
          id: 'files',
          title: 'Files',
          initiallyExpanded: false,
          child: SizedBox(
            height: 380,
            child: FilesPanelBody(state: widget.state, actions: widget.actions),
          ),
        ),
      if (ready && capabilities.contains('audit.read'))
        ContextPanelSection(
          id: 'activity',
          title: 'Activity',
          initiallyExpanded: false,
          child: SizedBox(
            height: 320,
            child: ActivityPanelBody(
              state: widget.state,
              actions: widget.actions,
            ),
          ),
        ),
    ];
  }

  Widget _contextPanelToggle(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return IconButton(
      onPressed: _toggleContextPanel,
      tooltip: 'Toggle context panel',
      iconSize: _T4Size.indicator,
      padding: EdgeInsets.zero,
      visualDensity: VisualDensity.compact,
      constraints: const BoxConstraints.tightFor(width: 28, height: 28),
      color: scheme.onSurfaceVariant,
      icon: const Icon(Icons.view_sidebar_outlined),
    );
  }

  Widget _surfaceNavigationEntries({
    required bool closeDrawer,
    required bool rail,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: rail ? scheme.surfaceContainerLowest : scheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            _T4Space.xs,
            _T4Space.xxs,
            _T4Space.xs,
            _T4Space.sm,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(
                button: true,
                selected: _showSearch,
                label: 'Search transcripts',
                child: ListTile(
                  selected: _showSearch,
                  selectedTileColor: scheme.secondaryContainer,
                  leading: const Icon(Icons.manage_search),
                  title: const Text('Search'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openSearch(closeDrawer: closeDrawer),
                ),
              ),
              Semantics(
                button: true,
                selected: _showUsage,
                label: 'Open usage and accounts',
                child: ListTile(
                  selected: _showUsage,
                  selectedTileColor: scheme.secondaryContainer,
                  leading: const Icon(Icons.data_usage_outlined),
                  title: const Text('Usage'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openUsage(closeDrawer: closeDrawer),
                ),
              ),
              Semantics(
                button: true,
                selected: _showSettings,
                label: 'Open settings',
                child: ListTile(
                  selected: _showSettings,
                  selectedTileColor: scheme.secondaryContainer,
                  leading: const Icon(Icons.settings_outlined),
                  title: const Text('Settings'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _openSettings(closeDrawer: closeDrawer),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _primaryContent({required bool showHeader}) {
    if (_showSearch) {
      return _TranscriptSearchPane(
        actions: widget.actions,
        showHeader: showHeader,
        onDone: _closeSearch,
        onOpenSession: (sessionId) async {
          await _selectSession(sessionId, closeDrawer: false);
          if (mounted) _closeSearch();
        },
      );
    }
    if (_showUsage) {
      return _UsageStatusPane(
        state: widget.state,
        actions: widget.actions,
        showHeader: showHeader,
        onDone: _closeUsage,
      );
    }
    if (_showSettings) {
      return _SettingsPane(
        state: widget.state,
        actions: widget.actions,
        platformState: widget.platformState,
        platformActions: widget.platformActions,
        showHeader: showHeader,
        onDone: _closeSettings,
      );
    }
    if (_showAttention) {
      return _AttentionPane(
        state: widget.state,
        actions: widget.actions,
        onDone: _closeAttention,
        onOpenSession: (sessionId) async {
          await _selectSession(sessionId, closeDrawer: false);
          if (mounted) _closeAttention();
        },
      );
    }
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

    if (_showDeveloper) {
      return _DeveloperSurfacesPane(
        state: widget.state,
        actions: widget.actions,
        initialTab: _developerInitialTab,
        showHeader: showHeader,
        onDone: _closeDeveloper,
      );
    }

    return _ConversationPane(
      state: widget.state,
      actions: widget.actions,
      showHeader: showHeader,
      onConnect: _connect,
      onOpenSessions: showHeader ? null : _openNavigation,
      onOpenAttention: _openAttention,
      onOpenDeveloper: _openDeveloper,
      onOpenQuickOpen: _openQuickOpen,
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

    return CallbackShortcuts(
      bindings: _shortcutBindings(),
      child: Focus(
        autofocus: true,
        child: LayoutBuilder(
          builder: (context, constraints) {
            if (constraints.maxWidth >= _T4Breakpoints.wide) {
              return _buildWide(context);
            }
            return _buildCompact(context);
          },
        ),
      ),
    );
  }

  Widget _buildWide(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Row(
          children: [
            SizedBox(
              width: _T4Layout.sessionRailWidth,
              child: Column(
                children: [
                  Expanded(
                    child: _SessionNavigation(
                      state: widget.state,
                      actions: widget.actions,
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
                  _surfaceNavigationEntries(closeDrawer: false, rail: true),
                ],
              ),
            ),
            const VerticalDivider(width: _T4Size.divider),
            Expanded(
              child: Stack(
                children: [
                  Positioned.fill(child: _primaryContent(showHeader: true)),
                  Positioned(
                    top: _T4Space.sm,
                    right: _T4Space.sm,
                    child: _contextPanelToggle(context),
                  ),
                ],
              ),
            ),
            if (_showContextPanel)
              ContextPanel(
                sections: _buildContextSections(context),
                onClose: _toggleContextPanel,
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
        toolbarHeight: _T4Layout.compactToolbarHeight,
        leading: IconButton(
          onPressed: _openNavigation,
          tooltip: 'Open navigation',
          icon: const Icon(Icons.menu),
        ),
        titleSpacing: 0,
        title: _showSearch
            ? Text('Search', style: Theme.of(context).textTheme.titleMedium)
            : _showUsage
            ? Text('Usage', style: Theme.of(context).textTheme.titleMedium)
            : _showSettings
            ? Text('Settings', style: Theme.of(context).textTheme.titleMedium)
            : _showHostManager
            ? Text('Hosts', style: Theme.of(context).textTheme.titleMedium)
            : _showDeveloper
            ? Text(
                'Developer tools',
                style: Theme.of(context).textTheme.titleMedium,
              )
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
          if (_showSearch || _showUsage || _showSettings)
            IconButton(
              onPressed: _showSearch
                  ? _closeSearch
                  : _showUsage
                  ? _closeUsage
                  : _closeSettings,
              tooltip: _showSearch
                  ? 'Close search'
                  : _showUsage
                  ? 'Close usage'
                  : 'Close settings',
              icon: const Icon(Icons.close),
            )
          else ...[
            if (!_showHostManager &&
                !_showAttention &&
                !_showDeveloper &&
                !_showSearch &&
                !_showUsage) ...[
              if (_canQuickOpen)
                IconButton(
                  onPressed: () => unawaited(_openQuickOpen()),
                  tooltip: 'Quick open project file',
                  icon: const Icon(Icons.search),
                ),
              Badge(
                isLabelVisible: widget.state.urgentAttentionCount > 0,
                label: Text('${widget.state.urgentAttentionCount}'),
                child: IconButton(
                  onPressed: _openAttention,
                  tooltip: 'Open inbox',
                  icon: const Icon(Icons.inbox_outlined),
                ),
              ),
            ],
            if (!_showHostManager &&
                !_showAttention &&
                !_showSearch &&
                !_showUsage)
              IconButton(
                onPressed: _showDeveloper ? _closeDeveloper : _openDeveloper,
                tooltip: _showDeveloper
                    ? 'Close developer tools'
                    : 'Open developer tools',
                icon: Icon(_showDeveloper ? Icons.close : Icons.code),
              ),
            if (!_showHostManager && !_showSearch && !_showUsage)
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
            if (!_showHostManager && !_showSearch && !_showUsage)
              IconButton(
                onPressed: _toggleContextPanel,
                tooltip: 'Toggle context panel',
                icon: const Icon(Icons.view_sidebar_outlined),
              ),
          ],
        ],
      ),
      drawerEnableOpenDragGesture: true,
      drawerEdgeDragWidth: _T4Layout.minimumTouchTarget,
      drawer: Drawer(
        child: Column(
          children: [
            Expanded(
              child: _SessionNavigation(
                state: widget.state,
                actions: widget.actions,
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
            _surfaceNavigationEntries(closeDrawer: true, rail: false),
          ],
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
