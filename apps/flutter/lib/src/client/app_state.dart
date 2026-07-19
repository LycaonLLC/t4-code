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

  bool get archived => archivedAt != null;
}

final class TranscriptMessage {
  const TranscriptMessage({
    required this.id,
    required this.role,
    required this.text,
    this.streaming = false,
  });

  final String id;
  final MessageRole role;
  final String text;
  final bool streaming;
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

  Future<void> submitPrompt(String message);
}
