/**
 * Public health check (GET /v1/health) for smoke tests and uptime probes. No auth, no Connect call.
 */
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export const handler = async (): Promise<APIGatewayProxyStructuredResultV2> => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ status: 'ok', service: 'chimeflutter-backend' }),
});
