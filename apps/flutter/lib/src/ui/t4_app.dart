library;

import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import '../client/app_state.dart';

part 'adaptive_session_shell.dart';
part 'attention_pane.dart';
part 'conversation_pane.dart';
part 'host_management.dart';
part 't4_theme.dart';
part 'session_navigation.dart';

/// Material 3 application shell for T4.
///
/// Protocol and connection behavior stay behind [T4Actions]; this widget only
/// renders the immutable [T4ViewState] supplied by its owner.
final class T4App extends StatelessWidget {
  const T4App({
    required this.state,
    required this.actions,
    required this.credentialsAreVolatile,
    super.key,
  });

  final T4ViewState state;
  final T4Actions actions;
  final bool credentialsAreVolatile;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'T4',
      theme: _T4Theme.light(),
      darkTheme: _T4Theme.dark(),
      themeMode: ThemeMode.system,
      home: credentialsAreVolatile
          ? _VolatileCredentialsShell(
              child: _AdaptiveSessionShell(state: state, actions: actions),
            )
          : _AdaptiveSessionShell(state: state, actions: actions),
    );
  }
}

final class _VolatileCredentialsShell extends StatelessWidget {
  const _VolatileCredentialsShell({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: [
        Semantics(
          container: true,
          label:
              'Unsigned development mode. Credentials reset when the app quits.',
          child: Material(
            color: colors.tertiaryContainer,
            child: SafeArea(
              bottom: false,
              child: SizedBox(
                height: 32,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Icon(
                      Icons.lock_open_outlined,
                      size: 16,
                      color: colors.onTertiaryContainer,
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        'Unsigned development · credentials reset on quit',
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.labelMedium
                            ?.copyWith(color: colors.onTertiaryContainer),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        Expanded(child: child),
      ],
    );
  }
}
