import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/demo/demo_app.dart';

void main() {
  testWidgets('public demo renders the canonical Flutter session workspace', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);

    await tester.pumpWidget(const T4DemoApp());
    // The demo seeds a working session whose rail spinner animates forever,
    // so settle with bounded pumps instead of pumpAndSettle.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('T4 CODE'), findsWidgets);
    expect(
      find.text('Public preview · sample data · actions disabled'),
      findsOneWidget,
    );
    expect(find.text('Fix quick-open stale results'), findsWidgets);
    expect(
      find.textContaining(
        'Quick open now keys its cache',
        findRichText: true,
      ),
      findsOneWidget,
    );
    expect(find.text('Connect to T4'), findsNothing);
  });
}
