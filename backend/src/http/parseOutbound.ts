/**
 * Parses and validates the simulated-outbound request bodies (`POST /devices`,
 * `POST /calls/outbound`). Pure and framework-agnostic, mirroring parseRequest.ts.
 */
import { badRequest } from './errors';
import { parseCallType } from '../connect/capabilities';
import type {
  DevicePlatform,
  OutboundCallRequest,
  RegisterDeviceRequest,
} from '../domain/outbound';

const KNOWN_PLATFORMS: Record<string, DevicePlatform> = {
  ios: 'iOS',
  android: 'Android',
};

/** Connect customerId attribute + DynamoDB key — keep it to a safe identifier alphabet. */
const CUSTOMER_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
/** Connect user id (UUID) or full agent ARN. */
const AGENT_ID_RE = /^[A-Za-z0-9_/:.-]{1,512}$/;
const MAX_PUSH_TOKEN = 4096;
const MAX_DISPLAY_NAME = 256;

const DEFAULT_CALLER_DISPLAY_NAME = 'Support';
const DEFAULT_CUSTOMER_DISPLAY_NAME = 'Mobile Customer';

function asObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null || body === '') {
    throw badRequest('EMPTY_BODY', 'Request body is required');
  }
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw badRequest('INVALID_JSON', 'Request body is not valid JSON');
    }
  }
  if (typeof body === 'object') return body as Record<string, unknown>;
  throw badRequest('INVALID_BODY', 'Request body must be a JSON object');
}

function parseCustomerId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!CUSTOMER_ID_RE.test(value)) {
    throw badRequest(
      'INVALID_CUSTOMER_ID',
      'customerId is required (1-128 chars: letters, digits, _ . : @ -)',
    );
  }
  return value;
}

function parseDisplayName(raw: unknown, fallback: string): string {
  const value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
  return value.length > MAX_DISPLAY_NAME ? value.slice(0, MAX_DISPLAY_NAME) : value;
}

function parseContext(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    out[k] = String(v);
  }
  return out;
}

export function parseRegisterDeviceRequest(body: unknown): RegisterDeviceRequest {
  const obj = asObject(body);

  const platformRaw = typeof obj.platform === 'string' ? obj.platform.trim().toLowerCase() : '';
  const platform = KNOWN_PLATFORMS[platformRaw];
  if (!platform) {
    throw badRequest('INVALID_PLATFORM', "platform must be 'iOS' or 'Android'");
  }

  const pushToken = typeof obj.pushToken === 'string' ? obj.pushToken.trim() : '';
  if (pushToken.length === 0 || pushToken.length > MAX_PUSH_TOKEN) {
    throw badRequest('INVALID_PUSH_TOKEN', `pushToken is required (1-${MAX_PUSH_TOKEN} chars)`);
  }

  return { customerId: parseCustomerId(obj.customerId), platform, pushToken };
}

export function parseOutboundCallRequest(body: unknown): OutboundCallRequest {
  const obj = asObject(body);

  const agentId = typeof obj.agentId === 'string' ? obj.agentId.trim() : '';
  if (!AGENT_ID_RE.test(agentId)) {
    throw badRequest('INVALID_AGENT_ID', 'agentId is required (Connect user id or agent ARN)');
  }

  return {
    customerId: parseCustomerId(obj.customerId),
    agentId,
    callType: parseCallType(obj.callType),
    callerDisplayName: parseDisplayName(obj.callerDisplayName, DEFAULT_CALLER_DISPLAY_NAME),
    customerDisplayName: parseDisplayName(obj.customerDisplayName, DEFAULT_CUSTOMER_DISPLAY_NAME),
    context: parseContext(obj.context),
  };
}
