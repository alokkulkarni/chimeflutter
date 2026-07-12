import { redact, DEFAULT_SENSITIVE_KEYS } from '../../src/domain/redact';

describe('FR-B10 / NFR-1 — PII redaction for structured logs', () => {
  it('masks sensitive keys by name (case-insensitive)', () => {
    const input = {
      customerName: 'Ada Lovelace',
      Email: 'ada@example.com',
      phoneNumber: '+441234567890',
      participantToken: 'secret-token',
      issueType: 'billing',
    };

    const out = redact(input);

    expect(out.customerName).toBe('***REDACTED***');
    expect(out.Email).toBe('***REDACTED***');
    expect(out.phoneNumber).toBe('***REDACTED***');
    expect(out.participantToken).toBe('***REDACTED***');
    // Non-sensitive values pass through untouched.
    expect(out.issueType).toBe('billing');
  });

  it('redacts nested objects and arrays without mutating the input', () => {
    const input = {
      attributes: { tier: 'gold', email: 'x@y.com' },
      participants: [{ name: 'A', role: 'customer' }],
    };

    const out = redact(input);

    expect(out).toEqual({
      attributes: { tier: 'gold', email: '***REDACTED***' },
      participants: [{ name: '***REDACTED***', role: 'customer' }],
    });
    // Original object is untouched (no mutation).
    expect(input.attributes.email).toBe('x@y.com');
  });

  it('masks email and phone patterns found inside free-text strings', () => {
    const out = redact({ note: 'call me at ada@example.com or +44 1234 567890' });
    expect(out.note).not.toContain('ada@example.com');
    expect(out.note).not.toContain('567890');
  });

  it('supports a caller-supplied additional key set', () => {
    const out = redact({ ssn: '123-45-6789', ok: 1 }, [...DEFAULT_SENSITIVE_KEYS, 'ssn']);
    expect(out.ssn).toBe('***REDACTED***');
    expect(out.ok).toBe(1);
  });

  it('is resilient to circular references', () => {
    const a: Record<string, unknown> = { name: 'X' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    const out = redact(a);
    expect(out.name).toBe('***REDACTED***');
  });
});
