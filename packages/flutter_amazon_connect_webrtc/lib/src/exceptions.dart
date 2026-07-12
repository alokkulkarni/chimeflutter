/// Base type for all errors surfaced by the plugin. [code] matches the canonical error codes in
/// `specs/003-api-contracts.md §B.4` where applicable.
sealed class ConnectWebRtcException implements Exception {
  const ConnectWebRtcException(this.code, this.message, {this.httpStatus});

  final String code;
  final String message;
  final int? httpStatus;

  @override
  String toString() => '$runtimeType($code): $message';
}

/// Authentication/authorization failed (missing/expired/invalid token → 401/403).
class AuthException extends ConnectWebRtcException {
  const AuthException([String message = 'Authentication failed', int? httpStatus])
      : super('unauthorized', message, httpStatus: httpStatus);
}

/// The backend rejected the request as malformed (4xx other than auth).
class InvalidRequestException extends ConnectWebRtcException {
  const InvalidRequestException(super.code, super.message, {super.httpStatus});
}

/// The backend/Connect is throttling; the caller should back off and retry.
class RateLimitedException extends ConnectWebRtcException {
  const RateLimitedException([String message = 'Rate limited'])
      : super('rate_limited', message, httpStatus: 429);
}

/// A generic backend/upstream failure (5xx or unusable response).
class BackendException extends ConnectWebRtcException {
  const BackendException(String message, {int? httpStatus})
      : super('backendError', message, httpStatus: httpStatus);
}

/// Microphone (or camera, for video) permission was denied on the device.
class PermissionDeniedException extends ConnectWebRtcException {
  const PermissionDeniedException([String message = 'Microphone/camera permission denied'])
      : super('permissionDenied', message);
}

/// The native Amazon Chime SDK reported a media failure.
class MediaException extends ConnectWebRtcException {
  const MediaException(String message, {String code = 'sdkError'}) : super(code, message);
}
