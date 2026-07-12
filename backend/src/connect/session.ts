/**
 * Normalises an Amazon Connect `StartWebRTCContact` response into the client-facing `CallSession`.
 *
 * Requirement: FR-B4 / NFR-1 — expose exactly what the Chime SDK needs to join (meeting + attendee)
 * plus the contactId/participantToken, in clean camelCase, and never leak Connect internals.
 *
 * The native bridge later rebuilds a Chime `MeetingSessionConfiguration` from these fields, injecting
 * `externalUserId = ""` (Connect's Attendee has no ExternalUserId), matching AWS's official samples.
 */
import type { StartWebRTCContactResponse } from '@aws-sdk/client-connect';
import { upstreamUnavailable } from '../http/errors';
import type { CallSession, CallType } from '../domain/types';

function requireField<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null || value === '') {
    throw upstreamUnavailable(`Upstream response missing required field: ${name}`);
  }
  return value;
}

export function toCallSession(response: StartWebRTCContactResponse, callType: CallType): CallSession {
  const connection = requireField(response.ConnectionData, 'ConnectionData');
  const meeting = requireField(connection.Meeting, 'ConnectionData.Meeting');
  const attendee = requireField(connection.Attendee, 'ConnectionData.Attendee');
  const placement = requireField(meeting.MediaPlacement, 'ConnectionData.Meeting.MediaPlacement');

  return {
    contactId: requireField(response.ContactId, 'ContactId'),
    participantId: requireField(response.ParticipantId, 'ParticipantId'),
    participantToken: requireField(response.ParticipantToken, 'ParticipantToken'),
    callType,
    meeting: {
      meetingId: requireField(meeting.MeetingId, 'Meeting.MeetingId'),
      mediaRegion: meeting.MediaRegion,
      mediaPlacement: {
        audioHostUrl: requireField(placement.AudioHostUrl, 'MediaPlacement.AudioHostUrl'),
        audioFallbackUrl: placement.AudioFallbackUrl,
        signalingUrl: requireField(placement.SignalingUrl, 'MediaPlacement.SignalingUrl'),
        turnControlUrl: placement.TurnControlUrl,
        eventIngestionUrl: placement.EventIngestionUrl,
      },
    },
    attendee: {
      attendeeId: requireField(attendee.AttendeeId, 'Attendee.AttendeeId'),
      joinToken: requireField(attendee.JoinToken, 'Attendee.JoinToken'),
    },
  };
}
