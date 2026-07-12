/**
 * Parses and validates the `POST /v1/calls` request body into a typed {@link CallRequest}.
 * Pure and framework-agnostic so it is trivially unit tested.
 */
import { badRequest } from './errors';
import { parseCallType } from '../connect/capabilities';
import type { CallRequest, DeviceInfo } from '../domain/types';

const KNOWN_PLATFORMS: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
};

const DEFAULT_DISPLAY_NAME = 'Mobile Customer';
const MAX_DISPLAY_NAME = 256;

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

function parseDevice(raw: unknown): DeviceInfo {
  if (typeof raw !== 'object' || raw === null) {
    throw badRequest('INVALID_DEVICE', 'device is required');
  }
  const d = raw as Record<string, unknown>;
  const platformRaw = typeof d.platform === 'string' ? d.platform.trim().toLowerCase() : '';
  const platform = KNOWN_PLATFORMS[platformRaw];
  if (!platform) {
    throw badRequest('INVALID_PLATFORM', "device.platform must be 'iOS' or 'Android'");
  }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  return {
    platform,
    osVersion: str(d.osVersion),
    appVersion: str(d.appVersion),
    deviceModel: str(d.deviceModel),
    locale: str(d.locale),
    networkType: str(d.networkType),
  };
}

function parseContext(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue; // context is a flat string map
    out[k] = String(v);
  }
  return out;
}

export function parseCallRequest(body: unknown): CallRequest {
  const obj = asObject(body);
  const callType = parseCallType(obj.callType);
  const device = parseDevice(obj.device);

  let displayName =
    typeof obj.displayName === 'string' && obj.displayName.trim() !== ''
      ? obj.displayName.trim()
      : DEFAULT_DISPLAY_NAME;
  if (displayName.length > MAX_DISPLAY_NAME) displayName = displayName.slice(0, MAX_DISPLAY_NAME);

  return {
    callType,
    displayName,
    device,
    context: parseContext(obj.context),
  };
}
