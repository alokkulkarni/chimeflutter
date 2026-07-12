/** Typed errors — mirrors the Flutter plugin's exception hierarchy. `code` values are the
 *  canonical ones from specs/003-api-contracts.md §B.4 plus the backend envelope codes. */

export class ConnectWebRtcError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = 'ConnectWebRtcError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Microphone (or camera for video) permission denied — join aborted. */
export class PermissionDeniedError extends ConnectWebRtcError {
  constructor(message = 'Microphone/camera permission denied') {
    super('permissionDenied', message);
    this.name = 'PermissionDeniedError';
  }
}

/** 401/403 from the backend — missing/expired/invalid token. */
export class AuthError extends ConnectWebRtcError {
  constructor(message: string, httpStatus: number) {
    super('authError', message, httpStatus);
    this.name = 'AuthError';
  }
}

/** 429 — Connect throttled; retry with the SAME idempotency key. */
export class RateLimitedError extends ConnectWebRtcError {
  constructor(message: string) {
    super('RATE_LIMITED', message, 429);
    this.name = 'RateLimitedError';
  }
}

/** Any other 4xx — the request itself is wrong; retrying won't help. */
export class InvalidRequestError extends ConnectWebRtcError {
  constructor(code: string, message: string, httpStatus: number) {
    super(code, message, httpStatus);
    this.name = 'InvalidRequestError';
  }
}

/** 5xx / network / unusable response. */
export class BackendError extends ConnectWebRtcError {
  constructor(message: string, httpStatus?: number) {
    super('backendError', message, httpStatus);
    this.name = 'BackendError';
  }
}

/** Native Chime SDK failure surfaced from a method call. */
export class MediaError extends ConnectWebRtcError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'MediaError';
  }
}
