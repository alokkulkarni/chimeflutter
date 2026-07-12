import { loadConfig } from '../../src/config/env';

const base = {
  AWS_REGION: 'eu-west-2',
  CONNECT_INSTANCE_ID: '11111111-1111-1111-1111-111111111111',
  CONNECT_CONTACT_FLOW_ID: '22222222-2222-2222-2222-222222222222',
};

describe('config loader', () => {
  it('loads a valid config', () => {
    const cfg = loadConfig(base);
    expect(cfg.connectInstanceId).toBe(base.CONNECT_INSTANCE_ID);
    expect(cfg.connectContactFlowId).toBe(base.CONNECT_CONTACT_FLOW_ID);
    expect(cfg.region).toBe('eu-west-2');
  });

  it('parses the client-attribute allow-list as a trimmed set', () => {
    const cfg = loadConfig({ ...base, ALLOWED_CLIENT_ATTRIBUTE_KEYS: ' issueType , tier ,segment ' });
    expect([...cfg.allowedClientAttributeKeys].sort()).toEqual(['issueType', 'segment', 'tier']);
  });

  it('provides a sensible default allow-list when unset', () => {
    const cfg = loadConfig(base);
    expect(cfg.allowedClientAttributeKeys.size).toBeGreaterThan(0);
  });

  it('throws a descriptive error when a required var is missing', () => {
    const { CONNECT_INSTANCE_ID, ...withoutInstance } = base;
    expect(() => loadConfig(withoutInstance)).toThrow(/CONNECT_INSTANCE_ID/);
  });
});
