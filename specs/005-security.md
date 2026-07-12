# 005 — Security & Privacy

> **Status note (2026-07-11):** the JWT/Cognito authorizer described in §2 was REMOVED from the
> shipped backend — auth is now bring-your-own (see docs/PUBLISHING.md §B.6 and docs/DEPLOYMENT.md §2).
> §2 remains as the reference design for re-attaching an authorizer.

**Related:** [001-requirements](./001-requirements.md) · [002-architecture](./002-architecture.md) · [003-api-contracts](./003-api-contracts.md)

## 1. Trust boundaries

```
 Device (untrusted) ──JWT──▶ API Gateway ──▶ Authorizer ──▶ Lambda ──IAM role──▶ Amazon Connect
   holds: JWT only            TLS 1.2+        verifies JWT    trusted            least privilege
   NOT: AWS creds, InstanceId, ContactFlowId, routing policy
```

The device is treated as fully untrusted. Everything security-relevant (which instance, which flow,
which attributes are trustworthy, which queue) is decided server-side.

## 2. Authentication & authorization

- **Transport:** HTTPS/TLS 1.2+ end to end; HSTS on API responses.
- **AuthN:** every protected route requires `Authorization: Bearer <JWT>`. The **Lambda authorizer**
  verifies the signature against the issuer JWKS and validates `iss`, `aud`, `exp` (5 s skew).
- **Trusted identity:** `customerId = token.sub`. A curated set of token claims (`tier`, `segment`,
  `language`, `preferredAgentId`, `entitlement`) are forwarded to Connect. **These always override
  any client-supplied value of the same key** (NFR-2) — a client cannot spoof its identity or tier.
- **Client context allow-list:** only keys in `ALLOWED_CLIENT_ATTRIBUTE_KEYS` pass through; everything
  else is dropped, so the client cannot inject arbitrary attributes (e.g. to jump a priority queue).

### 2.1 401 vs 403 (reconciliation of FR-B8)
FR-B8 states "unauthorised ⇒ 401". An HTTP API **simple-response** Lambda authorizer denies with
**403** by default; a hard failure/throw yields 500. We deliberately return `{ isAuthorized: false }`
(clean 403) rather than throwing. To present **401** to clients, map it at the edge with an API
Gateway **GatewayResponse** (`ACCESS_DENIED` → 401) or a custom domain/CDN rule. **Decision:** treat
401/403 as equivalent "unauthenticated" for the client; the Dart `BackendClient` maps both to
`AuthException`. The requirement text in FR-B8 is satisfied by "reject with 401 **or** 403".

## 3. Least privilege (IAM)

The call functions' execution roles grant only:
- `connect:StartWebRTCContact` (start) / `connect:StopContact` (end)
- Resource-scoped to a single instance ARN and its contacts:
  `arn:aws:connect:<region>:<account-id>:instance/<instance-id>` and `…/contact/*`.

No `connect:*`, no wildcard resources. The authorizer role only invokes the authorizer function.

## 4. Known limitation — StopContact ownership (IDOR)  ⚠️

`DELETE /v1/calls/{contactId}` currently stops **any** contactId a valid token can name; it does not
verify the caller *owns* that contact. This is an **Insecure Direct Object Reference** (CWE-639).

**Impact:** an authenticated customer could stop another customer's contact if they can guess/observe
a contactId (contactIds are UUID-like, so not trivially enumerable, but this is defence-in-depth).

**Recommended mitigation (v1.1):** at start time, persist `{ contactId → customerId, ttl }` in a
DynamoDB table; at stop time, load the record and 403 unless `record.customerId == token.sub`. The
code is structured to accept this: `endCall` would gain an injected `SessionStore` port checked before
`connect.stopContact`. Until then this is documented and accepted, because a customer stopping only
their own visible call is the realistic path, and the agent/flow can also end the contact.

## 5. PII & logging (FR-B10)

- Structured JSON logs run through `redact()` — masks keys (`name`, `email`, `phone`, `token`,
  `joinToken`, `participantToken`, `authorization`, …) and scrubs email/phone patterns in free text.
- The `CallSession` returned to the client contains no server internals; error envelopes expose only
  `{ code, message }` (never the AWS cause or stack).
- `participantToken`, `joinToken` and the JWT are secrets: never logged, never persisted client-side
  beyond the live call, transmitted only over TLS.
- Contact attributes may carry limited PII (e.g. `displayName` is sent to Connect as `DisplayName`);
  keep the allow-list free of sensitive keys and prefer opaque ids (`customerId`) over names.

## 6. Mobile-side hardening

- No AWS SDK or credentials embedded in the app.
- JWT held in memory / secure storage by the host; the plugin never persists it.
- Certificate pinning to the API domain is recommended for the host app (out of scope for the plugin).
- Runtime permissions (mic/camera) requested with rationale; denial fails the call cleanly.

## 7. Threat-model quick table

| Threat | Control |
|--------|---------|
| Stolen device JWT | Short token TTL; TLS; least-privilege backend; no creds on device. |
| Client spoofs identity/tier for better queue | Server-trusted claims override client values; attribute allow-list. |
| Attribute injection to skip queue | Allow-list + key sanitisation (alphanumeric/`-`/`_` only). |
| Replay / double-dial | `ClientToken` idempotency (7-day window). |
| Cross-customer contact teardown | ⚠️ §4 IDOR — mitigation designed, accepted for v1. |
| Log leakage of PII/secrets | `redact()` on every log line; secrets never logged. |
| Enumeration of Connect config | InstanceId/FlowId never leave the backend. |
