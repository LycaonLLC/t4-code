import Foundation
import CryptoKit
import ImageIO
import SwiftUI
import T4Client
import T4Protocol

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

@MainActor
public struct PreviewView: View {
    private let controller: T4ClientController

    @State private var previews: [DeveloperPreview] = []
    @State private var selectedPreviewID: String?
    @State private var launchURL = ""
    @State private var navigationURL = ""
    @State private var busyAction: String?
    @State private var actionError: String?
    @State private var showInteraction = false

    public init(controller: T4ClientController) {
        self.controller = controller
    }

    public var body: some View {
        Group {
            if !isConnected && previews.isEmpty {
                DeveloperEmptyState(
                    systemImage: "network.slash",
                    title: "Preview is offline",
                    detail: "Connect to a host to request a capture-only preview."
                )
            } else if !hasAnyPreviewCapability && previews.isEmpty {
                DeveloperEmptyState(
                    systemImage: "lock",
                    title: "Preview is unavailable",
                    detail: "The paired host did not grant preview.read, preview.control, or preview.input."
                )
            } else {
                previewWorkspace
            }
        }
        .background(T4Color.background)
        .onChange(of: selectedPreviewID) { _, _ in
            navigationURL = selectedPreview?.url ?? ""
        }
        .sheet(isPresented: $showInteraction) {
            PreviewInteractionSheet(
                allowInput: hasCapability("preview.input"),
                allowHandoff: hasCapability("preview.control"),
                onSubmit: { action, arguments in
                    showInteraction = false
                    Task { await runInteraction(action: action, arguments: arguments) }
                }
            )
            .presentationDetents([.medium, .large])
        }
    }

    private var previewWorkspace: some View {
        VStack(spacing: 0) {
            if let actionError {
                DeveloperErrorBanner(message: actionError) {
                    self.actionError = nil
                }
            }
            if busyAction != nil {
                ProgressView()
                    .progressViewStyle(.linear)
                    .accessibilityLabel("Preview operation in progress")
            }
            DeveloperNotice(
                systemImage: "checkmark.shield.fill",
                message: "Safe preview: page code never runs in this app. Only captured image bytes delivered by the paired host protocol are decoded."
            )
            Divider()

            GeometryReader { proxy in
                if proxy.size.width >= T4Layout.wideBreakpoint {
                    HStack(spacing: 0) {
                        previewControls
                            .frame(width: T4DeveloperDesign.previewControlWidth)
                        Divider()
                        capturePane
                    }
                } else {
                    VStack(spacing: 0) {
                        previewControls
                        Divider()
                        capturePane
                            .frame(minHeight: T4DeveloperDesign.previewCaptureMinimumHeight)
                    }
                }
            }
        }
    }

    private var previewControls: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: T4Spacing.md) {
                launchSection

                if !previews.isEmpty {
                    Divider()
                    selectionSection
                }

                if let selectedPreview {
                    Divider()
                    navigationSection(selectedPreview)
                    Divider()
                    actionSection(selectedPreview)
                    previewStatus(selectedPreview)
                }

                if !isConnected {
                    DeveloperNotice(
                        systemImage: "network.slash",
                        message: "This is a cached capture. Navigation and interaction remain disabled while offline."
                    )
                }
            }
            .padding(T4Spacing.md)
        }
        .background(T4Color.raised)
    }

    private var launchSection: some View {
        VStack(alignment: .leading, spacing: T4Spacing.sm) {
            Text("Launch preview")
                .font(T4Typography.heading())
            TextField("https://localhost:3000", text: $launchURL)
                .textFieldStyle(.roundedBorder)
                .textContentType(.URL)
                .keyboardTypeURL()
                .disabled(!canControl || busyAction != nil)
                .onSubmit {
                    Task { await launchPreview() }
                }
                .accessibilityLabel("Preview launch URL")
            HStack {
                Button {
                    Task { await refreshPreviews() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(!isConnected || !hasCapability("preview.read") || busyAction != nil)

                Spacer()

                Button {
                    Task { await launchPreview() }
                } label: {
                    Label("Launch", systemImage: "play.rectangle")
                }
                .buttonStyle(.borderedProminent)
                .disabled(launchURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !canControl || busyAction != nil)
            }
        }
    }

    private var selectionSection: some View {
        VStack(alignment: .leading, spacing: T4Spacing.xs) {
            Text("Open previews")
                .font(T4Typography.heading(.subheadline))
            Picker(
                "Select preview",
                selection: Binding(
                    get: { selectedPreviewID },
                    set: { previewID in
                        guard let previewID else { return }
                        Task { await activatePreview(previewID) }
                    }
                )
            ) {
                ForEach(previews) { preview in
                    Text(preview.displayTitle).tag(String?.some(preview.id))
                }
            }
            .pickerStyle(.menu)
            .disabled(!canControl || busyAction != nil)
            .accessibilityLabel("Select captured preview")
        }
    }

    private func navigationSection(_ preview: DeveloperPreview) -> some View {
        VStack(alignment: .leading, spacing: T4Spacing.sm) {
            Text("Navigate")
                .font(T4Typography.heading(.subheadline))
            HStack(spacing: T4Spacing.xs) {
                Button {
                    Task { await runPreviewAction("back") }
                } label: {
                    Image(systemName: "chevron.backward")
                }
                .disabled(!canControl || !preview.canGoBack || busyAction != nil)
                .accessibilityLabel("Preview back")

                Button {
                    Task { await runPreviewAction("forward") }
                } label: {
                    Image(systemName: "chevron.forward")
                }
                .disabled(!canControl || !preview.canGoForward || busyAction != nil)
                .accessibilityLabel("Preview forward")

                Button {
                    Task { await runPreviewAction("reload") }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(!canControl || busyAction != nil)
                .accessibilityLabel("Reload preview")
            }

            TextField("Preview address", text: $navigationURL)
                .textFieldStyle(.roundedBorder)
                .textContentType(.URL)
                .keyboardTypeURL()
                .disabled(!canControl || busyAction != nil)
                .onSubmit {
                    Task { await navigatePreview() }
                }
                .accessibilityLabel("Preview address")

            Button {
                Task { await navigatePreview() }
            } label: {
                Label("Navigate", systemImage: "arrow.right")
            }
            .disabled(navigationURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !canControl || busyAction != nil)
        }
    }

    private func actionSection(_ preview: DeveloperPreview) -> some View {
        VStack(alignment: .leading, spacing: T4Spacing.sm) {
            Text("Remote controls")
                .font(T4Typography.heading(.subheadline))
            Text("Controls send protocol intents to the paired host. This app never loads the page itself.")
                .font(T4Typography.body(.caption))
                .foregroundStyle(T4Color.secondaryText)

            HStack(spacing: T4Spacing.sm) {
                Button {
                    showInteraction = true
                } label: {
                    Label("Interact", systemImage: "hand.tap")
                }
                .disabled(!canInteract || busyAction != nil)

                Button {
                    Task { await capturePreview() }
                } label: {
                    Label("Capture", systemImage: "camera")
                }
                .buttonStyle(.borderedProminent)
                .disabled(!canCapture || busyAction != nil)
            }

            Button(role: .destructive) {
                Task { await runPreviewAction("close") }
            } label: {
                Label("Close Preview", systemImage: "xmark")
            }
            .disabled(!canControl || busyAction != nil)
        }
    }

    private func previewStatus(_ preview: DeveloperPreview) -> some View {
        HStack(spacing: T4Spacing.sm) {
            Image(systemName: preview.error == nil ? "circle.fill" : "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundStyle(preview.error == nil ? T4Color.success : T4Color.destructive)
            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                Text(preview.state.capitalized)
                    .font(T4Typography.heading(.caption))
                Text(preview.captureData == nil ? "Capture required" : "Protocol capture ready")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
            }
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Preview status \(preview.state). \(preview.captureData == nil ? "No capture available" : "Capture available")")
    }

    private var capturePane: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                    Text(selectedPreview?.displayTitle ?? "Protocol capture")
                        .font(T4Typography.heading())
                    if let selectedPreview {
                        Text(selectedPreview.url)
                            .font(T4Typography.body(.caption))
                            .foregroundStyle(T4Color.mutedText)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer()
                if let mimeType = selectedPreview?.captureMIMEType {
                    Text(mimeType)
                        .font(T4Typography.monospaced(.caption2))
                        .foregroundStyle(T4Color.mutedText)
                }
            }
            .padding(T4Spacing.sm)
            .background(T4Color.raised)
            Divider()

            if busyAction == "preview.capture" && selectedPreview?.captureData == nil {
                ProgressView("Requesting capture")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let selectedPreview {
                if let error = selectedPreview.error {
                    DeveloperEmptyState(
                        systemImage: "exclamationmark.triangle",
                        title: "Preview error",
                        detail: error
                    )
                } else if let data = selectedPreview.captureData,
                          let captureImage = CapturedPlatformImage(data: data) {
                    captureImage.image
                        .resizable()
                        .interpolation(.high)
                        .scaledToFit()
                        .padding(T4Spacing.sm)
                        .background(T4Color.input)
                        .accessibilityLabel("Captured preview of \(selectedPreview.displayTitle)")
                } else {
                    DeveloperEmptyState(
                        systemImage: "photo",
                        title: "No protocol capture",
                        detail: "Choose Capture to request rendered image bytes. HTML and page scripts are never loaded here."
                    )
                }
            } else {
                DeveloperEmptyState(
                    systemImage: "rectangle.on.rectangle.slash",
                    title: "No preview open",
                    detail: "Enter a URL to launch a host-rendered, capture-only preview."
                )
            }
        }
        .background(T4Color.input)
    }

    private var selectedPreview: DeveloperPreview? {
        guard let selectedPreviewID else { return nil }
        return previews.first { $0.id == selectedPreviewID }
    }

    private var isConnected: Bool {
        controller.state.connection == .connected
    }

    private var hasAnyPreviewCapability: Bool {
        hasCapability("preview.read") || hasCapability("preview.control") || hasCapability("preview.input")
    }

    private var canControl: Bool {
        isConnected &&
            controller.state.selectedSessionID != nil &&
            hasCapability("preview.control")
    }

    private var canCapture: Bool {
        isConnected &&
            controller.state.selectedSessionID != nil &&
            hasCapability("preview.read") &&
            selectedPreview != nil
    }

    private var canInteract: Bool {
        isConnected &&
            controller.state.selectedSessionID != nil &&
            (hasCapability("preview.input") || hasCapability("preview.control")) &&
            selectedPreview != nil
    }

    private func hasCapability(_ capability: String) -> Bool {
        DeveloperCapabilities.allows(capability, state: controller.state)
    }

    private func refreshPreviews() async {
        guard isConnected,
              hasCapability("preview.read"),
              let sessionID = controller.state.selectedSessionID else { return }
        await perform("preview.state") {
            let response = try await controller.command(
                "preview.state",
                sessionID: sessionID
            )
            guard let list = response.result?["previews"]?.arrayValue else {
                throw DeveloperSurfaceError("The host returned no preview list.")
            }
            let decoded = DeveloperPreview.decodeList(response.result)
            guard decoded.count == list.count else {
                throw DeveloperSurfaceError("The host returned invalid preview state.")
            }
            let incomingIDs = Set(decoded.map(\.id))
            previews = mergePreviews(decoded, into: previews).filter { incomingIDs.contains($0.id) }
            if selectedPreviewID == nil || !previews.contains(where: { $0.id == selectedPreviewID }) {
                selectedPreviewID = previews.first?.id
            }
        }
    }

    private func launchPreview() async {
        guard canControl, let sessionID = controller.state.selectedSessionID else { return }
        let rawURL = launchURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = normalizedPreviewURL(rawURL) else {
            actionError = "Enter an HTTP or HTTPS URL without embedded credentials."
            return
        }
        await perform("preview.launch") {
            let response = try await controller.command(
                "preview.launch",
                sessionID: sessionID,
                args: ["url": .string(url), "authorityId": .string("omp-session")]
            )
            guard let preview = DeveloperPreview.decode(response.result, fallbackURL: url) else {
                throw DeveloperSurfaceError("The host launched no valid preview.")
            }
            previews = mergePreviews([preview], into: previews)
            selectedPreviewID = preview.id
            navigationURL = preview.url
            launchURL = ""
        }
    }

    private func activatePreview(_ previewID: String) async {
        guard canControl,
              let sessionID = controller.state.selectedSessionID,
              let preview = previews.first(where: { $0.id == previewID }) else { return }
        await perform("preview.activate") {
            let response = try await controller.command(
                "preview.activate",
                sessionID: sessionID,
                args: ["previewId": .string(previewID)]
            )
            selectedPreviewID = previewID
            navigationURL = preview.url
            updatePreview(from: response.result, fallbackID: previewID, fallbackURL: preview.url)
        }
    }

    private func navigatePreview() async {
        guard let preview = selectedPreview,
              canControl,
              let sessionID = controller.state.selectedSessionID else { return }
        let rawURL = navigationURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = normalizedPreviewURL(rawURL) else {
            actionError = "Enter an HTTP or HTTPS URL without embedded credentials."
            return
        }
        guard url != preview.url else { return }
        await perform("preview.navigate") {
            let response = try await controller.command(
                "preview.navigate",
                sessionID: sessionID,
                args: ["previewId": .string(preview.id), "url": .string(url)]
            )
            updatePreview(from: response.result, fallbackID: preview.id, fallbackURL: url)
        }
    }

    private func runPreviewAction(_ action: String) async {
        guard DeveloperPreview.safeActions.contains(action),
              let preview = selectedPreview,
              canControl,
              let sessionID = controller.state.selectedSessionID else { return }
        let command = "preview.\(action)"
        await perform(command) {
            let response = try await controller.command(
                command,
                sessionID: sessionID,
                args: ["previewId": .string(preview.id)]
            )
            if action == "close" {
                previews.removeAll { $0.id == preview.id }
                selectedPreviewID = previews.last?.id
            } else {
                updatePreview(from: response.result, fallbackID: preview.id, fallbackURL: preview.url)
            }
        }
    }

    private func runInteraction(action: String, arguments: [String: JSONValue]) async {
        guard DeveloperPreview.interactionActions.contains(action),
              arguments["previewId"] == nil,
              let preview = selectedPreview,
              let sessionID = controller.state.selectedSessionID else { return }
        let capability = action == "handoff" ? "preview.control" : "preview.input"
        guard isConnected, hasCapability(capability) else { return }
        var args = arguments
        args["previewId"] = .string(preview.id)
        await perform("preview.\(action)") {
            let response = try await controller.command(
                "preview.\(action)",
                sessionID: sessionID,
                args: args
            )
            updatePreview(from: response.result, fallbackID: preview.id, fallbackURL: preview.url)
        }
    }

    private func capturePreview() async {
        guard let preview = selectedPreview,
              canCapture,
              let sessionID = controller.state.selectedSessionID else { return }
        await perform("preview.capture") {
            let response = try await controller.command(
                "preview.capture",
                sessionID: sessionID,
                args: ["previewId": .string(preview.id)]
            )
            guard var updated = DeveloperPreview.decode(
                response.result,
                fallbackID: preview.id,
                fallbackURL: preview.url
            ), let capture = updated.capture else {
                throw DeveloperSurfaceError("The host returned no valid capture metadata.")
            }
            let data = try await readCapture(capture, previewID: updated.id, sessionID: sessionID)
            updated.captureData = data
            updated.captureMIMEType = capture.mimeType
            previews = mergePreviews([updated], into: previews)
            selectedPreviewID = updated.id
            navigationURL = updated.url
        }
    }

    private func readCapture(
        _ capture: DeveloperPreviewCapture,
        previewID: String,
        sessionID: String
    ) async throws -> Data {
        var data = Data()
        data.reserveCapacity(capture.size)
        var offset = 0
        while offset < capture.size {
            let response = try await controller.command(
                "preview.capture.read",
                sessionID: sessionID,
                args: [
                    "previewId": .string(previewID),
                    "captureId": .string(capture.id),
                    "offset": .integer(offset)
                ]
            )
            guard let result = response.result,
                  result["previewId"]?.stringValue == previewID,
                  result["captureId"]?.stringValue == capture.id,
                  result["size"]?.intValue == capture.size,
                  result["offset"]?.intValue == offset,
                  let nextOffset = result["nextOffset"]?.intValue,
                  nextOffset > offset,
                  nextOffset <= capture.size,
                  nextOffset - offset <= T4DeveloperDesign.previewCaptureChunkBytes,
                  result["complete"]?.boolValue == (nextOffset == capture.size),
                  let encoded = result["content"]?.stringValue,
                  let chunk = Data(base64Encoded: encoded),
                  chunk.base64EncodedString() == encoded,
                  chunk.count == nextOffset - offset else {
                throw DeveloperSurfaceError("The host returned an invalid preview capture chunk.")
            }
            data.append(chunk)
            offset = nextOffset
        }
        guard data.count == capture.size,
              previewSHA256(data) == capture.sha256,
              previewRasterIsValid(data, capture: capture) else {
            throw DeveloperSurfaceError("The preview capture failed its integrity checks.")
        }
        return data
    }

    private func updatePreview(from result: [String: JSONValue]?, fallbackID: String, fallbackURL: String) {
        if let decoded = DeveloperPreview.decode(result, fallbackID: fallbackID, fallbackURL: fallbackURL) {
            previews = mergePreviews([decoded], into: previews)
            selectedPreviewID = decoded.id
            navigationURL = decoded.url
        }
    }

    private func perform(_ name: String, operation: @escaping @MainActor () async throws -> Void) async {
        guard busyAction == nil else { return }
        busyAction = name
        actionError = nil
        defer { busyAction = nil }
        do {
            try await operation()
        } catch {
            actionError = T4Privacy.redacted(developerErrorMessage(error))
        }
    }
}

private struct DeveloperPreview: Identifiable {
    static let safeActions: Set<String> = ["back", "forward", "reload", "close"]
    static let interactionActions: Set<String> = [
        "click", "fill", "type", "select", "press", "scroll", "upload", "handoff"
    ]
    private static let states: Set<String> = ["launching", "ready", "running", "stopped", "failed"]

    let id: String
    var title: String?
    var url: String
    var state: String
    var canGoBack: Bool
    var canGoForward: Bool
    var capture: DeveloperPreviewCapture?
    var captureData: Data?
    var captureMIMEType: String?
    var error: String?

    var displayTitle: String {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? url : trimmed
    }

    static func decodeList(_ result: [String: JSONValue]?) -> [DeveloperPreview] {
        guard let list = result?["previews"]?.arrayValue else { return [] }
        return list.compactMap { value in
            guard let object = value.objectValue else { return nil }
            return decode(object)
        }
    }

    static func decode(
        _ result: [String: JSONValue]?,
        fallbackID: String? = nil,
        fallbackURL: String = ""
    ) -> DeveloperPreview? {
        guard let result else { return nil }
        let object = result["preview"]?.objectValue ?? result
        guard let id = object["previewId"]?.stringValue ?? object["id"]?.stringValue ?? fallbackID,
              !id.isEmpty,
              let url = normalizedPreviewURL(object["url"]?.stringValue ?? fallbackURL) else { return nil }
        let state = object["state"]?.stringValue ?? "ready"
        guard states.contains(state) else { return nil }

        let capture: DeveloperPreviewCapture?
        if let captureObject = object["capture"]?.objectValue {
            guard let decoded = DeveloperPreviewCapture(captureObject) else { return nil }
            capture = decoded
        } else {
            capture = nil
        }

        return DeveloperPreview(
            id: id,
            title: object["title"]?.stringValue,
            url: url,
            state: state,
            canGoBack: object["canGoBack"]?.boolValue ?? false,
            canGoForward: object["canGoForward"]?.boolValue ?? false,
            capture: capture,
            captureData: nil,
            captureMIMEType: capture?.mimeType,
            error: object["error"]?.stringValue ?? object["message"]?.stringValue
        )
    }
}

private struct DeveloperPreviewCapture {
    private static let MIMETypeValues: Set<String> = ["image/png", "image/jpeg", "image/webp"]

    let id: String
    let mimeType: String
    let size: Int
    let width: Int
    let height: Int
    let sha256: String

    init?(_ object: [String: JSONValue]) {
        guard let id = object["captureId"]?.stringValue,
              !id.isEmpty,
              let mimeType = object["mimeType"]?.stringValue,
              Self.MIMETypeValues.contains(mimeType),
              let size = object["size"]?.intValue,
              (1...T4DeveloperDesign.previewCaptureMaximumBytes).contains(size),
              let width = object["width"]?.intValue,
              let height = object["height"]?.intValue,
              width > 0,
              height > 0,
              width <= T4DeveloperDesign.previewCaptureMaximumPixels,
              height <= T4DeveloperDesign.previewCaptureMaximumPixels,
              width * height <= T4DeveloperDesign.previewCaptureMaximumPixels,
              object["capturedAt"]?.intValue != nil,
              let sha256 = object["sha256"]?.stringValue,
              sha256.utf8.count == 64,
              sha256.utf8.allSatisfy({
                  ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
              }) else { return nil }
        self.id = id
        self.mimeType = mimeType
        self.size = size
        self.width = width
        self.height = height
        self.sha256 = sha256
    }
}

private func mergePreviews(_ incoming: [DeveloperPreview], into existing: [DeveloperPreview]) -> [DeveloperPreview] {
    var merged = existing
    for preview in incoming {
        if let index = merged.firstIndex(where: { $0.id == preview.id }) {
            var replacement = preview
            let previous = merged[index]
            if replacement.capture == nil {
                replacement.capture = previous.capture
                replacement.captureData = previous.captureData
                replacement.captureMIMEType = previous.captureMIMEType
            } else if replacement.capture?.id == previous.capture?.id, replacement.captureData == nil {
                replacement.captureData = previous.captureData
                replacement.captureMIMEType = previous.captureMIMEType
            }
            merged[index] = replacement
        } else {
            merged.append(preview)
        }
    }
    return merged
}

private func normalizedPreviewURL(_ source: String) -> String? {
    let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
          trimmed.utf8.count <= T4DeveloperDesign.previewURLMaximumBytes,
          let components = URLComponents(string: trimmed),
          let scheme = components.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          let host = components.host,
          !host.isEmpty,
          components.user == nil,
          components.password == nil else { return nil }
    return components.string
}

private func previewSHA256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func previewRasterIsValid(_ data: Data, capture: DeveloperPreviewCapture) -> Bool {
    let signatureIsValid: Bool
    switch capture.mimeType {
    case "image/png":
        signatureIsValid = data.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case "image/jpeg":
        signatureIsValid = data.starts(with: [0xff, 0xd8, 0xff])
    case "image/webp":
        signatureIsValid = data.starts(with: [0x52, 0x49, 0x46, 0x46]) &&
            data.dropFirst(8).starts(with: [0x57, 0x45, 0x42, 0x50])
    default:
        signatureIsValid = false
    }
    guard signatureIsValid,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return false }
    return image.width == capture.width && image.height == capture.height
}

@MainActor
private struct CapturedPlatformImage {
    let image: Image

#if os(macOS)
    init?(data: Data) {
        guard let value = NSImage(data: data) else { return nil }
        image = Image(nsImage: value)
    }
#elseif os(iOS)
    init?(data: Data) {
        guard let value = UIImage(data: data) else { return nil }
        image = Image(uiImage: value)
    }
#endif
}

@MainActor
private struct PreviewInteractionSheet: View {
    private static let templates: [String: String] = [
        "click": #"{"selector":"button"}"#,
        "fill": #"{"selector":"input","text":"value"}"#,
        "type": #"{"selector":"input","text":"value"}"#,
        "select": #"{"selector":"select","value":"option"}"#,
        "press": #"{"key":"Enter"}"#,
        "scroll": #"{"deltaX":0,"deltaY":480}"#,
        "upload": #"{"selector":"input[type=file]","path":"relative/file.txt"}"#,
        "handoff": #"{"message":"Complete this step","mode":"manual"}"#
    ]
    private static let inputActions = ["click", "fill", "type", "select", "press", "scroll", "upload"]

    let onSubmit: (String, [String: JSONValue]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var action: String
    @State private var arguments: String
    @State private var validationError: String?

    private let actions: [String]

    init(
        allowInput: Bool,
        allowHandoff: Bool,
        onSubmit: @escaping (String, [String: JSONValue]) -> Void
    ) {
        self.onSubmit = onSubmit
        let actions = (allowInput ? Self.inputActions : []) + (allowHandoff ? ["handoff"] : [])
        self.actions = actions
        let initialAction = actions.first ?? "click"
        self._action = State(initialValue: initialAction)
        self._arguments = State(initialValue: Self.templates[initialAction] ?? "{}")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Remote interaction") {
                    Picker("Action", selection: $action) {
                        ForEach(actions, id: \.self) { value in
                            Text(value.capitalized).tag(value)
                        }
                    }
                    .onChange(of: action) { _, value in
                        arguments = Self.templates[value] ?? "{}"
                        validationError = nil
                    }

                    TextEditor(text: $arguments)
                        .font(T4Typography.monospaced())
                        .frame(minHeight: T4DeveloperDesign.terminalOutputMinimumHeight / 2)
                        .accessibilityLabel("Preview interaction arguments in JSON")

                    if let validationError {
                        Text(validationError)
                            .foregroundStyle(T4Color.destructive)
                            .accessibilityLabel("Interaction arguments error: \(validationError)")
                    }
                }

                Section {
                    DeveloperNotice(
                        systemImage: "checkmark.shield",
                        message: "This sends a structured protocol action to the host. Captured page code is never evaluated in this app."
                    )
                }
            }
            .navigationTitle("Preview interaction")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { submit() }
                        .disabled(actions.isEmpty)
                }
            }
        }
    }

    private func submit() {
        do {
            let value = try previewArguments(arguments)
            guard value["previewId"] == nil else {
                throw DeveloperSurfaceError("Arguments cannot override the selected preview.")
            }
            onSubmit(action, value)
        } catch {
            validationError = developerErrorMessage(error)
        }
    }
}

private func previewArguments(_ source: String) throws -> [String: JSONValue] {
    guard let data = source.data(using: .utf8),
          data.count <= T4DeveloperDesign.previewInteractionMaximumBytes else {
        throw DeveloperSurfaceError("Arguments must be a bounded UTF-8 JSON object.")
    }
    let foundation: Any
    do {
        foundation = try JSONSerialization.jsonObject(with: data)
    } catch {
        throw DeveloperSurfaceError("Arguments must be a valid JSON object.")
    }
    guard let object = foundation as? [String: Any] else {
        throw DeveloperSurfaceError("Arguments must be a JSON object.")
    }
    return try object.mapValues(jsonValue)
}

private func jsonValue(_ value: Any) throws -> JSONValue {
    if value is NSNull { return .null }
    if let value = value as? Bool { return .bool(value) }
    if let value = value as? String { return .string(value) }
    if let value = value as? NSNumber {
        let number = value.doubleValue
        guard number.isFinite, abs(number) <= 9_007_199_254_740_991 else {
            throw DeveloperSurfaceError("Arguments contain an unsafe number.")
        }
        return .number(number)
    }
    if let value = value as? [Any] {
        return .array(try value.map(jsonValue))
    }
    if let value = value as? [String: Any] {
        return .object(try value.mapValues(jsonValue))
    }
    throw DeveloperSurfaceError("Arguments contain an unsupported JSON value.")
}

private extension View {
    @ViewBuilder
    func keyboardTypeURL() -> some View {
        #if os(iOS)
        self.keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        #else
        self
        #endif
    }
}
