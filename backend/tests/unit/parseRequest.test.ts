import { parseCallRequest } from '../../src/http/parseRequest';
import { AppError } from '../../src/http/errors';

describe('parseCallRequest — request body validation', () => {
  const valid = {
    callType: 'audio',
    displayName: 'Ada',
    context: { issueType: 'billing' },
    device: { platform: 'iOS', appVersion: '4.2.0' },
  };

  it('parses a valid body', () => {
    const req = parseCallRequest(JSON.stringify(valid));
    expect(req.callType).toBe('audio');
    expect(req.displayName).toBe('Ada');
    expect(req.device.platform).toBe('iOS');
    expect(req.context).toEqual({ issueType: 'billing' });
  });

  it('accepts an already-parsed object', () => {
    expect(parseCallRequest(valid).callType).toBe('audio');
  });

  it('rejects invalid JSON with 400', () => {
    expect(() => parseCallRequest('{not json')).toThrow(AppError);
    try {
      parseCallRequest('{not json');
    } catch (e) {
      expect((e as AppError).statusCode).toBe(400);
    }
  });

  it('rejects a missing/empty body', () => {
    expect(() => parseCallRequest(undefined)).toThrow(AppError);
    expect(() => parseCallRequest('')).toThrow(AppError);
  });

  it('rejects an invalid callType', () => {
    expect(() => parseCallRequest({ ...valid, callType: 'chat' })).toThrow(/INVALID_CALL_TYPE|callType/);
  });

  it('requires a device with a recognised platform', () => {
    expect(() => parseCallRequest({ ...valid, device: undefined })).toThrow(AppError);
    expect(() => parseCallRequest({ ...valid, device: { platform: 'Windows' } })).toThrow(/platform/i);
  });

  it('normalises platform casing to iOS / Android', () => {
    expect(parseCallRequest({ ...valid, device: { platform: 'ios' } }).device.platform).toBe('iOS');
    expect(parseCallRequest({ ...valid, device: { platform: 'ANDROID' } }).device.platform).toBe('Android');
  });

  it('defaults displayName when absent and truncates to 256 chars', () => {
    const noName = parseCallRequest({ callType: 'video', device: { platform: 'iOS' } });
    expect(noName.displayName && noName.displayName.length).toBeGreaterThan(0);

    const long = parseCallRequest({
      callType: 'video',
      displayName: 'x'.repeat(500),
      device: { platform: 'iOS' },
    });
    expect(long.displayName!.length).toBe(256);
  });

  it('coerces context values to strings and drops non-object context', () => {
    const req = parseCallRequest({
      callType: 'audio',
      device: { platform: 'Android' },
      context: { a: 1, b: true, c: 'x' } as unknown as Record<string, string>,
    });
    expect(req.context).toEqual({ a: '1', b: 'true', c: 'x' });
  });
});
