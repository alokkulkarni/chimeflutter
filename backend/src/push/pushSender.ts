/**
 * Push delivery for simulated-outbound calls, via Amazon SNS mobile push.
 *
 * iOS uses an **APNS_VOIP** platform application (PushKit VoIP pushes — the only push type that can
 * wake a killed app into CallKit's incoming-call UI). Android uses an **FCM** platform application
 * with a high-priority data message. The push carries only `{callId, callType, displayName,
 * timeoutSeconds}` — never meeting credentials; the device exchanges the callId for the join
 * credentials over HTTPS on answer.
 *
 * Platform applications hold the APNs .p8 key / FCM service-account credentials, so they are
 * created out-of-band (console or CLI, see docs/OUTBOUND_CALLS.md) and injected as ARNs.
 */
import {
  CreatePlatformEndpointCommand,
  PublishCommand,
  SetEndpointAttributesCommand,
  SNSClient,
} from '@aws-sdk/client-sns';
import type { DevicePlatform } from '../domain/outbound';
import { AppError } from '../http/errors';

export interface IncomingCallPush {
  callId: string;
  callType: string;
  displayName: string;
  timeoutSeconds: number;
  correlationId: string;
}

export interface PushPort {
  /** Creates (or re-enables) the SNS platform endpoint for the token; returns its ARN. */
  registerEndpoint(input: {
    platform: DevicePlatform;
    pushToken: string;
    customerId: string;
  }): Promise<string>;
  publishIncomingCall(
    endpointArn: string,
    platform: DevicePlatform,
    push: IncomingCallPush,
  ): Promise<void>;
}

export interface PushSenderConfig {
  /** SNS platform application for APNS_VOIP (iOS). Empty ⇒ iOS registration rejected. */
  apnsPlatformApplicationArn?: string;
  /** SNS platform application for FCM (Android). Empty ⇒ Android registration rejected. */
  fcmPlatformApplicationArn?: string;
}

const ENDPOINT_EXISTS_RE = /Endpoint (arn:[^ ]+) already exists/;

function notConfigured(platform: DevicePlatform): AppError {
  return new AppError(
    501,
    'PUSH_NOT_CONFIGURED',
    `No SNS platform application configured for ${platform} push`,
  );
}

/** The payload PushKit / FirebaseMessagingService receives — keys shared with both mobile libs. */
export function buildPushData(push: IncomingCallPush): Record<string, string> {
  return {
    type: 'incomingConnectCall',
    callId: push.callId,
    callType: push.callType,
    displayName: push.displayName,
    timeoutSeconds: String(push.timeoutSeconds),
    correlationId: push.correlationId,
  };
}

export function createPushSender(client: SNSClient, config: PushSenderConfig): PushPort {
  const applicationArn = (platform: DevicePlatform): string => {
    const arn =
      platform === 'iOS' ? config.apnsPlatformApplicationArn : config.fcmPlatformApplicationArn;
    if (!arn) throw notConfigured(platform);
    return arn;
  };

  return {
    async registerEndpoint({ platform, pushToken, customerId }): Promise<string> {
      const appArn = applicationArn(platform);
      try {
        const result = await client.send(
          new CreatePlatformEndpointCommand({
            PlatformApplicationArn: appArn,
            Token: pushToken,
            CustomUserData: customerId,
          }),
        );
        return result.EndpointArn!;
      } catch (err) {
        // SNS returns InvalidParameter when the token already has an endpoint with different
        // attributes; the existing ARN is embedded in the message (documented SNS behaviour).
        const message = (err as Error).message ?? '';
        const existing = ENDPOINT_EXISTS_RE.exec(message)?.[1];
        if (!existing) throw err;
        await client.send(
          new SetEndpointAttributesCommand({
            EndpointArn: existing,
            Attributes: { Token: pushToken, Enabled: 'true' },
          }),
        );
        return existing;
      }
    },

    async publishIncomingCall(endpointArn, platform, push): Promise<void> {
      const data = buildPushData(push);
      const message =
        platform === 'iOS'
          ? {
              default: 'Incoming call',
              // VoIP pushes are delivered to PushKit in full; aps stays minimal because the app
              // must immediately report the call to CallKit, not show a notification.
              APNS_VOIP: JSON.stringify({ aps: { 'content-available': 1 }, ...data }),
              APNS_VOIP_SANDBOX: JSON.stringify({ aps: { 'content-available': 1 }, ...data }),
            }
          : {
              default: 'Incoming call',
              // Data-only, high priority: FirebaseMessagingService.onMessageReceived fires even in
              // the background so the library can post the incoming-call UI.
              GCM: JSON.stringify({ priority: 'high', data }),
            };

      await client.send(
        new PublishCommand({
          TargetArn: endpointArn,
          MessageStructure: 'json',
          Message: JSON.stringify(message),
        }),
      );
    },
  };
}

/** Shared, lazily-created SNSClient (Lambda connection-reuse best practice). */
let sharedClient: SNSClient | undefined;
export function getSnsClient(region: string): SNSClient {
  if (!sharedClient) {
    sharedClient = new SNSClient({ region, maxAttempts: 3 });
  }
  return sharedClient;
}
