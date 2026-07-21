import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/ui/t4_app.dart';

void main() {
  testWidgets('command palette filters, runs on Enter, and closes', (
    tester,
  ) async {
    final ran = <String>[];
    final commands = <PaletteCommand>[
      PaletteCommand(
        id: 'open-settings',
        title: 'Open Settings',
        shortcutLabel: '⌘,',
        run: () => ran.add('open-settings'),
      ),
      PaletteCommand(
        id: 'new-session',
        title: 'New Session',
        shortcutLabel: '⌘N',
        run: () => ran.add('new-session'),
      ),
      PaletteCommand(
        id: 'toggle-inbox',
        title: 'Toggle Inbox',
        run: () => ran.add('toggle-inbox'),
      ),
    ];

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: ElevatedButton(
                onPressed: () =>
                    showCommandPalette(context, commands: commands),
                child: const Text('Palette'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Palette'));
    await tester.pumpAndSettle();

    // All three commands listed initially.
    expect(find.byType(TextField), findsOneWidget);
    expect(find.textContaining('Session'), findsOneWidget);

    // Filter down to just "New Session" via word-prefix fuzzy match.
    await tester.enterText(find.byType(TextField), 'new ses');
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('palette-command-new-session')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey<String>('palette-command-open-settings')),
      findsNothing,
    );

    // Enter runs the single remaining command and closes the dialog.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();

    expect(ran, <String>['new-session']);
    expect(find.byType(TextField), findsNothing);
  });
}
