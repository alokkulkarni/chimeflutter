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
