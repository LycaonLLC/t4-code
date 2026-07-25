import SwiftUI
import T4Client
import T4Protocol

@MainActor
public struct SessionNavigationView: View {
    private let controller: T4ClientController

    private let onSelect: (String) -> Void

    @State private var query = ""
    @State private var listMode: SessionListMode = .current
    @State private var pendingSessionIDs: Set<String> = []
    @State private var isCreating = false
    @State private var editor: SessionEditor?
    @State private var pendingConfirmation: SessionConfirmation?
    @State private var deleteCandidate: T4Session?
    @State private var actionError: String?

    public init(
        controller: T4ClientController,
        onSelect: @escaping (String) -> Void = { _ in }
    ) {
        self.controller = controller
        self.onSelect = onSelect
    }

    public var body: some View {
        let state = controller.state
        let visibleSessions = filteredSessions(state.sessions)
        let groups = groupedSessions(visibleSessions)

        VStack(spacing: T4Spacing.sm) {
            navigationHeader(state: state)

            TextField("Search sessions", text: $query)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel("Search sessions")
                .padding(.horizontal, T4Spacing.md)

            Picker("Session list", selection: $listMode) {
                ForEach(SessionListMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Current or archived sessions")
            .padding(.horizontal, T4Spacing.md)

            if groups.isEmpty {
                T4EmptyState(
                    title: emptyTitle(state: state),
                    message: emptyMessage(state: state),
                    systemImage: emptySystemImage(state: state)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: T4Spacing.md, pinnedViews: [.sectionHeaders]) {
                        ForEach(groups) { group in
                            Section {
                                ForEach(group.sessions) { session in
                                    sessionRow(session, state: state)
                                }
                            } header: {
                                HStack(spacing: T4Spacing.xs) {
                                    Image(systemName: "folder")
                                    Text(group.title)
                                        .lineLimit(1)
                                    Spacer(minLength: T4Spacing.xs)
                                    Text("\(group.sessions.count)")
                                        .foregroundStyle(T4Color.mutedText)
                                }
                                .font(T4Typography.body(.caption, weight: .semibold))
                                .foregroundStyle(T4Color.secondaryText)
                                .padding(.horizontal, T4Spacing.md)
                                .padding(.vertical, T4Spacing.xs)
                                .background(T4Color.background)
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                    .padding(.bottom, T4Spacing.lg)
                }
                .accessibilityLabel("Sessions grouped by host project scope")
            }

            capabilityNotice
        }
        .background(T4Color.background)
        .sheet(item: $editor) { editor in
            SessionEditorSheet(
                editor: editor,
                isPending: editor.session.map { pendingSessionIDs.contains($0.id) } ?? isCreating,
                onCancel: { self.editor = nil },
                onCommit: { projectID, title in
                    self.editor = nil
                    Task { @MainActor in
                        switch editor {
                        case .create:
                            await createSession(projectID: projectID, title: title)
                        case let .rename(session):
                            await renameSession(session, title: title)
                        }
                    }
                }
            )
        }
        .sheet(item: $deleteCandidate) { session in
            DeleteSessionSheet(
                session: session,
                isPending: pendingSessionIDs.contains(session.id),
                onCancel: { deleteCandidate = nil },
                onDelete: {
                    deleteCandidate = nil
                    Task { @MainActor in
                        await runRevisionedCommand(.delete, session: session)
                    }
                }
            )
        }
        .confirmationDialog(
            pendingConfirmation?.title ?? "Confirm session action",
            isPresented: confirmationIsPresented,
            titleVisibility: .visible
        ) {
            if let confirmation = pendingConfirmation {
                Button(confirmation.actionLabel, role: confirmation.role) {
                    pendingConfirmation = nil
                    Task { @MainActor in
                        await runRevisionedCommand(confirmation.action, session: confirmation.session)
                    }
                }
                Button("Cancel", role: .cancel) {
                    pendingConfirmation = nil
                }
            }
        } message: {
            if let confirmation = pendingConfirmation {
                Text(confirmation.message)
            }
        }
        .alert("Session action failed", isPresented: actionErrorIsPresented) {
            Button("OK") { actionError = nil }
        } message: {
            Text(actionError ?? "The host rejected the request.")
        }
    }

    private func navigationHeader(state: AppState) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: T4Spacing.sm) {
            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                Text("Sessions")
                    .font(T4Typography.heading(.title2))
                    .foregroundStyle(T4Color.foreground)

                Text(connectionLabel(state.connection))
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(state.connection == .connected ? T4Color.success : T4Color.secondaryText)
            }

            Spacer(minLength: T4Spacing.sm)

            Button {
                editor = .create
            } label: {
                Label("New session", systemImage: "plus")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.borderless)
            .disabled(createDisabledReason(state: state) != nil)
            .help(createDisabledReason(state: state) ?? "Create a session")
            .accessibilityLabel("Create session")
            .accessibilityHint(createDisabledReason(state: state) ?? "Opens the new session form")
        }
        .padding(.horizontal, T4Spacing.md)
        .padding(.top, T4Spacing.md)
    }

    @ViewBuilder
    private func sessionRow(_ session: T4Session, state: AppState) -> some View {
        let selected = session.id == state.selectedSessionID
        let pending = pendingSessionIDs.contains(session.id)
        let title = displayTitle(session)

        HStack(spacing: T4Spacing.sm) {
            Button {
                guard !pending else { return }
                pendingSessionIDs.insert(session.id)
                Task { @MainActor in
                    await controller.selectSession(session.id)
                    pendingSessionIDs.remove(session.id)
                    onSelect(session.id)
                }
            } label: {
                HStack(spacing: T4Spacing.sm) {
                    VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                        Text(title)
                            .font(T4Typography.body(.body, weight: selected ? .semibold : .regular))
                            .foregroundStyle(T4Color.foreground)
                            .lineLimit(1)

                        HStack(spacing: T4Spacing.xs) {
                            T4StatusPill(
                                text: session.status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Idle" : session.status,
                                tone: statusTone(session.status)
                            )
                            if let updatedAt = session.updatedAt {
                                Text(updatedAt, style: .relative)
                                    .font(T4Typography.body(.caption2))
                                    .foregroundStyle(T4Color.mutedText)
                            }
                        }
                    }

                    Spacer(minLength: T4Spacing.xs)

                    if pending {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel("Selecting \(title)")
                    } else if selected {
                        Image(systemName: "checkmark")
                            .foregroundStyle(T4Color.accent)
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
                .padding(.vertical, T4Spacing.sm)
                .padding(.leading, T4Spacing.md)
            }
            .buttonStyle(.plain)
            .disabled(pending)
            .accessibilityLabel("\(title), \(session.status.isEmpty ? "idle" : session.status)")
            .accessibilityValue(selected ? "Selected" : "Not selected")
            .accessibilityHint("Selects this session")

            sessionActions(session, state: state)
                .padding(.trailing, T4Spacing.sm)
        }
        .background(selected ? T4Color.accentSoft : T4Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
                .stroke(selected ? T4Color.accent : T4Color.border)
        }
        .padding(.horizontal, T4Spacing.sm)
    }

    private func sessionActions(_ session: T4Session, state: AppState) -> some View {
        let disabledReason = managementDisabledReason(session: session, state: state)
        let archived = isArchived(session)
        let working = isWorking(session.status)

        return Menu {
            if !archived {
                Button("Rename") { editor = .rename(session) }
                    .disabled(disabledReason != nil)

                Button("Terminate runtime", role: .destructive) {
                    pendingConfirmation = SessionConfirmation(action: .terminate, session: session)
                }
                .disabled(disabledReason != nil || session.status.lowercased().contains("closed"))

                Button("Archive", role: .destructive) {
                    pendingConfirmation = SessionConfirmation(action: .archive, session: session)
                }
                .disabled(disabledReason != nil || working)
            } else {
                Button("Restore") {
                    pendingConfirmation = SessionConfirmation(action: .restore, session: session)
                }
                .disabled(disabledReason != nil)
            }

            Divider()

            Button("Delete permanently", role: .destructive) {
                deleteCandidate = session
            }
            .disabled(disabledReason != nil || working)
        } label: {
            Image(systemName: "ellipsis")
                .frame(minWidth: T4Spacing.xl, minHeight: T4Spacing.xl)
                .contentShape(Rectangle())
        }
        .help(disabledReason ?? "Session actions")
        .accessibilityLabel("Actions for \(displayTitle(session))")
        .accessibilityHint(disabledReason ?? "Rename or manage this session")
    }

    @ViewBuilder
    private var capabilityNotice: some View {
        if controller.state.connection == .connected,
           !SessionCapabilities.allows("sessions.manage", state: controller.state) {
            HStack(alignment: .top, spacing: T4Spacing.xs) {
                Image(systemName: "lock")
                    .accessibilityHidden(true)
                Text("The paired host did not grant sessions.manage access. Selection remains available; create and management actions are disabled.")
                    .font(T4Typography.body(.caption))
            }
            .foregroundStyle(T4Color.secondaryText)
            .padding(.horizontal, T4Spacing.md)
            .padding(.bottom, T4Spacing.md)
            .accessibilityElement(children: .combine)
        }
    }

    private var confirmationIsPresented: Binding<Bool> {
        Binding(
            get: { pendingConfirmation != nil },
            set: { if !$0 { pendingConfirmation = nil } }
        )
    }

    private var actionErrorIsPresented: Binding<Bool> {
        Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )
    }

    private func filteredSessions(_ sessions: [T4Session]) -> [T4Session] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return sessions
            .filter { session in
                isArchived(session) == (listMode == .archived)
                    && (normalizedQuery.isEmpty
                        || session.title.lowercased().contains(normalizedQuery)
                        || session.hostID.lowercased().contains(normalizedQuery)
                        || session.status.lowercased().contains(normalizedQuery))
            }
            .sorted { lhs, rhs in
                switch (lhs.updatedAt, rhs.updatedAt) {
                case let (left?, right?) where left != right:
                    return left > right
                default:
                    return displayTitle(lhs).localizedCaseInsensitiveCompare(displayTitle(rhs)) == .orderedAscending
                }
            }
    }

    private func groupedSessions(_ sessions: [T4Session]) -> [SessionGroup] {
        Dictionary(grouping: sessions, by: \.hostID)
            .map { hostID, sessions in
                SessionGroup(id: hostID, title: hostID.isEmpty ? "Local project scope" : hostID, sessions: sessions)
            }
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    private func createDisabledReason(state: AppState) -> String? {
        guard state.connection == .connected else { return "Connect before creating a session." }
        guard SessionCapabilities.allows("sessions.manage", state: state) else {
            return "The paired host did not grant sessions.manage access."
        }
        guard !isCreating && pendingSessionIDs.isEmpty else { return "Wait for the current session action to finish." }
        return nil
    }

    private func managementDisabledReason(session: T4Session, state: AppState) -> String? {
        guard state.connection == .connected else { return "Connect before managing this session." }
        guard SessionCapabilities.allows("sessions.manage", state: state) else {
            return "The paired host did not grant sessions.manage access."
        }
        guard !isCreating && pendingSessionIDs.isEmpty else { return "Wait for the current session action to finish." }
        guard revision(for: session, state: state) != nil else {
            return "Select the session and wait for a revision before changing it."
        }
        return nil
    }

    private func revision(for session: T4Session, state: AppState) -> String? {
        SessionRuntime.revision(for: session.id, state: state)
    }

    private func createSession(projectID: String, title: String) async {
        let project = projectID.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !project.isEmpty else {
            actionError = "Enter a project identifier."
            return
        }
        guard createDisabledReason(state: controller.state) == nil else {
            actionError = createDisabledReason(state: controller.state)
            return
        }

        isCreating = true
        defer { isCreating = false }
        do {
            var arguments: [String: JSONValue] = ["projectId": .string(project)]
            if !normalizedTitle.isEmpty {
                arguments["title"] = .string(normalizedTitle)
            }
            let response = try await controller.command(
                "session.create",
                sessionID: nil,
                args: arguments
            )
            guard
                let created = response.result?["session"]?.objectValue,
                let id = (created["sessionId"] ?? created["id"])?.stringValue,
                !id.isEmpty
            else {
                actionError = "The host returned an invalid session.create response."
                return
            }

            let hostID = created["hostId"]?.stringValue ?? response.hostID
            let createdSession = T4Session(
                id: id,
                hostID: hostID,
                title: created["title"]?.stringValue ?? normalizedTitle,
                status: created["status"]?.stringValue ?? "idle"
            )
            if let index = controller.state.sessions.firstIndex(where: { $0.id == id }) {
                controller.state.sessions[index] = createdSession
            } else {
                controller.state.sessions.append(createdSession)
            }
            await controller.selectSession(id)
            onSelect(id)
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func renameSession(_ session: T4Session, title: String) async {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            actionError = "Enter a session title."
            return
        }
        await runRevisionedCommand(.rename(normalized), session: session)
    }

    private func runRevisionedCommand(_ action: RevisionedSessionAction, session: T4Session) async {
        guard managementDisabledReason(session: session, state: controller.state) == nil else {
            actionError = managementDisabledReason(session: session, state: controller.state)
            return
        }
        guard let revision = revision(for: session, state: controller.state) else {
            actionError = "The session revision is not available. Select the session and wait for it to finish loading."
            return
        }
        guard !pendingSessionIDs.contains(session.id) else { return }

        pendingSessionIDs.insert(session.id)
        defer { pendingSessionIDs.remove(session.id) }

        do {
            _ = try await controller.command(
                action.command,
                sessionID: session.id,
                expectedRevision: revision,
                args: action.arguments
            )
            await applySuccessful(action, to: session)
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func applySuccessful(_ action: RevisionedSessionAction, to session: T4Session) async {
        guard let index = controller.state.sessions.firstIndex(where: { $0.id == session.id }) else { return }
        switch action {
        case let .rename(title):
            controller.state.sessions[index].title = title
        case .terminate:
            controller.state.sessions[index].status = "closed"
        case .archive:
            controller.state.sessions[index].status = "archived"
            if controller.state.selectedSessionID == session.id {
                let replacement = controller.state.sessions.first { !isArchived($0) && $0.id != session.id }
                await controller.selectSession(replacement?.id)
                if let replacement { onSelect(replacement.id) }
            }
        case .restore:
            controller.state.sessions[index].status = "idle"
        case .delete:
            controller.state.sessions.remove(at: index)
            if controller.state.selectedSessionID == session.id {
                let replacement = controller.state.sessions.first { !isArchived($0) }
                await controller.selectSession(replacement?.id)
                if let replacement { onSelect(replacement.id) }
            }
        }
    }

    private func emptyTitle(state: AppState) -> String {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "No matching sessions" }
        if state.connection != .connected { return "Connect to load sessions" }
        return listMode == .archived ? "No archived sessions" : "No current sessions"
    }

    private func emptyMessage(state: AppState) -> String {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Try a session title, status, or host identifier."
        }
        if state.connection != .connected {
            return "Your session list will appear after the host is connected."
        }
        return listMode == .archived
            ? "Archived sessions will appear here and can be restored when management capabilities are available."
            : "Create a session from a project when management capabilities and project metadata are available."
    }

    private func emptySystemImage(state: AppState) -> String {
        state.connection == .connected ? "rectangle.stack" : "network.slash"
    }

    private func displayTitle(_ session: T4Session) -> String {
        let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? "Untitled session" : title
    }

    private func isArchived(_ session: T4Session) -> Bool {
        session.status.localizedCaseInsensitiveContains("archiv")
    }

    private func isWorking(_ status: String) -> Bool {
        SessionRuntime.isActive(status)
    }

    private func connectionLabel(_ connection: T4ConnectionState) -> String {
        switch connection {
        case .connected: "Connected"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .failed: "Connection failed"
        case .disconnected: "Disconnected"
        }
    }

    private func statusTone(_ status: String) -> T4StatusTone {
        let normalized = status.lowercased()
        if normalized.contains("error") || normalized.contains("failed") { return .error }
        if normalized.contains("working") || normalized.contains("running") || normalized.contains("stream") { return .working }
        if normalized.contains("approval") { return .approval }
        if normalized.contains("input") || normalized.contains("question") { return .input }
        if normalized.contains("done") || normalized.contains("complete") { return .done }
        return .neutral
    }
}

private enum SessionListMode: String, CaseIterable, Identifiable {
    case current
    case archived

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

private struct SessionGroup: Identifiable {
    let id: String
    let title: String
    let sessions: [T4Session]
}

private enum SessionEditor: Identifiable {
    case create
    case rename(T4Session)

    var id: String {
        switch self {
        case .create: "create"
        case let .rename(session): "rename-\(session.id)"
        }
    }

    var session: T4Session? {
        if case let .rename(session) = self { return session }
        return nil
    }
}

private enum RevisionedSessionAction {
    case rename(String)
    case terminate
    case archive
    case restore
    case delete

    var command: String {
        switch self {
        case .rename: "session.rename"
        case .terminate: "session.close"
        case .archive: "session.archive"
        case .restore: "session.restore"
        case .delete: "session.delete"
        }
    }

    var arguments: [String: JSONValue] {
        if case let .rename(title) = self { return ["name": .string(title)] }
        return [:]
    }
}

private struct SessionConfirmation {
    let action: RevisionedSessionAction
    let session: T4Session

    var title: String {
        switch action {
        case .terminate: "Terminate runtime?"
        case .archive: "Archive session?"
        case .restore: "Restore session?"
        case .rename, .delete: "Confirm session action"
        }
    }

    var message: String {
        let title = session.title.isEmpty ? "this session" : "“\(session.title)”"
        return switch action {
        case .terminate:
            "This stops the running agent for \(title). The session and transcript remain available."
        case .archive:
            "Archive \(title)? It will move out of the current session list."
        case .restore:
            "Restore \(title) to the current session list?"
        case .rename, .delete:
            "Confirm this session action."
        }
    }

    var actionLabel: String {
        switch action {
        case .terminate: "Terminate"
        case .archive: "Archive"
        case .restore: "Restore"
        case .rename: "Rename"
        case .delete: "Delete"
        }
    }

    var role: ButtonRole? {
        switch action {
        case .terminate, .archive, .delete: .destructive
        case .rename, .restore: nil
        }
    }
}

private struct SessionEditorSheet: View {
    let editor: SessionEditor
    let isPending: Bool
    let onCancel: () -> Void
    let onCommit: (_ projectID: String, _ title: String) -> Void

    @State private var projectID = ""
    @State private var title = ""

    var body: some View {
        NavigationStack {
            Form {
                if case .create = editor {
                    Section("Project") {
                        TextField("Project identifier", text: $projectID)
                        Text("Project metadata is not available in AppState, so an exact project identifier is required.")
                            .font(T4Typography.body(.caption))
                            .foregroundStyle(T4Color.secondaryText)
                    }
                }

                Section("Session") {
                    TextField("Title", text: $title)
                        .onSubmit(commit)
                    Text("Titles can contain up to 512 characters.")
                        .font(T4Typography.body(.caption))
                        .foregroundStyle(T4Color.secondaryText)
                }
            }
            .navigationTitle(editor.session == nil ? "New session" : "Rename session")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isPending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editor.session == nil ? "Create" : "Rename", action: commit)
                        .disabled(!isValid || isPending)
                }
            }
        }
        .onAppear {
            if let session = editor.session { title = session.title }
        }
    }

    private var isValid: Bool {
        let normalizedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalizedTitle.count <= 512 else { return false }
        if case .create = editor {
            return !projectID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return !normalizedTitle.isEmpty
    }

    private func commit() {
        guard isValid else { return }
        onCommit(projectID, title)
    }
}

private struct DeleteSessionSheet: View {
    let session: T4Session
    let isPending: Bool
    let onCancel: () -> Void
    let onDelete: () -> Void

    @State private var confirmation = ""

    private var confirmationText: String {
        let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? "delete" : title
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("This permanently deletes the session and its transcript.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(T4Color.destructive)
                    Text("This action cannot be undone. Type “\(confirmationText)” to confirm.")
                        .foregroundStyle(T4Color.secondaryText)
                    TextField("Session title", text: $confirmation)
                        .onSubmit(deleteIfValid)
                }
            }
            .navigationTitle("Delete session?")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isPending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Delete permanently", role: .destructive, action: deleteIfValid)
                        .disabled(!isValid || isPending)
                }
            }
        }
        .interactiveDismissDisabled(isPending)
    }

    private var isValid: Bool {
        confirmation.trimmingCharacters(in: .whitespacesAndNewlines) == confirmationText
    }

    private func deleteIfValid() {
        guard isValid else { return }
        onDelete()
    }
}
