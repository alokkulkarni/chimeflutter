/**
 * Adapter around the Amazon Connect Participant Service — used to send DTMF digits to the IVR
 * during a WebRTC contact. The `ParticipantToken` returned by `StartWebRTCContact` is exchanged for
 * connection credentials, then digits are sent as `audio/dtmf` messages. These APIs are authorised
 * by the tokens themselves (no Connect IAM resource permissions required).
 */
import {
  ConnectParticipantClient,
  CreateParticipantConnectionCommand,
  SendMessageCommand,
} from '@aws-sdk/client-connectparticipant';
import { upstreamUnavailable } from '../http/errors';

export interface ParticipantConnection {
  connectionToken: string;
  /** ISO timestamp when the connection token expires. */
  expiry?: string;
}

export interface ParticipantPort {
  createConnection(participantToken: string): Promise<ParticipantConnection>;
  sendDtmf(connectionToken: string, digits: string): Promise<void>;
}

export function createParticipantPort(client: ConnectParticipantClient): ParticipantPort {
  return {
    async createConnection(participantToken: string): Promise<ParticipantConnection> {
      const res = await client.send(
        new CreateParticipantConnectionCommand({
          ParticipantToken: participantToken,
          Type: ['CONNECTION_CREDENTIALS'],
        }),
      );
      const token = res.ConnectionCredentials?.ConnectionToken;
      if (!token) throw upstreamUnavailable('Participant connection returned no credentials');
      return { connectionToken: token, expiry: res.ConnectionCredentials?.Expiry };
    },

    async sendDtmf(connectionToken: string, digits: string): Promise<void> {
      await client.send(
        new SendMessageCommand({
          ConnectionToken: connectionToken,
          ContentType: 'audio/dtmf',
          Content: digits,
        }),
      );
    },
  };
}

let sharedClient: ConnectParticipantClient | undefined;
export function getParticipantClient(region: string): ConnectParticipantClient {
  if (!sharedClient) {
    sharedClient = new ConnectParticipantClient({ region, maxAttempts: 3 });
  }
  return sharedClient;
}
