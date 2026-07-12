/**
 * Deployment entrypoint for `DELETE /v1/calls/{contactId}`.
 */
import { loadConfig } from '../config/env';
import { createConnectPort, getConnectClient } from '../connect/connectClient';
import { createEndCallHandler } from '../handlers/endCall';

const config = loadConfig();
const connect = createConnectPort(getConnectClient(config.region), {
  instanceId: config.connectInstanceId,
  contactFlowId: config.connectContactFlowId,
});

export const handler = createEndCallHandler({ connect, logLevel: config.logLevel });
