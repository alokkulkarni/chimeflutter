import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'connect_webrtc_config.dart';
import 'exceptions.dart';
import 'models/call_models.dart';

/// Injectable delay so tests run without real time.
typedef Sleep = Future<void> Function(Duration);

/// Talks to the backend HTTP API. Injects the JWT and idempotency key, maps the error envelope to
/// typed exceptions, and retries throttling/5xx failures **reusing a single idempotency key** so a
/// retried start never creates a duplicate Connect contact (FR-B6 mechanism, client side).
class BackendClient {
  BackendClient({
    required this.baseUrl,
    required this.tokenProvider,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 15),
    this.maxAttempts = 3,
    Sleep? sleep,
    Random? random,
  })  : _http = httpClient ?? http.Client(),
        _sleep = sleep ?? Future.delayed,
        _random = random ?? Random();

  final Uri baseUrl;
  final TokenProvider tokenProvider;
  final Duration timeout;
  final int maxAttempts;
  final http.Client _http;
  final Sleep _sleep;
  final Random _random;

  /// Generates an idempotency key for one logical call. The controller creates it once and reuses
  /// it across the retries below.
  String newIdempotencyKey() =>
      'idem-${DateTime.now().microsecondsSinceEpoch}-${_random.nextInt(1 << 32)}';

  Uri _resolve(String path) => baseUrl.replace(
        path: '${baseUrl.path.replaceAll(RegExp(r"/$"), "")}$path',
      );

  Future<Map<String, String>> _headers({String? idempotencyKey, String? correlationId}) async {
    final token = await tokenProvider();
    return <String, String>{
      // No Authorization header when the host supplies no token (e.g. an API fronted by other
      // means). When a token is provided it is sent as a standard Bearer credential.
      if (token.isNotEmpty) 'Authorization': 'Bearer $token',
      'Content-Type': 'application/json',
      if (idempotencyKey != null) 'Idempotency-Key': idempotencyKey,
      if (correlationId != null) 'X-Correlation-Id': correlationId,
    };
  }

  /// `POST /calls` — starts the WebRTC contact and returns the join credentials.
  Future<CallSession> startCall(
    CallRequest request, {
    required String idempotencyKey,
    String? correlationId,
  }) async {
    final url = _resolve('/calls');
    final body = jsonEncode(request.toJson());

    Object? lastError;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        final res = await _http
            .post(
              url,
              headers: await _headers(idempotencyKey: idempotencyKey, correlationId: correlationId),
              body: body,
            )
            .timeout(timeout);

        if (res.statusCode == 201 || res.statusCode == 200) {
          final json = jsonDecode(res.body) as Map<String, dynamic>;
          return CallSession.fromJson(json);
        }

        final err = _toException(res);
        // Retry only on throttling / transient server errors, reusing the same idempotency key.
        if (err is RateLimitedException || (res.statusCode >= 500 && res.statusCode <= 599)) {
          lastError = err;
          if (attempt < maxAttempts) {
            await _backoff(attempt);
            continue;
          }
        }
        throw err;
      } on ConnectWebRtcException {
        rethrow;
      } catch (e) {
        // Network / timeout — retry.
        lastError = e;
        if (attempt < maxAttempts) {
          await _backoff(attempt);
          continue;
        }
        throw BackendException('Network error contacting backend: $e');
      }
    }
    throw lastError is ConnectWebRtcException
        ? lastError
        : BackendException('start call failed after $maxAttempts attempts');
  }

  /// `POST /calls/connections` — exchanges the session's participantToken for a participant
  /// connection (used to send DTMF to the IVR). Returns the connectionToken.
  Future<String> createParticipantConnection(String participantToken) async {
    final res = await _http
        .post(
          _resolve('/calls/connections'),
          headers: await _headers(),
          body: jsonEncode({'participantToken': participantToken}),
        )
        .timeout(timeout);
    if (res.statusCode != 201 && res.statusCode != 200) throw _toException(res);
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    final token = json['connectionToken'] as String?;
    if (token == null || token.isEmpty) {
      throw const BackendException('No connectionToken in response');
    }
    return token;
  }

  /// `POST /calls/dtmf` — sends DTMF digits (0-9 * # ,) to the IVR on an open connection.
  Future<void> sendDtmf({required String connectionToken, required String digits}) async {
    final res = await _http
        .post(
          _resolve('/calls/dtmf'),
          headers: await _headers(),
          body: jsonEncode({'connectionToken': connectionToken, 'digits': digits}),
        )
        .timeout(timeout);
    if (res.statusCode != 200) throw _toException(res);
  }

  /// `DELETE /calls/{contactId}` — ends the contact server-side. Best-effort; a failure here does
  /// not stop the local media session from tearing down.
  Future<void> endCall(String contactId, {String? correlationId}) async {
    final url = _resolve('/calls/${Uri.encodeComponent(contactId)}');
    final res =
        await _http.delete(url, headers: await _headers(correlationId: correlationId)).timeout(timeout);
    if (res.statusCode != 204 && res.statusCode != 200) {
      throw _toException(res);
    }
  }

  Future<void> _backoff(int attempt) async {
    // Exponential backoff with jitter: ~200ms, ~400ms, …
    final base = 200 * (1 << (attempt - 1));
    final jitter = _random.nextInt(100);
    await _sleep(Duration(milliseconds: base + jitter));
  }

  ConnectWebRtcException _toException(http.Response res) {
    String code = 'backendError';
    String message = 'Request failed (${res.statusCode})';
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map && decoded['error'] is Map) {
        final error = decoded['error'] as Map;
        code = (error['code'] as String?) ?? code;
        message = (error['message'] as String?) ?? message;
      }
    } catch (_) {
      // non-JSON body — keep defaults
    }

    switch (res.statusCode) {
      case 401:
      case 403:
        return AuthException(message, res.statusCode);
      case 429:
        return RateLimitedException(message);
      case >= 400 && < 500:
        return InvalidRequestException(code, message, httpStatus: res.statusCode);
      default:
        return BackendException(message, httpStatus: res.statusCode);
    }
  }

  void close() => _http.close();
}
