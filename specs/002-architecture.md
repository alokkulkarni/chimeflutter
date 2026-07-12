# 002 — Architecture

**Related:** [001-requirements](./001-requirements.md) · [003-api-contracts](./003-api-contracts.md) · [005-security](./005-security.md) · [004-sequence-diagrams](./004-sequence-diagrams.md)

## 1. Component overview

```
┌───────────────────────────── Native host app (iOS / Android) ─────────────────────────────┐
│  Owns identity/auth. Provides a JWT via tokenProvider. Holds customer context.             │
│                                                                                            │
│   ┌──────────────────────── Flutter library (add-to-app module) ───────────────────────┐  │
│   │  Dart:  ConnectWebRtcController ──▶ BackendClient ──HTTPS(JWT)──▶ API GW + Lambda    │  │
│   │            │  (state machine, models, permissions)                     │             │  │
│   │            ▼                                                           ▼             │  │
│   │      MethodChannel/EventChannel ◀────────────────────────── CallSession (meeting)   │  │
│   │            │                                                                          │  │
│   └────────────┼──────────────────────────────────────────────────────────────────────┘  │
│                ▼                                                                            │
│      Native bridge (Swift / Kotlin) ──▶ Amazon Chime SDK ══ WebRTC media ══▶ Amazon Connect │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Two planes:
- **Control plane** — Dart → backend (HTTPS/JWT) → `StartWebRTCContact`. Returns a `CallSession`.
- **Media plane** — native Chime SDK ⇄ Amazon Connect (Chime media). Audio = VoIP; video = WebRTC.

The device never holds AWS credentials or the Connect InstanceId/ContactFlowId (NFR-1).

## 2. Backend (see `backend/`)

Ports-and-adapters. Pure domain (attribute merge, capability map, session normaliser, redaction,
JWT authorize) is isolated from the AWS SDK and Lambda types, so it is unit-testable without cloud.

- `POST /v1/calls` → `StartWebRTCContact` → normalised `CallSession`.
- `DELETE /v1/calls/{contactId}` → `StopContact`.
- JWT **Lambda authorizer** (JWKS) injects trusted claims into `requestContext.authorizer.lambda`.
- Least-privilege IAM: `connect:StartWebRTCContact` / `connect:StopContact` on one instance ARN.

## 3. Flutter plugin (see `packages/flutter_amazon_connect_webrtc/`)

Layered so the logic-bearing parts are pure Dart and unit-tested; only the thinnest shims touch the
channels.

| Layer | Type | Responsibility | Tested by |
|-------|------|----------------|-----------|
| `ConnectWebRtcController` | pure Dart | Public API + **call state machine** (idle→connecting→connected→…). Orchestrates backend + native. | Dart unit (mocked ports) |
| `models` | pure Dart | `CallRequest`, `CallSession`, `CallState`, `CallEvent`, `DeviceInfo` + JSON round-trip. | Dart unit |
| `BackendClient` | Dart (+`http`) | Calls the HTTP API, injects `Authorization`/`Idempotency-Key`, maps errors. **One idempotency key per logical call, reused across retries.** | Dart unit (mock http) |
| `PermissionService` | Dart (+`permission_handler`) | Mic (+camera) runtime permission, injectable for tests. | Dart unit (fake) |
| `MethodChannelCallPlatform` | Dart shim | `MethodChannel`/`EventChannel` marshalling to a typed `CallPlatform` interface. | Dart unit (mock channel) |
| Swift / Kotlin bridge | native | Adapt `CallSession`→`MeetingSessionConfiguration`, drive `AudioVideoFacade`, forward observers. | XCTest / Robolectric (adapter) |

`CallPlatform` is an interface, so the controller is tested against a fake platform with no channels.

### 3.1 Video rendering decision — **PlatformView, not Texture**

Chime's mobile SDKs render into a **native view** (`DefaultVideoRenderView`, a `UIView`/`SurfaceView`
subclass), not a pixel stream. We therefore host that native view in a Flutter **PlatformView**
(`UiKitView`/`AndroidView`), exposed as the `ConnectVideoView(tileId:)` widget. This is the AWS-sample
path and avoids fragile frame-copying into a Flutter `Texture`. Consequence for the public API: the
plugin exposes **a controller (methods/streams) *and* a widget** — decided up front so video did not
force an API redesign later.

## 4. VoIP / real-time constraints (table-stakes, not gold-plating)

These are required for a call to behave correctly in the background and on device audio changes.

### iOS
- **`AVAudioSession`**: set category `.playAndRecord`, mode `.voiceChat`, activate before `start()`.
- **CallKit**: `audioVideo.start(callKitEnabled:)` — pass `true` when the host integrates CallKit so
  the OS manages the audio session; the sample plugin exposes a flag (default `false`).
- **`Info.plist`**: `UIBackgroundModes: [audio, voip]`, `NSMicrophoneUsageDescription`,
  `NSCameraUsageDescription` (video).
- **Min iOS 13** (Flutter floor); Amazon Chime SDK iOS supports 12+. Pod `AmazonChimeSDK` `~> 0.27`.

### Android
- **Foreground service** with `android:foregroundServiceType="microphone"` and permission
  `FOREGROUND_SERVICE_MICROPHONE` so the call survives backgrounding (AWS demo does this).
- **Audio focus**: request `AUDIOFOCUS_GAIN` / abandon on end; handle transient loss.
- **Permissions**: `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `INTERNET`, `BLUETOOTH(_CONNECT)`,
  `CAMERA` (video), `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`.
- **minSdk 24** (Chime `getActiveAudioDevice` needs API 24), Java 17. Dep
  `software.aws.chimesdk:amazon-chime-sdk:0.25.4` (note the group — **not** `com.amazonaws`).

### Threading
Chime observer callbacks arrive on arbitrary threads. **Every** `EventChannel.success` and any UIKit/
platform-view mutation is marshalled onto the main thread (iOS `DispatchQueue.main.async`, Android
`Handler(Looper.getMainLooper()).post`). This is the single most common crash source in such bridges
and is a hard rule in the bridge code.

## 5. Add-to-app integration (see `native/`)

Host apps embed the Flutter module via **add-to-app**:
- iOS: `FlutterEngine` + `FlutterViewController`; the plugin is registered via `GeneratedPluginRegistrant`.
- Android: `FlutterEngine` cached in a `FlutterEngineGroup`; launched via `FlutterActivity`/`FlutterFragment`.

The host passes customer context by (a) providing the JWT (trusted identity) and (b) forwarding a
context map into the Dart entrypoint, which becomes `CallRequest.context`.

## 6. Key design decisions (ADR-style)

| # | Decision | Alternatives | Why |
|---|----------|--------------|-----|
| A1 | Backend mints the WebRTC contact; device holds no AWS creds. | Device calls Connect directly with Cognito creds. | Keeps InstanceId/FlowId + routing policy server-side; smaller attack surface. |
| A2 | PlatformView for video. | Flutter Texture + VideoSink frame copy. | Matches Chime SDK's native render view; less fragile; AWS-sample-aligned. |
| A3 | Thin typed bridge; logic in pure Dart. | Business logic in Swift/Kotlin. | Maximises the unit-testable surface; iOS/Android stay in sync via one contract. |
| A4 | `ClientToken` idempotency (no DB). | DynamoDB idempotency table. | `StartWebRTCContact` is idempotent per ClientToken for 7 days — no extra infra. |
| A5 | Issuer-agnostic JWT authorizer. | Cognito-only native JWT authorizer. | Works with any OIDC IdP; still recommends Cognito. |
| A6 | **System call UI lives in the plugin** (CallKit iOS / Telecom `androidx.core.telecom` Android), enabled by `callKitEnabled`. | Host apps own CallKit/Telecom. | Same-process coordination with the Chime audio session (audio must start in `didActivate` / `onSetActive`); reusable across hosts. See [SYSTEM_CALL_UI](../docs/SYSTEM_CALL_UI.md). |
| A7 | Android uses Jetpack `androidx.core.telecom`, not a classic self-managed `ConnectionService`. | Hand-written `ConnectionService`. | Classic `CAPABILITY_SELF_MANAGED` is deprecated (API 37); Jetpack manages the API-34 transactional split + audio routing. `@RequiresApi(26)` → `minSdk 26`. |
