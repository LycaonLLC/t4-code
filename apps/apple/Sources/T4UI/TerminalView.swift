import Foundation
import SwiftUI
import T4Client
import T4Protocol

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

@MainActor
public struct TerminalView: View {
    private let controller: T4ClientController

    @State private var terminals: [DeveloperTerminalSession] = []
    @State private var selectedTerminalID: String?
    @State private var input = ""
    @State private var columns = T4DeveloperDesign.terminalDefaultColumns
    @State private var rows = T4DeveloperDesign.terminalDefaultRows
    @State private var busyAction: String?
    @State private var actionError: String?
    @State private var pendingPaste = ""
    @State private var showPasteConfirmation = false
    @FocusState private var inputFocused: Bool

    public init(controller: T4ClientController) {
        self.controller = controller
    }

    public var body: some View {
        Group {
            if !isConnected && terminals.isEmpty {
                offlineState
            } else if !hasCapability("term.open") && terminals.isEmpty {
                DeveloperEmptyState(
                    systemImage: "lock",
                    title: "Terminal is unavailable",
                    detail: "The paired host did not grant term.open access."
                )
            } else {
                GeometryReader { proxy in
                    if proxy.size.width >= T4Layout.wideBreakpoint {
                        HStack(spacing: 0) {
                            controlPane
                                .frame(width: T4DeveloperDesign.terminalControlWidth)
                            Divider()
                            outputPane
                        }
                    } else {
                        VStack(spacing: 0) {
                            controlPane
                            Divider()
                            outputPane
                                .frame(minHeight: T4DeveloperDesign.terminalOutputMinimumHeight)
                        }
                    }
                }
            }
        }
        .background(T4Color.background)
        .onChange(of: selectedTerminalID) { _, _ in
            guard let terminal = selectedTerminal else { return }
            columns = terminal.columns
            rows = terminal.rows
        }
        .alert("Paste into terminal?", isPresented: $showPasteConfirmation) {
            Button("Cancel", role: .cancel) {
                pendingPaste = ""
            }
            Button("Paste") {
                let value = pendingPaste
                pendingPaste = ""
                Task { await sendInput(value, source: "paste") }
            }
        } message: {
            Text(pasteWarning)
        }
    }

    private var offlineState: some View {
        DeveloperEmptyState(
            systemImage: "network.slash",
            title: "Terminal is offline",
            detail: "Reconnect to open a protocol-backed terminal for the selected session."
        ) {
            AnyView(
                Button {
                    Task { await controller.connect() }
                } label: {
                    Label("Reconnect", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
                .disabled(controller.state.connection == .connecting || controller.state.connection == .reconnecting)
            )
        }
    }

    private var controlPane: some View {
        VStack(spacing: 0) {
            terminalStrip
            Divider()
            if let actionError {
                DeveloperErrorBanner(message: actionError) {
                    self.actionError = nil
                }
            }
            if busyAction != nil {
                ProgressView()
                    .progressViewStyle(.linear)
                    .accessibilityLabel("Terminal operation in progress")
            }

            if selectedTerminal == nil {
                DeveloperEmptyState(
                    systemImage: "apple.terminal",
                    title: "No terminal open",
                    detail: selectedSessionAvailable
                        ? "Open a terminal to run commands on the paired host."
                        : "Select a conversation before opening a terminal."
                ) {
                    AnyView(
                        Button {
                            Task { await openTerminal() }
                        } label: {
                            Label("Open Terminal", systemImage: "plus")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!canOpen)
                    )
                }
            } else {
                terminalControls
            }
        }
        .background(T4Color.raised)
    }

    private var terminalStrip: some View {
        HStack(spacing: T4Spacing.xs) {
            Picker("Active terminal", selection: $selectedTerminalID) {
                Text("No terminal").tag(String?.none)
                ForEach(terminals) { terminal in
                    Text(terminal.title).tag(String?.some(terminal.id))
                }
            }
            .pickerStyle(.menu)
            .disabled(terminals.isEmpty || busyAction != nil)
            .accessibilityLabel("Select terminal")

            Spacer()

            Button {
                Task { await openTerminal() }
            } label: {
                Image(systemName: "plus")
            }
            .disabled(!canOpen)
            .accessibilityLabel("Open terminal")

            Button(role: .destructive) {
                Task { await closeSelectedTerminal() }
            } label: {
                Image(systemName: "xmark")
            }
            .disabled(!canClose || busyAction != nil)
            .accessibilityLabel("Close selected terminal")
        }
        .padding(T4Spacing.sm)
    }

    private var terminalControls: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: T4Spacing.md) {
                terminalStatus

                VStack(alignment: .leading, spacing: T4Spacing.xs) {
                    Text("Input")
                        .font(T4Typography.heading(.subheadline))
                    TextField("Command", text: $input, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .font(T4Typography.monospaced())
                        .lineLimit(1...4)
                        .focused($inputFocused)
                        .disabled(!canInput || busyAction != nil)
                        .onSubmit {
                            Task { await sendTypedInput() }
                        }
                        .accessibilityLabel("Terminal input")
                        .accessibilityHint("Press Return or choose Send to submit this command")

                    HStack {
                        Button {
                            preparePaste()
                        } label: {
                            Label("Paste", systemImage: "doc.on.clipboard")
                        }
                        .disabled(!canInput || busyAction != nil)
                        .accessibilityHint("Shows a confirmation before clipboard text is sent")

                        Spacer()

                        Button {
                            Task { await sendTypedInput() }
                        } label: {
                            Label("Send", systemImage: "paperplane.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(input.isEmpty || !canInput || busyAction != nil)
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: T4Spacing.sm) {
                    Text("Terminal size")
                        .font(T4Typography.heading(.subheadline))
                    Stepper(
                        "Columns: \(columns)",
                        value: $columns,
                        in: 1...T4DeveloperDesign.terminalMaximumColumns
                    )
                        .disabled(!canResize || busyAction != nil)
                    Stepper(
                        "Rows: \(rows)",
                        value: $rows,
                        in: 1...T4DeveloperDesign.terminalMaximumRows
                    )
                        .disabled(!canResize || busyAction != nil)
                    Button {
                        Task { await resizeTerminal() }
                    } label: {
                        Label("Apply Size", systemImage: "arrow.up.left.and.arrow.down.right")
                    }
                    .disabled(!canResize || busyAction != nil)
                }

                if !hasCapability("term.input") {
                    DeveloperNotice(
                        systemImage: "lock",
                        message: "This terminal is read-only because term.input access is unavailable."
                    )
                } else if !hasCapability("term.resize") {
                    DeveloperNotice(
                        systemImage: "lock",
                        message: "The paired host did not grant term.resize access."
                    )
                }
            }
            .padding(T4Spacing.md)
        }
    }

    private var terminalStatus: some View {
        HStack(spacing: T4Spacing.sm) {
            Image(systemName: isConnected ? "circle.fill" : "exclamationmark.circle.fill")
                .font(.caption)
                .foregroundStyle(isConnected ? T4Color.success : T4Color.warning)
            VStack(alignment: .leading, spacing: T4Spacing.xxs) {
                Text(selectedTerminal?.title ?? "Terminal")
                    .font(T4Typography.heading(.subheadline))
                Text(isConnected ? "Connected through omp-app terminal I/O" : "Offline · input is disabled")
                    .font(T4Typography.body(.caption))
                    .foregroundStyle(T4Color.secondaryText)
            }
            Spacer()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isConnected ? "Terminal connected" : "Terminal offline and read only")
    }

    private var outputPane: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Terminal output")
                    .font(T4Typography.heading())
                Spacer()
                if let selectedTerminal {
                    Text("\(selectedTerminal.columns) × \(selectedTerminal.rows)")
                        .font(T4Typography.monospaced(.caption))
                        .foregroundStyle(T4Color.mutedText)
                        .accessibilityLabel("\(selectedTerminal.columns) columns by \(selectedTerminal.rows) rows")
                }
            }
            .padding(T4Spacing.sm)
            .background(T4Color.raised)
            Divider()

            if let selectedTerminal {
                ScrollView([.horizontal, .vertical]) {
                    Text(selectedTerminal.output.isEmpty ? "Terminal opened. Host output will appear as protocol events arrive." : selectedTerminal.output)
                        .font(T4Typography.monospaced())
                        .foregroundStyle(T4Color.foreground)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(T4Spacing.md)
                }
                .background(T4Color.input)
                .accessibilityLabel("Terminal output for \(selectedTerminal.title)")
            } else {
                DeveloperEmptyState(
                    systemImage: "text.alignleft",
                    title: "No terminal selected",
                    detail: "Open or select a terminal to inspect its output."
                )
            }
        }
    }

    private var selectedTerminal: DeveloperTerminalSession? {
        guard let selectedTerminalID else { return nil }
        return terminals.first { $0.id == selectedTerminalID }
    }

    private var selectedSessionAvailable: Bool {
        controller.state.selectedSessionID != nil
    }

    private var isConnected: Bool {
        controller.state.connection == .connected
    }

    private var canOpen: Bool {
        selectedSessionAvailable && isConnected && hasCapability("term.open") && busyAction == nil
    }

    private var canInput: Bool {
        guard let terminal = selectedTerminal else { return false }
        return terminal.isRunning &&
            terminal.sessionID == controller.state.selectedSessionID &&
            isConnected &&
            hasCapability("term.input")
    }

    private var canResize: Bool {
        guard let terminal = selectedTerminal else { return false }
        return terminal.isRunning &&
            terminal.sessionID == controller.state.selectedSessionID &&
            isConnected &&
            hasCapability("term.resize")
    }

    private var canClose: Bool {
        selectedTerminal != nil && isConnected && hasCapability("term.open")
    }

    private var pasteWarning: String {
        let lines = pendingPaste.split(separator: "\n", omittingEmptySubsequences: false).count
        let preview = pendingPaste.count > T4DeveloperDesign.terminalPastePreviewLength
            ? String(pendingPaste.prefix(T4DeveloperDesign.terminalPastePreviewLength)) + "…"
            : pendingPaste
        return "\(lines) \(lines == 1 ? "line" : "lines") may execute immediately. Review before sending:\n\n\(preview)"
    }

    private func hasCapability(_ capability: String) -> Bool {
        DeveloperCapabilities.allows(capability, state: controller.state)
    }

    private func openTerminal() async {
        guard canOpen, let sessionID = controller.state.selectedSessionID else { return }
        await perform("term.open") {
            let response = try await controller.command(
                "term.open",
                sessionID: sessionID,
                args: ["cols": .integer(columns), "rows": .integer(rows)]
            )
            guard let terminalID = response.result?["terminalId"]?.stringValue else {
                throw DeveloperSurfaceError("The host opened no terminal identifier.")
            }
            if !terminals.contains(where: { $0.id == terminalID }) {
                terminals.append(
                    DeveloperTerminalSession(
                        id: terminalID,
                        sessionID: sessionID,
                        title: response.result?["title"]?.stringValue ?? "Terminal \(terminals.count + 1)",
                        output: response.result?["output"]?.stringValue ?? "",
                        columns: columns,
                        rows: rows,
                        isRunning: true
                    )
                )
            }
            selectedTerminalID = terminalID
            inputFocused = true
        }
    }

    private func sendTypedInput() async {
        guard !input.isEmpty else { return }
        let pendingInput = input
        let command = pendingInput.hasSuffix("\n") ? pendingInput : pendingInput + "\n"
        if await sendInput(command, source: "typed") {
            input = ""
        }
    }

    @discardableResult
    private func sendInput(_ data: String, source: String) async -> Bool {
        guard let terminal = selectedTerminal,
              canInput,
              let hostID = controller.hostID else { return false }
        return await perform("terminal.input") {
            let encodedFrame = try WireEncoder.terminalInput(
                hostId: hostID,
                sessionId: terminal.sessionID,
                terminalId: terminal.id,
                data: data
            )
            try await controller.transport.send(try WireDecoder.decode(encodedFrame))
            appendOutput(data, to: terminal.id, source: source)
        }
    }

    private func resizeTerminal() async {
        guard let terminal = selectedTerminal,
              canResize,
              let hostID = controller.hostID else { return }
        await perform("terminal.resize") {
            let encodedFrame = try WireEncoder.terminalResize(
                hostId: hostID,
                sessionId: terminal.sessionID,
                terminalId: terminal.id,
                cols: columns,
                rows: rows
            )
            try await controller.transport.send(try WireDecoder.decode(encodedFrame))
            guard let index = terminals.firstIndex(where: { $0.id == terminal.id }) else { return }
            terminals[index].columns = columns
            terminals[index].rows = rows
        }
    }

    private func closeSelectedTerminal() async {
        guard let terminal = selectedTerminal,
              canClose,
              let hostID = controller.hostID else { return }
        await perform("terminal.close") {
            let encodedFrame = try WireEncoder.terminalClose(
                hostId: hostID,
                sessionId: terminal.sessionID,
                terminalId: terminal.id,
                reason: "user"
            )
            try await controller.transport.send(try WireDecoder.decode(encodedFrame))
            terminals.removeAll { $0.id == terminal.id }
            selectedTerminalID = terminals.last?.id
        }
    }

    private func preparePaste() {
        guard canInput else { return }
        guard let clipboardText = terminalClipboardText(), !clipboardText.isEmpty else {
            actionError = "The clipboard does not contain text."
            return
        }
        pendingPaste = clipboardText
        showPasteConfirmation = true
    }

    private func appendOutput(_ value: String, to terminalID: String, source: String) {
        guard let index = terminals.firstIndex(where: { $0.id == terminalID }) else { return }
        let marker: String
        switch source {
        case "paste": marker = "[pasted] "
        case "typed": marker = "> "
        default: marker = ""
        }
        terminals[index].output += marker + value
        if terminals[index].output.count > T4DeveloperDesign.terminalOutputLimit {
            terminals[index].output = String(terminals[index].output.suffix(T4DeveloperDesign.terminalOutputLimit))
        }
    }

    @discardableResult
    private func perform(_ name: String, operation: @escaping @MainActor () async throws -> Void) async -> Bool {
        guard busyAction == nil else { return false }
        busyAction = name
        actionError = nil
        defer { busyAction = nil }
        do {
            try await operation()
            return true
        } catch {
            actionError = developerErrorMessage(error)
            return false
        }
    }
}

#if os(macOS)
@MainActor
private func terminalClipboardText() -> String? {
    NSPasteboard.general.string(forType: .string)
}
#elseif os(iOS)
@MainActor
private func terminalClipboardText() -> String? {
    UIPasteboard.general.string
}
#endif

private struct DeveloperTerminalSession: Identifiable {
    let id: String
    let sessionID: String
    let title: String
    var output: String
    var columns: Int
    var rows: Int
    var isRunning: Bool
}
