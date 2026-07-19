enum ConnectionPhase {
  disconnected,
  connecting,
  synchronizing,
  ready,
  retrying,
  failed,
}

enum MessageRole { user, assistant, system, tool }

final class SessionSummary {
  const SessionSummary({
    required this.hostId,
    required this.sessionId,
    required this.title,
    required this.revision,
    required this.status,
  });

  final String hostId;
  final String sessionId;
  final String title;
  final String revision;
  final String status;
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

final class ProofViewState {
  const ProofViewState({
    required this.connectionPhase,
    this.sessions = const <SessionSummary>[],
    this.selectedSessionId,
    this.messages = const <TranscriptMessage>[],
    this.errorMessage,
    this.submitting = false,
  });

  const ProofViewState.disconnected()
    : this(connectionPhase: ConnectionPhase.disconnected);

  final ConnectionPhase connectionPhase;
  final List<SessionSummary> sessions;
  final String? selectedSessionId;
  final List<TranscriptMessage> messages;
  final String? errorMessage;
  final bool submitting;

  SessionSummary? get selectedSession {
    for (final session in sessions) {
      if (session.sessionId == selectedSessionId) return session;
    }
    return null;
  }
}

abstract interface class ProofActions {
  Future<void> connect();

  Future<void> selectSession(String sessionId);

  Future<void> submitPrompt(String message);
}
