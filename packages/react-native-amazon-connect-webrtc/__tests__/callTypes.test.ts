import { parseEnabledCallTypes, soleCallType } from '../src/callTypes';

describe('parseEnabledCallTypes', () => {
  it('parses both, single, spaced and mixed-case values', () => {
    expect([...parseEnabledCallTypes('audio,video')].sort()).toEqual(['audio', 'video']);
    expect([...parseEnabledCallTypes('audio')]).toEqual(['audio']);
    expect([...parseEnabledCallTypes('video')]).toEqual(['video']);
    expect([...parseEnabledCallTypes(' Video , AUDIO ')].sort()).toEqual(['audio', 'video']);
  });

  it('falls back to both on empty/unknown input (a typo must never remove calling)', () => {
    expect(parseEnabledCallTypes(undefined).size).toBe(2);
    expect(parseEnabledCallTypes('').size).toBe(2);
    expect(parseEnabledCallTypes('telepathy').size).toBe(2);
  });
});

describe('soleCallType', () => {
  it('returns the type only when exactly one is enabled', () => {
    expect(soleCallType(parseEnabledCallTypes('audio'))).toBe('audio');
    expect(soleCallType(parseEnabledCallTypes('video'))).toBe('video');
    expect(soleCallType(parseEnabledCallTypes('audio,video'))).toBeNull();
  });
});
