import 'aws-sdk-client-mock-jest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CreatePlatformEndpointCommand,
  PublishCommand,
  SetEndpointAttributesCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import { buildPushData, createPushSender, type IncomingCallPush } from '../../src/push/pushSender';

const snsMock = mockClient(SNSClient);

const PUSH: IncomingCallPush = {
  callId: 'call-1',
  callType: 'video',
  displayName: 'Acme Support',
  timeoutSeconds: 45,
  correlationId: 'corr-1',
};

function sender() {
  return createPushSender(snsMock as unknown as SNSClient, {
    apnsPlatformApplicationArn: 'arn:aws:sns:eu-west-2:1:app/APNS_VOIP/demo',
    fcmPlatformApplicationArn: 'arn:aws:sns:eu-west-2:1:app/GCM/demo',
  });
}

beforeEach(() => snsMock.reset());

describe('buildPushData', () => {
  it('carries only the call reference — never credentials', () => {
    expect(buildPushData(PUSH)).toEqual({
      type: 'incomingConnectCall',
      callId: 'call-1',
      callType: 'video',
      displayName: 'Acme Support',
      timeoutSeconds: '45',
      correlationId: 'corr-1',
    });
  });
});

describe('registerEndpoint', () => {
  it('creates a platform endpoint for the right platform application', async () => {
    snsMock.on(CreatePlatformEndpointCommand).resolves({ EndpointArn: 'arn:endpoint/new' });
    const arn = await sender().registerEndpoint({
      platform: 'iOS',
      pushToken: 'tok-1',
      customerId: 'cust-1',
    });
    expect(arn).toBe('arn:endpoint/new');
    expect(snsMock).toHaveReceivedCommandWith(CreatePlatformEndpointCommand, {
      PlatformApplicationArn: 'arn:aws:sns:eu-west-2:1:app/APNS_VOIP/demo',
      Token: 'tok-1',
    });
  });

  it('reuses and re-enables an existing endpoint (documented SNS conflict path)', async () => {
    snsMock
      .on(CreatePlatformEndpointCommand)
      .rejects(
        new Error(
          'Invalid parameter: Token Reason: Endpoint arn:aws:sns:eu-west-2:1:endpoint/GCM/demo/abc already exists with the same Token, but different attributes.',
        ),
      );
    snsMock.on(SetEndpointAttributesCommand).resolves({});
    const arn = await sender().registerEndpoint({
      platform: 'Android',
      pushToken: 'tok-2',
      customerId: 'cust-1',
    });
    expect(arn).toBe('arn:aws:sns:eu-west-2:1:endpoint/GCM/demo/abc');
    expect(snsMock).toHaveReceivedCommandWith(SetEndpointAttributesCommand, {
      EndpointArn: 'arn:aws:sns:eu-west-2:1:endpoint/GCM/demo/abc',
      Attributes: { Token: 'tok-2', Enabled: 'true' },
    });
  });

  it('rejects registration when the platform application is not configured', async () => {
    const bare = createPushSender(snsMock as unknown as SNSClient, {});
    await expect(
      bare.registerEndpoint({ platform: 'iOS', pushToken: 't', customerId: 'c' }),
    ).rejects.toMatchObject({ code: 'PUSH_NOT_CONFIGURED', statusCode: 501 });
  });
});

describe('publishIncomingCall', () => {
  it('publishes an APNS_VOIP payload for iOS with no credentials inside', async () => {
    snsMock.on(PublishCommand).resolves({});
    await sender().publishIncomingCall('arn:endpoint/ios', 'iOS', PUSH);
    const input = snsMock.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(input.TargetArn).toBe('arn:endpoint/ios');
    expect(input.MessageStructure).toBe('json');
    const message = JSON.parse(input.Message!);
    const voip = JSON.parse(message.APNS_VOIP);
    expect(voip.callId).toBe('call-1');
    expect(voip.aps).toEqual({ 'content-available': 1 });
    expect(message.APNS_VOIP_SANDBOX).toBe(message.APNS_VOIP);
    expect(input.Message).not.toContain('joinToken');
  });

  it('publishes a high-priority FCM data message for Android', async () => {
    snsMock.on(PublishCommand).resolves({});
    await sender().publishIncomingCall('arn:endpoint/android', 'Android', PUSH);
    const message = JSON.parse(snsMock.commandCalls(PublishCommand)[0]!.args[0].input.Message!);
    const gcm = JSON.parse(message.GCM);
    expect(gcm.priority).toBe('high');
    expect(gcm.data).toMatchObject({ type: 'incomingConnectCall', callId: 'call-1' });
    expect(gcm.notification).toBeUndefined(); // data-only so the service class always runs
  });
});
