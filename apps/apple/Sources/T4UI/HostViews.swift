import Foundation
import SwiftUI
import T4Client
import T4Platform
import T4Protocol

public struct CredentialVolatilityBanner: View {
    public init() {}

    public var body: some View {
        HStack(alignment: .top, spacing: T4Spacing.sm) {
            Image(systemName: "key.horizontal")
                .foregroundStyle(T4Color.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                Text("Pairing credential storage")
                    .font(T4Typography.body(.subheadline, weight: .semibold))
#if DEBUG
                Text("This unsigned development build may keep a pairing credential only for the current run. If it cannot use Keychain, you will need to pair again after the app closes.")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
#else
                Text("Pairing credentials are scoped to each remote endpoint and stored in this device’s Keychain. Removing a remote host also removes its saved credential.")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
#endif
            }
            Spacer(minLength: 0)
        }
        .padding(T4Spacing.md)
        .background(T4Color.warningSoft, in: RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

public struct TailnetEndpointForm: View {
    @State private var address = ""
    @State private var profileID = ""
    @State private var validationMessage: String?

    private let isSubmitting: Bool
    private let submissionMessage: String?
    private let submitTitle: String
    private let onSubmit: (HostProfile) -> Void

    public init(
        isSubmitting: Bool = false,
        submissionMessage: String? = nil,
        submitTitle: String = "Save remote host",
        onSubmit: @escaping (HostProfile) -> Void
    ) {
        self.isSubmitting = isSubmitting
        self.submissionMessage = submissionMessage
        self.submitTitle = submitTitle
        self.onSubmit = onSubmit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: T4Spacing.md) {
            VStack(alignment: .leading, spacing: T4Spacing.xs) {
                Text("Remote host address")
                    .font(T4Typography.body(.subheadline, weight: .semibold))
                TextField("https://host.tailnet-name.ts.net:8445", text: $address)
                    .font(T4Typography.monospaced())
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    .autocorrectionDisabled()
                    .disabled(isSubmitting)
                    .accessibilityLabel("Remote host Tailnet HTTPS or WSS address")
                    .accessibilityHint("Enter the secure .ts.net address shown by T4 on the remote computer")
                    .onChange(of: address) { _, _ in validationMessage = nil }
            }

            VStack(alignment: .leading, spacing: T4Spacing.xs) {
                Text("Profile ID")
                    .font(T4Typography.body(.subheadline, weight: .semibold))
                TextField("default", text: $profileID)
                    .font(T4Typography.monospaced())
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    .autocorrectionDisabled()
                    .disabled(isSubmitting)
                    .accessibilityHint("Optional. Leave empty to use the remote host’s default profile")
                    .onChange(of: profileID) { _, _ in validationMessage = nil }
                Text("Use a full Tailnet HTTPS origin or its canonical WSS endpoint. Only encrypted .ts.net addresses are accepted.")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
            }

            if let message = validationMessage ?? submissionMessage {
                Label(message, systemImage: "exclamationmark.circle.fill")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.destructive)
                    .accessibilityLabel("Endpoint error: \(message)")
            }

            Button {
                submit()
            } label: {
                HStack(spacing: T4Spacing.xs) {
                    if isSubmitting {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityHidden(true)
                    }
                    Text(isSubmitting ? "Saving remote host…" : submitTitle)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isSubmitting || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityHint("Validates the address before it is saved")
        }
        .onSubmit(submit)
    }

    private func submit() {
        guard !isSubmitting else { return }
        do {
            let profile = try Self.parseEndpoint(address, profileID: profileID)
            validationMessage = nil
            onSubmit(profile)
        } catch {
            validationMessage = "Enter a secure .ts.net HTTPS origin or WSS endpoint and a valid profile ID."
        }
    }

    private static func parseEndpoint(_ rawAddress: String, profileID rawProfileID: String) throws -> HostProfile {
        let trimmed = rawAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedProfileID = try HostProfile.normalizeProfileID(rawProfileID)
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "wss" else {
            throw HostProfileStoreError.invalidProfile
        }

        let canonicalPath: String
        if normalizedProfileID == "default" {
            canonicalPath = "/v1/ws"
        } else {
            let encodedProfile = normalizedProfileID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? normalizedProfileID
            canonicalPath = "/v1/profiles/\(encodedProfile)/ws"
        }
        let path = components.percentEncodedPath
        guard (path.isEmpty || path == "/" || path == canonicalPath),
              components.query == nil,
              components.fragment == nil else {
            throw HostProfileStoreError.invalidProfile
        }

        components.scheme = "https"
        components.percentEncodedPath = ""
        guard let origin = components.string else { throw HostProfileStoreError.invalidProfile }
        return try HostProfile.parseTailnetAddress(origin, profileID: normalizedProfileID)
    }
}

@MainActor
public struct PairingCodeView: View {
    fileprivate enum SubmissionState: Equatable {
        case idle
        case sending
        case sent
        case failed
    }

    private let controller: T4ClientController
    private let state: AppState
    @State private var code = ""
    @State private var submissionState: SubmissionState = .idle

    public init(controller: T4ClientController) {
        self.controller = controller
        self.state = controller.state
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: T4Spacing.md) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                    Text("Pair this device")
                        .font(T4Typography.heading())
                    Text("Enter the one-time six-digit code shown by the host.")
                        .font(T4Typography.body(.subheadline))
                        .foregroundStyle(T4Color.secondaryText)
                }
                Spacer(minLength: 0)
                connectionLabel
            }

            pairingField

            switch submissionState {
            case .idle, .sending:
                if state.connection != .connected {
                    Label("Connect to the host before submitting the code.", systemImage: "wifi.exclamationmark")
                        .font(T4Typography.body(.caption))
                        .foregroundStyle(T4Color.warning)
                }
            case .sent:
                Label("Code sent. The host will reconnect this device after pairing completes.", systemImage: "checkmark.circle.fill")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.success)
                    .accessibilityLabel("Pairing code sent")
            case .failed:
                Label("The code could not be sent. Check the connection and try again.", systemImage: "exclamationmark.circle.fill")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.destructive)
                    .accessibilityLabel("Pairing failed")
            }

            Button {
                sendPairingCode()
            } label: {
                HStack(spacing: T4Spacing.xs) {
                    if submissionState == .sending {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityHidden(true)
                    }
                    Text(submissionState == .sending ? "Submitting code…" : submissionState == .failed ? "Try pairing again" : "Pair device")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(code.count != 6 || state.connection != .connected || submissionState == .sending || submissionState == .sent)
        }
        .padding(T4Spacing.lg)
        .background(T4Color.surface, in: RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous)
                .stroke(T4Color.border)
        }
    }

    @ViewBuilder
    private var pairingField: some View {
#if os(iOS)
        TextField("000000", text: $code)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .pairingCodeStyle(code: $code, submissionState: $submissionState)
#else
        TextField("000000", text: $code)
            .pairingCodeStyle(code: $code, submissionState: $submissionState)
#endif
    }

    private var connectionLabel: some View {
        HStack(spacing: T4Spacing.xs) {
            Circle()
                .fill(state.connection == .connected ? T4Color.success : T4Color.mutedText)
                .frame(width: T4Spacing.xs, height: T4Spacing.xs)
                .accessibilityHidden(true)
            Text(state.connection == .connected ? "Host online" : "Host offline")
                .font(T4Typography.body(.caption, weight: .medium))
                .foregroundStyle(T4Color.secondaryText)
        }
        .accessibilityElement(children: .combine)
    }

    private func sendPairingCode() {
        guard code.count == 6, state.connection == .connected, submissionState != .sending else { return }
        submissionState = .sending
        let submittedCode = code
        Task { @MainActor in
            do {
                let data = try WireEncoder.pairStart(
                    requestId: UUID().uuidString.lowercased(),
                    code: submittedCode,
                    deviceId: Self.deviceID,
                    deviceName: "Apple device",
                    platform: Self.platformName,
                    requestedCapabilities: []
                )
                try await controller.transport.send(try WireDecoder.decode(data))
                submissionState = .sent
            } catch {
                submissionState = .failed
            }
        }
    }

    private static let deviceID: String = {
        let key = "t4-code:apple-device-id:v1"
        if let value = UserDefaults.standard.string(forKey: key), !value.isEmpty { return value }
        let value = UUID().uuidString.lowercased()
        UserDefaults.standard.set(value, forKey: key)
        return value
    }()

    private static var platformName: String {
#if os(macOS)
        "macos"
#else
        "ios"
#endif
    }
}

private extension View {
    func pairingCodeStyle(code: Binding<String>, submissionState: Binding<PairingCodeView.SubmissionState>) -> some View {
        self
            .font(T4Typography.monospaced(.title2, weight: .semibold))
            .multilineTextAlignment(.center)
            .textFieldStyle(.roundedBorder)
            .controlSize(.large)
            .autocorrectionDisabled()
            .disabled(submissionState.wrappedValue == .sending || submissionState.wrappedValue == .sent)
            .accessibilityLabel("Six-digit pairing code")
            .accessibilityValue("\(code.wrappedValue.count) of 6 digits entered")
            .onChange(of: code.wrappedValue) { _, newValue in
                let digits = newValue.filter(\.isNumber)
                let normalized = String(digits.prefix(6))
                if code.wrappedValue != normalized { code.wrappedValue = normalized }
                if submissionState.wrappedValue == .failed { submissionState.wrappedValue = .idle }
            }
    }
}

@MainActor
public struct HostOnboardingView: View {
    private let controller: T4ClientController

    public init(controller: T4ClientController) {
        self.controller = controller
    }

    public var body: some View {
        HostManagerView(controller: controller, presentsOnboarding: true)
    }
}

@MainActor
public struct HostManagerView: View {
    private enum ManagerFlow: Equatable {
        case profiles
        case add
        case remove(HostProfile)
    }

    private let controller: T4ClientController
    private let state: AppState
    private let profileStore: any HostProfileStore
    private let credentialStore: any CredentialStore
    private let presentsOnboarding: Bool

    @State private var directory = HostDirectory.empty
    @State private var flow: ManagerFlow = .profiles
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var hasLoaded = false
    @State private var errorMessage: String?

    public init(
        controller: T4ClientController,
        profileStore: any HostProfileStore = UserDefaultsHostProfileStore(),
        credentialStore: any CredentialStore = KeychainCredentialStore(),
        presentsOnboarding: Bool = false
    ) {
        self.controller = controller
        self.state = controller.state
        self.profileStore = profileStore
        self.credentialStore = credentialStore
        self.presentsOnboarding = presentsOnboarding
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: T4Spacing.xl) {
                header
#if os(macOS)
                localServiceStatus
#endif

                if state.authentication == .pairingRequired {
                    PairingCodeView(controller: controller)
                }

                if isLoading {
                    HStack(spacing: T4Spacing.sm) {
                        ProgressView()
                        Text("Loading remote hosts…")
                            .font(T4Typography.body())
                            .foregroundStyle(T4Color.secondaryText)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, T4Spacing.xxl)
                    .accessibilityElement(children: .combine)
                } else {
                    flowContent
                }
            }
            .frame(maxWidth: T4Layout.readableMeasure, alignment: .leading)
            .padding(T4Spacing.xl)
            .frame(maxWidth: .infinity)
        }
        .background(T4Color.background)
        .task {
            guard !hasLoaded else { return }
            hasLoaded = true
            await loadDirectory()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: T4Spacing.xs) {
            Text(isRemoteOnboarding ? "Connect to a remote T4 host" : "Remote hosts")
                .font(T4Typography.heading(.largeTitle, weight: .bold))
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
        if directory.profiles.isEmpty {
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

    private func shouldPresentRemoteOnboarding(for directory: HostDirectory) -> Bool {
#if os(iOS)
        presentsOnboarding && directory.profiles.isEmpty
#else
        false
#endif
    }

#if os(macOS)
    private var localServiceStatus: some View {
        HStack(alignment: .center, spacing: T4Spacing.md) {
            VStack(alignment: .leading, spacing: T4Spacing.xs) {
                Text("Local service")
                    .font(T4Typography.heading(.subheadline))
                T4StatusPill(
                    localServiceLabel,
                    tone: localServiceTone,
                    isPulsing: state.connection == .connecting || state.connection == .reconnecting
                )
            }
            Spacer(minLength: T4Spacing.sm)
            Text("This Mac")
                .font(T4Typography.body(.caption, weight: .medium))
                .foregroundStyle(T4Color.secondaryText)
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
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Local service: \(localServiceLabel)")
    }

    private var localServiceLabel: String {
        switch state.connection {
        case .disconnected: "Offline"
        case .connecting: "Starting"
        case .connected: "Ready"
        case .reconnecting: "Restarting"
        case .failed: "Service error"
        }
    }

    private var localServiceTone: T4StatusTone {
        switch state.connection {
        case .disconnected: .neutral
        case .connecting, .reconnecting: .working
        case .connected: .success
        case .failed: .error
        }
    }
#endif

    @ViewBuilder
    private var flowContent: some View {
        switch flow {
        case .profiles:
            profilesContent
        case .add:
            addProfileContent
        case let .remove(profile):
            removalContent(profile)
        }
    }

    private var profilesContent: some View {
        VStack(alignment: .leading, spacing: T4Spacing.lg) {
            if let errorMessage {
                errorBanner(
                    errorMessage,
                    retry: directory.profiles.isEmpty
                        ? { Task { @MainActor in await loadDirectory() } }
                        : nil
                )
            }

            if directory.profiles.isEmpty {
                VStack(alignment: .leading, spacing: T4Spacing.md) {
                    Label("No remote hosts", systemImage: "network.slash")
                        .font(T4Typography.heading())
                    Text(emptyRemoteHostsMessage)
                        .font(T4Typography.body(.subheadline))
                        .foregroundStyle(T4Color.secondaryText)
                    Button("Add remote host") {
                        errorMessage = nil
                        flow = .add
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
                .padding(T4Spacing.lg)
                .background(T4Color.surface, in: RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous))
            } else {
                VStack(alignment: .leading, spacing: T4Spacing.sm) {
                    Text("Saved remote hosts")
                        .font(T4Typography.heading())
                    ForEach(directory.profiles, id: \.endpointKey) { profile in
                        profileRow(profile)
                    }
                }

                Button {
                    errorMessage = nil
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
        let isCurrent = directory.activeEndpointKey == profile.endpointKey
        return HStack(alignment: .center, spacing: T4Spacing.md) {
            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                HStack(spacing: T4Spacing.xs) {
                    Text(profile.label)
                        .font(T4Typography.body(.body, weight: .semibold))
                    if isCurrent {
                        Text("CURRENT")
                            .font(T4Typography.body(.caption2, weight: .bold))
                            .foregroundStyle(T4Color.accent)
                            .padding(.horizontal, T4Spacing.xs)
                            .padding(.vertical, T4Spacing.xxs)
                            .background(T4Color.accentSoft, in: Capsule())
                    }
                }
                Text(profile.profileID == "default" ? "Default profile" : "Profile · \(profile.profileID)")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
                Text(profile.origin)
                    .font(T4Typography.monospaced(.caption))
                    .foregroundStyle(T4Color.mutedText)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)

            Spacer(minLength: T4Spacing.sm)

            if !isCurrent {
                Button("Select") {
                    activate(profile)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(isWorking)
                .accessibilityLabel("Select \(profile.label), profile \(profile.profileID)")
            }

            Button(role: .destructive) {
                errorMessage = nil
                flow = .remove(profile)
            } label: {
                Label("Remove", systemImage: "trash")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.borderless)
            .frame(
                minWidth: T4Layout.minimumControlHeight,
                minHeight: T4Layout.minimumControlHeight
            )
            .disabled(isWorking)
            .accessibilityLabel("Remove \(profile.label), profile \(profile.profileID)")
        }
        .padding(T4Spacing.md)
        .background(T4Color.surface, in: RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
                .stroke(isCurrent ? T4Color.accent : T4Color.border)
        }
    }

    private var addProfileContent: some View {
        VStack(alignment: .leading, spacing: T4Spacing.lg) {
            CredentialVolatilityBanner()
            flowHeading(
                title: directory.profiles.isEmpty ? "Add a remote host" : "Add another remote host",
                detail: "Remote hosts must use an encrypted .ts.net HTTPS origin or its canonical WSS endpoint. The current selection remains unchanged if validation or saving fails."
            )
            TailnetEndpointForm(
                isSubmitting: isWorking,
                submissionMessage: errorMessage,
                submitTitle: "Save remote host"
            ) { profile in
                saveProfile(profile)
            }
            if !directory.profiles.isEmpty {
                Button("Back to remote hosts") {
                    errorMessage = nil
                    flow = .profiles
                }
                .buttonStyle(.borderless)
                .disabled(isWorking)
            }
        }
        .padding(T4Spacing.lg)
        .background(T4Color.surface, in: RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous))
    }

    private func removalContent(_ profile: HostProfile) -> some View {
        VStack(alignment: .leading, spacing: T4Spacing.lg) {
            flowHeading(
                title: "Remove \(profile.label)?",
                detail: "This deletes only the saved endpoint and its scoped pairing credential from this device. The host, projects, sessions, and transcripts on your computer are not touched."
            )

            VStack(alignment: .leading, spacing: T4Spacing.xs) {
                Text(profile.endpointKey)
                    .font(T4Typography.monospaced(.caption))
                    .textSelection(.enabled)
                if directory.activeEndpointKey == profile.endpointKey {
                    Label("This is the selected remote profile. Removing it disconnects that host.", systemImage: "exclamationmark.triangle.fill")
                        .font(T4Typography.body(.caption, weight: .medium))
                        .foregroundStyle(T4Color.warning)
                }
            }
            .padding(T4Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T4Color.warningSoft, in: RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous))

            if let errorMessage {
                errorBanner(errorMessage, retry: nil)
            }

            HStack(spacing: T4Spacing.sm) {
                Button("Keep remote host") {
                    errorMessage = nil
                    flow = .profiles
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(isWorking)

                Button(role: .destructive) {
                    remove(profile)
                } label: {
                    HStack(spacing: T4Spacing.xs) {
                        if isWorking {
                            ProgressView()
                                .controlSize(.small)
                                .accessibilityHidden(true)
                        }
                        Text(isWorking ? "Removing…" : "Remove remote host and credential")
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isWorking)
            }
        }
        .padding(T4Spacing.lg)
        .background(T4Color.surface, in: RoundedRectangle(cornerRadius: T4Radius.lg, style: .continuous))
    }

    private func flowHeading(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: T4Spacing.xs) {
            Text(title)
                .font(T4Typography.heading(.title2))
            Text(detail)
                .font(T4Typography.body(.subheadline))
                .foregroundStyle(T4Color.secondaryText)
        }
    }

    private func errorBanner(_ message: String, retry: (() -> Void)?) -> some View {
        HStack(alignment: .top, spacing: T4Spacing.sm) {
            Image(systemName: "exclamationmark.octagon.fill")
                .foregroundStyle(T4Color.destructive)
                .accessibilityHidden(true)
            Text(message)
                .font(T4Typography.body(.subheadline))
                .foregroundStyle(T4Color.foreground)
            Spacer(minLength: 0)
            if let retry {
                Button("Try again", action: retry)
                    .buttonStyle(.borderless)
            }
        }
        .padding(T4Spacing.md)
        .background(T4Color.destructiveSoft, in: RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error: \(message)")
    }

    private func loadDirectory() async {
        isLoading = true
        errorMessage = nil
        do {
            let loaded = try await profileStore.load()
            directory = loaded
            synchronizeAppState(with: loaded)
            if shouldPresentRemoteOnboarding(for: loaded) { flow = .add }
        } catch {
            errorMessage = "Remote hosts could not be loaded. Check this device’s storage and try again."
        }
        isLoading = false
    }

    private func saveProfile(_ profile: HostProfile) {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        Task { @MainActor in
            do {
                var profiles = directory.profiles.filter { $0.endpointKey != profile.endpointKey }
                guard profiles.count < maximumSavedHosts else { throw HostProfileStoreError.tooManyProfiles }
                profiles.append(profile)
                let activeKey = directory.activeEndpointKey ?? profile.endpointKey
                let next = try HostDirectory(profiles: profiles, activeEndpointKey: activeKey)
                try await profileStore.save(next)
                directory = next
                synchronizeAppState(with: next)
                flow = .profiles
            } catch {
                errorMessage = "The host could not be saved. Check the endpoint and available device storage."
            }
            isWorking = false
        }
    }

    private func activate(_ profile: HostProfile) {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        Task { @MainActor in
            do {
                let next = try directory.activating(endpointKey: profile.endpointKey)
                try await profileStore.save(next)
                directory = next
                synchronizeAppState(with: next)
            } catch {
                errorMessage = "The selected remote profile could not be saved. The current selection has not changed."
            }
            isWorking = false
        }
    }

    private func remove(_ profile: HostProfile) {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        let removingCurrent = directory.activeEndpointKey == profile.endpointKey
        Task { @MainActor in
            do {
                if removingCurrent && state.connection != .disconnected {
                    await controller.disconnect()
                }
                try await credentialStore.delete(for: profile)
                let next = try directory.removing(endpointKey: profile.endpointKey)
                try await profileStore.save(next)
                directory = next
                synchronizeAppState(with: next)
                flow = shouldPresentRemoteOnboarding(for: next) ? .add : .profiles
            } catch {
                errorMessage = "The remote host or its pairing credential could not be removed. Nothing on the computer was changed."
            }
            isWorking = false
        }
    }

    private func synchronizeAppState(with directory: HostDirectory) {
        state.profiles = directory.profiles.map { profile in
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
}

