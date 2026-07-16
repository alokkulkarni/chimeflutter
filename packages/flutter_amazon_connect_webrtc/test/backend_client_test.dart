import 'dart:convert';

import 'package:flutter_amazon_connect_webrtc/flutter_amazon_connect_webrtc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

CallRequest _req() => const CallRequest(
      callType: CallType.audio,
      device: DeviceInfo(platform: 'iOS', appVersion: '4.2.0'),
      context: {'issueType': 'billing'},
    );

const _okBody = {
  'contactId': 'c-1',
  'participantId': 'p-1',
  'participantToken': 'pt-1',
  'callType': 'audio',
  'meeting': {
    'meetingId': 'm-1',
    'mediaPlacement': {'audioHostUrl': 'https://a', 'signalingUrl': 'wss://s'},
  },
  'attendee': {'attendeeId': 'a-1', 'joinToken': 'jt-1'},
};

BackendClient _client(MockClient mock) => BackendClient(
      baseUrl: Uri.parse('https://api.test/v1'),
      tokenProvider: () async => 'jwt-token',
      httpClient: mock,
      sleep: (_) async {}, // no real delay in tests
    );

void main() {
  test('FR-F7: startCall posts to /v1/calls with bearer token and returns a CallSession', () async {
    late http.Request captured;
    final mock = MockClient((req) async {
      captured = req;
      return http.Response(jsonEncode(_okBody), 201);
    });

    final session = await _client(mock).startCall(_req(), idempotencyKey: 'k-1');

    expect(captured.method, 'POST');
    expect(captured.url.toString(), 'https://api.test/v1/calls');
    expect(captured.headers['Authorization'], 'Bearer jwt-token');
    expect(captured.headers['Idempotency-Key'], 'k-1');
    final sent = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(sent['callType'], 'audio');
    expect(session.contactId, 'c-1');
    expect(session.attendee.joinToken, 'jt-1');
  });

  test('US-5: the SAME idempotency key is reused across retries (429 then 201)', () async {
    final keys = <String?>[];
    var calls = 0;
    final mock = MockClient((req) async {
      calls++;
      keys.add(req.headers['Idempotency-Key']);
      if (calls == 1) {
        return http.Response(jsonEncode({'error': {'code': 'RATE_LIMITED', 'message': 'slow'}}), 429);
      }
      return http.Response(jsonEncode(_okBody), 201);
    });

    final session = await _client(mock).startCall(_req(), idempotencyKey: 'k-42');

    expect(calls, 2);
    expect(keys, ['k-42', 'k-42']); // reused, not regenerated
    expect(session.contactId, 'c-1');
  });

  test('US-4: a 429 that never clears becomes a RateLimitedException', () async {
    final mock = MockClient((req) async =>
        http.Response(jsonEncode({'error': {'code': 'RATE_LIMITED', 'message': 'slow'}}), 429),);
    await expectLater(
      _client(mock).startCall(_req(), idempotencyKey: 'k'),
      throwsA(isA<RateLimitedException>()),
    );
  });

  test('US-3: a 401 becomes an AuthException and is not retried', () async {
    var calls = 0;
    final mock = MockClient((req) async {
      calls++;
      return http.Response(jsonEncode({'error': {'code': 'UNAUTHORIZED', 'message': 'no'}}), 401);
    });
    await expectLater(
      _client(mock).startCall(_req(), idempotencyKey: 'k'),
      throwsA(isA<AuthException>()),
    );
    expect(calls, 1); // auth failure is terminal, no retry
  });

  test('a 400 becomes an InvalidRequestException (no retry)', () async {
    final mock = MockClient((req) async =>
        http.Response(jsonEncode({'error': {'code': 'INVALID_CALL_TYPE', 'message': 'bad'}}), 400),);
    await expectLater(
      _client(mock).startCall(_req(), idempotencyKey: 'k'),
      throwsA(isA<InvalidRequestException>()),
    );
  });

  test('endCall issues DELETE /v1/calls/{contactId} and accepts 204', () async {
    late http.Request captured;
    final mock = MockClient((req) async {
      captured = req;
      return http.Response('', 204);
    });
    await _client(mock).endCall('contact-9');
    expect(captured.method, 'DELETE');
    expect(captured.url.toString(), 'https://api.test/v1/calls/contact-9');
    expect(captured.headers['Authorization'], 'Bearer jwt-token');
  });

  test('createParticipantConnection posts the participantToken and returns the connectionToken',
      () async {
    late http.Request captured;
    final mock = MockClient((req) async {
      captured = req;
      return http.Response(jsonEncode({'connectionToken': 'ct-1', 'expiry': 'x'}), 201);
    });
    final token = await _client(mock).createParticipantConnection('pt-1');
    expect(captured.url.toString(), 'https://api.test/v1/calls/connections');
    expect(jsonDecode(captured.body), {'participantToken': 'pt-1'});
    expect(token, 'ct-1');
  });

  test('sendDtmf posts connectionToken + digits to /calls/dtmf', () async {
    late http.Request captured;
    final mock = MockClient((req) async {
      captured = req;
      return http.Response(jsonEncode({'sent': true}), 200);
    });
    await _client(mock).sendDtmf(connectionToken: 'ct-1', digits: '1*#');
    expect(captured.url.toString(), 'https://api.test/v1/calls/dtmf');
    expect(jsonDecode(captured.body), {'connectionToken': 'ct-1', 'digits': '1*#'});
  });

  test('sendDtmf surfaces backend errors as typed exceptions', () async {
    final mock = MockClient((req) async =>
        http.Response(jsonEncode({'error': {'code': 'UPSTREAM_ERROR', 'message': 'x'}}), 502),);
    await expectLater(
      _client(mock).sendDtmf(connectionToken: 'ct', digits: '1'),
      throwsA(isA<BackendException>()),
    );
  });

  test('registerDevice posts the push token to /v1/devices', () async {
    late http.Request captured;
    final mock = MockClient((req) async {
      captured = req;
      return http.Response(jsonEncode({'customerId': 'cust-1', 'platform': 'iOS'}), 200);
    });
    await _client(mock).registerDevice(
      customerId: 'cust-1',
      platform: 'iOS',
      pushToken: 'voip-token',
    );
    expect(captured.method, 'POST');
    expect(captured.url.toString(), 'https://api.test/v1/devices');
    expect(jsonDecode(captured.body), {
      'customerId': 'cust-1',
      'platform': 'iOS',
      'pushToken': 'voip-token',
    });
    expect(captured.headers['Authorization'], 'Bearer jwt-token');
  });

  test('answerOutboundCall exchanges the callId for a CallSession', () async {
    late http.Request captured;
    final mock = MockClient((req) async {
      captured = req;
      return http.Response(jsonEncode(_okBody), 200);
    });
    final session = await _client(mock).answerOutboundCall('call-1');
    expect(captured.method, 'POST');
    expect(captured.url.toString(), 'https://api.test/v1/calls/outbound/call-1/answer');
    expect(session.contactId, 'c-1');
    expect(session.attendee.joinToken, 'jt-1');
  });

  test('answerOutboundCall surfaces 410 (no longer ringing) as InvalidRequestException', () async {
    final mock = MockClient((req) async => http.Response(
        jsonEncode({'error': {'code': 'CALL_NO_LONGER_RINGING', 'message': 'gone'}}), 410,),);
    await expectLater(
      _client(mock).answerOutboundCall('call-1'),
      throwsA(
        isA<InvalidRequestException>().having((e) => e.code, 'code', 'CALL_NO_LONGER_RINGING'),
      ),
    );
  });

  test('declineOutboundCall posts to .../decline and accepts 204', () async {
    late http.Request captured;
    final mock = MockClient((req) async {
      captured = req;
      return http.Response('', 204);
    });
    await _client(mock).declineOutboundCall('call-2');
    expect(captured.method, 'POST');
    expect(captured.url.toString(), 'https://api.test/v1/calls/outbound/call-2/decline');
  });
}
