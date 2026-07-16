import 'package:flutter/services.dart';

import 'exceptions.dart';
import 'models/call_event.dart';
import 'models/call_models.dart';
import 'models/call_state.dart';

/// Channel names — the single source of truth shared with the native bridges
/// (`specs/003-api-contracts.md §B`).
const String kMethodChannelName = 'com.chimeflutter.connect_webrtc/methods';
const String kEventChannelName = 'com.chimeflutter.connect_webrtc/events';
const String kVideoViewType = 'com.chimeflutter.connect_webrtc/video_view';

/// Abstraction over the native Amazon Chime SDK media session. The controller depends on this
/// interface (not the channels) so it can be tested with a fake platform.
abstract interface class CallPlatform {
  /// Lifecycle transitions emitted by the native side (`connected`, `reconnecting`, …).
  Stream<CallState> get states;

  /// Discrete call events (participants, video tiles, audio route, errors).
  Stream<CallEvent> get events;

  /// Joins the native media session. When [callKitEnabled] the plugin reports the call to the OS
  /// system-call UI (CallKit / Telecom) using [callDisplayName] as the shown call name.
  ///
  /// [asIncoming] joins an ANSWERED simulated-outbound call: the OS already shows the call (it was
  /// reported by [reportIncomingCall] / the native push handler), so the native side attaches the
  /// media to the existing call instead of starting a new outgoing one.
  Future<void> join(
    CallSession session, {
    bool callKitEnabled,
    String callDisplayName,
    bool asIncoming,
  });
  Future<void> leave();
  Future<bool> setMuted(bool muted);
  Future<void> setLocalVideoEnabled(bool enabled);
  Future<void> switchCamera();
  Future<void> setSpeakerphoneEnabled(bool enabled);

  /// Shows the OS incoming-call UI (CallKit on iOS, a full-screen call notification + Telecom on
  /// Android) for a simulated-outbound call push received on the Dart side. On iOS, VoIP pushes
  /// arrive in the HOST APP's PushKit delegate before Dart runs — the host reports the call
  /// natively via `ConnectCallKitManager.shared.reportIncomingCall` instead (see
  /// docs/OUTBOUND_CALLS.md).
  Future<void> reportIncomingCall({
    required String callId,
    required String displayName,
    required bool isVideo,
    required int timeoutSeconds,
  });

  /// Dismisses a still-ringing incoming call (e.g. the app learned the caller cancelled).
  Future<void> dismissIncomingCall();

  /// Returns `{callId, isVideo}` if the user answered the ring UI before Dart attached (cold
  /// start), clearing it — the app should immediately `answerIncomingCall`. Null otherwise.
  Future<Map<String, dynamic>?> getPendingIncomingCall();
}

/// Default [CallPlatform] backed by [MethodChannel]/[EventChannel].
class MethodChannelCallPlatform implements CallPlatform {
  MethodChannelCallPlatform({MethodChannel? methodChannel, EventChannel? eventChannel})
      : _methods = methodChannel ?? const MethodChannel(kMethodChannelName),
        _eventChannel = eventChannel ?? const EventChannel(kEventChannelName);

  final MethodChannel _methods;
  final EventChannel _eventChannel;
  Stream<Map<String, dynamic>>? _rawCache;

  Stream<Map<String, dynamic>> get _raw => _rawCache ??= _eventChannel
      .receiveBroadcastStream()
      .map((dynamic e) => Map<String, dynamic>.from(e as Map))
      .asBroadcastStream();

  @override
  Stream<CallState> get states => _raw
      .where((m) => m['type'] == 'stateChanged')
      .map((m) => CallState.fromWire(m['state'] as String));

  @override
  Stream<CallEvent> get events => _raw
      .where((m) => m['type'] != 'stateChanged')
      .map(CallEvent.fromMap)
      .where((e) => e != null)
      .cast<CallEvent>();

  @override
  Future<void> join(
    CallSession session, {
    bool callKitEnabled = false,
    String callDisplayName = 'Support',
    bool asIncoming = false,
  }) =>
      _invoke('join', <String, dynamic>{
        ...session.toJson(),
        'callKitEnabled': callKitEnabled,
        'callDisplayName': callDisplayName,
        'asIncoming': asIncoming,
      });

  @override
  Future<void> leave() => _invoke('leave');

  @override
  Future<bool> setMuted(bool muted) async {
    try {
      final ok = await _methods.invokeMethod<bool>('setMuted', <String, dynamic>{'muted': muted});
      return ok ?? false;
    } on PlatformException catch (e) {
      throw _mapException(e);
    }
  }

  @override
  Future<void> setLocalVideoEnabled(bool enabled) =>
      _invoke('setLocalVideoEnabled', <String, dynamic>{'enabled': enabled});

  @override
  Future<void> switchCamera() => _invoke('switchCamera');

  @override
  Future<void> setSpeakerphoneEnabled(bool enabled) =>
      _invoke('setSpeakerphoneEnabled', <String, dynamic>{'enabled': enabled});

  @override
  Future<void> reportIncomingCall({
    required String callId,
    required String displayName,
    required bool isVideo,
    required int timeoutSeconds,
  }) =>
      _invoke('reportIncomingCall', <String, dynamic>{
        'callId': callId,
        'displayName': displayName,
        'isVideo': isVideo,
        'timeoutSeconds': timeoutSeconds,
      });

  @override
  Future<void> dismissIncomingCall() => _invoke('dismissIncomingCall');

  @override
  Future<Map<String, dynamic>?> getPendingIncomingCall() async {
    try {
      final raw = await _methods.invokeMethod<Map<Object?, Object?>>('getPendingIncomingCall');
      if (raw == null) return null;
      return Map<String, dynamic>.from(raw);
    } on PlatformException catch (e) {
      throw _mapException(e);
    }
  }

  Future<void> _invoke(String method, [dynamic args]) async {
    try {
      await _methods.invokeMethod<void>(method, args);
    } on PlatformException catch (e) {
      throw _mapException(e);
    }
  }

  ConnectWebRtcException _mapException(PlatformException e) {
    if (e.code == 'permissionDenied') {
      return PermissionDeniedException(e.message ?? 'Permission denied');
    }
    return MediaException(e.message ?? 'Native error', code: e.code);
  }
}
