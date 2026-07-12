/**
 * Maps the client's requested call type to the Amazon Connect `AllowedCapabilities`.
 *
 * Requirement: FR-B3. Per the Connect API, `ParticipantCapabilities` exposes only `Video` and
 * `ScreenShare` (valid value `SEND`) — audio is always-on for a WebRTC contact and is NOT requested
 * via a capability. So an audio call sends no `AllowedCapabilities` at all; a video call grants
 * `Video: SEND` to both the customer and the agent.
 */
import type { AllowedCapabilities } from '@aws-sdk/client-connect';
import { badRequest } from '../http/errors';
import type { CallType } from '../domain/types';

export function parseCallType(value: unknown): CallType {
  if (value === 'audio' || value === 'video') return value;
  throw badRequest('INVALID_CALL_TYPE', "callType must be 'audio' or 'video'");
}

export function buildAllowedCapabilities(callType: CallType): AllowedCapabilities | undefined {
  if (callType === 'audio') return undefined;
  return {
    Customer: { Video: 'SEND' },
    Agent: { Video: 'SEND' },
  };
}
