part of 't4_app.dart';

/// One selectable entry in an [AccessModeSelector] menu.
class AccessModeOption {
  const AccessModeOption({
    required this.id,
    required this.label,
    this.detail,
    this.selected = false,
  });

  /// Stable identifier passed to [AccessModeSelector.onSelected].
  final String id;

  /// Primary menu-row text.
  final String label;

  /// Optional dimmed second line describing the option.
  final String? detail;

  /// Whether this option renders with a leading check mark.
  final bool selected;
}

/// Quiet access-mode pill opening a themed [MenuAnchor] of options.
///
/// Matches the composer pill look: hairline stadium border, 12 px label,
/// chevron, and a 14 px shield leading icon. With an empty [options] list the
/// pill is informational: the menu shows a single disabled item repeating
/// [label] instead of selectable entries.
class AccessModeSelector extends StatelessWidget {
  const AccessModeSelector({
    required this.label,
    required this.options,
    required this.onSelected,
    this.enabled = true,
    this.readOnly = false,
    super.key,
  });

  /// Text shown inside the pill (current mode).
  final String label;

  /// Selectable modes; empty means display-only.
  final List<AccessModeOption> options;

  /// Called with the tapped option's [AccessModeOption.id].
  final ValueChanged<String> onSelected;

  /// Disables the pill entirely when false.
  final bool enabled;

  /// Renders options as a non-interactive granted-permissions status list:
  /// rows are disabled and the check mark means "granted", not "chosen".
  /// Use this until the wire protocol exposes a real access-mode command.
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Semantics(
      label: 'Access mode: $label',
      button: true,
      enabled: enabled,
      child: MenuAnchor(
        style: const MenuStyle(
          visualDensity: VisualDensity.compact,
          maximumSize: WidgetStatePropertyAll<Size?>(Size(320, 360)),
        ),
        alignmentOffset: const Offset(0, _T4Space.xs),
        menuChildren: options.isEmpty
            ? <Widget>[
                MenuItemButton(
                  style: _accessMenuItemStyle,
                  onPressed: null,
                  child: Text(label),
                ),
              ]
            : <Widget>[
                for (final option in options)
                  MenuItemButton(
                    key: ValueKey<String>('access-mode-${option.id}'),
                    style: _accessMenuItemStyle,
                    leadingIcon: option.selected
                        ? Icon(Icons.check, size: 16, color: scheme.primary)
                        : const SizedBox(width: 16),
                    onPressed: readOnly ? null : () => onSelected(option.id),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(option.label),
                        if (option.detail case final detail?)
                          Text(
                            detail,
                            style: TextStyle(
                              fontSize: 11,
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                      ],
                    ),
                  ),
              ],
        builder: (context, controller, child) => _AccessModePill(
          label: label,
          onTap: enabled
              ? () => controller.isOpen ? controller.close() : controller.open()
              : null,
        ),
      ),
    );
  }
}

final ButtonStyle _accessMenuItemStyle = MenuItemButton.styleFrom(
  visualDensity: VisualDensity.compact,
  textStyle: const TextStyle(fontSize: 12),
  minimumSize: const Size.fromHeight(36),
);

/// Hairline stadium pill anchor for [AccessModeSelector].
final class _AccessModePill extends StatelessWidget {
  const _AccessModePill({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final enabled = onTap != null;
    final color = enabled ? scheme.onSurfaceVariant : scheme.outline;
    final shape = StadiumBorder(side: BorderSide(color: scheme.outlineVariant));
    return Material(
      color: Colors.transparent,
      shape: shape,
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: _T4Space.xs,
            vertical: _T4Space.xxs + 1,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.shield_outlined, size: 14, color: color),
              const SizedBox(width: _T4Space.xxs),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 160),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: color),
                ),
              ),
              const SizedBox(width: 2),
              Icon(Icons.keyboard_arrow_down, size: 14, color: color),
            ],
          ),
        ),
      ),
    );
  }
}
