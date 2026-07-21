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
      title: 'Align the public demo',
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
  ],
  messages: const <TranscriptMessage>[
    TranscriptMessage(
      id: 'demo-message-1',
      role: MessageRole.user,
      text:
          'The public demo looks different from the current T4 client. Are they tied together?',
    ),
    TranscriptMessage(
      id: 'demo-message-2',
      role: MessageRole.assistant,
      text:
          'The old demo was built from the React compatibility client. The Flutter client is now the product source of truth.',
    ),
    TranscriptMessage(
      id: 'demo-message-3',
      role: MessageRole.user,
      text: 'Align the demo to Flutter and keep it current.',
    ),
    TranscriptMessage(
      id: 'demo-message-4',
      role: MessageRole.assistant,
      text:
          'The demo now uses this Flutter workspace. It is published from current main independently of downloadable releases.',
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
  dynamic noSuchMethod(Invocation invocation) {
    return switch (invocation.memberName) {
      #searchTranscripts => Future<TranscriptSearchResult>.value(
        const TranscriptSearchResult(
          items: <TranscriptSearchItem>[],
          incomplete: false,
          index: TranscriptSearchIndexStatus(
            state: TranscriptSearchIndexState.ready,
            indexedSessions: 3,
            knownSessions: 3,
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
      #readUsage => Future<UsageReadResult>.value(
        const UsageReadResult(
          generatedAt: 0,
          reports: <UsageReport>[],
          accountsWithoutUsage: <UsageAccountWithoutReport>[],
          capacity: <String, List<UsageCapacityWindow>>{},
        ),
      ),
      #readBrokerStatus => Future<BrokerStatusResult>.value(
        const BrokerStatusResult(state: BrokerState.local, generation: 0),
      ),
      #searchProjectFiles => Future<ProjectFileSearchResult>.value(
        const ProjectFileSearchResult(paths: <String>[], truncated: false),
      ),
      #submitPrompt ||
      #queuePrompt ||
      #respondToAttention => Future<bool>.value(false),
      #openTerminal || #launchPreview => Future<String>.value(''),
      _ => Future<void>.value(),
    };
  }
}
