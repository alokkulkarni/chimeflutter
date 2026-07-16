/**
 * Container entrypoint: a dependency-free Node HTTP server that hosts the SAME Lambda handlers the
 * SAM deployment uses (src/lambda/*). No framework, no new behaviour — requests are translated to
 * APIGatewayProxyEventV2 (adapter.ts) and the handlers do everything else exactly as on Lambda.
 *
 * AWS credentials come from the SDK's default provider chain — in Docker that means ROLE-BASED
 * access (ECS task role / EKS IRSA / EC2 instance profile), never baked-in keys. See
 * docs/BACKEND.md §7.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

// Importing the lambda entrypoints runs their cold-start wiring (loadConfig + AWS clients), so a
// missing CONNECT_INSTANCE_ID etc. fails fast at container start — same contract as Lambda.
import { handler as endCallHandler } from '../lambda/endCall';
import { handler as healthHandler } from '../lambda/health';
import { handler as participantHandler } from '../lambda/participant';
import { handler as startCallHandler } from '../lambda/startCall';
// The outbound entrypoints wire themselves lazily, so importing them here never crashes a
// container that has no outbound configuration — those routes just answer 501.
import { handler as outboundCallActionHandler } from '../lambda/outboundCallAction';
import { handler as registerDeviceHandler } from '../lambda/registerDevice';
import { handler as startOutboundCallHandler } from '../lambda/startOutboundCall';
import { handler as sweepOutboundCallsHandler } from '../lambda/sweepOutboundCalls';
import { MAX_BODY_BYTES, resolveRoute, toApiGatewayEvent, type RouteKey } from './adapter';

const PORT = Number(process.env.PORT ?? '8080');
const SWEEP_INTERVAL_MS = 60_000;

const handlers: Record<
  RouteKey,
  (event: ReturnType<typeof toApiGatewayEvent>) => Promise<APIGatewayProxyStructuredResultV2>
> = {
  health: () => healthHandler(),
  startCall: (event) => startCallHandler(event),
  endCall: (event) => endCallHandler(event),
  participant: (event) => participantHandler(event),
  registerDevice: (event) => registerDeviceHandler(event),
  startOutboundCall: (event) => startOutboundCallHandler(event),
  outboundCallAction: (event) => outboundCallActionHandler(event),
};

function send(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | number | boolean> | undefined,
  body: string | undefined,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, String(v)])),
  });
  res.end(body ?? '');
}

function sendError(res: ServerResponse, status: number, code: string, message: string, correlationId: string): void {
  send(
    res,
    status,
    { 'X-Correlation-Id': correlationId },
    JSON.stringify({ error: { code, message }, correlationId }),
  );
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const requestId = randomUUID();
  const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? requestId;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = resolveRoute(req.method ?? 'GET', url.pathname);
    if (!route) {
      sendError(res, 404, 'NOT_FOUND', `No route for ${req.method} ${url.pathname}`, correlationId);
      return;
    }

    let body: string | undefined;
    try {
      body = await readBody(req);
    } catch (e) {
      if ((e as Error).message === 'PAYLOAD_TOO_LARGE') {
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', `Body exceeds ${MAX_BODY_BYTES} bytes`, correlationId);
        return;
      }
      throw e;
    }

    const event = toApiGatewayEvent({
      method: req.method ?? 'GET',
      path: url.pathname,
      headers: req.headers,
      body,
      pathParameters: route.pathParameters,
      requestId,
    });

    const result = await handlers[route.key](event);
    send(res, result.statusCode ?? 200, result.headers, result.body);
  } catch (e) {
    // Handlers map their own domain errors; anything reaching here is an adapter-level fault.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled server error', requestId, error: String(e) }));
    sendError(res, 500, 'INTERNAL_ERROR', 'Unhandled server error', correlationId);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ level: 'info', msg: 'chimeflutter-backend listening', port: PORT, service: 'container' }),
  );
});

// Ring-timeout sweeper — the container equivalent of the Lambda EventBridge schedule. Gated on the
// outbound table being configured so plain (inbound-only) deployments run no timer at all.
if (process.env.OUTBOUND_CALLS_TABLE) {
  setInterval(() => {
    sweepOutboundCallsHandler().catch((e) => {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'error', msg: 'outbound sweep failed', error: String(e) }));
    });
  }, SWEEP_INTERVAL_MS).unref();
}

// Graceful shutdown — ECS/Kubernetes send SIGTERM before killing the task/pod.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Force-exit if in-flight requests hold the server open past the platform grace period.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
