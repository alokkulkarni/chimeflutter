/**
 * Deployment entrypoint for `POST /v1/devices`. Wiring is lazy so deployments without the
 * outbound feature configured (e.g. a Docker container without the DynamoDB tables) still boot;
 * the endpoint then answers 501 OUTBOUND_NOT_CONFIGURED per request.
 */
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { loadConfig, loadOutboundConfig } from '../config/env';
import { createDeviceStore, getDocumentClient } from '../store/deviceStore';
import { createPushSender, getSnsClient } from '../push/pushSender';
import { createRegisterDeviceHandler, type RegisterDeviceHandler } from '../handlers/registerDevice';
import { json } from '../http/response';

let cached: RegisterDeviceHandler | undefined;

function init(): RegisterDeviceHandler {
  const config = loadConfig();
  const outbound = loadOutboundConfig();
  return createRegisterDeviceHandler({
    devices: createDeviceStore(getDocumentClient(config.region), outbound.devicesTable),
    push: createPushSender(getSnsClient(config.region), {
      apnsPlatformApplicationArn: outbound.apnsPlatformApplicationArn,
      fcmPlatformApplicationArn: outbound.fcmPlatformApplicationArn,
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
