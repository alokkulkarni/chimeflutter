# ChimeFlutter backend

API Gateway (HTTP API) + Lambda that starts Amazon Connect WebRTC contacts for the mobile client,
TypeScript, AWS SAM, Jest (TDD). Ships without an authorizer — bring your own auth (docs/PUBLISHING.md §B.6).

## Layout

```
src/
  config/env.ts          # env loader (InstanceId/FlowId live here, server-side only)
  domain/                # pure, cloud-free logic
    redact.ts            #   PII redaction for logs
    logger.ts            #   structured JSON logger
  connect/               # Amazon Connect adapter + domain
    capabilities.ts      #   callType → AllowedCapabilities
    attributes.ts        #   trusted ⟩ client ⟩ device attribute merge (NFR-2)
    session.ts           #   StartWebRTCContact response → CallSession (FR-B4)
    connectClient.ts     #   ConnectClient port (StartWebRTCContact / StopContact)
  http/                  # thin framework layer (parse, respond, errors, event helpers)
  handlers/              # startCall / endCall (factories, DI)
  lambda/                # deployment entrypoints (wire env → handlers)
tests/
  unit/                  # pure-logic tests
  integration/           # handler ⇄ mocked ConnectClient (aws-sdk-client-mock)
```

## Commands

```bash
npm ci
npm test            # 68 tests
npm run test:cov    # with coverage
npm run typecheck
sam validate --lint
PATH="$PWD/node_modules/.bin:$PATH" sam build     # esbuild bundles the TS entrypoints
```

## Deploy

See [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md). Parameters: `ConnectInstanceId`,
`ConnectContactFlowId`, `JwtIssuer`, `JwtAudience`, `JwtJwksUri`, `AllowedClientAttributeKeys`.

## Design notes

- **Ports & adapters** — handlers depend on a `ConnectPort` interface, so the exact
  `StartWebRTCContact` command is asserted with a mocked `ConnectClient`.
- **No secrets to the client** — `CallSession` is normalised camelCase with no InstanceId/FlowId.
- **Idempotency** — the client `Idempotency-Key` becomes the Connect `ClientToken` (7-day window).
- **Least privilege** — IAM scopes `connect:StartWebRTCContact`/`StopContact` to one instance ARN.
