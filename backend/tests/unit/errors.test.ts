import {
  AppError,
  badRequest,
  unauthorized,
  rateLimited,
  upstreamUnavailable,
  mapAwsError,
} from '../../src/http/errors';

describe('FR-B5 — stable application errors', () => {
  it('carries a stable http status and machine code', () => {
    const e = badRequest('INVALID_CALL_TYPE', 'callType must be audio or video');
    expect(e).toBeInstanceOf(AppError);
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe('INVALID_CALL_TYPE');
    expect(e.message).toBe('callType must be audio or video');
  });

  it('unauthorized is 401 / UNAUTHORIZED', () => {
    expect(unauthorized().statusCode).toBe(401);
    expect(unauthorized().code).toBe('UNAUTHORIZED');
  });

  it('rateLimited is 429 / RATE_LIMITED', () => {
    expect(rateLimited().statusCode).toBe(429);
    expect(rateLimited().code).toBe('RATE_LIMITED');
  });

  describe('mapAwsError — Connect/AWS SDK errors to stable app errors', () => {
    const cases: Array<[string, number, string]> = [
      ['ThrottlingException', 429, 'RATE_LIMITED'],
      ['TooManyRequestsException', 429, 'RATE_LIMITED'],
      ['LimitExceededException', 429, 'RATE_LIMITED'],
      ['AccessDeniedException', 502, 'UPSTREAM_ERROR'],
      ['ResourceNotFoundException', 502, 'UPSTREAM_ERROR'],
      ['InvalidRequestException', 502, 'UPSTREAM_ERROR'],
      ['InternalServiceException', 502, 'UPSTREAM_ERROR'],
      ['ServiceQuotaExceededException', 429, 'RATE_LIMITED'],
    ];

    it.each(cases)('%s -> %d / %s', (name, status, code) => {
      const awsErr = Object.assign(new Error('boom'), { name });
      const mapped = mapAwsError(awsErr);
      expect(mapped.statusCode).toBe(status);
      expect(mapped.code).toBe(code);
      // NFR-1: never leak the raw AWS message to the client.
      expect(mapped.message).not.toContain('boom');
    });

    it('falls back to 502 UPSTREAM_ERROR for unknown AWS errors', () => {
      const mapped = mapAwsError(Object.assign(new Error('weird'), { name: 'SomethingElse' }));
      expect(mapped.statusCode).toBe(502);
      expect(mapped.code).toBe('UPSTREAM_ERROR');
    });

    it('passes AppError through unchanged', () => {
      const original = upstreamUnavailable();
      expect(mapAwsError(original)).toBe(original);
    });
  });
});
