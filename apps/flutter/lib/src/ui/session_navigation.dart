part of 't4_proof_app.dart';

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

  String? get actionLabel => switch (this) {
    ConnectionPhase.disconnected => 'Connect',
    ConnectionPhase.failed => 'Retry',
    ConnectionPhase.connecting ||
    ConnectionPhase.synchronizing ||
    ConnectionPhase.ready ||
    ConnectionPhase.retrying => null,
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
    required this.onConnect,
    required this.onSelectSession,
    this.onClose,
  });

  final ProofViewState state;
  final _SessionNavigationMode mode;
  final bool connecting;
  final String? selectingSessionId;
  final Future<void> Function() onConnect;
  final Future<void> Function(String sessionId) onSelectSession;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return ColoredBox(
      color: mode == _SessionNavigationMode.rail
          ? scheme.surfaceContainerLowest
          : scheme.surface,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _ProofSpace.md,
                _ProofSpace.sm,
                _ProofSpace.xs,
                _ProofSpace.xs,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      mode == _SessionNavigationMode.rail ? 'T4' : 'Sessions',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  if (onClose case final close?)
                    IconButton(
                      onPressed: close,
                      tooltip: 'Close sessions',
                      icon: const Icon(Icons.close),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: _ProofSpace.md),
              child: _ConnectionStatus(
                phase: state.connectionPhase,
                actionPending: connecting,
                onAction: onConnect,
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _ProofSpace.md,
                _ProofSpace.lg,
                _ProofSpace.md,
                _ProofSpace.xs,
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
                          _ProofSpace.xs,
                          0,
                          _ProofSpace.xs,
                          _ProofSpace.md,
                        ),
                        itemCount: state.sessions.length,
                        itemBuilder: (context, index) {
                          final session = state.sessions[index];
                          return Padding(
                            padding: const EdgeInsets.only(
                              bottom: _ProofSpace.xxs,
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
    required this.onAction,
  });

  final ConnectionPhase phase;
  final bool actionPending;
  final Future<void> Function() onAction;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final actionLabel = phase.actionLabel;
    final active = phase.isActive || actionPending;

    return Semantics(
      container: true,
      label: 'Connection status: ${phase.label}',
      child: Row(
        children: [
          SizedBox.square(
            dimension: _ProofSize.indicator,
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
          Expanded(
            child: Text(
              phase.label,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
          if (actionLabel != null)
            TextButton(
              onPressed: actionPending ? null : () => unawaited(onAction()),
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
        padding: const EdgeInsets.all(_ProofSpace.lg),
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
                dimension: _ProofSize.indicator,
                child: CircularProgressIndicator(
                  strokeWidth: _ProofSize.thinStroke,
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
