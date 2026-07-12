/**
 * Shared domain types for the ChimeFlutter backend.
 *
 * These describe the *client-facing* contract (request body + normalised CallSession response) and
 * are deliberately decoupled from the AWS SDK's PascalCase Connect types. See
 * `specs/003-api-contracts.md`.
 */

export type CallType = 'audio' | 'video';

export interface DeviceInfo {
  /** 'iOS' | 'Android' (validated). */
  platform: string;
  osVersion?: string;
  appVersion?: string;
  deviceModel?: string;
  locale?: string;
  /** e.g. 'wifi' | 'cellular' | '4g' | '5g'. */
  networkType?: string;
}

/** The request body the mobile client POSTs to `/v1/calls`. */
export interface CallRequest {
  callType: CallType;
  /** Display name shown to the agent. Optional; server may substitute a default. */
  displayName?: string;
  /** Free-form client context; only allow-listed keys reach Connect (NFR-2). */
  context?: Record<string, string>;
  device: DeviceInfo;
}

/** Normalised media placement — camelCase, exactly what the native Chime SDK bridge needs. */
export interface MediaPlacement {
  audioHostUrl: string;
  audioFallbackUrl?: string;
  signalingUrl: string;
  turnControlUrl?: string;
  eventIngestionUrl?: string;
}

export interface CallMeeting {
  meetingId: string;
  mediaRegion?: string;
  mediaPlacement: MediaPlacement;
}

export interface CallAttendee {
  attendeeId: string;
  joinToken: string;
}

/**
 * The normalised response returned to the mobile client. Contains exactly what the Chime SDK needs
 * to join, plus the contactId/participantToken. It never contains the Connect InstanceId or
 * ContactFlowId (FR-B4 / NFR-1).
 */
export interface CallSession {
  contactId: string;
  participantId: string;
  participantToken: string;
  callType: CallType;
  meeting: CallMeeting;
  attendee: CallAttendee;
}
