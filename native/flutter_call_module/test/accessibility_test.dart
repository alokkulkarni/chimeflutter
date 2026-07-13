/// Automated accessibility assessment for the call UI, using Flutter's OFFICIAL accessibility
/// guidelines (the same checks `flutter test` ships for a11y audits):
///  - androidTapTargetGuideline   (48x48dp minimum touch targets)
///  - iOSTapTargetGuideline       (44x44pt minimum touch targets)
///  - labeledTapTargetGuideline   (every tappable node has a semantic label)
///  - textContrastGuideline       (WCAG minimum text contrast)
///
/// Every screen state — idle chooser, single-type idle, in-call controls, DTMF keypad — must pass
/// ALL four guidelines. A failure here is a release blocker.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_amazon_connect_webrtc/flutter_amazon_connect_webrtc.dart';

import 'package:chime_call_module/main.dart';

const _session = CallSession(
  contactId: 'contact-1',
  participantId: 'participant-1',
  participantToken: 'ptoken',
  callType: CallType.audio,
  meeting: CallMeeting(
    meetingId: 'meeting-1',
    mediaRegion: 'eu-west-2',
    mediaPlacement: MediaPlacement(audioHostUrl: 'wss://a', signalingUrl: 'wss://s'),
  ),
  attendee: CallAttendee(attendeeId: 'attendee-1', joinToken: 'jtoken'),
);

class _FakePlatform implements CallPlatform {
  final _states = StreamController<CallState>.broadcast();
  final _events = StreamController<CallEvent>.broadcast();

  void pushState(CallState state) => _states.add(state);
  void pushEvent(CallEvent event) => _events.add(event);

  @override
  Stream<CallState> get states => _states.stream;
  @override
  Stream<CallEvent> get events => _events.stream;
  @override
  Future<void> join(CallSession session,
          {bool callKitEnabled = false, String? callDisplayName}) async =>
      pushState(CallState.connected);
  @override
  Future<void> leave() async => pushState(CallState.disconnected);
  @override
  Future<bool> setMuted(bool muted) async => true;
  @override
  Future<void> setLocalVideoEnabled(bool enabled) async {}
  @override
  Future<void> switchCamera() async {}
  @override
  Future<void> setSpeakerphoneEnabled(bool enabled) async {}
}

class _FakeBackend extends BackendClient {
  _FakeBackend() : super(baseUrl: Uri.parse('https://test/v1'), tokenProvider: () async => '');
  final sentDigits = <String>[];

  @override
  Future<CallSession> startCall(CallRequest request,
          {required String idempotencyKey, String? correlationId}) async =>
      _session;
  @override
  Future<String> createParticipantConnection(String participantToken) async => 'ctoken';
  @override
  Future<void> sendDtmf({required String connectionToken, required String digits}) async {
    sentDigits.add(digits);
  }

  @override
  Future<void> endCall(String contactId, {String? correlationId}) async {}
}

class _FakePermissions implements PermissionService {
  @override
  Future<bool> ensureCallPermissions(CallType callType) async => true;
}

Future<(ConnectWebRtcController, _FakePlatform, _FakeBackend)> _pumpCallHome(
  WidgetTester tester, {
  String enabledCallTypes = 'audio,video',
}) async {
  // The host bridge channel has no host in tests — give it a no-op handler so the module's
  // fire-and-forget onCallStateChanged notifications don't surface as unhandled errors.
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    const MethodChannel('com.chimeflutter.host/bridge'),
    (call) async => null,
  );

  final platform = _FakePlatform();
  final backend = _FakeBackend();
  final controller = ConnectWebRtcController(
    config: ConnectWebRtcConfig(backendBaseUrl: Uri.parse('https://test/v1')),
    tokenProvider: () async => '',
    backendClient: backend,
    platform: platform,
    permissionService: _FakePermissions(),
  );

  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true, brightness: Brightness.dark),
      home: CallHome(
        config: AppConfig(
          backendBaseUrl: 'https://test/v1',
          enabledCallTypes: AppConfig.parseCallTypes(enabledCallTypes),
        ),
        controllerOverride: controller,
      ),
    ),
  );
  await tester.pump();
  return (controller, platform, backend);
}

Future<void> _expectAllGuidelines(WidgetTester tester) async {
  await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
  await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
  await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  await expectLater(tester, meetsGuideline(textContrastGuideline));
}

void main() {
  testWidgets('idle chooser screen passes all four accessibility guidelines', (tester) async {
    final handle = tester.ensureSemantics();
    await _pumpCallHome(tester);

    expect(find.text('Audio call'), findsOneWidget);
    expect(find.text('Video call'), findsOneWidget);
    await _expectAllGuidelines(tester);
    handle.dispose();
  });

  testWidgets('in-call controls pass all four accessibility guidelines and are labelled',
      (tester) async {
    final handle = tester.ensureSemantics();
    final (_, platform, _) = await _pumpCallHome(tester);

    await tester.tap(find.text('Audio call'));
    await tester.pumpAndSettle();
    platform.pushState(CallState.connected);
    await tester.pumpAndSettle();

    // Every control is reachable by its screen-reader name.
    for (final label in ['Mute', 'Speaker', 'Video', 'Keypad', 'Flip']) {
      expect(find.bySemanticsLabel(label), findsOneWidget, reason: 'missing control: $label');
    }
    // The FAB announces via its tooltip (also its long-press affordance).
    expect(find.byTooltip('End call'), findsOneWidget);
    await _expectAllGuidelines(tester);
    handle.dispose();
  });

  testWidgets('DTMF keypad passes all four guidelines, names Star/Pound, and sends digits',
      (tester) async {
    final handle = tester.ensureSemantics();
    final (_, platform, backend) = await _pumpCallHome(tester);

    await tester.tap(find.text('Audio call'));
    await tester.pumpAndSettle();
    platform.pushState(CallState.connected);
    await tester.pumpAndSettle();

    await tester.tap(find.bySemanticsLabel('Keypad'));
    await tester.pumpAndSettle();

    expect(find.bySemanticsLabel('Star'), findsOneWidget);
    expect(find.bySemanticsLabel('Pound'), findsOneWidget);
    expect(find.bySemanticsLabel('2, ABC'), findsOneWidget);
    await _expectAllGuidelines(tester);

    await tester.tap(find.bySemanticsLabel('1'));
    await tester.pumpAndSettle();
    expect(backend.sentDigits, ['1']);
    // The dialed display is a live region announcing what was sent.
    expect(find.bySemanticsLabel('Sent: 1'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('single-call-type mode auto-dials, hides video controls, and stays compliant',
      (tester) async {
    final handle = tester.ensureSemantics();
    final (controller, platform, _) = await _pumpCallHome(tester, enabledCallTypes: 'audio');

    await tester.pumpAndSettle(); // auto-dial (post-frame) → fake join → connected
    platform.pushState(CallState.connected);
    await tester.pumpAndSettle();

    expect(controller.isInCall, isTrue);
    expect(find.bySemanticsLabel('Video'), findsNothing);
    expect(find.bySemanticsLabel('Flip'), findsNothing);
    expect(find.bySemanticsLabel('Mute'), findsOneWidget);
    await _expectAllGuidelines(tester);
    handle.dispose();
  });
}
