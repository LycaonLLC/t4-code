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
    await tester.pumpAndSettle();

    expect(find.text('T4 Code'), findsWidgets);
    expect(
      find.text('Public preview · sample data · actions disabled'),
      findsOneWidget,
    );
    expect(find.text('Align the public demo'), findsWidgets);
    expect(
      find.textContaining('The Flutter client is now the product source'),
      findsOneWidget,
    );
    expect(find.text('Connect to T4'), findsNothing);
  });
}
