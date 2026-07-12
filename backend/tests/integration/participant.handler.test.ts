import 'aws-sdk-client-mock-jest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ConnectParticipantClient,
  CreateParticipantConnectionCommand,
  SendMessageCommand,
} from '@aws-sdk/client-connectparticipant';
import { createParticipantPort } from '../../src/connect/participantClient';
import { createParticipantHandler } from '../../src/handlers/participant';

const participantMock = mockClient(ConnectParticipantClient);

function handler() {
  const port = createParticipantPort(participantMock as unknown as ConnectParticipantClient);
  return createParticipantHandler({ participant: port, logLevel: 'error' });
}

function event(path: string, body: unknown): any {
  return {
    version: '2.0',
    rawPath: path,
    headers: { 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST', path } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

beforeEach(() => {
  participantMock.reset();
  participantMock.on(CreateParticipantConnectionCommand).resolves({
    ConnectionCredentials: { ConnectionToken: 'conn-token-1', Expiry: '2026-07-11T23:59:59Z' },
  });
  participantMock.on(SendMessageCommand).resolves({ Id: 'msg-1' });
});

describe('POST /v1/calls/connections — create participant connection (for DTMF)', () => {
  it('exchanges the participantToken for connection credentials', async () => {
    const res = await handler()(event('/v1/calls/connections', { participantToken: 'ptoken-1' }));
    expect(res.statusCode).toBe(201);
    expect(participantMock).toHaveReceivedCommandWith(CreateParticipantConnectionCommand, {
      ParticipantToken: 'ptoken-1',
      Type: ['CONNECTION_CREDENTIALS'],
    });
    const body = JSON.parse(res.body as string);
    expect(body).toEqual({ connectionToken: 'conn-token-1', expiry: '2026-07-11T23:59:59Z' });
  });

  it('400s when participantToken is missing', async () => {
    const res = await handler()(event('/v1/calls/connections', {}));
    expect(res.statusCode).toBe(400);
    expect(participantMock).not.toHaveReceivedCommand(CreateParticipantConnectionCommand);
  });
});

describe('POST /v1/calls/dtmf — send DTMF digits to the IVR', () => {
  it('sends digits as an audio/dtmf message on the connection', async () => {
    const res = await handler()(
      event('/v1/calls/dtmf', { connectionToken: 'conn-token-1', digits: '1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(participantMock).toHaveReceivedCommandWith(SendMessageCommand, {
      ConnectionToken: 'conn-token-1',
      ContentType: 'audio/dtmf',
      Content: '1',
    });
  });

  it('accepts the full DTMF alphabet 0-9 * # ,', async () => {
    const res = await handler()(
      event('/v1/calls/dtmf', { connectionToken: 'c', digits: '123*#0,9' }),
    );
    expect(res.statusCode).toBe(200);
  });

  it.each(['', 'abc', '1;2', '1'.repeat(21)])('rejects invalid digits %j with 400', async (digits) => {
    const res = await handler()(event('/v1/calls/dtmf', { connectionToken: 'c', digits }));
    expect(res.statusCode).toBe(400);
    expect(participantMock).not.toHaveReceivedCommand(SendMessageCommand);
  });

  it('400s when connectionToken is missing', async () => {
    const res = await handler()(event('/v1/calls/dtmf', { digits: '1' }));
    expect(res.statusCode).toBe(400);
  });

  it('maps upstream failures to the stable error envelope', async () => {
    participantMock
      .on(SendMessageCommand)
      .rejects(Object.assign(new Error('gone'), { name: 'AccessDeniedException' }));
    const res = await handler()(event('/v1/calls/dtmf', { connectionToken: 'c', digits: '1' }));
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body as string).error.code).toBe('UPSTREAM_ERROR');
  });

  it('404s unknown paths', async () => {
    const res = await handler()(event('/v1/calls/other', {}));
    expect(res.statusCode).toBe(404);
  });
});
