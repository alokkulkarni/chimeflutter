/**
 * Deployment entrypoint for the ring-timeout sweeper. On Lambda it runs from a 1-minute
 * EventBridge schedule; the Docker container drives the same handler from a setInterval
 * (src/server/main.ts). No-ops (returns zero counts) when outbound is not configured.
 */
import { loadConfig, loadOutboundConfig } from '../config/env';
import { createConnectPort, getConnectClient } from '../connect/connectClient';
import { createOutboundCallStore } from '../store/outboundCallStore';
import { getDocumentClient } from '../store/deviceStore';
import {
  createSweepOutboundCallsHandler,
  type SweepOutboundCallsHandler,
  type SweepResult,
} from '../handlers/sweepOutboundCalls';

let cached: SweepOutboundCallsHandler | undefined;

function init(): SweepOutboundCallsHandler {
  const config = loadConfig();
  const outbound = loadOutboundConfig();
  return createSweepOutboundCallsHandler({
    calls: createOutboundCallStore(getDocumentClient(config.region), outbound.outboundCallsTable),
    connect: createConnectPort(getConnectClient(config.region), {
      instanceId: config.connectInstanceId,
      contactFlowId: outbound.outboundContactFlowId,
    }),
    now: () => Date.now(),
    logLevel: config.logLevel,
  });
}

export const handler = async (): Promise<SweepResult> => {
  try {
    cached ??= init();
  } catch {
    return { expired: 0, stopped: 0 };
  }
  return cached();
};
