# Backend Reference — `chimeflutter-backend`

The control-plane service for both mobile libraries (Flutter + React Native): it is the only
component that talks to Amazon Connect, and the only place AWS credentials, the Connect
**instance ID** and **contact flow ID** exist. TypeScript, ports-and-adapters, 85 Jest tests.

Two interchangeable deployments, same code, same behaviour:

| | A. Serverless (default) | B. Docker container |
|---|---|---|
| Runtime | API Gateway HTTP API + Lambda (SAM) | Node 22 container (`backend/Dockerfile`) |
| Handlers | `src/lambda/*` | **the same `src/lambda/*`**, hosted by `src/server/main.ts` |
| AWS credentials | Lambda execution role | **role-based at runtime** (ECS task role / EKS IRSA / EC2 instance profile) — §7 |
| Throttling/WAF | API Gateway | bring your own edge (ALB/API GW/NGINX) — §6.3 |

---

## 1. Responsibilities

1. **Start a call** — validate the client request, allow-list its context keys, merge
   server-trusted attributes (`source`, `correlationId`, device details), call
   `connect:StartWebRTCContact`, and return the normalised join credentials
   (Chime `Meeting` + `Attendee`, `contactId`, `participantToken`).
2. **End a call** — `connect:StopContact` (best-effort from the client's perspective).
3. **DTMF** — exchange the `participantToken` for a Participant Service connection and send
   `audio/dtmf` messages (WebRTC contacts cannot carry in-band DTMF).
4. **Health** — unauthenticated `GET /health` for probes and smoke tests.

What it deliberately does **not** do: authentication (bring-your-own — §6.2), storing state (it is
fully stateless; every request is self-contained), and anything with PII beyond pass-through
attributes (logs are redacted — §8).

## 2. Architecture

Ports-and-adapters: handlers contain the business rules and depend on narrow ports; entrypoints
wire real AWS SDK clients into those ports; tests wire mocks (`aws-sdk-client-mock`).

```
                    src/lambda/*.ts (wiring only)          src/server/main.ts + adapter.ts
                    Lambda cold-start entrypoints          container HTTP adapter (no framework)
                              │                                        │
                              └───────────────┬────────────────────────┘
                                              ▼
                                   src/handlers/*.ts
                        startCall · endCall · participant · (health)
                     validation ─ allow-listing ─ error envelope ─ logging
                                              │ ports
                          ┌───────────────────┴───────────────────┐
                          ▼                                       ▼
              src/connect/connectClient.ts            src/connect/participantClient.ts
              ConnectPort → StartWebRTCContact,       ParticipantPort → CreateParticipant-
              StopContact (@aws-sdk/client-connect)   Connection, SendMessage (client-connectparticipant)
```

**Request lifecycle (start call):** parse + validate body (`callType`, `device`, optional
`context`/`displayName`) → drop non-allow-listed context keys → build attributes (client keys +
server-trusted keys; client can never overwrite server keys) → `StartWebRTCContact` with the
`Idempotency-Key` header as Connect's `ClientToken` (idempotent for 7 days — retried starts can't
create duplicate contacts) → unwrap `ConnectionData` → return the §3.1 response. Errors map to the
single envelope of §3.5.

## 3. HTTP API

Single source of truth: [specs/003-api-contracts.md](../specs/003-api-contracts.md) (Part A).
Summary with the container-relevant notes:

### 3.1 `POST /v1/calls` — start a call
Headers: `Authorization: Bearer <jwt>` (optional until you add auth), `Idempotency-Key`
(recommended), `X-Correlation-Id` (optional, generated if absent, always echoed back).
Body: `{callType: 'audio'|'video', displayName?, context?, device}` →
**201** `{contactId, participantId, participantToken, callType, meeting{…mediaPlacement…}, attendee{attendeeId, joinToken}}`.

### 3.2 `DELETE /v1/calls/{contactId}` → **204**
See the StopContact ownership caveat in [specs/005-security.md](../specs/005-security.md).

### 3.3 `POST /v1/calls/connections`
`{participantToken}` → **201** `{connectionToken, expiry}`. Participant Service calls are
authorized by the token itself, not IAM.

### 3.4 `POST /v1/calls/dtmf`
`{connectionToken, digits}` (`[0-9*#,]{1,20}`) → **200** `{sent: true}`.

### 3.5 Simulated outbound (agent-initiated) calls — full guide: [OUTBOUND_CALLS.md](./OUTBOUND_CALLS.md)
| Endpoint | Caller | Result |
|---|---|---|
| `POST /v1/devices` | app | Registers `{customerId, platform, pushToken}` → SNS platform endpoint + DynamoDB. |
| `POST /v1/calls/outbound` | agent tooling | Availability-gates the agent (`GetCurrentUserData`), starts a WebRTC contact routed to the **agent queue**, pushes the device → **201** `{callId, contactId, status:'ringing', expiresAt}`. |
| `GET /v1/calls/outbound/{callId}` | agent tooling | Status view (`ringing/answered/declined/timedOut/cancelled`) — never tokens. |
| `POST /v1/calls/outbound/{callId}/answer` | app | **200** full CallSession (same shape as `POST /calls`); **410** when no longer ringing. |
| `POST /v1/calls/outbound/{callId}/decline` | app | **204**; stops the contact, releasing the agent. |

A 1-minute schedule (Lambda) / 60 s timer (container) times out unanswered calls and stops their
contacts. Push credentials live in SNS **platform applications** (APNS_VOIP + FCM) created
out-of-band; the push payload carries only the `callId`, never join credentials.

### 3.6 Error envelope (every non-2xx)
`{"error": {"code", "message"}, "correlationId"}` — codes: `INVALID_CALL_TYPE`,
`INVALID_PLATFORM`, `INVALID_JSON`, `EMPTY_BODY`, `MISSING_CONTACT_ID`, `INVALID_DIGITS`,
`RATE_LIMITED` (429 — retry with the SAME idempotency key), `UPSTREAM_ERROR` (502),
`NOT_FOUND`/`PAYLOAD_TOO_LARGE`/`INTERNAL_ERROR` (container adapter only). Outbound adds:
`INVALID_CUSTOMER_ID`, `INVALID_AGENT_ID`, `INVALID_PUSH_TOKEN`, `AGENT_NOT_AVAILABLE` (409),
`CALL_NO_LONGER_RINGING` (410), `PUSH_FAILED` (502), `PUSH_NOT_CONFIGURED` /
`OUTBOUND_NOT_CONFIGURED` (501).

### Path prefix
API Gateway serves everything under the `v1` **stage** (`https://…/v1/calls`). The container
accepts **both** `/v1/calls` and `/calls` (the adapter strips an optional `/v1`), so mobile
clients need no changes when you point `backendBaseUrl` at a container behind
`https://your-host/v1`.

## 4. Code layout

```
backend/
├── template.yaml               SAM: HTTP API + 4 functions + least-privilege IAM (§6.1)
├── Dockerfile                  container build (multi-stage, non-root, HEALTHCHECK) — §7
├── docker-compose.yml          local container runner (credential notes inline)
├── src/
│   ├── config/env.ts           env loader — the ONLY reader of environment variables (§5)
│   ├── domain/                 logger (structured JSON, redaction), types
│   ├── http/                   API GW event helpers, error envelope, response builders
│   ├── handlers/               business logic: startCall, endCall, participant + outbound:
│   │                           registerDevice, startOutboundCall, outboundCallAction, sweep
│   ├── connect/                AWS adapters: connectClient, participantClient, attributes
│   │                           (allow-listing), capabilities (video), session (unwrap),
│   │                           agentAvailability (GetCurrentUserData gate)
│   ├── store/                  DynamoDB ports: deviceStore, outboundCallStore (conditional
│   │                           ringing→X transitions so answer/decline/sweep race safely)
│   ├── push/                   pushSender — SNS mobile push (APNS_VOIP / FCM), callId-only payloads
│   ├── lambda/                 Lambda entrypoints (wiring only); outbound ones wire lazily so a
│   │                           container without outbound config still boots (routes answer 501)
│   └── server/                 container adapter: adapter.ts (pure request→event translation,
│                               unit-tested), main.ts (node:http server, graceful shutdown,
│                               60 s outbound ring-timeout sweeper)
└── tests/                      127 Jest tests: unit (validation, attributes, redaction, config,
                                envelope, server adapter, push payloads, availability) +
                                integration (handlers with mocked AWS / in-memory stores)
```

## 5. Configuration (environment variables)

| Variable | Required | SAM parameter | Meaning |
|----------|----------|---------------|---------|
| `AWS_REGION` | yes (set by Lambda automatically) | — | Must equal the Connect instance's region. |
| `CONNECT_INSTANCE_ID` | yes | `ConnectInstanceId` | The Connect instance the backend may call. Never sent to clients. |
| `CONNECT_CONTACT_FLOW_ID` | yes | `ConnectContactFlowId` | Published inbound flow that routes on the injected attributes. |
| `ALLOWED_CLIENT_ATTRIBUTE_KEYS` | no | `AllowedClientAttributeKeys` | CSV allow-list of client context keys (default: `issueType, issueSubType, productId, tier, segment, language, preferredAgentId, lastScreen, campaignId`). |
| `LOG_LEVEL` | no (`info`) | `LogLevel` | `debug`/`info`/`warn`/`error`. |
| `PORT` | no (`8080`) | — | **Container only** — listen port. |
| `DEVICES_TABLE` | outbound only | `DevicesTable` (auto) | DynamoDB table for device push registrations. |
| `OUTBOUND_CALLS_TABLE` | outbound only | `OutboundCallsTable` (auto) | DynamoDB table for outbound call records (TTL attribute `ttl`). Also gates the container's sweeper timer. |
| `CONNECT_OUTBOUND_CONTACT_FLOW_ID` | no | `ConnectOutboundContactFlowId` | Flow that routes by `$.Attributes.targetAgentArn` ([import guide](./OUTBOUND_CALLS.md#4-amazon-connect-flow-import-it-yourself--nothing-touches-your-instance-automatically)). Empty ⇒ falls back to the inbound flow. |
| `OUTBOUND_RING_TIMEOUT_SECONDS` | no (`45`) | `OutboundRingTimeoutSeconds` | Ring deadline; clamped 15–120 s. |
| `APNS_VOIP_PLATFORM_APPLICATION_ARN` | iOS outbound | `ApnsVoipPlatformApplicationArn` | SNS APNS_VOIP platform application (holds the APNs `.p8`). |
| `FCM_PLATFORM_APPLICATION_ARN` | Android outbound | `FcmPlatformApplicationArn` | SNS FCM platform application (holds the FCM service-account credentials). |

Config is loaded once at cold start / container start and **fails fast** if a required variable is
missing — a misconfigured container exits immediately rather than serving broken responses.

## 6. Security model

### 6.1 Least-privilege IAM (what the role needs — either deployment)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StartCall",
      "Effect": "Allow",
      "Action": "connect:StartWebRTCContact",
      "Resource": [
        "arn:aws:connect:<region>:<account-id>:instance/<instance-id>",
        "arn:aws:connect:<region>:<account-id>:instance/<instance-id>/contact/*",
        "arn:aws:connect:<region>:<account-id>:instance/<instance-id>/contact-flow/*"
      ]
    },
    {
      "Sid": "EndCall",
      "Effect": "Allow",
      "Action": "connect:StopContact",
      "Resource": [
        "arn:aws:connect:<region>:<account-id>:instance/<instance-id>",
        "arn:aws:connect:<region>:<account-id>:instance/<instance-id>/contact/*"
      ]
    }
  ]
}
```

Notes: the `contact-flow/*` resource on StartWebRTCContact is required (found empirically — its
absence produces `AccessDeniedException`). The Participant Service (DTMF) needs **no IAM** — it is
authorized by the participant/connection token. No `connect:*`, no wildcard resources, ever.

### 6.2 Authentication — bring your own
The API deploys **without** an authorizer so you can front it with your IdP (API Gateway JWT
authorizer, ALB OIDC, WAF, API key). Both mobile libraries already send
`Authorization: Bearer <tokenProvider()>` whenever the app supplies a token — re-attaching auth
requires zero client changes. **Do not run the open API in production** — anyone with the URL can
start contacts into your instance.

### 6.3 Other controls
- **Attribute allow-listing** — only §5's allow-listed keys pass to Connect; server-trusted keys
  (`source`, `correlationId`, device fields) cannot be overwritten by the client.
- **Idempotency** — `Idempotency-Key` → Connect `ClientToken`; duplicate starts return the same
  contact for 7 days.
- **Log redaction** — tokens/join credentials never appear in logs (unit-tested in `redact.test.ts`).
- **Container edge duties** — API Gateway gave you TLS, throttling and request limits for free; a
  container does not. Terminate TLS and rate-limit at your edge (ALB + WAF, API Gateway in HTTP
  proxy mode, or NGINX). The adapter enforces a 1 MiB body cap and runs as a non-root user.
- Known limitation (both deployments): StopContact ownership (IDOR) — documented in
  [specs/005-security.md](../specs/005-security.md).

## 7. Deployment B — Docker (same functionality, role-based AWS access)

### 7.1 How parity is achieved
`src/server/main.ts` is a **dependency-free** `node:http` server that translates each request into
the same `APIGatewayProxyEventV2` the Lambda handlers consume (`src/server/adapter.ts`, pure and
unit-tested) and invokes **the identical handler code** — same validation, same envelope, same
logging, same idempotency. No Express/Fastify: zero new dependencies means zero new
vulnerabilities (`npm audit`: 0).

Route table (adapter ⇄ `template.yaml`): `GET /health`, `POST /calls`,
`DELETE /calls/{contactId}`, `POST /calls/connections`, `POST /calls/dtmf` — each with or without
the `/v1` prefix. Unknown routes get the §3.5 envelope with `NOT_FOUND`.

### 7.2 Build & run

```bash
cd backend
docker build -t chimeflutter-backend .

docker run --rm -p 8080:8080 \
  -e AWS_REGION=eu-west-2 \
  -e CONNECT_INSTANCE_ID=<your-instance-id> \
  -e CONNECT_CONTACT_FLOW_ID=<your-flow-id> \
  chimeflutter-backend

curl http://localhost:8080/v1/health
# {"status":"ok","service":"chimeflutter-backend"}
```

Or `docker compose up` (see `docker-compose.yml` — it wires the env vars and the local-dev
credential options). The image: multi-stage build, `node:22-alpine`, production deps only, runs as
the unprivileged `node` user, ships a `HEALTHCHECK` against `/v1/health`, and handles
`SIGTERM` gracefully (ECS/Kubernetes drain-friendly). Being stateless, it scales horizontally
behind any load balancer with no session affinity.

### 7.3 AWS credentials — ROLE-BASED, never baked in

The image contains **no credentials**. The AWS SDK v3 default provider chain resolves them at
runtime, which on AWS means **the platform's role mechanism**:

| Platform | Mechanism | What you do |
|----------|-----------|-------------|
| **ECS / Fargate** | **Task role** | Create a task role with the §6.1 policy and set it as `taskRoleArn` in the task definition. The SDK picks it up automatically (container credentials endpoint). |
| **EKS** | **IRSA** (IAM Roles for Service Accounts) | Bind the §6.1 policy to a service-account role; annotate the pod's service account (`eks.amazonaws.com/role-arn`). The SDK uses the injected web-identity token. |
| **EC2 / self-managed** | **Instance profile** | Attach the §6.1 policy to the instance role. The SDK reads it from IMDSv2. |
| **Local development only** | shared config / env vars | `AWS_PROFILE` + a read-only `~/.aws` mount, or short-lived `aws sts assume-role` / SSO env vars (see `docker-compose.yml`). |

Example ECS task-definition fragment:

```json
{
  "family": "chimeflutter-backend",
  "taskRoleArn": "arn:aws:iam::<account-id>:role/chimeflutter-backend-task-role",
  "executionRoleArn": "arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
  "containerDefinitions": [{
    "name": "backend",
    "image": "<account-id>.dkr.ecr.<region>.amazonaws.com/chimeflutter-backend:1.0.0",
    "portMappings": [{ "containerPort": 8080 }],
    "environment": [
      { "name": "AWS_REGION", "value": "<region>" },
      { "name": "CONNECT_INSTANCE_ID", "value": "<instance-id>" },
      { "name": "CONNECT_CONTACT_FLOW_ID", "value": "<flow-id>" }
    ]
  }]
}
```

(`taskRoleArn` = what the *code* may do — the §6.1 policy. `executionRoleArn` = what *ECS* may do —
pull the image, write logs. Keep them separate.)

**Never** pass `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` to a production container — long-lived
keys in task definitions/compose files are the exact anti-pattern roles exist to prevent.

## 8. Observability

Structured JSON logs (one object per line) with `level`, `msg`, `correlationId` and event-specific
fields; secrets and join tokens are redacted before logging. Every response carries
`X-Correlation-Id` (echoed from the request or generated), and the same id is injected into the
Connect contact attributes — one id traces app → backend → contact flow. Lambda: CloudWatch Logs.
Container: stdout/stderr — collect with your platform's log driver (awslogs/fluent-bit).

## 9. Testing

```bash
cd backend
npm ci
npm test          # 85 tests: unit + handler integration (mocked AWS) + server adapter
npm run build     # tsc → dist/ (used by both `npm start` and the Docker image)
```

Live smoke test (against either deployment):

```bash
BASE=https://<api-or-host>/v1
curl $BASE/health
curl -X POST $BASE/calls -H 'Content-Type: application/json' \
  -d '{"callType":"audio","device":{"platform":"iOS","osVersion":"17","appVersion":"1","deviceModel":"x","locale":"en","networkType":"wifi"},"context":{"issueType":"billing"}}'
# expect 201 with meeting+attendee (then DELETE /calls/{contactId} to clean up)
```
