/**
 * Deployment entrypoint for `POST /v1/calls`. Wires the real ConnectClient (created outside the
 * handler for connection reuse) and config from the environment. Kept free of business logic.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/env';
import { createConnectPort, getConnectClient } from '../connect/connectClient';
import { createStartCallHandler } from '../handlers/startCall';

const config = loadConfig();
const connect = createConnectPort(getConnectClient(config.region), {
  instanceId: config.connectInstanceId,
  contactFlowId: config.connectContactFlowId,
});

export const handler = createStartCallHandler({
  connect,
  allowedClientAttributeKeys: config.allowedClientAttributeKeys,
  idGenerator: () => randomUUID(),
  logLevel: config.logLevel,
});
