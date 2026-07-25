import SwiftUI
import T4Client
import T4Platform

public enum T4Destination: String, CaseIterable, Identifiable, Hashable, Sendable {
    case conversation
    case hosts
    case attention
    case developer
    case settings
    case search
    case usage

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .conversation: "Sessions"
        case .hosts: "Remote hosts"
        case .attention: "Inbox"
        case .developer: "Developer"
        case .settings: "Settings"
        case .search: "Search"
        case .usage: "Usage"
        }
    }

    public var systemImage: String {
        switch self {
        case .conversation: "bubble.left.and.bubble.right"
        case .hosts: "network"
        case .attention: "tray"
        case .developer: "hammer"
        case .settings: "gearshape"
        case .search: "magnifyingglass"
        case .usage: "chart.bar.xaxis"
        }
    }
}

@MainActor
public struct AdaptiveShell: View {
    private let controller: T4ClientController
    private let state: AppState

    @State private var destination: T4Destination = .conversation
    @State private var isDrawerPresented = false
    @State private var isQuickOpenPresented = false
    @State private var opensQuickOpenAfterDrawer = false

    public init(controller: T4ClientController) {
        self.controller = controller
        self.state = controller.state
    }

    public var body: some View {
        GeometryReader { geometry in
            if geometry.size.width >= T4Layout.wideBreakpoint {
                wideLayout
            } else {
                compactLayout
            }
        }
        .background(T4Color.background)
        .foregroundStyle(T4Color.foreground)
        .sheet(isPresented: $isQuickOpenPresented) {
            QuickOpenView(
                controller: controller,
                destination: $destination,
                isPresented: $isQuickOpenPresented
            )
        }
    }

    private var wideLayout: some View {
        NavigationSplitView {
            ShellRail(
                controller: controller,
                destination: $destination,
                onQuickOpen: { isQuickOpenPresented = true }
            )
            .navigationSplitViewColumnWidth(
                min: ShellLayout.minimumRailWidth,
                ideal: ShellLayout.idealRailWidth,
                max: ShellLayout.maximumRailWidth
            )
        } detail: {
            shellDetail
        }
        .navigationSplitViewStyle(.balanced)
    }

    private var compactLayout: some View {
        NavigationStack {
            shellDetail
                .navigationTitle(destination.title)
                .toolbar {
                    ToolbarItem(placement: .navigation) {
                        Button {
                            isDrawerPresented = true
                        } label: {
                            Image(systemName: "line.3.horizontal")
                        }
                        .accessibilityLabel("Open navigation drawer")
                    }
                    ToolbarItemGroup(placement: .primaryAction) {
                        Button {
                            isQuickOpenPresented = true
                        } label: {
                            Image(systemName: "magnifyingglass")
                        }
                        .accessibilityLabel("Quick Open")
                        .accessibilityHint("Search sessions and destinations")
                        .keyboardShortcut("k", modifiers: .command)

                        Button {
                            destination = .developer
                        } label: {
                            Image(systemName: T4Destination.developer.systemImage)
                        }
                        .accessibilityLabel("Open Developer workspace")
                        .keyboardShortcut("d", modifiers: [.command, .shift])
                    }
                }
        }
        .sheet(isPresented: $isDrawerPresented, onDismiss: {
            guard opensQuickOpenAfterDrawer else { return }
            opensQuickOpenAfterDrawer = false
            isQuickOpenPresented = true
        }) {
            NavigationStack {
                CompactDrawer(
                    controller: controller,
                    destination: $destination,
                    isPresented: $isDrawerPresented,
                    onQuickOpen: {
                        opensQuickOpenAfterDrawer = true
                        isDrawerPresented = false
                    }
                )
                .navigationTitle("T4 Code")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { isDrawerPresented = false }
                    }
                }
            }
#if os(iOS)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
#endif
        }
    }

    @ViewBuilder
    private var shellDetail: some View {
        VStack(spacing: 0) {
            if let error = state.errorMessage {
                ShellErrorBanner(
                    message: error,
                    canRetry: state.connection == .failed,
                    onRetry: { Task { await controller.connect() } },
                    onDismiss: { state.errorMessage = nil }
                )
            }
            destinationContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(T4Color.background)
    }

    @ViewBuilder
    private var destinationContent: some View {
        switch destination {
        case .conversation:
            ConversationView(controller: controller)
        case .hosts:
            HostManagerView(controller: controller)
        case .attention:
            AttentionView(controller: controller)
        case .developer:
            DeveloperWorkspaceView(controller: controller)
        case .search:
            SearchUsageView(controller: controller, mode: .search)
        case .usage:
            SearchUsageView(controller: controller, mode: .usage)
        case .settings:
            SettingsView(controller: controller, lifecycle: PlatformLifecycleService())
        }
    }
}

@MainActor
private struct ShellRail: View {
    private let controller: T4ClientController
    private let state: AppState
    @Binding private var destination: T4Destination
    private let onQuickOpen: () -> Void

    init(
        controller: T4ClientController,
        destination: Binding<T4Destination>,
        onQuickOpen: @escaping () -> Void
    ) {
        self.controller = controller
        self.state = controller.state
        self._destination = destination
        self.onQuickOpen = onQuickOpen
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: T4Spacing.md) {
                HStack(spacing: T4Spacing.sm) {
                    Image(systemName: "command.square.fill")
                        .font(.title2)
                        .foregroundStyle(T4Color.accent)
                        .accessibilityHidden(true)
                    Text("T4 Code")
                        .font(T4Typography.heading(.title3, weight: .bold))
                    Spacer(minLength: 0)
                    ConnectionIndicator(connection: state.connection)
                }
                ConnectionControl(controller: controller)
            }
            .padding(T4Spacing.md)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: T4Spacing.md) {
                    VStack(spacing: T4Spacing.xxs) {
                        navigationButton(.conversation)
                        navigationButton(.attention)
                        navigationButton(.search)
                    }

                    Divider()

                    SessionNavigationView(controller: controller) { _ in
                        destination = .conversation
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Divider()

                    VStack(spacing: T4Spacing.xxs) {
                        navigationButton(.hosts)
                        navigationButton(.usage)
                        navigationButton(.settings)
                    }
                }
                .padding(T4Spacing.sm)
            }

            Divider()

            VStack(spacing: T4Spacing.xxs) {
                Button(action: onQuickOpen) {
                    Label("Quick Open", systemImage: "magnifyingglass")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(ShellNavigationButtonStyle(isSelected: false))
                .keyboardShortcut("k", modifiers: .command)
                .accessibilityHint("Search sessions and destinations")

                Button {
                    destination = .developer
                } label: {
                    Label("Developer", systemImage: T4Destination.developer.systemImage)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(ShellNavigationButtonStyle(isSelected: destination == .developer))
                .keyboardShortcut("d", modifiers: [.command, .shift])
            }
            .padding(T4Spacing.sm)
        }
        .background(T4Color.surface)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Application navigation")
    }

    private func navigationButton(_ target: T4Destination) -> some View {
        Button {
            destination = target
        } label: {
            HStack(spacing: T4Spacing.sm) {
                Image(systemName: target.systemImage)
                    .frame(width: ShellLayout.navigationIconWidth)
                    .accessibilityHidden(true)
                Text(target.title)
                Spacer(minLength: 0)
                if target == .attention, !state.attention.isEmpty {
                    InboxBadge(count: state.attention.count)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(ShellNavigationButtonStyle(isSelected: destination == target))
        .accessibilityValue(destination == target ? "Selected" : "")
    }
}

@MainActor
private struct CompactDrawer: View {
    private let controller: T4ClientController
    private let state: AppState
    @Binding private var destination: T4Destination
    @Binding private var isPresented: Bool
    private let onQuickOpen: () -> Void

    init(
        controller: T4ClientController,
        destination: Binding<T4Destination>,
        isPresented: Binding<Bool>,
        onQuickOpen: @escaping () -> Void
    ) {
        self.controller = controller
        self.state = controller.state
        self._destination = destination
        self._isPresented = isPresented
        self.onQuickOpen = onQuickOpen
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: T4Spacing.lg) {
                HStack {
                    ConnectionIndicator(connection: state.connection, showsLabel: true)
                    Spacer(minLength: 0)
                    ConnectionControl(controller: controller, compact: true)
                }
                .padding(.horizontal, T4Spacing.md)

                VStack(spacing: T4Spacing.xxs) {
                    drawerButton(.conversation)
                    drawerButton(.attention)
                    drawerButton(.search)
                }
                .padding(.horizontal, T4Spacing.sm)

                Divider()

                VStack(alignment: .leading, spacing: T4Spacing.sm) {
                    Text("Sessions")
                        .font(T4Typography.body(.caption, weight: .semibold))
                        .foregroundStyle(T4Color.mutedText)
                        .textCase(.uppercase)
                        .padding(.horizontal, T4Spacing.md)
                    SessionNavigationView(controller: controller) { _ in
                        destination = .conversation
                        isPresented = false
                    }
                }

                Divider()

                VStack(spacing: T4Spacing.xxs) {
                    drawerButton(.hosts)
                    drawerButton(.usage)
                    drawerButton(.developer)
                    drawerButton(.settings)
                    Button(action: onQuickOpen) {
                        Label("Quick Open", systemImage: "magnifyingglass")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(ShellNavigationButtonStyle(isSelected: false))
                    .accessibilityHint("Search sessions and destinations")
                }
                .padding(.horizontal, T4Spacing.sm)
            }
            .padding(.vertical, T4Spacing.md)
        }
        .background(T4Color.background)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Navigation drawer")
    }

    private func drawerButton(_ target: T4Destination) -> some View {
        Button {
            destination = target
            isPresented = false
        } label: {
            HStack(spacing: T4Spacing.sm) {
                Image(systemName: target.systemImage)
                    .frame(width: ShellLayout.navigationIconWidth)
                    .accessibilityHidden(true)
                Text(target.title)
                Spacer(minLength: 0)
                if target == .attention, !state.attention.isEmpty {
                    InboxBadge(count: state.attention.count)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(ShellNavigationButtonStyle(isSelected: destination == target))
        .accessibilityValue(destination == target ? "Selected" : "")
    }
}

private struct ConnectionIndicator: View {
    let connection: T4ConnectionState
    var showsLabel = false

    var body: some View {
        HStack(spacing: T4Spacing.xs) {
            Circle()
                .fill(color)
                .frame(width: T4Spacing.xs, height: T4Spacing.xs)
                .accessibilityHidden(true)
            if showsLabel {
                Text(label)
                    .font(T4Typography.body(.caption, weight: .medium))
                    .foregroundStyle(T4Color.secondaryText)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Connection status")
        .accessibilityValue(label)
    }

    private var label: String {
        switch connection {
        case .disconnected: "Disconnected"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .reconnecting: "Reconnecting"
        case .failed: "Connection failed"
        }
    }

    private var color: Color {
        switch connection {
        case .disconnected: T4Color.mutedText
        case .connecting: T4Color.info
        case .connected: T4Color.success
        case .reconnecting: T4Color.warning
        case .failed: T4Color.destructive
        }
    }
}

@MainActor
private struct ConnectionControl: View {
    private let controller: T4ClientController
    private let state: AppState
    @State private var isPerforming = false
    private let compact: Bool

    init(controller: T4ClientController, compact: Bool = false) {
        self.controller = controller
        self.state = controller.state
        self.compact = compact
    }

    var body: some View {
        Button(role: disconnects ? .destructive : nil) {
            performAction()
        } label: {
            HStack(spacing: T4Spacing.xs) {
                if isPerforming || state.connection == .connecting || state.connection == .reconnecting {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: actionIcon)
                        .accessibilityHidden(true)
                }
                Text(actionLabel)
            }
            .frame(maxWidth: compact ? nil : .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(compact ? .regular : .large)
        .disabled(isPerforming)
        .accessibilityLabel(actionLabel)
        .accessibilityHint(actionHint)
    }

    private var disconnects: Bool {
        switch state.connection {
        case .connected, .connecting, .reconnecting: true
        case .disconnected, .failed: false
        }
    }

    private var actionLabel: String {
        switch state.connection {
        case .disconnected: "Connect"
        case .connecting: "Cancel"
        case .connected: "Disconnect"
        case .reconnecting: "Stop retrying"
        case .failed: "Retry"
        }
    }

    private var actionIcon: String {
        disconnects ? "stop.circle" : state.connection == .failed ? "arrow.clockwise" : "bolt.horizontal.circle"
    }

    private var actionHint: String {
        switch state.connection {
        case .disconnected: "Connects to the selected host profile"
        case .connecting: "Cancels the current connection attempt"
        case .connected: "Disconnects from the live host"
        case .reconnecting: "Stops automatic reconnection"
        case .failed: "Tries the selected host again"
        }
    }

    private func performAction() {
        guard !isPerforming else { return }
        let shouldDisconnect = disconnects
        isPerforming = true
        Task { @MainActor in
            if shouldDisconnect {
                await controller.disconnect()
            } else {
                await controller.connect()
            }
            isPerforming = false
        }
    }
}

private struct InboxBadge: View {
    let count: Int

    var body: some View {
        Text(count > ShellLayout.maximumBadgeCount ? "\(ShellLayout.maximumBadgeCount)+" : "\(count)")
            .font(T4Typography.body(.caption2, weight: .bold))
            .foregroundStyle(T4Color.accentForeground)
            .padding(.horizontal, T4Spacing.xs)
            .padding(.vertical, T4Spacing.xxs)
            .background(T4Color.accent, in: Capsule())
            .accessibilityLabel("\(count) items need attention")
    }
}

private struct ShellErrorBanner: View {
    let message: String
    let canRetry: Bool
    let onRetry: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: T4Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(T4Color.destructive)
                .accessibilityHidden(true)
            Text(T4Privacy.redacted(message))
                .font(T4Typography.body(.subheadline))
                .lineLimit(3)
            Spacer(minLength: 0)
            if canRetry {
                Button("Retry", action: onRetry)
                    .buttonStyle(.bordered)
            }
            Button(action: onDismiss) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Dismiss connection error")
        }
        .padding(T4Spacing.sm)
        .background(T4Color.destructiveSoft)
        .accessibilityElement(children: .contain)
    }
}

private struct ShellNavigationButtonStyle: ButtonStyle {
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(T4Typography.body(.subheadline, weight: isSelected ? .semibold : .regular))
            .foregroundStyle(isSelected ? T4Color.accent : T4Color.foreground)
            .padding(.horizontal, T4Spacing.sm)
            .padding(.vertical, T4Spacing.xs)
            .frame(minHeight: T4Layout.minimumControlHeight)
            .background(
                isSelected ? T4Color.accentSoft : configuration.isPressed ? T4Color.raised : Color.clear,
                in: RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
            )
            .contentShape(Rectangle())
    }
}

private struct QuickOpenEntry: Identifiable {
    enum Action {
        case destination(T4Destination)
        case session(String)
    }

    let id: String
    let title: String
    let subtitle: String
    let systemImage: String
    let action: Action
}

@MainActor
private struct QuickOpenView: View {
    private let controller: T4ClientController
    private let state: AppState
    @Binding private var destination: T4Destination
    @Binding private var isPresented: Bool
    @State private var query = ""

    init(
        controller: T4ClientController,
        destination: Binding<T4Destination>,
        isPresented: Binding<Bool>
    ) {
        self.controller = controller
        self.state = controller.state
        self._destination = destination
        self._isPresented = isPresented
    }

    var body: some View {
        NavigationStack {
            Group {
                if filteredEntries.isEmpty {
                    T4EmptyState(
                        icon: "magnifyingglass",
                        title: "No matches",
                        message: "Try a session title, host, or destination such as Inbox or Settings."
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(filteredEntries) { entry in
                        Button {
                            select(entry)
                        } label: {
                            HStack(spacing: T4Spacing.sm) {
                                Image(systemName: entry.systemImage)
                                    .foregroundStyle(T4Color.mutedText)
                                    .frame(width: ShellLayout.quickOpenIconWidth)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                                    Text(entry.title)
                                        .font(T4Typography.body(.body, weight: .medium))
                                    Text(entry.subtitle)
                                        .font(T4Typography.body(.caption))
                                        .foregroundStyle(T4Color.secondaryText)
                                        .lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(entry.title), \(entry.subtitle)")
                    }
                    .scrollContentBackground(.hidden)
                }
            }
            .background(T4Color.background)
            .navigationTitle("Quick Open")
            .searchable(text: $query, prompt: "Sessions and destinations")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { isPresented = false }
                }
            }
        }
#if os(iOS)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
#endif
    }

    private var entries: [QuickOpenEntry] {
        let destinations = T4Destination.allCases.map { destination in
            QuickOpenEntry(
                id: "destination:\(destination.rawValue)",
                title: destination.title,
                subtitle: destination == .developer ? "Inspect terminal, files, review, audit, and preview" : "Open \(destination.title)",
                systemImage: destination.systemImage,
                action: .destination(destination)
            )
        }
        let sessions = state.sessions.map { session in
            QuickOpenEntry(
                id: "session:\(session.id)",
                title: session.title.isEmpty ? "Untitled session" : session.title,
                subtitle: [session.hostID, session.status].filter { !$0.isEmpty }.joined(separator: " · "),
                systemImage: "bubble.left",
                action: .session(session.id)
            )
        }
        return destinations + sessions
    }

    private var filteredEntries: [QuickOpenEntry] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return entries }
        return entries.filter {
            $0.title.localizedCaseInsensitiveContains(trimmed) ||
            $0.subtitle.localizedCaseInsensitiveContains(trimmed)
        }
    }

    private func select(_ entry: QuickOpenEntry) {
        switch entry.action {
        case let .destination(target):
            destination = target
            isPresented = false
        case let .session(sessionID):
            Task { @MainActor in
                await controller.selectSession(sessionID)
                destination = .conversation
                isPresented = false
            }
        }
    }
}

private enum ShellLayout {
    static let minimumRailWidth: CGFloat = 252
    static let idealRailWidth: CGFloat = 288
    static let maximumRailWidth: CGFloat = 340
    static let navigationIconWidth: CGFloat = 20
    static let quickOpenIconWidth: CGFloat = 24
    static let maximumBadgeCount = 99
}
