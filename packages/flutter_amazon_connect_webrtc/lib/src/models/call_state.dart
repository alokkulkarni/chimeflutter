/// Lifecycle of a call, exposed to the host via `controller.state` / `controller.states`.
///
/// Overlay states (`idle`, `connecting`, `ringing`) are owned by the Dart controller; from
/// `connected` onwards the native Chime session drives transitions.
enum CallState {
  /// No call in progress.
  idle,

  /// Fetching join credentials from the backend.
  connecting,

  /// Credentials obtained; joining the media session (waiting for audio to start).
  ringing,

  /// Media session established — audio (and video, if requested) is flowing.
  connected,

  /// Media dropped; the Chime SDK is attempting to reconnect.
  reconnecting,

  /// Call ended normally.
  disconnected,

  /// Call could not be established or failed fatally.
  failed;

  bool get isActive =>
      this == CallState.connecting ||
      this == CallState.ringing ||
      this == CallState.connected ||
      this == CallState.reconnecting;

  bool get isTerminal => this == CallState.disconnected || this == CallState.failed;

  /// Parses a native `stateChanged` wire value. The native side emits a subset
  /// (`connecting,connected,reconnecting,disconnected,failed`).
  static CallState fromWire(String value) {
    switch (value) {
      case 'connecting':
        return CallState.connecting;
      case 'connected':
        return CallState.connected;
      case 'reconnecting':
        return CallState.reconnecting;
      case 'disconnected':
        return CallState.disconnected;
      case 'failed':
        return CallState.failed;
      case 'ringing':
        return CallState.ringing;
      case 'idle':
        return CallState.idle;
      default:
        throw ArgumentError('Unknown call state: $value');
    }
  }
}
