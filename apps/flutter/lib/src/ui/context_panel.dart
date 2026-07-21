part of 't4_app.dart';

/// One collapsible section hosted by a [ContextPanel].
final class ContextPanelSection {
  const ContextPanelSection({
    required this.id,
    required this.title,
    required this.child,
    this.trailing,
    this.initiallyExpanded = true,
  });

  final String id;
  final String title;
  final Widget child;
  final Widget? trailing;
  final bool initiallyExpanded;
}

/// Right-docked contextual side panel with collapsible sections.
///
/// Renders a fixed-width column with a hairline left divider, one header row
/// per section (title, optional trailing widget, collapse chevron), and a
/// single shared scroll view. Hosts no [Scaffold] or [AppBar] — the shell
/// mounts it directly beside the primary surface.
final class ContextPanel extends StatelessWidget {
  const ContextPanel({
    required this.sections,
    this.onClose,
    this.width = 340,
    super.key,
  });

  final List<ContextPanelSection> sections;
  final VoidCallback? onClose;
  final double width;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: width,
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(
          left: BorderSide(
            color: scheme.outlineVariant,
            width: _T4Size.divider,
          ),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (onClose case final close?)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                _T4Space.md,
                _T4Space.xs,
                _T4Space.xs,
                0,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Context',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                  ),
                  IconButton(
                    onPressed: close,
                    tooltip: 'Close context panel',
                    iconSize: _T4Size.indicator,
                    visualDensity: VisualDensity.compact,
                    color: scheme.onSurfaceVariant,
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
          Expanded(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final section in sections)
                    _ContextPanelSectionView(
                      key: ValueKey<String>('context-section-${section.id}'),
                      section: section,
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

final class _ContextPanelSectionView extends StatefulWidget {
  const _ContextPanelSectionView({required this.section, super.key});

  final ContextPanelSection section;

  @override
  State<_ContextPanelSectionView> createState() =>
      _ContextPanelSectionViewState();
}

final class _ContextPanelSectionViewState
    extends State<_ContextPanelSectionView> {
  late bool _expanded = widget.section.initiallyExpanded;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final section = widget.section;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          button: true,
          expanded: _expanded,
          label: '${section.title} section',
          child: InkWell(
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                _T4Space.md,
                _T4Space.sm,
                _T4Space.sm,
                _T4Space.sm,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      section.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleSmall,
                    ),
                  ),
                  if (section.trailing case final trailing?) ...[
                    trailing,
                    const SizedBox(width: _T4Space.xs),
                  ],
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: _T4Size.indicator,
                    color: scheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
        if (_expanded)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              _T4Space.md,
              0,
              _T4Space.md,
              _T4Space.sm,
            ),
            child: section.child,
          ),
        Divider(
          height: _T4Size.divider,
          thickness: _T4Size.divider,
          color: scheme.outlineVariant,
        ),
      ],
    );
  }
}
