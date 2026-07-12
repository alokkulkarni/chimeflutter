/**
 * Helpers for building API Gateway (HTTP API, payload format 2.0) responses with a consistent,
 * hardened envelope. Error bodies expose only `{ code, message }` plus a correlation id.
 */
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AppError } from './errors';

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

export function json(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

export const ok = (body: unknown): APIGatewayProxyStructuredResultV2 => json(200, body);
export const created = (body: unknown): APIGatewayProxyStructuredResultV2 => json(201, body);

export function noContent(): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 204, headers: { ...SECURITY_HEADERS } };
}

/** Serialises an {@link AppError} into the stable client-facing error envelope. */
export function errorResponse(
  error: AppError,
  correlationId: string,
): APIGatewayProxyStructuredResultV2 {
  return json(error.statusCode, {
    error: { code: error.code, message: error.message },
    correlationId,
  });
}
