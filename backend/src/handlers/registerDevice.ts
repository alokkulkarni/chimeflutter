/**
 * `POST /v1/devices` — register (upsert) the customer device's push token so the contact center can
 * ring it for simulated-outbound calls. Creates/refreshes the SNS platform endpoint and stores the
 * mapping customerId → endpoint.
 *
 * SECURITY: in production this endpoint must sit behind your auth (the same authorizer as
 * /calls) — the customerId ties push delivery to an identity, so it must come from a verified
 * principal, not be freely claimable. The demo deployment is open, exactly like /calls.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DeviceStore } from '../store/deviceStore';
import type { PushPort } from '../push/pushSender';
import { parseRegisterDeviceRequest } from '../http/parseOutbound';
import { getHeader, getRawBody } from '../http/event';
import { ok, errorResponse } from '../http/response';
import { mapAwsError } from '../http/errors';
import { createLogger, type LogLevel } from '../domain/logger';

export interface RegisterDeviceDeps {
  devices: DeviceStore;
  push: PushPort;
  idGenerator: () => string;
  now: () => number;
  logLevel?: LogLevel;
}

export type RegisterDeviceHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2>;

export function createRegisterDeviceHandler(deps: RegisterDeviceDeps): RegisterDeviceHandler {
  return async (event) => {
    const correlationId = getHeader(event, 'x-correlation-id') ?? deps.idGenerator();
    const logger = createLogger({ level: deps.logLevel ?? 'info', correlationId });
    const respond = (r: APIGatewayProxyStructuredResultV2) => ({
      ...r,
      headers: { ...(r.headers ?? {}), 'x-correlation-id': correlationId },
    });

    try {
      const request = parseRegisterDeviceRequest(getRawBody(event));
      const endpointArn = await deps.push.registerEndpoint({
        platform: request.platform,
        pushToken: request.pushToken,
        customerId: request.customerId,
      });
      await deps.devices.put({
        customerId: request.customerId,
        platform: request.platform,
        pushToken: request.pushToken,
        endpointArn,
        updatedAt: deps.now(),
      });
      logger.info('device registered', {
        customerId: request.customerId,
        platform: request.platform,
      });
      return respond(ok({ customerId: request.customerId, platform: request.platform }));
    } catch (err) {
      const appError = mapAwsError(err);
      logger.error('device registration failed', {
        code: appError.code,
        status: appError.statusCode,
        err,
      });
      return respond(errorResponse(appError, correlationId));
    }
  };
}
