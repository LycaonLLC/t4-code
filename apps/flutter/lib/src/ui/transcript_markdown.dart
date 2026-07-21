// Markdown rendering for transcript content.
//
// Standalone library (not a `part of` t4_app.dart) so it can be consumed by
// later waves without pulling in the shell. Styling is derived entirely from
// `Theme.of(context)`; no private theme tokens are referenced.

// The `markdown` package is a direct dependency of flutter_markdown_plus and
// is required here only for the `MarkdownElementBuilder` override signatures.
// ignore_for_file: depend_on_referenced_packages

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:re_highlight/languages/bash.dart';
import 'package:re_highlight/languages/c.dart';
import 'package:re_highlight/languages/cpp.dart';
import 'package:re_highlight/languages/css.dart';
import 'package:re_highlight/languages/dart.dart';
import 'package:re_highlight/languages/go.dart';
import 'package:re_highlight/languages/java.dart';
import 'package:re_highlight/languages/javascript.dart';
import 'package:re_highlight/languages/json.dart';
import 'package:re_highlight/languages/kotlin.dart';
import 'package:re_highlight/languages/markdown.dart';
import 'package:re_highlight/languages/python.dart';
import 'package:re_highlight/languages/rust.dart';
import 'package:re_highlight/languages/sql.dart';
import 'package:re_highlight/languages/swift.dart';
import 'package:re_highlight/languages/typescript.dart';
import 'package:re_highlight/languages/xml.dart';
import 'package:re_highlight/languages/yaml.dart';
import 'package:re_highlight/re_highlight.dart';
import 'package:re_highlight/styles/atom-one-dark.dart';
import 'package:re_highlight/styles/atom-one-light.dart';

const String _monoFamily = 'JetBrains Mono';

/// Renders markdown transcript content with T4 typography.
///
/// Fenced code blocks render through [CodeBlock]. Body text uses plain
/// `Text.rich` spans, so the widget is selectable when embedded in an
/// ambient [SelectionArea]; set [selectable] to false to opt a subtree out.
class TranscriptMarkdown extends StatelessWidget {
  const TranscriptMarkdown({
    required this.data,
    this.selectable = true,
    super.key,
  });

  /// Raw markdown source.
  final String data;

  /// Whether an ambient [SelectionArea] may select this content.
  final bool selectable;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final Widget body = MarkdownBody(
      data: data,
      // Plain RichText spans cooperate with an ambient SelectionArea;
      // SelectableText (selectable: true) would fight it.
      selectable: false,
      styleSheet: _styleSheetFor(theme),
      builders: <String, MarkdownElementBuilder>{'code': _FencedCodeBuilder()},
    );
    if (selectable) {
      return SelectionArea(child: body);
    }
    return SelectionContainer.disabled(child: body);
  }

  static MarkdownStyleSheet _styleSheetFor(ThemeData theme) {
    final ColorScheme scheme = theme.colorScheme;
    final TextTheme text = theme.textTheme;
    final TextStyle body = (text.bodyMedium ?? const TextStyle()).copyWith(
      fontSize: 13,
      height: 1.55,
    );
    TextStyle heading(TextStyle? base, double size) =>
        (base ?? body).copyWith(fontSize: size, height: 1.3);

    return MarkdownStyleSheet.fromTheme(theme).copyWith(
      p: body,
      pPadding: EdgeInsets.zero,
      blockSpacing: 10,
      listIndent: 20,
      listBullet: body.copyWith(color: scheme.onSurfaceVariant),
      h1: heading(text.titleLarge, 19),
      h2: heading(text.titleMedium, 16.5),
      h3: heading(text.titleSmall, 14.5),
      h4: heading(text.labelLarge, 13.5),
      h5: heading(text.labelLarge, 13),
      h6: heading(text.labelMedium, 12.5),
      // Inline code chip; fenced blocks are replaced by CodeBlock below.
      code: body.copyWith(
        fontFamily: _monoFamily,
        fontSize: 12.5,
        height: 1.4,
        backgroundColor: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
      ),
      blockquote: body.copyWith(color: scheme.onSurfaceVariant),
      blockquotePadding: const EdgeInsets.fromLTRB(12, 4, 8, 4),
      blockquoteDecoration: BoxDecoration(
        border: Border(
          left: BorderSide(
            color: scheme.primary.withValues(alpha: 0.45),
            width: 3,
          ),
        ),
      ),
      tableHead: body.copyWith(fontSize: 12.5, fontWeight: FontWeight.w600),
      tableBody: body.copyWith(fontSize: 12.5),
      tableBorder: TableBorder.all(color: scheme.outlineVariant, width: 1),
      tableCellsPadding: const EdgeInsets.symmetric(
        horizontal: 10,
        vertical: 6,
      ),
      tableHeadCellsDecoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
      ),
      // CodeBlock paints its own container; keep the default `pre` wrapper
      // from painting a second background behind it.
      codeblockDecoration: const BoxDecoration(),
      codeblockPadding: EdgeInsets.zero,
      horizontalRuleDecoration: BoxDecoration(
        border: Border(top: BorderSide(color: scheme.outlineVariant, width: 1)),
      ),
    );
  }
}

/// Routes fenced/indented code blocks to [CodeBlock].
///
/// Registered under the `code` tag: returning a widget replaces the default
/// `pre` scroll view, while returning null for inline `code` spans keeps the
/// stylesheet-driven inline rendering (and unbroken text flow).
class _FencedCodeBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final String classAttribute = element.attributes['class'] ?? '';
    final String? language = classAttribute.startsWith('language-')
        ? classAttribute.substring('language-'.length)
        : null;
    String code = element.textContent;
    final bool isBlock = language != null || code.contains('\n');
    if (!isBlock) {
      return null;
    }
    if (code.endsWith('\n')) {
      code = code.substring(0, code.length - 1);
    }
    return CodeBlock(code: code, language: language);
  }
}

/// A fenced code block with a language header, copy button, and
/// `re_highlight` syntax highlighting.
class CodeBlock extends StatefulWidget {
  const CodeBlock({required this.code, this.language, super.key});

  /// Code text without the trailing fence newline.
  final String code;

  /// Info-string language (e.g. `dart`), if one was provided.
  final String? language;

  @override
  State<CodeBlock> createState() => _CodeBlockState();
}

class _CodeBlockState extends State<CodeBlock> {
  static const Duration _copyFeedback = Duration(milliseconds: 1500);

  bool _copied = false;
  Timer? _copyTimer;

  @override
  void dispose() {
    _copyTimer?.cancel();
    super.dispose();
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) {
      return;
    }
    setState(() => _copied = true);
    _copyTimer?.cancel();
    _copyTimer = Timer(_copyFeedback, () {
      if (mounted) {
        setState(() => _copied = false);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    final ColorScheme scheme = theme.colorScheme;
    final Map<String, TextStyle> syntaxTheme =
        theme.brightness == Brightness.dark
        ? atomOneDarkTheme
        : atomOneLightTheme;
    final TextStyle baseStyle = TextStyle(
      fontFamily: _monoFamily,
      fontSize: 12.5,
      height: 1.55,
      color: syntaxTheme['root']?.color ?? scheme.onSurface,
    );
    final String label = switch (widget.language?.trim()) {
      final String language when language.isNotEmpty => language,
      _ => 'text',
    };

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: scheme.outlineVariant, width: 1),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _buildHeader(theme, label),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            child: Text.rich(
              _highlightedSpan(
                widget.code,
                widget.language,
                baseStyle,
                syntaxTheme,
              ),
              softWrap: false,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHeader(ThemeData theme, String label) {
    final ColorScheme scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsetsDirectional.only(start: 12, end: 4),
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: scheme.outlineVariant, width: 1),
        ),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: SelectionContainer.disabled(
              child: Text(
                label,
                style: (theme.textTheme.labelSmall ?? const TextStyle())
                    .copyWith(
                      fontFamily: _monoFamily,
                      color: scheme.onSurfaceVariant,
                    ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          IconButton(
            onPressed: _copy,
            tooltip: _copied ? 'Copied' : 'Copy',
            iconSize: 15,
            visualDensity: VisualDensity.compact,
            icon: Icon(
              _copied ? Icons.check_rounded : Icons.copy_rounded,
              color: _copied ? scheme.primary : scheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

/// Lazily constructed highlighter with the transcript's supported grammars.
final Highlight _highlighter = () {
  final Highlight highlight = Highlight();
  highlight.registerLanguages(<String, Mode>{
    'bash': langBash,
    'c': langC,
    'cpp': langCpp,
    'css': langCss,
    'dart': langDart,
    'go': langGo,
    'java': langJava,
    'javascript': langJavascript,
    'json': langJson,
    'kotlin': langKotlin,
    'markdown': langMarkdown,
    'python': langPython,
    'rust': langRust,
    'sql': langSql,
    'swift': langSwift,
    'typescript': langTypescript,
    'xml': langXml,
    'yaml': langYaml,
  });
  return highlight;
}();

const Map<String, String> _languageAliases = <String, String>{
  'c++': 'cpp',
  'cc': 'cpp',
  'cjs': 'javascript',
  'golang': 'go',
  'htm': 'xml',
  'html': 'xml',
  'hpp': 'cpp',
  'js': 'javascript',
  'jsx': 'javascript',
  'kt': 'kotlin',
  'md': 'markdown',
  'mjs': 'javascript',
  'py': 'python',
  'rs': 'rust',
  'sh': 'bash',
  'shell': 'bash',
  'ts': 'typescript',
  'tsx': 'typescript',
  'yml': 'yaml',
  'zsh': 'bash',
};

TextSpan _highlightedSpan(
  String code,
  String? language,
  TextStyle baseStyle,
  Map<String, TextStyle> syntaxTheme,
) {
  final String? normalized = _normalizeLanguage(language);
  if (normalized == null) {
    return TextSpan(text: code, style: baseStyle);
  }
  final HighlightResult result = _highlighter.highlight(
    code: code,
    language: normalized,
  );
  final TextSpanRenderer renderer = TextSpanRenderer(baseStyle, syntaxTheme);
  result.render(renderer);
  return renderer.span ?? TextSpan(text: code, style: baseStyle);
}

String? _normalizeLanguage(String? language) {
  final String? raw = language?.trim().toLowerCase();
  if (raw == null || raw.isEmpty) {
    return null;
  }
  final String canonical = _languageAliases[raw] ?? raw;
  return _highlighter.getLanguage(canonical) != null ? canonical : null;
}
