part of 't4_app.dart';

/// One executable entry in the command palette.
class PaletteCommand {
  const PaletteCommand({
    required this.id,
    required this.title,
    this.shortcutLabel,
    this.enabled = true,
    required this.run,
  });

  /// Stable identifier (used for widget keys and de-duplication by callers).
  final String id;

  /// Human-readable command title; the fuzzy filter matches against this.
  final String title;

  /// Optional right-aligned shortcut hint (e.g. `⌘K`).
  final String? shortcutLabel;

  /// Disabled commands render dimmed and cannot be selected or run.
  final bool enabled;

  /// Invoked after the palette dialog has been popped.
  final VoidCallback run;
}

/// Shows the centered command palette dialog over [context].
///
/// Fully keyboard drivable: the filter field autofocuses, ArrowUp/Down move
/// the active row, Enter pops the dialog and runs the active command, Escape
/// closes. Clicking a row does the same as Enter for that row.
Future<void> showCommandPalette(
  BuildContext context, {
  required List<PaletteCommand> commands,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: true,
    builder: (context) => _CommandPaletteDialog(commands: commands),
  );
}

/// A [PaletteCommand] paired with the title indices its match highlighted.
final class _PaletteMatch {
  const _PaletteMatch({required this.command, required this.highlight});

  final PaletteCommand command;
  final Set<int> highlight;
}

/// Case-insensitive subsequence match of [query] inside [title].
///
/// Characters at word starts are preferred so multi-word queries behave like
/// word-prefix matching (`"op set"` matches **Op**en **Set**tings). Returns
/// the matched character indices for highlighting, or null when [query] is
/// not a subsequence of [title].
Set<int>? _fuzzyMatch(String query, String title) {
  final needle = query.toLowerCase();
  final haystack = title.toLowerCase();
  if (needle.isEmpty) return const <int>{};
  final matched = <int>{};
  var from = 0;
  for (var i = 0; i < needle.length; i++) {
    final ch = needle[i];
    if (ch == ' ') continue;
    var at = -1;
    // Prefer a word-start occurrence at/after the cursor, else any occurrence.
    for (var j = from; j < haystack.length; j++) {
      if (haystack[j] != ch) continue;
      final wordStart = j == 0 || haystack[j - 1] == ' ';
      if (wordStart) {
        at = j;
        break;
      }
      if (at < 0) at = j;
    }
    if (at < 0) return null;
    matched.add(at);
    from = at + 1;
  }
  return matched;
}

final class _CommandPaletteDialog extends StatefulWidget {
  const _CommandPaletteDialog({required this.commands});

  final List<PaletteCommand> commands;

  @override
  State<_CommandPaletteDialog> createState() => _CommandPaletteDialogState();
}

final class _CommandPaletteDialogState extends State<_CommandPaletteDialog> {
  final TextEditingController _queryController = TextEditingController();
  final FocusNode _fieldFocus = FocusNode(debugLabel: 'Command palette query');
  final ScrollController _scrollController = ScrollController();
  List<_PaletteMatch> _matches = const <_PaletteMatch>[];
  int _active = -1;

  @override
  void initState() {
    super.initState();
    _refilter('');
  }

  @override
  void dispose() {
    _queryController.dispose();
    _fieldFocus.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _refilter(String query) {
    final matches = <_PaletteMatch>[];
    for (final command in widget.commands) {
      final highlight = _fuzzyMatch(query.trim(), command.title);
      if (highlight == null) continue;
      matches.add(_PaletteMatch(command: command, highlight: highlight));
    }
    setState(() {
      _matches = matches;
      _active = matches.indexWhere((match) => match.command.enabled);
    });
  }

  /// Moves the active row by [delta], skipping disabled commands.
  void _moveActive(int delta) {
    if (_matches.isEmpty) return;
    var index = _active;
    for (var step = 0; step < _matches.length; step++) {
      index = (index + delta) % _matches.length;
      if (index < 0) index += _matches.length;
      if (_matches[index].command.enabled) {
        setState(() => _active = index);
        _revealActive();
        return;
      }
    }
  }

  void _revealActive() {
    if (_active < 0 || !_scrollController.hasClients) return;
    const rowExtent = 40.0;
    final viewport = _scrollController.position.viewportDimension;
    final top = _active * rowExtent;
    final offset = _scrollController.offset;
    if (top < offset) {
      _scrollController.jumpTo(top);
    } else if (top + rowExtent > offset + viewport) {
      _scrollController.jumpTo(top + rowExtent - viewport);
    }
  }

  void _runCommand(PaletteCommand command) {
    if (!command.enabled) return;
    Navigator.of(context).pop();
    command.run();
  }

  KeyEventResult _onKeyEvent(FocusNode node, KeyEvent event) {
    if (event is KeyUpEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;
    if (key == LogicalKeyboardKey.arrowDown) {
      _moveActive(1);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowUp) {
      _moveActive(-1);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      if (_active >= 0 && _active < _matches.length) {
        _runCommand(_matches[_active].command);
      }
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final topInset = MediaQuery.sizeOf(context).height * 0.15;
    return SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: Padding(
          padding: EdgeInsets.only(top: topInset),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560, maxHeight: 420),
            child: Material(
              color: scheme.surface,
              elevation: 8,
              borderRadius: BorderRadius.circular(_T4Radius.md),
              clipBehavior: Clip.antiAlias,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Focus(
                    onKeyEvent: _onKeyEvent,
                    child: TextField(
                      controller: _queryController,
                      focusNode: _fieldFocus,
                      autofocus: true,
                      onChanged: _refilter,
                      style: theme.textTheme.bodyMedium,
                      decoration: const InputDecoration(
                        hintText: 'Type a command…',
                        prefixIcon: Icon(Icons.search, size: 18),
                        border: InputBorder.none,
                        enabledBorder: InputBorder.none,
                        focusedBorder: InputBorder.none,
                        contentPadding: EdgeInsets.symmetric(
                          horizontal: _T4Space.sm,
                          vertical: _T4Space.sm,
                        ),
                      ),
                    ),
                  ),
                  Divider(height: 1, color: scheme.outlineVariant),
                  Flexible(
                    child: _matches.isEmpty
                        ? Padding(
                            padding: const EdgeInsets.all(_T4Space.md),
                            child: Text(
                              'No matching commands.',
                              textAlign: TextAlign.center,
                              style: theme.textTheme.bodySmall?.copyWith(
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                          )
                        : ListView.builder(
                            controller: _scrollController,
                            shrinkWrap: true,
                            padding: const EdgeInsets.symmetric(
                              vertical: _T4Space.xxs,
                            ),
                            itemExtent: 40,
                            itemCount: _matches.length,
                            itemBuilder: (context, index) => _PaletteRow(
                              match: _matches[index],
                              active: index == _active,
                              onTap: () => _runCommand(_matches[index].command),
                            ),
                          ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

final class _PaletteRow extends StatelessWidget {
  const _PaletteRow({
    required this.match,
    required this.active,
    required this.onTap,
  });

  final _PaletteMatch match;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final command = match.command;
    final enabled = command.enabled;
    final baseColor = enabled ? scheme.onSurface : scheme.outline;
    final title = Text.rich(
      TextSpan(
        children: [
          for (var i = 0; i < command.title.length; i++)
            TextSpan(
              text: command.title[i],
              style: match.highlight.contains(i)
                  ? TextStyle(
                      color: scheme.primary,
                      fontWeight: FontWeight.w600,
                    )
                  : null,
            ),
        ],
        style: TextStyle(fontSize: 13, color: baseColor),
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
    return InkWell(
      key: ValueKey<String>('palette-command-${command.id}'),
      onTap: enabled ? onTap : null,
      child: Container(
        color: active ? scheme.primary.withValues(alpha: 0.08) : null,
        padding: const EdgeInsets.symmetric(horizontal: _T4Space.sm),
        alignment: Alignment.centerLeft,
        child: Row(
          children: [
            Expanded(child: title),
            if (command.shortcutLabel case final shortcut?) ...[
              const SizedBox(width: _T4Space.xs),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: _T4Space.xxs + 1,
                  vertical: 1,
                ),
                decoration: BoxDecoration(
                  border: Border.all(color: scheme.outlineVariant),
                  borderRadius: BorderRadius.circular(_T4Radius.xs - 2),
                ),
                child: Text(
                  shortcut,
                  style: TextStyle(
                    fontFamily: _T4Typography.monoFamily,
                    fontSize: 11,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
