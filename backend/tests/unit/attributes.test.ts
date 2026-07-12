import { buildContactAttributes } from '../../src/connect/attributes';
import type { DeviceInfo } from '../../src/domain/types';

const device: DeviceInfo = {
  platform: 'iOS',
  osVersion: '17.5',
  appVersion: '4.2.0',
  deviceModel: 'iPhone15,2',
  locale: 'en-GB',
  networkType: 'wifi',
};

const allowed = new Set(['issueType', 'tier', 'segment', 'productId']);

describe('FR-B2 / US-1 — contact attribute merge', () => {
  it('includes allow-listed client context and device details', () => {
    const attrs = buildContactAttributes({
      trustedClaims: { customerId: 'cust-123' },
      clientContext: { issueType: 'billing', tier: 'gold' },
      device,
      allowedClientKeys: allowed,
      correlationId: 'corr-1',
    });

    expect(attrs.issueType).toBe('billing');
    expect(attrs.tier).toBe('gold');
    expect(attrs.devicePlatform).toBe('iOS');
    expect(attrs.appVersion).toBe('4.2.0');
    expect(attrs.osVersion).toBe('17.5');
    expect(attrs.deviceModel).toBe('iPhone15,2');
    expect(attrs.customerId).toBe('cust-123');
    expect(attrs.correlationId).toBe('corr-1');
  });

  it('NFR-2: trusted claims win over client-supplied values of the same key', () => {
    const attrs = buildContactAttributes({
      trustedClaims: { customerId: 'cust-123', tier: 'gold' },
      clientContext: { customerId: 'cust-999', tier: 'silver' }, // spoofed
      device,
      allowedClientKeys: allowed,
      correlationId: 'c',
    });
    expect(attrs.customerId).toBe('cust-123');
    expect(attrs.tier).toBe('gold');
  });

  it('drops client keys that are not in the allow-list', () => {
    const attrs = buildContactAttributes({
      trustedClaims: {},
      clientContext: { issueType: 'billing', secretFlag: 'x', isVip: 'true' },
      device,
      allowedClientKeys: allowed,
      correlationId: 'c',
    });
    expect(attrs.issueType).toBe('billing');
    expect(attrs.secretFlag).toBeUndefined();
    expect(attrs.isVip).toBeUndefined();
  });

  it('sanitises keys — Connect allows only alphanumeric, dash, underscore', () => {
    const attrs = buildContactAttributes({
      trustedClaims: { 'bad$key': 'v', 'good_key-1': 'ok' },
      clientContext: {},
      device,
      allowedClientKeys: allowed,
      correlationId: 'c',
    });
    expect(attrs['bad$key']).toBeUndefined();
    expect(attrs['good_key-1']).toBe('ok');
  });

  it('trims values and drops empty/undefined-valued attributes', () => {
    const attrs = buildContactAttributes({
      trustedClaims: { a: '  spaced  ', b: '   ' },
      clientContext: {},
      device: { platform: 'Android' },
      allowedClientKeys: allowed,
      correlationId: 'c',
    });
    expect(attrs.a).toBe('spaced');
    expect(attrs.b).toBeUndefined();
    // absent device fields are simply not present
    expect(attrs.osVersion).toBeUndefined();
    expect(attrs.devicePlatform).toBe('Android');
  });

  it('stays within the Connect 32768-byte total budget by dropping overflow client attrs', () => {
    const big: Record<string, string> = {};
    const allowBig = new Set<string>();
    for (let i = 0; i < 40; i++) {
      big[`k${i}`] = 'v'.repeat(1000);
      allowBig.add(`k${i}`);
    }
    const attrs = buildContactAttributes({
      trustedClaims: { customerId: 'cust-1' },
      clientContext: big,
      device,
      allowedClientKeys: allowBig,
      correlationId: 'c',
    });
    const total = Object.entries(attrs).reduce(
      (n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v),
      0,
    );
    expect(total).toBeLessThanOrEqual(32768);
    // server-critical attributes always survive the trim
    expect(attrs.customerId).toBe('cust-1');
    expect(attrs.correlationId).toBe('c');
    expect(attrs.devicePlatform).toBe('iOS');
  });

  it('tags the contact with a server-controlled source', () => {
    const attrs = buildContactAttributes({
      trustedClaims: {},
      clientContext: {},
      device,
      allowedClientKeys: allowed,
      correlationId: 'c',
    });
    expect(attrs.source).toBe('chimeflutter-mobile');
  });
});
