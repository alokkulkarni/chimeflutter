import type { StartWebRTCContactResponse } from '@aws-sdk/client-connect';
import { toCallSession } from '../../src/connect/session';
import { AppError } from '../../src/http/errors';

const goodResponse: StartWebRTCContactResponse = {
  ConnectionData: {
    Attendee: { AttendeeId: 'att-1', JoinToken: 'join-token-abc' },
    Meeting: {
      MeetingId: 'meeting-1',
      MediaRegion: 'eu-west-2',
      MediaPlacement: {
        AudioHostUrl: 'https://audio.example',
        AudioFallbackUrl: 'https://audiofb.example',
        SignalingUrl: 'wss://signal.example',
        TurnControlUrl: 'https://turn.example',
        EventIngestionUrl: 'https://ingest.example',
      },
    },
  },
  ContactId: 'contact-1',
  ParticipantId: 'participant-1',
  ParticipantToken: 'participant-token-xyz',
};

describe('FR-B4 — normalise StartWebRTCContact response to CallSession', () => {
  it('maps PascalCase Connect fields to the camelCase client contract', () => {
    const session = toCallSession(goodResponse, 'video');
    expect(session).toEqual({
      contactId: 'contact-1',
      participantId: 'participant-1',
      participantToken: 'participant-token-xyz',
      callType: 'video',
      meeting: {
        meetingId: 'meeting-1',
        mediaRegion: 'eu-west-2',
        mediaPlacement: {
          audioHostUrl: 'https://audio.example',
          audioFallbackUrl: 'https://audiofb.example',
          signalingUrl: 'wss://signal.example',
          turnControlUrl: 'https://turn.example',
          eventIngestionUrl: 'https://ingest.example',
        },
      },
      attendee: { attendeeId: 'att-1', joinToken: 'join-token-abc' },
    });
  });

  it('NFR-1: the serialised session leaks no InstanceId / ContactFlowId', () => {
    const json = JSON.stringify(toCallSession(goodResponse, 'audio'));
    expect(json.toLowerCase()).not.toContain('instanceid');
    expect(json.toLowerCase()).not.toContain('contactflowid');
  });

  it('throws UPSTREAM_ERROR when the Meeting is missing', () => {
    const bad = { ...goodResponse, ConnectionData: { Attendee: goodResponse.ConnectionData!.Attendee } };
    expect(() => toCallSession(bad, 'audio')).toThrow(AppError);
    try {
      toCallSession(bad, 'audio');
    } catch (e) {
      expect((e as AppError).code).toBe('UPSTREAM_ERROR');
    }
  });

  it('throws when the Attendee JoinToken is missing', () => {
    const bad: StartWebRTCContactResponse = {
      ...goodResponse,
      ConnectionData: {
        ...goodResponse.ConnectionData,
        Attendee: { AttendeeId: 'att-1' },
      },
    };
    expect(() => toCallSession(bad, 'audio')).toThrow(/UPSTREAM_ERROR|missing/i);
  });

  it('throws when required media URLs are missing', () => {
    const bad: StartWebRTCContactResponse = {
      ...goodResponse,
      ConnectionData: {
        ...goodResponse.ConnectionData,
        Meeting: { MeetingId: 'm', MediaPlacement: { AudioFallbackUrl: 'x' } },
      },
    };
    expect(() => toCallSession(bad, 'audio')).toThrow(AppError);
  });

  it('tolerates absent optional media URLs (fallback/turn/ingestion)', () => {
    const minimal: StartWebRTCContactResponse = {
      ...goodResponse,
      ConnectionData: {
        Attendee: { AttendeeId: 'a', JoinToken: 'j' },
        Meeting: {
          MeetingId: 'm',
          MediaPlacement: { AudioHostUrl: 'https://a', SignalingUrl: 'wss://s' },
        },
      },
    };
    const session = toCallSession(minimal, 'audio');
    expect(session.meeting.mediaPlacement.audioFallbackUrl).toBeUndefined();
    expect(session.meeting.mediaPlacement.audioHostUrl).toBe('https://a');
    expect(session.meeting.mediaPlacement.signalingUrl).toBe('wss://s');
  });
});
