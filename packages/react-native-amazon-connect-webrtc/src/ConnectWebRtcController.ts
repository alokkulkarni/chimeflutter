import { BackendClient, DTMF_PATTERN } from './BackendClient';
import { ConnectWebRtcError, InvalidRequestError, MediaError, PermissionDeniedError } from './errors';
import { createNativeBridge, NativeBridge } from './native';
import {
  ACTIVE_STATES,
  CallEvent,
  CallRequest,
  CallSession,
  CallState,
  CallType,
  ConnectWebRtcConfig,
  TERMINAL_STATES,
  TokenProvider,
} from './types';

export interface ControllerDeps {
  backendClient?: BackendClient;
  bridge?: NativeBridge;
}

type StateListener = (state: CallState) => void;
type EventListener = (event: CallEvent) => void;

/**
 * The library's public entry point. Owns the call state machine and orchestrates the three
 * collaborators: permissions → BackendClient → NativeBridge (native Chime SDK).
 *
 * State machine (JS-owned overlay in brackets, native-driven after):
 * `[idle] → [connecting] → [ringing] → connected → (reconnecting ↔ connected) → disconnected|failed`
 *
 * Faithful port of the Flutter plugin's ConnectWebRtcController (Dart).
 */
export class ConnectWebRtcController {
  private readonly config: ConnectWebRtcConfig;
  private readonly backend: BackendClient;
  private readonly bridge: NativeBridge;
  private readonly unsubscribeNative: () => void;

  private state: CallState = 'idle';
  private session: CallSession | null = null;
  private participantConnectionToken: string | null = null;
  private stateListeners = new Set<StateListener>();
  private eventListeners = new Set<EventListener>();
  private disposed = false;

  constructor(config: ConnectWebRtcConfig, tokenProvider: TokenProvider, deps: ControllerDeps = {}) {
    this.config = config;
    this.backend =
      deps.backendClient ??
      new BackendClient({
        baseUrl: config.backendBaseUrl,
        tokenProvider,
        timeoutMs: config.requestTimeoutMs,
        maxAttempts: config.maxStartAttempts,
      });
    this.bridge = deps.bridge ?? createNativeBridge();
    this.unsubscribeNative = this.bridge.addEventListener((event) => this.onNativeEvent(event));
  }

  // ── Observation ────────────────────────────────────────────────────────────

  getState(): CallState {
    return this.state;
  }

  /** The active session, if any (contains the contactId — useful for support/diagnostics). */
  getSession(): CallSession | null {
    return this.session;
  }

  get isInCall(): boolean {
    return ACTIVE_STATES.has(this.state);
  }

  /** Subscribe to state transitions; returns the unsubscribe function. */
  onStateChanged(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Subscribe to discrete call events (§B.2); returns the unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // ── Call lifecycle ─────────────────────────────────────────────────────────

  /** Starts a call: verify permissions → fetch join credentials → join the native media session.
   *  Throws PermissionDeniedError / AuthError / RateLimitedError / BackendError / MediaError on
   *  failure, and leaves the state at `failed`. */
  async startCall(request: CallRequest): Promise<void> {
    if (this.isInCall) throw new Error('A call is already in progress');
    this.setState('connecting');

    const granted = await this.bridge.ensurePermissions(request.callType);
    if (!granted) {
      this.setState('failed');
      throw new PermissionDeniedError();
    }

    let session: CallSession;
    try {
      // One idempotency key for this logical call — reused across the backend's internal retries.
      session = await this.backend.startCall(
        request,
        this.backend.newIdempotencyKey(),
        newCorrelationId(),
      );
    } catch (e) {
      this.setState('failed');
      throw e;
    }

    this.session = session;
    this.setState('ringing');

    try {
      await this.bridge.join(
        session,
        this.config.callKitEnabled ?? false,
        this.config.callDisplayName ?? 'Support',
      );
      // `connected` arrives asynchronously via the native `stateChanged` event.
    } catch (e) {
      this.setState('failed');
      throw toMediaError(e);
    }
  }

  /** Shows the OS incoming-call UI for a simulated-outbound push received on the JS side
   *  (Android FCM). On iOS the host app's PushKit delegate must report the call natively —
   *  see docs/OUTBOUND_CALLS.md. */
  reportIncomingCall(
    callId: string,
    displayName: string,
    isVideo = false,
    timeoutSeconds = 45,
  ): Promise<void> {
    return this.bridge.reportIncomingCall(callId, displayName, isVideo, timeoutSeconds);
  }

  /** Answers a ringing simulated-outbound call: verify permissions → exchange the callId for the
   *  join credentials (`POST /calls/outbound/{callId}/answer`) → attach the media to the call the
   *  OS is already showing. Call this from your `incomingCallAnswered` event handler. */
  async answerIncomingCall(callId: string, callType: CallType = 'audio'): Promise<void> {
    if (this.isInCall) throw new Error('A call is already in progress');
    this.setState('connecting');

    const granted = await this.bridge.ensurePermissions(callType);
    if (!granted) {
      this.setState('failed');
      throw new PermissionDeniedError();
    }

    let session: CallSession;
    try {
      session = await this.backend.answerOutboundCall(callId, newCorrelationId());
    } catch (e) {
      this.setState('failed');
      throw e;
    }

    this.session = session;
    try {
      await this.bridge.join(
        session,
        this.config.callKitEnabled ?? false,
        this.config.callDisplayName ?? 'Support',
        true,
      );
      // `connected` arrives asynchronously via the native `stateChanged` event.
    } catch (e) {
      this.setState('failed');
      throw toMediaError(e);
    }
  }

  /** Declines a ringing simulated-outbound call: dismisses the ring UI (best-effort) and tells the
   *  backend to stop the contact so the waiting agent is released immediately. */
  async declineIncomingCall(callId: string): Promise<void> {
    await this.bridge.dismissIncomingCall().catch(() => undefined);
    await this.backend.declineOutboundCall(callId, newCorrelationId());
  }

  /** Cold-start recovery: when the user answered the OS ring UI before the JS bundle was running,
   *  the native side parks the answer. Call once at startup; answers the parked call and returns
   *  true, or returns false when nothing is pending. */
  async handlePendingIncomingCall(): Promise<boolean> {
    const pending = await this.bridge.getPendingIncomingCall();
    if (!pending?.callId) return false;
    await this.answerIncomingCall(pending.callId, pending.isVideo ? 'video' : 'audio');
    return true;
  }

  async endCall(): Promise<void> {
    const session = this.session;
    try {
      await this.bridge.leave();
    } finally {
      if (session) {
        // Best-effort server-side stop; never block or fail the local teardown on it.
        this.backend.endCall(session.contactId).catch(() => undefined);
      }
      this.session = null;
      this.participantConnectionToken = null;
      this.setState('disconnected');
    }
  }

  /** Sends DTMF digits (`0-9`, `*`, `#`, `,` for a pause) to the Connect IVR — e.g. "Press 1 for
   *  billing". Digits travel via the Connect Participant Service (not the audio stream); the
   *  participant connection is created lazily on first use and retried once if it has expired. */
  async sendDtmf(digits: string): Promise<void> {
    const session = this.session;
    if (!session) throw new Error('No active call to send DTMF on');
    if (!DTMF_PATTERN.test(digits)) {
      throw new InvalidRequestError('INVALID_DTMF', `digits must match ${DTMF_PATTERN}`, 400);
    }

    this.participantConnectionToken ??= await this.backend.createParticipantConnection(
      session.participantToken,
    );
    try {
      await this.backend.sendDtmf(this.participantConnectionToken, digits);
    } catch (e) {
      if (!(e instanceof ConnectWebRtcError)) throw e;
      // The connection may have expired — recreate once and retry.
      this.participantConnectionToken = await this.backend.createParticipantConnection(
        session.participantToken,
      );
      await this.backend.sendDtmf(this.participantConnectionToken, digits);
    }
  }

  // ── In-call controls ───────────────────────────────────────────────────────

  setMuted(muted: boolean): Promise<boolean> {
    return this.bridge.setMuted(muted);
  }

  enableLocalVideo(): Promise<void> {
    return this.bridge.setLocalVideoEnabled(true);
  }

  disableLocalVideo(): Promise<void> {
    return this.bridge.setLocalVideoEnabled(false);
  }

  switchCamera(): Promise<void> {
    return this.bridge.switchCamera();
  }

  setSpeakerphone(enabled: boolean): Promise<void> {
    return this.bridge.setSpeakerphoneEnabled(enabled);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeNative();
    this.stateListeners.clear();
    this.eventListeners.clear();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private onNativeEvent(event: CallEvent): void {
    if (this.disposed) return;
    if (event.type === 'stateChanged') {
      this.setState(event.state);
      if (TERMINAL_STATES.has(event.state)) {
        this.session = null;
        this.participantConnectionToken = null;
      }
    }
    for (const listener of this.eventListeners) listener(event);
    if (event.type === 'error' && event.fatal) {
      this.setState('failed');
      this.session = null;
      this.participantConnectionToken = null;
    }
  }

  private setState(next: CallState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }
}

function newCorrelationId(): string {
  return `rn-${Date.now()}-${Math.floor(Math.random() * 0xffff)}`;
}

function toMediaError(e: unknown): Error {
  if (e instanceof ConnectWebRtcError) return e;
  // React Native rejects native promise errors as {code, message}.
  const native = e as { code?: string; message?: string };
  if (native?.code === 'permissionDenied') return new PermissionDeniedError(native.message);
  return new MediaError(native?.code ?? 'sdkError', native?.message ?? String(e));
}
