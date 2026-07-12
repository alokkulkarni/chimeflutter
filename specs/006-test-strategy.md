# 006 — Test Strategy (TDD)

**Related:** [001-requirements](./001-requirements.md) · [003-api-contracts](./003-api-contracts.md)

This project is built **test‑first**. Each acceptance scenario in
[001-requirements §6](./001-requirements.md#6--user-stories--acceptance-criteria-drive-the-tests)
maps to one or more automated tests. This document defines the test pyramid, what runs where, and
the traceability matrix.

## 1. Test pyramid

```
        ┌───────────────────────────────┐
        │  E2E (manual + smoke)         │   live Connect instance, real device, real JWT
        ├───────────────────────────────┤
        │  Contract tests               │   API shape ↔ Chime SDK shape adapters, OpenAPI
        ├───────────────────────────────┤
        │  Integration (mocked AWS)     │   Lambda handler ⇄ mocked ConnectClient
        ├───────────────────────────────┤
        │  Unit (pure domain)           │   attribute merge, capability map, adapters, Dart models
        └───────────────────────────────┘
```

Most value and volume sit in the two bottom layers, which run with **no cloud** and **no device**.

## 2. What is tested where

| Layer | Tooling | Runs in CI without cloud? | Covers |
|-------|---------|---------------------------|--------|
| Backend unit | Jest + ts‑jest | ✅ | attribute merge, capability mapping, error mapping, session normaliser, JWT claim extraction |
| Backend integration | Jest + `aws-sdk-client-mock` | ✅ | handler behaviour with a mocked `ConnectClient` (asserts the exact `StartWebRTCContact` input & the HTTP response) |
| Backend authorizer | Jest + local JWKS/`jose` | ✅ | signature/`iss`/`aud`/`exp` validation, allow/deny policy |
| Flutter Dart unit | `flutter test` + `mocktail` | ✅ (needs Flutter SDK) | models (JSON round‑trip), `CallController` state machine, backend client, MethodChannel mocking |
| iOS bridge unit | XCTest | ⚠️ needs Xcode | `CallSession → MeetingSessionConfiguration` adapter, channel arg parsing |
| Android bridge unit | JUnit + Robolectric | ⚠️ needs Android SDK | same adapter on Android |
| Contract | Jest snapshot of OpenAPI + adapter golden files | ✅ | the JSON contract between backend and the SDK shapes stays stable |
| E2E smoke | manual checklist + optional Maestro/XCUITest | ❌ needs live env | join a real call, hear audio, see video, land in the right queue |

> **Environment note.** This dev environment has `node`, `npm`, `python`, `aws-cli`, `sam`, `java` —
> so the **backend** Jest suite runs here. It does **not** have the Flutter/Dart SDK, Xcode, or the
> Android SDK, so those suites are authored test‑first but executed in their respective CI runners
> (documented in [`docs/CI.md`](../docs/CI.md)).

## 3. Traceability matrix

| Requirement | Scenario | Test(s) |
|-------------|----------|---------|
| FR‑B1, FR‑B2 | US‑1 “Context drives the queue” | `backend/tests/unit/attributes.test.ts`, `backend/tests/integration/startCall.handler.test.ts` |
| FR‑B2 / NFR‑2 | US‑1 “Untrusted client identity overridden” | `backend/tests/unit/attributes.test.ts` |
| FR‑B3 | US‑2 “Video capabilities requested” | `backend/tests/unit/capabilities.test.ts` |
| FR‑B4 | US‑1 | `backend/tests/unit/session.test.ts` (normaliser hides InstanceId/FlowId) |
| FR‑B5 | US‑4 “Connect throttles” | `backend/tests/unit/errors.test.ts`, integration test |
| FR‑B6 | US‑5 “Idempotent retry” | `backend/tests/integration/idempotency.test.ts` |
| FR‑B7 | US‑6 “Customer hangs up” | `backend/tests/integration/endCall.handler.test.ts` |
| FR‑B8, FR‑B9 | US‑3 “Auth enforced” | `backend/tests/unit/authorizer.test.ts` |
| FR‑B10 / NFR‑1 | logging redaction | `backend/tests/unit/redact.test.ts` |
| FR‑F1, FR‑F3 | US‑1 join → connected | `packages/.../test/call_controller_test.dart` |
| FR‑F6 | US‑4 “Mic permission denied” | `packages/.../test/permissions_test.dart` |
| FR‑F7 | token provider / no creds | `packages/.../test/backend_client_test.dart` |
| FR‑N1, FR‑N2 | adapter | `ios/.../AdapterTests`, `android/.../AdapterTest` |

## 4. Test naming & structure

- Arrange‑Act‑Assert, one behaviour per test.
- Test file lives next to the traceability id; the `describe`/`group` string names the requirement.
- No network, no clock, no randomness in unit tests: inject `clock`, `idGenerator`, `connectClient`.

## 5. Definition of done (per component)

1. Spec updated in `specs/`.
2. Failing test written (red).
3. Minimal implementation (green).
4. Refactor with tests green.
5. `npm test` (backend) / `flutter test` (plugin) pass; lint clean.
6. Traceability matrix row exists.
