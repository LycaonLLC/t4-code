part of 't4_app.dart';

final class _AttentionPane extends StatefulWidget {
  const _AttentionPane({
    required this.state,
    required this.actions,
    required this.onDone,
    required this.onOpenSession,
  });

  final T4ViewState state;
  final T4Actions actions;
  final VoidCallback onDone;
  final Future<void> Function(String sessionId) onOpenSession;

  @override
  State<_AttentionPane> createState() => _AttentionPaneState();
}

final class _AttentionPaneState extends State<_AttentionPane>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs;
  final Set<String> _responding = <String>{};

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 3, vsync: this);
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _respond(AttentionItem item, AttentionResponse response) async {
    if (!_responding.add(item.key)) return;
    setState(() {});
    try {
      final accepted = await widget.actions.respondToAttention(item, response);
      if (!mounted) return;
      if (!accepted) _showError('The host did not accept that response.');
    } on Object catch (error) {
      if (mounted) _showError(error.toString().replaceFirst('Bad state: ', ''));
    } finally {
      if (mounted) setState(() => _responding.remove(item.key));
    }
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<String?> _askForText({
    required String title,
    String hint = 'Add a note',
  }) async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: controller,
          autofocus: true,
          minLines: 2,
          maxLines: 6,
          decoration: InputDecoration(hintText: hint),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Send'),
          ),
        ],
      ),
    );
    controller.dispose();
    return result;
  }

  @override
  Widget build(BuildContext context) {
    final needsYou = widget.state.attentionItems
        .where((item) => item.needsResponse)
        .toList(growable: false);
    final updates = widget.state.attentionItems
        .where((item) => !item.needsResponse)
        .toList(growable: false);
    return Column(
      children: [
        _AttentionHeader(
          urgentCount: widget.state.urgentAttentionCount,
          onDone: widget.onDone,
        ),
        if (widget.state.attentionPartial)
          MaterialBanner(
            content: Text(
              widget.state.omittedAttentionCount > 0
                  ? '${widget.state.omittedAttentionCount} more requests are available on the host.'
                  : 'Some attention data could not be read. Refresh the host before acting.',
            ),
            actions: [
              TextButton(onPressed: widget.onDone, child: const Text('Close')),
            ],
          ),
        TabBar(
          controller: _tabs,
          tabs: [
            Tab(
              text: needsYou.isEmpty
                  ? 'Needs you'
                  : 'Needs you (${needsYou.length})',
            ),
            Tab(
              text: updates.isEmpty ? 'Updates' : 'Updates (${updates.length})',
            ),
            Tab(
              text: widget.state.agentActivities.isEmpty
                  ? 'Agents'
                  : 'Agents (${widget.state.agentActivities.length})',
            ),
          ],
        ),
        Expanded(
          child: TabBarView(
            controller: _tabs,
            children: [
              _attentionList(
                needsYou,
                emptyLabel: 'Nothing needs your response.',
              ),
              _attentionList(updates, emptyLabel: 'No recent session updates.'),
              _AgentActivityList(activities: widget.state.agentActivities),
            ],
          ),
        ),
      ],
    );
  }

  Widget _attentionList(
    List<AttentionItem> items, {
    required String emptyLabel,
  }) {
    if (items.isEmpty) return _AttentionEmpty(label: emptyLabel);
    return ListView.separated(
      padding: const EdgeInsets.all(_T4Space.lg),
      itemCount: items.length,
      separatorBuilder: (_, _) => const SizedBox(height: _T4Space.md),
      itemBuilder: (context, index) {
        final item = items[index];
        return _AttentionCard(
          item: item,
          busy: _responding.contains(item.key),
          canRespond:
              widget.state.connectionPhase == ConnectionPhase.ready &&
              item.actionable,
          onRespond: (response) => _respond(item, response),
          onRevise: () async {
            final note = await _askForText(
              title: 'Request plan changes',
              hint: 'What should change?',
            );
            if (note != null) {
              await _respond(
                item,
                AttentionResponse(
                  decision: AttentionDecision.revise,
                  text: note,
                ),
              );
            }
          },
          onCustomAnswer: () async {
            final answer = await _askForText(
              title: item.title,
              hint: 'Type your answer',
            );
            if (answer != null && answer.isNotEmpty) {
              await _respond(
                item,
                AttentionResponse(
                  decision: AttentionDecision.approve,
                  text: answer,
                ),
              );
            }
          },
          onOpenSession: () => widget.onOpenSession(item.sessionId),
          onRetry: item.isProblem
              ? () async {
                  try {
                    await widget.actions.retrySession(item.sessionId);
                  } on Object catch (error) {
                    if (mounted) _showError(error.toString());
                  }
                }
              : null,
        );
      },
    );
  }
}

final class _AttentionHeader extends StatelessWidget {
  const _AttentionHeader({required this.urgentCount, required this.onDone});

  final int urgentCount;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(
      _T4Space.lg,
      _T4Space.md,
      _T4Space.sm,
      _T4Space.sm,
    ),
    child: Row(
      children: [
        Expanded(
          child: Text(
            urgentCount == 0 ? 'Inbox' : 'Inbox · $urgentCount waiting',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
        ),
        IconButton(
          onPressed: onDone,
          tooltip: 'Close inbox',
          icon: const Icon(Icons.close),
        ),
      ],
    ),
  );
}

final class _AttentionCard extends StatelessWidget {
  const _AttentionCard({
    required this.item,
    required this.busy,
    required this.canRespond,
    required this.onRespond,
    required this.onRevise,
    required this.onCustomAnswer,
    required this.onOpenSession,
    this.onRetry,
  });

  final AttentionItem item;
  final bool busy;
  final bool canRespond;
  final ValueChanged<AttentionResponse> onRespond;
  final VoidCallback onRevise;
  final VoidCallback onCustomAnswer;
  final VoidCallback onOpenSession;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(_T4Space.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(_icon, size: 20, color: _color(scheme)),
                const SizedBox(width: _T4Space.sm),
                Expanded(
                  child: Text(
                    item.title,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                if (busy)
                  const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
              ],
            ),
            const SizedBox(height: _T4Space.sm),
            Text(item.summary),
            const SizedBox(height: _T4Space.sm),
            TextButton.icon(
              onPressed: busy ? null : onOpenSession,
              icon: const Icon(Icons.forum_outlined),
              label: Text(item.sessionTitle),
            ),
            if (item.needsResponse) ...[
              const SizedBox(height: _T4Space.sm),
              if (item.kind == AttentionKind.question)
                _questionActions()
              else
                _decisionActions(),
              if (!canRespond)
                Padding(
                  padding: const EdgeInsets.only(top: _T4Space.sm),
                  child: Text(
                    'Connect with write access to respond.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ] else if (onRetry != null) ...[
              const SizedBox(height: _T4Space.sm),
              OutlinedButton.icon(
                onPressed: busy ? null : onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry session'),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _questionActions() => Wrap(
    spacing: _T4Space.sm,
    runSpacing: _T4Space.sm,
    children: [
      for (final choice in item.choices)
        OutlinedButton(
          onPressed: !canRespond || busy
              ? null
              : () => onRespond(
                  AttentionResponse(
                    decision: AttentionDecision.approve,
                    optionIds: <String>[choice.id],
                  ),
                ),
          child: Text(choice.label),
        ),
      if (item.allowText)
        FilledButton.tonal(
          onPressed: !canRespond || busy ? null : onCustomAnswer,
          child: const Text('Type an answer'),
        ),
    ],
  );

  Widget _decisionActions() => Row(
    mainAxisAlignment: MainAxisAlignment.end,
    children: [
      if (item.kind == AttentionKind.plan) ...[
        TextButton(
          onPressed: !canRespond || busy ? null : onRevise,
          child: const Text('Revise'),
        ),
        const SizedBox(width: _T4Space.sm),
      ],
      OutlinedButton(
        onPressed: !canRespond || busy
            ? null
            : () => onRespond(
                AttentionResponse(
                  decision: item.kind == AttentionKind.plan
                      ? AttentionDecision.reject
                      : AttentionDecision.deny,
                ),
              ),
        child: Text(item.kind == AttentionKind.plan ? 'Reject' : 'Deny'),
      ),
      const SizedBox(width: _T4Space.sm),
      FilledButton(
        onPressed: !canRespond || busy
            ? null
            : () => onRespond(
                const AttentionResponse(decision: AttentionDecision.approve),
              ),
        child: const Text('Approve'),
      ),
    ],
  );

  IconData get _icon => switch (item.kind) {
    AttentionKind.approval => Icons.shield_outlined,
    AttentionKind.question => Icons.help_outline,
    AttentionKind.plan => Icons.account_tree_outlined,
    AttentionKind.confirmation => Icons.verified_user_outlined,
    AttentionKind.completed => Icons.check_circle_outline,
    AttentionKind.failed => Icons.error_outline,
    AttentionKind.cancelled => Icons.cancel_outlined,
  };

  Color _color(ColorScheme scheme) => switch (item.kind) {
    AttentionKind.failed => scheme.error,
    AttentionKind.cancelled => scheme.onSurfaceVariant,
    AttentionKind.completed => scheme.primary,
    _ => scheme.tertiary,
  };
}

final class _AgentActivityList extends StatelessWidget {
  const _AgentActivityList({required this.activities});

  final List<AgentActivity> activities;

  @override
  Widget build(BuildContext context) {
    if (activities.isEmpty) {
      return const _AttentionEmpty(label: 'No background agent activity.');
    }
    return ListView.separated(
      padding: const EdgeInsets.all(_T4Space.lg),
      itemCount: activities.length,
      separatorBuilder: (_, _) => const Divider(height: _T4Space.lg),
      itemBuilder: (context, index) {
        final activity = activities[index];
        return ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.hub_outlined),
          title: Text(activity.label),
          subtitle: Text(activity.status),
          trailing: activity.progress == null
              ? null
              : SizedBox(
                  width: 72,
                  child: LinearProgressIndicator(value: activity.progress),
                ),
        );
      },
    );
  }
}

final class _AttentionEmpty extends StatelessWidget {
  const _AttentionEmpty({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(_T4Space.xl),
      child: Text(
        label,
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.bodyLarge?.copyWith(
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
    ),
  );
}
