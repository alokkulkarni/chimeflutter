import 'aws-sdk-client-mock-jest';
import { mockClient } from 'aws-sdk-client-mock';
import { ConnectClient, StopContactCommand } from '@aws-sdk/client-connect';
import { createConnectPort } from '../../src/connect/connectClient';
import { createEndCallHandler } from '../../src/handlers/endCall';

const connectMock = mockClient(ConnectClient);
const CFG = { instanceId: 'inst-1', contactFlowId: 'flow-1' };

function handler() {
  const connect = createConnectPort(connectMock as unknown as ConnectClient, CFG);
  return createEndCallHandler({ connect, logLevel: 'error' });
}

function event(contactId: string | undefined): any {
  return {
    version: '2.0',
    routeKey: 'DELETE /v1/calls/{contactId}',
    rawPath: `/v1/calls/${contactId ?? ''}`,
    headers: {},
    pathParameters: contactId === undefined ? {} : { contactId },
    requestContext: {
      http: { method: 'DELETE', path: `/v1/calls/${contactId ?? ''}` },
      authorizer: { lambda: { customerId: 'cust-1' } },
    },
    isBase64Encoded: false,
  };
}

beforeEach(() => {
  connectMock.reset();
  connectMock.on(StopContactCommand).resolves({});
});

describe('US-6 / FR-B7 — end call', () => {
  it('calls StopContact for the contactId and returns 204', async () => {
    const res = await handler()(event('contact-42'));
    expect(res.statusCode).toBe(204);
    expect(connectMock).toHaveReceivedCommandWith(StopContactCommand, {
      InstanceId: 'inst-1',
      ContactId: 'contact-42',
    });
  });

  it('returns 400 when contactId is missing and does not call Connect', async () => {
    const res = await handler()(event(undefined));
    expect(res.statusCode).toBe(400);
    expect(connectMock).not.toHaveReceivedCommand(StopContactCommand);
  });

  it('maps a Connect failure to a stable error', async () => {
    connectMock
      .on(StopContactCommand)
      .rejects(Object.assign(new Error('nope'), { name: 'InternalServiceException' }));
    const res = await handler()(event('c-1'));
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body as string).error.code).toBe('UPSTREAM_ERROR');
  });
});
