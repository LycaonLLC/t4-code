import Foundation
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif
import SwiftUI
import T4Client
import T4Platform
import T4Protocol

public enum SearchUsageMode: String, CaseIterable, Identifiable, Sendable {
    case search
    case usage

    public var id: String { rawValue }
}

@MainActor
public struct SearchUsageView: View {
    @Bindable private var controller: T4ClientController
    public let mode: SearchUsageMode

    public init(controller: T4ClientController, mode: SearchUsageMode) {
        self.controller = controller
        self.mode = mode
    }

    @ViewBuilder
    public var body: some View {
        switch mode {
        case .search:
            TranscriptSearchView(controller: controller)
        case .usage:
            UsageAccountView(controller: controller)
        }
    }
}

private struct T4SearchResult: Identifiable, Sendable {
    let id: String
    let sessionID: String
    let sessionTitle: String
    let projectID: String
    let role: String
    let timestamp: String
    let snippet: String
}

@MainActor
public struct TranscriptSearchView: View {
    @Bindable private var controller: T4ClientController
    @State private var query = ""
    @State private var role = "all"
    @State private var includesArchived = true
    @State private var results: [T4SearchResult] = []
    @State private var isLoading = false
    @State private var hasSearched = false
    @State private var errorMessage: String?
    @State private var announcement = ""

    public init(controller: T4ClientController) {
        self.controller = controller
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: T4Spacing.lg) {
                pageHeading(
                    title: "Transcript search",
                    detail: "Find decisions and prior work without loading every session."
                )

                VStack(alignment: .leading, spacing: T4Spacing.sm) {
                    HStack(spacing: T4Spacing.xs) {
                        TextField("Search transcripts", text: $query)
                            .textFieldStyle(.roundedBorder)
                            .submitLabel(.search)
                            .onSubmit { Task { await search() } }
                            .accessibilityLabel("Transcript search query")
                        Button("Search") { Task { await search() } }
                            .buttonStyle(.borderedProminent)
                            .tint(T4Color.accent)
                            .disabled(trimmedQuery.count < 2 || isLoading || controller.state.connection != .connected)
                    }

                    HStack(spacing: T4Spacing.sm) {
                        Picker("Role", selection: $role) {
                            Text("All roles").tag("all")
                            Text("You").tag("user")
                            Text("Assistant").tag("assistant")
                            Text("Summaries").tag("summary")
                        }
                        .pickerStyle(.menu)
                        Toggle("Include archived", isOn: $includesArchived)
                            .toggleStyle(.switch)
                    }
                    .font(T4Typography.body(.subheadline))
                }
                .padding(T4Spacing.md)
                .background(T4Color.raised, in: RoundedRectangle(cornerRadius: T4Radius.lg))
                .overlay { RoundedRectangle(cornerRadius: T4Radius.lg).stroke(T4Color.border) }

                searchContent
            }
            .frame(maxWidth: T4Layout.readableMeasure, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
            .padding(T4Spacing.lg)
        }
        .background(T4Color.background)
        .navigationTitle("Search")
        .overlay(alignment: .topLeading) {
            Text(announcement)
                .frame(width: 1, height: 1)
                .opacity(0.001)
                .accessibilityHidden(announcement.isEmpty)
        }
    }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    @ViewBuilder
    private var searchContent: some View {
        if controller.state.connection != .connected && !isLoading {
            T4EmptyState(
                icon: "network.slash",
                title: "Search is offline",
                message: "Connect to an OMP host to search its transcript index.",
                actionTitle: "Connect",
                action: { Task { await controller.connect() } }
            )
        } else if isLoading {
            loadingState("Searching transcripts…")
        } else if let errorMessage {
            T4ErrorState(
                title: "Search failed",
                message: errorMessage,
                retry: { Task { await search() } }
            )
        } else if !hasSearched {
            T4EmptyState(
                icon: "text.magnifyingglass",
                title: "Search past conversations",
                message: "Enter at least two characters. Results stay on the connected host until requested."
            )
        } else if results.isEmpty {
            T4EmptyState(
                icon: "magnifyingglass",
                title: "No matching transcript entries",
                message: "Try fewer words, another role, or include archived sessions."
            )
        } else {
            LazyVStack(alignment: .leading, spacing: T4Spacing.xs) {
                Text("\(results.count) result\(results.count == 1 ? "" : "s")")
                    .font(T4Typography.heading(.headline))
                ForEach(results) { result in
                    Button {
                        Task { await controller.selectSession(result.sessionID) }
                    } label: {
                        VStack(alignment: .leading, spacing: T4Spacing.xs) {
                            HStack(alignment: .firstTextBaseline, spacing: T4Spacing.xs) {
                                Text(result.sessionTitle.isEmpty ? "Untitled session" : result.sessionTitle)
                                    .font(T4Typography.heading(.subheadline))
                                    .foregroundStyle(T4Color.foreground)
                                Spacer(minLength: T4Spacing.sm)
                                T4StatusPill(result.role.capitalized, tone: result.role == "user" ? .input : .neutral)
                            }
                            Text(T4Privacy.redacted(result.snippet))
                                .font(T4Typography.body(.subheadline))
                                .foregroundStyle(T4Color.secondaryText)
                                .multilineTextAlignment(.leading)
                                .lineLimit(4)
                            HStack(spacing: T4Spacing.xs) {
                                Text(result.projectID)
                                Text(result.timestamp)
                            }
                            .font(T4Typography.monospaced(.caption))
                            .foregroundStyle(T4Color.mutedText)
                        }
                        .padding(T4Spacing.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(T4Color.raised, in: RoundedRectangle(cornerRadius: T4Radius.md))
                        .overlay { RoundedRectangle(cornerRadius: T4Radius.md).stroke(T4Color.border) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens this session")
                }
            }
        }
    }

    @MainActor
    private func search() async {
        guard trimmedQuery.count >= 2, !isLoading else { return }
        isLoading = true
        hasSearched = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            var args: [String: JSONValue] = [
                "query": .string(trimmedQuery),
                "limit": .integer(50),
                "archived": .string(includesArchived ? "include" : "exclude"),
            ]
            if role != "all" { args["roles"] = .array([.string(role)]) }
            let response = try await controller.command("transcript.search", args: args)
            results = decodeSearchResults(response.result)
            announcement = "Search complete. \(results.count) result\(results.count == 1 ? "" : "s")."
        } catch {
            results = []
            errorMessage = T4Privacy.redacted(String(describing: error))
            announcement = "Search failed."
        }
    }
}

private struct T4UsageLimit: Identifiable, Sendable {
    let id: String
    let label: String
    let status: String
    let used: Double?
    let limit: Double?
    let remaining: Double?
    let usedFraction: Double?
    let unit: String
    let resetLabel: String?
}

private struct T4UsageReport: Identifiable, Sendable {
    let id: String
    let provider: String
    let plan: String?
    let fetchedAt: Double?
    let limits: [T4UsageLimit]
}

private struct T4BrokerStatus: Sendable {
    let state: String
    let endpoint: String?

    var label: String {
        switch state {
        case "local": "Local account"
        case "connected": "Broker connected"
        case "missingToken": "Sign-in required"
        case "unreachable": "Broker unreachable"
        default: state.capitalized
        }
    }

    var detail: String {
        switch state {
        case "local": "Provider accounts are managed by this OMP host."
        case "connected": "OMP can read account status from the configured broker."
        case "missingToken": "The host needs a broker token before account status is available."
        case "unreachable": "The configured account broker did not respond."
        default: "OMP returned an account state this app does not recognize."
        }
    }

    var tone: T4StatusTone {
        switch state {
        case "local", "connected": .success
        case "missingToken": .warning
        case "unreachable": .error
        default: .neutral
        }
    }
}

@MainActor
public struct UsageAccountView: View {
    @Bindable private var controller: T4ClientController
    @State private var reports: [T4UsageReport] = []
    @State private var accountCountWithoutUsage = 0
    @State private var brokerStatus: T4BrokerStatus?
    @State private var brokerError: String?
    @State private var isLoading = false
    @State private var hasLoaded = false
    @State private var errorMessage: String?
    @State private var announcement = ""

    public init(controller: T4ClientController) {
        self.controller = controller
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: T4Spacing.lg) {
                HStack(alignment: .top, spacing: T4Spacing.md) {
                    pageHeading(
                        title: "Usage & accounts",
                        detail: "Provider limits reported by OMP. Credentials are never returned or displayed."
                    )
                    Spacer(minLength: T4Spacing.sm)
                    Button { Task { await loadUsage() } } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                    .disabled(isLoading || controller.state.connection != .connected)
                }
                usageContent
            }
            .frame(maxWidth: T4Layout.readableMeasure, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
            .padding(T4Spacing.lg)
        }
        .background(T4Color.background)
        .navigationTitle("Usage")
        .task {
            if !hasLoaded, controller.state.connection == .connected { await loadUsage() }
        }
        .overlay(alignment: .topLeading) {
            Text(announcement)
                .frame(width: 1, height: 1)
                .opacity(0.001)
                .accessibilityHidden(announcement.isEmpty)
        }
    }

    @ViewBuilder
    private var usageContent: some View {
        if controller.state.connection != .connected && !hasLoaded {
            T4EmptyState(
                icon: "network.slash",
                title: "Usage is offline",
                message: "Connect to an OMP host to read provider account status.",
                actionTitle: "Connect",
                action: { Task { await controller.connect() } }
            )
        } else if isLoading && !hasLoaded {
            loadingState("Loading usage and account status…")
        } else {
            accountStatus
            if let errorMessage, reports.isEmpty {
                T4ErrorState(title: "Usage refresh failed", message: errorMessage, retry: { Task { await loadUsage() } })
            } else if hasLoaded && reports.isEmpty {
                T4EmptyState(
                    icon: "gauge.with.dots.needle.0percent",
                    title: "No usage reports",
                    message: accountCountWithoutUsage > 0
                        ? "\(accountCountWithoutUsage) configured account\(accountCountWithoutUsage == 1 ? " does" : "s do") not publish usage. No credentials were exposed."
                        : "This OMP host has no provider usage to report."
                )
            } else {
                if let errorMessage {
                    T4ErrorState(title: "Showing saved usage", message: errorMessage, retry: { Task { await loadUsage() } })
                }
                LazyVStack(spacing: T4Spacing.sm) {
                    ForEach(reports) { report in usageReport(report) }
                }
            }
        }
    }

    @ViewBuilder
    private var accountStatus: some View {
        VStack(alignment: .leading, spacing: T4Spacing.sm) {
            Text("Account connection")
                .font(T4Typography.heading(.headline))
            if let brokerStatus {
                VStack(alignment: .leading, spacing: T4Spacing.xs) {
                    HStack(spacing: T4Spacing.xs) {
                        T4StatusPill(brokerStatus.label, tone: brokerStatus.tone)
                        Spacer(minLength: T4Spacing.sm)
                        if let endpoint = brokerStatus.endpoint {
                            Text(T4Privacy.redacted(endpoint))
                                .font(T4Typography.monospaced(.caption))
                                .foregroundStyle(T4Color.mutedText)
                        }
                    }
                    Text(brokerStatus.detail)
                        .font(T4Typography.body(.subheadline))
                        .foregroundStyle(T4Color.secondaryText)
                }
                .padding(T4Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(T4Color.raised, in: RoundedRectangle(cornerRadius: T4Radius.md))
                .overlay { RoundedRectangle(cornerRadius: T4Radius.md).stroke(T4Color.border) }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Account connection: \(brokerStatus.label). \(brokerStatus.detail)")
            } else if let brokerError {
                T4ErrorState(title: "Account status unavailable", message: brokerError, retry: { Task { await loadUsage() } })
                Text("The connected device must be granted broker.read.")
                    .font(T4Typography.monospaced(.caption))
                    .foregroundStyle(T4Color.mutedText)
            }
        }
    }

    private func usageReport(_ report: T4UsageReport) -> some View {
        VStack(alignment: .leading, spacing: T4Spacing.md) {
            HStack(alignment: .firstTextBaseline, spacing: T4Spacing.xs) {
                Text(report.provider.capitalized)
                    .font(T4Typography.heading(.headline))
                if let plan = report.plan, !plan.isEmpty {
                    T4StatusPill(plan, tone: .neutral)
                }
                Spacer(minLength: T4Spacing.sm)
                if let fetchedAt = report.fetchedAt {
                    Text(Date(timeIntervalSince1970: fetchedAt / 1_000), style: .relative)
                        .font(T4Typography.monospaced(.caption))
                        .foregroundStyle(T4Color.mutedText)
                }
            }
            if report.limits.isEmpty {
                Text("Account connected; this provider returned no limit windows.")
                    .font(T4Typography.body(.subheadline))
                    .foregroundStyle(T4Color.secondaryText)
            } else {
                ForEach(report.limits) { limit in usageLimit(limit) }
            }
        }
        .padding(T4Spacing.md)
        .background(T4Color.raised, in: RoundedRectangle(cornerRadius: T4Radius.lg))
        .overlay { RoundedRectangle(cornerRadius: T4Radius.lg).stroke(T4Color.border) }
    }

    private func usageLimit(_ limit: T4UsageLimit) -> some View {
        let fraction = max(0, min(1, limit.usedFraction ?? inferredFraction(limit)))
        let tone = usageTone(limit.status, fraction: fraction)
        return VStack(alignment: .leading, spacing: T4Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: T4Spacing.xs) {
                Text(limit.label)
                    .font(T4Typography.body(.subheadline, weight: .medium))
                Spacer(minLength: T4Spacing.sm)
                T4StatusPill(usageStatusLabel(limit.status), tone: tone)
            }
            ProgressView(value: fraction)
                .tint(tone.colorForUsage)
                .accessibilityLabel(limit.label)
                .accessibilityValue("\(Int((fraction * 100).rounded())) percent used")
            HStack(spacing: T4Spacing.xs) {
                Text(usageAmount(limit))
                if let resetLabel = limit.resetLabel { Text("· \(resetLabel)") }
            }
            .font(T4Typography.monospaced(.caption))
            .foregroundStyle(T4Color.mutedText)
        }
        .padding(.vertical, T4Spacing.xxs)
    }

    @MainActor
    private func loadUsage() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        brokerError = nil
        defer { isLoading = false }

        do {
            let response = try await controller.command("usage.read")
            let decoded = decodeUsage(response.result)
            reports = decoded.reports
            accountCountWithoutUsage = decoded.accountCountWithoutUsage
            hasLoaded = true
            announcement = "Usage refreshed. \(reports.count) provider report\(reports.count == 1 ? "" : "s")."
        } catch {
            errorMessage = T4Privacy.redacted(String(describing: error))
            announcement = "Usage refresh failed."
        }

        do {
            let response = try await controller.command("broker.status")
            brokerStatus = decodeBrokerStatus(response.result)
            if brokerStatus == nil {
                brokerError = "The host returned an invalid broker.status response."
            }
        } catch {
            brokerError = T4Privacy.redacted(String(describing: error))
        }
    }
}

private struct T4SettingValue: Sendable {
    let value: String
    let sensitive: Bool
    let writableScopes: [String]
    let restartRequired: Bool
    let available: Bool
    let group: String
    let label: String?
    let help: String?

    init(
        value: String,
        sensitive: Bool,
        writableScopes: [String] = [],
        restartRequired: Bool = false,
        available: Bool = true,
        group: String = "General",
        label: String? = nil,
        help: String? = nil
    ) {
        self.value = value
        self.sensitive = sensitive
        self.writableScopes = writableScopes
        self.restartRequired = restartRequired
        self.available = available
        self.group = group
        self.label = label
        self.help = help
    }

    var isWritable: Bool { available && !sensitive && !writableScopes.isEmpty }
    var scope: String { writableScopes.first ?? "global" }
}

private struct T4SettingMetadata {
    let path: String
    let group: String
    let label: String?
    let help: String?
    let sensitive: Bool
    let configured: Bool
    let restartRequired: Bool
    let available: Bool
    let writableScopes: [String]
}

private struct T4SettingSection: Identifiable {
    let name: String
    let paths: [String]
    var id: String { name }
}

@MainActor
public struct SettingsView: View {
    @Bindable private var controller: T4ClientController
    @AppStorage("t4-code:apple-theme-preference:v1") private var storedTheme = T4ThemePreference.system.rawValue
    @State private var baseline: [String: T4SettingValue] = [:]
    @State private var drafts: [String: String] = [:]
    @State private var resets: Set<String> = []
    @State private var revision: String?
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var hasLoaded = false
    @State private var errorMessage: String?
    @State private var revisionConflict = false
    @State private var confirmsSave = false
    @State private var confirmsUninstall = false
    @State private var announcement = ""
    @State private var lifecycleStatus: RuntimeServiceStatus?
    @State private var lifecycleOperation: String?
    @State private var lifecycleError: String?

    private let lifecycle: any PlatformLifecycle

    public init(controller: T4ClientController, lifecycle: any PlatformLifecycle) {
        self.controller = controller
        self.lifecycle = lifecycle
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: T4Spacing.xl) {
                pageHeading(
                    title: "Settings",
                    detail: "Appearance on this device, staged OMP configuration, and local service diagnostics."
                )
                appearanceSection
                ompSettingsSection
                lifecycleSection
                diagnosticsSection
            }
            .frame(maxWidth: T4Layout.readableMeasure, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
            .padding(T4Spacing.lg)
        }
        .background(T4Color.background)
        .navigationTitle("Settings")
        .task {
            async let settingsLoad: Void = loadSettings()
            async let lifecycleLoad: Void = inspectLifecycle()
            _ = await (settingsLoad, lifecycleLoad)
        }
        .confirmationDialog(
            "Save \(pendingEditCount) OMP setting change\(pendingEditCount == 1 ? "" : "s")?",
            isPresented: $confirmsSave,
            titleVisibility: .visible
        ) {
            Button("Save changes") { Task { await saveSettings() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("OMP may request a second security confirmation before applying these revisioned changes.")
        }
        .confirmationDialog(
            "Remove the local OMP service?",
            isPresented: $confirmsUninstall,
            titleVisibility: .visible
        ) {
            Button("Remove service", role: .destructive) { Task { await runLifecycle("Remove") { try await lifecycle.uninstall() } } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the launch service definition. It does not delete projects or transcripts.")
        }
        .overlay(alignment: .topLeading) {
            Text(announcement)
                .frame(width: 1, height: 1)
                .opacity(0.001)
                .accessibilityHidden(announcement.isEmpty)
        }
        .t4Theme(themePreference)
    }

    private var themePreference: T4ThemePreference {
        T4ThemePreference(rawValue: storedTheme) ?? .system
    }

    private var pendingEditCount: Int {
        let changedValues = drafts.filter { baseline[$0.key]?.value != $0.value }.count
        return changedValues + resets.count
    }

    private var pendingConfirmation: T4AttentionItem? {
        controller.state.attention.first {
            $0.kind.lowercased() == "confirmation" && $0.commandID != nil
        }
    }

    private var appearanceSection: some View {
        settingsGroup(title: "Appearance", detail: "Applied immediately on this device") {
            Picker("Theme", selection: $storedTheme) {
                ForEach(T4ThemePreference.allCases) { preference in
                    Text(preference.title).tag(preference.rawValue)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Color theme")
        }
    }

    @ViewBuilder
    private var ompSettingsSection: some View {
        VStack(alignment: .leading, spacing: T4Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: T4Spacing.xs) {
                Text("OMP settings")
                    .font(T4Typography.heading(.title3))
                if pendingEditCount > 0 { T4StatusPill("\(pendingEditCount) unsaved", tone: .warning) }
                Spacer(minLength: T4Spacing.sm)
                Button("Reload") { Task { await loadSettings() } }
                    .buttonStyle(.borderless)
                    .disabled(isLoading || isSaving || controller.state.connection != .connected)
            }
            Text("Changes are staged here and sent together against the host revision.")
                .font(T4Typography.body(.subheadline))
                .foregroundStyle(T4Color.secondaryText)

            if revisionConflict {
                T4ErrorState(
                    title: "Settings changed on the host",
                    message: "Your staged values were not applied. Reload the latest revision, review, and save again.",
                    retry: { Task { await loadSettings() } }
                )
            } else if let errorMessage {
                T4ErrorState(title: "Settings unavailable", message: errorMessage, retry: { Task { await loadSettings() } })
                if let settingsAccessMessage {
                    Label(settingsAccessMessage, systemImage: "lock.trianglebadge.exclamationmark")
                        .font(T4Typography.body(.caption))
                        .foregroundStyle(T4Color.warning)
                        .accessibilityLabel("Settings capability: \(settingsAccessMessage)")
                }
            }

            if let pendingConfirmation, isSaving {
                VStack(alignment: .leading, spacing: T4Spacing.sm) {
                    T4StatusPill("Security confirmation", tone: .approval)
                    Text("OMP is waiting for permission to apply the staged settings.")
                        .font(T4Typography.body(.subheadline))
                    HStack(spacing: T4Spacing.xs) {
                        Button("Approve changes") { Task { await decideSettingsConfirmation(pendingConfirmation, decision: "approve") } }
                            .buttonStyle(.borderedProminent)
                            .tint(T4Color.accent)
                        Button("Deny", role: .destructive) { Task { await decideSettingsConfirmation(pendingConfirmation, decision: "deny") } }
                            .buttonStyle(.bordered)
                    }
                }
                .padding(T4Spacing.md)
                .background(T4Color.warningSoft, in: RoundedRectangle(cornerRadius: T4Radius.md))
            }

            if isLoading && !hasLoaded {
                loadingState("Loading OMP settings…")
            } else if controller.state.connection != .connected && !hasLoaded {
                T4EmptyState(
                    icon: "network.slash",
                    title: "OMP settings are offline",
                    message: "Connect before reading or changing host configuration.",
                    actionTitle: "Connect",
                    action: { Task { await controller.connect() } }
                )
            } else if baseline.isEmpty && hasLoaded {
                T4EmptyState(
                    icon: "slider.horizontal.3",
                    title: "No editable settings",
                    message: "This OMP host did not publish any settings available to this device."
                )
            } else {
                ForEach(settingGroups) { group in
                    settingsGroup(title: group.name, detail: nil) {
                        VStack(spacing: 0) {
                            ForEach(group.paths, id: \.self) { path in
                                settingRow(path)
                                if path != group.paths.last { Divider().overlay(T4Color.border) }
                            }
                        }
                    }
                }
            }

            if pendingEditCount > 0 {
                HStack(spacing: T4Spacing.xs) {
                    Button("Save changes") { confirmsSave = true }
                        .buttonStyle(.borderedProminent)
                        .tint(T4Color.accent)
                        .disabled(isSaving || revision == nil || controller.state.connection != .connected)
                    Button("Discard") { discardStagedChanges() }
                        .buttonStyle(.bordered)
                        .disabled(isSaving)
                    if isSaving { ProgressView().controlSize(.small).accessibilityLabel("Saving settings") }
                }
                .padding(.top, T4Spacing.xs)
            }
        }
    }

    private var settingGroups: [T4SettingSection] {
        let grouped = Dictionary(grouping: baseline.keys.sorted()) { path in
            baseline[path]?.group ?? "General"
        }
        return grouped.keys.sorted().map {
            T4SettingSection(name: $0, paths: grouped[$0, default: []])
        }
    }

    private func settingRow(_ path: String) -> some View {
        let setting = baseline[path] ?? T4SettingValue(value: "", sensitive: T4Privacy.isSecretKey(path))
        return VStack(alignment: .leading, spacing: T4Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: T4Spacing.sm) {
                VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                    Text(setting.label ?? settingLabel(path))
                        .font(T4Typography.body(.subheadline, weight: .medium))
                    Text(path)
                        .font(T4Typography.monospaced(.caption))
                        .foregroundStyle(T4Color.mutedText)
                }
                Spacer(minLength: T4Spacing.sm)
                if setting.sensitive { T4StatusPill("Secret", tone: .neutral) }
                if !setting.available { T4StatusPill("Unavailable", tone: .warning) }
                if !setting.sensitive && !setting.isWritable { T4StatusPill("Read only", tone: .neutral) }
                if setting.restartRequired { T4StatusPill("Restart required", tone: .warning) }
                if resets.contains(path) { T4StatusPill("Will reset", tone: .warning) }
                if setting.isWritable {
                    Button("Reset") {
                        resets.insert(path)
                        drafts[path] = nil
                    }
                    .buttonStyle(.borderless)
                    .font(T4Typography.body(.caption, weight: .semibold))
                    .disabled(isSaving)
                    .accessibilityLabel("Reset \(setting.label ?? settingLabel(path))")
                }
            }

            if let help = setting.help, !help.isEmpty {
                Text(help)
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
            }

            if setting.sensitive || T4Privacy.isSecretKey(path) {
                Label(
                    setting.value.isEmpty ? "No secret is configured." : "A secret is configured. Its value is never displayed.",
                    systemImage: "lock.fill"
                )
                .font(T4Typography.body(.caption))
                .foregroundStyle(T4Color.mutedText)
                .accessibilityLabel("Secret setting. Value hidden. Read only in this app.")
            } else if setting.value == "true" || setting.value == "false" {
                Toggle("Enabled", isOn: booleanBinding(path))
                    .disabled(resets.contains(path) || !setting.isWritable || isSaving)
                    .accessibilityHint(setting.isWritable ? "Stages this value until Save changes is selected" : "This setting is read only")
            } else {
                TextField("Value", text: valueBinding(path))
                    .textFieldStyle(.roundedBorder)
                    .disabled(resets.contains(path) || !setting.isWritable || isSaving)
                    .accessibilityHint(setting.isWritable ? "Stages this value until Save changes is selected" : "This setting is read only")
            }
        }
        .padding(T4Spacing.md)
    }

    @ViewBuilder
    private var lifecycleSection: some View {
        settingsGroup(title: "Local OMP service", detail: "Lifecycle actions affect this Mac only") {
#if os(iOS)
            T4EmptyState(
                icon: "desktopcomputer.trianglebadge.exclamationmark",
                title: "Service management is unavailable on iOS",
                message: "iPhone and iPad can connect to OMP hosts, but launch, stop, restart, and installation are supported on macOS only."
            )
#else
            if let status = lifecycleStatus {
                VStack(alignment: .leading, spacing: T4Spacing.md) {
                    HStack(spacing: T4Spacing.xs) {
                        T4StatusPill(
                            lifecycleLabel(status),
                            tone: status.service == .running ? .success : status.service == .failed ? .error : .neutral,
                            isPulsing: lifecycleOperation != nil
                        )
                        if let operation = lifecycleOperation {
                            Text("\(operation)…")
                                .font(T4Typography.body(.caption))
                                .foregroundStyle(T4Color.mutedText)
                        }
                    }
                    if let message = status.message {
                        Text(T4Privacy.redacted(message))
                            .font(T4Typography.body(.subheadline))
                            .foregroundStyle(T4Color.secondaryText)
                    }
                    Text(T4Privacy.redacted(status.diagnostics))
                        .font(T4Typography.monospaced(.caption))
                        .foregroundStyle(T4Color.secondaryText)
                        .textSelection(.enabled)
                        .padding(T4Spacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(T4Color.surface, in: RoundedRectangle(cornerRadius: T4Radius.sm))
                        .accessibilityLabel("Service diagnostics")
                    if let lifecycleError {
                        T4ErrorState(title: "Service action failed", message: lifecycleError, retry: { Task { await inspectLifecycle() } })
                    }
                    HStack(spacing: T4Spacing.xs) {
                        if status.definition == .missing {
                            Button("Install") { Task { await runLifecycle("Installing") { try await lifecycle.install() } } }
                                .buttonStyle(.borderedProminent)
                                .tint(T4Color.accent)
                        }
                        if status.service == .running {
                            Button("Restart") { Task { await runLifecycle("Restarting") { try await lifecycle.restart() } } }
                                .buttonStyle(.bordered)
                            Button("Stop") { Task { await runLifecycle("Stopping") { try await lifecycle.stop() } } }
                                .buttonStyle(.bordered)
                        } else if status.definition != .missing {
                            Button("Start") { Task { await runLifecycle("Starting") { try await lifecycle.start() } } }
                                .buttonStyle(.borderedProminent)
                                .tint(T4Color.accent)
                        }
                        Button("Inspect") { Task { await inspectLifecycle() } }
                            .buttonStyle(.bordered)
                        if status.definition != .missing {
                            Button("Remove", role: .destructive) { confirmsUninstall = true }
                                .buttonStyle(.bordered)
                        }
                    }
                    .disabled(lifecycleOperation != nil)
                }
            } else {
                loadingState("Inspecting local OMP service…")
            }
#endif
        }
    }

    private func valueBinding(_ path: String) -> Binding<String> {
        Binding(
            get: { drafts[path] ?? baseline[path]?.value ?? "" },
            set: { drafts[path] = $0; resets.remove(path) }
        )
    }


    private func booleanBinding(_ path: String) -> Binding<Bool> {
        Binding(
            get: { (drafts[path] ?? baseline[path]?.value) == "true" },
            set: { drafts[path] = $0 ? "true" : "false"; resets.remove(path) }
        )
    }

    @MainActor
    private func loadSettings() async {
        guard !isLoading, controller.state.connection == .connected else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let catalogResponse = try await controller.command("catalog.get")
            let metadata = decodeSettingCatalog(catalogResponse.result)
            let response = try await controller.command("settings.read")
            let decoded = decodeSettings(response.result, catalog: metadata)
            baseline = decoded.values
            revision = decoded.revision
            drafts.removeAll(keepingCapacity: true)
            resets.removeAll(keepingCapacity: true)
            revisionConflict = false
            hasLoaded = true
            announcement = "OMP settings loaded."
        } catch {
            if baseline.isEmpty, !controller.state.settings.values.isEmpty {
                baseline = Dictionary(uniqueKeysWithValues: controller.state.settings.values.map { path, value in
                    (
                        path,
                        T4SettingValue(
                            value: T4Privacy.isSecretKey(path) ? "configured" : value,
                            sensitive: T4Privacy.isSecretKey(path),
                            group: "Host snapshot"
                        )
                    )
                })
                hasLoaded = true
            }
            errorMessage = T4Privacy.redacted(String(describing: error))
            announcement = "OMP settings failed to load."
        }
    }

    @MainActor
    private func saveSettings() async {
        guard let revision, pendingEditCount > 0, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        revisionConflict = false
        let edits = settingsEdits()
        do {
            _ = try await controller.command(
                "settings.write",
                expectedRevision: revision,
                args: [
                    "edits": .array(edits),
                    "expectedRevision": .string(revision),
                ]
            )
            isSaving = false
            announcement = "OMP settings saved."
            await loadSettings()
        } catch {
            isSaving = false
            let message = T4Privacy.redacted(String(describing: error))
            if message.lowercased().contains("stale_revision") || message.lowercased().contains("stale revision") {
                revisionConflict = true
                announcement = "Settings conflict. Reload required."
            } else {
                errorMessage = message
                announcement = "OMP settings were not saved."
            }
        }
    }

    private func settingsEdits() -> [JSONValue] {
        var edits: [JSONValue] = resets.sorted().compactMap { path in
            guard let setting = baseline[path], setting.isWritable else { return nil }
            return .object(["path": .string(path), "scope": .string(setting.scope), "reset": .bool(true)])
        }
        for (path, value) in drafts.sorted(by: { $0.key < $1.key })
        where baseline[path]?.value != value && !resets.contains(path) && baseline[path]?.isWritable == true {
            let scope = baseline[path]?.scope ?? "global"
            edits.append(.object(["path": .string(path), "scope": .string(scope), "value": settingJSON(value)]))
        }
        return edits
    }

    @MainActor
    private func decideSettingsConfirmation(_ item: T4AttentionItem, decision: String) async {
        do {
            try await sendT4ConfirmationDecision(controller: controller, item: item, decision: decision)
            controller.state.attention.removeAll { $0.id == item.id }
            announcement = decision == "approve" ? "Settings changes approved." : "Settings changes denied."
        } catch {
            errorMessage = T4Privacy.redacted(String(describing: error))
            announcement = "Confirmation failed."
        }
    }

    private func discardStagedChanges() {
        drafts.removeAll(keepingCapacity: true)
        resets.removeAll(keepingCapacity: true)
        revisionConflict = false
        announcement = "Staged changes discarded."
    }

    private var settingsAccessMessage: String? {
        guard let message = errorMessage?.lowercased() else { return nil }
        if message.contains("config.read") || message.contains("permission") || message.contains("capability") {
            return "Permission denied. This device needs config.read and catalog.read."
        }
        if message.contains("catalog") || message.contains("metadata") {
            return "The connected host did not publish settings metadata."
        }
        return nil
    }

    private var diagnosticsSection: some View {
        settingsGroup(title: "Diagnostics", detail: "Allowlisted and redacted before leaving this screen") {
            VStack(alignment: .leading, spacing: T4Spacing.sm) {
                diagnosticLine("Connection", controller.state.connection.rawValue)
                diagnosticLine("Authentication", controller.state.authentication.rawValue)
                diagnosticLine("Indexed sessions", "\(controller.state.sessions.count)")
                diagnosticLine("Attention items", "\(controller.state.attention.count)")
                if let lifecycleStatus {
                    diagnosticLine("Runtime service", lifecycleStatus.service.rawValue)
                    diagnosticLine("Runtime definition", lifecycleStatus.definition.rawValue)
                }
                Button {
                    copyDiagnostics()
                } label: {
                    Label("Copy redacted diagnostics", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .accessibilityHint("Copies connection and runtime status without transcripts, credentials, or setting values")
            }
        }
    }

    private func diagnosticLine(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: T4Spacing.sm) {
            Text(label)
                .font(T4Typography.body(.caption, weight: .medium))
            Spacer(minLength: T4Spacing.sm)
            Text(T4Privacy.redacted(value))
                .font(T4Typography.monospaced(.caption))
                .foregroundStyle(T4Color.secondaryText)
        }
        .accessibilityElement(children: .combine)
    }

    private func copyDiagnostics() {
        let payload: [String: Any] = [
            "kind": "t4-code.apple-diagnostics",
            "generatedAt": ISO8601DateFormatter().string(from: Date()),
            "connection": controller.state.connection.rawValue,
            "authentication": controller.state.authentication.rawValue,
            "hostConnected": controller.hostID != nil,
            "sessionCount": controller.state.sessions.count,
            "attentionCount": controller.state.attention.count,
            "publishedSettingKeys": baseline.keys.filter { !T4Privacy.isSecretKey($0) }.sorted(),
            "runtimeService": lifecycleStatus?.service.rawValue ?? "unknown",
            "runtimeDefinition": lifecycleStatus?.definition.rawValue ?? "unknown",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8)
        else {
            announcement = "Diagnostics could not be prepared."
            return
        }
#if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
#elseif os(iOS)
        UIPasteboard.general.string = text
#endif
        announcement = "Redacted diagnostics copied."
    }

    @MainActor
    private func inspectLifecycle() async {
        lifecycleStatus = await lifecycle.status()
        lifecycleError = nil
    }

    @MainActor
    private func runLifecycle(
        _ label: String,
        action: @MainActor () async throws -> RuntimeServiceStatus
    ) async {
        guard lifecycleOperation == nil else { return }
        lifecycleOperation = label
        lifecycleError = nil
        defer { lifecycleOperation = nil }
        do {
            lifecycleStatus = try await action()
            announcement = "Local OMP service updated."
        } catch {
            lifecycleError = T4Privacy.redacted(String(describing: error))
            announcement = "Local OMP service action failed."
        }
    }
}

private struct T4SettingGroup<Content: View>: View {
    let title: String
    let detail: String?
    let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: T4Spacing.sm) {
            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                Text(title)
                    .font(T4Typography.heading(.headline))
                if let detail {
                    Text(detail)
                        .font(T4Typography.body(.caption))
                        .foregroundStyle(T4Color.mutedText)
                }
            }
            content
        }
        .padding(T4Spacing.md)
        .background(T4Color.raised, in: RoundedRectangle(cornerRadius: T4Radius.lg))
        .overlay { RoundedRectangle(cornerRadius: T4Radius.lg).stroke(T4Color.border) }
    }
}

@MainActor
private func settingsGroup<Content: View>(
    title: String,
    detail: String?,
    @ViewBuilder content: () -> Content
) -> some View {
    T4SettingGroup(title: title, detail: detail, content: content())
}

private func pageHeading(title: String, detail: String) -> some View {
    VStack(alignment: .leading, spacing: T4Spacing.xs) {
        Text(title)
            .font(T4Typography.heading(.largeTitle, weight: .bold))
            .foregroundStyle(T4Color.foreground)
        Text(detail)
            .font(T4Typography.body(.subheadline))
            .foregroundStyle(T4Color.secondaryText)
    }
}

private func loadingState(_ label: String) -> some View {
    HStack(spacing: T4Spacing.sm) {
        ProgressView().controlSize(.small)
        Text(label)
            .font(T4Typography.body(.subheadline))
            .foregroundStyle(T4Color.secondaryText)
    }
    .padding(T4Spacing.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(label)
}

private func decodeSearchResults(_ result: [String: JSONValue]?) -> [T4SearchResult] {
    guard case let .array(items)? = result?["items"] else { return [] }
    return items.compactMap { value in
        guard case let .object(item) = value,
              let sessionID = item["sessionId"]?.stringValue,
              let anchorID = item["anchorId"]?.stringValue,
              let snippet = item["snippet"]?.stringValue
        else { return nil }
        return T4SearchResult(
            id: "\(sessionID):\(anchorID)",
            sessionID: sessionID,
            sessionTitle: item["sessionTitle"]?.stringValue ?? "",
            projectID: item["projectId"]?.stringValue ?? "",
            role: item["role"]?.stringValue ?? "assistant",
            timestamp: item["timestamp"]?.stringValue ?? "",
            snippet: snippet
        )
    }
}

private func decodeBrokerStatus(_ result: [String: JSONValue]?) -> T4BrokerStatus? {
    guard let state = result?["state"]?.stringValue else { return nil }
    return T4BrokerStatus(state: state, endpoint: result?["endpoint"]?.stringValue)
}

private func decodeUsage(_ result: [String: JSONValue]?) -> (reports: [T4UsageReport], accountCountWithoutUsage: Int) {
    guard let result else { return ([], 0) }
    let accountCount: Int
    if case let .array(accounts)? = result["accountsWithoutUsage"] { accountCount = accounts.count } else { accountCount = 0 }
    guard case let .array(rawReports)? = result["reports"] else { return ([], accountCount) }
    let reports = rawReports.enumerated().compactMap { index, raw -> T4UsageReport? in
        guard case let .object(report) = raw,
              let provider = report["provider"]?.stringValue
        else { return nil }
        let limits: [T4UsageLimit]
        if case let .array(rawLimits)? = report["limits"] {
            limits = rawLimits.compactMap(decodeUsageLimit)
        } else {
            limits = []
        }
        let plan: String?
        if case let .object(metadata)? = report["metadata"] {
            plan = metadata["plan"]?.stringValue ?? metadata["planType"]?.stringValue ?? metadata["currentTierName"]?.stringValue
        } else {
            plan = nil
        }
        return T4UsageReport(
            id: "\(provider):\(index)",
            provider: provider,
            plan: plan,
            fetchedAt: jsonNumber(report["fetchedAt"]),
            limits: limits
        )
    }
    return (reports, accountCount)
}

private func decodeUsageLimit(_ raw: JSONValue) -> T4UsageLimit? {
    guard case let .object(limit) = raw,
          let id = limit["id"]?.stringValue,
          let label = limit["label"]?.stringValue,
          case let .object(amount)? = limit["amount"]
    else { return nil }
    let resetLabel: String?
    if case let .object(window)? = limit["window"], let resets = jsonNumber(window["resetsAt"]) {
        resetLabel = "resets \(Date(timeIntervalSince1970: resets / 1_000).formatted(date: .abbreviated, time: .shortened))"
    } else {
        resetLabel = nil
    }
    return T4UsageLimit(
        id: id,
        label: label,
        status: limit["status"]?.stringValue ?? "unknown",
        used: jsonNumber(amount["used"]),
        limit: jsonNumber(amount["limit"]),
        remaining: jsonNumber(amount["remaining"]),
        usedFraction: jsonNumber(amount["usedFraction"]),
        unit: amount["unit"]?.stringValue ?? "unknown",
        resetLabel: resetLabel
    )
}

private func inferredFraction(_ limit: T4UsageLimit) -> Double {
    guard let used = limit.used, let maximum = limit.limit, maximum > 0 else { return 0 }
    return used / maximum
}

private func usageAmount(_ limit: T4UsageLimit) -> String {
    if let used = limit.used, let maximum = limit.limit {
        return "\(used.formatted()) of \(maximum.formatted()) \(limit.unit)"
    }
    if let remaining = limit.remaining { return "\(remaining.formatted()) \(limit.unit) remaining" }
    return "Amount not reported"
}

private func usageTone(_ status: String, fraction: Double) -> T4StatusTone {
    switch status {
    case "exhausted": .error
    case "warning": .warning
    case "ok": .success
    default: fraction >= 1 ? .error : fraction >= 0.8 ? .warning : .neutral
    }
}

private func usageStatusLabel(_ status: String) -> String {
    switch status {
    case "exhausted": "Exhausted"
    case "warning": "Running low"
    case "ok": "Available"
    default: "Unknown"
    }
}

private extension T4StatusTone {
    var colorForUsage: Color {
        switch self {
        case .success, .done: T4Color.success
        case .warning, .approval: T4Color.warning
        case .error: T4Color.destructive
        case .working: T4Color.info
        case .input: T4Color.statusInput
        case .plan: T4Color.statusPlan
        case .neutral: T4Color.mutedText
        }
    }
}

private func jsonNumber(_ value: JSONValue?) -> Double? {
    guard case let .number(number)? = value else { return nil }
    return number
}

private func decodeSettingCatalog(_ result: [String: JSONValue]?) -> [String: T4SettingMetadata] {
    guard case let .array(items)? = result?["items"] else { return [:] }
    var catalog: [String: T4SettingMetadata] = [:]
    for itemValue in items {
        guard case let .object(item) = itemValue,
              item["kind"]?.stringValue == "setting",
              case let .object(metadata)? = item["metadata"]
        else { continue }
        let path = metadata["path"]?.stringValue ?? item["name"]?.stringValue ?? item["id"]?.stringValue
        guard let path, !path.isEmpty, !path.hasPrefix("/"), !path.hasPrefix("~") else { continue }
        let tab = metadata["tab"]?.stringValue
        let subgroup = metadata["group"]?.stringValue
        let group = [tab, subgroup].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        let sensitive = (jsonBool(metadata["sensitive"]) ?? false)
            || metadata["controlType"]?.stringValue == "secret"
            || T4Privacy.isSecretKey(path)
        let available = (jsonBool(item["supported"]) ?? true) && (jsonBool(metadata["availability"]) ?? true)
        let inlineEditable = ["boolean", "number", "string", "enum"].contains(
            metadata["controlType"]?.stringValue ?? ""
        )
        let readOnly = jsonBool(metadata["readOnly"]) ?? false
        let scopes: [String]
        if readOnly || sensitive || !available || !inlineEditable {
            scopes = []
        } else if case let .array(rawScopes)? = metadata["scopes"] {
            scopes = rawScopes.compactMap(\.stringValue).filter { $0 == "global" || $0 == "session" }
        } else {
            scopes = ["global"]
        }
        catalog[path] = T4SettingMetadata(
            path: path,
            group: group.isEmpty ? "General" : group,
            label: metadata["label"]?.stringValue,
            help: metadata["description"]?.stringValue,
            sensitive: sensitive,
            configured: jsonBool(metadata["configured"]) ?? false,
            restartRequired: jsonBool(metadata["restartRequired"]) ?? false,
            available: available,
            writableScopes: scopes
        )
    }
    return catalog
}

private func decodeSettings(
    _ result: [String: JSONValue]?,
    catalog: [String: T4SettingMetadata]
) -> (revision: String?, values: [String: T4SettingValue]) {
    let revision = result?["revision"]?.stringValue
    let settings: [String: JSONValue]
    let responseValid: Bool
    if case let .object(rawSettings)? = result?["settings"], revision?.isEmpty == false {
        settings = rawSettings
        responseValid = true
    } else {
        settings = [:]
        responseValid = false
    }
    var values: [String: T4SettingValue] = [:]
    for path in Set(settings.keys).union(catalog.keys).sorted() {
        let raw = settings[path]
        let published = catalog[path]
        let sensitiveByName = T4Privacy.isSecretKey(path)
        let valueMetadata = raw?.objectValue
        let malformedValue = raw != nil && valueMetadata == nil
        let sensitive = (jsonBool(valueMetadata?["sensitive"]) ?? false)
            || (published?.sensitive ?? false)
            || sensitiveByName
        let configured = jsonBool(valueMetadata?["configured"]) ?? published?.configured ?? false
        let structuredValue: Bool
        if let effective = valueMetadata?["effective"] {
            switch effective {
            case .array, .object: structuredValue = true
            case .null, .bool, .number, .string: structuredValue = false
            }
        } else {
            structuredValue = false
        }
        let available = responseValid
            && !malformedValue
            && (jsonBool(valueMetadata?["availability"]) ?? published?.available ?? false)
        let displayValue: String
        if sensitive {
            displayValue = configured ? "configured" : ""
        } else if let effective = valueMetadata?["effective"], !structuredValue {
            displayValue = displaySettingValue(effective)
        } else {
            displayValue = ""
        }
        values[path] = T4SettingValue(
            value: displayValue,
            sensitive: sensitive,
            writableScopes: available && !structuredValue ? (published?.writableScopes ?? []) : [],
            restartRequired: published?.restartRequired ?? false,
            available: available,
            group: published?.group ?? "Other",
            label: published?.label,
            help: published?.help
        )
    }
    return (revision, values)
}

private func jsonBool(_ value: JSONValue?) -> Bool? {
    guard case let .bool(boolean)? = value else { return nil }
    return boolean
}

private func displaySettingValue(_ value: JSONValue) -> String {
    switch value {
    case let .string(text): text
    case let .bool(boolean): boolean ? "true" : "false"
    case let .number(number): number.formatted()
    case .null: ""
    case .array, .object: "Structured value"
    }
}

private func settingJSON(_ value: String) -> JSONValue {
    if value == "true" { return .bool(true) }
    if value == "false" { return .bool(false) }
    if let number = Double(value) { return .number(number) }
    return .string(value)
}

private func settingLabel(_ path: String) -> String {
    let leaf = path.split(separator: ".").last.map(String.init) ?? path
    return leaf
        .replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
        .replacingOccurrences(of: "-", with: " ")
        .capitalized
}

private func lifecycleLabel(_ status: RuntimeServiceStatus) -> String {
    switch status.service {
    case .running: "Running"
    case .starting: "Starting"
    case .stopped: "Stopped"
    case .failed: "Failed"
    case .unknown: "Unknown"
    }
}
