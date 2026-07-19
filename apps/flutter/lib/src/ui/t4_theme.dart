part of 't4_app.dart';

abstract final class _T4Breakpoints {
  static const double wide = 980;
}

abstract final class _T4Layout {
  static const double sessionRailWidth = 300;
  static const double contentMaxWidth = 760;
  static const double compactToolbarHeight = 72;
  static const double minimumTouchTarget = 44;
  static const double followScrollThreshold = 96;
}

abstract final class _T4Space {
  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
}

abstract final class _T4Radius {
  static const double sm = 8;
  static const double md = 12;
}

abstract final class _T4Size {
  static const double indicator = 16;
  static const double emptyIcon = 32;
  static const double thinStroke = 2;
  static const double divider = 1;
}

abstract final class _T4Motion {
  static const Duration short = Duration(milliseconds: 180);
  static const Curve standard = Curves.easeOutCubic;
}

abstract final class _T4Palette {
  static const Color lightSeed = Color(0xff566052);
  static const Color lightSurface = Color(0xfff7f7f2);
  static const Color darkSeed = Color(0xffaeb9a8);
  static const Color darkSurface = Color(0xff191b19);
}

abstract final class _T4Theme {
  static ThemeData light() => _build(
    brightness: Brightness.light,
    seed: _T4Palette.lightSeed,
    surface: _T4Palette.lightSurface,
  );

  static ThemeData dark() => _build(
    brightness: Brightness.dark,
    seed: _T4Palette.darkSeed,
    surface: _T4Palette.darkSurface,
  );

  static ThemeData _build({
    required Brightness brightness,
    required Color seed,
    required Color surface,
  }) {
    final scheme = ColorScheme.fromSeed(
      seedColor: seed,
      brightness: brightness,
    ).copyWith(surface: surface);
    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
    );
    final textTheme = base.textTheme.copyWith(
      headlineSmall: base.textTheme.headlineSmall?.copyWith(
        fontWeight: FontWeight.w600,
      ),
      titleLarge: base.textTheme.titleLarge?.copyWith(
        fontWeight: FontWeight.w600,
      ),
      titleMedium: base.textTheme.titleMedium?.copyWith(
        fontWeight: FontWeight.w600,
      ),
      labelLarge: base.textTheme.labelLarge?.copyWith(
        fontWeight: FontWeight.w600,
      ),
    );
    final minimumSize = WidgetStatePropertyAll<Size>(
      Size.square(_T4Layout.minimumTouchTarget),
    );
    final buttonShape = WidgetStatePropertyAll<OutlinedBorder>(
      RoundedRectangleBorder(borderRadius: BorderRadius.circular(_T4Radius.sm)),
    );

    return base.copyWith(
      scaffoldBackgroundColor: scheme.surface,
      textTheme: textTheme,
      visualDensity: VisualDensity.standard,
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        space: _T4Size.divider,
        thickness: _T4Size.divider,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerLow,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: _T4Space.md,
          vertical: _T4Space.sm,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_T4Radius.md),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_T4Radius.md),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_T4Radius.md),
          borderSide: BorderSide(
            color: scheme.primary,
            width: _T4Size.thinStroke,
          ),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: ButtonStyle(minimumSize: minimumSize, shape: buttonShape),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: ButtonStyle(minimumSize: minimumSize, shape: buttonShape),
      ),
      textButtonTheme: TextButtonThemeData(
        style: ButtonStyle(minimumSize: minimumSize),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: ButtonStyle(minimumSize: minimumSize),
      ),
      listTileTheme: ListTileThemeData(
        minTileHeight: _T4Layout.minimumTouchTarget,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_T4Radius.sm),
        ),
      ),
      drawerTheme: DrawerThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: scheme.inverseSurface,
        contentTextStyle: textTheme.bodyMedium?.copyWith(
          color: scheme.onInverseSurface,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_T4Radius.sm),
        ),
      ),
      tooltipTheme: TooltipThemeData(
        waitDuration: _T4Motion.short,
        decoration: BoxDecoration(
          color: scheme.inverseSurface,
          borderRadius: BorderRadius.circular(_T4Radius.sm),
        ),
        textStyle: textTheme.bodySmall?.copyWith(
          color: scheme.onInverseSurface,
        ),
      ),
    );
  }
}
