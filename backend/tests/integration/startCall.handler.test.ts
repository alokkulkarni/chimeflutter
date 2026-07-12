import 'aws-sdk-client-mock-jest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConnectClient,
  StartWebRTCContactCommand,
  type StartWebRTCContactResponse,
} from '@aws-sdk/client-connect';
import { createConnectPort } from '../../src/connect/connectClient';
import { createStartCallHandler } from '../../src/handlers/startCall';

const connectMock = mockClient(ConnectClient);

const CFG = { instanceId: 'inst-1', contactFlowId: 'flow-1' };
const ALLOWED = new Set(['issueType', 'tier', 'segment']);

const CONNECT_OK: StartWebRTCContactResponse = {
  ConnectionData: {
    Attendee: { AttendeeId: 'att-1', JoinToken: 'jt-1' },
    Meeting: {
      MeetingId: 'meet-1',
      MediaRegion: 'eu-west-2',
      MediaPlacement: {
        AudioHostUrl: 'https://audio',
        AudioFallbackUrl: 'https://audiofb',
        SignalingUrl: 'wss://signal',
        TurnControlUrl: 'https://turn',
        EventIngestionUrl: 'https://ingest',
      },
    },
  },
  ContactId: 'contact-1',
  ParticipantId: 'part-1',
  ParticipantToken: 'ptoken-1',
};

function handler() {
  const connect = createConnectPort(connectMock as unknown as ConnectClient, CFG);
  let n = 0;
  return createStartCallHandler({
    connect,
    allowedClientAttributeKeys: ALLOWED,
    idGenerator: () => `corr-${++n}`,
    logLevel: 'error',
  });
}

function event(opts: {
  body: unknown;
  authorizer?: Record<string, string>;
  headers?: Record<string, string>;
}): any {
  return {
    version: '2.0',
    routeKey: 'POST /v1/calls',
    rawPath: '/v1/calls',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    requestContext: {
      http: { method: 'POST', path: '/v1/calls' },
      authorizer: { lambda: opts.authorizer ?? { customerId: 'cust-1' } },
    },
    body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    isBase64Encoded: false,
  };
}

beforeEach(() => {
  connectMock.reset();
  connectMock.on(StartWebRTCContactCommand).resolves(CONNECT_OK);
});

describe('US-1 — audio call routed by context', () => {
  it('calls StartWebRTCContact with merged attributes and audio-only capabilities', async () => {
    const res = await handler()(
      event({
        body: {
          callType: 'audio',
          displayName: 'Ada',
          context: { issueType: 'billing', tier: 'silver' },
          device: { platform: 'iOS', appVersion: '4.2.0' },
        },
        authorizer: { customerId: 'cust-123', tier: 'gold' },
      }),
    );

    expect(res.statusCode).toBe(201);

    expect(connectMock).toHaveReceivedCommandWith(StartWebRTCContactCommand, {
      InstanceId: 'inst-1',
      ContactFlowId: 'flow-1',
      ParticipantDetails: { DisplayName: 'Ada' },
    });

    // Assert the exact merged attributes (trusted tier=gold wins over client tier=silver).
    const input = connectMock.commandCalls(StartWebRTCContactCommand)[0]!.args[0].input;
    expect(input.Attributes).toMatchObject({
      issueType: 'billing',
      tier: 'gold',
      customerId: 'cust-123',
      devicePlatform: 'iOS',
      appVersion: '4.2.0',
      source: 'chimeflutter-mobile',
    });
    expect(input.AllowedCapabilities).toBeUndefined(); // audio has no video capability

    const body = JSON.parse(res.body as string);
    expect(body.attendee.joinToken).toBe('jt-1');
    expect(body.meeting.meetingId).toBe('meet-1');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('inst-1');
  });

  it('NFR-2: spoofed client customerId cannot override the token subject', async () => {
    await handler()(
      event({
        body: {
          callType: 'audio',
          context: { customerId: 'cust-999' },
          device: { platform: 'iOS' },
        },
        authorizer: { customerId: 'cust-123' },
      }),
    );
    const input = connectMock.commandCalls(StartWebRTCContactCommand)[0]!.args[0].input;
    expect(input.Attributes!.customerId).toBe('cust-123');
  });
});

describe('US-2 — video call', () => {
  it('requests Video SEND for customer and agent', async () => {
    await handler()(
      event({ body: { callType: 'video', device: { platform: 'Android' } } }),
    );
    const input = connectMock.commandCalls(StartWebRTCContactCommand)[0]!.args[0].input;
    expect(input.AllowedCapabilities).toEqual({
      Customer: { Video: 'SEND' },
      Agent: { Video: 'SEND' },
    });
  });
});

describe('US-4 — graceful degradation', () => {
  it('maps a Connect ThrottlingException to 429 RATE_LIMITED and returns no meeting', async () => {
    connectMock
      .on(StartWebRTCContactCommand)
      .rejects(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));

    const res = await handler()(event({ body: { callType: 'audio', device: { platform: 'iOS' } } }));
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body as string);
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.meeting).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('slow down');
  });

  it('returns 400 for an invalid callType without calling Connect', async () => {
    const res = await handler()(event({ body: { callType: 'fax', device: { platform: 'iOS' } } }));
    expect(res.statusCode).toBe(400);
    expect(connectMock).not.toHaveReceivedCommand(StartWebRTCContactCommand);
  });
});

describe('US-5 — idempotency', () => {
  it('passes the Idempotency-Key header as the Connect ClientToken', async () => {
    const h = handler();
    const ev = () =>
      event({
        body: { callType: 'audio', device: { platform: 'iOS' } },
        headers: { 'idempotency-key': 'k-1' },
      });
    await h(ev());
    await h(ev());
    const calls = connectMock.commandCalls(StartWebRTCContactCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input.ClientToken).toBe('k-1');
    expect(calls[1]!.args[0].input.ClientToken).toBe('k-1');
  });
});

describe('correlation id (NFR-6)', () => {
  it('echoes an incoming x-correlation-id and forwards it as a contact attribute', async () => {
    const res = await handler()(
      event({
        body: { callType: 'audio', device: { platform: 'iOS' } },
        headers: { 'x-correlation-id': 'trace-42' },
      }),
    );
    expect(res.headers?.['x-correlation-id']).toBe('trace-42');
    const input = connectMock.commandCalls(StartWebRTCContactCommand)[0]!.args[0].input;
    expect(input.Attributes!.correlationId).toBe('trace-42');
  });
});
