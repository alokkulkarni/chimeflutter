import { mockClient } from 'aws-sdk-client-mock';
import { ConnectClient, GetCurrentUserDataCommand } from '@aws-sdk/client-connect';
import {
  isRingExpired,
  recordTtlSeconds,
  toStatusView,
  type OutboundCallRecord,
} from '../../src/domain/outbound';
import {
  createAgentStatusPort,
  evaluateAgentAvailability,
  toUserId,
} from '../../src/connect/agentAvailability';
import { parseOutboundCallRequest, parseRegisterDeviceRequest } from '../../src/http/parseOutbound';
import type { CallSession } from '../../src/domain/types';

const SESSION: CallSession = {
  contactId: 'contact-1',
  participantId: 'part-1',
  participantToken: 'ptoken-1',
  callType: 'audio',
  meeting: {
    meetingId: 'meet-1',
    mediaPlacement: { audioHostUrl: 'https://a', signalingUrl: 'wss://s' },
  },
  attendee: { attendeeId: 'att-1', joinToken: 'jt-1' },
};

function record(overrides: Partial<OutboundCallRecord> = {}): OutboundCallRecord {
  return {
    callId: 'call-1',
    customerId: 'cust-1',
    agentId: 'agent-1',
    agentResource: 'arn:aws:connect:eu-west-2:1:instance/i/agent/agent-1',
    callType: 'audio',
    callerDisplayName: 'Support',
    status: 'ringing',
    session: SESSION,
    createdAt: 1_000,
    expiresAt: 46_000,
    correlationId: 'corr-1',
    ttl: 86_401,
    ...overrides,
  };
}

describe('outbound domain', () => {
  it('isRingExpired is true only for ringing records past expiresAt', () => {
    expect(isRingExpired(record(), 46_001)).toBe(true);
    expect(isRingExpired(record(), 45_999)).toBe(false);
    expect(isRingExpired(record({ status: 'answered' }), 99_999)).toBe(false);
  });

  it('toStatusView exposes no tokens', () => {
    const view = toStatusView(record());
    expect(view).toEqual({
      callId: 'call-1',
      contactId: 'contact-1',
      status: 'ringing',
      callType: 'audio',
      createdAt: 1_000,
      expiresAt: 46_000,
      answeredAt: undefined,
      endedAt: undefined,
    });
    expect(JSON.stringify(view)).not.toContain('jt-1');
    expect(JSON.stringify(view)).not.toContain('ptoken-1');
  });

  it('recordTtlSeconds is one day out, in seconds', () => {
    expect(recordTtlSeconds(10_000)).toBe(10 + 24 * 60 * 60);
  });
});

describe('evaluateAgentAvailability', () => {
  it('requires the agent to exist', () => {
    expect(evaluateAgentAvailability({ found: false })).toEqual({
      available: false,
      reason: 'AGENT_NOT_FOUND',
    });
  });

  it('uses free voice slots when reported', () => {
    expect(
      evaluateAgentAvailability({ found: true, statusName: 'Available', availableVoiceSlots: 1 }),
    ).toEqual({ available: true, reason: 'OK' });
    expect(
      evaluateAgentAvailability({ found: true, statusName: 'Available', availableVoiceSlots: 0 }),
    ).toEqual({ available: false, reason: 'NO_FREE_VOICE_SLOT' });
  });

  it('falls back to the status name when slots are not reported', () => {
    expect(evaluateAgentAvailability({ found: true, statusName: 'Available' })).toEqual({
      available: true,
      reason: 'OK',
    });
    expect(evaluateAgentAvailability({ found: true, statusName: 'Lunch' })).toEqual({
      available: false,
      reason: 'AGENT_NOT_ROUTABLE',
    });
  });
});

describe('toUserId', () => {
  it('passes plain user ids through', () => {
    expect(toUserId('11111111-2222-3333-4444-555555555555')).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
  });
  it('extracts the id from an agent ARN', () => {
    expect(
      toUserId('arn:aws:connect:eu-west-2:123:instance/inst-1/agent/user-9'),
    ).toBe('user-9');
  });
});

describe('createAgentStatusPort', () => {
  const connectMock = mockClient(ConnectClient);
  beforeEach(() => connectMock.reset());

  it('maps GetCurrentUserData to a snapshot', async () => {
    connectMock.on(GetCurrentUserDataCommand).resolves({
      UserDataList: [
        {
          User: { Id: 'user-9', Arn: 'arn:aws:connect:eu-west-2:123:instance/i/agent/user-9' },
          Status: { StatusName: 'Available' },
          AvailableSlotsByChannel: { VOICE: 1 },
        },
      ],
    });
    const port = createAgentStatusPort(connectMock as unknown as ConnectClient, 'inst-1');
    const snapshot = await port.getAgentSnapshot('user-9');
    expect(snapshot).toEqual({
      found: true,
      arn: 'arn:aws:connect:eu-west-2:123:instance/i/agent/user-9',
      statusName: 'Available',
      availableVoiceSlots: 1,
    });
    const input = connectMock.commandCalls(GetCurrentUserDataCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ InstanceId: 'inst-1', Filters: { Agents: ['user-9'] } });
  });

  it('reports found=false when the agent is not in the response', async () => {
    connectMock.on(GetCurrentUserDataCommand).resolves({ UserDataList: [] });
    const port = createAgentStatusPort(connectMock as unknown as ConnectClient, 'inst-1');
    await expect(port.getAgentSnapshot('user-9')).resolves.toEqual({ found: false });
  });
});

describe('parseRegisterDeviceRequest', () => {
  it('accepts a valid registration', () => {
    expect(
      parseRegisterDeviceRequest(
        JSON.stringify({ customerId: 'cust-1', platform: 'ios', pushToken: 'tok' }),
      ),
    ).toEqual({ customerId: 'cust-1', platform: 'iOS', pushToken: 'tok' });
  });

  it.each([
    [{ platform: 'ios', pushToken: 't' }, 'INVALID_CUSTOMER_ID'],
    [{ customerId: 'c a!', platform: 'ios', pushToken: 't' }, 'INVALID_CUSTOMER_ID'],
    [{ customerId: 'c', platform: 'windows', pushToken: 't' }, 'INVALID_PLATFORM'],
    [{ customerId: 'c', platform: 'ios' }, 'INVALID_PUSH_TOKEN'],
  ])('rejects %j with %s', (body, code) => {
    expect(() => parseRegisterDeviceRequest(JSON.stringify(body))).toThrow(
      expect.objectContaining({ code }),
    );
  });
});

describe('parseOutboundCallRequest', () => {
  it('applies display-name defaults and keeps context', () => {
    const parsed = parseOutboundCallRequest(
      JSON.stringify({
        customerId: 'cust-1',
        agentId: 'user-9',
        callType: 'video',
        context: { issueType: 'billing' },
      }),
    );
    expect(parsed).toEqual({
      customerId: 'cust-1',
      agentId: 'user-9',
      callType: 'video',
      callerDisplayName: 'Support',
      customerDisplayName: 'Mobile Customer',
      context: { issueType: 'billing' },
    });
  });

  it('accepts a full agent ARN', () => {
    const arn = 'arn:aws:connect:eu-west-2:123:instance/inst-1/agent/user-9';
    expect(
      parseOutboundCallRequest(
        JSON.stringify({ customerId: 'c', agentId: arn, callType: 'audio' }),
      ).agentId,
    ).toBe(arn);
  });

  it.each([
    [{ customerId: 'c', callType: 'audio' }, 'INVALID_AGENT_ID'],
    [{ customerId: 'c', agentId: 'a', callType: 'fax' }, 'INVALID_CALL_TYPE'],
  ])('rejects %j with %s', (body, code) => {
    expect(() => parseOutboundCallRequest(JSON.stringify(body))).toThrow(
      expect.objectContaining({ code }),
    );
  });
});
