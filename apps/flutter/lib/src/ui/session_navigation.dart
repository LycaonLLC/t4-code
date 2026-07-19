part of 't4_app.dart';

enum _SessionNavigationMode { rail, drawer }

extension on ConnectionPhase {
  String get label => switch (this) {
    ConnectionPhase.disconnected => 'Disconnected',
    ConnectionPhase.connecting => 'Connecting',
    ConnectionPhase.synchronizing => 'Synchronizing',
    ConnectionPhase.ready => 'Ready',
    ConnectionPhase.retrying => 'Retrying',
    ConnectionPhase.failed => 'Connection failed',
  };

  bool get isActive => switch (this) {
    ConnectionPhase.connecting ||
    ConnectionPhase.synchronizing ||
    ConnectionPhase.retrying => true,
    ConnectionPhase.disconnected ||
    ConnectionPhase.ready ||
    ConnectionPhase.failed => false,
  };

  bool get canDisconnect => switch (this) {
    ConnectionPhase.disconnected || ConnectionPhase.failed => false,
    ConnectionPhase.connecting ||
    ConnectionPhase.synchronizing ||
    ConnectionPhase.ready ||
    ConnectionPhase.retrying => true,
  };

  String get actionLabel => canDisconnect
      ? 'Disconnect'
      : switch (this) {
          ConnectionPhase.disconnected => 'Connect',
          ConnectionPhase.failed => 'Retry',
          ConnectionPhase.connecting ||
          ConnectionPhase.synchronizing ||
          ConnectionPhase.ready ||
          ConnectionPhase.retrying => throw StateError(
            'disconnectable phase has no connection action',
          ),
        };
}

String _displaySessionTitle(SessionSummary? session) {
  final title = session?.title.trim();
  return title == null || title.isEmpty ? 'No session selected' : title;
}

final class _SessionNavigation extends StatelessWidget {
  const _SessionNavigation({
    required this.state,
    required this.mode,
    required this.connecting,
    required this.selectingSessionId,
    required this.disconnecting,
    required this.showingHostManager,
    required this.onConnect,
    required this.onDisconnect,
    required this.onManageHosts,
    required this.onSelectSession,
    this.onClose,
  });

  final T4ViewState state;
  final _SessionNavigationMode mode;
  final bool disconnecting;
  final bool connecting;
  final String? selectingSessionId;
  final bool showingHostManager;
  final Future<void> Function() onDisconnect;
  final Future<void> Function() onConnect;
  final VoidCallback onManageHosts;
  final Future<void> Function(String sessionId) onSelectSession;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final activeProfile = state.hostDirectory.activeProfile;

    return Material(
      color: mode == _SessionNavigationMode.rail
          ? scheme.surfaceContainerLowest
          : scheme.surface,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _T4Space.md,
                _T4Space.sm,
                _T4Space.xs,
                _T4Space.xs,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      mode == _SessionNavigationMode.rail ? 'T4' : 'Navigation',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  if (onClose case final close?)
                    IconButton(
                      onPressed: close,
                      tooltip: 'Close navigation',
                      icon: const Icon(Icons.close),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: _T4Space.md),
              child: _ConnectionStatus(
                phase: state.connectionPhase,
                actionPending: connecting || disconnecting,
                onConnect: onConnect,
                onDisconnect: onDisconnect,
              ),
            ),
            if (activeProfile != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  _T4Space.md,
                  _T4Space.xs,
                  _T4Space.md,
                  _T4Space.sm,
                ),
                child: Text(
                  activeProfile.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _T4Space.xs,
                _T4Space.sm,
                _T4Space.xs,
                0,
              ),
              child: Semantics(
                button: true,
                selected: showingHostManager,
                label: 'Manage hosts',
                child: ListTile(
                  selected: showingHostManager,
                  selectedTileColor: scheme.secondaryContainer,
                  leading: const Icon(Icons.dns_outlined),
                  title: const Text('Manage hosts'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: onManageHosts,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _T4Space.md,
                _T4Space.lg,
                _T4Space.md,
                _T4Space.xs,
              ),
              child: Text(
                'SESSIONS',
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ),
            Expanded(
              child: Semantics(
                label: 'Sessions',
                explicitChildNodes: true,
                child: state.sessions.isEmpty
                    ? _EmptySessions(phase: state.connectionPhase)
                    : ListView.builder(
                        padding: const EdgeInsets.fromLTRB(
                          _T4Space.xs,
                          0,
                          _T4Space.xs,
                          _T4Space.md,
                        ),
                        itemCount: state.sessions.length,
                        itemBuilder: (context, index) {
                          final session = state.sessions[index];
                          return Padding(
                            padding: const EdgeInsets.only(
                              bottom: _T4Space.xxs,
                            ),
                            child: _SessionTile(
                              session: session,
                              selected:
                                  session.sessionId == state.selectedSessionId,
                              pending: session.sessionId == selectingSessionId,
                              onTap: () => onSelectSession(session.sessionId),
                            ),
                          );
                        },
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

final class _ConnectionStatus extends StatelessWidget {
  const _ConnectionStatus({
    required this.phase,
    required this.actionPending,
    required this.onConnect,
    required this.onDisconnect,
  });

  final ConnectionPhase phase;
  final bool actionPending;
  final Future<void> Function() onConnect;
  final Future<void> Function() onDisconnect;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final actionLabel = phase.actionLabel;
    final action = phase.canDisconnect ? onDisconnect : onConnect;
    final active = phase.isActive || actionPending;

    return Semantics(
      container: true,
      label: 'Connection status: ${phase.label}',
      child: Row(
        children: [
          SizedBox.square(
            dimension: _T4Size.indicator,
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
          Expanded(
            child: Text(
              phase.label,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
          TextButton(
            onPressed: actionPending ? null : () => unawaited(action()),
            child: Text(actionPending ? 'Working…' : actionLabel),
          ),
        ],
      ),
    );
  }
}

final class _EmptySessions extends StatelessWidget {
  const _EmptySessions({required this.phase});

  final ConnectionPhase phase;

  @override
  Widget build(BuildContext context) {
    final ready = phase == ConnectionPhase.ready;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(_T4Space.lg),
        child: Text(
          ready
              ? 'No sessions are available.'
              : 'Connect to load your sessions.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

final class _SessionTile extends StatelessWidget {
  const _SessionTile({
    required this.session,
    required this.selected,
    required this.pending,
    required this.onTap,
  });

  final SessionSummary session;
  final bool selected;
  final bool pending;
  final Future<void> Function() onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final title = session.title.trim().isEmpty
        ? 'Untitled session'
        : session.title;

    return Semantics(
      button: true,
      selected: selected,
      label: '$title, ${session.status}',
      child: ListTile(
        selected: selected,
        selectedTileColor: scheme.secondaryContainer,
        title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: session.status.trim().isEmpty
            ? null
            : Text(
                session.status,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
        trailing: pending
            ? const SizedBox.square(
                dimension: _T4Size.indicator,
                child: CircularProgressIndicator(
                  strokeWidth: _T4Size.thinStroke,
                  semanticsLabel: 'Selecting session',
                ),
              )
            : selected
            ? const Icon(Icons.check, semanticLabel: 'Selected')
            : null,
        onTap: pending ? null : () => unawaited(onTap()),
      ),
    );
  }
}
