/**
 * Deployment entrypoint for the participant routes (POST /v1/calls/connections, /v1/calls/dtmf).
 */
import { loadConfig } from '../config/env';
import { createParticipantPort, getParticipantClient } from '../connect/participantClient';
import { createParticipantHandler } from '../handlers/participant';

const config = loadConfig();
export const handler = createParticipantHandler({
  participant: createParticipantPort(getParticipantClient(config.region)),
  logLevel: config.logLevel,
});
