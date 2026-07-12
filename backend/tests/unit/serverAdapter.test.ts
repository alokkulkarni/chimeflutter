import { normalizePath, resolveRoute, toApiGatewayEvent } from '../../src/server/adapter';

describe('normalizePath', () => {
  it('strips an optional /v1 stage prefix and trailing slashes', () => {
    expect(normalizePath('/v1/health')).toBe('/health');
    expect(normalizePath('/health')).toBe('/health');
    expect(normalizePath('/v1/calls/')).toBe('/calls');
    expect(normalizePath('/v1')).toBe('/');
    // /v1xyz is NOT the stage prefix
    expect(normalizePath('/v1xyz')).toBe('/v1xyz');
  });
});

describe('resolveRoute', () => {
  it('maps every template.yaml route, with and without the /v1 prefix', () => {
    expect(resolveRoute('GET', '/v1/health')?.key).toBe('health');
    expect(resolveRoute('GET', '/health')?.key).toBe('health');
    expect(resolveRoute('POST', '/v1/calls')?.key).toBe('startCall');
    expect(resolveRoute('post', '/calls')?.key).toBe('startCall');
    expect(resolveRoute('POST', '/v1/calls/connections')?.key).toBe('participant');
    expect(resolveRoute('POST', '/v1/calls/dtmf')?.key).toBe('participant');
  });

  it('extracts (and URL-decodes) the contactId for DELETE /calls/{contactId}', () => {
    expect(resolveRoute('DELETE', '/v1/calls/abc-123')).toEqual({
      key: 'endCall',
      pathParameters: { contactId: 'abc-123' },
    });
    expect(resolveRoute('DELETE', '/calls/a%2Fb')?.pathParameters).toEqual({ contactId: 'a/b' });
  });

  it('returns null for unknown routes and wrong methods', () => {
    expect(resolveRoute('GET', '/v1/calls')).toBeNull();
    expect(resolveRoute('PUT', '/v1/calls')).toBeNull();
    expect(resolveRoute('POST', '/v1/calls/abc-123')).toBeNull();
    expect(resolveRoute('DELETE', '/v1/calls')).toBeNull();
    expect(resolveRoute('DELETE', '/v1/calls/a/b')).toBeNull();
    expect(resolveRoute('GET', '/')).toBeNull();
  });
});

describe('toApiGatewayEvent', () => {
  it('builds the fields the handlers actually read', () => {
    const event = toApiGatewayEvent({
      method: 'post',
      path: '/v1/calls/dtmf',
      headers: {
        authorization: 'Bearer jwt',
        'x-correlation-id': 'corr-1',
        'set-cookie': ['a=1', 'b=2'], // array headers are joined
      },
      body: '{"digits":"1"}',
      requestId: 'req-1',
    });

    expect(event.rawPath).toBe('/calls/dtmf'); // participant handler routes on this suffix
    expect(event.headers['authorization']).toBe('Bearer jwt');
    expect(event.headers['x-correlation-id']).toBe('corr-1');
    expect(event.headers['set-cookie']).toBe('a=1, b=2');
    expect(event.body).toBe('{"digits":"1"}');
    expect(event.isBase64Encoded).toBe(false);
    expect(event.requestContext.http.method).toBe('POST');
    expect(event.requestContext.requestId).toBe('req-1');
  });

  it('carries pathParameters through for endCall', () => {
    const event = toApiGatewayEvent({
      method: 'DELETE',
      path: '/v1/calls/contact-1',
      headers: {},
      body: undefined,
      pathParameters: { contactId: 'contact-1' },
      requestId: 'req-2',
    });
    expect(event.pathParameters).toEqual({ contactId: 'contact-1' });
    expect(event.body).toBeUndefined();
  });
});
