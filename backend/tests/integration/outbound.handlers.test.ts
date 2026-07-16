/**
 * Handler-level tests for the simulated-outbound feature: register device → start outbound call
 * (agent availability gate, agent-queue routing attributes, push) → answer/decline/status → ring
 * timeout sweep. Ports are in-memory fakes; the Connect port is a recording stub.
 */
import type { StartWebRTCContactResponse } from '@aws-sdk/client-connect';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createRegisterDeviceHandler } from '../../src/handlers/registerDevice';
import { createStartOutboundCallHandler } from '../../src/handlers/startOutboundCall';
import { createOutboundCallActionHandler } from '../../src/handlers/outboundCallAction';
import { createSweepOutboundCallsHandler } from '../../src/handlers/sweepOutboundCalls';
import type { ConnectPort, StartContactInput } from '../../src/connect/connectClient';
import type { AgentSnapshot, AgentStatusPort } from '../../src/connect/agentAvailability';
import type { DeviceStore } from '../../src/store/deviceStore';
import type { OutboundCallStore } from '../../src/store/outboundCallStore';
import type { PushPort } from '../../src/push/pushSender';
import type { DeviceRecord, OutboundCallRecord, OutboundCallStatus } from '../../src/domain/outbound';

const CONNECT_OK: StartWebRTCContactResponse = {
  ConnectionData: {
    Attendee: { AttendeeId: 'att-1', JoinToken: 'jt-1' },
    Meeting: {
      MeetingId: 'meet-1',
      MediaRegion: 'eu-west-2',
      MediaPlacement: { AudioHostUrl: 'https://audio', SignalingUrl: 'wss://signal' },
    },
  },
  ContactId: 'contact-1',
  ParticipantId: 'part-1',
  ParticipantToken: 'ptoken-1',
};

const AGENT_ARN = 'arn:aws:connect:eu-west-2:1:instance/inst-1/agent/user-9';

function fakeConnect() {
  const started: StartContactInput[] = [];
  const stopped: string[] = [];
  const port: ConnectPort = {
    async startWebRtcContact(input) {
      started.push(input);
      return CONNECT_OK;
    },
    async stopContact(contactId) {
      stopped.push(contactId);
    },
  };
  return { port, started, stopped };
}

function fakeAgentStatus(snapshot: AgentSnapshot): AgentStatusPort {
  return { getAgentSnapshot: async () => snapshot };
}

function memDeviceStore(initial: DeviceRecord[] = []) {
  const items = new Map(initial.map((d) => [d.customerId, d]));
  const store: DeviceStore = {
    async get(customerId) {
      return items.get(customerId);
    },
    async put(record) {
      items.set(record.customerId, record);
    },
  };
  return { store, items };
}

function memCallStore(initial: OutboundCallRecord[] = []) {
  const items = new Map(initial.map((r) => [r.callId, r]));
  const store: OutboundCallStore = {
    async get(callId) {
      return items.get(callId);
    },
    async put(record) {
      items.set(record.callId, record);
    },
    async transitionFromRinging(callId, next, timestamps) {
      const current = items.get(callId);
      if (!current || current.status !== 'ringing') return false;
      items.set(callId, { ...current, status: next as OutboundCallStatus, ...timestamps });
      return true;
    },
    async listExpiredRinging(nowMs) {
      return [...items.values()].filter((r) => r.status === 'ringing' && r.expiresAt < nowMs);
    },
  };
  return { store, items };
}

function fakePush(opts: { failPublish?: boolean } = {}) {
  const registered: unknown[] = [];
  const published: unknown[] = [];
  const port: PushPort = {
    async registerEndpoint(input) {
      registered.push(input);
      return `arn:endpoint/${input.platform}`;
    },
    async publishIncomingCall(endpointArn, platform, push) {
      if (opts.failPublish) throw new Error('APNs is down');
      published.push({ endpointArn, platform, push });
    },
  };
  return { port, registered, published };
}

function postEvent(path: string, body?: unknown, pathParameters?: Record<string, string>) {
  return {
    version: '2.0',
    rawPath: path,
    headers: { 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST', path } },
    pathParameters,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function getEvent(path: string, pathParameters?: Record<string, string>) {
  return {
    version: '2.0',
    rawPath: path,
    headers: {},
    requestContext: { http: { method: 'GET', path } },
    pathParameters,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const DEVICE: DeviceRecord = {
  customerId: 'cust-1',
  platform: 'iOS',
  pushToken: 'tok-1',
  endpointArn: 'arn:endpoint/ios',
  updatedAt: 0,
};

const AVAILABLE: AgentSnapshot = {
  found: true,
  arn: AGENT_ARN,
  statusName: 'Available',
  availableVoiceSlots: 1,
};

let now = 100_000;
const clock = () => now;
let seq = 0;
const ids = () => `id-${++seq}`;

beforeEach(() => {
  now = 100_000;
  seq = 0;
});

describe('POST /devices', () => {
  it('registers the endpoint and stores the device', async () => {
    const devices = memDeviceStore();
    const push = fakePush();
    const handler = createRegisterDeviceHandler({
      devices: devices.store,
      push: push.port,
      idGenerator: ids,
      now: clock,
      logLevel: 'error',
    });
    const res = await handler(
      postEvent('/v1/devices', { customerId: 'cust-1', platform: 'ios', pushToken: 'tok-1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(devices.items.get('cust-1')).toMatchObject({
      platform: 'iOS',
      pushToken: 'tok-1',
      endpointArn: 'arn:endpoint/iOS',
    });
  });

  it('propagates PUSH_NOT_CONFIGURED as its own status (501)', async () => {
    const devices = memDeviceStore();
    const push = fakePush();
    push.port.registerEndpoint = async () => {
      const { AppError } = await import('../../src/http/errors');
      throw new AppError(501, 'PUSH_NOT_CONFIGURED', 'no app');
    };
    const handler = createRegisterDeviceHandler({
      devices: devices.store,
      push: push.port,
      idGenerator: ids,
      now: clock,
      logLevel: 'error',
    });
    const res = await handler(
      postEvent('/v1/devices', { customerId: 'cust-1', platform: 'ios', pushToken: 'tok-1' }),
    );
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body as string).error.code).toBe('PUSH_NOT_CONFIGURED');
  });
});

describe('POST /calls/outbound', () => {
  function makeHandler(overrides: {
    snapshot?: AgentSnapshot;
    devices?: ReturnType<typeof memDeviceStore>;
    calls?: ReturnType<typeof memCallStore>;
    push?: ReturnType<typeof fakePush>;
    connect?: ReturnType<typeof fakeConnect>;
  } = {}) {
    const devices = overrides.devices ?? memDeviceStore([DEVICE]);
    const calls = overrides.calls ?? memCallStore();
    const push = overrides.push ?? fakePush();
    const connect = overrides.connect ?? fakeConnect();
    const handler = createStartOutboundCallHandler({
      connect: connect.port,
      agentStatus: fakeAgentStatus(overrides.snapshot ?? AVAILABLE),
      devices: devices.store,
      calls: calls.store,
      push: push.port,
      allowedClientAttributeKeys: new Set(['issueType']),
      idGenerator: ids,
      now: clock,
      ringTimeoutSeconds: 45,
      logLevel: 'error',
    });
    return { handler, devices, calls, push, connect };
  }

  const BODY = { customerId: 'cust-1', agentId: 'user-9', callType: 'audio' };

  it('starts the contact routed to the agent and rings the device', async () => {
    const { handler, calls, push, connect } = makeHandler();
    const res = await handler(postEvent('/v1/calls/outbound', BODY));

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body as string);
    expect(body).toMatchObject({ contactId: 'contact-1', status: 'ringing' });
    expect(body.expiresAt).toBe(100_000 + 45_000);
    // The response for the AGENT side never contains the customer's join credentials.
    expect(res.body).not.toContain('jt-1');
    expect(res.body).not.toContain('ptoken-1');

    // Contact attributes drive the outbound flow's set-queue-by-agent step.
    expect(connect.started[0]!.attributes).toMatchObject({
      direction: 'outbound',
      targetAgentArn: AGENT_ARN,
      customerId: 'cust-1',
    });

    // Push carries only the call reference.
    expect(push.published).toHaveLength(1);
    const pushed = push.published[0] as { push: { callId: string } };
    expect(pushed.push.callId).toBe(body.callId);

    // Server-side record keeps the credentials for the answer exchange.
    expect(calls.items.get(body.callId)!.session.attendee.joinToken).toBe('jt-1');
  });

  it('404s when the customer has no registered device (nothing started)', async () => {
    const { handler, connect } = makeHandler({ devices: memDeviceStore() });
    const res = await handler(postEvent('/v1/calls/outbound', BODY));
    expect(res.statusCode).toBe(404);
    expect(connect.started).toHaveLength(0);
  });

  it('409s AGENT_NOT_AVAILABLE when the agent has no free voice slot', async () => {
    const { handler, connect } = makeHandler({
      snapshot: { ...AVAILABLE, availableVoiceSlots: 0 },
    });
    const res = await handler(postEvent('/v1/calls/outbound', BODY));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body as string).error.code).toBe('AGENT_NOT_AVAILABLE');
    expect(connect.started).toHaveLength(0);
  });

  it('stops the contact again when the push cannot be delivered', async () => {
    const push = fakePush({ failPublish: true });
    const { handler, connect, calls } = makeHandler({ push });
    const res = await handler(postEvent('/v1/calls/outbound', BODY));
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body as string).error.code).toBe('PUSH_FAILED');
    expect(connect.stopped).toEqual(['contact-1']);
    expect([...calls.items.values()][0]!.status).toBe('cancelled');
  });
});

describe('outbound call actions', () => {
  function ringingRecord(overrides: Partial<OutboundCallRecord> = {}): OutboundCallRecord {
    return {
      callId: 'call-1',
      customerId: 'cust-1',
      agentId: 'user-9',
      agentResource: AGENT_ARN,
      callType: 'audio',
      callerDisplayName: 'Support',
      status: 'ringing',
      session: {
        contactId: 'contact-1',
        participantId: 'part-1',
        participantToken: 'ptoken-1',
        callType: 'audio',
        meeting: {
          meetingId: 'meet-1',
          mediaPlacement: { audioHostUrl: 'https://a', signalingUrl: 'wss://s' },
        },
        attendee: { attendeeId: 'att-1', joinToken: 'jt-1' },
      },
      createdAt: 90_000,
      expiresAt: 135_000,
      correlationId: 'corr-1',
      ttl: 90 + 86_400,
      ...overrides,
    };
  }

  function makeHandler(records: OutboundCallRecord[]) {
    const calls = memCallStore(records);
    const connect = fakeConnect();
    const handler = createOutboundCallActionHandler({
      calls: calls.store,
      connect: connect.port,
      idGenerator: ids,
      now: clock,
      logLevel: 'error',
    });
    return { handler, calls, connect };
  }

  it('answer returns the join credentials and marks the record answered', async () => {
    const { handler, calls } = makeHandler([ringingRecord()]);
    const res = await handler(
      postEvent('/v1/calls/outbound/call-1/answer', undefined, { callId: 'call-1' }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.attendee.joinToken).toBe('jt-1');
    expect(body.contactId).toBe('contact-1');
    expect(calls.items.get('call-1')!.status).toBe('answered');
  });

  it('answer is idempotent for an already-answered call', async () => {
    const { handler } = makeHandler([ringingRecord({ status: 'answered' })]);
    const res = await handler(
      postEvent('/v1/calls/outbound/call-1/answer', undefined, { callId: 'call-1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string).attendee.joinToken).toBe('jt-1');
  });

  it('answer after the ring deadline times the call out and stops the contact (410)', async () => {
    now = 200_000; // past expiresAt=135_000
    const { handler, calls, connect } = makeHandler([ringingRecord()]);
    const res = await handler(
      postEvent('/v1/calls/outbound/call-1/answer', undefined, { callId: 'call-1' }),
    );
    expect(res.statusCode).toBe(410);
    expect(calls.items.get('call-1')!.status).toBe('timedOut');
    expect(connect.stopped).toEqual(['contact-1']);
  });

  it('answer on a declined call is 410', async () => {
    const { handler } = makeHandler([ringingRecord({ status: 'declined' })]);
    const res = await handler(
      postEvent('/v1/calls/outbound/call-1/answer', undefined, { callId: 'call-1' }),
    );
    expect(res.statusCode).toBe(410);
  });

  it('decline stops the contact and releases the agent', async () => {
    const { handler, calls, connect } = makeHandler([ringingRecord()]);
    const res = await handler(
      postEvent('/v1/calls/outbound/call-1/decline', undefined, { callId: 'call-1' }),
    );
    expect(res.statusCode).toBe(204);
    expect(calls.items.get('call-1')!.status).toBe('declined');
    expect(connect.stopped).toEqual(['contact-1']);
  });

  it('decline is idempotent and does not stop an already-settled contact again', async () => {
    const { handler, connect } = makeHandler([ringingRecord({ status: 'answered' })]);
    const res = await handler(
      postEvent('/v1/calls/outbound/call-1/decline', undefined, { callId: 'call-1' }),
    );
    expect(res.statusCode).toBe(204);
    expect(connect.stopped).toHaveLength(0);
  });

  it('status view exposes the lifecycle but never tokens', async () => {
    const { handler } = makeHandler([ringingRecord()]);
    const res = await handler(getEvent('/v1/calls/outbound/call-1', { callId: 'call-1' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body).toMatchObject({ callId: 'call-1', status: 'ringing', contactId: 'contact-1' });
    expect(res.body).not.toContain('jt-1');
  });

  it('404s an unknown callId', async () => {
    const { handler } = makeHandler([]);
    const res = await handler(getEvent('/v1/calls/outbound/nope', { callId: 'nope' }));
    expect(res.statusCode).toBe(404);
  });
});

describe('ring-timeout sweeper', () => {
  it('times out expired ringing calls and stops their contacts', async () => {
    const expired: OutboundCallRecord = {
      callId: 'call-old',
      customerId: 'cust-1',
      agentId: 'user-9',
      agentResource: AGENT_ARN,
      callType: 'audio',
      callerDisplayName: 'Support',
      status: 'ringing',
      session: {
        contactId: 'contact-old',
        participantId: 'p',
        participantToken: 't',
        callType: 'audio',
        meeting: {
          meetingId: 'm',
          mediaPlacement: { audioHostUrl: 'https://a', signalingUrl: 'wss://s' },
        },
        attendee: { attendeeId: 'a', joinToken: 'j' },
      },
      createdAt: 0,
      expiresAt: 50_000, // now=100_000 → expired
      correlationId: 'c',
      ttl: 86_400,
    };
    const calls = memCallStore([expired]);
    const connect = fakeConnect();
    const sweep = createSweepOutboundCallsHandler({
      calls: calls.store,
      connect: connect.port,
      now: clock,
      logLevel: 'error',
    });
    const result = await sweep();
    expect(result).toEqual({ expired: 1, stopped: 1 });
    expect(calls.items.get('call-old')!.status).toBe('timedOut');
    expect(connect.stopped).toEqual(['contact-old']);
  });

  it('is a no-op when nothing is expired', async () => {
    const calls = memCallStore();
    const connect = fakeConnect();
    const sweep = createSweepOutboundCallsHandler({
      calls: calls.store,
      connect: connect.port,
      now: clock,
      logLevel: 'error',
    });
    await expect(sweep()).resolves.toEqual({ expired: 0, stopped: 0 });
  });
});
