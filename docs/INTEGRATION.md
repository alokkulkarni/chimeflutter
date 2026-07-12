# Integration Guide

End-to-end guide to wiring ChimeFlutter into a mobile app. Read the [specs](../specs) for the "why".

## 0. Prerequisites

- An Amazon Connect instance with **in-app/web/video calling** enabled and a published inbound
  contact flow (see [DEPLOYMENT](./DEPLOYMENT.md)).
- Node 20+, AWS SAM CLI, an AWS account, and optionally your own API auth (see docs/PUBLISHING.md §B.6).
- Flutter 3.19+, Xcode 15+, Android Studio (JDK 17).

## 1. Deploy the backend

```bash
cd backend
npm ci
npm test                     # 68 unit/integration tests
PATH="$PWD/node_modules/.bin:$PATH" sam build
sam deploy --guided \
  --parameter-overrides \
    ConnectInstanceId=<your-connect-instance-id> \
    ConnectContactFlowId=<your-published-flow-id>
```

Note the `ApiBaseUrl` output — that is the plugin's `backendBaseUrl`. Full runbook: [DEPLOYMENT](./DEPLOYMENT.md).

## 2. Use the plugin in a pure-Flutter app

```yaml
# pubspec.yaml
dependencies:
  flutter_amazon_connect_webrtc:
    path: ../packages/flutter_amazon_connect_webrtc   # or a pub/git ref
```

```dart
final controller = ConnectWebRtcController(
  config: ConnectWebRtcConfig(backendBaseUrl: Uri.parse('https://<apiId>.execute-api.eu-west-2.amazonaws.com/v1')),
  tokenProvider: () => myAuth.getJwt(),      // your app owns auth
);

await controller.startCall(CallRequest(
  callType: CallType.audio,                  // or CallType.video
  device: DeviceInfo.forCurrentPlatform(appVersion: '4.2.0'),
  context: {'issueType': 'billing', 'tier': 'gold'},   // drives Connect routing
));

controller.states.listen((s) => print('call: $s'));
controller.events.listen((e) { /* video tiles, participants, errors */ });

await controller.setMuted(true);
await controller.endCall();
```

For video, render tiles from events:
```dart
controller.events.listen((e) {
  if (e is RemoteVideoTileAdded) setState(() => remoteTile = e.tileId);
});
// ...
if (remoteTile != null) ConnectVideoView(tileId: remoteTile!);
```

> **Local vs remote video.** The native bridge always starts *receiving* remote video, so the agent's
> tile arrives automatically on a video call. Your **local** camera is opt-in — call
> `controller.enableLocalVideo()` (e.g. from a "turn on camera" button, as the example does) when you
> want to send video. This keeps the customer in control of their camera.

### Platform config
- **iOS** (`ios/Runner/Info.plist`): `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`,
  `UIBackgroundModes = [audio, voip]`; deployment target 15.0 + the permission_handler macros (docs/PUBLISHING.md §B.3).
- **Android**: `minSdkVersion 26`, `compileSdk 35+`, Java 17. The plugin declares the media +
  foreground-service permissions; request `RECORD_AUDIO`/`CAMERA` at runtime.

## 3. Embed in an existing native app (add-to-app)

The hosts embed a Flutter **add-to-app module** ([`native/flutter_call_module`](../native/flutter_call_module),
**not** the example app — only a module generates the `.ios/`/`.android/` glue). The host owns auth +
customer context and provides them over the host bridge (`com.chimeflutter.host/bridge`). See:
- Module: [`native/flutter_call_module`](../native/flutter_call_module) — run `flutter pub get` here **first**
- iOS: [`native/ios-host`](../native/ios-host)
- Android: [`native/android-host`](../native/android-host)

The Flutter side is [`native/flutter_call_module/lib/main.dart`](../native/flutter_call_module/lib/main.dart)
(entrypoint `mainHost`), whose `tokenProvider` is `HostBridge.getAuthToken`.

### Audio/video offering (`enabledCallTypes`)

The host's `getConfig` bridge reply includes `enabledCallTypes`, which controls what the call
screen offers when it opens:

| Value | Behaviour |
|-------|-----------|
| `"audio,video"` (default) | The chooser is shown — the user picks **Audio call** or **Video call**. |
| `"audio"` | No chooser — an audio call dials **immediately** when the call screen opens. |
| `"video"` | No chooser — a video call dials immediately. |

On `"audio"` the in-call Video/Flip buttons are hidden too. After a hang-up the idle screen shows a
single redial button for the sole type (it never auto-redials).

Set it in `HostConfig`: iOS [`AppDelegate.swift`](../native/ios-host/HostApp/AppDelegate.swift)
(`HostConfig.enabledCallTypes`, overridable via an `ENABLED_CALL_TYPES` scheme environment
variable) · Android [`HostApplication.kt`](../native/android-host/app/src/main/kotlin/com/chimeflutter/hostapp/HostApplication.kt)
(`HostConfig.enabledCallTypes`). Standalone module runs use
`--dart-define=ENABLED_CALL_TYPES=…`. Unrecognised/empty values fall back to both.

### System call UI ("like WhatsApp")
Set `ConnectWebRtcConfig(callKitEnabled: true)` (the host apps do) and the plugin reports the call to
**CallKit** (iOS) / **Telecom** (Android) so the OS shows a real phone call with lock-screen controls
and proper audio routing. The host must declare the matching entitlements/permissions — full checklist
and call flow in [docs/SYSTEM_CALL_UI.md](./SYSTEM_CALL_UI.md).

## 4. How context reaches the right queue

`CallRequest.context` (allow-listed) + device details are merged by the backend
into Connect **contact attributes**. In your contact flow, branch on them:

```
Check contact attributes → $.Attributes.issueType == "billing" → Set working queue: Billing
                          → $.Attributes.tier == "gold"        → Set working queue: Priority
```

## 5. Test it

- Backend: `cd backend && npm test`.
- Plugin (Dart): `cd packages/flutter_amazon_connect_webrtc && flutter test`.
- Native adapters: run in CI (XCTest / Gradle) — see [CI](./CI.md).
- Live smoke test: [DEPLOYMENT §Smoke test](./DEPLOYMENT.md#5-smoke-test).
