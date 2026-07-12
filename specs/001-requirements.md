# 001 — Requirements Specification

**Project:** ChimeFlutter — Amazon Connect in‑app VoIP/Video calling for Flutter
**Status:** Baseline
**Owner:** Mobile Platform + Contact Centre Engineering
**Related:** [002-architecture](./002-architecture.md) · [003-api-contracts](./003-api-contracts.md) · [004-sequence-diagrams](./004-sequence-diagrams.md) · [005-security](./005-security.md) · [006-test-strategy](./006-test-strategy.md)

---

## 1. Purpose & vision

Provide a reusable **Flutter library** that a native iOS or Android application can embed to let a
customer place a **voice (VoIP)** or **video (WebRTC)** call directly into an **Amazon Connect**
contact centre — without a PSTN phone number — using the **Amazon Chime SDK** for the media plane.

The customer never talks to AWS directly. A **backend** (AWS Lambda behind API Gateway) authenticates
the request, enriches it with server‑trusted customer/session context, and calls the Amazon Connect
`StartWebRTCContact` API. Connect returns the media‑session credentials (a Chime meeting + attendee),
which the app uses to join the call. The context attributes drive Connect's **contact flow** so the
customer lands in the **correct queue**.

## 2. Actors

| Actor | Description |
|-------|-------------|
| **Customer** | End user of the native mobile app who initiates the call. |
| **Native host app** | The existing iOS/Android app that embeds the Flutter library. |
| **Flutter library** | `flutter_amazon_connect_webrtc` — the reusable package under test. |
| **Backend API** | API Gateway + Lambda (`start-call`, `end-call`, authorizer). |
| **Amazon Connect** | Contact centre; routes the WebRTC contact to a queue/agent. |
| **Agent** | Human contact‑centre agent who answers in the CCP / agent workspace. |

## 3. Glossary

- **WebRTC contact** — an Amazon Connect contact created by `StartWebRTCContact`, carried over the
  Chime media plane rather than the PSTN.
- **ConnectionData** — the payload returned by `StartWebRTCContact` containing the Chime `Meeting`
  and `Attendee` the client needs to join.
- **Contact attributes** — key/value metadata attached to a Connect contact; readable in the contact
  flow to drive routing.
- **Meeting session** — the Amazon Chime SDK object that owns the audio/video connection.

---

## 4. Functional requirements (EARS)

EARS = Easy Approach to Requirements Syntax (`WHEN <trigger>, the <system> SHALL <response>`).

### 4.1 Backend — start a call

- **FR‑B1** — WHEN the backend receives an authenticated `POST /v1/calls` request containing a valid
  customer/session context, the **backend** SHALL call `connect:StartWebRTCContact` against the
  configured Connect instance and contact flow.
- **FR‑B2** — The **backend** SHALL merge three attribute sources into the Connect contact
  attributes, with server‑trusted values winning: (a) server‑derived identity claims from the JWT,
  (b) a curated allow‑list of client‑supplied context, (c) device details. See
  [003-api-contracts §Attributes](./003-api-contracts.md).
- **FR‑B3** — The **backend** SHALL set `AllowedCapabilities` from the requested `callType`
  (`audio` ⇒ audio send/receive only; `video` ⇒ audio + video send/receive).
- **FR‑B4** — The **backend** SHALL return to the client a normalised `CallSession` payload that
  contains exactly what the Chime SDK needs to join (meeting + attendee), plus the `ContactId` and
  `ParticipantToken`. It SHALL NOT leak the Connect `InstanceId`, `ContactFlowId`, or any AWS
  credential.
- **FR‑B5** — WHEN `StartWebRTCContact` returns a throttling or service error, the **backend** SHALL
  map it to a stable HTTP status (429/5xx) and a machine‑readable error code, and SHALL NOT expose
  raw AWS error internals to the client.
- **FR‑B6** — The **backend** SHALL be idempotent per client‑supplied `Idempotency-Key` /
  `ClientToken` so a retried request does not create a duplicate contact.
- **FR‑B7** — WHEN the backend receives an authenticated `DELETE /v1/calls/{contactId}` request, the
  **backend** SHALL call `connect:StopContact` to end the contact server‑side.

### 4.2 Backend — security & auth

- **FR‑B8** — The **backend** SHALL reject any request to a protected route that does not present a
  valid, unexpired JWT bearer token (via the Lambda authorizer). Unauthorised ⇒ `401`.
- **FR‑B9** — The **authorizer** SHALL verify the token signature against the configured issuer's
  JWKS, and SHALL validate `iss`, `aud`, and `exp`.
- **FR‑B10** — The **backend** SHALL emit structured logs that **redact** PII (name, phone, email,
  tokens) — see [005-security](./005-security.md).

### 4.3 Flutter library — Dart API

- **FR‑F1** — The library SHALL expose an idempotent `startCall(CallRequest)` that (1) calls the
  backend to obtain a `CallSession`, then (2) joins the Chime meeting on the native side.
- **FR‑F2** — The library SHALL expose `endCall()`, `mute()/unmute()`, `switchCamera()`,
  `enableLocalVideo()/disableLocalVideo()`, `setSpeakerphone(bool)`.
- **FR‑F3** — The library SHALL expose a `Stream<CallState>` reflecting the lifecycle:
  `idle → connecting → ringing → connected → reconnecting → disconnected → failed`.
- **FR‑F4** — The library SHALL expose a `Stream<CallEvent>` for discrete events (remote participant
  joined/left, audio route changed, network‑quality changed, error).
- **FR‑F5** — For a **video** call the library SHALL expose bindable video tiles (local + remote) that
  the host renders via a `Texture`/platform view.
- **FR‑F6** — The library SHALL request and verify microphone (and, for video, camera) runtime
  permissions before starting media, and SHALL surface a typed `permissionDenied` failure.
- **FR‑F7** — The library SHALL accept a caller‑provided `backendBaseUrl` and a `tokenProvider`
  callback (so the host owns auth), and SHALL NOT bundle any AWS credentials or endpoints.
- **FR‑F8** — WHEN the media session drops, the library SHALL emit `reconnecting`, attempt the Chime
  SDK reconnection, and transition to `connected` or `failed` accordingly.

### 4.4 Native bridge

- **FR‑N1** — The **iOS** implementation SHALL adapt the backend `CallSession` into a Chime
  `MeetingSessionConfiguration` and drive `AudioVideoFacade`.
- **FR‑N2** — The **Android** implementation SHALL adapt the backend `CallSession` into a Chime
  `MeetingSessionConfiguration` and drive `AudioVideoFacade`.
- **FR‑N3** — Both platforms SHALL forward Chime realtime/audio‑video observer callbacks to Dart as
  `CallState`/`CallEvent` messages over the `EventChannel`.

### 4.5 Host apps

- **FR‑H1** — A native **iOS** app SHALL embed the library via Flutter *add‑to‑app* and present the
  call UI from a native screen, passing customer context it holds.
- **FR‑H2** — A native **Android** app SHALL embed the library via Flutter *add‑to‑app* and present
  the call UI from a native screen, passing customer context it holds.
- **FR‑H3** — Host apps SHALL obtain the JWT from their own identity backend and hand it to the
  library's `tokenProvider`.

---

## 5. Non‑functional requirements

| ID | Category | Requirement |
|----|----------|-------------|
| NFR‑1 | Security | No AWS credentials, InstanceId or ContactFlowId on the device. TLS 1.2+ everywhere. JWT‑gated API. PII redacted in logs. |
| NFR‑2 | Privacy | Client‑supplied attributes pass through a server allow‑list; server identity claims always win over client‑claimed identity. |
| NFR‑3 | Reliability | Start‑call is idempotent (ClientToken). Media session auto‑reconnects. Backend maps AWS errors to stable codes. |
| NFR‑4 | Performance | P95 backend `start-call` latency < 800 ms (excluding cold start). Time‑to‑audio < 3 s on 4G. |
| NFR‑5 | Portability | Flutter library works as a standalone Flutter app **and** as an add‑to‑app module on iOS 15+ / Android 8.0 (API 26)+. |
| NFR‑6 | Observability | Correlation id propagated client→API→Connect (`References`/attribute). Structured JSON logs. |
| NFR‑7 | Testability | Pure domain logic separated from AWS SDK & platform channels so it is unit‑testable without cloud. |
| NFR‑8 | Accessibility | Call UI in the example app is screen‑reader labelled and honours OS audio‑route changes. |

---

## 6. User stories & acceptance criteria (drive the tests)

> Each `Scenario` below is the source for a unit/contract test in [006-test-strategy](./006-test-strategy.md).

### US‑1 — Customer starts an audio call routed by context
> *As a customer in the mobile app, I tap "Call support" so I reach the queue for my issue.*

```gherkin
Feature: Start an audio (VoIP) call

  Scenario: Context drives the queue
    Given an authenticated customer with context { issueType: "billing", tier: "gold" }
    And the device reports { platform: "iOS", appVersion: "4.2.0" }
    When the app requests a call of type "audio"
    Then the backend calls StartWebRTCContact with Attributes containing
         issueType="billing", tier="gold", devicePlatform="iOS", appVersion="4.2.0"
    And AllowedCapabilities grants audio send and receive only
    And the client receives a CallSession with a meeting and attendee
    And the Chime meeting is joined and CallState becomes "connected"

  Scenario: Untrusted client identity is overridden by the token
    Given an authenticated customer whose JWT sub is "cust-123"
    And the client context also claims customerId "cust-999"
    When the app requests a call
    Then the Attributes sent to Connect contain customerId="cust-123"
```

### US‑2 — Customer starts a video call
```gherkin
Feature: Start a video (WebRTC) call

  Scenario: Video capabilities requested
    Given an authenticated customer
    When the app requests a call of type "video"
    Then AllowedCapabilities grants audio and video send and receive
    And after connect the local video tile is available
    And when a remote participant enables video a remote tile event is emitted
```

### US‑3 — Auth is enforced
```gherkin
Feature: API is protected

  Scenario: Missing token is rejected
    Given a request to POST /v1/calls with no Authorization header
    Then the API responds 401 and StartWebRTCContact is never called

  Scenario: Expired token is rejected
    Given a request with an expired JWT
    Then the authorizer denies the request and the API responds 401
```

### US‑4 — Errors are handled gracefully
```gherkin
Feature: Graceful degradation

  Scenario: Connect throttles the backend
    Given StartWebRTCContact raises a ThrottlingException
    Then the backend responds 429 with code "RATE_LIMITED"
    And no meeting is returned to the client

  Scenario: Microphone permission denied on device
    Given the customer denies the microphone permission
    When startCall runs
    Then CallState becomes "failed" with reason "permissionDenied"
    And StartWebRTCContact is not called
```

### US‑5 — Idempotent retry
```gherkin
Feature: Idempotent start

  Scenario: Same idempotency key does not double-dial
    Given a start-call request with Idempotency-Key "k-1"
    When the same request is retried with Idempotency-Key "k-1"
    Then only one Connect contact is created
```

### US‑6 — End call
```gherkin
Feature: End call

  Scenario: Customer hangs up
    Given a connected call with contactId "c-1"
    When the customer taps end
    Then the native media session is stopped
    And the backend calls StopContact for "c-1"
    And CallState becomes "disconnected"
```

---

## 7. Out of scope (v1)

- Screen sharing and content share (Chime supports it; not wired in v1).
- Chat / messaging channels (this is voice/video only).
- Agent‑side experience (uses the standard Connect agent workspace / CCP).
- Call recording configuration (done in Connect, not the client).
- Push‑notification “incoming call” (outbound‑from‑customer only in v1).

## 8. Assumptions & decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D‑1 | Backend in **TypeScript** on Node.js 20 Lambda, packaged with **AWS SAM**. | `sam` + `node` available in CI; AWS SDK v3 is well‑typed and unit‑testable. |
| D‑2 | Auth via **JWT bearer** validated by a **Lambda authorizer** (JWKS). Cognito is the recommended issuer but any OIDC issuer works. | Keeps the sample self‑contained and issuer‑agnostic; mobile‑standard. |
| D‑3 | Flutter plugin uses **MethodChannel (commands) + EventChannel (state/events)** wrapping the native Amazon Chime SDK. | No official Chime Flutter SDK exists; a thin typed bridge is the least‑surprise approach. |
| D‑4 | Host apps embed the library via **Flutter add‑to‑app**. | The requirement is “integrated into native iOS/Android apps”. |
| D‑5 | The example app talks to the **real** backend contract via an injectable HTTP client, mocked in tests. | Enables TDD without a live Connect instance. |

These decisions are revisited in [002-architecture](./002-architecture.md).
