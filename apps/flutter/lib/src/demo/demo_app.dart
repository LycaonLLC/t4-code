import 'dart:typed_data';

import 'package:flutter/widgets.dart';

import '../client/app_state.dart';
import '../host/host_profile.dart';
import '../protocol/models.dart';
import '../ui/t4_app.dart';

/// Read-only public preview of the canonical Flutter client.
///
/// The demo deliberately uses local display data and never opens a network
/// connection or stores credentials.
final class T4DemoApp extends StatelessWidget {
  const T4DemoApp({super.key});

  static const T4Actions _actions = _DemoActions();

  @override
  Widget build(BuildContext context) => T4App(
    state: demoViewState,
    actions: _actions,
    credentialsAreVolatile: false,
    demoMode: true,
  );
}

final HostProfile _demoProfile = HostProfile.parseTailnetAddress(
  'https://demo.t4code.ts.net',
);

/// Fixed timestamp for all demo usage data: 2026-07-21T08:00:00Z.
const int _demoGeneratedAtMs = 1784620800000;

final T4ViewState demoViewState = T4ViewState(
  connectionPhase: ConnectionPhase.ready,
  hostDirectory: HostDirectory.empty().upsert(_demoProfile),
  authenticationPhase: AuthenticationPhase.paired,
  targetConfigured: true,
  grantedCapabilities: t4RequestedCapabilities.toSet(),
  grantedFeatures: t4RequestedFeatures.toSet(),
  selectedSessionId: 'sess-settings',
  sessions: const <SessionSummary>[
    SessionSummary(
      hostId: 'demo-host',
      sessionId: 'sess-settings',
      projectId: 'project-t4',
      projectName: 'T4 Code',
      title: 'Fix quick-open stale results',
      revision: 'demo-revision-3',
      status: 'idle',
      updatedAt: '2026-07-21T08:00:00Z',
      modelSelector: 'openai-codex/gpt-5.6-sol',
      modelDisplayName: 'GPT-5.6 Sol',
      thinking: 'high',
      thinkingSupported: true,
      thinkingLevels: <String>['off', 'medium', 'high'],
      fastAvailable: true,
    ),
    SessionSummary(
      hostId: 'demo-host',
      sessionId: 'sess-runtime',
      projectId: 'project-t4',
      projectName: 'T4 Code',
      title: 'Flutter runtime integration',
      revision: 'demo-revision-2',
      status: 'idle',
      updatedAt: '2026-07-21T07:40:00Z',
    ),
    SessionSummary(
      hostId: 'demo-host',
      sessionId: 'sess-release',
      projectId: 'project-t4',
      projectName: 'T4 Code',
      title: 'Release readiness',
      revision: 'demo-revision-1',
      status: 'idle',
      updatedAt: '2026-07-21T07:10:00Z',
    ),
    SessionSummary(
      hostId: 'demo-host',
      sessionId: 'sess-omp-advisor',
      projectId: 'project-omp',
      projectName: 'omp',
      title: 'Advisor routing selectors',
      revision: 'demo-revision-8',
      status: 'running widget tests',
      updatedAt: '2026-07-21T07:58:00Z',
      working: true,
      modelSelector: 'openai-codex/gpt-5.6-sol',
      modelDisplayName: 'GPT-5.6 Sol',
    ),
    SessionSummary(
      hostId: 'demo-host',
      sessionId: 'sess-omp-usage',
      projectId: 'project-omp',
      projectName: 'omp',
      title: 'Usage meter polish',
      revision: 'demo-revision-5',
      status: 'closed',
      updatedAt: '2026-07-18T16:45:00Z',
      archivedAt: '2026-07-18T16:45:00Z',
    ),
  ],
  messages: const <TranscriptMessage>[
    TranscriptMessage(
      id: 'demo-message-1',
      role: MessageRole.user,
      text:
          'Quick open keeps showing results from the previous session after I '
          'switch projects. Can you fix it?',
    ),
    TranscriptMessage(
      id: 'demo-message-2',
      role: MessageRole.assistant,
      reasoning:
          'Reproduced the report: open quick open in session A, switch to '
          'session B, reopen the palette — the first frame still lists paths '
          'from A. The result cache in quick_open.dart is keyed by query text '
          'only, so it survives session switches. Either the cache needs the '
          'session id in its key, or it should be dropped when the selected '
          'session changes. Scoping the key is smaller and keeps warm results '
          'per session.',
      text:
          'Reproduced it. The palette caches results in `_resultCache`, keyed '
          'by the query string alone, so switching sessions replays stale '
          'paths from the previous workspace. Let me confirm the shape of the '
          'cache before proposing a fix.',
    ),
    TranscriptMessage(
      id: 'demo-message-3',
      role: MessageRole.tool,
      kind: TranscriptKind.tool,
      text: '',
      toolName: 'files.read',
      toolTitle: 'Read lib/src/quick_open.dart',
      toolArguments: '{"path": "lib/src/quick_open.dart"}',
      toolOutput:
          'final Map<String, List<String>> _resultCache =\n'
          '    <String, List<String>>{};\n'
          '\n'
          'Future<List<String>> search(String query) async {\n'
          '  final cached = _resultCache[query];\n'
          '  if (cached != null) return cached;\n'
          '  ...\n'
          '}',
      toolSucceeded: true,
    ),
    TranscriptMessage(
      id: 'demo-message-4',
      role: MessageRole.assistant,
      text:
          'Confirmed — the cache never sees the session change. Two viable '
          'fixes:\n'
          '\n'
          '| Approach | Blast radius | Warm-cache behavior |\n'
          '| --- | --- | --- |\n'
          '| Scope keys by `(sessionId, query)` | One file | Keeps per-session warm results |\n'
          '| Clear cache on `selectSession` | Two files | Cold palette after every switch |\n'
          '\n'
          '> Scoping the key is the smaller change and preserves warm results '
          'when you switch back to a session.\n'
          '\n'
          'Checking for other readers of `_resultCache` before touching it.',
    ),
    TranscriptMessage(
      id: 'demo-message-5',
      role: MessageRole.tool,
      kind: TranscriptKind.tool,
      text: '',
      toolName: 'terminal.run',
      toolTitle: 'grep -rn _resultCache lib/',
      toolArguments: '{"command": "grep -rn _resultCache lib/"}',
      toolOutput:
          'lib/src/quick_open.dart:18:final Map<String, List<String>> _resultCache =\n'
          'lib/src/quick_open.dart:22:  final cached = _resultCache[query];\n'
          'lib/src/quick_open.dart:31:  _resultCache[query] = paths;',
      toolSucceeded: true,
    ),
    TranscriptMessage(
      id: 'demo-message-6',
      role: MessageRole.assistant,
      text:
          'Only quick_open.dart touches the cache, so the scoped key is safe. '
          'Proposed change:\n'
          '\n'
          '```dart\n'
          'final Map<(String, String), List<String>> _resultCache =\n'
          '    <(String, String), List<String>>{};\n'
          '\n'
          'Future<List<String>> search(String sessionId, String query) async {\n'
          '  final key = (sessionId, query);\n'
          '  final cached = _resultCache[key];\n'
          '  if (cached != null) return cached;\n'
          '  final paths = await _actions.searchProjectFiles(query);\n'
          '  _resultCache[key] = paths.paths;\n'
          '  return paths.paths;\n'
          '}\n'
          '```\n'
          '\n'
          'The palette already knows the selected session, so the callsite '
          'change is one line.',
    ),
    TranscriptMessage(
      id: 'demo-message-7',
      role: MessageRole.user,
      text:
          'Go with the session-scoped cache. Run the tests before you wrap up.',
    ),
    TranscriptMessage(
      id: 'demo-message-8',
      role: MessageRole.tool,
      kind: TranscriptKind.tool,
      text: '',
      toolName: 'terminal.run',
      toolTitle: 'flutter test test/quick_open_test.dart',
      toolArguments: '{"command": "flutter test test/quick_open_test.dart"}',
      toolOutput:
          '00:03 +11: quick open scopes cached results per session\n'
          '00:04 +12: All tests passed!',
      toolSucceeded: true,
    ),
    TranscriptMessage(
      id: 'demo-message-9',
      role: MessageRole.assistant,
      text:
          'Applied and verified. To reproduce the check locally:\n'
          '\n'
          '```bash\n'
          'cd apps/flutter\n'
          'flutter analyze\n'
          'flutter test test/quick_open_test.dart\n'
          '```\n'
          '\n'
          'Quick open now keys its cache by `(sessionId, query)`, so switching '
          'projects can no longer surface another workspace\u2019s paths.',
    ),
    TranscriptMessage(
      id: 'demo-message-10',
      role: MessageRole.system,
      kind: TranscriptKind.notice,
      text:
          'Turn complete \u00b7 2 files changed \u00b7 12 tests passed \u00b7 '
          'quick-open results are now scoped per session.',
    ),
  ],
  attentionItems: <AttentionItem>[
    AttentionItem(
      key: 'demo-attention-approval',
      kind: AttentionKind.approval,
      sessionId: 'sess-omp-advisor',
      sessionTitle: 'Advisor routing selectors',
      revision: 'demo-revision-8',
      title: 'Run pnpm test?',
      summary:
          'The agent wants to run `pnpm test` in packages/advisor before '
          'committing the selector change.',
      at: DateTime.utc(2026, 7, 21, 7, 58),
      choices: const <AttentionChoice>[
        AttentionChoice(id: 'allow', label: 'Allow'),
        AttentionChoice(id: 'deny', label: 'Deny'),
      ],
      actionable: true,
    ),
    AttentionItem(
      key: 'demo-attention-completed',
      kind: AttentionKind.completed,
      sessionId: 'sess-settings',
      sessionTitle: 'Fix quick-open stale results',
      revision: 'demo-revision-3',
      title: 'Quick-open fix landed',
      summary:
          'Session-scoped result cache applied; analyzer clean and 12 tests '
          'passing.',
      at: DateTime.utc(2026, 7, 21, 8),
    ),
  ],
  agentActivities: <AgentActivity>[
    AgentActivity(
      agentId: 'demo-agent-tests',
      sessionId: 'sess-omp-advisor',
      label: 'Widget test sweep',
      status: 'running',
      updatedAt: DateTime.utc(2026, 7, 21, 7, 59),
      progress: 0.62,
      description: 'Running the advisor selector widget tests before commit.',
      model: 'GPT-5.6 Sol',
      currentTool: 'terminal.run',
    ),
  ],
  fileWorkspace: FileWorkspaceState(
    path: 'lib/src/quick_open.dart',
    entries: const <DeveloperFileEntry>[
      DeveloperFileEntry(path: 'lib', kind: 'dir'),
      DeveloperFileEntry(path: 'test', kind: 'dir'),
      DeveloperFileEntry(path: 'README.md', kind: 'file', size: 412),
      DeveloperFileEntry(path: 'CHANGELOG.md', kind: 'file', size: 268),
      DeveloperFileEntry(path: 'pubspec.yaml', kind: 'file', size: 301),
      DeveloperFileEntry(path: 'analysis_options.yaml', kind: 'file', size: 88),
    ],
    content: _demoWorkspaceFiles['lib/src/quick_open.dart'],
    diff: _demoQuickOpenDiff,
    revision: 'demo-revision-3',
  ),
  reviews: const <ReviewWorkspaceItem>[
    ReviewWorkspaceItem(
      reviewId: 'demo-review-1',
      sessionId: 'sess-settings',
      status: 'completed',
      path: 'lib/src/quick_open.dart',
      findings: <Map<String, Object?>>[
        <String, Object?>{
          'path': 'lib/src/quick_open.dart',
          'severity': 'info',
          'message':
              'Result cache is now keyed by (sessionId, query); no cross-'
              'session reuse remains.',
        },
      ],
    ),
  ],
  composer: const SessionComposerState(
    modelLabel: 'GPT-5.6 Sol',
    modelSelector: 'openai-codex/gpt-5.6-sol',
    modelChoices: <ComposerModelChoice>[
      ComposerModelChoice(
        label: 'GPT-5.6 Sol',
        selector: 'openai-codex/gpt-5.6-sol',
        provider: 'openai-codex',
        providerLabel: 'OpenAI Codex',
      ),
    ],
    thinking: 'high',
    thinkingLevels: <String>['off', 'medium', 'high'],
    fastAvailable: true,
  ),
  themePreference: T4ThemePreference.system,
);

/// Small static workspace used by quick open, file search, and file reads.
const Map<String, String> _demoWorkspaceFiles = <String, String>{
  'README.md':
      '# demo workspace\n'
      '\n'
      'Sample project served by the T4 Code public preview. Everything here '
      'is static display data; no command leaves the browser.\n'
      '\n'
      '- `lib/main.dart` — app entrypoint\n'
      '- `lib/src/quick_open.dart` — palette + session-scoped result cache\n'
      '- `test/quick_open_test.dart` — regression coverage for the cache\n',
  'CHANGELOG.md':
      '## Unreleased\n'
      '\n'
      '- Quick open: scope cached results per session.\n'
      '- Usage pane: show provider limit windows with reset times.\n',
  'pubspec.yaml':
      'name: demo_workspace\n'
      'description: Sample workspace for the T4 Code public preview.\n'
      'environment:\n'
      "  sdk: '>=3.8.0 <4.0.0'\n"
      'dependencies:\n'
      '  flutter:\n'
      '    sdk: flutter\n',
  'analysis_options.yaml':
      'include: package:flutter_lints/flutter.yaml\n'
      'linter:\n'
      '  rules:\n'
      '    - prefer_const_constructors\n',
  'lib/main.dart':
      "import 'package:flutter/widgets.dart';\n"
      "import 'src/quick_open.dart';\n"
      '\n'
      'void main() => runApp(const DemoWorkspaceApp());\n',
  'lib/src/quick_open.dart':
      'final Map<(String, String), List<String>> _resultCache =\n'
      '    <(String, String), List<String>>{};\n'
      '\n'
      'Future<List<String>> search(String sessionId, String query) async {\n'
      '  final key = (sessionId, query);\n'
      '  return _resultCache[key] ??= await _lookup(query);\n'
      '}\n',
  'lib/src/session_scope.dart':
      '/// Identifies the session a palette query belongs to.\n'
      'final class SessionScope {\n'
      '  const SessionScope(this.sessionId);\n'
      '  final String sessionId;\n'
      '}\n',
  'test/quick_open_test.dart':
      "import 'package:flutter_test/flutter_test.dart';\n"
      '\n'
      'void main() {\n'
      "  test('quick open scopes cached results per session', () {\n"
      '    // Regression: switching sessions must not replay stale paths.\n'
      '  });\n'
      '}\n',
};

const String _demoQuickOpenDiff =
    '--- a/lib/src/quick_open.dart\n'
    '+++ b/lib/src/quick_open.dart\n'
    '@@ -15,10 +15,11 @@\n'
    '-final Map<String, List<String>> _resultCache =\n'
    '-    <String, List<String>>{};\n'
    '+final Map<(String, String), List<String>> _resultCache =\n'
    '+    <(String, String), List<String>>{};\n'
    ' \n'
    '-Future<List<String>> search(String query) async {\n'
    '-  final cached = _resultCache[query];\n'
    '+Future<List<String>> search(String sessionId, String query) async {\n'
    '+  final key = (sessionId, query);\n'
    '+  final cached = _resultCache[key];\n'
    '   if (cached != null) return cached;\n';

/// Safe action sink for the public preview. Interactive controls render as the
/// real client does, but no command leaves the browser.
final class _DemoActions implements T4Actions {
  const _DemoActions();

  @override
  Future<void> refreshSettings() async {}

  @override
  Future<void> setThemePreference(T4ThemePreference preference) async {}

  @override
  Future<void> selectSession(String sessionId) async {}

  @override
  Future<bool> submitPrompt(
    String message, {
    List<PromptImageAttachment> images = const <PromptImageAttachment>[],
  }) async => false;

  @override
  Future<bool> queuePrompt(String message) async => false;

  @override
  Future<bool> respondToAttention(
    AttentionItem item,
    AttentionResponse response,
  ) async => false;

  @override
  Future<Uint8List> readTranscriptImage(
    String entryId,
    TranscriptImageMetadata image,
  ) async => Uint8List(0);

  @override
  Future<UsageReadResult> readUsage() async => const UsageReadResult(
    generatedAt: _demoGeneratedAtMs,
    reports: <UsageReport>[
      UsageReport(
        provider: 'openai-codex',
        fetchedAt: _demoGeneratedAtMs,
        limits: <UsageLimit>[
          UsageLimit(
            id: 'session-5h',
            label: '5-hour window',
            scope: UsageScope(provider: 'openai-codex'),
            window: UsageWindow(
              id: 'session-5h',
              label: '5h',
              durationMs: 5 * 60 * 60 * 1000,
              resetsAt: _demoGeneratedAtMs + 2 * 60 * 60 * 1000,
            ),
            amount: UsageAmount(
              unit: UsageUnit.percent,
              used: 34,
              limit: 100,
              remaining: 66,
              usedFraction: 0.34,
              remainingFraction: 0.66,
            ),
            status: UsageStatus.ok,
            notes: <String>[],
          ),
          UsageLimit(
            id: 'weekly',
            label: 'Weekly window',
            scope: UsageScope(provider: 'openai-codex'),
            window: UsageWindow(
              id: 'weekly',
              label: '7d',
              durationMs: 7 * 24 * 60 * 60 * 1000,
              resetsAt: _demoGeneratedAtMs + 3 * 24 * 60 * 60 * 1000,
            ),
            amount: UsageAmount(
              unit: UsageUnit.percent,
              used: 61,
              limit: 100,
              remaining: 39,
              usedFraction: 0.61,
              remainingFraction: 0.39,
            ),
            status: UsageStatus.warning,
            notes: <String>[],
          ),
        ],
        notes: <String>[],
        metadata: <String, Object?>{},
      ),
    ],
    accountsWithoutUsage: <UsageAccountWithoutReport>[],
    capacity: <String, List<UsageCapacityWindow>>{},
  );

  @override
  Future<BrokerStatusResult> readBrokerStatus() async =>
      const BrokerStatusResult(
        state: BrokerState.connected,
        generation: 7,
        endpoint: 'https://demo.t4code.ts.net',
      );

  @override
  Future<ProjectFileSearchResult> searchProjectFiles(
    String query, {
    int limit = 12,
  }) async {
    final needle = query.trim().toLowerCase();
    final matches = _demoWorkspaceFiles.keys
        .where((path) => needle.isEmpty || path.toLowerCase().contains(needle))
        .take(limit)
        .toList(growable: false);
    return ProjectFileSearchResult(paths: matches, truncated: false);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) {
    return switch (invocation.memberName) {
      #searchTranscripts => Future<TranscriptSearchResult>.value(
        const TranscriptSearchResult(
          items: <TranscriptSearchItem>[],
          incomplete: false,
          index: TranscriptSearchIndexStatus(
            state: TranscriptSearchIndexState.ready,
            indexedSessions: 5,
            knownSessions: 5,
            generation: 'demo',
          ),
        ),
      ),
      #loadTranscriptContext => Future<TranscriptContextResult>.value(
        const TranscriptContextResult(
          anchorId: '',
          rows: <TranscriptContextRow>[],
          anchorIndex: 0,
          hasBefore: false,
          hasAfter: false,
          generation: 'demo',
        ),
      ),
      #submitPrompt ||
      #queuePrompt ||
      #respondToAttention => Future<bool>.value(false),
      #openTerminal || #launchPreview => Future<String>.value(''),
      _ => Future<void>.value(),
    };
  }
}
