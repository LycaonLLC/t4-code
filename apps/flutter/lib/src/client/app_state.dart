import 'dart:typed_data';

import '../host/host_profile.dart';

enum ConnectionPhase {
  disconnected,
  connecting,
  synchronizing,
  ready,
  retrying,
  failed,
}

enum AuthenticationPhase { unknown, local, pairingRequired, pairing, paired }

const List<String> t4RequestedCapabilities = <String>[
  'sessions.read',
  'sessions.prompt',
  'sessions.control',
  'sessions.manage',
];

final String t4PairCommand = <String>[
  'omp appserver pair',
  for (final capability in t4RequestedCapabilities) '--capability $capability',
].join(' ');

enum MessageRole { user, assistant, system, tool }

enum TranscriptKind { message, tool, compaction, notice }

final class TranscriptImageMetadata {
  const TranscriptImageMetadata({required this.sha256, required this.mimeType});

  final String sha256;
  final String mimeType;
}

final class SessionSummary {
  const SessionSummary({
    required this.hostId,
    required this.sessionId,
    required this.title,
    required this.revision,
    required this.status,
    this.projectId = 'unknown-project',
    this.projectName = 'Project',
    this.updatedAt = '',
    this.archivedAt,
    this.working = false,
    this.modelSelector,
    this.modelDisplayName,
    this.thinking,
    this.thinkingLevels = const <String>[],
    this.fast = false,
    this.fastAvailable = false,
    this.turnActive = false,
    this.queuedFollowUpCount = 0,
  });

  final String hostId;
  final String sessionId;
  final String title;
  final String revision;
  final String status;
  final String projectId;
  final String projectName;
  final String updatedAt;
  final String? archivedAt;
  final bool working;
  final String? modelSelector;
  final String? modelDisplayName;
  final String? thinking;
  final List<String> thinkingLevels;
  final bool fast;
  final bool fastAvailable;
  final bool turnActive;
  final int queuedFollowUpCount;

  bool get archived => archivedAt != null;
}

final class TranscriptMessage {
  const TranscriptMessage({
    required this.id,
    required this.role,
    required this.text,
    this.kind = TranscriptKind.message,
    this.reasoning = '',
    this.streaming = false,
    this.toolName,
    this.toolTitle,
    this.toolArguments,
    this.toolOutput,
    this.toolSucceeded,
    this.toolRunning = false,
    this.toolProgress,
    this.images = const <TranscriptImageMetadata>[],
  });

  final String id;
  final MessageRole role;
  final String text;
  final TranscriptKind kind;
  final String reasoning;
  final bool streaming;
  final String? toolName;
  final String? toolTitle;
  final String? toolArguments;
  final String? toolOutput;
  final bool? toolSucceeded;
  final bool toolRunning;
  final double? toolProgress;
  final List<TranscriptImageMetadata> images;
}

final class ComposerModelChoice {
  const ComposerModelChoice({
    required this.label,
    required this.selector,
    this.supported = true,
    this.reason,
  });

  final String label;
  final String selector;
  final bool supported;
  final String? reason;
}

final class ComposerSlashCommand {
  const ComposerSlashCommand({
    required this.name,
    required this.description,
    required this.insert,
    this.disabledReason,
  });

  final String name;
  final String description;
  final String insert;
  final String? disabledReason;
}

final class SessionComposerState {
  const SessionComposerState({
    this.modelLabel,
    this.modelSelector,
    this.modelChoices = const <ComposerModelChoice>[],
    this.slashCommands = const <ComposerSlashCommand>[],
    this.thinking,
    this.thinkingLevels = const <String>[],
    this.fastEnabled = false,
    this.fastAvailable = false,
    this.turnActive = false,
    this.queuedFollowUpCount = 0,
  });

  final String? modelLabel;
  final String? modelSelector;
  final List<ComposerModelChoice> modelChoices;
  final List<ComposerSlashCommand> slashCommands;
  final String? thinking;
  final List<String> thinkingLevels;
  final bool fastEnabled;
  final bool fastAvailable;
  final bool turnActive;
  final int queuedFollowUpCount;
}

final class PromptImageAttachment {
  const PromptImageAttachment({
    required this.id,
    required this.name,
    required this.mimeType,
    required this.bytes,
  });

  final String id;
  final String name;
  final String mimeType;
  final Uint8List bytes;
}

enum AttentionKind {
  approval,
  question,
  plan,
  confirmation,
  completed,
  failed,
  cancelled,
}

enum AttentionDecision { approve, deny, revise, reject }

final class AttentionChoice {
  const AttentionChoice({required this.id, required this.label});

  final String id;
  final String label;
}

final class AttentionItem {
  const AttentionItem({
    required this.key,
    required this.kind,
    required this.sessionId,
    required this.sessionTitle,
    required this.revision,
    required this.title,
    required this.summary,
    required this.at,
    this.requestId,
    this.confirmationId,
    this.commandId,
    this.expiresAt,
    this.choices = const <AttentionChoice>[],
    this.allowText = false,
    this.actionable = false,
  });

  final String key;
  final AttentionKind kind;
  final String sessionId;
  final String sessionTitle;
  final String revision;
  final String title;
  final String summary;
  final DateTime at;
  final String? requestId;
  final String? confirmationId;
  final String? commandId;
  final DateTime? expiresAt;
  final List<AttentionChoice> choices;
  final bool allowText;
  final bool actionable;

  bool get needsResponse =>
      kind == AttentionKind.approval ||
      kind == AttentionKind.question ||
      kind == AttentionKind.plan ||
      kind == AttentionKind.confirmation;

  bool get isProblem =>
      kind == AttentionKind.failed || kind == AttentionKind.cancelled;
}

final class AgentActivity {
  const AgentActivity({
    required this.agentId,
    required this.sessionId,
    required this.label,
    required this.status,
    required this.updatedAt,
    this.progress,
  });

  final String agentId;
  final String sessionId;
  final String label;
  final String status;
  final DateTime updatedAt;
  final double? progress;
}

final class AttentionResponse {
  const AttentionResponse({
    required this.decision,
    this.optionIds = const <String>[],
    this.text = '',
  });

  final AttentionDecision decision;
  final List<String> optionIds;
  final String text;
}

final class T4ViewState {
  const T4ViewState({
    required this.connectionPhase,
    this.sessions = const <SessionSummary>[],
    this.selectedSessionId,
    this.messages = const <TranscriptMessage>[],
    this.errorMessage,
    this.hostDirectory = const HostDirectory.empty(),
    this.authenticationPhase = AuthenticationPhase.unknown,
    this.grantedCapabilities = const <String>{},
    this.grantedFeatures = const <String>{},
    this.targetConfigured = false,
    this.hostOperationPending = false,
    this.submitting = false,
    this.sessionOperationPending = false,
    this.composer = const SessionComposerState(),
    this.attentionItems = const <AttentionItem>[],
    this.agentActivities = const <AgentActivity>[],
    this.attentionPartial = false,
    this.omittedAttentionCount = 0,
  });

  const T4ViewState.disconnected()
    : this(connectionPhase: ConnectionPhase.disconnected);

  final ConnectionPhase connectionPhase;
  final List<SessionSummary> sessions;
  final String? selectedSessionId;
  final List<TranscriptMessage> messages;
  final String? errorMessage;
  final HostDirectory hostDirectory;
  final AuthenticationPhase authenticationPhase;
  final Set<String> grantedCapabilities;
  final Set<String> grantedFeatures;
  final bool targetConfigured;
  final bool hostOperationPending;
  final bool submitting;
  final bool sessionOperationPending;
  final SessionComposerState composer;
  final List<AttentionItem> attentionItems;
  final List<AgentActivity> agentActivities;
  final bool attentionPartial;
  final int omittedAttentionCount;

  int get urgentAttentionCount =>
      attentionItems.where((item) => item.needsResponse).length +
      omittedAttentionCount;

  SessionSummary? get selectedSession {
    for (final session in sessions) {
      if (session.sessionId == selectedSessionId) return session;
    }
    return null;
  }
}

abstract interface class T4Actions {
  Future<void> connect();
  Future<void> disconnect();

  void cancelHostProbe();

  Future<void> addHost(
    String address, {
    String profileId = defaultHostProfileId,
  });

  Future<void> activateHost(String endpointKey);

  Future<void> removeHost(String endpointKey);

  Future<void> pairHost(String code);

  Future<void> selectSession(String sessionId);
  Future<void> createSession(String projectId, {String? title});

  Future<void> renameSession(String sessionId, String title);

  Future<void> terminateSession(String sessionId);

  Future<void> archiveSession(String sessionId);

  Future<void> restoreSession(String sessionId);

  Future<void> deleteSession(String sessionId);

  Future<bool> submitPrompt(
    String message, {
    List<PromptImageAttachment> images = const <PromptImageAttachment>[],
  });

  Future<bool> queuePrompt(String message);

  Future<void> cancelTurn();

  Future<void> setSessionModel(String selector);

  Future<void> setSessionThinking(String level);

  Future<void> setSessionFast(bool enabled);

  Future<bool> respondToAttention(
    AttentionItem item,
    AttentionResponse response,
  );

  Future<void> retrySession(String sessionId);

  Future<Uint8List> readTranscriptImage(
    String entryId,
    TranscriptImageMetadata image,
  );
}
