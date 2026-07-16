/**
 * `POST /v1/calls/outbound` — agent-initiated ("simulated outbound") in-app call.
 *
 * Sequence (see docs/OUTBOUND_CALLS.md):
 *  1. The customer must have a registered device (404 otherwise).
 *  2. The agent must be routable with a free voice slot (409 otherwise) — checked via
 *     GetCurrentUserData so we never ring a customer for an agent who cannot take the call.
 *  3. StartWebRTCContact with `direction=outbound` + `targetAgentArn` attributes; the outbound
 *     contact flow routes the contact straight into the agent's personal queue, so it is offered
 *     to the agent immediately and occupies their voice slot — they cannot receive other calls
 *     while the customer's phone rings.
 *  4. The join credentials are stored server-side; the device push carries ONLY the callId.
 *  5. If the push cannot be delivered the contact is stopped again (no zombie agent leg).
 *
 * SECURITY: this endpoint makes customer phones ring — in production it must be restricted to
 * authenticated agent/backoffice principals, never exposed to end users.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ConnectPort } from '../connect/connectClient';
import type { AgentStatusPort } from '../connect/agentAvailability';
import { evaluateAgentAvailability } from '../connect/agentAvailability';
import { buildContactAttributes } from '../connect/attributes';
import { buildAllowedCapabilities } from '../connect/capabilities';
import { toCallSession } from '../connect/session';
import type { DeviceStore } from '../store/deviceStore';
import type { OutboundCallStore } from '../store/outboundCallStore';
import type { PushPort } from '../push/pushSender';
import { recordTtlSeconds } from '../domain/outbound';
import { parseOutboundCallRequest } from '../http/parseOutbound';
import { getHeader, getRawBody } from '../http/event';
import { created, errorResponse } from '../http/response';
import { AppError, conflict, mapAwsError, notFound } from '../http/errors';
import { createLogger, type LogLevel } from '../domain/logger';

export interface StartOutboundCallDeps {
  /** ConnectPort bound to the OUTBOUND contact flow (set-queue-by-agent → transfer). */
  connect: ConnectPort;
  agentStatus: AgentStatusPort;
  devices: DeviceStore;
  calls: OutboundCallStore;
  push: PushPort;
  allowedClientAttributeKeys: ReadonlySet<string>;
  idGenerator: () => string;
  now: () => number;
  ringTimeoutSeconds: number;
  logLevel?: LogLevel;
}

export type StartOutboundCallHandler = (
  event: APIGatewayProxyEventV2,
) => Promise<APIGatewayProxyStructuredResultV2>;

export function createStartOutboundCallHandler(
  deps: StartOutboundCallDeps,
): StartOutboundCallHandler {
  return async (event) => {
    const correlationId = getHeader(event, 'x-correlation-id') ?? deps.idGenerator();
    const logger = createLogger({ level: deps.logLevel ?? 'info', correlationId });
    const respond = (r: APIGatewayProxyStructuredResultV2) => ({
      ...r,
      headers: { ...(r.headers ?? {}), 'x-correlation-id': correlationId },
    });

    try {
      const request = parseOutboundCallRequest(getRawBody(event));
      const idempotencyKey = getHeader(event, 'idempotency-key');

      const device = await deps.devices.get(request.customerId);
      if (!device) {
        throw notFound('No registered device for this customer — call POST /devices first');
      }

      const snapshot = await deps.agentStatus.getAgentSnapshot(request.agentId);
      const availability = evaluateAgentAvailability(snapshot);
      if (!availability.available) {
        throw conflict(
          'AGENT_NOT_AVAILABLE',
          `Agent is not available to take this call (${availability.reason})`,
        );
      }
      const agentResource = snapshot.arn ?? request.agentId;

      // Attribute allow-listing/normalisation is identical to inbound; direction/targetAgentArn
      // are injected as trusted claims so a client context key can never override them.
      const attributes = buildContactAttributes({
        trustedClaims: {
          direction: 'outbound',
          targetAgentArn: agentResource,
          customerId: request.customerId,
        },
        clientContext: request.context,
        device: { platform: device.platform },
        allowedClientKeys: deps.allowedClientAttributeKeys,
        correlationId,
      });

      logger.info('starting simulated-outbound webrtc contact', {
        callType: request.callType,
        customerId: request.customerId,
        attributeKeys: Object.keys(attributes),
      });

      const response = await deps.connect.startWebRtcContact({
        callType: request.callType,
        displayName: request.customerDisplayName,
        attributes,
        allowedCapabilities: buildAllowedCapabilities(request.callType),
        clientToken: idempotencyKey,
      });
      const session = toCallSession(response, request.callType);

      const nowMs = deps.now();
      const callId = deps.idGenerator();
      const expiresAt = nowMs + deps.ringTimeoutSeconds * 1000;
      await deps.calls.put({
        callId,
        customerId: request.customerId,
        agentId: request.agentId,
        agentResource,
        callType: request.callType,
        callerDisplayName: request.callerDisplayName,
        status: 'ringing',
        session,
        createdAt: nowMs,
        expiresAt,
        correlationId,
        ttl: recordTtlSeconds(nowMs),
      });

      try {
        await deps.push.publishIncomingCall(device.endpointArn, device.platform, {
          callId,
          callType: request.callType,
          displayName: request.callerDisplayName,
          timeoutSeconds: deps.ringTimeoutSeconds,
          correlationId,
        });
      } catch (pushErr) {
        // The customer can never answer — stop the agent leg and surface the failure.
        logger.error('push delivery failed; stopping contact', { err: pushErr });
        await deps.calls.transitionFromRinging(callId, 'cancelled', { endedAt: deps.now() });
        await deps.connect.stopContact(session.contactId).catch(() => undefined);
        throw pushErr instanceof AppError
          ? pushErr
          : new AppError(502, 'PUSH_FAILED', 'Could not deliver the incoming-call push', pushErr);
      }

      logger.info('simulated-outbound contact ringing', {
        callId,
        contactId: session.contactId,
      });
      return respond(
        created({ callId, contactId: session.contactId, status: 'ringing', expiresAt }),
      );
    } catch (err) {
      const appError = mapAwsError(err);
      logger.error('start outbound call failed', {
        code: appError.code,
        status: appError.statusCode,
        err,
      });
      return respond(errorResponse(appError, correlationId));
    }
  };
}
