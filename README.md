# ChimeFlutter — Amazon Connect In‑App VoIP / Video calling for Flutter & React Native

A production‑oriented, **spec‑driven** and **test‑driven** implementation that lets a mobile
customer place a **VoIP audio** or **WebRTC video** call directly into an **Amazon Connect**
contact centre — from a Flutter app, a React Native app, or an **existing native iOS/Android app**
— using reusable mobile libraries that wrap the **Amazon Chime SDK**, with **CallKit** (iOS) and
**Telecom** (Android) so the OS treats it as a real phone call, "like WhatsApp".

The customer's context (who they are, what they were doing, device details) is passed to Amazon
Connect as **contact attributes**, so the contact flow routes the customer to the **right queue /
agent**. An in‑call **DTMF keypad** drives IVR menus via the Connect Participant Service.

```
┌──────────────┐  HTTPS (Bearer     ┌─────────────┐   StartWebRTCContact   ┌──────────────────┐
│ iOS / Android│   optional — bring │ API Gateway │ ─────────────────────▶ │  Amazon Connect  │
│ app          │   your own auth)   │  + Lambda   │  (Attributes = ctx)    │  (routing/queue) │
│              │ ─────────────────▶ │             │ ◀───────────────────── │                  │
│ Flutter / RN │ ◀───────────────── └─────────────┘   Meeting + Attendee   └────────┬─────────┘
│ library      │                                                                    │ WebRTC media
│ (Chime SDK)  │ ◀════════════════════ Chime SDK media session ═════════════════════┘
└──────────────┘        audio (VoIP) / video (WebRTC) over the Chime media plane
```

## What's in this repo

| Path | Purpose |
|------|---------|
| [`specs/`](./specs) | Spec‑driven development artefacts: requirements, architecture, **API & channel contracts** (the single source of truth shared by every codebase), sequences, security, test strategy. |
| [`backend/`](./backend) | AWS SAM app: API Gateway (HTTP API) + Lambdas — start/end call (`StartWebRTCContact`/`StopContact`), participant connection + **DTMF**, health. Least‑privilege IAM, attribute allow‑listing, bring‑your‑own auth. TypeScript, 79 Jest tests. |
| [`packages/flutter_amazon_connect_webrtc/`](./packages/flutter_amazon_connect_webrtc) | The **Flutter plugin**. Dart API + iOS (Swift/Chime SDK/CallKit) + Android (Kotlin/Chime SDK/Telecom) implementations. 34 Dart tests. |
| [`packages/flutter_amazon_connect_webrtc/example/`](./packages/flutter_amazon_connect_webrtc/example) | A pure‑Flutter example app that exercises the plugin end‑to‑end. |
| [`packages/react-native-amazon-connect-webrtc/`](./packages/react-native-amazon-connect-webrtc) | The **React Native library** — same backend, same contract, native managers ported verbatim from the device‑verified Flutter plugin. Prebuilt call screen, brownfield (existing‑native‑app) embedding, zero runtime npm deps, 26 Jest tests, `npm audit` clean. |
| [`native/flutter_call_module/`](./native/flutter_call_module) | The Flutter **add‑to‑app module**: complete call UI (chooser or auto‑dial via `enabledCallTypes`, DTMF keypad, video tiles) + the host platform‑channel bridge. |
| [`native/ios-host/`](./native/ios-host) | A **native SwiftUI** iOS app embedding the Flutter module add‑to‑app, with CallKit, green return‑to‑call bar, sheet‑minimize. |
| [`native/android-host/`](./native/android-host) | A **native Kotlin** Android app embedding the module as **AARs**, with Telecom, return‑to‑call banner, back‑gesture minimize. |
| [`docs/`](./docs) | Guides. Flutter: [getting started](./docs/GETTING_STARTED.md) · [integration](./docs/INTEGRATION.md) · [publishing](./docs/PUBLISHING.md). React Native: [getting started](./docs/react-native/GETTING_STARTED.md) · [integration](./docs/react-native/INTEGRATION.md) · [publishing](./docs/react-native/PUBLISHING.md). Plus the [deployment runbook](./docs/DEPLOYMENT.md), [system call UI](./docs/SYSTEM_CALL_UI.md) and an importable [Connect flow](./docs/connect). |

## Design principles

1. **Backend is the source of truth.** The mobile client holds *no* AWS credentials and *no*
   Connect instance/flow IDs. It sends customer context; the Lambda allow‑lists the attributes,
   injects server‑trusted ones, and calls `StartWebRTCContact`.
2. **Bring your own auth.** The API deploys open for development; the libraries already send
   `Authorization: Bearer <tokenProvider()>` whenever the app supplies a token, so fronting the
   API with your IdP later requires **zero client changes**. Do not run the open API in production.
3. **Least privilege.** The Lambda execution roles may only call
   `StartWebRTCContact`/`StopContact` on a single Connect instance ARN.
4. **Thin, well‑typed bridges.** Small, strongly‑typed Dart/TypeScript APIs forwarding to the
   native Amazon Chime SDK; both libraries implement the **same contract**
   ([specs/003](./specs/003-api-contracts.md)) and share one backend. No business logic in the
   bridge; media pixels never cross into Dart/JS.
5. **Spec first, test first.** Every component has a spec in [`specs/`](./specs) and tests written
   before (or alongside) the implementation.

## Quick start

**Pick your guide** — both are novice‑friendly, end‑to‑end (Connect console → backend deploy →
app config → first call), and cover embedding in an existing native app:

- **Flutter:** [`docs/GETTING_STARTED.md`](./docs/GETTING_STARTED.md)
- **React Native:** [`docs/react-native/GETTING_STARTED.md`](./docs/react-native/GETTING_STARTED.md)

In short:

```bash
# 1. Backend (shared by both libraries)
cd backend && npm ci && npm test                # 79 tests
sam build && sam deploy --guided                 # → note the ApiBaseUrl output

# 2a. Flutter
cd packages/flutter_amazon_connect_webrtc && flutter test
cd example && flutter run --dart-define=BACKEND_BASE_URL=<ApiBaseUrl>

# 2b. React Native
cd packages/react-native-amazon-connect-webrtc && npm ci && npm test && npm audit

# 3. Native host apps (Flutter add-to-app references)
#    iOS:     native/ios-host      (see its README)
#    Android: native/android-host  (build the module AARs first)
```

## Status / scope

The Flutter path is **verified end‑to‑end on physical devices**: real VoIP calls placed from an
iPhone into Amazon Connect (CallKit call UI, queue routing by attributes, DTMF into an IVR,
speaker routing, minimize‑and‑browse), with the Android host building and consuming the same
feature set. The backend is deployed and live‑tested (79 Jest tests + smoke tests against the real
Connect instance). The React Native library shares the same contract and verbatim‑ported native
managers, with a fully tested TypeScript core (26 tests, `npm audit` 0 vulnerabilities); compiling
its native modules requires embedding in an RN host app — the release checklist in
[docs/react-native/PUBLISHING.md](./docs/react-native/PUBLISHING.md) gates on that device smoke
test. See [`specs/006-test-strategy.md`](./specs/006-test-strategy.md) for exactly what is
unit‑tested, contract‑tested, and device‑verified.
