/**
 * Ring-timeout sweeper: any simulated-outbound call still `ringing` past its expiresAt is
 * transitioned to `timedOut` and its Connect contact stopped, releasing the agent's voice slot.
 *
 * Runs as an EventBridge 1-minute schedule on Lambda and as a 60 s setInterval in the Docker
 * container (same code, see src/server/main.ts). The answer path also lazily times out expired
 * calls, so the sweeper is a safety net, not a latency-critical component.
 */
import type { ConnectPort } from '../connect/connectClient';
import type { OutboundCallStore } from '../store/outboundCallStore';
import { createLogger, type LogLevel } from '../domain/logger';

export interface SweepOutboundCallsDeps {
  calls: OutboundCallStore;
  connect: Pick<ConnectPort, 'stopContact'>;
  now: () => number;
  logLevel?: LogLevel;
}

export interface SweepResult {
  expired: number;
  stopped: number;
}

export type SweepOutboundCallsHandler = () => Promise<SweepResult>;

export function createSweepOutboundCallsHandler(
  deps: SweepOutboundCallsDeps,
): SweepOutboundCallsHandler {
  return async () => {
    const logger = createLogger({ level: deps.logLevel ?? 'info', correlationId: 'sweep' });
    const expired = await deps.calls.listExpiredRinging(deps.now());
    let stopped = 0;
    for (const record of expired) {
      const won = await deps.calls.transitionFromRinging(record.callId, 'timedOut', {
        endedAt: deps.now(),
      });
      if (!won) continue; // answered/declined in the meantime — nothing to stop
      try {
        await deps.connect.stopContact(record.session.contactId);
        stopped += 1;
      } catch (err) {
        // The contact may already be over (agent hung up) — that also releases the agent.
        logger.warn('stopContact failed during sweep', { callId: record.callId, err });
      }
    }
    if (expired.length > 0) {
      logger.info('outbound ring-timeout sweep', { expired: expired.length, stopped });
    }
    return { expired: expired.length, stopped };
  };
}
