/**
 * Agent-availability gate for simulated outbound calls.
 *
 * Requirement (outbound FR): the agent MUST be routable with a free voice slot before we ring the
 * customer, because the contact is routed straight to the agent's personal queue and must be
 * offered to them immediately — occupying their voice slot so Connect offers them nothing else
 * while the customer's phone rings.
 *
 * Uses `GetCurrentUserData` (real-time agent status) via a port so handlers stay mockable.
 */
import { GetCurrentUserDataCommand, type ConnectClient } from '@aws-sdk/client-connect';

export interface AgentSnapshot {
  found: boolean;
  /** Agent (user) ARN, when returned — preferred value for the flow's set-queue-by-agent step. */
  arn?: string;
  statusName?: string;
  /** Free VOICE slots right now; undefined when Connect omits the map. */
  availableVoiceSlots?: number;
}

export interface AgentStatusPort {
  getAgentSnapshot(agentId: string): Promise<AgentSnapshot>;
}

export interface AgentAvailability {
  available: boolean;
  /** Machine-readable reason for a 409 (e.g. 'NOT_FOUND', 'NO_FREE_VOICE_SLOT'). */
  reason: string;
}

/**
 * Pure decision: routable and a free voice slot. When Connect omits AvailableSlotsByChannel we
 * fall back to the status name (default routable status is 'Available').
 */
export function evaluateAgentAvailability(snapshot: AgentSnapshot): AgentAvailability {
  if (!snapshot.found) return { available: false, reason: 'AGENT_NOT_FOUND' };
  if (snapshot.availableVoiceSlots !== undefined) {
    return snapshot.availableVoiceSlots >= 1
      ? { available: true, reason: 'OK' }
      : { available: false, reason: 'NO_FREE_VOICE_SLOT' };
  }
  return snapshot.statusName === 'Available'
    ? { available: true, reason: 'OK' }
    : { available: false, reason: 'AGENT_NOT_ROUTABLE' };
}

/** Accepts a Connect user id or a full user/agent ARN and returns the bare user id. */
export function toUserId(agentId: string): string {
  const arnMatch = /\/agent\/([^/]+)$/.exec(agentId);
  return arnMatch ? arnMatch[1]! : agentId;
}

export function createAgentStatusPort(client: ConnectClient, instanceId: string): AgentStatusPort {
  return {
    async getAgentSnapshot(agentId: string): Promise<AgentSnapshot> {
      const userId = toUserId(agentId);
      const response = await client.send(
        new GetCurrentUserDataCommand({
          InstanceId: instanceId,
          Filters: { Agents: [userId] },
        }),
      );
      const data = response.UserDataList?.find((u) => u.User?.Id === userId) ??
        response.UserDataList?.[0];
      if (!data) return { found: false };
      return {
        found: true,
        arn: data.User?.Arn,
        statusName: data.Status?.StatusName,
        availableVoiceSlots: data.AvailableSlotsByChannel?.VOICE,
      };
    },
  };
}
