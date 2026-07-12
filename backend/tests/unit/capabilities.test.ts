import { buildAllowedCapabilities, parseCallType } from '../../src/connect/capabilities';
import { AppError } from '../../src/http/errors';

describe('FR-B3 — AllowedCapabilities mapping', () => {
  it('audio call requests no video capability (audio is always on for WebRTC)', () => {
    // Connect enables audio implicitly for WebRTC contacts; only video is opt-in.
    expect(buildAllowedCapabilities('audio')).toBeUndefined();
  });

  it('video call grants video SEND to both customer and agent', () => {
    const caps = buildAllowedCapabilities('video');
    expect(caps).toEqual({
      Customer: { Video: 'SEND' },
      Agent: { Video: 'SEND' },
    });
  });
});

describe('parseCallType — input validation', () => {
  it('accepts audio and video', () => {
    expect(parseCallType('audio')).toBe('audio');
    expect(parseCallType('video')).toBe('video');
  });

  it('rejects anything else with a 400 INVALID_CALL_TYPE', () => {
    expect(() => parseCallType('screenshare')).toThrow(AppError);
    try {
      parseCallType('nope');
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_CALL_TYPE');
      expect((e as AppError).statusCode).toBe(400);
    }
  });

  it('rejects missing/undefined', () => {
    expect(() => parseCallType(undefined)).toThrow(AppError);
  });
});
