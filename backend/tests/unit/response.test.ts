import { ok, created, noContent, errorResponse } from '../../src/http/response';
import { rateLimited, badRequest } from '../../src/http/errors';

describe('HTTP response envelope', () => {
  it('ok() returns 200 with JSON body and hardened headers', () => {
    const res = ok({ hello: 'world' });
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Content-Type']).toBe('application/json');
    expect(res.headers?.['Cache-Control']).toBe('no-store');
    expect(res.headers?.['X-Content-Type-Options']).toBe('nosniff');
    expect(JSON.parse(res.body as string)).toEqual({ hello: 'world' });
  });

  it('created() returns 201', () => {
    expect(created({ id: 1 }).statusCode).toBe(201);
  });

  it('noContent() returns 204 with no body', () => {
    const res = noContent();
    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
  });

  it('errorResponse() serialises an AppError into a stable envelope with correlation id', () => {
    const res = errorResponse(rateLimited(), 'corr-123');
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body as string);
    expect(body).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please retry shortly' },
      correlationId: 'corr-123',
    });
  });

  it('errorResponse() never serialises the cause / stack', () => {
    const err = badRequest('X', 'bad');
    (err as unknown as { cause: unknown }).cause = new Error('secret internal detail');
    const body = JSON.parse(errorResponse(err, 'c').body as string);
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
    expect(body.error.stack).toBeUndefined();
  });
});
