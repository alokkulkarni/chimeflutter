import { assertSecureBaseUrl, BackendClient } from '../src/BackendClient';
import { AuthError, BackendError, InvalidRequestError, RateLimitedError } from '../src/errors';
import type { CallRequest } from '../src/types';

const REQUEST: CallRequest = {
  callType: 'audio',
  context: { issueType: 'billing', tier: 'gold' },
  device: {
    platform: 'iOS',
    osVersion: '17.5',
    appVersion: '1.0.0',
    deviceModel: 'iPhone15,2',
    locale: 'en-GB',
    networkType: 'wifi',
  },
};

const SESSION = {
  contactId: 'contact-1',
  participantId: 'participant-1',
  participantToken: 'ptoken-1',
  callType: 'audio',
  meeting: {
    meetingId: 'meeting-1',
    mediaRegion: 'eu-west-2',
    mediaPlacement: { audioHostUrl: 'wss://a', signalingUrl: 'wss://s' },
  },
  attendee: { attendeeId: 'attendee-1', joinToken: 'jtoken-1' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fetchFn: typeof fetch, token = 'jwt-123') {
  return new BackendClient(
    { baseUrl: 'https://api.example.com/v1', tokenProvider: () => token },
    { fetchFn, sleep: async () => undefined, random: () => 0.5 },
  );
}

describe('assertSecureBaseUrl', () => {
  it('accepts https and localhost http, rejects remote http', () => {
    expect(() => assertSecureBaseUrl('https://api.example.com/v1')).not.toThrow();
    expect(() => assertSecureBaseUrl('http://localhost:3000')).not.toThrow();
    expect(() => assertSecureBaseUrl('http://10.0.2.2:3000')).not.toThrow();
    expect(() => assertSecureBaseUrl('http://api.example.com/v1')).toThrow(BackendError);
    expect(() => assertSecureBaseUrl('not a url')).toThrow(BackendError);
  });
});

describe('startCall', () => {
  it('POSTs /calls with bearer token + idempotency key and returns the session', async () => {
    const fetchFn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/v1/calls');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer jwt-123');
      expect(headers['Idempotency-Key']).toBe('key-1');
      expect(headers['X-Correlation-Id']).toBe('corr-1');
      expect(JSON.parse(String(init?.body))).toEqual(REQUEST);
      return jsonResponse(201, SESSION);
    }) as unknown as typeof fetch;

    const session = await client(fetchFn).startCall(REQUEST, 'key-1', 'corr-1');
    expect(session.contactId).toBe('contact-1');
    expect(session.attendee.joinToken).toBe('jtoken-1');
  });

  it('omits the Authorization header when the token is empty', async () => {
    const fetchFn = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect('Authorization' in headers).toBe(false);
      return jsonResponse(201, SESSION);
    }) as unknown as typeof fetch;

    await client(fetchFn, '').startCall(REQUEST, 'key-1');
  });

  it('retries 429 and 5xx reusing the SAME idempotency key, then succeeds', async () => {
    const keys: string[] = [];
    let call = 0;
    const fetchFn = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)['Idempotency-Key']!);
      call += 1;
      if (call === 1) return jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } });
      if (call === 2) return jsonResponse(502, { error: { code: 'UPSTREAM_ERROR', message: 'connect down' } });
      return jsonResponse(201, SESSION);
    }) as unknown as typeof fetch;

    await client(fetchFn).startCall(REQUEST, 'key-stable');
    expect(keys).toEqual(['key-stable', 'key-stable', 'key-stable']);
  });

  it('gives up after maxAttempts with the last error', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'still throttled' } }),
    ) as unknown as typeof fetch;

    await expect(client(fetchFn).startCall(REQUEST, 'k')).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry 4xx and maps the error envelope', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(400, { error: { code: 'INVALID_CALL_TYPE', message: 'bad callType' } }),
    ) as unknown as typeof fetch;

    const promise = client(fetchFn).startCall(REQUEST, 'k');
    await expect(promise).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(promise).rejects.toMatchObject({ code: 'INVALID_CALL_TYPE' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('maps 401/403 to AuthError', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'no token' } }),
    ) as unknown as typeof fetch;

    await expect(client(fetchFn).startCall(REQUEST, 'k')).rejects.toBeInstanceOf(AuthError);
  });

  it('retries network errors and surfaces BackendError when they persist', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(client(fetchFn).startCall(REQUEST, 'k')).rejects.toBeInstanceOf(BackendError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe('participant connection + DTMF', () => {
  it('exchanges the participantToken for a connectionToken', async () => {
    const fetchFn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/v1/calls/connections');
      expect(JSON.parse(String(init?.body))).toEqual({ participantToken: 'ptoken-1' });
      return jsonResponse(201, { connectionToken: 'ctoken-1', expiry: 'later' });
    }) as unknown as typeof fetch;

    await expect(client(fetchFn).createParticipantConnection('ptoken-1')).resolves.toBe('ctoken-1');
  });

  it('sends DTMF digits and validates them client-side', async () => {
    const fetchFn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/v1/calls/dtmf');
      expect(JSON.parse(String(init?.body))).toEqual({ connectionToken: 'ctoken-1', digits: '1*#,' });
      return jsonResponse(200, { sent: true });
    }) as unknown as typeof fetch;

    const c = client(fetchFn);
    await c.sendDtmf('ctoken-1', '1*#,');
    await expect(c.sendDtmf('ctoken-1', 'abc')).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(c.sendDtmf('ctoken-1', '')).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fetchFn).toHaveBeenCalledTimes(1); // invalid digits never reach the network
  });
});

describe('endCall', () => {
  it('DELETEs /calls/{contactId} with the id URL-encoded', async () => {
    const fetchFn = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/v1/calls/contact%2F1');
      expect(init?.method).toBe('DELETE');
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await client(fetchFn).endCall('contact/1');
  });
});
