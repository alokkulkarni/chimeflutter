/**
 * Small helpers for reading from an API Gateway HTTP API (v2) event without pulling framework
 * concerns into the handlers.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

/** Case-insensitive header lookup (HTTP API lowercases header keys, but be defensive). */
export function getHeader(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const headers = event.headers ?? {};
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

export function getRawBody(event: APIGatewayProxyEventV2): string | undefined {
  if (event.body === undefined) return undefined;
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64').toString('utf8');
  return event.body;
}

/**
 * Trusted identity claims injected by the Lambda authorizer live at
 * `requestContext.authorizer.lambda`. Returns a plain string map (or {} if absent).
 */
export function getAuthorizerContext(event: APIGatewayProxyEventV2): Record<string, string> {
  const lambda = (event.requestContext as { authorizer?: { lambda?: unknown } } | undefined)
    ?.authorizer?.lambda;
  if (!lambda || typeof lambda !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(lambda as Record<string, unknown>)) {
    if (v !== null && v !== undefined) out[k] = String(v);
  }
  return out;
}
