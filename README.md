# ChimeFlutter — Amazon Connect In‑App VoIP / Video calling for Flutter

A production‑oriented, **spec‑driven** and **test‑driven** reference implementation that lets a
mobile customer place a **VoIP audio** or **WebRTC video** call directly into an **Amazon Connect**
contact centre from a native iOS or Android app, using a reusable **Flutter library** that wraps the
**Amazon Chime SDK** for mobile.

The customer's context (who they are, what they were doing, device details) is fetched from the
backend and passed to Amazon Connect as **contact attributes**, so the contact flow can route the
customer to the **right queue / agent**.

```
┌──────────────┐   HTTPS (JWT)   ┌─────────────┐   StartWebRTCContact   ┌──────────────────┐
│ Native iOS / │ ──────────────▶ │ API Gateway │ ─────────────────────▶ │  Amazon Connect  │
│ Android app  │                 │  + Lambda   │  (Attributes = ctx)    │  (routing/queue) │
│              │ ◀────────────── │ (authorizer)│ ◀───────────────────── │                  │
│  Flutter     │  ConnectionData └─────────────┘   Meeting + Attendee   └────────┬─────────┘
│  library     │                                                                  │ WebRTC media
│  (Chime SDK) │ ◀════════════════════ Chime SDK media session ═══════════════════┘
└──────────────┘        audio (VoIP) / video (WebRTC) over Chime media plane
```

## What's in this repo

| Path | Purpose |
|------|---------|
| [`specs/`](./specs) | Spec‑driven development artefacts: requirements, architecture, API contracts, sequences, security, test strategy. **Read these first.** |
| [`backend/`](./backend) | AWS SAM app: API Gateway (HTTP API) + Lambda that calls `connect:StartWebRTCContact` (bring‑your‑own auth). TypeScript, Jest, TDD. |
| [`packages/flutter_amazon_connect_webrtc/`](./packages/flutter_amazon_connect_webrtc) | The reusable **Flutter plugin**. Dart API + iOS (Swift/Chime SDK) + Android (Kotlin/Chime SDK) platform implementations. Unit‑tested. |
| [`packages/flutter_amazon_connect_webrtc/example/`](./packages/flutter_amazon_connect_webrtc/example) | A pure‑Flutter example app that exercises the plugin end‑to‑end. |
| [`packages/react-native-amazon-connect-webrtc/`](./packages/react-native-amazon-connect-webrtc) | The **React Native** sibling library — same backend, same native Chime SDK managers (ported verbatim), CallKit/Telecom, video tiles, DTMF. Zero runtime npm deps; TypeScript strict; unit‑tested; `npm audit` clean. |
| [`native/ios-host/`](./native/ios-host) | A **native SwiftUI** iOS app (XcodeGen + CocoaPods) embedding the library `add‑to‑app`, with **CallKit** so the OS shows a real call. |
| [`native/android-host/`](./native/android-host) | A **native Kotlin** Android app (Gradle) embedding the library `add‑to‑app`, with **Telecom** so the OS shows a real call. |
| [`docs/`](./docs) | **[Getting-started guide](./docs/GETTING_STARTED.md)** (novice-friendly, end-to-end), integration guide, deployment runbook, **publishing guide** ([PUBLISHING.md](./docs/PUBLISHING.md)), sequence diagrams. React Native docs: [getting started](./docs/react-native/GETTING_STARTED.md) · [integration](./docs/react-native/INTEGRATION.md) · [publishing](./docs/react-native/PUBLISHING.md). |

## Design principles

1. **Backend is the source of truth.** The mobile client holds *no* AWS credentials and *no*
   Connect instance IDs / flow IDs. It sends a customer/session context; the Lambda decides the
   `ContactFlowId`, injects server‑trusted attributes, and calls `StartWebRTCContact`.
2. **Least privilege.** The Lambda's execution role may only call `connect:StartWebRTCContact` on a
   single instance ARN. The mobile app authenticates to API Gateway with a short‑lived JWT.
3. **Thin, well‑typed bridge.** The Flutter plugin exposes a small, strongly‑typed Dart API and
   forwards to the native Amazon Chime SDK over a `MethodChannel` (commands) + `EventChannel`
   (state/events). No business logic lives in the bridge.
4. **Spec first, test first.** Every component has a spec in [`specs/`](./specs) and tests written
   before (or alongside) the implementation.

## Quick start

**New to this repo? Start with [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md)** — a
detailed, novice-friendly walk-through from AWS setup to your first call, covering every native
file and config on both platforms. [`docs/INTEGRATION.md`](./docs/INTEGRATION.md) is the shorter
concept guide. In short:

```bash
# 1. Backend
cd backend && npm install && npm test          # run the unit tests (TDD)
sam build && sam deploy --guided                # deploy API Gateway + Lambda

# 2. Flutter plugin
cd packages/flutter_amazon_connect_webrtc
flutter test                                    # run the Dart unit tests
cd example && flutter run                        # run the example app

# 3. Native host apps
#   iOS:     open native/ios-host   (see its README for the add-to-app wiring)
#   Android: open native/android-host in Android Studio
```

## Status / scope

This repository is a **reference implementation and scaffold**. The Dart, Swift, Kotlin and
TypeScript are written to be correct against the published Amazon Chime SDK and Amazon Connect APIs,
with unit tests. The pieces that require real cloud resources (an Amazon Connect instance, signed
JWTs, live Chime media) are covered by contract tests and integration test stubs, and documented in
the deployment runbook. See [`specs/006-test-strategy.md`](./specs/006-test-strategy.md) for exactly
what is unit‑tested, what is contract‑tested, and what requires a live environment.
