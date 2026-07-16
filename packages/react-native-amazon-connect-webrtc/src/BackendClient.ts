import {
  AuthError,
  BackendError,
  ConnectWebRtcError,
  InvalidRequestError,
  RateLimitedError,
} from './errors';
import type { CallRequest, CallSession, TokenProvider } from './types';

/** Injectable clock/entropy/transport so tests run deterministic and offline. */
export interface BackendClientDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface BackendClientOptions {
  baseUrl: string;
  tokenProvider: TokenProvider;
  timeoutMs?: number;
  maxAttempts?: number;
}

const DEV_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

/** Rejects non-HTTPS backends (except emulator/localhost dev hosts) — join tokens and bearer
 *  credentials must never travel in cleartext. */
export function assertSecureBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new BackendError(`backendBaseUrl is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && DEV_HTTP_HOSTS.has(url.hostname)) return url;
  throw new BackendError(
    `backendBaseUrl must be https:// (got ${url.protocol}//${url.hostname}) — call/join tokens must not travel in cleartext`,
  );
}

/** Digits the Connect Participant Service accepts for DTMF ("," = 1s pause). Validated client-side
 *  as well as server-side. */
export const DTMF_PATTERN = /^[0-9*#,]{1,20}$/;

/**
 * Talks to the backend HTTP API. Injects the bearer token and idempotency key, maps the error
 * envelope to typed errors, and retries throttling/5xx failures **reusing a single idempotency
 * key** so a retried start never creates a duplicate Connect contact.
 *
 * Faithful port of the Flutter plugin's BackendClient (Dart).
 */
export class BackendClient {
  private readonly baseUrl: URL;
  private readonly tokenProvider: TokenProvider;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: BackendClientOptions, deps: BackendClientDeps = {}) {
    this.baseUrl = assertSecureBaseUrl(options.baseUrl);
    this.tokenProvider = options.tokenProvider;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.fetchFn = deps.fetchFn ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
  }

  /** One idempotency key per logical call — the controller creates it once and reuses it across
   *  the retries below. */
  newIdempotencyKey(): string {
    return `idem-${Date.now()}-${Math.floor(this.random() * 0xffffffff)}`;
  }

  private resolve(path: string): string {
    const base = this.baseUrl.toString().replace(/\/$/, '');
    return `${base}${path}`;
  }

  private async headers(idempotencyKey?: string, correlationId?: string): Promise<Record<string, string>> {
    const token = await this.tokenProvider();
    return {
      // No Authorization header when the host supplies no token (e.g. an API fronted by other
      // means). When a token is provided it is sent as a standard Bearer credential.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
    };
  }

  private async request(
    method: 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
    correlationId?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(this.resolve(path), {
        method,
        headers: await this.headers(idempotencyKey, correlationId),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** `POST /calls` — starts the WebRTC contact and returns the join credentials. */
  async startCall(
    request: CallRequest,
    idempotencyKey: string,
    correlationId?: string,
  ): Promise<CallSession> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.request('POST', '/calls', request, idempotencyKey, correlationId);
      } catch (e) {
        // Network / timeout — retry with the SAME idempotency key.
        lastError = e;
        if (attempt < this.maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
        throw new BackendError(`Network error contacting backend: ${String(e)}`);
      }

      if (res.status === 201 || res.status === 200) {
        return (await res.json()) as CallSession;
      }

      const err = await this.toError(res);
      // Retry only throttling / transient server errors, reusing the same idempotency key.
      if (err instanceof RateLimitedError || (res.status >= 500 && res.status <= 599)) {
        lastError = err;
        if (attempt < this.maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
      }
      throw err;
    }
    throw lastError instanceof ConnectWebRtcError
      ? lastError
      : new BackendError(`start call failed after ${this.maxAttempts} attempts`);
  }

  /** `POST /calls/connections` — exchanges the session's participantToken for a participant
   *  connection (used to send DTMF to the IVR). Returns the connectionToken. */
  async createParticipantConnection(participantToken: string): Promise<string> {
    const res = await this.request('POST', '/calls/connections', { participantToken });
    if (res.status !== 201 && res.status !== 200) throw await this.toError(res);
    const json = (await res.json()) as { connectionToken?: string };
    if (!json.connectionToken) throw new BackendError('No connectionToken in response');
    return json.connectionToken;
  }

  /** `POST /calls/dtmf` — sends DTMF digits (0-9 * # ,) to the IVR on an open connection. */
  async sendDtmf(connectionToken: string, digits: string): Promise<void> {
    if (!DTMF_PATTERN.test(digits)) {
      throw new InvalidRequestError('INVALID_DTMF', `digits must match ${DTMF_PATTERN}`, 400);
    }
    const res = await this.request('POST', '/calls/dtmf', { connectionToken, digits });
    if (res.status !== 200) throw await this.toError(res);
  }

  /** `POST /devices` — registers (upserts) this device's push token so the contact center can
   *  place simulated-outbound calls to it. `platform` is 'iOS' or 'Android'; `pushToken` is the
   *  APNs **VoIP** token (iOS) or the FCM registration token (Android). */
  async registerDevice(customerId: string, platform: 'iOS' | 'Android', pushToken: string): Promise<void> {
    const res = await this.request('POST', '/devices', { customerId, platform, pushToken });
    if (res.status !== 200 && res.status !== 201) throw await this.toError(res);
  }

  /** `POST /calls/outbound/{callId}/answer` — exchanges the callId from an incoming-call push for
   *  the full join credentials. Idempotent on retry; a 410 means the call stopped ringing
   *  (declined elsewhere, cancelled, or timed out). */
  async answerOutboundCall(callId: string, correlationId?: string): Promise<CallSession> {
    const res = await this.request(
      'POST',
      `/calls/outbound/${encodeURIComponent(callId)}/answer`,
      undefined,
      undefined,
      correlationId,
    );
    if (res.status !== 200) throw await this.toError(res);
    return (await res.json()) as CallSession;
  }

  /** `POST /calls/outbound/{callId}/decline` — declines a ringing simulated-outbound call so the
   *  waiting agent is released immediately. */
  async declineOutboundCall(callId: string, correlationId?: string): Promise<void> {
    const res = await this.request(
      'POST',
      `/calls/outbound/${encodeURIComponent(callId)}/decline`,
      undefined,
      undefined,
      correlationId,
    );
    if (res.status !== 204 && res.status !== 200) throw await this.toError(res);
  }

  /** `DELETE /calls/{contactId}` — ends the contact server-side. Best-effort. */
  async endCall(contactId: string, correlationId?: string): Promise<void> {
    const res = await this.request(
      'DELETE',
      `/calls/${encodeURIComponent(contactId)}`,
      undefined,
      undefined,
      correlationId,
    );
    if (res.status !== 204 && res.status !== 200) throw await this.toError(res);
  }

  private async backoff(attempt: number): Promise<void> {
    // Exponential backoff with jitter: ~200ms, ~400ms, …
    const base = 200 * 2 ** (attempt - 1);
    await this.sleep(base + Math.floor(this.random() * 100));
  }

  private async toError(res: Response): Promise<ConnectWebRtcError> {
    let code = 'backendError';
    let message = `Request failed (${res.status})`;
    try {
      const decoded = (await res.json()) as { error?: { code?: string; message?: string } };
      if (decoded?.error) {
        code = decoded.error.code ?? code;
        message = decoded.error.message ?? message;
      }
    } catch {
      // non-JSON body — keep defaults
    }
    if (res.status === 401 || res.status === 403) return new AuthError(message, res.status);
    if (res.status === 429) return new RateLimitedError(message);
    if (res.status >= 400 && res.status < 500) {
      return new InvalidRequestError(code, message, res.status);
    }
    return new BackendError(message, res.status);
  }
}
