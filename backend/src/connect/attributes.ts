/**
 * Builds the Amazon Connect contact `Attributes` map that drives contact-flow routing.
 *
 * Requirements:
 *  - FR-B2: merge (a) trusted JWT claims, (b) allow-listed client context, (c) device details.
 *  - NFR-2: server-trusted values always win over client-claimed identity.
 *  - Connect constraints: attribute keys may contain only alphanumeric, `-`, `_`; total size across
 *    all key/value pairs must stay within 32,768 UTF-8 bytes.
 *
 * The resulting attributes are read in the flow as `$.Attributes.<Key>` (e.g. a "Check contact
 * attributes" block branching on `issueType`, then a "Set working queue" block).
 */
import type { DeviceInfo } from '../domain/types';

const CONNECT_KEY_RE = /^[A-Za-z0-9_-]+$/;
const MAX_TOTAL_BYTES = 32768;
const MAX_VALUE_BYTES = 32767;

export interface BuildAttributesInput {
  /** Verified identity claims from the JWT authorizer — these win. */
  trustedClaims: Record<string, string>;
  /** Free-form context from the client request body. */
  clientContext?: Record<string, string>;
  device: DeviceInfo;
  /** Allow-list of client-context keys permitted to reach Connect. */
  allowedClientKeys: ReadonlySet<string>;
  correlationId: string;
}

function deviceAttributes(device: DeviceInfo): Record<string, string | undefined> {
  return {
    devicePlatform: device.platform,
    osVersion: device.osVersion,
    appVersion: device.appVersion,
    deviceModel: device.deviceModel,
    locale: device.locale,
    networkType: device.networkType,
  };
}

/** Validates the key and normalises the value; returns undefined if the pair must be skipped. */
function normalisePair(key: string, value: unknown): [string, string] | undefined {
  if (!CONNECT_KEY_RE.test(key)) return undefined;
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  if (str.length === 0) return undefined;
  const truncated = str.length > MAX_VALUE_BYTES ? str.slice(0, MAX_VALUE_BYTES) : str;
  return [key, truncated];
}

export function buildContactAttributes(input: BuildAttributesInput): Record<string, string> {
  const { trustedClaims, clientContext = {}, device, allowedClientKeys, correlationId } = input;

  // Server-critical attributes are added first and are protected from the size-based trim.
  const critical: Record<string, string> = {};
  const addCritical = (k: string, v: unknown) => {
    const pair = normalisePair(k, v);
    if (pair) critical[pair[0]] = pair[1];
  };

  addCritical('source', 'chimeflutter-mobile');
  addCritical('correlationId', correlationId);
  for (const [k, v] of Object.entries(deviceAttributes(device))) addCritical(k, v);
  // Trusted identity claims win over everything (NFR-2) and are also protected.
  for (const [k, v] of Object.entries(trustedClaims)) addCritical(k, v);

  // Client context is best-effort: only allow-listed keys, and only if it fits the byte budget.
  let total = Object.entries(critical).reduce(
    (n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v),
    0,
  );

  const result: Record<string, string> = { ...critical };
  for (const [k, v] of Object.entries(clientContext)) {
    if (!allowedClientKeys.has(k)) continue;
    if (k in critical) continue; // never let client override a trusted/critical key
    const pair = normalisePair(k, v);
    if (!pair) continue;
    const cost = Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]);
    if (total + cost > MAX_TOTAL_BYTES) continue; // drop overflow rather than fail the call
    result[pair[0]] = pair[1];
    total += cost;
  }

  return result;
}
