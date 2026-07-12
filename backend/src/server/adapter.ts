/**
 * Pure translation layer for the container deployment: maps an incoming Node HTTP request onto the
 * SAME APIGatewayProxyEventV2 shape the Lambda handlers already consume, so Docker serves
 * byte-for-byte the behaviour of the API Gateway deployment (routing, validation, error envelope,
 * logging — all unchanged).
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export type RouteKey = 'health' | 'startCall' | 'endCall' | 'participant';

export interface ResolvedRoute {
  key: RouteKey;
  pathParameters?: Record<string, string>;
}

/** Same ceiling class as API Gateway HTTP APIs (10 MB); our payloads are a few KB. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Maps method+path to the Lambda handler that owns it — mirroring the routes in
 * backend/template.yaml. An optional `/v1` stage prefix is accepted and stripped so clients can
 * use the exact same URLs against the container as against API Gateway.
 */
export function resolveRoute(method: string, pathname: string): ResolvedRoute | null {
  const path = normalizePath(pathname);
  const m = method.toUpperCase();

  if (m === 'GET' && path === '/health') return { key: 'health' };
  if (m === 'POST' && path === '/calls') return { key: 'startCall' };
  if (m === 'POST' && (path === '/calls/connections' || path === '/calls/dtmf')) {
    return { key: 'participant' };
  }
  if (m === 'DELETE') {
    const match = /^\/calls\/([^/]+)$/.exec(path);
    if (match) {
      return { key: 'endCall', pathParameters: { contactId: decodeURIComponent(match[1]!) } };
    }
  }
  return null;
}

/** Strips an optional /v1 stage prefix and any trailing slash (but keeps "/"). */
export function normalizePath(pathname: string): string {
  let path = pathname.replace(/^\/v1(?=\/|$)/, '');
  if (path.length > 1) path = path.replace(/\/$/, '');
  return path === '' ? '/' : path;
}

/**
 * Builds the minimal APIGatewayProxyEventV2 the handlers actually read: `headers` (they do their
 * own case-insensitive lookup), `body`/`isBase64Encoded`, `rawPath` (participant routing) and
 * `pathParameters` (endCall). The full event type has many more fields the handlers never touch.
 */
export function toApiGatewayEvent(args: {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string | undefined;
  pathParameters?: Record<string, string>;
  requestId: string;
}): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.headers)) {
    if (value === undefined) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  const rawPath = normalizePath(args.path);
  const event = {
    version: '2.0',
    routeKey: `${args.method.toUpperCase()} ${rawPath}`,
    rawPath,
    rawQueryString: '',
    headers,
    body: args.body,
    isBase64Encoded: false,
    pathParameters: args.pathParameters,
    requestContext: {
      accountId: 'container',
      apiId: 'container',
      domainName: 'container',
      domainPrefix: 'container',
      http: {
        method: args.method.toUpperCase(),
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '',
        userAgent: headers['user-agent'] ?? '',
      },
      requestId: args.requestId,
      routeKey: `${args.method.toUpperCase()} ${rawPath}`,
      stage: 'v1',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
  };
  return event as APIGatewayProxyEventV2;
}
