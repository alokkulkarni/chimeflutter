/**
 * Deployment entrypoint for `POST /v1/calls/outbound`. Wiring is lazy so deployments without the
 * outbound feature configured still boot (501 OUTBOUND_NOT_CONFIGURED per request).
 */
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { loadConfig, loadOutboundConfig } from '../config/env';
import { createConnectPort, getConnectClient } from '../connect/connectClient';
import { createAgentStatusPort } from '../connect/agentAvailability';
import { createDeviceStore, getDocumentClient } from '../store/deviceStore';
import { createOutboundCallStore } from '../store/outboundCallStore';
import { createPushSender, getSnsClient } from '../push/pushSender';
import {
  createStartOutboundCallHandler,
  type StartOutboundCallHandler,
} from '../handlers/startOutboundCall';
import { json } from '../http/response';

let cached: StartOutboundCallHandler | undefined;

function init(): StartOutboundCallHandler {
  const config = loadConfig();
  const outbound = loadOutboundConfig();
  const client = getConnectClient(config.region);
  const doc = getDocumentClient(config.region);
  return createStartOutboundCallHandler({
    // Bound to the OUTBOUND flow — routes by $.Attributes.targetAgentArn to the agent queue.
    connect: createConnectPort(client, {
      instanceId: config.connectInstanceId,
      contactFlowId: outbound.outboundContactFlowId,
    }),
    agentStatus: createAgentStatusPort(client, config.connectInstanceId),
    devices: createDeviceStore(doc, outbound.devicesTable),
    calls: createOutboundCallStore(doc, outbound.outboundCallsTable),
    push: createPushSender(getSnsClient(config.region), {
      apnsPlatformApplicationArn: outbound.apnsPlatformApplicationArn,
      fcmPlatformApplicationArn: outbound.fcmPlatformApplicationArn,
    }),
    allowedClientAttributeKeys: config.allowedClientAttributeKeys,
    idGenerator: () => randomUUID(),
    now: () => Date.now(),
    ringTimeoutSeconds: outbound.ringTimeoutSeconds,
    logLevel: config.logLevel,
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    cached ??= init();
  } catch {
    return json(501, {
      error: {
        code: 'OUTBOUND_NOT_CONFIGURED',
        message: 'Simulated-outbound calling is not configured on this deployment',
      },
    });
  }
  return cached(event);
};
