import SwiftUI
import T4Client
import T4Platform

/// Remote-host directory editor used by iOS onboarding and the connected
/// shell. Endpoint parsing stays in `TailnetEndpointForm`; all mutations are
/// delegated to the root runtime so a profile change also replaces the socket
/// and controller generation.
@MainActor
public struct HostManagementView: View {
    private enum Flow: Equatable {
        case profiles
        case add
        case remove(HostProfile)
    }

    private let directory: HostDirectory
    private let controller: T4ClientController?
    private let isWorking: Bool
    private let errorMessage: String?
    private let presentsOnboarding: Bool
    private let onAdd: (HostProfile) -> Void
    private let onSelect: (HostProfile) -> Void
    private let onRemove: (HostProfile) -> Void
    private let onRetry: () -> Void

    @State private var flow: Flow = .profiles
    @State private var connectionActionPending = false

    public init(
        directory: HostDirectory,
        controller: T4ClientController?,
        isWorking: Bool = false,
        errorMessage: String? = nil,
        presentsOnboarding: Bool = false,
        onAdd: @escaping (HostProfile) -> Void,
        onSelect: @escaping (HostProfile) -> Void,
        onRemove: @escaping (HostProfile) -> Void,
        onRetry: @escaping () -> Void
    ) {
        self.directory = directory
        self.controller = controller
        self.isWorking = isWorking
        self.errorMessage = errorMessage
        self.presentsOnboarding = presentsOnboarding
        self.onAdd = onAdd
        self.onSelect = onSelect
        self.onRemove = onRemove
        self.onRetry = onRetry
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: T4Spacing.xl) {
                header
#if os(macOS)
                if let controller {
                    connectionCard(controller)
                }
#endif

                if let controller,
                   controller.state.authentication == .pairingRequired {
                    PairingCodeView(controller: controller)
                }

                if let errorMessage,
                   !errorMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    T4ErrorState(
                        title: "Remote host change failed",
                        message: T4Privacy.redacted(errorMessage),
                        retry: onRetry
                    )
                }

                flowContent
            }
            .frame(maxWidth: T4Layout.readableMeasure, alignment: .leading)
            .padding(T4Spacing.xl)
            .frame(maxWidth: .infinity)
        }
        .background(T4Color.background)
        .navigationTitle("Remote hosts")
        .onAppear {
            if shouldPresentRemoteOnboarding(for: directory) {
                flow = .add
            }
        }
        .onChange(of: directory) { oldDirectory, newDirectory in
            switch flow {
            case .add
                where Self.remoteProfiles(in: newDirectory).count >
                    Self.remoteProfiles(in: oldDirectory).count:
                flow = .profiles
            case let .remove(profile)
                where !Self.remoteProfiles(in: newDirectory).contains(where: { $0.endpointKey == profile.endpointKey }):
                flow = shouldPresentRemoteOnboarding(for: newDirectory) ? .add : .profiles
            default:
                break
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: T4Spacing.xs) {
            Text(isRemoteOnboarding
                 ? "Connect to a remote T4 host"
                 : "Remote hosts")
                .font(T4Typography.heading(.largeTitle, weight: .bold))
                .foregroundStyle(T4Color.foreground)

            Text(headerDetail)
                .font(T4Typography.body())
                .foregroundStyle(T4Color.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var isRemoteOnboarding: Bool {
        shouldPresentRemoteOnboarding(for: directory)
    }

    private var headerDetail: String {
        if isRemoteOnboarding {
            return "OMP and your projects stay on your computer. Add its encrypted Tailnet address to use T4 Code from this device."
        }
        if remoteProfiles.isEmpty {
#if os(macOS)
            return "T4 Code uses the automatically managed local service by default. Add a Tailnet host only when you want to work with another computer."
#else
            return "Add an encrypted Tailnet address when you want to connect this device to a T4 host."
#endif
        }
        return "Manage optional Tailnet connections without changing projects, sessions, or transcripts on either host."
    }

    private var emptyRemoteHostsMessage: String {
#if os(macOS)
        "The local service remains your default. Add a secure .ts.net address only to connect to another computer."
#else
        "Add the secure .ts.net address shown by T4 on the computer you want to use."
#endif
    }

    private var remoteProfiles: [HostProfile] {
        Self.remoteProfiles(in: directory)
    }

    private static func remoteProfiles(in directory: HostDirectory) -> [HostProfile] {
        directory.profiles.filter { $0.endpointKey != "local" }
    }

    private func shouldPresentRemoteOnboarding(for directory: HostDirectory) -> Bool {
#if os(iOS)
        presentsOnboarding && Self.remoteProfiles(in: directory).isEmpty
#else
        false
#endif
    }

    @ViewBuilder
    private var flowContent: some View {
        switch flow {
        case .profiles:
            profilesContent
        case .add:
            addContent
        case let .remove(profile):
            removeContent(profile)
        }
    }

    private var profilesContent: some View {
        VStack(alignment: .leading, spacing: T4Spacing.lg) {
#if os(iOS)
            if let controller {
                connectionCard(controller)
            }
#endif

            if remoteProfiles.isEmpty {
                T4EmptyState(
                    icon: "network.slash",
                    title: "No remote hosts",
                    message: emptyRemoteHostsMessage,
                    actionTitle: "Add remote host",
                    action: { flow = .add }
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    T4Color.surface,
                    in: RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous)
                )
            } else {
                VStack(alignment: .leading, spacing: T4Spacing.sm) {
                    Text("Saved remote hosts")
                        .font(T4Typography.heading())
                    ForEach(remoteProfiles, id: \.endpointKey) { profile in
                        profileRow(profile)
                    }
                }

                Button {
                    flow = .add
                } label: {
                    Label("Add remote host", systemImage: "plus")
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(isWorking)
            }
        }
    }

    private func profileRow(_ profile: HostProfile) -> some View {
        let isActive = directory.activeEndpointKey == profile.endpointKey
        return HStack(alignment: .center, spacing: T4Spacing.md) {
            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                HStack(spacing: T4Spacing.xs) {
                    Text(profile.label)
                        .font(T4Typography.body(.body, weight: .semibold))
                        .foregroundStyle(T4Color.foreground)
                    if isActive {
                        T4StatusPill("Current", tone: activeProfileTone)
                    }
                }
                Text(profile.profileID == "default"
                     ? "Default profile"
                     : "Profile · \(profile.profileID)")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
                Text(profile.origin)
                    .font(T4Typography.monospaced(.caption))
                    .foregroundStyle(T4Color.mutedText)
                    .lineLimit(1)
                    .textSelection(.enabled)
            }
            .accessibilityElement(children: .combine)

            Spacer(minLength: T4Spacing.sm)

            if !isActive {
                Button("Select") {
                    onSelect(profile)
                }
                .buttonStyle(.bordered)
                .disabled(isWorking)
                .accessibilityLabel("Select \(profile.label), profile \(profile.profileID)")
            }

            Button(role: .destructive) {
                flow = .remove(profile)
            } label: {
                Label("Remove", systemImage: "trash")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.borderless)
            .disabled(isWorking)
            .accessibilityLabel("Remove \(profile.label), profile \(profile.profileID)")
        }
        .padding(T4Spacing.md)
        .background(
            isActive ? T4Color.accentSoft : T4Color.surface,
            in: RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
                .stroke(isActive ? T4Color.accent : T4Color.border)
        }
    }

    private var addContent: some View {
        VStack(alignment: .leading, spacing: T4Spacing.lg) {
            CredentialVolatilityBanner()
            flowHeading(
                title: remoteProfiles.isEmpty ? "Add a remote host" : "Add another remote host",
                detail: "Remote hosts must use an encrypted .ts.net HTTPS origin or its canonical WSS endpoint. Nothing changes unless the address validates and saves successfully."
            )

            TailnetEndpointForm(
                isSubmitting: isWorking,
                submissionMessage: errorMessage,
                submitTitle: "Save remote host"
            ) { profile in
                onAdd(profile)
            }

            if !remoteProfiles.isEmpty {
                Button("Back to remote hosts") {
                    flow = .profiles
                }
                .buttonStyle(.borderless)
                .disabled(isWorking)
            }
        }
        .padding(T4Spacing.lg)
        .background(
            T4Color.surface,
            in: RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous)
                .stroke(T4Color.border)
        }
    }

    private func removeContent(_ profile: HostProfile) -> some View {
        VStack(alignment: .leading, spacing: T4Spacing.lg) {
            flowHeading(
                title: "Remove \(profile.label)?",
                detail: "This deletes the saved endpoint and its scoped Keychain credential from this device. OMP, projects, sessions, and transcripts on the computer are not changed."
            )

            VStack(alignment: .leading, spacing: T4Spacing.xs) {
                Text(profile.endpointKey)
                    .font(T4Typography.monospaced(.caption))
                    .foregroundStyle(T4Color.foreground)
                    .textSelection(.enabled)

                if directory.activeEndpointKey == profile.endpointKey {
                    Label(
                        "This is the current profile. T4 will disconnect it and activate the next saved profile, if one exists.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(T4Typography.body(.caption, weight: .medium))
                    .foregroundStyle(T4Color.warning)
                }
            }
            .padding(T4Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                T4Color.warningSoft,
                in: RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
            )

            HStack(spacing: T4Spacing.sm) {
                Button("Keep host") {
                    flow = .profiles
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(isWorking)

                Button(role: .destructive) {
                    onRemove(profile)
                } label: {
                    HStack(spacing: T4Spacing.xs) {
                        if isWorking {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityHidden(true)
                        }
                        Text(isWorking ? "Removing…" : "Remove host and credential")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isWorking)
            }
        }
        .padding(T4Spacing.lg)
        .background(
            T4Color.surface,
            in: RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous)
                .stroke(T4Color.border)
        }
    }

    private func connectionCard(_ controller: T4ClientController) -> some View {
        HStack(alignment: .center, spacing: T4Spacing.md) {
            VStack(alignment: .leading, spacing: T4Spacing.xs) {
                Text(connectionCardTitle)
                    .font(T4Typography.heading(.subheadline))
                T4StatusPill(
                    connectionLabel(controller.state.connection),
                    tone: connectionTone(controller.state.connection),
                    isPulsing: controller.state.connection == .connecting ||
                        controller.state.connection == .reconnecting
                )
            }

            Spacer(minLength: T4Spacing.sm)

            Button(connectionActionLabel(controller.state.connection)) {
                runConnectionAction(controller)
            }
            .buttonStyle(.bordered)
            .disabled(connectionActionPending || controller.state.connection == .connecting)
        }
        .padding(T4Spacing.md)
        .background(
            T4Color.raised,
            in: RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
                .stroke(T4Color.border)
        }
    }

    private var connectionCardTitle: String {
#if os(macOS)
        "Local service"
#else
        "Remote connection"
#endif
    }

    private func flowHeading(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: T4Spacing.xs) {
            Text(title)
                .font(T4Typography.heading(.title2))
                .foregroundStyle(T4Color.foreground)
            Text(detail)
                .font(T4Typography.body(.subheadline))
                .foregroundStyle(T4Color.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var activeProfileTone: T4StatusTone {
        guard let controller else { return .neutral }
        return connectionTone(controller.state.connection)
    }

    private func connectionLabel(_ connection: T4ConnectionState) -> String {
        switch connection {
        case .disconnected: "Offline"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .reconnecting: "Reconnecting"
        case .failed: "Connection failed"
        }
    }

    private func connectionTone(_ connection: T4ConnectionState) -> T4StatusTone {
        switch connection {
        case .disconnected: .neutral
        case .connecting, .reconnecting: .working
        case .connected: .success
        case .failed: .error
        }
    }

    private func connectionActionLabel(_ connection: T4ConnectionState) -> String {
        switch connection {
        case .connected, .reconnecting: "Disconnect"
        case .failed: "Retry"
        case .disconnected, .connecting: "Connect"
        }
    }

    private func runConnectionAction(_ controller: T4ClientController) {
        guard !connectionActionPending else { return }
        connectionActionPending = true
        Task { @MainActor in
            if controller.state.connection == .connected ||
                controller.state.connection == .reconnecting {
                await controller.disconnect()
            } else {
                await controller.connect()
            }
            connectionActionPending = false
        }
    }
}
