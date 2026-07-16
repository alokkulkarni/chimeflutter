/**
 * Environment configuration loader.
 *
 * The Connect InstanceId and ContactFlowId live *only* here (server side) — they are never sent to
 * the client (NFR-1). The client-attribute allow-list (NFR-2) is also defined here.
 */

export interface AppConfig {
  region: string;
  connectInstanceId: string;
  connectContactFlowId: string;
  /** Allow-list of client-supplied attribute keys that may pass through to Connect (NFR-2). */
  allowedClientAttributeKeys: ReadonlySet<string>;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_ALLOWED_CLIENT_ATTRIBUTE_KEYS = [
  'issueType',
  'issueSubType',
  'productId',
  'tier',
  'segment',
  'language',
  'preferredAgentId',
  'lastScreen',
  'campaignId',
];

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function parseCsvSet(raw: string | undefined, fallback: string[]): Set<string> {
  if (!raw || raw.trim() === '') return new Set(fallback);
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const logLevel = (env.LOG_LEVEL ?? 'info') as AppConfig['logLevel'];
  return {
    region: required(env, 'AWS_REGION'),
    connectInstanceId: required(env, 'CONNECT_INSTANCE_ID'),
    connectContactFlowId: required(env, 'CONNECT_CONTACT_FLOW_ID'),
    allowedClientAttributeKeys: parseCsvSet(
      env.ALLOWED_CLIENT_ATTRIBUTE_KEYS,
      DEFAULT_ALLOWED_CLIENT_ATTRIBUTE_KEYS,
    ),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
  };
}

/** Extra configuration required only by the simulated-outbound endpoints (docs/OUTBOUND_CALLS.md). */
export interface OutboundConfig {
  devicesTable: string;
  outboundCallsTable: string;
  /** Flow that routes by $.Attributes.targetAgentArn; falls back to the inbound flow when unset. */
  outboundContactFlowId: string;
  /** How long the customer's device rings before the contact is stopped (clamped 15–120 s). */
  ringTimeoutSeconds: number;
  apnsPlatformApplicationArn?: string;
  fcmPlatformApplicationArn?: string;
}

const DEFAULT_RING_TIMEOUT_SECONDS = 45;

function optional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Throws when the outbound tables are not configured — callers surface that as a clear
 * OUTBOUND_NOT_CONFIGURED error instead of crashing at load time (the Docker container must boot
 * fine without outbound configured).
 */
export function loadOutboundConfig(
  env: Record<string, string | undefined> = process.env,
): OutboundConfig {
  const rawTimeout = Number(env.OUTBOUND_RING_TIMEOUT_SECONDS ?? DEFAULT_RING_TIMEOUT_SECONDS);
  const ringTimeoutSeconds = Number.isFinite(rawTimeout)
    ? Math.min(120, Math.max(15, Math.round(rawTimeout)))
    : DEFAULT_RING_TIMEOUT_SECONDS;
  return {
    devicesTable: required(env, 'DEVICES_TABLE'),
    outboundCallsTable: required(env, 'OUTBOUND_CALLS_TABLE'),
    outboundContactFlowId:
      optional(env, 'CONNECT_OUTBOUND_CONTACT_FLOW_ID') ?? required(env, 'CONNECT_CONTACT_FLOW_ID'),
    ringTimeoutSeconds,
    apnsPlatformApplicationArn: optional(env, 'APNS_VOIP_PLATFORM_APPLICATION_ARN'),
    fcmPlatformApplicationArn: optional(env, 'FCM_PLATFORM_APPLICATION_ARN'),
  };
}
