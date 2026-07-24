import Foundation
import SwiftUI

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// The user-facing appearance preference. `system` intentionally leaves the
/// color scheme unset so each window follows the platform setting live.
public enum T4ThemePreference: String, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    public var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

private struct T4RGB {
    let red: Double
    let green: Double
    let blue: Double
    let opacity: Double

    init(_ red: Double, _ green: Double, _ blue: Double, opacity: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.opacity = opacity
    }

#if os(macOS)
    var nativeColor: NSColor {
        NSColor(srgbRed: red, green: green, blue: blue, alpha: opacity)
    }
#elseif os(iOS)
    var nativeColor: UIColor {
        UIColor(red: red, green: green, blue: blue, alpha: opacity)
    }
#endif
}

/// Adaptive T4 color tokens. Raw color components live here and nowhere else
/// in the Apple UI, mirroring the web token graph while tinting both extremes.
public enum T4Color {
    public static var background: Color { adaptive(light: .init(0.985, 0.982, 0.990), dark: .init(0.059, 0.059, 0.067)) }
    public static var surface: Color { adaptive(light: .init(0.965, 0.961, 0.972), dark: .init(0.078, 0.078, 0.090)) }
    public static var raised: Color { adaptive(light: .init(0.996, 0.993, 0.998), dark: .init(0.100, 0.100, 0.114)) }
    public static var foreground: Color { adaptive(light: .init(0.145, 0.137, 0.153), dark: .init(0.890, 0.894, 0.902)) }
    public static var secondaryText: Color { adaptive(light: .init(0.337, 0.322, 0.353), dark: .init(0.710, 0.710, 0.745)) }
    public static var mutedText: Color { adaptive(light: .init(0.470, 0.455, 0.486), dark: .init(0.590, 0.590, 0.625)) }
    public static var border: Color { adaptive(light: .init(0.145, 0.137, 0.153, opacity: 0.11), dark: .init(0.890, 0.894, 0.902, opacity: 0.10)) }
    public static var input: Color { adaptive(light: .init(0.145, 0.137, 0.153, opacity: 0.15), dark: .init(0.890, 0.894, 0.902, opacity: 0.14)) }

    public static var accent: Color { adaptive(light: .init(0.710, 0.105, 0.350), dark: .init(0.955, 0.350, 0.575)) }
    public static var accentForeground: Color { adaptive(light: .init(0.990, 0.975, 0.982), dark: .init(0.105, 0.055, 0.075)) }
    public static var accentSoft: Color { adaptive(light: .init(0.710, 0.105, 0.350, opacity: 0.10), dark: .init(0.955, 0.350, 0.575, opacity: 0.18)) }

    public static var destructive: Color { adaptive(light: .init(0.720, 0.120, 0.120), dark: .init(0.965, 0.390, 0.375)) }
    public static var destructiveSoft: Color { adaptive(light: .init(0.720, 0.120, 0.120, opacity: 0.09), dark: .init(0.965, 0.390, 0.375, opacity: 0.16)) }
    public static var warning: Color { adaptive(light: .init(0.635, 0.390, 0.025), dark: .init(0.940, 0.680, 0.225)) }
    public static var warningSoft: Color { adaptive(light: .init(0.635, 0.390, 0.025, opacity: 0.10), dark: .init(0.940, 0.680, 0.225, opacity: 0.16)) }
    public static var success: Color { adaptive(light: .init(0.110, 0.500, 0.330), dark: .init(0.365, 0.820, 0.600)) }
    public static var successSoft: Color { adaptive(light: .init(0.110, 0.500, 0.330, opacity: 0.10), dark: .init(0.365, 0.820, 0.600, opacity: 0.16)) }
    public static var info: Color { adaptive(light: .init(0.120, 0.355, 0.735), dark: .init(0.390, 0.650, 0.980)) }
    public static var infoSoft: Color { adaptive(light: .init(0.120, 0.355, 0.735, opacity: 0.09), dark: .init(0.390, 0.650, 0.980, opacity: 0.16)) }

    public static var statusWorking: Color { info }
    public static var statusApproval: Color { warning }
    public static var statusInput: Color { adaptive(light: .init(0.310, 0.240, 0.760), dark: .init(0.635, 0.570, 0.980)) }
    public static var statusPlan: Color { adaptive(light: .init(0.495, 0.205, 0.725), dark: .init(0.735, 0.525, 0.940)) }
    public static var statusDone: Color { success }
    public static var statusError: Color { destructive }

    private static func adaptive(light: T4RGB, dark: T4RGB) -> Color {
#if os(macOS)
        let dynamic = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                ? dark.nativeColor
                : light.nativeColor
        }
        return Color(nsColor: dynamic)
#elseif os(iOS)
        return Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark.nativeColor : light.nativeColor
        })
#else
        return Color(red: light.red, green: light.green, blue: light.blue, opacity: light.opacity)
#endif
    }
}

/// Four-point/ eight-point spacing vocabulary used across native surfaces.
public enum T4Spacing {
    public static let xxs: CGFloat = 4
    public static let xs: CGFloat = 8
    public static let sm: CGFloat = 12
    public static let md: CGFloat = 16
    public static let lg: CGFloat = 24
    public static let xl: CGFloat = 32
    public static let xxl: CGFloat = 48
}

public enum T4Radius {
    public static let sm: CGFloat = 6
    public static let md: CGFloat = 10
    public static let lg: CGFloat = 14
    public static let pill: CGFloat = 1_000
}

public enum T4Layout {
    public static let wideBreakpoint: CGFloat = 980
    public static let readableMeasure: CGFloat = 760
    public static let settingsRailWidth: CGFloat = 240
    public static let minimumControlHeight: CGFloat = 44
}

/// Central display-boundary redaction. It is deliberately conservative:
/// secret-like settings are identified by key and never rendered, while
/// incidental diagnostics have credentials and URL query data removed.
public enum T4Privacy {
    public static func isSecretKey(_ key: String) -> Bool {
        let normalized = key
            .precomposedStringWithCompatibilityMapping
            .lowercased()
            .filter { $0.isLetter || $0.isNumber }
        return [
            "password", "passwd", "secret", "token", "credential", "apikey",
            "privatekey", "cookie", "auth", "sessionkey",
        ].contains { normalized.contains($0) }
    }

    public static func redacted(_ value: String) -> String {
        value
            .replacingOccurrences(
                of: "(?i)\\b(authorization|auth|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key|session[_-]?key)\\b\\s*[:=]\\s*[^\\s,;]+",
                with: "$1=<redacted>",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: "(?i)(https?://[^\\s/?#]+)[^\\s]*",
                with: "$1",
                options: .regularExpression
            )
    }
}

/// Native fallbacks for the product's DM Sans / JetBrains Mono type intent.
/// SwiftUI's semantic styles retain Dynamic Type scaling on both platforms.
public enum T4Typography {
    public static func heading(
        _ style: Font.TextStyle = .headline,
        weight: Font.Weight = .semibold
    ) -> Font {
        .system(style, design: .default, weight: weight)
    }

    public static func body(
        _ style: Font.TextStyle = .body,
        weight: Font.Weight = .regular
    ) -> Font {
        .system(style, design: .default, weight: weight)
    }

    public static func monospaced(
        _ style: Font.TextStyle = .body,
        weight: Font.Weight = .regular
    ) -> Font {
        .system(style, design: .monospaced, weight: weight)
    }
}

public enum T4StatusTone: Sendable {
    case neutral
    case working
    case approval
    case input
    case plan
    case success
    case done
    case warning
    case error

    fileprivate var color: Color {
        switch self {
        case .neutral: T4Color.mutedText
        case .working: T4Color.statusWorking
        case .approval: T4Color.statusApproval
        case .input: T4Color.statusInput
        case .plan: T4Color.statusPlan
        case .success, .done: T4Color.statusDone
        case .warning: T4Color.warning
        case .error: T4Color.statusError
        }
    }

    fileprivate var background: Color {
        switch self {
        case .neutral: T4Color.surface
        case .working: T4Color.infoSoft
        case .approval, .warning: T4Color.warningSoft
        case .input, .plan: T4Color.accentSoft
        case .success, .done: T4Color.successSoft
        case .error: T4Color.destructiveSoft
        }
    }
}

/// Dot-plus-label status presentation. Its meaning never depends on color.
public struct T4StatusPill: View {
    private let label: String
    private let tone: T4StatusTone
    private let isPulsing: Bool

    public init(_ label: String, tone: T4StatusTone = .neutral, isPulsing: Bool = false) {
        self.label = label
        self.tone = tone
        self.isPulsing = isPulsing
    }

    public init(text: String, tone: T4StatusTone = .neutral, isPulsing: Bool = false) {
        self.init(text, tone: tone, isPulsing: isPulsing)
    }

    public var body: some View {
        HStack(spacing: T4Spacing.xxs) {
            Circle()
                .fill(tone.color)
                .frame(width: T4Spacing.xxs + 2, height: T4Spacing.xxs + 2)
                .opacity(isPulsing ? 0.82 : 1)
                .accessibilityHidden(true)
            Text(label)
                .font(T4Typography.body(.caption, weight: .medium))
        }
        .foregroundStyle(tone.color)
        .padding(.horizontal, T4Spacing.xs)
        .padding(.vertical, T4Spacing.xxs)
        .background(tone.background, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

/// A compact, action-oriented empty state suitable for full pages and panels.
public struct T4EmptyState: View {
    private let icon: String
    private let title: String
    private let message: String
    private let actionTitle: String?
    private let action: (() -> Void)?

    public init(
        icon: String,
        title: String,
        message: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    public init(
        title: String,
        message: String,
        systemImage: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.init(
            icon: systemImage,
            title: title,
            message: message,
            actionTitle: actionTitle,
            action: action
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: T4Spacing.md) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(T4Color.mutedText)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                Text(title)
                    .font(T4Typography.heading(.title3))
                    .foregroundStyle(T4Color.foreground)
                Text(message)
                    .font(T4Typography.body(.subheadline))
                    .foregroundStyle(T4Color.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.bordered)
                    .tint(T4Color.accent)
            }
        }
        .frame(maxWidth: 420, alignment: .leading)
        .padding(T4Spacing.lg)
        .accessibilityElement(children: .contain)
    }
}

/// Error presentation with an assertive announcement and an optional retry.
public struct T4ErrorState: View {
    private let title: String
    private let message: String
    private let retry: (() -> Void)?

    public init(
        title: String = "Something went wrong",
        message: String,
        retry: (() -> Void)? = nil
    ) {
        self.title = title
        self.message = message
        self.retry = retry
    }

    public var body: some View {
        HStack(alignment: .top, spacing: T4Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(T4Color.destructive)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                Text(title)
                    .font(T4Typography.heading(.subheadline))
                Text(message)
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                if let retry {
                    Button("Try again", action: retry)
                        .buttonStyle(.borderless)
                        .font(T4Typography.body(.caption, weight: .semibold))
                        .foregroundStyle(T4Color.destructive)
                }
            }
        }
        .padding(T4Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(T4Color.destructiveSoft, in: RoundedRectangle(cornerRadius: T4Radius.md))
        .accessibilityElement(children: .contain)
    }
}

public extension View {
    /// Applies a persisted T4 appearance without converting `system` into a
    /// frozen light/dark snapshot.
    func t4Theme(_ preference: T4ThemePreference) -> some View {
        preferredColorScheme(preference.colorScheme)
            .tint(T4Color.accent)
    }
}
