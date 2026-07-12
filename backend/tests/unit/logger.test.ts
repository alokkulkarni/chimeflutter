import { createLogger } from '../../src/domain/logger';

describe('structured logger', () => {
  let out: string[];
  const sink = (line: string) => out.push(line);
  const clock = () => '2026-07-10T00:00:00.000Z';

  beforeEach(() => {
    out = [];
  });

  it('emits single-line JSON with level, timestamp, correlationId, message', () => {
    const log = createLogger({ level: 'info', correlationId: 'corr-1', sink, clock });
    log.info('call started', { contactId: 'c-1' });

    expect(out).toHaveLength(1);
    const entry = JSON.parse(out[0]!);
    expect(entry).toMatchObject({
      level: 'info',
      time: '2026-07-10T00:00:00.000Z',
      correlationId: 'corr-1',
      message: 'call started',
      contactId: 'c-1',
    });
  });

  it('redacts PII in the context (FR-B10)', () => {
    const log = createLogger({ level: 'info', correlationId: 'x', sink, clock });
    log.info('ctx', { customerName: 'Ada', email: 'ada@example.com', tier: 'gold' });
    const entry = JSON.parse(out[0]!);
    expect(entry.customerName).toBe('***REDACTED***');
    expect(entry.email).toBe('***REDACTED***');
    expect(entry.tier).toBe('gold');
  });

  it('suppresses messages below the configured level', () => {
    const log = createLogger({ level: 'warn', correlationId: 'x', sink, clock });
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).level).toBe('warn');
  });

  it('serialises an Error without leaking it as PII but keeps name/message for ops', () => {
    const log = createLogger({ level: 'error', correlationId: 'x', sink, clock });
    log.error('failed', { err: new Error('kaboom') });
    const entry = JSON.parse(out[0]!);
    expect(entry.err.name).toBe('Error');
    expect(entry.err.message).toBe('kaboom');
  });
});
