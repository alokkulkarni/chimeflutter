# React Native Integration Guide — `react-native-amazon-connect-webrtc`

Concepts and complete API reference. For the hand-holding walk-through see
[GETTING_STARTED.md](./GETTING_STARTED.md); for shipping the package see
[PUBLISHING.md](./PUBLISHING.md).

The library is the React Native sibling of the repo's Flutter plugin. Both implement the **same
contract** ([specs/003-api-contracts.md](../../specs/003-api-contracts.md)): the same backend HTTP
API (Part A), the same native method/event semantics (Part B), and the same native managers — the
Swift/Kotlin `ChimeCallManager`, `ConnectCallKitManager`/`ConnectTelecomManager` and the
`ChimeMeetingSessionAdapter` are line-for-line ports of the Flutter plugin's (which are verified
end-to-end on real devices).

## 1. Architecture

```
JS (TypeScript, zero runtime deps)                        Native (Swift / Kotlin)
┌─────────────────────────────┐  NativeModules.ConnectWebrtc  ┌──────────────────────────────┐
│ ConnectWebRtcController      │ ────── join/leave/mute… ────▶ │ ConnectWebrtcModule           │
│  • state machine             │ ◀── 'ConnectWebrtcEvent' ──── │  • ChimeCallManager (media)   │
│  • BackendClient (fetch)     │        {type, …}              │  • CallKit / Telecom manager  │
│  • permissions orchestration │                               │  • ChimeMeetingSessionAdapter │
└──────────────┬──────────────┘                               └──────────────┬───────────────┘
               │ HTTPS (Bearer optional)                                      │
               ▼                                                              ▼
        Backend (SAM): /calls, /calls/{id}, /calls/connections, /calls/dtmf   Amazon Chime SDK
```

- **JS owns**: permissions flow, backend HTTP (start/end/DTMF), the `idle → connecting → ringing`
  overlay states, retries/idempotency.
- **Native owns**: the Chime `MeetingSession`, CallKit/Telecom registration, audio session/focus,
  audio routing, video tile binding. Native pushes `connected/reconnecting/disconnected/failed`
  and all discrete events up as `{type, …}` payloads (main-thread marshalled).
- **Backend owns**: AWS credentials, `StartWebRTCContact`, attribute allow-listing, `ContactFlowId`
  selection. The app never sees instance/flow IDs.

## 2. API reference

### `new ConnectWebRtcController(config, tokenProvider, deps?)`

| `config` field | Default | Meaning |
|----------------|---------|---------|
| `backendBaseUrl` | — (required) | The `ApiBaseUrl` output of `sam deploy`. **Must be `https://`** (cleartext rejected; `localhost`/`127.0.0.1`/`10.0.2.2` allowed for dev). |
| `callKitEnabled` | `false` | Register with CallKit/Telecom (set `true` for the "real call" experience). |
| `callDisplayName` | `'Support'` | Name in the system call UI. |
| `requestTimeoutMs` | `15000` | Per-request timeout. |
| `maxStartAttempts` | `3` | Start-call attempts; 429/5xx/network retries reuse **one** idempotency key so a retry can never create a duplicate contact. |

`tokenProvider: () => string | Promise<string>` — called before every backend request. Return your
session JWT (sent as `Authorization: Bearer …`) or `''` for no header.

`deps` (optional) — inject a custom `BackendClient` or `NativeBridge` (used by the unit tests).

### Methods

| Method | Notes |
|--------|-------|
| `startCall(request)` | permissions → `POST /calls` → native join. Throws `PermissionDeniedError` / `AuthError` / `RateLimitedError` / `InvalidRequestError` / `BackendError` / `MediaError`; state ends at `failed`. |
| `endCall()` | native leave + best-effort `DELETE /calls/{contactId}` (never blocks teardown). |
| `sendDtmf(digits)` | `0-9 * #` and `,` (pause), ≤20 chars, validated client-side. Uses the Connect **Participant Service** (`POST /calls/connections` once, then `/calls/dtmf`; auto-recreates the connection once on expiry). DTMF is NOT in-band audio — WebRTC contacts don't support that. |
| `setMuted(muted)` | Routed through CallKit/Telecom when enabled so the system UI stays in sync. |
| `enableLocalVideo()` / `disableLocalVideo()` / `switchCamera()` | Local video control. |
| `setSpeakerphone(enabled)` | Routes via the Chime device controller (iOS) / Telecom endpoints (Android) — the only reliable way under CallKit/Telecom. |
| `getState()` / `getSession()` / `isInCall` | Current state / active `CallSession` (has `contactId`) / convenience. |
| `onStateChanged(fn)` / `onEvent(fn)` | Subscriptions; both return their unsubscribe function. |
| `dispose()` | Unsubscribes from native events and clears listeners. |

### States and events

States: `idle → connecting → ringing → connected → (reconnecting ↔ connected) → disconnected | failed`.

Events (`onEvent`): `stateChanged`, `muteChanged`, `participantJoined/Left`,
`localVideoAvailable`, `remoteVideoAvailable`, `videoTileRemoved`, `audioRouteChanged`,
`networkQualityChanged`, `error {code, message, fatal}` — identical to the Flutter contract
(specs/003 §B.2).

### `<ConnectVideoView tileId={n} mirror? style? />`

Hosts the Chime SDK's native `DefaultVideoRenderView` — video pixels never cross the JS bridge.
Get `tileId` from the `localVideoAvailable` / `remoteVideoAvailable` events; use `mirror` for the
self-view.

### `<ConnectCallScreen controller={…} … />` — prebuilt call UI

The ready-made call screen (counterpart of the Flutter module's UI): audio/video chooser — or
auto-dial when `enabledCallTypes` is a single type — mute/speaker/video/flip controls, a DTMF
keypad for IVR menus, remote + local (PiP) video tiles, status/duration header. Props:
`controller`, `enabledCallTypes?`, `context?`, `device?`, `displayName?`. Pure RN primitives.

### `ConnectCallApp` + `registerConnectCallApp()` — brownfield mini-app

For embedding in an **existing native app**: `registerConnectCallApp()` registers the
self-contained call screen under the AppRegistry name `ConnectCallApp`. The native host mounts it
with `initialProperties` (`backendBaseUrl`, `enabledCallTypes`, `authToken`, `context`,
`callDisplayName`, `device`) and observes call events natively via
`Notification.Name.connectWebrtcEvent` (iOS) or `ConnectWebrtcHostEvents.listener` (Android) — the
RN counterpart of the Flutter host bridge. Walk-through with full Swift/Kotlin host code:
[GETTING_STARTED.md §9](./GETTING_STARTED.md#9-embedding-in-an-existing-native-iosandroid-app-brownfield).

## 3. Routing context → the right queue

`startCall({ context })` keys are **allow-listed by the backend**
(`AllowedClientAttributeKeys` in [backend/template.yaml](../../backend/template.yaml); default:
`issueType, issueSubType, productId, tier, segment, language, preferredAgentId, lastScreen,
campaignId`) and arrive in your contact flow as `$.Attributes.<key>` — branch on them with *Check
contact attributes*. Anything not allow-listed is dropped server-side, so a compromised client
cannot inject arbitrary attributes.

## 4. Security posture

- **Zero runtime npm dependencies** — nothing to audit in your production JS bundle from this
  library (`npm audit --omit=dev`: 0 vulnerabilities by construction; the dev toolchain also audits
  clean at the pinned versions).
- **No AWS credentials or Connect IDs on the device** — the backend is the control plane.
- **HTTPS enforced** for `backendBaseUrl` (cleartext rejected at construction, dev hosts excepted).
- **Bearer tokens** live only in memory, injected per request, never logged by the library.
- **Idempotent starts** — one idempotency key per logical call across all retries (no duplicate
  contacts, no double billing).
- **Client-side input validation** — DTMF digits are validated (`[0-9*#,]{1,20}`) before any
  network call; the server validates again.
- **Native permission gates** — join aborts with `permissionDenied` before any media starts if
  mic/camera aren't granted.
- Backend-side: least-privilege IAM (only `StartWebRTCContact`/`StopContact` on one instance),
  attribute allow-listing, log redaction — see [specs/005-security.md](../../specs/005-security.md).
- ⚠️ The reference API deploys **without an authorizer** (bring-your-own-auth). Front it with your
  IdP before production and return the token from `tokenProvider` — no library change needed.

## 5. Parity with the Flutter plugin

| Aspect | Flutter | React Native |
|--------|---------|--------------|
| Backend API + retries + idempotency | `BackendClient` (Dart) | `BackendClient` (TS) — same semantics, same tests |
| State machine | `ConnectWebRtcController` (Dart) | `ConnectWebRtcController` (TS) — same transitions |
| iOS media/CallKit | `ChimeCallManager` + `ConnectCallKitManager` | **same files, ported verbatim** |
| Android media/Telecom | `ChimeCallManager` + `ConnectTelecomManager` | **same files, ported verbatim** |
| Video tiles | PlatformView | `requireNativeComponent` view manager |
| DTMF | Participant Service | Participant Service (same endpoints) |
| Prebuilt call UI | `flutter_call_module` (`CallHome`) | `ConnectCallScreen` |
| Add-to-app / brownfield | module + cached `FlutterEngine` + MethodChannel host bridge | `ConnectCallApp` + retained React instance + `initialProperties` in / native notifications out |
| `enabledCallTypes` (skip chooser) | host bridge `getConfig` | prop / initialProperty |
| Chime SDK versions | iOS `~>0.27`, Android `0.25.4` | identical |

One backend serves both libraries — deploy it once.
