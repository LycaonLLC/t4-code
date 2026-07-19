library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../client/proof_state.dart';

part 'adaptive_session_shell.dart';
part 'conversation_pane.dart';
part 'proof_theme.dart';
part 'session_navigation.dart';

/// Material 3 application shell for the Stage 1 T4 proof client.
///
/// Protocol and connection behavior stay behind [ProofActions]; this widget only
/// renders the immutable [ProofViewState] supplied by its owner.
final class T4ProofApp extends StatelessWidget {
  const T4ProofApp({required this.state, required this.actions, super.key});

  final ProofViewState state;
  final ProofActions actions;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'T4',
      theme: _ProofTheme.light(),
      darkTheme: _ProofTheme.dark(),
      themeMode: ThemeMode.system,
      home: _AdaptiveSessionShell(state: state, actions: actions),
    );
  }
}
