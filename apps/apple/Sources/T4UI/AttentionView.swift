import SwiftUI
import T4Client
import T4Protocol

/// Sends the protocol-level response used by destructive confirmation
/// challenges. A confirmation is a distinct omp-app frame, not a command.
@MainActor
func sendT4ConfirmationDecision(
    controller: T4ClientController,
    item: T4AttentionItem,
    decision: String
) async throws {
    guard decision == "approve" || decision == "deny",
          let hostID = controller.hostID,
          let commandID = item.commandID
    else {
        throw T4ClientControllerError.disconnected
    }

    let data = try WireEncoder.confirm(
        requestId: UUID().uuidString.lowercased(),
        confirmationId: item.id,
        commandId: commandID,
        hostId: hostID,
        decision: decision,
        sessionId: controller.state.selectedSessionID
    )
    try await controller.transport.send(try WireDecoder.decode(data))
}

@MainActor
public struct AttentionView: View {
    private let controller: T4ClientController
    @State private var pendingItemIDs: Set<String> = []
    @State private var answers: [String: String] = [:]
    @State private var itemErrors: [String: String] = [:]
    @State private var announcement = ""

    public init(controller: T4ClientController) {
        self.controller = controller
    }

    public var body: some View {
        GeometryReader { geometry in
            let isWide = geometry.size.width >= T4Layout.wideBreakpoint
            ScrollView {
                HStack(alignment: .top, spacing: T4Spacing.xl) {
                    if isWide {
                        summary
                            .frame(width: T4Layout.settingsRailWidth, alignment: .leading)
                    }
                    inbox
                        .frame(maxWidth: T4Layout.readableMeasure, alignment: .leading)
                }
                .frame(maxWidth: .infinity, alignment: .top)
                .padding(isWide ? T4Spacing.xl : T4Spacing.md)
            }
            .background(T4Color.background)
        }
        .navigationTitle("Attention")
        .accessibilityElement(children: .contain)
        .overlay(alignment: .topLeading) {
            Text(announcement)
                .frame(width: 1, height: 1)
                .opacity(0.001)
                .accessibilityHidden(announcement.isEmpty)
        }
    }

    private var items: [T4AttentionItem] { controller.state.attention }

    private var blockingItems: [T4AttentionItem] {
        items.filter { ["approval", "confirmation", "input", "plan", "question"].contains($0.kind.lowercased()) }
    }

    private var problemItems: [T4AttentionItem] {
        items.filter { ["cancelled", "error", "failed"].contains($0.kind.lowercased()) }
    }

    private var backgroundItems: [T4AttentionItem] {
        items.filter { item in
            !blockingItems.contains(where: { $0.id == item.id }) &&
                !problemItems.contains(where: { $0.id == item.id })
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: T4Spacing.lg) {
            VStack(alignment: .leading, spacing: T4Spacing.xs) {
                Text("Attention inbox")
                    .font(T4Typography.heading(.title2))
                    .foregroundStyle(T4Color.foreground)
                Text("Decisions and updates from the active OMP host, ordered by what needs you first.")
                    .font(T4Typography.body(.subheadline))
                    .foregroundStyle(T4Color.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: T4Spacing.sm) {
                summaryRow("Needs you", count: blockingItems.count, tone: .approval)
                summaryRow("Problems", count: problemItems.count, tone: .error)
                summaryRow("Background", count: backgroundItems.count, tone: .working)
            }

            connectionStatus
        }
    }

    private func summaryRow(_ label: String, count: Int, tone: T4StatusTone) -> some View {
        HStack(spacing: T4Spacing.xs) {
            T4StatusPill("\(count)", tone: tone)
            Text(label)
                .font(T4Typography.body(.subheadline, weight: .medium))
                .foregroundStyle(T4Color.secondaryText)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(count) \(label)")
    }

    @ViewBuilder
    private var connectionStatus: some View {
        switch controller.state.connection {
        case .connected:
            T4StatusPill("Live", tone: .success)
        case .connecting, .reconnecting:
            T4StatusPill("Updating", tone: .working, isPulsing: true)
        case .disconnected:
            T4StatusPill("Offline", tone: .neutral)
        case .failed:
            T4StatusPill("Connection failed", tone: .error)
        }
    }

    @ViewBuilder
    private var inbox: some View {
        VStack(alignment: .leading, spacing: T4Spacing.lg) {
            if !isWideHeaderSuppressed {
                VStack(alignment: .leading, spacing: T4Spacing.xs) {
                    HStack(alignment: .firstTextBaseline, spacing: T4Spacing.xs) {
                        Text("Attention inbox")
                            .font(T4Typography.heading(.title2))
                        Spacer(minLength: T4Spacing.sm)
                        connectionStatus
                    }
                    Text("Decisions and updates from the active OMP host.")
                        .font(T4Typography.body(.subheadline))
                        .foregroundStyle(T4Color.secondaryText)
                }
            }

            if let errorMessage = controller.state.errorMessage {
                T4ErrorState(
                    title: "Host update failed",
                    message: T4Privacy.redacted(errorMessage),
                    retry: { Task { await controller.connect() } }
                )
            }

            if items.isEmpty {
                emptyOrLoading
            } else {
                if !blockingItems.isEmpty {
                    section(
                        title: "Needs you",
                        detail: "Work paused for a decision or answer",
                        items: blockingItems
                    )
                }
                if !problemItems.isEmpty {
                    section(
                        title: "Problems",
                        detail: "Failed or cancelled work ready to review",
                        items: problemItems
                    )
                }
                if !backgroundItems.isEmpty {
                    section(
                        title: "Background",
                        detail: "Recent plan and agent status",
                        items: backgroundItems
                    )
                }
            }
        }
    }

    /// The width decision is made by the parent GeometryReader. A compact
    /// header remains useful at all sizes and the wide summary adds detail;
    /// duplicate visible copy is avoided with this environment-independent
    /// check supplied by the layout itself.
    private var isWideHeaderSuppressed: Bool { false }

    @ViewBuilder
    private var emptyOrLoading: some View {
        switch controller.state.connection {
        case .connecting, .reconnecting:
            VStack(alignment: .leading, spacing: T4Spacing.sm) {
                ProgressView()
                    .controlSize(.small)
                Text("Checking for decisions and updates…")
                    .font(T4Typography.body(.subheadline))
                    .foregroundStyle(T4Color.secondaryText)
            }
            .padding(T4Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Loading attention inbox")
        case .failed:
            T4EmptyState(
                icon: "bolt.horizontal.circle",
                title: "The inbox could not update",
                message: "Reconnect to OMP to check whether any work needs your attention.",
                actionTitle: "Reconnect",
                action: { Task { await controller.connect() } }
            )
        case .connected:
            T4EmptyState(
                icon: "checkmark.circle",
                title: "Nothing needs you",
                message: "OMP will place approvals, questions, plans, errors, and background updates here."
            )
        case .disconnected:
            T4EmptyState(
                icon: "network.slash",
                title: "Inbox is offline",
                message: "Connect to an OMP host to load current decisions and status.",
                actionTitle: "Connect",
                action: { Task { await controller.connect() } }
            )
        }
    }

    private func section(title: String, detail: String, items: [T4AttentionItem]) -> some View {
        VStack(alignment: .leading, spacing: T4Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: T4Spacing.xs) {
                Text(title)
                    .font(T4Typography.heading(.headline))
                Text("\(items.count)")
                    .font(T4Typography.monospaced(.caption))
                    .foregroundStyle(T4Color.mutedText)
                Spacer(minLength: T4Spacing.sm)
                Text(detail)
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.mutedText)
                    .lineLimit(1)
            }

            LazyVStack(spacing: T4Spacing.xs) {
                ForEach(items) { item in
                    itemRow(item)
                }
            }
        }
    }

    private func itemRow(_ item: T4AttentionItem) -> some View {
        let pending = pendingItemIDs.contains(item.id)
        let kind = item.kind.lowercased()
        return VStack(alignment: .leading, spacing: T4Spacing.sm) {
            HStack(alignment: .top, spacing: T4Spacing.sm) {
                Image(systemName: icon(for: kind))
                    .foregroundStyle(tone(for: kind).colorForAttention)
                    .frame(width: T4Spacing.lg)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                    HStack(alignment: .firstTextBaseline, spacing: T4Spacing.xs) {
                        Text(item.title)
                            .font(T4Typography.heading(.subheadline))
                            .foregroundStyle(T4Color.foreground)
                        Spacer(minLength: T4Spacing.sm)
                        T4StatusPill(statusLabel(for: kind), tone: tone(for: kind), isPulsing: pending)
                    }
                    if !item.detail.isEmpty {
                        Text(T4Privacy.redacted(item.detail))
                            .font(T4Typography.body(.subheadline))
                            .foregroundStyle(T4Color.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            actionControls(for: item, kind: kind, pending: pending)

            if let error = itemErrors[item.id] {
                T4ErrorState(title: "Action not sent", message: error)
            }
        }
        .padding(T4Spacing.md)
        .background(T4Color.raised, in: RoundedRectangle(cornerRadius: T4Radius.lg))
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.lg)
                .stroke(T4Color.border)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func actionControls(for item: T4AttentionItem, kind: String, pending: Bool) -> some View {
        let connected = controller.state.connection == .connected
        switch kind {
        case "approval", "confirmation", "plan":
            HStack(spacing: T4Spacing.xs) {
                Button(kind == "plan" ? "Approve plan" : "Approve") {
                    Task { await resolve(item, decision: "approve") }
                }
                .buttonStyle(.borderedProminent)
                .tint(T4Color.accent)
                Button(kind == "plan" ? "Deny plan" : "Deny") {
                    Task { await resolve(item, decision: "deny") }
                }
                .buttonStyle(.bordered)
                .tint(T4Color.destructive)
            }
            .disabled(pending || !connected || (kind != "confirmation" && sessionRevision == nil))
        case "input", "question":
            HStack(alignment: .center, spacing: T4Spacing.xs) {
                TextField("Answer", text: answerBinding(for: item.id))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Answer \(item.title)")
                    .onSubmit { Task { await answer(item) } }
                Button("Answer") {
                    Task { await answer(item) }
                }
                .buttonStyle(.borderedProminent)
                .tint(T4Color.accent)
                .disabled(answerText(for: item.id).isEmpty || pending || !connected || sessionRevision == nil)
            }
        case "error", "failed":
            if sessionRevision != nil {
                Button("Retry") {
                    Task { await retry(item) }
                }
                .buttonStyle(.bordered)
                .tint(T4Color.accent)
                .disabled(pending || !connected)
            } else {
                Text("Open or refresh the session before retrying this turn.")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.mutedText)
            }
        default:
            EmptyView()
        }

        if !connected && ["approval", "confirmation", "input", "plan", "question"].contains(kind) {
            Text("Reconnect before responding. This item stays pending.")
                .font(T4Typography.body(.caption))
                .foregroundStyle(T4Color.warning)
        }
    }

    private var sessionRevision: String? {
        controller.state.transcript.reversed().compactMap(\.revision).first
    }

    private func answerBinding(for itemID: String) -> Binding<String> {
        Binding(
            get: { answers[itemID, default: ""] },
            set: { answers[itemID] = $0 }
        )
    }

    private func answerText(for itemID: String) -> String {
        answers[itemID, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @MainActor
    private func answer(_ item: T4AttentionItem) async {
        let answer = answerText(for: item.id)
        guard !answer.isEmpty else { return }
        await perform(item, success: "Answer sent") {
            guard let revision = sessionRevision else { throw T4ClientControllerError.staleGeneration }
            _ = try await controller.command(
                "session.ui.respond",
                sessionID: controller.state.selectedSessionID,
                expectedRevision: revision,
                args: ["requestId": .string(item.id), "value": .string(answer)]
            )
        }
    }

    @MainActor
    private func resolve(_ item: T4AttentionItem, decision: String) async {
        await perform(item, success: decision == "approve" ? "Approved" : "Denied") {
            if item.kind.lowercased() == "confirmation" {
                try await sendT4ConfirmationDecision(controller: controller, item: item, decision: decision)
                return
            }
            guard let revision = sessionRevision else { throw T4ClientControllerError.staleGeneration }
            _ = try await controller.command(
                "session.ui.respond",
                sessionID: controller.state.selectedSessionID,
                expectedRevision: revision,
                args: [
                    "requestId": .string(item.id),
                    "confirmed": .bool(decision == "approve"),
                ]
            )
        }
    }

    @MainActor
    private func retry(_ item: T4AttentionItem) async {
        await perform(item, success: "Retry started") {
            guard let revision = sessionRevision else { throw T4ClientControllerError.staleGeneration }
            _ = try await controller.command(
                "session.retry",
                sessionID: controller.state.selectedSessionID,
                expectedRevision: revision
            )
        }
    }

    @MainActor
    private func perform(
        _ item: T4AttentionItem,
        success: String,
        operation: @MainActor () async throws -> Void
    ) async {
        guard !pendingItemIDs.contains(item.id) else { return }
        pendingItemIDs.insert(item.id)
        itemErrors[item.id] = nil
        defer { pendingItemIDs.remove(item.id) }
        do {
            try await operation()
            controller.state.attention.removeAll { $0.id == item.id }
            answers[item.id] = nil
            announcement = "\(success): \(item.title)"
        } catch {
            let message = T4Privacy.redacted(String(describing: error))
            itemErrors[item.id] = message
            announcement = "Action failed: \(message)"
        }
    }

    private func tone(for kind: String) -> T4StatusTone {
        switch kind {
        case "approval", "confirmation": .approval
        case "input", "question": .input
        case "plan": .plan
        case "error", "failed": .error
        case "completed", "done": .success
        case "cancelled": .warning
        case "background", "working": .working
        default: .neutral
        }
    }

    private func statusLabel(for kind: String) -> String {
        switch kind {
        case "approval": "Approval"
        case "confirmation": "Confirm"
        case "input", "question": "Question"
        case "plan": "Plan"
        case "error", "failed": "Failed"
        case "completed", "done": "Done"
        case "cancelled": "Cancelled"
        case "background", "working": "Working"
        default: kind.isEmpty ? "Update" : kind.capitalized
        }
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "approval", "confirmation": "checkmark.shield"
        case "input", "question": "questionmark.bubble"
        case "plan": "list.bullet.clipboard"
        case "error", "failed": "exclamationmark.triangle"
        case "completed", "done": "checkmark.circle"
        case "cancelled": "xmark.circle"
        default: "waveform.path.ecg"
        }
    }
}

private extension T4StatusTone {
    var colorForAttention: Color {
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
}
