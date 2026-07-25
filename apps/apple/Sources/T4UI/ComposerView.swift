import CryptoKit
import Foundation
import SwiftUI
import T4Client
import T4Protocol
import UniformTypeIdentifiers

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

@MainActor
public struct ComposerView: View {
    private let controller: T4ClientController

    @State private var activeSessionID: String?
    @State private var draft = ""
    @State private var drafts: [String: String] = [:]
    @State private var attachments: [String: [ComposerImageAttachment]] = [:]
    @State private var busyAction: ComposerAction?
    @State private var localError: String?
    @State private var showingImageImporter = false
    @State private var showingModelEditor = false
    @State private var modelInput = ""
    @FocusState private var composerFocused: Bool

    public init(controller: T4ClientController) {
        self.controller = controller
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: T4Spacing.xs) {
            if let localError {
                composerError(localError)
            } else if let error = controller.state.composer.error {
                composerError(error)
            }

            if !currentAttachments.isEmpty {
                attachmentStrip
            }

            if selectedSession != nil {
                controlStrip
            }

            HStack(alignment: .bottom, spacing: T4Spacing.xs) {
                Button {
                    showingImageImporter = true
                } label: {
                    Image(systemName: "paperclip")
                        .frame(minWidth: T4Spacing.xl, minHeight: T4Spacing.xl)
                }
                .buttonStyle(.borderless)
                .disabled(attachmentDisabledReason != nil)
                .help(attachmentDisabledReason ?? "Attach images")
                .accessibilityLabel("Attach images")
                .accessibilityHint(attachmentDisabledReason ?? "Choose up to eight PNG, JPEG, GIF, or WebP images")

                TextField(composerPlaceholder, text: draftBinding, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(ComposerLimits.minimumLines...ComposerLimits.maximumLines)
                    .submitLabel(.send)
                    .focused($composerFocused)
                    .disabled(inputDisabledReason != nil)
                    .accessibilityLabel("Prompt message")
                    .accessibilityHint(inputDisabledReason ?? "Press Return to send")
                    .onSubmit {
                        Task { await submit() }
                    }

                Button {
                    Task { await submit() }
                } label: {
                    if isSending {
                        ProgressView()
                            .controlSize(.small)
                            .frame(minWidth: T4Spacing.xl, minHeight: T4Spacing.xl)
                            .accessibilityLabel("Sending prompt")
                    } else {
                        Text(turnIsActive ? "Steer" : "Send")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canSubmit)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityHint(submitDisabledReason ?? "Sends this prompt to the selected session")
            }
        }
        .frame(maxWidth: T4Layout.readableMeasure)
        .padding(.horizontal, T4Spacing.md)
        .padding(.vertical, T4Spacing.sm)
        .frame(maxWidth: .infinity)
        .background(T4Color.surface)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(T4Color.border)
                .frame(height: T4Spacing.xxs / 2)
        }
        .onAppear {
            activateSession(controller.state.selectedSessionID)
        }
        .onChange(of: controller.state.selectedSessionID) { _, nextSessionID in
            activateSession(nextSessionID)
        }
        .fileImporter(
            isPresented: $showingImageImporter,
            allowedContentTypes: [.png, .jpeg, .gif, .webP],
            allowsMultipleSelection: true
        ) { result in
            switch result {
            case let .success(urls):
                Task { await importImages(urls) }
            case let .failure(error):
                localError = "Could not open the selected image: \(error.localizedDescription)"
            }
        }
        .sheet(isPresented: $showingModelEditor) {
            ModelSelectionSheet(
                selection: $modelInput,
                suggestedModels: modelOptions,
                isPending: busyAction != nil,
                onCancel: { showingModelEditor = false },
                onSelect: { selector in
                    showingModelEditor = false
                    Task { await setModel(selector) }
                }
            )
        }
    }

    private var selectedSession: T4Session? {
        guard let selectedSessionID = controller.state.selectedSessionID else { return nil }
        return controller.state.sessions.first { $0.id == selectedSessionID }
    }

    private var currentAttachments: [ComposerImageAttachment] {
        guard let activeSessionID else { return [] }
        return attachments[activeSessionID] ?? []
    }

    private var isSending: Bool {
        controller.state.composer.isSending || busyAction == .sending
    }

    private var turnIsActive: Bool {
        selectedSession.map { SessionRuntime.isActive($0.status) } ?? false
    }

    private var sessionIsPaused: Bool {
        selectedSession.map { SessionRuntime.isPaused($0.status) } ?? false
    }

    private var modelOptions: [String] {
        SessionSettings.modelOptions(state: controller.state)
    }

    private var currentModelLabel: String {
        guard let sessionID = activeSessionID else { return "Model" }
        return SessionSettings.currentModel(sessionID: sessionID, state: controller.state) ?? "Model"
    }

    private var draftBinding: Binding<String> {
        Binding(
            get: { draft },
            set: { value in
                draft = value
                if let activeSessionID {
                    drafts[activeSessionID] = value
                }
                controller.state.composer.text = value
                controller.state.composer.error = nil
                localError = nil
            }
        )
    }

    private var canSubmit: Bool {
        submitDisabledReason == nil
    }

    private var submitDisabledReason: String? {
        if let inputDisabledReason { return inputDisabledReason }
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !currentAttachments.isEmpty else {
            return "Enter a message or attach an image."
        }
        if turnIsActive && !currentAttachments.isEmpty {
            return "Images cannot be sent while a turn is active. Queue text or stop the turn first."
        }
        if !currentAttachments.isEmpty && currentRevision == nil {
            return "Wait for the session revision before sending images."
        }
        return nil
    }

    private var inputDisabledReason: String? {
        guard controller.state.connection == .connected else { return "Reconnect before sending a prompt." }
        guard selectedSession != nil else { return "Choose a session before sending a prompt." }
        guard SessionCapabilities.allows("sessions.prompt", state: controller.state) else {
            return "The paired host did not grant sessions.prompt access."
        }
        guard !sessionIsPaused else { return "Resume the session before sending a prompt." }
        guard !isSending else { return "Wait for the current prompt to finish sending." }
        return nil
    }

    private var attachmentDisabledReason: String? {
        if let inputDisabledReason { return inputDisabledReason }
        guard currentAttachments.count < ComposerLimits.maximumImages else {
            return "A prompt can contain at most eight images."
        }
        guard !turnIsActive else { return "Images cannot be attached while a turn is active." }
        return nil
    }

    private var currentRevision: String? {
        SessionRuntime.revision(for: activeSessionID, state: controller.state)
    }

    private var controlDisabledReason: String? {
        guard controller.state.connection == .connected else { return "Reconnect to control this session." }
        guard SessionCapabilities.allows("sessions.control", state: controller.state) else {
            return "The paired host did not grant sessions.control access."
        }
        guard currentRevision != nil else { return "Wait for the current session revision." }
        guard busyAction == nil && !controller.state.composer.isSending else { return "A session action is already in progress." }
        return nil
    }

    private var modelDisabledReason: String? {
        guard controller.state.connection == .connected else { return "Reconnect to change the model." }
        guard SessionCapabilities.allows("sessions.manage", state: controller.state) else {
            return "The paired host did not grant sessions.manage access."
        }
        guard currentRevision != nil else { return "Wait for the current session revision." }
        guard busyAction == nil else { return "A session action is already in progress." }
        return nil
    }

    private var composerPlaceholder: String {
        if selectedSession == nil { return "Choose a session to begin" }
        if sessionIsPaused { return "Resume the session to continue" }
        if turnIsActive { return "Steer the active turn" }
        return "Message T4"
    }

    private var controlStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: T4Spacing.xs) {
                Menu {
                    ForEach(modelOptions, id: \.self) { selector in
                        Button(selector) {
                            Task { await setModel(selector) }
                        }
                    }
                    if !modelOptions.isEmpty {
                        Divider()
                    }
                    Button("Choose model…") {
                        modelInput = currentModelLabel == "Model" ? "" : currentModelLabel
                        showingModelEditor = true
                    }
                } label: {
                    Label(currentModelLabel, systemImage: "cpu")
                        .lineLimit(1)
                }
                .disabled(modelDisabledReason != nil)
                .help(modelDisabledReason ?? "Choose a model for this session")
                .accessibilityLabel("Session model: \(currentModelLabel)")

                if sessionIsPaused {
                    controlButton("Resume", systemImage: "play.fill", action: .resume)
                } else if turnIsActive {
                    controlButton("Pause", systemImage: "pause.fill", action: .pause)
                } else {
                    controlButton("Compact", systemImage: "rectangle.compress.vertical", action: .compact)
                }

                if turnIsActive {
                    Button {
                        Task { await cancelTurn() }
                    } label: {
                        Label("Stop", systemImage: "stop.fill")
                    }
                    .buttonStyle(.bordered)
                    .disabled(controlDisabledReason != nil)
                    .help(controlDisabledReason ?? "Cancel the active turn")

                    Button {
                        Task { await queue() }
                    } label: {
                        Label(queueLabel, systemImage: "text.badge.plus")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!canQueue)
                    .help(queueDisabledReason ?? "Queue this message after the active turn")
                }
            }
            .controlSize(.small)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Session controls")
    }

    private var queueLabel: String {
        let count = controller.state.composer.queuedCount
        return count == 0 ? "Queue" : "Queue (\(count))"
    }

    private var canQueue: Bool {
        queueDisabledReason == nil
    }

    private var queueDisabledReason: String? {
        guard turnIsActive else { return "Messages can be queued while a turn is active." }
        guard inputDisabledReason == nil else { return inputDisabledReason }
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Enter a follow-up message to queue." }
        return nil
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: T4Spacing.xs) {
                ForEach(currentAttachments) { attachment in
                    HStack(spacing: T4Spacing.xs) {
                        ComposerImageThumbnail(data: attachment.data)
                        VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                            Text(attachment.name)
                                .font(T4Typography.body(.caption, weight: .medium))
                                .lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.data.count), countStyle: .file))
                                .font(T4Typography.body(.caption2))
                                .foregroundStyle(T4Color.secondaryText)
                        }
                        Button {
                            removeAttachment(attachment.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.borderless)
                        .disabled(isSending)
                        .accessibilityLabel("Remove \(attachment.name)")
                    }
                    .padding(T4Spacing.xs)
                    .background(T4Color.raised, in: RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous)
                            .stroke(T4Color.border)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attached images")
    }

    private func controlButton(_ title: String, systemImage: String, action: ComposerAction) -> some View {
        Button {
            Task { await runControl(action) }
        } label: {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(.bordered)
        .disabled(controlDisabledReason != nil)
        .help(controlDisabledReason ?? title)
    }

    private func composerError(_ message: String) -> some View {
        HStack(alignment: .top, spacing: T4Spacing.xs) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(T4Color.destructive)
                .accessibilityHidden(true)
            Text(message)
                .font(T4Typography.body(.caption))
                .foregroundStyle(T4Color.foreground)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                localError = nil
                controller.state.composer.error = nil
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Dismiss composer error")
        }
        .padding(T4Spacing.xs)
        .background(T4Color.destructiveSoft, in: RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func activateSession(_ nextSessionID: String?) {
        if let activeSessionID {
            drafts[activeSessionID] = draft
        }
        activeSessionID = nextSessionID
        draft = nextSessionID.flatMap { drafts[$0] } ?? ""
        controller.state.composer.text = draft
        localError = nil
    }

    private func submit() async {
        guard canSubmit, let sessionID = activeSessionID else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = currentAttachments
        let submittedDraft = draft
        busyAction = .sending
        controller.state.composer.error = nil
        localError = nil
        defer { busyAction = nil }

        do {
            if images.isEmpty {
                _ = try await controller.prompt(text)
            } else {
                guard let revision = currentRevision else { return }
                try await submit(text: text, images: images, sessionID: sessionID, revision: revision)
            }
            guard activeSessionID == sessionID else { return }
            if draft == submittedDraft {
                draft = ""
                drafts[sessionID] = ""
                controller.state.composer.text = ""
            }
            attachments[sessionID] = []
            composerFocused = true
        } catch {
            let message = "Could not send the prompt: \(error.localizedDescription)"
            localError = message
            controller.state.composer.error = message
        }
    }

    private func queue() async {
        guard canQueue, let sessionID = activeSessionID else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let submittedDraft = draft
        busyAction = .queueing
        localError = nil
        defer { busyAction = nil }

        do {
            _ = try await controller.queue(text)
            guard activeSessionID == sessionID else { return }
            if draft == submittedDraft {
                draft = ""
                drafts[sessionID] = ""
                controller.state.composer.text = ""
            }
            composerFocused = true
        } catch {
            localError = "Could not queue the follow-up: \(error.localizedDescription)"
        }
    }

    private func cancelTurn() async {
        guard controlDisabledReason == nil else { return }
        busyAction = .cancel
        localError = nil
        defer { busyAction = nil }
        do {
            _ = try await controller.cancel()
        } catch {
            localError = "Could not stop the active turn: \(error.localizedDescription)"
        }
    }

    private func runControl(_ action: ComposerAction) async {
        guard
            controlDisabledReason == nil,
            let sessionID = activeSessionID,
            let revision = currentRevision
        else { return }

        busyAction = action
        localError = nil
        defer { busyAction = nil }

        let command: String
        switch action {
        case .pause: command = "session.pause"
        case .resume: command = "session.resume"
        case .compact: command = "session.compact"
        case .sending, .queueing, .cancel, .model: return
        }

        do {
            _ = try await controller.command(command, sessionID: sessionID, expectedRevision: revision)
        } catch {
            localError = "Could not update the session: \(error.localizedDescription)"
        }
    }

    private func setModel(_ rawSelector: String) async {
        let selector = rawSelector.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !selector.isEmpty,
            modelDisabledReason == nil,
            let sessionID = activeSessionID,
            let revision = currentRevision
        else { return }

        busyAction = .model
        localError = nil
        defer { busyAction = nil }
        do {
            _ = try await controller.command(
                "session.model.set",
                sessionID: sessionID,
                expectedRevision: revision,
                args: [
                    "selector": .string(selector),
                    "persistence": .string("session")
                ]
            )
        } catch {
            localError = "Could not change the session model: \(error.localizedDescription)"
        }
    }

    private func importImages(_ urls: [URL]) async {
        guard let sessionID = activeSessionID, inputDisabledReason == nil else { return }
        let available = ComposerLimits.maximumImages - currentAttachments.count
        guard available > 0 else {
            localError = "A prompt can contain at most eight images."
            return
        }
        if urls.count > available {
            localError = "Only the first \(available) selected image\(available == 1 ? "" : "s") could be attached. A prompt can contain at most eight."
        } else {
            localError = nil
        }

        var imported: [ComposerImageAttachment] = []
        for url in urls.prefix(available) {
            let accessed = url.startAccessingSecurityScopedResource()
            defer {
                if accessed { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let values = try url.resourceValues(forKeys: [.fileSizeKey, .nameKey])
                guard let byteCount = values.fileSize, byteCount > 0 else {
                    localError = "\(values.name ?? url.lastPathComponent) is empty."
                    continue
                }
                guard byteCount <= ComposerLimits.maximumImageBytes else {
                    localError = "\(values.name ?? url.lastPathComponent) is larger than 20 MB."
                    continue
                }
                guard let mimeType = ComposerImageAttachment.mimeType(for: url) else {
                    localError = "\(values.name ?? url.lastPathComponent) is not a supported image type."
                    continue
                }
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                guard !data.isEmpty, data.count <= ComposerLimits.maximumImageBytes else {
                    localError = "\(values.name ?? url.lastPathComponent) must be between 1 byte and 20 MB."
                    continue
                }
                imported.append(
                    ComposerImageAttachment(
                        id: UUID().uuidString.lowercased(),
                        name: values.name ?? url.lastPathComponent,
                        mimeType: mimeType,
                        data: data
                    )
                )
            } catch {
                localError = "Could not open \(url.lastPathComponent): \(error.localizedDescription)"
            }
        }

        guard activeSessionID == sessionID, !imported.isEmpty else { return }
        attachments[sessionID, default: []].append(contentsOf: imported)
    }

    private func removeAttachment(_ id: String) {
        guard let sessionID = activeSessionID else { return }
        attachments[sessionID]?.removeAll { $0.id == id }
        localError = nil
    }

    private func submit(
        text: String,
        images: [ComposerImageAttachment],
        sessionID: String,
        revision: String
    ) async throws {
        controller.state.composer.isSending = true
        defer { controller.state.composer.isSending = false }

        var imageIDs: [String] = []
        do {
            for image in images {
                imageIDs.append(try await upload(image, sessionID: sessionID))
            }
            let response = try await controller.command(
                "session.prompt",
                sessionID: sessionID,
                expectedRevision: revision,
                args: [
                    "message": .string(text),
                    "images": .array(imageIDs.map { .object(["imageId": .string($0)]) })
                ]
            )
            if case let .bool(accepted)? = response.result?["accepted"], !accepted {
                throw ComposerError.promptRejected
            }
        } catch {
            await discard(imageIDs, sessionID: sessionID)
            throw error
        }
    }

    private func upload(_ image: ComposerImageAttachment, sessionID: String) async throws -> String {
        guard image.data.count <= ComposerLimits.maximumImageBytes else { throw ComposerError.imageTooLarge }
        let begin = try await controller.command(
            "session.image.begin",
            sessionID: sessionID,
            args: [
                "mimeType": .string(image.mimeType),
                "size": .integer(image.data.count),
                "sha256": .string(Self.sha256Hex(image.data))
            ]
        )
        guard
            let imageID = begin.result?["imageId"]?.stringValue,
            case let .number(rawChunkBytes)? = begin.result?["chunkBytes"],
            rawChunkBytes.rounded(.towardZero) == rawChunkBytes,
            rawChunkBytes > 0,
            rawChunkBytes <= Double(Int.max)
        else { throw ComposerError.invalidImageResponse }

        let requestedChunkBytes = Int(rawChunkBytes)
        let chunkBytes = min(requestedChunkBytes, ComposerLimits.maximumUploadChunkBytes)
        var offset = 0
        while offset < image.data.count {
            let end = min(offset + chunkBytes, image.data.count)
            let content = image.data[offset..<end].base64EncodedString()
            let response = try await controller.command(
                "session.image.chunk",
                sessionID: sessionID,
                args: [
                    "imageId": .string(imageID),
                    "offset": .integer(offset),
                    "content": .string(content)
                ]
            )
            guard
                response.result?["imageId"]?.stringValue == imageID,
                case let .number(received)? = response.result?["received"],
                received == Double(end),
                case let .bool(complete)? = response.result?["complete"],
                complete == (end == image.data.count)
            else { throw ComposerError.invalidImageResponse }
            offset = end
        }
        return imageID
    }

    private func discard(_ imageIDs: [String], sessionID: String) async {
        for imageID in imageIDs {
            _ = try? await controller.command(
                "session.image.discard",
                sessionID: sessionID,
                args: ["imageId": .string(imageID)]
            )
        }
    }

    private static func sha256Hex(_ data: Data) -> String {
        let alphabet = Array("0123456789abcdef".utf8)
        var result: [UInt8] = []
        result.reserveCapacity(SHA256.Digest.byteCount * 2)
        for byte in SHA256.hash(data: data) {
            result.append(alphabet[Int(byte >> 4)])
            result.append(alphabet[Int(byte & 0x0f)])
        }
        return String(decoding: result, as: UTF8.self)
    }
}

private enum ComposerLimits {
    static let maximumImages = 8
    static let maximumImageBytes = 20 * 1024 * 1024
    static let maximumUploadChunkBytes = 512 * 1024
    static let minimumLines = 1
    static let maximumLines = 6
}

private enum ComposerAction: Equatable {
    case sending
    case queueing
    case cancel
    case pause
    case resume
    case compact
    case model
}

private enum ComposerError: LocalizedError {
    case imageTooLarge
    case invalidImageResponse
    case promptRejected

    var errorDescription: String? {
        switch self {
        case .imageTooLarge: "An image is larger than 20 MB."
        case .invalidImageResponse: "The host returned an invalid image-upload response."
        case .promptRejected: "The host did not accept the prompt."
        }
    }
}

private struct ComposerImageAttachment: Identifiable {
    let id: String
    let name: String
    let mimeType: String
    let data: Data

    static func mimeType(for url: URL) -> String? {
        switch url.pathExtension.lowercased() {
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        default: nil
        }
    }
}

private struct ComposerImageThumbnail: View {
    let data: Data

    var body: some View {
#if os(macOS)
        if let image = NSImage(data: data) {
            Image(nsImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: T4Spacing.xxl, height: T4Spacing.xxl)
                .clipShape(RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous))
                .accessibilityHidden(true)
        } else {
            fallback
        }
#elseif os(iOS)
        if let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: T4Spacing.xxl, height: T4Spacing.xxl)
                .clipShape(RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous))
                .accessibilityHidden(true)
        } else {
            fallback
        }
#endif
    }

    private var fallback: some View {
        Image(systemName: "photo")
            .frame(width: T4Spacing.xxl, height: T4Spacing.xxl)
            .background(T4Color.surface, in: RoundedRectangle(cornerRadius: T4Radius.sm, style: .continuous))
            .foregroundStyle(T4Color.mutedText)
            .accessibilityHidden(true)
    }
}

private struct ModelSelectionSheet: View {
    @Binding var selection: String
    let suggestedModels: [String]
    let isPending: Bool
    let onCancel: () -> Void
    let onSelect: (String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Model selector") {
                    TextField("provider/model", text: $selection)
                        .font(T4Typography.monospaced())
                        .autocorrectionDisabled()
                        .onSubmit(select)
                    Text("Enter the exact model selector advertised by the host.")
                        .font(T4Typography.body(.caption))
                        .foregroundStyle(T4Color.secondaryText)
                }
                if !suggestedModels.isEmpty {
                    Section("Available models") {
                        ForEach(suggestedModels, id: \.self) { model in
                            Button(model) {
                                selection = model
                            }
                        }
                    }
                }
            }
            .navigationTitle("Choose model")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isPending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use Model", action: select)
                        .disabled(normalizedSelection.isEmpty || isPending)
                }
            }
        }
    }

    private var normalizedSelection: String {
        selection.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func select() {
        guard !normalizedSelection.isEmpty, !isPending else { return }
        onSelect(normalizedSelection)
    }
}

@MainActor
enum SessionCapabilities {
    static func allows(_ capability: String, state: AppState) -> Bool {
        guard let advertised = state.settings.values["client.grantedCapabilities"]
            ?? state.settings.values["grantedCapabilities"]
        else { return true }
        let values = Set(
            advertised
                .split { !$0.isLetter && !$0.isNumber && $0 != "." && $0 != "-" }
                .map(String.init)
        )
        return values.contains(capability)
    }
}

@MainActor
enum SessionRuntime {
    static func isActive(_ status: String) -> Bool {
        let normalized = status.lowercased()
        return ["working", "running", "streaming", "busy", "thinking"].contains { normalized.contains($0) }
            && !isPaused(status)
    }

    static func isPaused(_ status: String) -> Bool {
        let normalized = status.lowercased()
        return normalized.contains("paused") || normalized.contains("suspended")
    }

    static func revision(for sessionID: String?, state: AppState) -> String? {
        guard sessionID != nil, sessionID == state.selectedSessionID else { return nil }
        return state.transcript.reversed().compactMap(\.revision).first { !$0.isEmpty }
    }
}

@MainActor
private enum SessionSettings {
    static func modelOptions(state: AppState) -> [String] {
        let raw = state.settings.values["session.model.options"]
            ?? state.settings.values["client.models"]
            ?? state.settings.values["models"]
        guard let raw else { return [] }
        var seen: Set<String> = []
        return raw
            .split { $0 == "," || $0 == ";" || $0 == "\n" }
            .map {
                $0.trimmingCharacters(in: CharacterSet(charactersIn: " \t\r\n[]\"") )
            }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    static func currentModel(sessionID: String, state: AppState) -> String? {
        let value = state.settings.values["session.\(sessionID).model"]
            ?? state.settings.values["session.model"]
            ?? state.settings.values["model"]
        let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.flatMap { $0.isEmpty ? nil : $0 }
    }
}
