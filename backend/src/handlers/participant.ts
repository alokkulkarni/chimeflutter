/**
 * Participant endpoints — enable in-call IVR interaction (DTMF keypad):
 *
 *   POST /v1/calls/connections  { participantToken }          → { connectionToken, expiry }
 *   POST /v1/calls/dtmf         { connectionToken, digits }   → { sent: true }
 *
 * DTMF for a Connect WebRTC contact is NOT carried in the audio stream — it is sent via the
 * Connect Participant Service as `audio/dtmf` messages on a participant connection.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ParticipantPort } from '../connect/participantClient';
import { getHeader, getRawBody } from '../http/event';
import { created, ok, errorResponse } from '../http/response';
import { badRequest, notFound, mapAwsError } from '../http/errors';
import { createLogger, type LogLevel } from '../domain/logger';

/** Digits Connect IVRs understand: 0-9, * and #, plus `,` as a pause. Max 20 per send. */
const DTMF_RE = /^[0-9*#,]{1,20}$/;

export interface ParticipantDeps {
  participant: ParticipantPort;
  logLevel?: LogLevel;
}

export type ParticipantHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2>;

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  const raw = getRawBody(event);
  if (!raw) throw badRequest('EMPTY_BODY', 'Request body is required');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw badRequest('INVALID_JSON', 'Request body is not valid JSON');
  }
}

export function createParticipantHandler(deps: ParticipantDeps): ParticipantHandler {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const correlationId = getHeader(event, 'x-correlation-id') ?? 'participant';
    const logger = createLogger({ level: deps.logLevel ?? 'info', correlationId });
    const path = event.rawPath ?? event.requestContext?.http?.path ?? '';

    try {
      if (path.endsWith('/calls/connections')) {
        const body = parseBody(event);
        const participantToken = typeof body.participantToken === 'string' ? body.participantToken : '';
        if (!participantToken) {
          throw badRequest('MISSING_PARTICIPANT_TOKEN', 'participantToken is required');
        }
        const connection = await deps.participant.createConnection(participantToken);
        logger.info('participant connection created');
        return created(connection);
      }

      if (path.endsWith('/calls/dtmf')) {
        const body = parseBody(event);
        const connectionToken = typeof body.connectionToken === 'string' ? body.connectionToken : '';
        const digits = typeof body.digits === 'string' ? body.digits : '';
        if (!connectionToken) {
          throw badRequest('MISSING_CONNECTION_TOKEN', 'connectionToken is required');
        }
        if (!DTMF_RE.test(digits)) {
          throw badRequest('INVALID_DIGITS', 'digits must match [0-9*#,]{1,20}');
        }
        await deps.participant.sendDtmf(connectionToken, digits);
        logger.info('dtmf sent', { count: digits.length });
        return ok({ sent: true });
      }

      throw notFound(`No participant route for ${path}`);
    } catch (err) {
      const appError = mapAwsError(err);
      logger.error('participant request failed', { code: appError.code, err });
      return errorResponse(appError, correlationId);
    }
  };
}
