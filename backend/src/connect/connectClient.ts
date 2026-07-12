/**
 * Adapter around the AWS SDK v3 Connect client. This is the ONLY place that knows the Connect
 * InstanceId / ContactFlowId (injected from config, never from the client) and the only place that
 * constructs `StartWebRTCContact` / `StopContact` commands.
 *
 * The handler depends on the {@link ConnectPort} interface, so it can be unit/integration tested
 * with a mocked ConnectClient (see tests/integration).
 */
import {
  ConnectClient,
  StartWebRTCContactCommand,
  StopContactCommand,
  type AllowedCapabilities,
  type StartWebRTCContactResponse,
} from '@aws-sdk/client-connect';
import type { CallType } from '../domain/types';

export interface StartContactInput {
  callType: CallType;
  displayName: string;
  attributes: Record<string, string>;
  allowedCapabilities?: AllowedCapabilities;
  /** Idempotency token (max 500 chars) — Connect returns the same contact on retry for 7 days. */
  clientToken?: string;
}

export interface ConnectPort {
  startWebRtcContact(input: StartContactInput): Promise<StartWebRTCContactResponse>;
  stopContact(contactId: string): Promise<void>;
}

export interface ConnectPortConfig {
  instanceId: string;
  contactFlowId: string;
}

export function createConnectPort(client: ConnectClient, cfg: ConnectPortConfig): ConnectPort {
  return {
    async startWebRtcContact(input: StartContactInput): Promise<StartWebRTCContactResponse> {
      return client.send(
        new StartWebRTCContactCommand({
          InstanceId: cfg.instanceId,
          ContactFlowId: cfg.contactFlowId,
          ParticipantDetails: { DisplayName: input.displayName },
          Attributes: input.attributes,
          AllowedCapabilities: input.allowedCapabilities,
          ClientToken: input.clientToken,
        }),
      );
    },

    async stopContact(contactId: string): Promise<void> {
      await client.send(
        new StopContactCommand({ InstanceId: cfg.instanceId, ContactId: contactId }),
      );
    },
  };
}

/**
 * A singleton ConnectClient is created at module load (outside the handler) so connections are
 * reused across warm invocations — AWS Lambda performance best practice.
 */
let sharedClient: ConnectClient | undefined;
export function getConnectClient(region: string): ConnectClient {
  if (!sharedClient) {
    sharedClient = new ConnectClient({ region, maxAttempts: 3 });
  }
  return sharedClient;
}
