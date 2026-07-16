/**
 * Domain types for **simulated outbound** (agent-initiated) in-app calls.
 *
 * Amazon Connect has no outbound-WebRTC API: `StartOutboundVoiceContact` is PSTN-only and
 * `StartWebRTCContact` is formally an *inbound* contact. So an agent-initiated call is modelled as
 * a backend-created inbound WebRTC contact that (a) is routed straight to the initiating agent's
 * personal queue — occupying their voice slot so they cannot receive other calls while the customer
 * device rings — and (b) wakes the customer device with a VoIP/FCM push carrying only the callId.
 * The device fetches the join credentials on answer; they never travel inside a push payload.
 */
import type { CallSession, CallType } from './types';

export type DevicePlatform = 'iOS' | 'Android';

/** One registered push destination per customer (upsert semantics). */
export interface DeviceRecord {
  customerId: string;
  platform: DevicePlatform;
  /** APNs VoIP device token (iOS) or FCM registration token (Android). */
  pushToken: string;
  /** SNS platform-endpoint ARN created for the token. */
  endpointArn: string;
  /** Epoch ms of last registration. */
  updatedAt: number;
}

export type OutboundCallStatus = 'ringing' | 'answered' | 'declined' | 'cancelled' | 'timedOut';

/** Server-side record of one simulated-outbound call attempt. */
export interface OutboundCallRecord {
  callId: string;
  customerId: string;
  /** The Connect user (agent) id or ARN as supplied by the caller. */
  agentId: string;
  /** The agent resource written into the `targetAgentArn` contact attribute (ARN preferred). */
  agentResource: string;
  callType: CallType;
  /** Name shown on the customer's incoming-call UI (e.g. "Acme Support"). */
  callerDisplayName: string;
  status: OutboundCallStatus;
  /** The full join credentials, returned to the device only on answer. */
  session: CallSession;
  createdAt: number;
  /** Epoch ms deadline: unanswered past this point the call is timed out and the contact stopped. */
  expiresAt: number;
  answeredAt?: number;
  endedAt?: number;
  correlationId: string;
  /** DynamoDB TTL (epoch **seconds**) for physical cleanup well after the call is over. */
  ttl: number;
}

/** The agent/dashboard-facing request body for `POST /calls/outbound`. */
export interface OutboundCallRequest {
  customerId: string;
  agentId: string;
  callType: CallType;
  /** Shown on the customer's ring UI. */
  callerDisplayName: string;
  /** Shown to the agent in the CCP (Connect ParticipantDetails.DisplayName). */
  customerDisplayName: string;
  /** Free-form context; only allow-listed keys reach Connect (same rule as inbound). */
  context?: Record<string, string>;
}

/** The device registration body for `POST /devices`. */
export interface RegisterDeviceRequest {
  customerId: string;
  platform: DevicePlatform;
  pushToken: string;
}

/** Status view returned by `GET /calls/outbound/{callId}` — never contains tokens. */
export interface OutboundCallStatusView {
  callId: string;
  contactId: string;
  status: OutboundCallStatus;
  callType: CallType;
  createdAt: number;
  expiresAt: number;
  answeredAt?: number;
  endedAt?: number;
}

export function isRingExpired(record: OutboundCallRecord, nowMs: number): boolean {
  return record.status === 'ringing' && nowMs > record.expiresAt;
}

export function toStatusView(record: OutboundCallRecord): OutboundCallStatusView {
  return {
    callId: record.callId,
    contactId: record.session.contactId,
    status: record.status,
    callType: record.callType,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    answeredAt: record.answeredAt,
    endedAt: record.endedAt,
  };
}

/** Keep finished records queryable for a day, then let DynamoDB TTL delete them. */
export function recordTtlSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000) + 24 * 60 * 60;
}
