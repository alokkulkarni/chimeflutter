# Deployment Runbook

Deploys the backend and prepares the Amazon Connect instance so mobile clients can place WebRTC calls.

Target instance (fill in your own — see the Connect console → instance overview):
- Region `<region>`, account `<account-id>`
- Instance `<connect-instance-id>`
  (ARN `arn:aws:connect:<region>:<account-id>:instance/<connect-instance-id>`)

## 1. Prepare Amazon Connect

1. **Enable in-app, web & video calling** on the instance (Connect console → *Communication widgets*;
   AWS guide: `inapp-calling.html` → *config-com-widget2.html* for the native/API path). Native mobile
   calls the `StartWebRTCContact` API directly — you do **not** need to embed the web widget.
2. **Contact flow** — create/publish a **standard inbound** contact flow (there is *no* special
   "WebRTC" flow type). It should read the injected attributes and route:
   ```
   Entry → Check contact attributes ($.Attributes.issueType)
        ├─ "billing"  → Set working queue → Billing
        ├─ "tech"     → Set working queue → Technical
        └─ default    → Set working queue → General
   Check contact attributes ($.Attributes.tier == "gold") → Set working queue → Priority
   Transfer to queue
   ```
   Copy its **ContactFlowId** (flow page → *Show additional flow information*).
3. **Agents** — grant the security profile *CCP* and, for video, *Video calls - Access*.

## 2. Authentication — bring your own (API deploys open)

The API deploys **without** an authorizer so you can integrate your own identity provider. The
mobile library sends `Authorization: Bearer <tokenProvider()>` whenever the app's `tokenProvider`
returns a token, so re-attaching an API Gateway JWT/Lambda authorizer for your IdP later requires
**zero client changes**. Alternatives: an API key or WAF at the edge.

> ⚠️ Do NOT run the open API in production — anyone with the URL could start contacts into your
> Connect instance. See docs/PUBLISHING.md §B.6.

(Optional demo tooling: `scripts/setup-cognito.sh` can create/delete a Cognito user pool if you want
JWT auth for testing; re-add the authorizer to `template.yaml` to use it.)

## 3. Build & deploy the backend

```bash
cd backend
npm ci
npm test                                   # gate: all tests must pass
export PATH="$PWD/node_modules/.bin:$PATH" # so SAM's esbuild builder finds esbuild
sam build
sam deploy --guided \
  --stack-name chimeflutter-backend \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ConnectInstanceId=<your-connect-instance-id> \
    ConnectContactFlowId=<flow-id> \
    LogLevel=info
```

Outputs: `ApiBaseUrl` (→ mobile `backendBaseUrl`) and `StartCallEndpoint`.

### What gets created
- HTTP API (stage `v1`) — **no authorizer** (bring your own, §2).
- `StartCallFunction` (`POST /v1/calls`) — IAM allows only `connect:StartWebRTCContact` on the
  instance ARN + `…/contact/*`.
- `EndCallFunction` (`DELETE /v1/calls/{contactId}`) — only `connect:StopContact`.
- `HealthFunction` (`GET /v1/health`) — public.
- Access logs to CloudWatch.

## 4. Region / account note

The Lambda role ARNs are built from `AWS::Region`/`AWS::AccountId`, so deploy the stack **in the same
region and account as the Connect instance**. Cross-region will produce
an IAM resource that does not match the instance and `StartWebRTCContact` will be denied.

## 5. Smoke test

```bash
BASE=https://<apiId>.execute-api.eu-west-2.amazonaws.com/v1

# Public health (no auth)
curl -s "$BASE/health"                       # {"status":"ok",...}

# Start a call (no auth by default — add your Authorization header if you front the API with auth)
curl -s -X POST "$BASE/calls" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"callType":"audio","device":{"platform":"iOS","appVersion":"4.2.0"},"context":{"issueType":"billing","tier":"gold"}}'
# → 201 with { contactId, meeting, attendee, ... }
```

Then run the example app against `$BASE`, place a call, and confirm the agent receives it in the
expected queue.

## 6. Rollback

`sam delete --stack-name chimeflutter-backend`. The Connect instance/flow are unaffected (managed
separately). No data stores are created by this stack.

## 7. Operational notes

- **Logs**: structured JSON in CloudWatch; PII redacted. Filter by `correlationId`.
- **Throttling**: `StartWebRTCContact` throttling surfaces as `429 RATE_LIMITED`; clients retry with
  the same `Idempotency-Key`.
- **Known limitation**: `DELETE /calls/{contactId}` does not verify contact ownership — see
  [specs/005-security §4](../specs/005-security.md).
