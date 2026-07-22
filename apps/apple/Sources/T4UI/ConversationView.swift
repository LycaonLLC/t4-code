import Foundation
import SwiftUI
import T4Client
import T4Protocol

@MainActor
public struct ConversationView: View {
    private let controller: T4ClientController

    public init(controller: T4ClientController) {
        self.controller = controller
    }

    public var body: some View {
        let state = controller.state

        VStack(spacing: 0) {
            ConversationHeader(state: state)

            if let error = visibleError(state: state) {
                ConnectionErrorBanner(
                    message: error,
                    canRetry: state.connection == .failed || state.connection == .disconnected,
                    onRetry: {
                        Task { @MainActor in await controller.connect() }
                    }
                )
            }

            if state.connection != .connected && !state.transcript.isEmpty {
                CachedTranscriptNotice(connection: state.connection)
            }

            TranscriptTimelineView(controller: controller)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            ComposerView(controller: controller)
        }
        .background(T4Color.background)
    }

    private func visibleError(state: AppState) -> String? {
        let message = state.errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let message, !message.isEmpty { return T4Privacy.redacted(message) }
        return state.connection == .failed ? "The connection could not be established." : nil
    }
}

@MainActor
private struct ConversationHeader: View {
    let state: AppState

    var body: some View {
        let session = state.sessions.first { $0.id == state.selectedSessionID }
        let streaming = session.map { isWorking($0.status) } ?? false

        ViewThatFits(in: .horizontal) {
            HStack(spacing: T4Spacing.md) {
                titleBlock(session: session)
                Spacer(minLength: T4Spacing.md)
                statusBlock(session: session, streaming: streaming)
            }

            VStack(alignment: .leading, spacing: T4Spacing.sm) {
                titleBlock(session: session)
                statusBlock(session: session, streaming: streaming)
            }
        }
        .padding(.horizontal, T4Spacing.lg)
        .padding(.vertical, T4Spacing.md)
        .background(T4Color.surface)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(T4Color.border)
                .frame(height: T4Spacing.xxs / 2)
        }
        .accessibilityElement(children: .contain)
    }

    private func titleBlock(session: T4Session?) -> some View {
        VStack(alignment: .leading, spacing: T4Spacing.xxs) {
            Text(displayTitle(session))
                .font(T4Typography.heading(.title2))
                .foregroundStyle(T4Color.foreground)
                .lineLimit(1)

            if let session {
                Text(session.status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Idle" : session.status)
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
                    .lineLimit(1)
            } else {
                Text("Choose a session to begin")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
            }
        }
    }

    private func statusBlock(session: T4Session?, streaming: Bool) -> some View {
        HStack(spacing: T4Spacing.sm) {
            if !state.attention.isEmpty {
                Label("\(state.attention.count) pending", systemImage: "tray.full")
                    .font(T4Typography.body(.caption, weight: .semibold))
                    .foregroundStyle(T4Color.warning)
                    .accessibilityLabel("\(state.attention.count) pending attention items")
            }

            if streaming {
                HStack(spacing: T4Spacing.xs) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Streaming")
                        .font(T4Typography.body(.caption, weight: .semibold))
                }
                .foregroundStyle(T4Color.statusWorking)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Assistant is streaming a response")
                .accessibilityAddTraits(.updatesFrequently)
            } else if let session {
                T4StatusPill(text: statusLabel(session.status), tone: statusTone(session.status))
            }
        }
    }

    private func displayTitle(_ session: T4Session?) -> String {
        guard let session else { return "No session selected" }
        let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? "Untitled session" : title
    }

    private func statusLabel(_ status: String) -> String {
        let normalized = status.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? "Idle" : normalized
    }

    private func statusTone(_ status: String) -> T4StatusTone {
        let normalized = status.lowercased()
        if normalized.contains("error") || normalized.contains("failed") { return .error }
        if normalized.contains("approval") { return .approval }
        if normalized.contains("input") || normalized.contains("question") { return .input }
        if normalized.contains("done") || normalized.contains("complete") || normalized.contains("closed") { return .done }
        if isWorking(status) { return .working }
        return .neutral
    }

    private func isWorking(_ status: String) -> Bool {
        SessionRuntime.isActive(status)
    }
}

private struct ConnectionErrorBanner: View {
    let message: String
    let canRetry: Bool
    let onRetry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: T4Spacing.sm) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(T4Color.destructive)
                .accessibilityHidden(true)

            Text(message)
                .font(T4Typography.body(.callout))
                .foregroundStyle(T4Color.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)

            if canRetry {
                Button("Retry", action: onRetry)
                    .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, T4Spacing.md)
        .padding(.vertical, T4Spacing.sm)
        .background(T4Color.destructiveSoft)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Connection error: \(message)")
    }
}

private struct CachedTranscriptNotice: View {
    let connection: T4ConnectionState

    var body: some View {
        HStack(spacing: T4Spacing.xs) {
            Image(systemName: "lock.doc")
                .accessibilityHidden(true)
            Text(message)
                .font(T4Typography.body(.caption))
        }
        .foregroundStyle(T4Color.secondaryText)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, T4Spacing.md)
        .padding(.vertical, T4Spacing.xs)
        .background(T4Color.raised)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
        .accessibilityAddTraits(.updatesFrequently)
    }

    private var message: String {
        switch connection {
        case .connecting, .reconnecting:
            "Showing cached messages while the live transcript reconnects."
        case .failed:
            "Showing cached messages. Live updates are unavailable."
        case .disconnected:
            "Showing cached messages while offline."
        case .connected:
            "Showing live messages."
        }
    }
}

@MainActor
private struct TranscriptTimelineView: View {
    let controller: T4ClientController

    @State private var followsTail = true
    @State private var historyLoading = false
    @State private var historyError: String?
    @State private var historyCursor: TranscriptCursor?
    @State private var historyExhausted = false

    private let tailID = "t4-transcript-tail"

    var body: some View {
        let state = controller.state

        if state.selectedSessionID == nil {
            T4EmptyState(
                title: "Choose a session",
                message: "Select a session from the session list to view its conversation.",
                systemImage: "bubble.left.and.bubble.right"
            )
        } else if state.transcript.isEmpty {
            emptyTranscript(state: state)
        } else {
            GeometryReader { viewport in
                ScrollViewReader { proxy in
                    ZStack(alignment: .bottomTrailing) {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: T4Spacing.lg) {
                                historyControl(state: state, proxy: proxy)

                                ForEach(state.transcript) { item in
                                    TranscriptMessageView(
                                        item: item,
                                        streaming: item.id == state.transcript.last?.id
                                            && isStreamableRole(item.role)
                                            && selectedSessionIsWorking(state: state),
                                        onRetryImage: {
                                            Task { @MainActor in
                                                guard let sessionID = state.selectedSessionID else { return }
                                                await controller.selectSession(sessionID)
                                            }
                                        }
                                    )
                                    .id(item.id)
                                }

                                Color.clear
                                    .frame(height: T4Spacing.xxs)
                                    .id(tailID)
                                    .background {
                                        GeometryReader { tail in
                                            Color.clear.preference(
                                                key: TranscriptTailVisibilityKey.self,
                                                value: tail.frame(in: .named("transcript-scroll")).minY
                                                    <= viewport.size.height + T4Spacing.xl
                                            )
                                        }
                                    }
                            }
                            .padding(.horizontal, T4Spacing.md)
                            .padding(.top, T4Spacing.lg)
                            .padding(.bottom, T4Spacing.xl)
                        }
                        .coordinateSpace(name: "transcript-scroll")
                        .scrollDismissesKeyboard(.interactively)
                        .onPreferenceChange(TranscriptTailVisibilityKey.self) { visible in
                            followsTail = visible
                        }
                        .onChange(of: state.selectedSessionID) { _, _ in
                            followsTail = true
                            historyCursor = nil
                            historyExhausted = false
                            historyError = nil
                            scrollToTail(proxy, animated: false)
                        }
                        .onChange(of: state.transcript.count) { oldCount, newCount in
                            guard newCount >= oldCount, followsTail else { return }
                            scrollToTail(proxy, animated: oldCount > 0)
                        }
                        .onChange(of: state.transcript.last?.text) { _, _ in
                            guard followsTail else { return }
                            scrollToTail(proxy, animated: false)
                        }
                        .onAppear {
                            scrollToTail(proxy, animated: false)
                        }

                        if !followsTail {
                            Button {
                                followsTail = true
                                scrollToTail(proxy, animated: true)
                            } label: {
                                Label("Jump to latest", systemImage: "arrow.down")
                            }
                            .buttonStyle(.borderedProminent)
                            .padding(T4Spacing.md)
                            .accessibilityHint("Scrolls to the newest message and resumes automatic scrolling")
                        }
                    }
                }
            }
        }
    }

    private func emptyTranscript(state: AppState) -> some View {
        let loading = state.connection == .connecting || state.connection == .reconnecting
        return VStack(spacing: T4Spacing.md) {
            if loading {
                ProgressView()
                    .accessibilityLabel("Loading conversation")
            }
            T4EmptyState(
                title: loading ? "Loading conversation" : "Start the conversation",
                message: state.connection == .connected
                    ? "Send a prompt when you are ready."
                    : "Messages and the composer will be available when the host reconnects.",
                systemImage: "bubble.left"
            )
        }
    }

    private func historyControl(state: AppState, proxy: ScrollViewProxy) -> some View {
        VStack(spacing: T4Spacing.xs) {
            if let historyError {
                Text(historyError)
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.destructive)
                    .textSelection(.enabled)
                    .accessibilityLabel("Earlier message error: \(historyError)")
            }

            Button {
                Task { @MainActor in await loadEarlier(state: state, proxy: proxy) }
            } label: {
                if historyLoading {
                    HStack(spacing: T4Spacing.xs) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Loading earlier messages")
                    }
                } else {
                    Label("Load earlier messages", systemImage: "clock.arrow.circlepath")
                }
            }
            .buttonStyle(.bordered)
            .disabled(historyDisabledReason(state: state) != nil || historyLoading)
            .help(historyDisabledReason(state: state) ?? "Load the previous transcript page")
            .accessibilityHint(historyDisabledReason(state: state) ?? "Keeps the current reading position stable")
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, T4Spacing.sm)
    }

    private func historyDisabledReason(state: AppState) -> String? {
        guard state.connection == .connected else { return "Reconnect to load earlier messages." }
        guard SessionCapabilities.allows("sessions.read", state: state) else {
            return "The paired host did not grant sessions.read access."
        }
        guard effectiveHistoryCursor(state: state) != nil else { return "No earlier history cursor is available." }
        return nil
    }

    private func loadEarlier(state: AppState, proxy: ScrollViewProxy) async {
        guard
            !historyLoading,
            let sessionID = state.selectedSessionID,
            let cursor = effectiveHistoryCursor(state: state)
        else { return }

        historyLoading = true
        historyError = nil
        let readingAnchor = state.transcript.first?.id
        defer { historyLoading = false }

        do {
            let response = try await controller.command(
                "transcript.page",
                sessionID: sessionID,
                args: [
                    "before": .object([
                        "epoch": .string(cursor.epoch),
                        "seq": .number(Double(cursor.seq))
                    ]),
                    "limit": .integer(ConversationLimits.historyPageEntries),
                    "maxBytes": .integer(ConversationLimits.historyPageBytes)
                ]
            )
            guard case let .array(values)? = response.result?["entries"] else {
                throw ConversationError.invalidHistoryResponse
            }

            let nextCursor = decodeCursor(response.result?["nextCursor"] ?? response.result?["cursor"])
            if case let .bool(hasMore)? = response.result?["hasMore"] {
                historyCursor = hasMore ? nextCursor : nil
                historyExhausted = !hasMore || nextCursor == nil
            } else if let nextCursor {
                historyCursor = nextCursor
            } else if values.isEmpty {
                historyCursor = nil
                historyExhausted = true
            }

            let knownIDs = Set(state.transcript.map(\.id))
            let earlier = values.compactMap(decodeTranscriptItem).filter { !knownIDs.contains($0.id) }
            guard !earlier.isEmpty else { return }
            state.transcript.insert(contentsOf: earlier, at: 0)

            if let readingAnchor {
                await Task.yield()
                proxy.scrollTo(readingAnchor, anchor: .top)
            }
        } catch {
            historyError = error.localizedDescription
        }
    }

    private func effectiveHistoryCursor(state: AppState) -> TranscriptCursor? {
        guard !historyExhausted else { return nil }
        return historyCursor ?? state.transcript.first?.cursor ?? state.transcriptCursor
    }

    private func decodeTranscriptItem(_ value: JSONValue) -> T4TranscriptItem? {
        guard
            let object = value.objectValue,
            let id = (object["id"] ?? object["entryId"])?.stringValue
        else { return nil }

        return T4TranscriptItem(
            id: id,
            role: (object["role"] ?? object["author"])?.stringValue ?? "assistant",
            text: (object["text"] ?? object["message"])?.stringValue ?? "",
            cursor: decodeCursor(object["cursor"]),
            revision: object["revision"]?.stringValue
        )
    }

    private func decodeCursor(_ value: JSONValue?) -> TranscriptCursor? {
        guard
            let object = value?.objectValue,
            let epoch = object["epoch"]?.stringValue,
            case let .number(sequence)? = object["seq"],
            sequence.rounded(.towardZero) == sequence,
            sequence >= 0,
            sequence <= Double(Int.max)
        else { return nil }
        return TranscriptCursor(epoch: epoch, seq: Int(sequence))
    }

    private func isStreamableRole(_ role: String) -> Bool {
        let normalized = role.lowercased()
        return normalized != "user"
            && normalized != "human"
            && normalized != "system"
            && normalized != "event"
            && !normalized.contains("image")
    }

    private func selectedSessionIsWorking(state: AppState) -> Bool {
        guard let session = state.sessions.first(where: { $0.id == state.selectedSessionID }) else { return false }
        return SessionRuntime.isActive(session.status)
    }

    private func scrollToTail(_ proxy: ScrollViewProxy, animated: Bool) {
        Task { @MainActor in
            await Task.yield()
            if animated {
                withAnimation(.easeOut) {
                    proxy.scrollTo(tailID, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(tailID, anchor: .bottom)
            }
        }
    }
}

private struct TranscriptMessageView: View {
    let item: T4TranscriptItem
    let streaming: Bool
    let onRetryImage: () -> Void

    var body: some View {
        switch messageKind {
        case .tool:
            toolMessage
        case .reasoning:
            reasoningMessage
        case .image:
            TranscriptRepresentedImage(item: item, onRetry: onRetryImage)
        case .user, .assistant, .system:
            standardMessage
        }
    }

    private var standardMessage: some View {
        HStack {
            if messageKind == .user { Spacer(minLength: T4Spacing.xl) }

            VStack(alignment: .leading, spacing: T4Spacing.xs) {
                Text(roleLabel.uppercased())
                    .font(T4Typography.body(.caption2, weight: .semibold))
                    .foregroundStyle(T4Color.secondaryText)

                if item.text.isEmpty && streaming {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Assistant is preparing a response")
                } else {
                    TranscriptMarkdownView(text: item.text)
                }

                if streaming {
                    HStack(spacing: T4Spacing.xs) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Streaming")
                            .font(T4Typography.body(.caption, weight: .semibold))
                    }
                    .foregroundStyle(T4Color.statusWorking)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Assistant response is streaming")
                    .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .padding(messageKind == .assistant ? T4Spacing.xs : T4Spacing.md)
            .background(messageBackground)
            .clipShape(RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous))
            .overlay {
                if messageKind == .system {
                    RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
                        .stroke(T4Color.border)
                }
            }
            .frame(maxWidth: .infinity, alignment: messageKind == .user ? .trailing : .leading)

            if messageKind != .user { Spacer(minLength: T4Spacing.xl) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(roleLabel) message\(streaming ? ", streaming" : "")")
    }

    private var toolMessage: some View {
        DisclosureGroup {
            Text(item.text.isEmpty ? "No tool output was provided." : item.text)
                .font(T4Typography.monospaced(.caption))
                .foregroundStyle(T4Color.foreground)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, T4Spacing.sm)
        } label: {
            HStack(spacing: T4Spacing.sm) {
                Image(systemName: streaming ? "arrow.triangle.2.circlepath" : "wrench.and.screwdriver")
                    .foregroundStyle(streaming ? T4Color.statusWorking : T4Color.secondaryText)
                VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                    Text("Tool")
                        .font(T4Typography.heading(.callout))
                    Text(streaming ? "Running" : "Details")
                        .font(T4Typography.body(.caption))
                        .foregroundStyle(T4Color.secondaryText)
                }
            }
        }
        .padding(T4Spacing.md)
        .background(T4Color.raised)
        .clipShape(RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
                .stroke(T4Color.border)
        }
        .accessibilityLabel(streaming ? "Tool is running" : "Tool result")
    }

    private var reasoningMessage: some View {
        DisclosureGroup {
            TranscriptMarkdownView(text: item.text)
                .font(T4Typography.body(.callout))
                .padding(.top, T4Spacing.sm)
        } label: {
            Label(streaming ? "Reasoning · streaming" : "Reasoning", systemImage: "brain")
                .font(T4Typography.heading(.callout))
                .foregroundStyle(T4Color.info)
        }
        .padding(T4Spacing.md)
        .background(T4Color.infoSoft)
        .clipShape(RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous))
        .accessibilityLabel(streaming ? "Reasoning, streaming" : "Reasoning")
    }

    private var messageBackground: Color {
        switch messageKind {
        case .user: T4Color.accentSoft
        case .system: T4Color.raised
        case .assistant, .tool, .reasoning, .image: T4Color.surface
        }
    }

    private var roleLabel: String {
        switch messageKind {
        case .user: "You"
        case .assistant: "Assistant"
        case .system: "System"
        case .tool: "Tool"
        case .reasoning: "Reasoning"
        case .image: "Image"
        }
    }

    private var messageKind: TranscriptMessageKind {
        let role = item.role.lowercased()
        if role.contains("tool") { return .tool }
        if role.contains("reason") || role.contains("thinking") { return .reasoning }
        if role.contains("image") || item.text.lowercased().hasPrefix("[image") { return .image }
        if role == "user" || role == "human" { return .user }
        if role == "system" || role == "event" { return .system }
        return .assistant
    }
}

private enum TranscriptMessageKind {
    case user
    case assistant
    case system
    case tool
    case reasoning
    case image
}

private struct TranscriptRepresentedImage: View {
    let item: T4TranscriptItem
    let onRetry: () -> Void

    var body: some View {
        if let url = representedURL {
            TranscriptRemoteImage(url: url, altText: item.text)
        } else {
            VStack(spacing: T4Spacing.sm) {
                Image(systemName: "photo")
                    .font(T4Typography.heading(.title))
                    .foregroundStyle(T4Color.mutedText)
                    .accessibilityHidden(true)

                Text("Image unavailable")
                    .font(T4Typography.heading(.callout))

                Text(item.text.isEmpty ? "Reconnect to request this transcript image again." : item.text)
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)

                Button {
                    onRetry()
                } label: {
                    Label("Retry image", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity)
            .padding(T4Spacing.lg)
            .background(T4Color.raised)
            .clipShape(RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: T4Radius.md, style: .continuous)
                    .stroke(T4Color.border)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Transcript image unavailable")
        }
    }

    private var representedURL: URL? {
        let source = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: source), url.scheme == "https" || url.scheme == "http" {
            return url
        }
        let pattern = #"!?\[[^\]]*\]\((https?://[^\s\)]+)\)"#
        guard
            let expression = try? NSRegularExpression(pattern: pattern),
            let match = expression.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
            let range = Range(match.range(at: 1), in: source)
        else { return nil }
        return URL(string: String(source[range]))
    }
}

private enum ConversationLimits {
    static let historyPageEntries = 128
    static let historyPageBytes = 512 * 1024
}

private enum ConversationError: LocalizedError {
    case invalidHistoryResponse

    var errorDescription: String? {
        "The host returned an invalid transcript page."
    }
}

private struct TranscriptMarkdownView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: T4Spacing.sm) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case let .prose(source):
                    Text(formatted(source))
                        .font(T4Typography.body())
                        .foregroundStyle(T4Color.foreground)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case let .code(language, source):
                    VStack(alignment: .leading, spacing: T4Spacing.xs) {
                        if let language, !language.isEmpty {
                            Text(language.uppercased())
                                .font(T4Typography.body(.caption2, weight: .semibold))
                                .foregroundStyle(T4Color.secondaryText)
                        }
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(source.isEmpty ? " " : source)
                                .font(T4Typography.monospaced(.callout))
                                .foregroundStyle(T4Color.foreground)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                    }
                    .padding(T4Spacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(T4Color.raised, in: RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous)
                            .stroke(T4Color.border)
                    }
                case let .image(altText, url):
                    TranscriptRemoteImage(url: url, altText: altText)
                }
            }
        }
    }

    private var blocks: [TranscriptMarkdownBlock] {
        TranscriptMarkdownParser.parse(text)
    }

    private func formatted(_ source: String) -> AttributedString {
        (try? AttributedString(markdown: source)) ?? AttributedString(source)
    }
}

private enum TranscriptMarkdownBlock {
    case prose(String)
    case code(language: String?, text: String)
    case image(altText: String, url: URL)
}

private enum TranscriptMarkdownParser {
    static func parse(_ source: String) -> [TranscriptMarkdownBlock] {
        var blocks: [TranscriptMarkdownBlock] = []
        var proseLines: [String] = []
        var codeLines: [String] = []
        var codeLanguage: String?
        var insideCode = false

        func flushProse() {
            guard !proseLines.isEmpty else { return }
            appendProseWithImages(proseLines.joined(separator: "\n"), to: &blocks)
            proseLines.removeAll(keepingCapacity: true)
        }

        func flushCode() {
            blocks.append(.code(language: codeLanguage, text: codeLines.joined(separator: "\n")))
            codeLines.removeAll(keepingCapacity: true)
            codeLanguage = nil
        }

        for line in source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if insideCode {
                    flushCode()
                    insideCode = false
                } else {
                    flushProse()
                    let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    codeLanguage = language.isEmpty ? nil : language
                    insideCode = true
                }
            } else if insideCode {
                codeLines.append(line)
            } else {
                proseLines.append(line)
            }
        }

        if insideCode {
            flushCode()
        } else {
            flushProse()
        }
        if blocks.isEmpty {
            blocks.append(.prose(source))
        }
        return blocks
    }

    private static func appendProseWithImages(
        _ source: String,
        to blocks: inout [TranscriptMarkdownBlock]
    ) {
        let pattern = #"!\[([^\]]*)\]\((https?://[^\s\)]+)\)"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            blocks.append(.prose(source))
            return
        }
        let matches = expression.matches(in: source, range: NSRange(source.startIndex..., in: source))
        guard !matches.isEmpty else {
            blocks.append(.prose(source))
            return
        }

        var cursor = source.startIndex
        for match in matches {
            guard
                let wholeRange = Range(match.range(at: 0), in: source),
                let altRange = Range(match.range(at: 1), in: source),
                let urlRange = Range(match.range(at: 2), in: source),
                let url = URL(string: String(source[urlRange]))
            else { continue }

            if cursor < wholeRange.lowerBound {
                let prose = String(source[cursor..<wholeRange.lowerBound])
                if !prose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    blocks.append(.prose(prose))
                }
            }
            let altText = String(source[altRange]).trimmingCharacters(in: .whitespacesAndNewlines)
            blocks.append(.image(altText: altText.isEmpty ? "Transcript image" : altText, url: url))
            cursor = wholeRange.upperBound
        }
        if cursor < source.endIndex {
            let prose = String(source[cursor...])
            if !prose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                blocks.append(.prose(prose))
            }
        }
    }
}

private struct TranscriptRemoteImage: View {
    let url: URL
    let altText: String

    @State private var reloadID = UUID()

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case let .success(image):
                image
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: T4Layout.readableMeasure / 2)
            case .empty:
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: T4Spacing.xxl * 2)
                    .accessibilityLabel("Loading \(altText)")
            case .failure:
                VStack(spacing: T4Spacing.xs) {
                    Label("Image could not be loaded", systemImage: "photo.badge.exclamationmark")
                        .font(T4Typography.body(.caption, weight: .semibold))
                    Button("Retry") {
                        reloadID = UUID()
                    }
                    .buttonStyle(.bordered)
                }
                .foregroundStyle(T4Color.secondaryText)
                .frame(maxWidth: .infinity, minHeight: T4Spacing.xxl * 2)
            @unknown default:
                EmptyView()
            }
        }
        .id(reloadID)
        .background(T4Color.raised, in: RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous)
                .stroke(T4Color.border)
        }
        .accessibilityLabel(altText.isEmpty ? "Transcript image" : altText)
    }
}

private struct TranscriptTailVisibilityKey: PreferenceKey {
    static let defaultValue = true

    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value && nextValue()
    }
}
