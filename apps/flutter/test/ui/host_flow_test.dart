import 'dart:async';

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
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(T4App(state: state, actions: actions));
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
    final code = List<String>.filled(6, '1').join();
    await tester.enterText(find.byType(TextField), code);
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Pair device'));
    await tester.pump();

    expect(actions.pairingCodes, [code]);
    final editable = tester.widget<EditableText>(find.byType(EditableText));
    expect(editable.controller.text, isEmpty);
    expect(find.text(code), findsNothing);
  });

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
    await tester.pumpWidget(T4App(state: state, actions: actions));
    await tester.pumpAndSettle();

    expect(find.byTooltip('Open navigation'), findsNothing);
    expect(find.text('Manage hosts'), findsOneWidget);
    expect(find.text('T4'), findsOneWidget);
  });
}

final class _FakeActions implements T4Actions {
  _FakeActions({this.addHostError, this.addHostCompletion});

  final Object? addHostError;
  final Completer<void>? addHostCompletion;
  final List<String> addedAddresses = <String>[];
  final List<String> addedProfileIds = <String>[];
  final List<String> activatedEndpointKeys = <String>[];
  final List<String> removedEndpointKeys = <String>[];
  final List<String> pairingCodes = <String>[];

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
  Future<void> activateHost(String endpointKey) async {
    activatedEndpointKeys.add(endpointKey);
  }

  @override
  Future<void> connect() async {}

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
  Future<void> submitPrompt(String message) async {}
}
