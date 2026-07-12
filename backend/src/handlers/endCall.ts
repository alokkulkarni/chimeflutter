/**
 * `DELETE /v1/calls/{contactId}` — end an in-progress WebRTC contact server-side (FR-B7 / US-6).
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ConnectPort } from '../connect/connectClient';
import { getHeader } from '../http/event';
import { noContent, errorResponse } from '../http/response';
import { badRequest, mapAwsError } from '../http/errors';
import { createLogger, type LogLevel } from '../domain/logger';

export interface EndCallDeps {
  connect: ConnectPort;
  logLevel?: LogLevel;
}

export type EndCallHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2>;

export function createEndCallHandler(deps: EndCallDeps): EndCallHandler {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const correlationId = getHeader(event, 'x-correlation-id') ?? 'end-call';
    const logger = createLogger({ level: deps.logLevel ?? 'info', correlationId });
    const respond = (r: APIGatewayProxyStructuredResultV2) => ({
      ...r,
      headers: { ...(r.headers ?? {}), 'x-correlation-id': correlationId },
    });

    try {
      const contactId = event.pathParameters?.contactId;
      if (!contactId || contactId.trim() === '') {
        throw badRequest('MISSING_CONTACT_ID', 'contactId path parameter is required');
      }
      await deps.connect.stopContact(contactId);
      logger.info('contact stopped', { contactId });
      return respond(noContent());
    } catch (err) {
      const appError = mapAwsError(err);
      logger.error('end call failed', { code: appError.code, err });
      return respond(errorResponse(appError, correlationId));
    }
  };
}
