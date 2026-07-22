import Foundation
import Observation
import SwiftUI
import T4Client
import T4Platform
import T4Protocol

public typealias T4ControllerFactory =
    @MainActor @Sendable (HostProfile, DeviceCredentials?) -> T4ClientController

/// The process-wide dependencies used by the native shell. The live
/// composition keeps persistence and service ownership stable while controllers
/// remain disposable per-host projections.
public struct T4Composition: Sendable {
    public let profileStore: any HostProfileStore
    public let credentialStore: any CredentialStore
    public let lifecycle: any PlatformLifecycle
    public let localHostSupervisor: LocalHostSupervisor?

    private let localProfile: HostProfile?
    private let controllerFactory: T4ControllerFactory

    public init(
        profileStore: any HostProfileStore = UserDefaultsHostProfileStore(),
        credentialStore: any CredentialStore = KeychainCredentialStore(),
        lifecycle: any PlatformLifecycle = PlatformLifecycleService(),
        controllerFactory: T4ControllerFactory? = nil,
        localHostSupervisor: LocalHostSupervisor? = nil,
        localProfile: HostProfile? = nil
    ) {
        self.profileStore = profileStore
        self.credentialStore = credentialStore
        self.lifecycle = lifecycle
        self.localHostSupervisor = localHostSupervisor
        self.localProfile = localProfile
        self.controllerFactory = controllerFactory ?? { profile, credentials in
            let state = AppState()
            let transport = URLSessionWebSocketTransport(
                url: profile.webSocketURL,
                profile: profile,
                credentialStore: credentialStore,
                credentials: credentials,
                onWelcome: { [weak state] welcome in
                    guard let state else { return }
                    state.settings.values["client.grantedCapabilities"] =
                        welcome.grantedCapabilities.joined(separator: ",")
                    state.settings.values["client.grantedFeatures"] =
                        welcome.grantedFeatures.joined(separator: ",")
                    state.developer.isEnabled = welcome.grantedCapabilities.contains { capability in
                        capability.hasPrefix("term.") ||
                            capability.hasPrefix("files.") ||
                            capability == "audit.read" ||
                            capability == "preview.read" ||
                            capability == "preview.control" ||
                            capability == "preview.input"
                    }
                },
                onPairingSaved: { [weak state] in
                    state?.authentication = .paired
                }
            )
            return T4ClientController(transport: transport, state: state)
        }
    }

    public static func live() -> T4Composition {
        T4Composition(
            profileStore: UserDefaultsHostProfileStore(),
            credentialStore: KeychainCredentialStore(),
            lifecycle: PlatformLifecycleService()
        )
    }

    public static func local(bundle: Bundle = .main) -> T4Composition {
        let profile = try! HostProfile(
            endpointKey: "local",
            origin: "local",
            profileID: "default",
            webSocketURL: URL(string: "wss://local/v1/ws")!,
            label: "This Mac"
        )
        return T4Composition(
            profileStore: UserDefaultsHostProfileStore(),
            credentialStore: KeychainCredentialStore(),
            lifecycle: PlatformLifecycleService(),
            localHostSupervisor: LocalHostSupervisor(bundle: bundle),
            localProfile: profile
        )
    }

    var usesLocalHost: Bool { localHostSupervisor != nil }

    @MainActor
    func makeController(
        profile: HostProfile,
        credentials: DeviceCredentials?
    ) -> T4ClientController {
        controllerFactory(profile, credentials)
    }

    @MainActor
    func makeLocalController(socketPath: String) throws -> T4ClientController {
        let state = AppState()
        let transport = try UnixWebSocketTransport(socketPath: socketPath)
        return T4ClientController(transport: transport, state: state)
    }

    func localProfileValue() -> HostProfile? { localProfile }
}

@MainActor
@Observable
final class T4AppRuntime {
    private let composition: T4Composition

    var directory = HostDirectory.empty
    var controller: T4ClientController?
    var isLoadingHosts = true
    var isHostOperationInFlight = false
    var hasLoadedHosts = false
    var hostError: String?
    var localPhase: LocalHostPhase = .stopped
    var localError: String?

    init(composition: T4Composition) {
        self.composition = composition
    }

    var lifecycle: any PlatformLifecycle { composition.lifecycle }
    var usesLocalHost: Bool { composition.usesLocalHost }

    func loadHosts() async {
        guard !hasLoadedHosts else { return }
        isLoadingHosts = true
        hostError = nil
        do {
            directory = try await composition.profileStore.load()
            hasLoadedHosts = true
            isLoadingHosts = false
            if let profile = directory.activeProfile {
                await replaceController(with: profile)
            }
        } catch {
            hasLoadedHosts = true
            isLoadingHosts = false
            hostError = "Saved hosts could not be loaded. Check this device’s storage and try again."
        }
    }

    func startLocalHost() async {
        guard let supervisor = composition.localHostSupervisor,
              let profile = composition.localProfileValue()
        else { return }
        guard localPhase != .starting else { return }
        if localPhase == .running, controller?.state.connection == .connected { return }

        if let controller {
            await controller.disconnect()
            self.controller = nil
        }
        localPhase = .starting
        localError = nil
        do {
            _ = try await supervisor.start()
            let socketPath = (await supervisor.status()).socketURL.path
            let next = try composition.makeLocalController(socketPath: socketPath)
            directory = try HostDirectory(profiles: [profile], activeEndpointKey: profile.endpointKey)
            controller = next
            synchronizeProfiles()
            await next.connect()
            guard next.state.connection == .connected else {
                throw LocalHostSupervisorError.launchFailed(
                    next.state.errorMessage ?? "The local T4 runtime could not establish a connection."
                )
            }
            localPhase = .running
        } catch {
            if let controller {
                await controller.disconnect()
                self.controller = nil
            }
            localPhase = .failed
            localError = localMessage(for: error)
        }
    }

    func stopLocalHost() async {
        guard let supervisor = composition.localHostSupervisor else { return }
        if let controller {
            await controller.disconnect()
            self.controller = nil
        }
        do {
            let status = try await supervisor.stop()
            localPhase = status.phase
        } catch {
            localPhase = .failed
            localError = localMessage(for: error)
        }
    }

    func reloadHosts() async {
        guard !isHostOperationInFlight else { return }
        isHostOperationInFlight = true
        defer { isHostOperationInFlight = false }
        hostError = nil
        do {
            let loaded = try await composition.profileStore.load()
            directory = loaded
            if let profile = loaded.activeProfile {
                if controller?.state.selectedProfileID != profile.endpointKey {
                    await replaceController(with: profile)
                } else {
                    synchronizeProfiles()
                }
            } else if let controller {
                await controller.disconnect()
                self.controller = nil
            }
        } catch {
            hostError = "Saved hosts could not be loaded. Check this device’s storage and try again."
        }
    }

    func add(_ profile: HostProfile) async {
        guard !isHostOperationInFlight else { return }
        isHostOperationInFlight = true
        defer { isHostOperationInFlight = false }
        hostError = nil
        do {
            let next = try directory.upserting(profile)
            try await composition.profileStore.save(next)
            directory = next
            await replaceController(with: profile)
        } catch {
            hostError = "The host could not be saved. Check the endpoint and available device storage."
        }
    }

    func select(_ profile: HostProfile) async {
        guard !isHostOperationInFlight,
              profile.endpointKey != directory.activeEndpointKey
        else { return }
        isHostOperationInFlight = true
        defer { isHostOperationInFlight = false }
        hostError = nil
        do {
            let next = try directory.activating(endpointKey: profile.endpointKey)
            try await composition.profileStore.save(next)
            directory = next
            await replaceController(with: profile)
        } catch {
            hostError = "The selected host could not be activated. The previous host remains saved."
        }
    }

    func remove(_ profile: HostProfile) async {
        guard !isHostOperationInFlight else { return }
        isHostOperationInFlight = true
        defer { isHostOperationInFlight = false }
        hostError = nil
        let wasActive = directory.activeEndpointKey == profile.endpointKey
        do {
            if wasActive, let controller {
                await controller.disconnect()
            }
            try await composition.credentialStore.delete(for: profile)
            let next = try directory.removing(endpointKey: profile.endpointKey)
            try await composition.profileStore.save(next)
            directory = next

            if wasActive {
                controller = nil
                if let replacement = next.activeProfile {
                    await replaceController(with: replacement)
                }
            } else {
                synchronizeProfiles()
            }
        } catch {
            hostError = "The host or its pairing credential could not be removed. Nothing on the computer was changed."
        }
    }

    func retryConnection() async {
        guard !isHostOperationInFlight else { return }
        if let controller {
            await controller.connect()
        } else if let profile = directory.activeProfile {
            await replaceController(with: profile)
        }
    }

    private func replaceController(with profile: HostProfile) async {
        if let controller {
            await controller.disconnect()
        }

        let credentials: DeviceCredentials?
        do {
            credentials = try await composition.credentialStore.read(for: profile)
        } catch {
            credentials = nil
            hostError = "The saved pairing credential could not be read. You may need to pair this host again."
        }

        let next = composition.makeController(profile: profile, credentials: credentials)
        controller = next
        synchronizeProfiles()
        await next.connect()
    }

    private func synchronizeProfiles() {
        guard let controller else { return }
        controller.state.profiles = directory.profiles.map { profile in
            T4Profile(
                id: profile.endpointKey,
                label: profile.label,
                targetID: profile.profileID,
                isEnabled: true,
                isSelected: profile.endpointKey == directory.activeEndpointKey
            )
        }
        controller.selectProfile(directory.activeEndpointKey)
    }

    private func localMessage(for error: Error) -> String {
        switch error {
        case let error as LocalHostSupervisorError:
            switch error {
            case .unsupported: "Local T4 runtime is unavailable on this Mac."
            case .invalidResource(let message),
                 .invalidPath(let message),
                 .launchFailed(let message),
                 .timedOut(let message):
                message
            case .processExited(_, let message):
                message
            }
        default:
            String(describing: error)
        }
    }
}

@MainActor
public struct T4RootView: View {
    @State private var runtime: T4AppRuntime
    @State private var route: T4RootRoute = .conversation
    @State private var showsCompactNavigation = false
    @AppStorage("t4-code:apple-theme-preference:v1")
    private var themeValue = T4ThemePreference.system.rawValue

    public init(composition: T4Composition) {
        _runtime = State(initialValue: T4AppRuntime(composition: composition))
    }

    public var body: some View {
        GeometryReader { geometry in
            Group {
                if runtime.usesLocalHost {
                    if runtime.localPhase == .starting || runtime.localPhase == .stopped {
                        localStartingSurface
                    } else if runtime.localPhase == .failed {
                        localErrorSurface
                    } else if let controller = runtime.controller {
                        if geometry.size.width >= T4Layout.wideBreakpoint {
                            wideShell(controller: controller)
                        } else {
                            compactShell(controller: controller)
                        }
                    } else {
                        localStartingSurface
                    }
                } else if runtime.isLoadingHosts && !runtime.hasLoadedHosts {
                    loadingSurface
                } else if runtime.directory.profiles.isEmpty {
                    hostManagement(presentsOnboarding: true)
                } else if let controller = runtime.controller {
                    if geometry.size.width >= T4Layout.wideBreakpoint {
                        wideShell(controller: controller)
                    } else {
                        compactShell(controller: controller)
                    }
                } else {
                    unavailableHostSurface
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T4Color.background)
        }
        .t4Theme(T4ThemePreference(rawValue: themeValue) ?? .system)
        .task {
            if runtime.usesLocalHost {
                await runtime.startLocalHost()
            } else {
                await runtime.loadHosts()
            }
        }
        .onDisappear {
            guard runtime.usesLocalHost else { return }
            Task { await runtime.stopLocalHost() }
        }
    }

    private var loadingSurface: some View {
        VStack(spacing: T4Spacing.md) {
            ProgressView()
                .controlSize(.large)
            Text("Loading saved hosts…")
                .font(T4Typography.body(.subheadline))
                .foregroundStyle(T4Color.secondaryText)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Loading saved hosts")
    }

    private var localStartingSurface: some View {
        VStack(spacing: T4Spacing.md) {
            ProgressView()
                .controlSize(.large)
            Text("Starting the local T4 runtime…")
                .font(T4Typography.body(.subheadline))
                .foregroundStyle(T4Color.secondaryText)
            Text("Preparing this Mac’s private runtime connection.")
                .font(T4Typography.body(.caption))
                .foregroundStyle(T4Color.secondaryText)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Starting the local T4 runtime")
    }

    private var localErrorSurface: some View {
        T4ErrorState(
            title: "The local T4 runtime could not start",
            message: runtime.localError ?? "T4 could not prepare the local runtime connection.",
            retry: {
                Task { await runtime.startLocalHost() }
            }
        )
        .frame(maxWidth: T4Layout.readableMeasure)
        .padding(T4Spacing.xl)
    }

    private var unavailableHostSurface: some View {
        T4ErrorState(
            title: "The active host is unavailable",
            message: runtime.hostError ?? "T4 could not prepare the saved host connection.",
            retry: {
                Task { await runtime.retryConnection() }
            }
        )
        .frame(maxWidth: T4Layout.readableMeasure)
        .padding(T4Spacing.xl)
    }

    private func wideShell(controller: T4ClientController) -> some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                T4ConnectionControl(controller: controller)
                Divider()
                SessionNavigationView(controller: controller) { _ in
                    route = .conversation
                }
                Divider()
                T4RootRouteList(
                    route: $route,
                    attentionCount: controller.state.attention.count
                )
            }
            .background(T4Color.surface)
            .navigationSplitViewColumnWidth(
                min: T4Layout.settingsRailWidth,
                ideal: T4Layout.settingsRailWidth + T4Spacing.xxl,
                max: T4Layout.settingsRailWidth + T4Spacing.xxl + T4Spacing.xxl
            )
        } detail: {
            detail(controller: controller)
        }
        .navigationSplitViewStyle(.balanced)
    }

    private func compactShell(controller: T4ClientController) -> some View {
        NavigationStack {
            detail(controller: controller)
                .navigationTitle(route.title)
                .toolbar {
                    ToolbarItem(placement: .automatic) {
                        Button {
                            showsCompactNavigation = true
                        } label: {
                            Label("Open navigation", systemImage: "sidebar.left")
                        }
                        .accessibilityHint("Shows sessions and app destinations")
                    }

                    ToolbarItemGroup(placement: .automatic) {
                        if !controller.state.attention.isEmpty && route == .conversation {
                            Button {
                                route = .attention
                            } label: {
                                Label(
                                    "\(controller.state.attention.count) attention items",
                                    systemImage: "tray.full"
                                )
                            }
                        }
                        T4CompactConnectionButton(controller: controller)
                    }
                }
        }
        .sheet(isPresented: $showsCompactNavigation) {
            NavigationStack {
                T4CompactNavigationSheet(
                    controller: controller,
                    route: $route,
                    dismiss: { showsCompactNavigation = false }
                )
                .navigationTitle("T4 Code")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            showsCompactNavigation = false
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func detail(controller: T4ClientController) -> some View {
        if route == .hosts {
            hostManagement(presentsOnboarding: false)
        } else if controller.state.authentication == .pairingRequired {
            pairingSurface(controller: controller)
        } else {
            switch route {
            case .conversation:
                ConversationView(controller: controller)
            case .attention:
                AttentionView(controller: controller)
            case .developer:
                DeveloperWorkspaceView(controller: controller)
            case .search:
                SearchUsageView(controller: controller, mode: .search)
            case .usage:
                SearchUsageView(controller: controller, mode: .usage)
            case .settings:
                SettingsView(controller: controller, lifecycle: runtime.lifecycle)
            case .hosts:
                hostManagement(presentsOnboarding: false)
            }
        }
    }

    private func pairingSurface(controller: T4ClientController) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: T4Spacing.lg) {
                VStack(alignment: .leading, spacing: T4Spacing.xs) {
                    Text("Authorize this Apple device")
                        .font(T4Typography.heading(.largeTitle, weight: .bold))
                    Text("Pairing is scoped to the selected Tailnet endpoint. T4 will reconnect with the saved device credential after approval.")
                        .font(T4Typography.body())
                        .foregroundStyle(T4Color.secondaryText)
                }
                CredentialVolatilityBanner()
                PairingCodeView(controller: controller)
            }
            .frame(maxWidth: T4Layout.readableMeasure, alignment: .leading)
            .padding(T4Spacing.xl)
            .frame(maxWidth: .infinity)
        }
        .background(T4Color.background)
    }

    private func hostManagement(presentsOnboarding: Bool) -> some View {
        HostManagementView(
            directory: runtime.directory,
            controller: runtime.controller,
            isWorking: runtime.isHostOperationInFlight,
            errorMessage: runtime.hostError,
            presentsOnboarding: presentsOnboarding,
            onAdd: { profile in
                Task { await runtime.add(profile) }
            },
            onSelect: { profile in
                Task { await runtime.select(profile) }
            },
            onRemove: { profile in
                Task { await runtime.remove(profile) }
            },
            onRetry: {
                Task { await runtime.reloadHosts() }
            }
        )
    }
}

private enum T4RootRoute: String, CaseIterable, Identifiable {
    case conversation
    case attention
    case developer
    case search
    case usage
    case settings
    case hosts

    var id: String { rawValue }

    var title: String {
        switch self {
        case .conversation: "Conversation"
        case .attention: "Attention"
        case .developer: "Developer"
        case .search: "Search"
        case .usage: "Usage"
        case .settings: "Settings"
        case .hosts: "Hosts"
        }
    }

    var systemImage: String {
        switch self {
        case .conversation: "bubble.left.and.bubble.right"
        case .attention: "tray"
        case .developer: "chevron.left.forwardslash.chevron.right"
        case .search: "text.magnifyingglass"
        case .usage: "gauge.with.dots.needle.33percent"
        case .settings: "gearshape"
        case .hosts: "network"
        }
    }

    static let secondary: [T4RootRoute] = [
        .conversation, .attention, .developer, .search, .usage, .settings, .hosts,
    ]
}

@MainActor
private struct T4RootRouteList: View {
    @Binding var route: T4RootRoute
    let attentionCount: Int

    var body: some View {
        ScrollView {
            VStack(spacing: T4Spacing.xxs) {
                ForEach(T4RootRoute.secondary) { destination in
                    T4RootRouteButton(
                        destination: destination,
                        selected: route == destination,
                        badge: destination == .attention ? attentionCount : 0
                    ) {
                        route = destination
                    }
                }
            }
            .padding(T4Spacing.xs)
        }
        .frame(maxHeight: T4Layout.settingsRailWidth)
        .accessibilityLabel("App destinations")
    }
}

@MainActor
private struct T4RootRouteButton: View {
    let destination: T4RootRoute
    let selected: Bool
    let badge: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: T4Spacing.sm) {
                Image(systemName: destination.systemImage)
                    .frame(width: T4Spacing.lg)
                    .accessibilityHidden(true)
                Text(destination.title)
                    .font(T4Typography.body(.subheadline, weight: selected ? .semibold : .regular))
                Spacer(minLength: T4Spacing.xs)
                if badge > 0 {
                    Text("\(badge)")
                        .font(T4Typography.body(.caption2, weight: .bold))
                        .foregroundStyle(T4Color.warning)
                        .padding(.horizontal, T4Spacing.xs)
                        .padding(.vertical, T4Spacing.xxs)
                        .background(T4Color.warningSoft, in: Capsule())
                }
            }
            .foregroundStyle(selected ? T4Color.accent : T4Color.foreground)
            .padding(.horizontal, T4Spacing.sm)
            .frame(minHeight: T4Layout.minimumControlHeight)
            .contentShape(Rectangle())
            .background(
                selected ? T4Color.accentSoft : Color.clear,
                in: RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(destination.title)
        .accessibilityValue(selected ? "Selected" : "Not selected")
    }
}

@MainActor
private struct T4CompactNavigationSheet: View {
    let controller: T4ClientController
    @Binding var route: T4RootRoute
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            SessionNavigationView(controller: controller) { _ in
                route = .conversation
                dismiss()
            }
            Divider()
            ScrollView {
                VStack(spacing: T4Spacing.xxs) {
                    ForEach(T4RootRoute.secondary) { destination in
                        T4RootRouteButton(
                            destination: destination,
                            selected: route == destination,
                            badge: destination == .attention ? controller.state.attention.count : 0
                        ) {
                            route = destination
                            dismiss()
                        }
                    }
                }
                .padding(T4Spacing.xs)
            }
            .frame(maxHeight: T4Layout.settingsRailWidth)
        }
        .background(T4Color.background)
    }
}

@MainActor
private struct T4ConnectionControl: View {
    let controller: T4ClientController
    @State private var actionPending = false

    var body: some View {
        VStack(alignment: .leading, spacing: T4Spacing.sm) {
            HStack(spacing: T4Spacing.sm) {
                Image(systemName: "network")
                    .foregroundStyle(T4Color.accent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                    Text("T4 Code")
                        .font(T4Typography.heading())
                    T4StatusPill(
                        connectionLabel,
                        tone: connectionTone,
                        isPulsing: isConnecting
                    )
                }
                Spacer(minLength: T4Spacing.xs)
                Button(actionLabel) {
                    runAction()
                }
                .buttonStyle(.borderless)
                .disabled(actionPending || isConnecting)
            }

            if let message = controller.state.errorMessage,
               !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(T4Privacy.redacted(message))
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.destructive)
                    .lineLimit(2)
                    .accessibilityLabel("Connection error: \(T4Privacy.redacted(message))")
            }
        }
        .padding(T4Spacing.md)
        .background(T4Color.raised)
    }

    private var isConnecting: Bool {
        controller.state.connection == .connecting ||
            controller.state.connection == .reconnecting
    }

    private var connectionLabel: String {
        switch controller.state.connection {
        case .disconnected: "Offline"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .reconnecting: "Reconnecting"
        case .failed: "Connection failed"
        }
    }

    private var connectionTone: T4StatusTone {
        switch controller.state.connection {
        case .disconnected: .neutral
        case .connecting, .reconnecting: .working
        case .connected: .success
        case .failed: .error
        }
    }

    private var actionLabel: String {
        switch controller.state.connection {
        case .connected, .reconnecting: "Disconnect"
        case .failed: "Retry"
        case .disconnected, .connecting: "Connect"
        }
    }

    private func runAction() {
        guard !actionPending else { return }
        actionPending = true
        Task { @MainActor in
            if controller.state.connection == .connected ||
                controller.state.connection == .reconnecting {
                await controller.disconnect()
            } else {
                await controller.connect()
            }
            actionPending = false
        }
    }
}

@MainActor
private struct T4CompactConnectionButton: View {
    let controller: T4ClientController
    @State private var actionPending = false

    var body: some View {
        Button {
            guard !actionPending else { return }
            actionPending = true
            Task { @MainActor in
                if controller.state.connection == .connected ||
                    controller.state.connection == .reconnecting {
                    await controller.disconnect()
                } else {
                    await controller.connect()
                }
                actionPending = false
            }
        } label: {
            if actionPending ||
                controller.state.connection == .connecting ||
                controller.state.connection == .reconnecting {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel(compactActionLabel)
            } else {
                Label(compactActionLabel, systemImage: compactActionImage)
            }
        }
        .disabled(actionPending || controller.state.connection == .connecting)
        .accessibilityHint("Changes the active host connection")
    }

    private var compactActionLabel: String {
        switch controller.state.connection {
        case .connected, .reconnecting: "Disconnect"
        case .failed: "Retry connection"
        case .disconnected, .connecting: "Connect"
        }
    }

    private var compactActionImage: String {
        switch controller.state.connection {
        case .connected, .reconnecting: "link.badge.minus"
        case .failed: "arrow.clockwise"
        case .disconnected, .connecting: "power"
        }
    }
}

private enum CredentialTransportError: Error {
    case invalidPairingResponse
}

/// URLSession transport boundary that adds only the selected profile's scoped
/// credential and persists a validated pair result before exposing it to UI.
private actor URLSessionWebSocketTransport: T4ClientTransport {
    nonisolated var incoming: AsyncThrowingStream<WireFrame, Error> {
        streamBox.current
    }

    private let transport: WebSocketTransport
    private let profile: HostProfile
    private let credentialStore: any CredentialStore
    private let streamBox = T4IncomingStreamBox()
    private let onWelcome: @MainActor @Sendable (WelcomeFrame) -> Void
    private let onPairingSaved: @MainActor @Sendable () -> Void

    private var credentials: DeviceCredentials?
    private var pendingPair: PairStartFrame?
    private var relayTask: Task<Void, Never>?
    private var generation: UInt64 = 0

    init(
        url: URL,
        profile: HostProfile,
        credentialStore: any CredentialStore,
        credentials: DeviceCredentials?,
        onWelcome: @escaping @MainActor @Sendable (WelcomeFrame) -> Void,
        onPairingSaved: @escaping @MainActor @Sendable () -> Void
    ) {
        transport = WebSocketTransport(url: url)
        self.profile = profile
        self.credentialStore = credentialStore
        self.credentials = credentials
        self.onWelcome = onWelcome
        self.onPairingSaved = onPairingSaved
    }

    func connect() async throws {
        generation &+= 1
        let currentGeneration = generation
        relayTask?.cancel()
        streamBox.replace()
        try await transport.connect()
        let upstream = transport.incoming
        relayTask = Task { [weak self] in
            do {
                for try await frame in upstream {
                    guard let self else { return }
                    try await self.receive(frame, generation: currentGeneration)
                }
                await self?.finishRelay(generation: currentGeneration, error: nil)
            } catch {
                await self?.finishRelay(generation: currentGeneration, error: error)
            }
        }
    }

    func send(_ frame: WireFrame) async throws {
        switch frame {
        case let .hello(hello):
            var raw = hello.raw
            raw["requestedFeatures"] = .array(Self.requestedFeatures.map(JSONValue.string))
            raw["capabilities"] = .object([
                "client": .array(Self.requestedCapabilities.map(JSONValue.string)),
            ])
            if let credentials {
                raw["authentication"] = .object([
                    "deviceId": .string(credentials.deviceID),
                    "deviceToken": .string(credentials.deviceToken),
                ])
            }
            try await transport.send(try Self.frame(raw))

        case let .pairStart(pair):
            var raw = pair.raw
            raw["requestedCapabilities"] =
                .array(Self.requestedCapabilities.map(JSONValue.string))
            let normalized = try Self.frame(raw)
            guard case let .pairStart(request) = normalized else {
                throw CredentialTransportError.invalidPairingResponse
            }
            pendingPair = request
            try await transport.send(normalized)

        default:
            try await transport.send(frame)
        }
    }

    func disconnect() async {
        generation &+= 1
        relayTask?.cancel()
        relayTask = nil
        pendingPair = nil
        await transport.disconnect()
        streamBox.finish()
    }

    private func receive(_ frame: WireFrame, generation currentGeneration: UInt64) async throws {
        guard generation == currentGeneration else { return }
        switch frame {
        case let .welcome(welcome):
            await onWelcome(welcome)

        case let .pairOK(pairOK):
            let saved = try validatedCredentials(pairOK)
            try await credentialStore.write(saved, for: profile)
            guard generation == currentGeneration else { return }
            credentials = saved
            pendingPair = nil
            await onPairingSaved()

        case .pairError:
            pendingPair = nil

        default:
            break
        }
        streamBox.yield(frame)
    }

    private func validatedCredentials(_ response: PairOKFrame) throws -> DeviceCredentials {
        guard let pendingPair,
              response.raw["requestId"]?.stringValue == pendingPair.requestId,
              response.raw["deviceId"]?.stringValue == pendingPair.deviceId,
              response.raw["deviceName"]?.stringValue == pendingPair.deviceName,
              response.raw["platform"]?.stringValue == pendingPair.platform,
              let token = response.raw["deviceToken"]?.stringValue,
              let requested = Self.strings(response.raw["requestedCapabilities"]),
              let granted = Self.strings(response.raw["grantedCapabilities"]),
              Set(requested).isSubset(of: Set(pendingPair.requestedCapabilities)),
              Set(granted).isSubset(of: Set(pendingPair.requestedCapabilities)),
              let expiresAt = response.raw["expiresAt"]?.stringValue,
              let expiration = ISO8601DateFormatter().date(from: expiresAt),
              expiration > Date()
        else {
            throw CredentialTransportError.invalidPairingResponse
        }
        return try DeviceCredentials(deviceID: pendingPair.deviceId, deviceToken: token)
    }

    private func finishRelay(generation currentGeneration: UInt64, error: Error?) async {
        guard generation == currentGeneration else { return }
        relayTask = nil
        if let error {
            await transport.disconnect()
            streamBox.finish(throwing: error)
        } else {
            streamBox.finish()
        }
    }

    private static func strings(_ value: JSONValue?) -> [String]? {
        guard case let .array(values) = value else { return nil }
        let strings = values.compactMap(\.stringValue)
        return strings.count == values.count ? strings : nil
    }

    private static func frame(_ raw: [String: JSONValue]) throws -> WireFrame {
        try WireDecoder.decode(try JSONValue.object(raw).encodedData())
    }

    private static let requestedFeatures = [
        "resume", "host.watch", "session.watch", "session.state", "session.delta",
        "session.observer", "controller.lease", "prompt.lease", "prompt.images",
        "transcript.images", "transcript.search", "transcript.page",
        "agent.lifecycle", "agent.progress", "agent.event", "agent.transcript",
        "terminal.io", "files.list", "files.search", "files.diff", "audit.tail",
        "catalog.metadata", "settings.metadata", "preview.control",
    ]

    private static let requestedCapabilities = [
        "sessions.read", "sessions.prompt", "sessions.control", "sessions.manage",
        "term.open", "term.input", "term.resize", "files.read", "files.write",
        "files.list", "files.diff", "agents.control", "audit.read", "config.read",
        "catalog.read", "config.write", "broker.read", "usage.read", "preview.read",
        "preview.control", "preview.input",
    ]
}

private final class T4IncomingStreamBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stream: AsyncThrowingStream<WireFrame, Error>
    private var continuation: AsyncThrowingStream<WireFrame, Error>.Continuation

    init() {
        var continuation: AsyncThrowingStream<WireFrame, Error>.Continuation!
        stream = AsyncThrowingStream { continuation = $0 }
        self.continuation = continuation
    }

    var current: AsyncThrowingStream<WireFrame, Error> {
        lock.lock()
        defer { lock.unlock() }
        return stream
    }

    func replace() {
        let old: AsyncThrowingStream<WireFrame, Error>.Continuation
        lock.lock()
        old = continuation
        var next: AsyncThrowingStream<WireFrame, Error>.Continuation!
        stream = AsyncThrowingStream { next = $0 }
        continuation = next
        lock.unlock()
        old.finish()
    }

    func yield(_ frame: WireFrame) {
        lock.lock()
        let continuation = continuation
        lock.unlock()
        continuation.yield(frame)
    }

    func finish(throwing error: Error? = nil) {
        lock.lock()
        let continuation = continuation
        lock.unlock()
        if let error {
            continuation.finish(throwing: error)
        } else {
            continuation.finish()
        }
    }
}
