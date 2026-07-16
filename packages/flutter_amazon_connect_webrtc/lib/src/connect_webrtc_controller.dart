import 'dart:async';

import 'package:flutter/foundation.dart';

import 'backend_client.dart';
import 'call_platform.dart';
import 'connect_webrtc_config.dart';
import 'exceptions.dart';
import 'models/call_event.dart';
import 'models/call_models.dart';
import 'models/call_state.dart';
import 'permission_service.dart';

/// The plugin's public entry point. Owns the call state machine and orchestrates the three
/// collaborators: [PermissionService] → [BackendClient] → [CallPlatform] (native Chime SDK).
///
/// State machine (Dart-owned overlay in brackets, native-driven after):
/// `[idle] → [connecting] → [ringing] → connected → (reconnecting ↔ connected) → disconnected|failed`
class ConnectWebRtcController {
  ConnectWebRtcController({
    required ConnectWebRtcConfig config,
    required TokenProvider tokenProvider,
    BackendClient? backendClient,
    CallPlatform? platform,
    PermissionService? permissionService,
  })  : _config = config,
        _backend = backendClient ??
            BackendClient(
              baseUrl: config.backendBaseUrl,
              tokenProvider: tokenProvider,
              timeout: config.requestTimeout,
              maxAttempts: config.maxStartAttempts,
            ),
        _platform = platform ?? MethodChannelCallPlatform(),
        _permissions = permissionService ?? const DefaultPermissionService() {
    _stateSub = _platform.states.listen(_onNativeState);
    _eventSub = _platform.events.listen(_onNativeEvent);
  }

  final ConnectWebRtcConfig _config;
  final BackendClient _backend;
  final CallPlatform _platform;
  final PermissionService _permissions;

  late final StreamSubscription<CallState> _stateSub;
  late final StreamSubscription<CallEvent> _eventSub;

  final ValueNotifier<CallState> _state = ValueNotifier<CallState>(CallState.idle);
  final StreamController<CallState> _states = StreamController<CallState>.broadcast();
  final StreamController<CallEvent> _events = StreamController<CallEvent>.broadcast();

  CallSession? _session;

  /// Current state (for `ValueListenableBuilder`).
  ValueListenable<CallState> get state => _state;

  /// Stream of state transitions.
  Stream<CallState> get states => _states.stream;

  /// Stream of discrete call events.
  Stream<CallEvent> get events => _events.stream;

  /// The active session, if any (contains the contactId, useful for support/diagnostics).
  CallSession? get session => _session;

  bool get isInCall => _state.value.isActive;

  /// Starts a call: verify permissions → fetch join credentials → join the native media session.
  /// Throws [PermissionDeniedException], [AuthException], [RateLimitedException], [BackendException]
  /// or [MediaException] on failure, and leaves the state at `failed`.
  Future<void> startCall(CallRequest request) async {
    if (_state.value.isActive) {
      throw StateError('A call is already in progress');
    }
    _setState(CallState.connecting);

    final granted = await _permissions.ensureCallPermissions(request.callType);
    if (!granted) {
      _setState(CallState.failed);
      throw const PermissionDeniedException();
    }

    final CallSession session;
    try {
      // One idempotency key for this logical call — reused across the backend's internal retries.
      final idempotencyKey = _backend.newIdempotencyKey();
      session = await _backend.startCall(
        request,
        idempotencyKey: idempotencyKey,
        correlationId: _newCorrelationId(),
      );
    } catch (_) {
      _setState(CallState.failed);
      rethrow;
    }

    _session = session;
    _setState(CallState.ringing);

    try {
      await _platform.join(
        session,
        callKitEnabled: _config.callKitEnabled,
        callDisplayName: _config.callDisplayName,
      );
      // `connected` arrives asynchronously via the native `stateChanged` event.
    } catch (_) {
      _setState(CallState.failed);
      rethrow;
    }
  }

  /// Shows the OS incoming-call UI for a simulated-outbound push received on the Dart side
  /// (Android FCM via e.g. `firebase_messaging`). On iOS the host app's PushKit delegate must
  /// report the call natively instead — see docs/OUTBOUND_CALLS.md.
  Future<void> reportIncomingCall({
    required String callId,
    required String displayName,
    bool isVideo = false,
    int timeoutSeconds = 45,
  }) =>
      _platform.reportIncomingCall(
        callId: callId,
        displayName: displayName,
        isVideo: isVideo,
        timeoutSeconds: timeoutSeconds,
      );

  /// Answers a ringing simulated-outbound call: verify permissions → exchange [callId] for the
  /// join credentials (`POST /calls/outbound/{callId}/answer`) → attach the media to the call the
  /// OS is already showing. Call this from your [IncomingCallAnswered] event handler.
  ///
  /// Throws [PermissionDeniedException], [InvalidRequestException] (410 when the call is no longer
  /// ringing), [AuthException], [BackendException] or [MediaException], leaving state `failed`.
  Future<void> answerIncomingCall({required String callId, CallType callType = CallType.audio}) async {
    if (_state.value.isActive) {
      throw StateError('A call is already in progress');
    }
    _setState(CallState.connecting);

    final granted = await _permissions.ensureCallPermissions(callType);
    if (!granted) {
      _setState(CallState.failed);
      throw const PermissionDeniedException();
    }

    final CallSession session;
    try {
      session = await _backend.answerOutboundCall(callId, correlationId: _newCorrelationId());
    } catch (_) {
      _setState(CallState.failed);
      rethrow;
    }

    _session = session;
    try {
      await _platform.join(
        session,
        callKitEnabled: _config.callKitEnabled,
        callDisplayName: _config.callDisplayName,
        asIncoming: true,
      );
      // `connected` arrives asynchronously via the native `stateChanged` event.
    } catch (_) {
      _setState(CallState.failed);
      rethrow;
    }
  }

  /// Declines a ringing simulated-outbound call: dismisses the ring UI (best-effort) and tells the
  /// backend to stop the contact so the waiting agent is released immediately. Call this from your
  /// [IncomingCallDeclined] handler (or an in-app decline button).
  Future<void> declineIncomingCall(String callId) async {
    try {
      await _platform.dismissIncomingCall();
    } catch (_) {
      // Ring UI may already be gone — the backend decline is what matters.
    }
    await _backend.declineOutboundCall(callId, correlationId: _newCorrelationId());
  }

  /// Cold-start recovery: when the user answered the OS ring UI before Flutter was running, the
  /// native side parks the answer. Call this once at startup; it answers the parked call and
  /// returns true, or returns false when there is nothing pending.
  Future<bool> handlePendingIncomingCall() async {
    final pending = await _platform.getPendingIncomingCall();
    final callId = pending?['callId'] as String?;
    if (callId == null || callId.isEmpty) return false;
    final isVideo = (pending?['isVideo'] as bool?) ?? false;
    await answerIncomingCall(
      callId: callId,
      callType: isVideo ? CallType.video : CallType.audio,
    );
    return true;
  }

  Future<void> endCall() async {
    final session = _session;
    try {
      await _platform.leave();
    } finally {
      if (session != null) {
        // Best-effort server-side stop; never block or fail the local teardown on it.
        unawaited(_backend.endCall(session.contactId).catchError((Object _) {}));
      }
      _session = null;
      _participantConnectionToken = null;
      _setState(CallState.disconnected);
    }
  }

  String? _participantConnectionToken;

  /// Sends DTMF [digits] (`0-9`, `*`, `#`, `,` for a pause) to the Connect IVR — e.g. "Press 1 for
  /// billing". Digits travel via the Connect Participant Service (not the audio stream); the
  /// participant connection is created lazily on first use and retried once if it has expired.
  Future<void> sendDtmf(String digits) async {
    final session = _session;
    if (session == null) throw StateError('No active call to send DTMF on');

    _participantConnectionToken ??=
        await _backend.createParticipantConnection(session.participantToken);
    try {
      await _backend.sendDtmf(connectionToken: _participantConnectionToken!, digits: digits);
    } on ConnectWebRtcException {
      // The connection may have expired — recreate once and retry.
      _participantConnectionToken =
          await _backend.createParticipantConnection(session.participantToken);
      await _backend.sendDtmf(connectionToken: _participantConnectionToken!, digits: digits);
    }
  }

  Future<bool> setMuted(bool muted) => _platform.setMuted(muted);
  Future<void> mute() => _platform.setMuted(true);
  Future<void> unmute() => _platform.setMuted(false);
  Future<void> enableLocalVideo() => _platform.setLocalVideoEnabled(true);
  Future<void> disableLocalVideo() => _platform.setLocalVideoEnabled(false);
  Future<void> switchCamera() => _platform.switchCamera();
  Future<void> setSpeakerphone(bool enabled) => _platform.setSpeakerphoneEnabled(enabled);

  void _onNativeState(CallState native) {
    _setState(native);
    if (native.isTerminal) {
      _session = null;
      _participantConnectionToken = null;
    }
  }

  void _onNativeEvent(CallEvent event) {
    if (!_events.isClosed) _events.add(event);
    if (event is CallErrorEvent && event.fatal) {
      _setState(CallState.failed);
      _session = null;
      _participantConnectionToken = null;
    }
  }

  void _setState(CallState next) {
    if (_state.value == next) return;
    _state.value = next;
    if (!_states.isClosed) _states.add(next);
  }

  String _newCorrelationId() => 'cf-${DateTime.now().microsecondsSinceEpoch}';

  Future<void> dispose() async {
    await _stateSub.cancel();
    await _eventSub.cancel();
    await _states.close();
    await _events.close();
    _state.dispose();
    _backend.close();
  }
}
