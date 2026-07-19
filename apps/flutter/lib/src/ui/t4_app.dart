library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/app_state.dart';

part 'adaptive_session_shell.dart';
part 'conversation_pane.dart';
part 'host_management.dart';
part 't4_theme.dart';
part 'session_navigation.dart';

/// Material 3 application shell for T4.
///
/// Protocol and connection behavior stay behind [T4Actions]; this widget only
/// renders the immutable [T4ViewState] supplied by its owner.
final class T4App extends StatelessWidget {
  const T4App({required this.state, required this.actions, super.key});

  final T4ViewState state;
  final T4Actions actions;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'T4',
      theme: _T4Theme.light(),
      darkTheme: _T4Theme.dark(),
      themeMode: ThemeMode.system,
      home: _AdaptiveSessionShell(state: state, actions: actions),
    );
  }
}
