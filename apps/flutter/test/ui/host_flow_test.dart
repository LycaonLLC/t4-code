import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/app_state.dart';
import 'package:t4code/src/host/host_profile.dart';
import 'package:t4code/src/ui/t4_app.dart';

void main() {
  const compactPhone = Size(390, 844);
  const compactDesktop = Size(979, 800);
  const wideDesktop = Size(980, 800);

  Future<void> pumpApp(
    WidgetTester tester, {
    required T4ViewState state,
    required _FakeActions actions,
    required Size size,
    bool credentialsAreVolatile = false,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      T4App(
        state: state,
        actions: actions,
        credentialsAreVolatile: credentialsAreVolatile,
      ),
    );
    await tester.pump();
  }

  group('host onboarding', () {
    testWidgets('shows an empty-host onboarding form', (tester) async {
      await pumpApp(
        tester,
        state: const T4ViewState.disconnected(),
        actions: _FakeActions(),
        size: compactPhone,
      );

      expect(find.text('Connect to T4'), findsOneWidget);
      expect(find.text('Tailnet HTTPS address'), findsOneWidget);
      expect(find.text('Profile ID (optional)'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Add host'), findsOneWidget);
      expect(find.byType(SafeArea), findsWidgets);
    });

    testWidgets('surfaces the controller validation error', (tester) async {
      final actions = _FakeActions(
        addHostError: const FormatException(
          'Use the full Tailscale hostname ending in .ts.net.',
        ),
      );
      await pumpApp(
        tester,
        state: const T4ViewState.disconnected(),
        actions: actions,
        size: compactPhone,
      );

      await tester.enterText(
        find.byType(TextField).first,
        'https://not-a-tailnet.example',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add host'));
      await tester.pumpAndSettle();

      expect(
        find.text('Use the full Tailscale hostname ending in .ts.net.'),
        findsOneWidget,
      );
      expect(actions.addedAddresses, ['https://not-a-tailnet.example']);
    });

    testWidgets('shows progress while adding a host', (tester) async {
      final completion = Completer<void>();
      final actions = _FakeActions(addHostCompletion: completion);
      await pumpApp(
        tester,
        state: const T4ViewState.disconnected(),
        actions: actions,
        size: compactPhone,
      );

      await tester.enterText(
        find.byType(TextField).first,
        'https://alpha.tailnet-name.ts.net',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add host'));
      await tester.pump();

      expect(find.bySemanticsLabel('Adding host'), findsWidgets);
      final button = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(button.onPressed, isNull);

      completion.complete();
      await tester.pumpAndSettle();
    });
  });

  testWidgets('host manager switches and removes saved hosts', (tester) async {
    final beta = HostProfile.parseTailnetAddress(
      'https://beta.tailnet-name.ts.net',
    );
    final alpha = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final directory = HostDirectory.empty().upsert(beta).upsert(alpha);
    final actions = _FakeActions();
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: directory,
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
      ),
      actions: actions,
      size: wideDesktop,
    );

    await tester.tap(find.text('Manage hosts'));
    await tester.pumpAndSettle();

    expect(find.text('Saved hosts'), findsOneWidget);
    expect(find.text(alpha.origin), findsOneWidget);
    expect(find.text(beta.origin), findsOneWidget);
    expect(find.text('Current host · Ready · Paired'), findsOneWidget);

    await tester.tap(find.bySemanticsLabel('Switch to ${beta.label}'));
    await tester.pumpAndSettle();
    expect(actions.activatedEndpointKeys, [beta.endpointKey]);

    await tester.ensureVisible(find.widgetWithText(TextButton, 'Remove').last);
    await tester.pump();
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is Semantics &&
            widget.properties.label == 'Remove ${alpha.label}',
      ),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(TextButton, 'Remove').last);
    await tester.pumpAndSettle();
    expect(find.text('Remove ${alpha.label}?'), findsOneWidget);
    expect(
      find.textContaining('pairing credential from this device'),
      findsOneWidget,
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Remove host'));
    await tester.pumpAndSettle();
    expect(actions.removedEndpointKeys, [alpha.endpointKey]);
  });

  testWidgets('pairing-required state submits six digits and clears the form', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions();
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.synchronizing,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.pairingRequired,
      ),
      actions: actions,
      size: compactPhone,
    );

    expect(find.text('Pair this device'), findsOneWidget);
    expect(find.text(t4PairCommand), findsOneWidget);
    final code = List<String>.filled(6, '1').join();
    await tester.enterText(find.byType(TextField), code);
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Pair device'));
    await tester.pump();

    expect(actions.pairingCodes, [code]);
    final codeField = tester.widget<TextField>(find.byType(TextField));
    expect(codeField.controller?.text, isEmpty);
    expect(find.text(code), findsNothing);
  });

  testWidgets('pairing-required state surfaces the host rejection', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.synchronizing,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.pairingRequired,
        errorMessage:
            'Pairing failed (INVALID_CODE). Check the code and try again.',
      ),
      actions: _FakeActions(),
      size: compactPhone,
    );

    expect(
      find.textContaining('Pairing failed (INVALID_CODE)'),
      findsOneWidget,
    );
  });

  testWidgets('connected host can be deliberately disconnected', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final actions = _FakeActions();
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
      ),
      actions: actions,
      size: wideDesktop,
    );

    await tester.tap(find.widgetWithText(TextButton, 'Disconnect'));
    await tester.pumpAndSettle();
    expect(actions.disconnectCalls, 1);
  });

  testWidgets(
    'configured endpoint can reconnect after a deliberate disconnect',
    (tester) async {
      final actions = _FakeActions();
      await pumpApp(
        tester,
        state: const T4ViewState(
          connectionPhase: ConnectionPhase.disconnected,
          targetConfigured: true,
        ),
        actions: actions,
        size: compactPhone,
      );

      expect(find.byTooltip('Connect'), findsOneWidget);
      expect(find.text('Connect to T4'), findsNothing);
      await tester.tap(find.byTooltip('Connect'));
      await tester.pumpAndSettle();
      expect(actions.connectCalls, 1);
    },
  );

  testWidgets('compact layout exposes host manager in the drawer', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    await pumpApp(
      tester,
      state: T4ViewState(
        connectionPhase: ConnectionPhase.disconnected,
        hostDirectory: HostDirectory.empty().upsert(profile),
      ),
      actions: _FakeActions(),
      size: compactPhone,
    );

    expect(find.byTooltip('Open navigation'), findsOneWidget);
    await tester.tap(find.byTooltip('Open navigation'));
    await tester.pumpAndSettle();

    expect(find.text('Navigation'), findsOneWidget);
    expect(find.text('Manage hosts'), findsOneWidget);
    expect(find.byType(Drawer), findsOneWidget);
  });

  testWidgets('unsigned macOS development mode is visibly identified', (
    tester,
  ) async {
    await pumpApp(
      tester,
      state: const T4ViewState.disconnected(),
      actions: _FakeActions(),
      size: compactPhone,
      credentialsAreVolatile: true,
    );

    expect(
      find.text('Unsigned development · credentials reset on quit'),
      findsOneWidget,
    );
  });

  testWidgets('responsive split changes from drawer to rail at 980 pixels', (
    tester,
  ) async {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    final state = T4ViewState(
      connectionPhase: ConnectionPhase.ready,
      hostDirectory: HostDirectory.empty().upsert(profile),
      authenticationPhase: AuthenticationPhase.paired,
    );
    final actions = _FakeActions();

    await pumpApp(tester, state: state, actions: actions, size: compactDesktop);
    expect(find.byTooltip('Open navigation'), findsOneWidget);

    tester.view.physicalSize = wideDesktop;
    await tester.pumpWidget(
      T4App(state: state, actions: actions, credentialsAreVolatile: false),
    );
    await tester.pumpAndSettle();

    expect(find.byTooltip('Open navigation'), findsNothing);
    expect(find.text('Manage hosts'), findsOneWidget);
    expect(find.text('T4'), findsOneWidget);
  });
  testWidgets(
    'session rail groups projects, searches, creates, archives, and restores',
    (tester) async {
      final profile = HostProfile.parseTailnetAddress(
        'https://alpha.tailnet-name.ts.net',
      );
      final actions = _FakeActions();
      final state = T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        selectedSessionId: 'session-alpha',
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'First investigation',
            revision: 'revision-alpha',
            status: 'idle',
          ),
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-beta',
            projectId: 'project-beta',
            projectName: 'Project Beta',
            title: 'Second investigation',
            revision: 'revision-beta',
            status: 'idle',
          ),
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-archived',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'Archived investigation',
            revision: 'revision-archived',
            status: 'closed',
            archivedAt: '2026-07-18T00:00:00.000Z',
          ),
        ],
      );
      await pumpApp(tester, state: state, actions: actions, size: wideDesktop);

      expect(find.text('Project Alpha'), findsOneWidget);
      expect(find.text('Project Beta'), findsOneWidget);
      expect(find.text('Archived investigation'), findsNothing);

      await tester.enterText(
        find.widgetWithText(TextField, 'Search sessions'),
        'second',
      );
      await tester.pump();
      expect(
        find.ancestor(
          of: find.text('First investigation'),
          matching: find.byType(ListTile),
        ),
        findsNothing,
      );
      expect(
        find.ancestor(
          of: find.text('Second investigation'),
          matching: find.byType(ListTile),
        ),
        findsOneWidget,
      );
      await tester.tap(find.byTooltip('Clear search'));
      await tester.pump();

      await tester.tap(find.byTooltip('New session'));
      await tester.pumpAndSettle();
      expect(find.text('New session'), findsOneWidget);
      await tester.enterText(find.byType(TextField).last, 'Fresh session');
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pumpAndSettle();
      expect(actions.createdSessions, <({String projectId, String? title})>[
        (projectId: 'project-alpha', title: 'Fresh session'),
      ]);

      await tester.tap(find.byTooltip('Session actions').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Archive').last);
      await tester.pumpAndSettle();
      expect(actions.archivedSessionIds, <String>['session-alpha']);

      await tester.tap(find.text('Archived'));
      await tester.pumpAndSettle();
      expect(find.text('Archived investigation'), findsOneWidget);
      await tester.tap(find.byTooltip('Session actions').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Restore').last);
      await tester.pumpAndSettle();
      expect(actions.restoredSessionIds, <String>['session-archived']);
    },
  );
  testWidgets(
    'composer preserves per-session drafts and exposes turn controls',
    (tester) async {
      final profile = HostProfile.parseTailnetAddress(
        'https://alpha.tailnet-name.ts.net',
      );
      final actions = _FakeActions();
      T4ViewState stateFor(
        String selectedSessionId, {
        bool turnActive = false,
      }) => T4ViewState(
        connectionPhase: ConnectionPhase.ready,
        hostDirectory: HostDirectory.empty().upsert(profile),
        authenticationPhase: AuthenticationPhase.paired,
        grantedCapabilities: t4RequestedCapabilities.toSet(),
        selectedSessionId: selectedSessionId,
        sessions: const <SessionSummary>[
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-alpha',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'First investigation',
            revision: 'revision-alpha',
            status: 'idle',
          ),
          SessionSummary(
            hostId: 'host-alpha',
            sessionId: 'session-beta',
            projectId: 'project-alpha',
            projectName: 'Project Alpha',
            title: 'Second investigation',
            revision: 'revision-beta',
            status: 'idle',
          ),
        ],
        composer: SessionComposerState(
          modelLabel: 'Fixture model',
          modelSelector: 'fixture/model',
          modelChoices: const <ComposerModelChoice>[
            ComposerModelChoice(
              label: 'Fixture model',
              selector: 'fixture/model',
            ),
          ],
          thinking: 'medium',
          thinkingLevels: const <String>['off', 'medium', 'high'],
          fastAvailable: true,
          turnActive: turnActive,
          queuedFollowUpCount: turnActive ? 2 : 0,
        ),
      );

      await pumpApp(
        tester,
        state: stateFor('session-alpha'),
        actions: actions,
        size: compactPhone,
      );
      await tester.enterText(find.byType(TextField).last, 'Alpha draft');

      await tester.pumpWidget(
        T4App(
          state: stateFor('session-beta'),
          actions: actions,
          credentialsAreVolatile: false,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextField, 'Alpha draft'), findsNothing);
      await tester.enterText(find.byType(TextField).last, 'Beta draft');

      await tester.pumpWidget(
        T4App(
          state: stateFor('session-alpha', turnActive: true),
          actions: actions,
          credentialsAreVolatile: false,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.widgetWithText(TextField, 'Alpha draft'), findsOneWidget);
      expect(find.text('Fixture model'), findsOneWidget);
      expect(find.text('medium'), findsOneWidget);
      expect(find.text('Fast'), findsOneWidget);
      expect(find.text('Stop'), findsOneWidget);
      expect(find.text('Queue (2)'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Steer'));
      await tester.pumpAndSettle();
      expect(actions.submittedPrompts, <String>['Alpha draft']);
    },
  );
}

final class _FakeActions implements T4Actions {
  _FakeActions({this.addHostError, this.addHostCompletion});

  final Object? addHostError;
  final Completer<void>? addHostCompletion;
  final List<String> addedAddresses = <String>[];
  final List<String> addedProfileIds = <String>[];
  final List<String> activatedEndpointKeys = <String>[];
  int connectCalls = 0;
  final List<String> removedEndpointKeys = <String>[];
  final List<String> pairingCodes = <String>[];
  int cancelHostProbeCalls = 0;
  int disconnectCalls = 0;
  final List<({String projectId, String? title})> createdSessions =
      <({String projectId, String? title})>[];
  final List<({String sessionId, String title})> renamedSessions =
      <({String sessionId, String title})>[];
  final List<String> terminatedSessionIds = <String>[];
  final List<String> archivedSessionIds = <String>[];
  final List<String> restoredSessionIds = <String>[];
  final List<String> submittedPrompts = <String>[];
  final List<String> queuedPrompts = <String>[];
  int cancelTurnCalls = 0;
  final List<String> selectedModels = <String>[];
  final List<String> selectedThinkingLevels = <String>[];
  final List<bool> selectedFastModes = <bool>[];
  final List<String> deletedSessionIds = <String>[];

  @override
  Future<void> addHost(
    String address, {
    String profileId = defaultHostProfileId,
  }) async {
    addedAddresses.add(address);
    addedProfileIds.add(profileId);
    final error = addHostError;
    if (error != null) throw error;
    await addHostCompletion?.future;
  }

  @override
  void cancelHostProbe() {
    cancelHostProbeCalls += 1;
  }

  @override
  Future<void> activateHost(String endpointKey) async {
    activatedEndpointKeys.add(endpointKey);
  }

  @override
  Future<void> createSession(String projectId, {String? title}) async {
    createdSessions.add((projectId: projectId, title: title));
  }

  @override
  Future<void> renameSession(String sessionId, String title) async {
    renamedSessions.add((sessionId: sessionId, title: title));
  }

  @override
  Future<void> terminateSession(String sessionId) async {
    terminatedSessionIds.add(sessionId);
  }

  @override
  Future<void> archiveSession(String sessionId) async {
    archivedSessionIds.add(sessionId);
  }

  @override
  Future<void> restoreSession(String sessionId) async {
    restoredSessionIds.add(sessionId);
  }

  @override
  Future<void> deleteSession(String sessionId) async {
    deletedSessionIds.add(sessionId);
  }

  @override
  Future<void> connect() async {
    connectCalls += 1;
  }

  @override
  Future<void> disconnect() async {
    disconnectCalls += 1;
  }

  @override
  Future<void> pairHost(String code) async {
    pairingCodes.add(code);
  }

  @override
  Future<void> removeHost(String endpointKey) async {
    removedEndpointKeys.add(endpointKey);
  }

  @override
  Future<void> selectSession(String sessionId) async {}

  @override
  Future<bool> submitPrompt(
    String message, {
    List<PromptImageAttachment> images = const <PromptImageAttachment>[],
  }) async {
    submittedPrompts.add(message);
    return true;
  }

  @override
  Future<bool> queuePrompt(String message) async {
    queuedPrompts.add(message);
    return true;
  }

  @override
  Future<void> cancelTurn() async {
    cancelTurnCalls += 1;
  }

  @override
  Future<void> setSessionModel(String selector) async {
    selectedModels.add(selector);
  }

  @override
  Future<void> setSessionThinking(String level) async {
    selectedThinkingLevels.add(level);
  }

  @override
  Future<void> setSessionFast(bool enabled) async {
    selectedFastModes.add(enabled);
  }

  @override
  Future<Uint8List> readTranscriptImage(
    String entryId,
    TranscriptImageMetadata image,
  ) async => Uint8List(0);
}
