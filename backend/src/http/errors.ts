/**
 * Typed application errors with stable HTTP status codes and machine-readable codes.
 *
 * Requirement: FR-B5 / NFR-1 — map upstream (AWS/Connect) failures to a small, stable set of
 * client-facing errors and never leak raw AWS internals or messages to the mobile client.
 */

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Optional cause for server-side logging only — never serialised to the client. */
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string): AppError => new AppError(400, code, message);
export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Forbidden'): AppError => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found'): AppError => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string): AppError => new AppError(409, code, message);
export const rateLimited = (message = 'Too many requests, please retry shortly'): AppError =>
  new AppError(429, 'RATE_LIMITED', message);
export const upstreamUnavailable = (message = 'The calling service is temporarily unavailable'): AppError =>
  new AppError(502, 'UPSTREAM_ERROR', message);
export const internalError = (message = 'Internal error'): AppError =>
  new AppError(500, 'INTERNAL_ERROR', message);

/** AWS SDK error `name`s that indicate the client should back off and retry. */
const RETRYABLE_AWS_ERRORS = new Set<string>([
  'ThrottlingException',
  'ThrottledException',
  'TooManyRequestsException',
  'LimitExceededException',
  'ServiceQuotaExceededException',
  'RequestLimitExceeded',
  'ProvisionedThroughputExceededException',
]);

/**
 * Maps an arbitrary thrown value (typically an AWS SDK service error) to a stable {@link AppError}.
 * AppErrors are passed through untouched. Raw AWS messages are dropped so nothing sensitive or
 * implementation-revealing reaches the client; the original is attached as `cause` for logging.
 */
export function mapAwsError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const name = (err as { name?: string } | undefined)?.name ?? 'UnknownError';

  if (RETRYABLE_AWS_ERRORS.has(name)) {
    return new AppError(429, 'RATE_LIMITED', 'Too many requests, please retry shortly', err);
  }

  // Everything else from the upstream is a generic 502 — we do not distinguish AccessDenied vs
  // InvalidRequest to the client, to avoid leaking backend configuration details.
  return new AppError(502, 'UPSTREAM_ERROR', 'The calling service is temporarily unavailable', err);
}
