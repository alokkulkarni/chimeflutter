/**
 * PII/secret redaction for structured logging.
 *
 * Requirement: FR-B10 / NFR-1 — the backend SHALL emit structured logs that redact PII
 * (name, phone, email, tokens). This module is pure and side-effect free so it can be unit
 * tested without a logger or cloud.
 */

export const REDACTED = '***REDACTED***';

/** Keys whose values are always masked, matched case-insensitively. */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'name',
  'customername',
  'displayname',
  'firstname',
  'lastname',
  'fullname',
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'mobile',
  'msisdn',
  'address',
  'dob',
  'dateofbirth',
  'ssn',
  'nino',
  'authorization',
  'token',
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'participanttoken',
  'jointoken',
  'clienttoken',
  'password',
  'secret',
  'apikey',
];

// Reasonable-effort patterns for PII embedded in free-text values.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// 7+ consecutive digits (optionally spaced/grouped, optional leading +) — catches phone numbers.
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

function maskString(value: string): string {
  return value.replace(EMAIL_RE, REDACTED).replace(PHONE_RE, REDACTED);
}

/** Scrubs email/phone patterns from a free-text string (e.g. an error message). */
export function redactText(value: string): string {
  return maskString(value);
}

/**
 * Returns a deep copy of `value` with sensitive keys masked and PII patterns scrubbed from
 * strings. Never mutates the input and is safe against circular references.
 */
export function redact<T>(value: T, sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS): T {
  const sensitive = new Set(sensitiveKeys.map((k) => k.toLowerCase()));
  const seen = new WeakSet<object>();

  const walk = (node: unknown): unknown => {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') return maskString(node);
    if (typeof node !== 'object') return node;

    if (seen.has(node as object)) return '[Circular]';
    seen.add(node as object);

    if (Array.isArray(node)) return node.map(walk);

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      out[key] = sensitive.has(key.toLowerCase()) ? REDACTED : walk(val);
    }
    return out;
  };

  return walk(value) as T;
}
