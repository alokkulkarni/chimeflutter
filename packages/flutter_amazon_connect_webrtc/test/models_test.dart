import 'package:flutter_amazon_connect_webrtc/flutter_amazon_connect_webrtc.dart';
import 'package:flutter_test/flutter_test.dart';

const _sessionJson = <String, dynamic>{
  'contactId': 'contact-1',
  'participantId': 'part-1',
  'participantToken': 'ptoken-1',
  'callType': 'video',
  'meeting': {
    'meetingId': 'meet-1',
    'mediaRegion': 'eu-west-2',
    'mediaPlacement': {
      'audioHostUrl': 'https://audio',
      'audioFallbackUrl': 'https://audiofb',
      'signalingUrl': 'wss://signal',
      'turnControlUrl': 'https://turn',
      'eventIngestionUrl': 'https://ingest',
    },
  },
  'attendee': {'attendeeId': 'att-1', 'joinToken': 'jt-1'},
};

void main() {
  group('CallType', () {
    test('round-trips wire names', () {
      expect(CallType.fromWire('audio'), CallType.audio);
      expect(CallType.fromWire('video'), CallType.video);
      expect(CallType.video.wireName, 'video');
    });

    test('throws on unknown', () {
      expect(() => CallType.fromWire('chat'), throwsArgumentError);
    });
  });

  group('CallSession', () {
    test('fromJson parses the full backend response', () {
      final s = CallSession.fromJson(_sessionJson);
      expect(s.contactId, 'contact-1');
      expect(s.callType, CallType.video);
      expect(s.meeting.meetingId, 'meet-1');
      expect(s.meeting.mediaPlacement.audioHostUrl, 'https://audio');
      expect(s.meeting.mediaPlacement.signalingUrl, 'wss://signal');
      expect(s.attendee.joinToken, 'jt-1');
    });

    test('toJson round-trips (this is the payload sent to native `join`)', () {
      final s = CallSession.fromJson(_sessionJson);
      final again = CallSession.fromJson(s.toJson());
      expect(again.meeting.mediaPlacement.turnControlUrl, 'https://turn');
      expect(again.attendee.attendeeId, 'att-1');
      expect(again.callType, CallType.video);
    });

    test('tolerates absent optional media urls', () {
      final json = Map<String, dynamic>.from(_sessionJson);
      json['meeting'] = {
        'meetingId': 'm',
        'mediaPlacement': {'audioHostUrl': 'https://a', 'signalingUrl': 'wss://s'},
      };
      final s = CallSession.fromJson(json);
      expect(s.meeting.mediaPlacement.audioFallbackUrl, isNull);
      expect(s.meeting.mediaRegion, isNull);
    });
  });

  group('CallRequest.toJson', () {
    test('emits callType, device and only non-empty context', () {
      const req = CallRequest(
        callType: CallType.audio,
        device: DeviceInfo(platform: 'iOS', appVersion: '4.2.0'),
        context: {'issueType': 'billing'},
      );
      final json = req.toJson();
      expect(json['callType'], 'audio');
      expect(json['context'], {'issueType': 'billing'});
      expect((json['device'] as Map)['platform'], 'iOS');
      expect((json['device'] as Map)['appVersion'], '4.2.0');
      expect(json.containsKey('displayName'), isFalse);
    });

    test('omits empty context', () {
      const req = CallRequest(callType: CallType.video, device: DeviceInfo(platform: 'Android'));
      expect(req.toJson().containsKey('context'), isFalse);
    });
  });

  group('CallState.fromWire', () {
    test('parses native lifecycle values', () {
      expect(CallState.fromWire('connected'), CallState.connected);
      expect(CallState.fromWire('reconnecting'), CallState.reconnecting);
      expect(CallState.fromWire('failed'), CallState.failed);
    });

    test('classifies active/terminal', () {
      expect(CallState.connected.isActive, isTrue);
      expect(CallState.disconnected.isTerminal, isTrue);
      expect(CallState.idle.isActive, isFalse);
    });
  });

  group('CallEvent.fromMap', () {
    test('returns null for stateChanged (handled as state)', () {
      expect(CallEvent.fromMap({'type': 'stateChanged', 'state': 'connected'}), isNull);
    });

    test('parses each event type', () {
      expect(CallEvent.fromMap({'type': 'muteChanged', 'muted': true}), isA<MuteChanged>());
      expect(
        CallEvent.fromMap({'type': 'participantJoined', 'attendeeId': 'a'}),
        isA<RemoteParticipantJoined>(),
      );
      expect(
        CallEvent.fromMap({'type': 'remoteVideoAvailable', 'tileId': 7, 'attendeeId': 'a'}),
        isA<RemoteVideoTileAdded>(),
      );
      final err = CallEvent.fromMap({'type': 'error', 'code': 'sdkError', 'message': 'x', 'fatal': true});
      expect((err as CallErrorEvent).fatal, isTrue);
    });

    test('coerces numeric tileId', () {
      final e = CallEvent.fromMap({'type': 'localVideoAvailable', 'tileId': 3}) as LocalVideoTileAdded;
      expect(e.tileId, 3);
    });

    test('returns null for unknown type', () {
      expect(CallEvent.fromMap({'type': 'wat'}), isNull);
    });
  });
}
