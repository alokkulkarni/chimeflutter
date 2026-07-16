/**
 * Device/agent-side actions on a ringing simulated-outbound call:
 *
 *  - `POST /v1/calls/outbound/{callId}/answer`  — device answered: atomically win the
 *    ringing→answered transition and return the stored join credentials (the same CallSession
 *    shape as POST /calls, so the mobile libraries join through the existing code path).
 *    Idempotent: re-answering an already-answered call returns the session again.
 *  - `POST /v1/calls/outbound/{callId}/decline` — device declined: stop the Connect contact so the
 *    agent leg is released immediately.
 *  - `GET  /v1/calls/outbound/{callId}`         — status view for the agent dashboard (no tokens).
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ConnectPort } from '../connect/connectClient';
import type { OutboundCallStore } from '../store/outboundCallStore';
import { isRingExpired, toStatusView } from '../domain/outbound';
import { getHeader } from '../http/event';
import { ok, noContent, errorResponse } from '../http/response';
import { AppError, badRequest, mapAwsError, notFound } from '../http/errors';
import { createLogger, type LogLevel } from '../domain/logger';

export interface OutboundCallActionDeps {
  calls: OutboundCallStore;
  /** Only stopContact is used. */
  connect: Pick<ConnectPort, 'stopContact'>;
  idGenerator: () => string;
  now: () => number;
  logLevel?: LogLevel;
}

export type OutboundCallActionHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2>;

const CALL_GONE = new AppError(410, 'CALL_NO_LONGER_RINGING', 'This call is no longer ringing');

function resolveAction(event: APIGatewayProxyEventV2): 'answer' | 'decline' | 'status' {
  const path = event.rawPath ?? '';
  const method = event.requestContext?.http?.method?.toUpperCase() ?? 'GET';
  if (method === 'POST' && path.endsWith('/answer')) return 'answer';
  if (method === 'POST' && path.endsWith('/decline')) return 'decline';
  if (method === 'GET') return 'status';
  throw badRequest('INVALID_ACTION', `Unsupported outbound call action: ${method} ${path}`);
}

export function createOutboundCallActionHandler(
  deps: OutboundCallActionDeps,
): OutboundCallActionHandler {
  return async (event) => {
    const correlationId = getHeader(event, 'x-correlation-id') ?? deps.idGenerator();
    const logger = createLogger({ level: deps.logLevel ?? 'info', correlationId });
    const respond = (r: APIGatewayProxyStructuredResultV2) => ({
      ...r,
      headers: { ...(r.headers ?? {}), 'x-correlation-id': correlationId },
    });

    try {
      const callId = event.pathParameters?.callId;
      if (!callId) throw badRequest('MISSING_CALL_ID', 'callId path parameter is required');
      const action = resolveAction(event);

      const record = await deps.calls.get(callId);
      if (!record) throw notFound('Unknown callId');

      if (action === 'status') {
        return respond(ok(toStatusView(record)));
      }

      if (action === 'answer') {
        if (record.status === 'answered') return respond(ok(record.session)); // idempotent retry
        if (record.status !== 'ringing') throw CALL_GONE;
        if (isRingExpired(record, deps.now())) {
          // The sweeper may not have run yet — time the call out now and release the agent.
          const won = await deps.calls.transitionFromRinging(callId, 'timedOut', {
            endedAt: deps.now(),
          });
          if (won) await deps.connect.stopContact(record.session.contactId).catch(() => undefined);
          throw CALL_GONE;
        }
        const won = await deps.calls.transitionFromRinging(callId, 'answered', {
          answeredAt: deps.now(),
        });
        if (!won) {
          // Lost the race (decline/sweeper) — re-read to answer idempotently if possible.
          const latest = await deps.calls.get(callId);
          if (latest?.status === 'answered') return respond(ok(latest.session));
          throw CALL_GONE;
        }
        logger.info('outbound call answered', { callId, contactId: record.session.contactId });
        return respond(ok(record.session));
      }

      // action === 'decline' — idempotent: only the ringing→declined winner stops the contact.
      const won = await deps.calls.transitionFromRinging(callId, 'declined', {
        endedAt: deps.now(),
      });
      if (won) {
        await deps.connect.stopContact(record.session.contactId).catch(() => undefined);
        logger.info('outbound call declined', { callId, contactId: record.session.contactId });
      }
      return respond(noContent());
    } catch (err) {
      const appError = mapAwsError(err);
      logger.error('outbound call action failed', {
        code: appError.code,
        status: appError.statusCode,
        err,
      });
      return respond(errorResponse(appError, correlationId));
    }
  };
}
