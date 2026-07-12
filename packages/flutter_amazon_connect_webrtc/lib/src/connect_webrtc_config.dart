import 'package:meta/meta.dart';

/// Provides a short-lived bearer token for the backend. The host app owns authentication; the
/// plugin never persists the token (FR-F7). Return an empty string to send no Authorization header
/// (e.g. when the API is fronted by other means).
typedef TokenProvider = Future<String> Function();

/// Static configuration for [ConnectWebRtcController]. Contains only the backend base URL and call
/// tunables — never AWS endpoints or credentials.
@immutable
class ConnectWebRtcConfig {
  const ConnectWebRtcConfig({
    required this.backendBaseUrl,
    this.requestTimeout = const Duration(seconds: 15),
    this.maxStartAttempts = 3,
    this.callKitEnabled = false,
    this.callDisplayName = 'Support',
  });

  /// e.g. `https://abc.execute-api.eu-west-2.amazonaws.com/v1`.
  final Uri backendBaseUrl;

  /// Per-HTTP-request timeout.
  final Duration requestTimeout;

  /// How many times `startCall` retries the backend on throttling/5xx (reusing one idempotency key).
  final int maxStartAttempts;

  /// When true, the plugin reports the call to the OS system-call UI — **CallKit** on iOS and a
  /// self-managed **Telecom `ConnectionService`** on Android — so it behaves like a native phone
  /// call ("like WhatsApp"): lock-screen controls, correct audio routing, interop with cellular
  /// calls. The host app must declare the matching entitlements/permissions (see the host READMEs).
  final bool callKitEnabled;

  /// Name shown in the OS call UI (CallKit/Telecom), e.g. "Support" or your brand.
  final String callDisplayName;
}
