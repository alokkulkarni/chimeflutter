# 003 — API & Channel Contracts

**Related:** [001-requirements](./001-requirements.md) · [002-architecture](./002-architecture.md) · [005-security](./005-security.md)

This document is the **single source of truth** shared by four codebases: the TypeScript backend, the
Dart plugin, the Swift (iOS) bridge and the Kotlin (Android) bridge. Changing a field here is a
breaking change and must be reflected in all four.

---

## Part A — HTTP API (mobile client ⇄ backend)

Base URL: `https://{apiId}.execute-api.{region}.amazonaws.com/v1`
All requests (except `/health`) require `Authorization: Bearer <JWT>`.
All responses set `X-Correlation-Id`.

### A.1 `GET /health` — public
`200 → { "status": "ok", "service": "chimeflutter-backend" }`

### A.2 `POST /v1/calls` — start a call

**Headers**
| Header | Required | Notes |
|--------|----------|-------|
| `Authorization: Bearer <jwt>` | yes | Verified by the Lambda authorizer. |
| `Idempotency-Key: <uuid>` | recommended | Reused across retries of the *same* logical call → Connect `ClientToken` (idempotent 7 days). |
| `X-Correlation-Id: <id>` | optional | Propagated to logs + Connect `correlationId` attribute; generated if absent. |

**Request body**
```jsonc
{
  "callType": "audio",              // "audio" | "video"  (required)
  "displayName": "Ada Lovelace",    // optional; shown to agent; server defaults + truncates to 256
  "context": {                      // optional; ONLY allow-listed keys reach Connect (NFR-2)
    "issueType": "billing",
    "tier": "gold",
    "productId": "card-platinum"
  },
  "device": {                       // required
    "platform": "iOS",              // "iOS" | "Android" (case-insensitive, normalised)
    "osVersion": "17.5",
    "appVersion": "4.2.0",
    "deviceModel": "iPhone15,2",
    "locale": "en-GB",
    "networkType": "wifi"
  }
}
```

**Success `201`** — the normalised `CallSession` (camelCase; nothing server-internal):
```jsonc
{
  "contactId": "…",
  "participantId": "…",
  "participantToken": "…",
  "callType": "audio",
  "meeting": {
    "meetingId": "…",
    "mediaRegion": "eu-west-2",
    "mediaPlacement": {
      "audioHostUrl": "…",
      "audioFallbackUrl": "…",       // optional
      "signalingUrl": "…",
      "turnControlUrl": "…",          // optional
      "eventIngestionUrl": "…"        // optional
    }
  },
  "attendee": { "attendeeId": "…", "joinToken": "…" }
}
```

### A.3 `DELETE /v1/calls/{contactId}` — end a call
`204` on success. See [005-security §IDOR](./005-security.md) for the ownership caveat.

### A.4 `POST /v1/calls/connections` — participant connection (DTMF)
Body `{ "participantToken": "…" }` → `201 { "connectionToken": "…", "expiry": "…" }`.
Exchanges the CallSession's participantToken for a Participant Service connection.

### A.5 `POST /v1/calls/dtmf` — send IVR digits
Body `{ "connectionToken": "…", "digits": "1" }` (digits: `[0-9*#,]{1,20}`) → `200 { "sent": true }`.
DTMF is sent as an `audio/dtmf` Participant Service message, NOT in the audio stream. The Dart
`controller.sendDtmf(digits)` wraps both calls (lazy connection + one retry on expiry).

### A.6 Error envelope (all non-2xx)
```jsonc
{ "error": { "code": "RATE_LIMITED", "message": "…" }, "correlationId": "…" }
```
| HTTP | `code` | Meaning |
|------|--------|---------|
| 400 | `INVALID_CALL_TYPE`, `INVALID_PLATFORM`, `INVALID_JSON`, `EMPTY_BODY`, `MISSING_CONTACT_ID` | Bad request. |
| 401/403 | (authorizer deny) | Missing/expired/invalid token. See [005-security](./005-security.md). |
| 429 | `RATE_LIMITED` | Connect throttled; client should back off & retry with the **same** Idempotency-Key. |
| 502 | `UPSTREAM_ERROR` | Connect failed / returned an unusable response. |

---

## Part B — Platform-channel contract (Dart ⇄ native Chime SDK)

The Dart plugin talks to the native Amazon Chime SDK over two channels. **Native never talks to the
backend**; Dart fetches the `CallSession` and hands the join payload down.

- **Method channel** (Dart → native, request/response): `com.chimeflutter.connect_webrtc/methods`
- **Event channel** (native → Dart, stream): `com.chimeflutter.connect_webrtc/events`
- **Platform view** (video tiles): `com.chimeflutter.connect_webrtc/video_view`

### B.1 Methods (Dart → native)

| Method | Arguments | Returns | Behaviour |
|--------|-----------|---------|-----------|
| `join` | `CallSession` map (§A.2 body) | `void` | Build `MeetingSessionConfiguration` (unwrap → `externalUserId=""`), configure audio session / foreground service, `audioVideo.start()`. |
| `leave` | – | `void` | `audioVideo.stop()`, release audio session / stop foreground service. |
| `setMuted` | `{ "muted": bool }` | `bool` (success) | `realtimeLocalMute()` / `realtimeLocalUnmute()`. |
| `setLocalVideoEnabled` | `{ "enabled": bool }` | `void` | `startLocalVideo()` / `stopLocalVideo()`. |
| `switchCamera` | – | `void` | Toggle front/back capture device. |
| `setSpeakerphoneEnabled` | `{ "enabled": bool }` | `void` | Route audio to speaker/earpiece. |

Method errors surface as a `PlatformException(code, message)` where `code` is one of the error codes
in §B.4 (e.g. `permissionDenied`, `sdkError`).

### B.2 Events (native → Dart) — every event is a map with a `type` discriminator

| `type` | Fields | Maps to (Dart) |
|--------|--------|----------------|
| `stateChanged` | `state`: one of `connecting,connected,reconnecting,disconnected,failed`; `reason?` | `CallState` |
| `muteChanged` | `muted`: bool | `CallEvent.muteChanged` |
| `participantJoined` | `attendeeId`, `externalUserId?` | `CallEvent.remoteParticipantJoined` |
| `participantLeft` | `attendeeId` | `CallEvent.remoteParticipantLeft` |
| `localVideoAvailable` | `tileId`: int | `CallEvent.localVideoTileAdded` |
| `remoteVideoAvailable` | `tileId`: int, `attendeeId` | `CallEvent.remoteVideoTileAdded` |
| `videoTileRemoved` | `tileId`: int | `CallEvent.videoTileRemoved` |
| `audioRouteChanged` | `route`: `speaker,receiver,bluetooth,headset` | `CallEvent.audioRouteChanged` |
| `networkQualityChanged` | `quality`: `good,poor`, `attendeeId?` | `CallEvent.networkQualityChanged` |
| `error` | `code`, `message`, `fatal`: bool | `CallEvent.error` (+ `failed` state if fatal) |

**Threading:** native observers fire on arbitrary threads. Every event **must** be posted to the
platform main thread before `EventSink.success(...)` (iOS `DispatchQueue.main`, Android
`Handler(Looper.getMainLooper())`). See [002-architecture §threading](./002-architecture.md).

### B.3 Video tiles / PlatformView

Rendering uses a **PlatformView** hosting the Chime SDK's native render view (`UIView` /
`SurfaceView`), *not* a Flutter `Texture`. Dart embeds:

```dart
ConnectVideoView(tileId: e.tileId, mirror: true)   // wraps UiKitView / AndroidView
```
Creation params: `{ "tileId": int, "mirror": bool }`. On create, native calls
`audioVideo.bindVideoView(view, tileId)`; on dispose, `unbindVideoView(tileId)`.

### B.4 Canonical error codes (shared by method errors and `error` events)

| code | fatal | Meaning |
|------|-------|---------|
| `permissionDenied` | yes | Microphone (or camera for video) permission denied. Join aborted. |
| `backendError` | yes | The backend start-call call failed (Dart-side; see §A.4). |
| `sdkError` | maybe | Chime SDK failure (join/start/observer). `fatal` set per severity. |
| `networkLost` | no | Media connection dropped; SDK reconnecting. |
| `sessionEnded` | yes | Remote/agent ended the session or `audioVideo` stopped. |

---

## Part C — Dart public API (host app ⇄ plugin)

```dart
final controller = ConnectWebRtcController(
  config: ConnectWebRtcConfig(backendBaseUrl: Uri.parse('https://…/v1')),
  tokenProvider: () async => await myAuth.getJwt(),   // host owns auth (FR-F7)
);

await controller.startCall(CallRequest(
  callType: CallType.audio,
  context: {'issueType': 'billing', 'tier': 'gold'},
  device: await DeviceInfo.current(),
));

controller.state;                 // ValueListenable<CallState>
controller.states;                // Stream<CallState>
controller.events;                // Stream<CallEvent>
await controller.setMuted(true);
await controller.enableLocalVideo();
await controller.switchCamera();
await controller.endCall();
controller.dispose();
```

`ConnectVideoView` is the widget the host places to show a tile (local or remote), obtained from the
`videoTileAdded` events.
