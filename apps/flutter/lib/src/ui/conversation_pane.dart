part of 't4_proof_app.dart';

final class _ConversationPane extends StatelessWidget {
  const _ConversationPane({
    required this.state,
    required this.actions,
    required this.showHeader,
    required this.onConnect,
    this.onOpenSessions,
  });

  final ProofViewState state;
  final ProofActions actions;
  final bool showHeader;
  final Future<void> Function() onConnect;
  final VoidCallback? onOpenSessions;

  @override
  Widget build(BuildContext context) {
    final error = state.errorMessage?.trim();
    final showError =
        (error != null && error.isNotEmpty) ||
        state.connectionPhase == ConnectionPhase.failed;

    return Column(
      children: [
        if (showHeader) _ConversationHeader(state: state),
        if (showError)
          _ConnectionErrorBanner(
            message: error == null || error.isEmpty
                ? 'The connection could not be established.'
                : error,
            canRetry: state.connectionPhase == ConnectionPhase.failed,
            onRetry: onConnect,
          ),
        Expanded(
          child: _TranscriptView(state: state, onOpenSessions: onOpenSessions),
        ),
        _PromptComposer(state: state, actions: actions),
      ],
    );
  }
}

final class _ConversationHeader extends StatelessWidget {
  const _ConversationHeader({required this.state});

  final ProofViewState state;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final session = state.selectedSession;
    final streaming = state.messages.any((message) => message.streaming);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: _ProofSpace.lg,
          vertical: _ProofSpace.md,
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _displaySessionTitle(session),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  if (session != null && session.status.trim().isNotEmpty) ...[
                    const SizedBox(height: _ProofSpace.xxs),
                    Text(
                      session.status,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            if (streaming) const _StreamingLabel(),
          ],
        ),
      ),
    );
  }
}

final class _StreamingLabel extends StatelessWidget {
  const _StreamingLabel();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: true,
      label: 'Assistant is streaming a response',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox.square(
            dimension: _ProofSize.indicator,
            child: CircularProgressIndicator(
              strokeWidth: _ProofSize.thinStroke,
              color: scheme.primary,
            ),
          ),
          const SizedBox(width: _ProofSpace.xs),
          Text(
            'Streaming',
            style: Theme.of(
              context,
            ).textTheme.labelMedium?.copyWith(color: scheme.primary),
          ),
        ],
      ),
    );
  }
}

final class _ConnectionErrorBanner extends StatelessWidget {
  const _ConnectionErrorBanner({
    required this.message,
    required this.canRetry,
    required this.onRetry,
  });

  final String message;
  final bool canRetry;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Connection error: $message',
      child: ColoredBox(
        color: scheme.errorContainer,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: _ProofSpace.md,
            vertical: _ProofSpace.xs,
          ),
          child: Row(
            children: [
              Icon(Icons.error_outline, color: scheme.onErrorContainer),
              const SizedBox(width: _ProofSpace.sm),
              Expanded(
                child: Text(
                  message,
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: scheme.onErrorContainer,
                  ),
                ),
              ),
              if (canRetry) ...[
                const SizedBox(width: _ProofSpace.xs),
                TextButton(
                  onPressed: () => unawaited(onRetry()),
                  style: TextButton.styleFrom(
                    foregroundColor: scheme.onErrorContainer,
                  ),
                  child: const Text('Retry'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

final class _TranscriptView extends StatefulWidget {
  const _TranscriptView({required this.state, this.onOpenSessions});

  final ProofViewState state;
  final VoidCallback? onOpenSessions;

  @override
  State<_TranscriptView> createState() => _TranscriptViewState();
}

final class _TranscriptViewState extends State<_TranscriptView> {
  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    _scheduleScrollToEnd(animate: false);
  }

  @override
  void didUpdateWidget(covariant _TranscriptView oldWidget) {
    super.didUpdateWidget(oldWidget);
    final sessionChanged =
        oldWidget.state.selectedSessionId != widget.state.selectedSessionId;
    final messagesChanged = _visibleMessagesChanged(
      oldWidget.state.messages,
      widget.state.messages,
    );
    if (!sessionChanged && !messagesChanged) return;

    final shouldFollow = sessionChanged || _isNearEnd;
    if (shouldFollow) _scheduleScrollToEnd(animate: !sessionChanged);
  }

  bool get _isNearEnd {
    if (!_scrollController.hasClients) return true;
    final position = _scrollController.position;
    return position.maxScrollExtent - position.pixels <=
        _ProofLayout.followScrollThreshold;
  }

  bool _visibleMessagesChanged(
    List<TranscriptMessage> previous,
    List<TranscriptMessage> current,
  ) {
    if (previous.length != current.length) return true;
    if (previous.isEmpty) return false;
    final oldLast = previous.last;
    final newLast = current.last;
    return oldLast.id != newLast.id ||
        oldLast.text != newLast.text ||
        oldLast.streaming != newLast.streaming;
  }

  void _scheduleScrollToEnd({required bool animate}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      final end = _scrollController.position.maxScrollExtent;
      if (animate) {
        unawaited(
          _scrollController.animateTo(
            end,
            duration: _ProofMotion.short,
            curve: _ProofMotion.standard,
          ),
        );
      } else {
        _scrollController.jumpTo(end);
      }
    });
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.state.selectedSession;
    if (session == null) {
      return _TranscriptEmptyState(
        title: 'Choose a session',
        message: widget.onOpenSessions == null
            ? 'Select a session from the session rail.'
            : 'Open sessions to choose a conversation.',
        actionLabel: widget.onOpenSessions == null ? null : 'Open sessions',
        onAction: widget.onOpenSessions,
      );
    }

    if (widget.state.messages.isEmpty) {
      final ready = widget.state.connectionPhase == ConnectionPhase.ready;
      return _TranscriptEmptyState(
        title: 'Start the conversation',
        message: ready
            ? 'Send a prompt when you’re ready.'
            : 'You can send a prompt once the connection is ready.',
      );
    }

    return Scrollbar(
      controller: _scrollController,
      child: ListView.separated(
        controller: _scrollController,
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        padding: const EdgeInsets.fromLTRB(
          _ProofSpace.md,
          _ProofSpace.lg,
          _ProofSpace.md,
          _ProofSpace.xl,
        ),
        itemCount: widget.state.messages.length,
        separatorBuilder: (context, index) =>
            const SizedBox(height: _ProofSpace.lg),
        itemBuilder: (context, index) =>
            _TranscriptMessageView(message: widget.state.messages[index]),
      ),
    );
  }
}

final class _TranscriptEmptyState extends StatelessWidget {
  const _TranscriptEmptyState({
    required this.title,
    required this.message,
    this.actionLabel,
    this.onAction,
  });

  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: _ProofLayout.contentMaxWidth,
        ),
        child: Padding(
          padding: const EdgeInsets.all(_ProofSpace.xl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.chat_bubble_outline,
                size: _ProofSize.emptyIcon,
                color: scheme.outline,
              ),
              const SizedBox(height: _ProofSpace.md),
              Text(
                title,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: _ProofSpace.xs),
              Text(
                message,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
              if (actionLabel case final label?) ...[
                const SizedBox(height: _ProofSpace.lg),
                TextButton(onPressed: onAction, child: Text(label)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

extension on MessageRole {
  String get label => switch (this) {
    MessageRole.user => 'You',
    MessageRole.assistant => 'Assistant',
    MessageRole.system => 'System',
    MessageRole.tool => 'Tool',
  };
}

final class _TranscriptMessageView extends StatelessWidget {
  const _TranscriptMessageView({required this.message});

  final TranscriptMessage message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final isUser = message.role == MessageRole.user;
    final isAuxiliary =
        message.role == MessageRole.system || message.role == MessageRole.tool;
    final background = isUser
        ? scheme.surfaceContainerHigh
        : isAuxiliary
        ? scheme.surfaceContainerLow
        : Colors.transparent;

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          maxWidth: _ProofLayout.contentMaxWidth,
        ),
        child: Semantics(
          container: true,
          label:
              '${message.role.label} message${message.streaming ? ', streaming' : ''}',
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: background,
              borderRadius: BorderRadius.circular(_ProofRadius.md),
              border: isAuxiliary
                  ? Border.all(color: scheme.outlineVariant)
                  : null,
            ),
            child: Padding(
              padding: isUser || isAuxiliary
                  ? const EdgeInsets.all(_ProofSpace.md)
                  : const EdgeInsets.symmetric(vertical: _ProofSpace.xs),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    message.role.label.toUpperCase(),
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                  if (message.text.isNotEmpty) ...[
                    const SizedBox(height: _ProofSpace.xs),
                    SelectionArea(
                      child: Text(
                        message.text,
                        style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                          height: _ProofType.bodyLineHeight,
                        ),
                      ),
                    ),
                  ],
                  if (message.streaming) ...[
                    const SizedBox(height: _ProofSpace.sm),
                    const _StreamingLabel(),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

final class _PromptComposer extends StatefulWidget {
  const _PromptComposer({required this.state, required this.actions});

  final ProofViewState state;
  final ProofActions actions;

  @override
  State<_PromptComposer> createState() => _PromptComposerState();
}

final class _PromptComposerState extends State<_PromptComposer> {
  final TextEditingController _textController = TextEditingController();
  final FocusNode _focusNode = FocusNode(debugLabel: 'Prompt composer');
  bool _hasText = false;
  bool _submitting = false;

  bool get _canSubmit =>
      widget.state.connectionPhase == ConnectionPhase.ready &&
      widget.state.selectedSession != null &&
      !widget.state.submitting &&
      !_submitting &&
      _hasText;

  @override
  void initState() {
    super.initState();
    _textController.addListener(_handleTextChanged);
  }

  void _handleTextChanged() {
    final hasText = _textController.text.trim().isNotEmpty;
    if (hasText == _hasText) return;
    setState(() => _hasText = hasText);
  }

  Future<void> _submit() async {
    if (!_canSubmit) return;
    final message = _textController.text.trim();
    setState(() => _submitting = true);
    try {
      await widget.actions.submitPrompt(message);
      if (!mounted) return;
      _textController.clear();
      _focusNode.requestFocus();
    } on Object {
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          const SnackBar(
            content: Text('Could not send the prompt. Try again.'),
          ),
        );
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  void dispose() {
    _textController
      ..removeListener(_handleTextChanged)
      ..dispose();
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final submitting = widget.state.submitting || _submitting;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: SafeArea(
        top: false,
        minimum: const EdgeInsets.fromLTRB(
          _ProofSpace.md,
          _ProofSpace.sm,
          _ProofSpace.md,
          _ProofSpace.sm,
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: _ProofLayout.contentMaxWidth,
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: CallbackShortcuts(
                    bindings: <ShortcutActivator, VoidCallback>{
                      const SingleActivator(LogicalKeyboardKey.enter): () =>
                          unawaited(_submit()),
                    },
                    child: Semantics(
                      textField: true,
                      label: 'Prompt message',
                      child: TextField(
                        controller: _textController,
                        focusNode: _focusNode,
                        readOnly: submitting,
                        minLines: 1,
                        maxLines: 6,
                        keyboardType: TextInputType.multiline,
                        textInputAction: TextInputAction.send,
                        onSubmitted: (_) => unawaited(_submit()),
                        decoration: InputDecoration(
                          hintText: widget.state.selectedSession == null
                              ? 'Choose a session to begin'
                              : 'Message T4',
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: _ProofSpace.xs),
                Semantics(
                  button: true,
                  label: submitting ? 'Sending prompt' : 'Send prompt',
                  child: FilledButton(
                    onPressed: _canSubmit ? () => unawaited(_submit()) : null,
                    child: submitting
                        ? const SizedBox.square(
                            dimension: _ProofSize.indicator,
                            child: CircularProgressIndicator(
                              strokeWidth: _ProofSize.thinStroke,
                              semanticsLabel: 'Sending',
                            ),
                          )
                        : const Text('Send'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
