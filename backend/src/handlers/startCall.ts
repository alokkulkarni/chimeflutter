/**
 * `POST /v1/calls` — start an Amazon Connect WebRTC contact and return the join credentials.
 *
 * Requirements: FR-B1..FR-B6, NFR-1/2/6. The handler is a thin orchestration over pure domain
 * modules and the {@link ConnectPort}, produced by a factory so it can be integration tested with a
 * mocked ConnectClient.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ConnectPort } from '../connect/connectClient';
import { buildContactAttributes } from '../connect/attributes';
import { buildAllowedCapabilities } from '../connect/capabilities';
import { toCallSession } from '../connect/session';
import { parseCallRequest } from '../http/parseRequest';
import { getAuthorizerContext, getHeader, getRawBody } from '../http/event';
import { created, errorResponse } from '../http/response';
import { mapAwsError } from '../http/errors';
import { createLogger, type LogLevel } from '../domain/logger';

export interface StartCallDeps {
  connect: ConnectPort;
  allowedClientAttributeKeys: ReadonlySet<string>;
  /** Generates a correlation id when the client does not supply one. */
  idGenerator: () => string;
  logLevel?: LogLevel;
}

export type StartCallHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2>;

export function createStartCallHandler(deps: StartCallDeps): StartCallHandler {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const correlationId = getHeader(event, 'x-correlation-id') ?? deps.idGenerator();
    const logger = createLogger({ level: deps.logLevel ?? 'info', correlationId });
    const respond = (r: APIGatewayProxyStructuredResultV2) => ({
      ...r,
      headers: { ...(r.headers ?? {}), 'x-correlation-id': correlationId },
    });

    try {
      const trustedClaims = getAuthorizerContext(event);
      const request = parseCallRequest(getRawBody(event));
      const idempotencyKey = getHeader(event, 'idempotency-key');

      const attributes = buildContactAttributes({
        trustedClaims,
        clientContext: request.context,
        device: request.device,
        allowedClientKeys: deps.allowedClientAttributeKeys,
        correlationId,
      });

      logger.info('starting webrtc contact', {
        callType: request.callType,
        customerId: trustedClaims.customerId,
        attributeKeys: Object.keys(attributes),
      });

      const response = await deps.connect.startWebRtcContact({
        callType: request.callType,
        displayName: request.displayName!,
        attributes,
        allowedCapabilities: buildAllowedCapabilities(request.callType),
        clientToken: idempotencyKey,
      });

      const session = toCallSession(response, request.callType);
      logger.info('webrtc contact started', { contactId: session.contactId });
      return respond(created(session));
    } catch (err) {
      const appError = mapAwsError(err);
      logger.error('start call failed', { code: appError.code, status: appError.statusCode, err });
      return respond(errorResponse(appError, correlationId));
    }
  };
}
