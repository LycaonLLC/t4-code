import Foundation
import SwiftUI
import T4Client
import T4Protocol

@MainActor
public struct DeveloperWorkspaceView: View {
    private let controller: T4ClientController

    @State private var selectedTab: DeveloperTab = .activity
    @State private var busyAction: String?
    @State private var actionError: String?

    @State private var activityPaused = false
    @State private var activityFilter: String?
    @State private var activitySnapshot: [String] = []

    @State private var directoryPath = ""
    @State private var fileEntries: [DeveloperFileEntry] = []
    @State private var selectedFilePath: String?
    @State private var fileContent = ""
    @State private var fileDraft = ""
    @State private var fileRevision: String?
    @State private var fileDirty = false
    @State private var pendingFileTarget: FileTarget?
    @State private var showDiscardConfirmation = false

    @State private var diffText: String?
    @State private var reviewItems: [DeveloperReviewItem] = []
    @State private var pendingReview: DeveloperReviewItem?
    @State private var showApplyConfirmation = false

    public init(controller: T4ClientController) {
        self.controller = controller
    }

    public var body: some View {
        VStack(spacing: 0) {
            tabStrip
            Divider()
            if let actionError {
                DeveloperErrorBanner(message: actionError) {
                    self.actionError = nil
                }
            }
            if busyAction != nil {
                ProgressView()
                    .progressViewStyle(.linear)
                    .accessibilityLabel("Developer operation in progress")
            }
            selectedSurface
        }
        .background(T4Color.background)
        .onAppear {
            if activitySnapshot.isEmpty {
                activitySnapshot = controller.state.developer.messages
            }
        }
        .onChange(of: controller.state.developer.messages) { _, messages in
            if !activityPaused {
                activitySnapshot = messages
            }
        }
        .alert("Discard unsaved changes?", isPresented: $showDiscardConfirmation) {
            Button("Keep Editing", role: .cancel) {
                pendingFileTarget = nil
            }
            Button("Discard", role: .destructive) {
                discardAndContinue()
            }
        } message: {
            Text("Your edits to \(selectedFilePath ?? "this file") have not been saved.")
        }
        .alert("Apply review?", isPresented: $showApplyConfirmation, presenting: pendingReview) { review in
            Button("Cancel", role: .cancel) {
                pendingReview = nil
            }
            Button("Apply", role: .destructive) {
                Task { await applyReview(review) }
            }
        } message: { review in
            Text("Apply \(review.title) to the selected session workspace? This changes files on the paired host.")
        }
    }

    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: T4Spacing.xs) {
                ForEach(DeveloperTab.allCases) { tab in
                    Button {
                        selectedTab = tab
                    } label: {
                        Label(tab.title, systemImage: tab.systemImage)
                            .font(.subheadline.weight(selectedTab == tab ? .semibold : .regular))
                            .padding(.horizontal, T4Spacing.sm)
                            .padding(.vertical, T4Spacing.xs)
                            .foregroundStyle(selectedTab == tab ? T4Color.accentForeground : T4Color.secondaryText)
                            .background(selectedTab == tab ? T4Color.accent : T4Color.surface, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(tab.title) developer tab")
                    .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
                }
            }
            .padding(.horizontal, T4Spacing.sm)
            .padding(.vertical, T4Spacing.xs)
        }
        .background(T4Color.raised)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Developer tools tabs")
    }

    @ViewBuilder
    private var selectedSurface: some View {
        switch selectedTab {
        case .activity:
            activitySurface
        case .files:
            filesSurface
        case .review:
            reviewSurface
        case .terminal:
            TerminalView(controller: controller)
        case .preview:
            PreviewView(controller: controller)
        }
    }

    private var activitySurface: some View {
        Group {
            if !isConnected && activitySnapshot.isEmpty {
                DeveloperEmptyState(
                    systemImage: "icloud.slash",
                    title: "Activity is offline",
                    detail: "Connect to a host to inspect redacted protocol activity."
                )
            } else if !hasCapability("audit.read") {
                DeveloperEmptyState(
                    systemImage: "lock",
                    title: "Activity is unavailable",
                    detail: "The paired host did not grant audit.read access."
                )
            } else {
                VStack(spacing: 0) {
                    activityToolbar
                    if activityPaused {
                        DeveloperNotice(
                            systemImage: "pause.circle",
                            message: "Activity is paused. New rows are held until you resume."
                        )
                    }
                    Divider()
                    if filteredActivity.isEmpty {
                        DeveloperEmptyState(
                            systemImage: activitySnapshot.isEmpty ? "waveform.path.ecg" : "line.3.horizontal.decrease.circle",
                            title: activitySnapshot.isEmpty ? "No activity yet" : "No matching activity",
                            detail: activitySnapshot.isEmpty
                                ? "Refresh to request recent host activity."
                                : "Choose a different category filter."
                        )
                    } else {
                        List(filteredActivity) { row in
                            VStack(alignment: .leading, spacing: T4Spacing.xs) {
                                HStack {
                                    Text(row.category)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(T4Color.accent)
                                    Spacer()
                                    Text("Redacted")
                                        .font(.caption2)
                                        .foregroundStyle(T4Color.mutedText)
                                }
                                Text(row.message)
                                    .font(T4Typography.monospaced())
                                    .foregroundStyle(T4Color.foreground)
                                    .textSelection(.enabled)
                            }
                            .padding(.vertical, T4Spacing.xs)
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("\(row.category) activity. \(row.message)")
                        }
                        .listStyle(.plain)
                    }
                }
            }
        }
    }

    private var activityToolbar: some View {
        HStack(spacing: T4Spacing.sm) {
            Picker("Activity filter", selection: $activityFilter) {
                Text("All activity").tag(String?.none)
                ForEach(activityCategories, id: \.self) { category in
                    Text(category).tag(String?.some(category))
                }
            }
            .pickerStyle(.menu)
            .disabled(busyAction != nil)

            Spacer()

            Button {
                activityPaused.toggle()
                if !activityPaused {
                    activitySnapshot = controller.state.developer.messages
                }
            } label: {
                Label(activityPaused ? "Resume" : "Pause", systemImage: activityPaused ? "play.fill" : "pause.fill")
            }
            .disabled(busyAction != nil)
            .accessibilityLabel(activityPaused ? "Resume activity" : "Pause activity")

            Button {
                Task { await refreshActivity() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .disabled(!isConnected || busyAction != nil)
            .accessibilityLabel("Refresh activity")
        }
        .labelStyle(.iconOnly)
        .padding(T4Spacing.sm)
    }

    private var filesSurface: some View {
        Group {
            if !isConnected && fileEntries.isEmpty && selectedFilePath == nil {
                DeveloperEmptyState(
                    systemImage: "externaldrive.badge.xmark",
                    title: "Files are offline",
                    detail: "Connect to browse the selected session workspace."
                )
            } else if !hasCapability("files.list") || !hasCapability("files.read") {
                DeveloperEmptyState(
                    systemImage: "lock",
                    title: "Files are unavailable",
                    detail: "Browsing requires files.list and files.read access from the paired host."
                )
            } else {
                GeometryReader { proxy in
                    if proxy.size.width >= T4Layout.wideBreakpoint {
                        HStack(spacing: 0) {
                            fileBrowser
                                .frame(width: T4DeveloperDesign.fileRailWidth)
                            Divider()
                            sourceEditor
                        }
                    } else {
                        VStack(spacing: 0) {
                            fileBrowser
                                .frame(maxHeight: T4DeveloperDesign.compactBrowserHeight)
                            Divider()
                            sourceEditor
                        }
                    }
                }
            }
        }
    }

    private var fileBrowser: some View {
        VStack(spacing: 0) {
            HStack(spacing: T4Spacing.xs) {
                Button {
                    requestFileTarget(.directory(parentPath(of: directoryPath)))
                } label: {
                    Image(systemName: "arrow.up")
                }
                .disabled(directoryPath.isEmpty || !canMutateWorkspace)
                .accessibilityLabel("Open parent directory")

                Text(directoryPath.isEmpty ? "Workspace root" : directoryPath)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    requestFileTarget(.directory(directoryPath))
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(!canMutateWorkspace)
                .accessibilityLabel("Refresh directory")
            }
            .padding(T4Spacing.sm)

            Divider()

            if busyAction == "files.list" && fileEntries.isEmpty {
                ProgressView("Loading files")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if fileEntries.isEmpty {
                DeveloperEmptyState(
                    systemImage: "folder",
                    title: "No files loaded",
                    detail: "Refresh to inspect this directory."
                )
            } else {
                List(sortedFileEntries) { entry in
                    Button {
                        requestFileTarget(entry.isDirectory ? .directory(entry.path) : .file(entry.path))
                    } label: {
                        HStack(spacing: T4Spacing.sm) {
                            Image(systemName: entry.isDirectory ? "folder" : "doc.text")
                                .foregroundStyle(entry.isDirectory ? T4Color.accent : T4Color.secondaryText)
                            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                                Text(entry.name)
                                    .foregroundStyle(T4Color.foreground)
                                    .lineLimit(1)
                                if let size = entry.size, !entry.isDirectory {
                                    Text(byteCount(size))
                                        .font(.caption)
                                        .foregroundStyle(T4Color.mutedText)
                                }
                            }
                            Spacer()
                            if entry.isDirectory {
                                Image(systemName: "chevron.right")
                                    .foregroundStyle(T4Color.mutedText)
                            }
                        }
                        .padding(.leading, CGFloat(entry.depth) * T4Spacing.sm)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(entry.path == selectedFilePath ? T4Color.accentSoft : T4Color.background)
                    .disabled(!canMutateWorkspace)
                    .accessibilityLabel(entry.isDirectory ? "Open directory \(entry.path)" : "Open file \(entry.path)")
                }
                .listStyle(.plain)
            }
        }
        .background(T4Color.background)
    }

    private var sourceEditor: some View {
        Group {
            if busyAction == "files.read" {
                ProgressView("Reading file")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let selectedFilePath {
                VStack(spacing: 0) {
                    HStack(spacing: T4Spacing.sm) {
                        Text(selectedFilePath)
                            .font(.headline)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if fileDirty {
                            T4StatusPill("Unsaved", tone: .warning)
                        } else if !fileIsEditable {
                            T4StatusPill("Read only", tone: .neutral)
                        }
                        Spacer()
                        Button("Discard") {
                            fileDraft = fileContent
                            fileDirty = false
                        }
                        .disabled(!fileDirty || busyAction != nil)
                        Button {
                            Task { await saveFile() }
                        } label: {
                            Label(fileDirty ? "Save" : "Saved", systemImage: "square.and.arrow.down")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!fileDirty || !fileIsEditable || busyAction != nil)
                        .accessibilityHint(fileEditDisabledReason ?? "Saves changes to the paired host")
                    }
                    .padding(T4Spacing.sm)

                    Divider()

                    TextEditor(text: $fileDraft)
                        .font(T4Typography.monospaced())
                        .foregroundStyle(T4Color.foreground)
                        .scrollContentBackground(.hidden)
                        .padding(T4Spacing.sm)
                        .background(T4Color.input)
                        .disabled(!fileIsEditable || busyAction != nil)
                        .onChange(of: fileDraft) { _, value in
                            fileDirty = value != fileContent
                        }
                        .accessibilityLabel("Source editor for \(selectedFilePath)")
                        .accessibilityHint(fileEditDisabledReason ?? "Edit this file, then choose Save")
                }
            } else {
                DeveloperEmptyState(
                    systemImage: "chevron.left.forwardslash.chevron.right",
                    title: "Select a source file",
                    detail: "Choose a file to inspect protocol-provided contents."
                )
            }
        }
        .background(T4Color.input)
    }

    private var reviewSurface: some View {
        Group {
            if !isConnected && diffText == nil && combinedReviewItems.isEmpty {
                DeveloperEmptyState(
                    systemImage: "doc.badge.clock",
                    title: "Review is offline",
                    detail: "Connect to load review items and file diffs."
                )
            } else {
                GeometryReader { proxy in
                    if proxy.size.width >= T4Layout.wideBreakpoint {
                        HStack(spacing: 0) {
                            reviewQueue
                                .frame(width: T4DeveloperDesign.reviewRailWidth)
                            Divider()
                            diffViewer
                        }
                    } else {
                        VStack(spacing: 0) {
                            reviewQueue
                                .frame(maxHeight: T4DeveloperDesign.compactReviewHeight)
                            Divider()
                            diffViewer
                        }
                    }
                }
            }
        }
    }

    private var reviewQueue: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Review queue")
                    .font(.headline)
                Spacer()
                Text("\(combinedReviewItems.count)")
                    .foregroundStyle(T4Color.mutedText)
                    .accessibilityLabel("\(combinedReviewItems.count) review items")
            }
            .padding(T4Spacing.sm)
            Divider()

            if combinedReviewItems.isEmpty {
                DeveloperEmptyState(
                    systemImage: "checkmark.circle",
                    title: "Queue is clear",
                    detail: "Load a selected file diff or wait for a host review request."
                )
            } else {
                List(combinedReviewItems) { review in
                    VStack(alignment: .leading, spacing: T4Spacing.sm) {
                        Text(review.title)
                            .font(.headline)
                        if !review.detail.isEmpty {
                            Text(review.detail)
                                .font(.subheadline)
                                .foregroundStyle(T4Color.secondaryText)
                                .lineLimit(3)
                        }
                        HStack {
                            T4StatusPill(review.status.capitalized, tone: review.isFinal ? .success : .working)
                            Spacer()
                            Button("Refresh") {
                                Task { await refreshReview(review) }
                            }
                            .disabled(!isConnected || !hasCapability("files.read") || busyAction != nil)
                            Button("Apply") {
                                pendingReview = review
                                showApplyConfirmation = true
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(review.isFinal || review.revision == nil || !isConnected || !hasCapability("files.write") || busyAction != nil)
                            .accessibilityHint(review.revision == nil ? "Refresh this review before applying it." : "Applies this review to the paired host.")
                        }
                    }
                    .padding(.vertical, T4Spacing.xs)
                    .accessibilityElement(children: .contain)
                }
                .listStyle(.plain)
            }
        }
        .background(T4Color.background)
    }

    private var diffViewer: some View {
        VStack(spacing: 0) {
            HStack(spacing: T4Spacing.sm) {
                VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                    Text("File diff")
                        .font(.headline)
                    Text(selectedFilePath ?? "No file selected")
                        .font(.caption)
                        .foregroundStyle(T4Color.mutedText)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Button {
                    Task { await loadSelectedFileDiff() }
                } label: {
                    Label(diffText == nil ? "Load Diff" : "Reload", systemImage: "arrow.clockwise")
                }
                .disabled(selectedFilePath == nil || !isConnected || !hasCapability("files.diff") || busyAction != nil)
            }
            .padding(T4Spacing.sm)
            Divider()

            if !hasCapability("files.diff") {
                DeveloperEmptyState(
                    systemImage: "lock",
                    title: "File diff unavailable",
                    detail: "The paired host did not grant files.diff access."
                )
            } else if busyAction == "files.diff" {
                ProgressView("Loading diff")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let diffText {
                if diffText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    DeveloperEmptyState(
                        systemImage: "checkmark.circle",
                        title: "No changes",
                        detail: "The selected file has no changes to review."
                    )
                } else {
                    ScrollView([.horizontal, .vertical]) {
                        Text(diffText)
                            .font(T4Typography.monospaced())
                            .foregroundStyle(T4Color.foreground)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                            .padding(T4Spacing.md)
                    }
                    .background(T4Color.input)
                    .accessibilityLabel("Diff for \(selectedFilePath ?? "selected file")")
                }
            } else {
                DeveloperEmptyState(
                    systemImage: "doc.text.magnifyingglass",
                    title: selectedFilePath == nil ? "Choose a file first" : "Diff not loaded",
                    detail: selectedFilePath == nil
                        ? "Select a file in Files, then return here to inspect its diff."
                        : "Load the selected file diff to begin review."
                )
            }
        }
        .background(T4Color.input)
    }

    private var filteredActivity: [DeveloperActivityRow] {
        activitySnapshot.enumerated().reversed().compactMap { offset, message in
            let row = DeveloperActivityRow(index: offset, source: message)
            guard activityFilter == nil || row.category == activityFilter else { return nil }
            return row
        }
    }

    private var activityCategories: [String] {
        Array(Set(activitySnapshot.enumerated().map { DeveloperActivityRow(index: $0.offset, source: $0.element).category })).sorted()
    }

    private var sortedFileEntries: [DeveloperFileEntry] {
        fileEntries.sorted {
            if $0.isDirectory != $1.isDirectory { return $0.isDirectory }
            return $0.path.localizedCaseInsensitiveCompare($1.path) == .orderedAscending
        }
    }

    private var combinedReviewItems: [DeveloperReviewItem] {
        var byID = Dictionary(uniqueKeysWithValues: reviewItems.map { ($0.id, $0) })
        for attention in controller.state.attention
        where attention.kind.localizedCaseInsensitiveContains("review") && byID[attention.id] == nil {
            byID[attention.id] = DeveloperReviewItem(
                id: attention.id,
                title: attention.title,
                detail: attention.detail,
                status: "pending",
                revision: nil
            )
        }
        return byID.values.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    private var isConnected: Bool {
        controller.state.connection == .connected
    }

    private var canMutateWorkspace: Bool {
        isConnected && busyAction == nil
    }

    private var fileIsEditable: Bool {
        isConnected && hasCapability("files.write") && fileRevision != nil
    }

    private var fileEditDisabledReason: String? {
        guard isConnected else { return "Reconnect to edit this file." }
        guard hasCapability("files.write") else { return "Requires files.write access." }
        guard fileRevision != nil else { return "Read the file again to obtain its current revision before editing." }
        return nil
    }

    private func hasCapability(_ capability: String) -> Bool {
        DeveloperCapabilities.allows(capability, state: controller.state)
    }

    private func refreshActivity() async {
        await perform("audit.read") {
            let response = try await controller.command(
                "audit.read",
                args: ["limit": .integer(T4DeveloperDesign.activityLimit)]
            )
            let messages = response.result?["events"]?.arrayValue?.map(prettyJSON) ?? []
            guard !activityPaused else { return }
            activitySnapshot = messages.isEmpty ? controller.state.developer.messages : messages
        }
    }

    private func requestFileTarget(_ target: FileTarget) {
        if fileDirty {
            pendingFileTarget = target
            showDiscardConfirmation = true
            return
        }
        Task { await open(target) }
    }

    private func discardAndContinue() {
        fileDraft = fileContent
        fileDirty = false
        guard let target = pendingFileTarget else { return }
        pendingFileTarget = nil
        Task { await open(target) }
    }

    private func open(_ target: FileTarget) async {
        switch target {
        case let .directory(path):
            await listDirectory(path)
        case let .file(path):
            await readFile(path)
        }
    }

    private func listDirectory(_ path: String) async {
        await perform("files.list") {
            let args: [String: JSONValue] = path.isEmpty ? [:] : ["path": .string(path)]
            let response = try await controller.command(
                "files.list",
                sessionID: controller.state.selectedSessionID,
                args: args
            )
            directoryPath = path
            selectedFilePath = nil
            fileContent = ""
            fileDraft = ""
            fileRevision = nil
            fileDirty = false
            diffText = nil
            fileEntries = DeveloperFileEntry.decode(response.result?["entries"])
        }
    }

    private func readFile(_ path: String) async {
        await perform("files.read") {
            let response = try await controller.command(
                "files.read",
                sessionID: controller.state.selectedSessionID,
                args: ["path": .string(path)]
            )
            guard let content = response.result?["content"]?.stringValue else {
                throw DeveloperSurfaceError("The host returned no text content for this file.")
            }
            selectedFilePath = path
            directoryPath = parentPath(of: path)
            fileContent = content
            fileDraft = content
            fileRevision = response.result?["revision"]?.stringValue
            fileDirty = false
            diffText = nil
        }
    }

    private func saveFile() async {
        guard let path = selectedFilePath, fileDirty else { return }
        guard let expectedRevision = fileRevision else {
            actionError = "Read the file again to obtain its current revision before saving."
            return
        }
        let savedDraft = fileDraft
        await perform("files.write") {
            let response = try await controller.command(
                "files.write",
                sessionID: controller.state.selectedSessionID,
                expectedRevision: expectedRevision,
                args: ["path": .string(path), "content": .string(savedDraft)]
            )
            fileContent = savedDraft
            fileDraft = savedDraft
            fileRevision = response.result?["revision"]?.stringValue ?? fileRevision
            fileDirty = false
        }
    }

    private func loadSelectedFileDiff() async {
        guard let selectedFilePath else { return }
        await perform("files.diff") {
            let response = try await controller.command(
                "files.diff",
                sessionID: controller.state.selectedSessionID,
                args: ["path": .string(selectedFilePath)]
            )
            diffText = response.result?["diff"]?.stringValue ?? ""
            let revision = response.result?["revision"]?.stringValue
            let decoded = DeveloperReviewItem.decode(response.result?["reviews"]).map { item in
                var item = item
                item.revision = item.revision ?? revision
                return item
            }
            if !decoded.isEmpty { reviewItems = decoded }
        }
    }

    private func refreshReview(_ review: DeveloperReviewItem) async {
        await perform("review.read") {
            let response = try await controller.command(
                "review.read",
                sessionID: controller.state.selectedSessionID,
                args: ["reviewId": .string(review.id)]
            )
            if let diff = response.result?["diff"]?.stringValue {
                diffText = diff
            }
            if let path = response.result?["path"]?.stringValue {
                selectedFilePath = path
            }
            var refreshed = review
            refreshed.revision = response.result?["revision"]?.stringValue
                ?? response.result?["review"]?.objectValue?["revision"]?.stringValue
                ?? review.revision
            if let index = reviewItems.firstIndex(where: { $0.id == review.id }) {
                reviewItems[index] = refreshed
            } else {
                reviewItems.append(refreshed)
            }
        }
    }

    private func applyReview(_ review: DeveloperReviewItem) async {
        pendingReview = nil
        guard let expectedRevision = review.revision else {
            actionError = "Refresh this review to obtain its current revision before applying it."
            return
        }
        await perform("review.apply") {
            _ = try await controller.command(
                "review.apply",
                sessionID: controller.state.selectedSessionID,
                expectedRevision: expectedRevision,
                args: ["reviewId": .string(review.id)]
            )
            if let index = reviewItems.firstIndex(where: { $0.id == review.id }) {
                reviewItems[index].status = "applied"
            } else {
                var applied = review
                applied.status = "applied"
                reviewItems.append(applied)
            }
        }
    }

    private func perform(_ name: String, operation: @escaping @MainActor () async throws -> Void) async {
        guard busyAction == nil else { return }
        busyAction = name
        actionError = nil
        do {
            try await operation()
        } catch {
            actionError = developerErrorMessage(error)
        }
        busyAction = nil
    }
}

private enum DeveloperTab: String, CaseIterable, Identifiable {
    case activity
    case files
    case review
    case terminal
    case preview

    var id: String { rawValue }

    var title: String { rawValue.capitalized }

    var systemImage: String {
        switch self {
        case .activity: "waveform.path.ecg"
        case .files: "folder"
        case .review: "doc.text.magnifyingglass"
        case .terminal: "apple.terminal"
        case .preview: "rectangle.inset.filled.and.person.filled"
        }
    }
}

private enum FileTarget {
    case directory(String)
    case file(String)
}

private struct DeveloperActivityRow: Identifiable {
    let id: String
    let category: String
    let message: String

    init(index: Int, source: String) {
        id = "\(index)-\(source.hashValue)"
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("["), let end = trimmed.firstIndex(of: "]") {
            category = String(trimmed[trimmed.index(after: trimmed.startIndex)..<end]).capitalized
        } else if let separator = trimmed.firstIndex(of: ":"), trimmed.distance(from: trimmed.startIndex, to: separator) <= T4DeveloperDesign.maximumCategoryLength {
            category = String(trimmed[..<separator]).trimmingCharacters(in: .whitespaces).capitalized
        } else {
            category = "Protocol"
        }
        message = redactDeveloperText(trimmed)
    }
}

private struct DeveloperFileEntry: Identifiable {
    let path: String
    let kind: String
    let size: Int?

    var id: String { path }
    var isDirectory: Bool {
        ["directory", "dir", "folder"].contains(kind.lowercased())
    }
    var name: String {
        let normalized = path.replacingOccurrences(of: "\\", with: "/").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return normalized.split(separator: "/").last.map(String.init) ?? path
    }
    var depth: Int {
        max(0, path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").count - 1)
    }

    static func decode(_ value: JSONValue?) -> [DeveloperFileEntry] {
        value?.arrayValue?.compactMap { value in
            guard let object = value.objectValue,
                  let path = object["path"]?.stringValue else { return nil }
            return DeveloperFileEntry(
                path: path,
                kind: object["kind"]?.stringValue ?? object["type"]?.stringValue ?? "file",
                size: object["size"]?.intValue
            )
        } ?? []
    }
}

private struct DeveloperReviewItem: Identifiable {
    let id: String
    let title: String
    let detail: String
    var status: String
    var revision: String?

    var isFinal: Bool {
        ["applied", "discarded"].contains(status.lowercased())
    }

    static func decode(_ value: JSONValue?) -> [DeveloperReviewItem] {
        value?.arrayValue?.compactMap { value in
            guard let object = value.objectValue,
                  let id = object["reviewId"]?.stringValue ?? object["id"]?.stringValue else { return nil }
            return DeveloperReviewItem(
                id: id,
                title: object["path"]?.stringValue ?? object["title"]?.stringValue ?? id,
                detail: object["summary"]?.stringValue ?? object["detail"]?.stringValue ?? "",
                status: object["status"]?.stringValue ?? "pending",
                revision: object["revision"]?.stringValue
            )
        } ?? []
    }
}

enum T4DeveloperDesign {
    static let fileRailWidth: CGFloat = 304
    static let reviewRailWidth: CGFloat = 336
    static let compactBrowserHeight: CGFloat = 248
    static let compactReviewHeight: CGFloat = 272
    static let minimumEmptyStateWidth: CGFloat = 240
    static let maximumEmptyStateWidth: CGFloat = 520
    static let activityLimit = 200
    static let maximumCategoryLength = 28
    static let terminalPastePreviewLength = 320
    static let terminalOutputLimit = 256_000
    static let terminalDefaultColumns = 80
    static let terminalDefaultRows = 24
    static let terminalMaximumColumns = 1_000
    static let terminalMaximumRows = 500
    static let terminalControlWidth: CGFloat = 320
    static let terminalOutputMinimumHeight: CGFloat = 240
    static let previewControlWidth: CGFloat = 344
    static let previewCaptureMinimumHeight: CGFloat = 280
    static let previewCaptureChunkBytes = 256 * 1024
    static let previewCaptureMaximumBytes = 8 * 1024 * 1024
    static let previewCaptureMaximumPixels = 16 * 1024 * 1024
    static let previewURLMaximumBytes = 4_096
    static let previewInteractionMaximumBytes = 8 * 1024
}

@MainActor
enum DeveloperCapabilities {
    static func allows(_ capability: String, state: AppState) -> Bool {
        guard state.developer.isEnabled else { return false }
        let advertised = state.settings.values["client.grantedCapabilities"]
            ?? state.settings.values["grantedCapabilities"]
        guard let advertised else { return true }
        let values = Set(advertised.split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "." && $0 != "-" }).map(String.init))
        return values.contains(capability)
    }
}

struct DeveloperSurfaceError: Error {
    let message: String

    init(_ message: String) {
        self.message = message
    }
}

func developerErrorMessage(_ error: Error) -> String {
    if let error = error as? DeveloperSurfaceError { return error.message }
    if let error = error as? T4ClientControllerError {
        switch error {
        case .disconnected: return "The host is offline. Reconnect and try again."
        case .staleGeneration: return "The connection changed before the operation finished."
        case .invalidFrame: return "The host returned an invalid protocol frame."
        case let .remote(_, message): return message
        case let .transport(message): return message
        }
    }
    return String(describing: error)
}

func parentPath(of path: String) -> String {
    let normalized = path.replacingOccurrences(of: "\\", with: "/").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard let separator = normalized.lastIndex(of: "/") else { return "" }
    return String(normalized[..<separator])
}

func byteCount(_ count: Int) -> String {
    let formatter = ByteCountFormatter()
    formatter.countStyle = .file
    return formatter.string(fromByteCount: Int64(count))
}

func prettyJSON(_ value: JSONValue) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value.toFoundation(), options: [.prettyPrinted, .sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        return "Protocol event"
    }
    return redactDeveloperText(text)
}

func redactDeveloperText(_ source: String) -> String {
    T4Privacy.redacted(source)
}

struct DeveloperNotice: View {
    let systemImage: String
    let message: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: T4Spacing.sm) {
            Image(systemName: systemImage)
                .foregroundStyle(T4Color.info)
            Text(message)
                .font(.footnote)
                .foregroundStyle(T4Color.secondaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, T4Spacing.md)
        .padding(.vertical, T4Spacing.sm)
        .background(T4Color.infoSoft)
        .accessibilityElement(children: .combine)
    }
}

struct DeveloperErrorBanner: View {
    let message: String
    var dismiss: (() -> Void)?

    init(message: String, dismiss: (() -> Void)? = nil) {
        self.message = message
        self.dismiss = dismiss
    }

    var body: some View {
        HStack(spacing: T4Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(message)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let dismiss {
                Button("Dismiss", systemImage: "xmark", action: dismiss)
                    .labelStyle(.iconOnly)
                    .accessibilityLabel("Dismiss error")
            }
        }
        .foregroundStyle(T4Color.destructive)
        .padding(.horizontal, T4Spacing.md)
        .padding(.vertical, T4Spacing.sm)
        .background(T4Color.destructiveSoft)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Developer tools error: \(message)")
    }
}

struct DeveloperEmptyState: View {
    let systemImage: String
    let title: String
    let detail: String
    var action: (() -> AnyView)?

    init(systemImage: String, title: String, detail: String, action: (() -> AnyView)? = nil) {
        self.systemImage = systemImage
        self.title = title
        self.detail = detail
        self.action = action
    }

    var body: some View {
        ScrollView {
            VStack(spacing: T4Spacing.sm) {
                Image(systemName: systemImage)
                    .font(.largeTitle)
                    .foregroundStyle(T4Color.mutedText)
                Text(title)
                    .font(.headline)
                    .foregroundStyle(T4Color.foreground)
                    .multilineTextAlignment(.center)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(T4Color.secondaryText)
                    .multilineTextAlignment(.center)
                if let action {
                    action()
                        .padding(.top, T4Spacing.xs)
                }
            }
            .frame(minWidth: T4DeveloperDesign.minimumEmptyStateWidth, maxWidth: T4DeveloperDesign.maximumEmptyStateWidth)
            .padding(T4Spacing.xl)
            .frame(maxWidth: .infinity, minHeight: T4DeveloperDesign.compactBrowserHeight)
            .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension JSONValue {
    var arrayValue: [JSONValue]? {
        guard case let .array(value) = self else { return nil }
        return value
    }

    var intValue: Int? {
        guard case let .number(value) = self,
              value.rounded(.towardZero) == value,
              value >= Double(Int.min), value <= Double(Int.max) else { return nil }
        return Int(value)
    }

    var boolValue: Bool? {
        guard case let .bool(value) = self else { return nil }
        return value
    }
}
