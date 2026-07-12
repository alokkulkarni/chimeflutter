/** Public types — mirrors the shared contract in specs/003-api-contracts.md. */

export type CallType = 'audio' | 'video';

/** Dart-parity state machine:
 *  idle → connecting → ringing → connected → (reconnecting ↔ connected) → disconnected | failed */
export type CallState =
  | 'idle'
  | 'connecting'
  | 'ringing'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed';

export const ACTIVE_STATES: ReadonlySet<CallState> = new Set([
  'connecting',
  'ringing',
  'connected',
  'reconnecting',
]);
export const TERMINAL_STATES: ReadonlySet<CallState> = new Set(['disconnected', 'failed']);

export interface MediaPlacement {
  audioHostUrl: string;
  audioFallbackUrl?: string;
  signalingUrl: string;
  turnControlUrl?: string;
  eventIngestionUrl?: string;
}

export interface Meeting {
  meetingId: string;
  mediaRegion: string;
  mediaPlacement: MediaPlacement;
}

export interface Attendee {
  attendeeId: string;
  joinToken: string;
}

/** The normalised join credentials returned by `POST /calls` (§A.2). */
export interface CallSession {
  contactId: string;
  participantId: string;
  participantToken: string;
  callType: CallType;
  meeting: Meeting;
  attendee: Attendee;
}

export interface DeviceInfo {
  platform: 'iOS' | 'Android';
  osVersion: string;
  appVersion: string;
  deviceModel: string;
  locale: string;
  networkType: string;
}

export interface CallRequest {
  callType: CallType;
  /** Shown to the agent; server defaults + truncates to 256 chars. */
  displayName?: string;
  /** ONLY allow-listed keys reach Connect (server-enforced; see backend AllowedClientAttributeKeys). */
  context?: Record<string, string>;
  device: DeviceInfo;
}

/** Discriminated union of everything the native side reports (§B.2). */
export type CallEvent =
  | { type: 'stateChanged'; state: CallState; reason?: string }
  | { type: 'muteChanged'; muted: boolean }
  | { type: 'participantJoined'; attendeeId: string; externalUserId?: string }
  | { type: 'participantLeft'; attendeeId: string }
  | { type: 'localVideoAvailable'; tileId: number }
  | { type: 'remoteVideoAvailable'; tileId: number; attendeeId: string }
  | { type: 'videoTileRemoved'; tileId: number }
  | { type: 'audioRouteChanged'; route: 'speaker' | 'receiver' | 'bluetooth' | 'headset' }
  | { type: 'networkQualityChanged'; quality: 'good' | 'poor'; attendeeId?: string }
  | { type: 'error'; code: string; message: string; fatal: boolean };

/** Bearer token sent as `Authorization: Bearer <token>`. Return '' for no header (e.g. while the
 *  demo backend runs auth-free). NEVER hard-code tokens — read them from your session. */
export type TokenProvider = () => Promise<string> | string;

export interface ConnectWebRtcConfig {
  /** The `ApiBaseUrl` output of `sam deploy`, e.g. https://…execute-api…amazonaws.com/v1.
   *  Must be https:// (http:// is rejected except for localhost dev hosts). */
  backendBaseUrl: string;
  /** Register the call with CallKit (iOS) / Telecom (Android) so the OS shows a real call. */
  callKitEnabled?: boolean;
  /** Name shown in the system call UI. */
  callDisplayName?: string;
  /** Per-request timeout in ms (default 15000). */
  requestTimeoutMs?: number;
  /** Attempts for the start-call request (default 3; retries reuse ONE idempotency key). */
  maxStartAttempts?: number;
}
