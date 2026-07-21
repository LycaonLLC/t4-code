import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/app_state.dart';
import 'package:t4code/src/host/host_profile.dart';
import 'package:t4code/src/ui/t4_app.dart';

void main() {
  const wideDesktop = Size(1200, 800);

  T4ViewState shellState() {
    final profile = HostProfile.parseTailnetAddress(
      'https://alpha.tailnet-name.ts.net',
    );
    return T4ViewState(
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
          title: 'Shortcut test session',
          revision: 'revision-alpha',
          status: 'idle',
        ),
      ],
      messages: const <TranscriptMessage>[
        TranscriptMessage(
          id: 'message-0',
          role: MessageRole.assistant,
          text: 'Hello from the transcript',
        ),
      ],
    );
  }

  Future<void> pressChord(
    WidgetTester tester,
    List<LogicalKeyboardKey> keys,
  ) async {
    for (final key in keys) {
      await tester.sendKeyDownEvent(key);
    }
    for (final key in keys.reversed) {
      await tester.sendKeyUpEvent(key);
    }
    await tester.pumpAndSettle();
  }

  testWidgets(
    'mod+shift+F toggles transcript search and Escape returns to conversation',
    (tester) async {
      // Linux → the shell binds control as the primary modifier, which keeps
      // the test free of meta-key platform quirks.
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;

      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = wideDesktop;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        T4App(
          state: shellState(),
          actions: _StubActions(),
          credentialsAreVolatile: false,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Search transcripts'), findsNothing);
      expect(find.text('Hello from the transcript'), findsOneWidget);

      // mod+shift+F opens the search surface.
      await pressChord(tester, const [
        LogicalKeyboardKey.controlLeft,
        LogicalKeyboardKey.shiftLeft,
        LogicalKeyboardKey.keyF,
      ]);
      expect(find.text('Search transcripts'), findsWidgets);

      // Same chord toggles it back off.
      await pressChord(tester, const [
        LogicalKeyboardKey.controlLeft,
        LogicalKeyboardKey.shiftLeft,
        LogicalKeyboardKey.keyF,
      ]);
      expect(find.text('Search transcripts'), findsNothing);
      expect(find.text('Hello from the transcript'), findsOneWidget);

      // Reopen, then Escape returns to the conversation.
      await pressChord(tester, const [
        LogicalKeyboardKey.controlLeft,
        LogicalKeyboardKey.shiftLeft,
        LogicalKeyboardKey.keyF,
      ]);
      expect(find.text('Search transcripts'), findsWidgets);

      await pressChord(tester, const [LogicalKeyboardKey.escape]);
      expect(find.text('Search transcripts'), findsNothing);
      expect(find.text('Hello from the transcript'), findsOneWidget);

      // Reset inside the body: the binding asserts foundation vars before
      // tearDown callbacks run.
      debugDefaultTargetPlatformOverride = null;
    },
  );
}

/// Minimal stub: the shortcut flows under test never reach the host, so any
/// unexpected action call surfaces loudly as a type error instead of passing
/// silently.
final class _StubActions implements T4Actions {
  @override
  Object? noSuchMethod(Invocation invocation) => Future<void>.value();
}
