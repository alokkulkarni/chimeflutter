import 'dart:async';

import 'package:flutter_amazon_connect_webrtc/flutter_amazon_connect_webrtc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

/// A controllable in-memory [CallPlatform] — no channels, no native.
class FakeCallPlatform implements CallPlatform {
  final _states = StreamController<CallState>.broadcast();
  final _events = StreamController<CallEvent>.broadcast();
  final List<String> calls = <String>[];
  bool joinShouldThrow = false;

  @override
  Stream<CallState> get states => _states.stream;
  @override
  Stream<CallEvent> get events => _events.stream;

  @override
  Future<void> join(
    CallSession session, {
    bool callKitEnabled = false,
    String callDisplayName = 'Support',
  }) async {
    calls.add('join:${session.contactId}');
    if (joinShouldThrow) throw const MediaException('join failed');
  }

  @override
  Future<void> leave() async => calls.add('leave');
  @override
  Future<bool> setMuted(bool muted) async {
    calls.add('setMuted:$muted');
    return true;
  }

  @override
  Future<void> setLocalVideoEnabled(bool enabled) async => calls.add('video:$enabled');
  @override
  Future<void> switchCamera() async => calls.add('switchCamera');
  @override
  Future<void> setSpeakerphoneEnabled(bool enabled) async => calls.add('speaker:$enabled');

  void emitState(CallState s) => _states.add(s);
  void emitEvent(CallEvent e) => _events.add(e);
  Future<void> disposeFake() async {
    await _states.close();
    await _events.close();
  }
}

class MockBackendClient extends Mock implements BackendClient {}

class FakePermissionService implements PermissionService {
  FakePermissionService(this.granted);
  bool granted;
  int calls = 0;
  @override
  Future<bool> ensureCallPermissions(CallType callType) async {
    calls++;
    return granted;
  }
}

CallSession _session() => CallSession.fromJson(const {
      'contactId': 'contact-1',
      'participantId': 'p-1',
      'participantToken': 'pt-1',
      'callType': 'audio',
      'meeting': {
        'meetingId': 'm-1',
        'mediaPlacement': {'audioHostUrl': 'https://a', 'signalingUrl': 'wss://s'},
      },
      'attendee': {'attendeeId': 'a-1', 'joinToken': 'jt-1'},
    });

CallRequest _request({CallType type = CallType.audio}) =>
    CallRequest(callType: type, device: const DeviceInfo(platform: 'iOS'));

void main() {
  setUpAll(() => registerFallbackValue(_request()));

  late FakeCallPlatform platform;
  late MockBackendClient backend;

  ConnectWebRtcController build({bool permission = true}) {
    return ConnectWebRtcController(
      config: ConnectWebRtcConfig(backendBaseUrl: Uri.parse('https://api.test/v1')),
      tokenProvider: () async => 'jwt',
      backendClient: backend,
      platform: platform,
      permissionService: FakePermissionService(permission),
    );
  }

  void stubStartSuccess() {
    when(() => backend.newIdempotencyKey()).thenReturn('idem-1');
    when(() => backend.startCall(any(),
        idempotencyKey: any(named: 'idempotencyKey'),
        correlationId: any(named: 'correlationId'),),).thenAnswer((_) async => _session());
    when(() => backend.endCall(any(), correlationId: any(named: 'correlationId')))
        .thenAnswer((_) async {});
    when(() => backend.endCall(any())).thenAnswer((_) async {});
    when(() => backend.close()).thenReturn(null);
  }

  setUp(() {
    platform = FakeCallPlatform();
    backend = MockBackendClient();
    when(() => backend.close()).thenReturn(null);
  });

  tearDown(() async => platform.disposeFake());

  test('US-1: startCall transitions connecting → ringing, joins native, then connected', () async {
    stubStartSuccess();
    final controller = build();
    final seen = <CallState>[];
    controller.states.listen(seen.add);

    await controller.startCall(_request());

    // Backend was asked with the single generated idempotency key.
    verify(() => backend.startCall(any(),
        idempotencyKey: any(named: 'idempotencyKey', that: equals('idem-1')),
        correlationId: any(named: 'correlationId'),),).called(1);
    expect(platform.calls, contains('join:contact-1'));
    expect(controller.state.value, CallState.ringing);

    // Native reports the media session is up.
    platform.emitState(CallState.connected);
    await Future<void>.delayed(Duration.zero);
    expect(controller.state.value, CallState.connected);

    expect(seen, containsAllInOrder([CallState.connecting, CallState.ringing, CallState.connected]));
  });

  test('US-4: microphone permission denied → failed, backend never called', () async {
    stubStartSuccess();
    final controller = build(permission: false);

    await expectLater(controller.startCall(_request()), throwsA(isA<PermissionDeniedException>()));

    expect(controller.state.value, CallState.failed);
    verifyNever(() => backend.startCall(any(),
        idempotencyKey: any(named: 'idempotencyKey'), correlationId: any(named: 'correlationId'),),);
    expect(platform.calls, isEmpty);
  });

  test('backend failure during start → failed and rethrown', () async {
    when(() => backend.newIdempotencyKey()).thenReturn('idem-1');
    when(() => backend.startCall(any(),
            idempotencyKey: any(named: 'idempotencyKey'),
            correlationId: any(named: 'correlationId'),),)
        .thenThrow(const RateLimitedException());
    final controller = build();

    await expectLater(controller.startCall(_request()), throwsA(isA<RateLimitedException>()));
    expect(controller.state.value, CallState.failed);
    expect(platform.calls, isEmpty);
  });

  test('native join failure → failed', () async {
    stubStartSuccess();
    platform.joinShouldThrow = true;
    final controller = build();

    await expectLater(controller.startCall(_request()), throwsA(isA<MediaException>()));
    expect(controller.state.value, CallState.failed);
  });

  test('US-6: endCall stops native, best-effort backend stop, state disconnected', () async {
    stubStartSuccess();
    final controller = build();
    await controller.startCall(_request());
    platform.emitState(CallState.connected);
    await Future<void>.delayed(Duration.zero);

    await controller.endCall();

    expect(platform.calls, contains('leave'));
    await Future<void>.delayed(Duration.zero);
    verify(() => backend.endCall('contact-1')).called(1);
    expect(controller.state.value, CallState.disconnected);
  });

  test('a fatal error event forces the failed state', () async {
    stubStartSuccess();
    final controller = build();
    await controller.startCall(_request());

    platform.emitEvent(const CallErrorEvent(code: 'sdkError', message: 'boom', fatal: true));
    await Future<void>.delayed(Duration.zero);
    expect(controller.state.value, CallState.failed);
  });

  test('reconnecting is surfaced from the native side', () async {
    stubStartSuccess();
    final controller = build();
    await controller.startCall(_request());
    platform.emitState(CallState.connected);
    await Future<void>.delayed(Duration.zero);

    platform.emitState(CallState.reconnecting);
    await Future<void>.delayed(Duration.zero);
    expect(controller.state.value, CallState.reconnecting);
  });

  test('cannot start a second call while one is active', () async {
    stubStartSuccess();
    final controller = build();
    await controller.startCall(_request());
    await expectLater(controller.startCall(_request()), throwsA(isA<StateError>()));
  });

  test('mute/video/camera commands are forwarded to the platform', () async {
    stubStartSuccess();
    final controller = build();
    await controller.setMuted(true);
    await controller.enableLocalVideo();
    await controller.switchCamera();
    await controller.setSpeakerphone(true);
    expect(platform.calls, containsAll(['setMuted:true', 'video:true', 'switchCamera', 'speaker:true']));
  });

  group('sendDtmf (IVR keypad)', () {
    test('creates the participant connection lazily, then reuses it', () async {
      stubStartSuccess();
      when(() => backend.createParticipantConnection(any())).thenAnswer((_) async => 'conn-1');
      when(() => backend.sendDtmf(
          connectionToken: any(named: 'connectionToken'),
          digits: any(named: 'digits'))).thenAnswer((_) async {});
      final controller = build();
      await controller.startCall(_request());

      await controller.sendDtmf('1');
      await controller.sendDtmf('2');

      verify(() => backend.createParticipantConnection('pt-1')).called(1); // lazy + cached
      verify(() => backend.sendDtmf(
          connectionToken: any(named: 'connectionToken', that: equals('conn-1')),
          digits: any(named: 'digits', that: equals('1')))).called(1);
      verify(() => backend.sendDtmf(
          connectionToken: any(named: 'connectionToken', that: equals('conn-1')),
          digits: any(named: 'digits', that: equals('2')))).called(1);
    });

    test('recreates the connection once when a send fails (expired token)', () async {
      stubStartSuccess();
      var conn = 0;
      when(() => backend.createParticipantConnection(any()))
          .thenAnswer((_) async => 'conn-${++conn}');
      var sends = 0;
      when(() => backend.sendDtmf(
          connectionToken: any(named: 'connectionToken'),
          digits: any(named: 'digits'))).thenAnswer((_) async {
        if (++sends == 1) throw const BackendException('expired');
      });
      final controller = build();
      await controller.startCall(_request());

      await controller.sendDtmf('5'); // first send fails → reconnect → retry succeeds

      verify(() => backend.createParticipantConnection(any())).called(2);
      expect(sends, 2);
    });

    test('throws StateError when no call is active', () async {
      stubStartSuccess();
      final controller = build();
      await expectLater(controller.sendDtmf('1'), throwsA(isA<StateError>()));
    });
  });
}
