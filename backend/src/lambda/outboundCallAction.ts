/**
 * Deployment entrypoint for `GET /v1/calls/outbound/{callId}` and
 * `POST /v1/calls/outbound/{callId}/(answer|decline)`. Lazy wiring, same contract as the other
 * outbound entrypoints.
 */
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { loadConfig, loadOutboundConfig } from '../config/env';
import { createConnectPort, getConnectClient } from '../connect/connectClient';
import { createOutboundCallStore } from '../store/outboundCallStore';
import { getDocumentClient } from '../store/deviceStore';
import {
  createOutboundCallActionHandler,
  type OutboundCallActionHandler,
} from '../handlers/outboundCallAction';
import { json } from '../http/response';

let cached: OutboundCallActionHandler | undefined;

function init(): OutboundCallActionHandler {
  const config = loadConfig();
  const outbound = loadOutboundConfig();
  return createOutboundCallActionHandler({
    calls: createOutboundCallStore(getDocumentClient(config.region), outbound.outboundCallsTable),
    connect: createConnectPort(getConnectClient(config.region), {
      instanceId: config.connectInstanceId,
      contactFlowId: outbound.outboundContactFlowId,
    }),
    idGenerator: () => randomUUID(),
    now: () => Date.now(),
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
