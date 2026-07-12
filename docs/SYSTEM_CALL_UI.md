# System Call UI — "like WhatsApp" (CallKit / Telecom)

How ChimeFlutter makes the OS treat a Chime/Connect call as a **real phone call**: system call UI,
lock-screen controls, correct audio routing, and interop with cellular calls.

## Where it lives

The system-call integration is **in the plugin** (`flutter_amazon_connect_webrtc`), not the host apps.
That keeps CallKit/Telecom in the same process as the Chime media session, which is required for a
correct audio handoff. Enable it with `ConnectWebRtcConfig(callKitEnabled: true)` — the host apps set
this. When enabled:

- **iOS** → [`ConnectCallKitManager.swift`](../packages/flutter_amazon_connect_webrtc/ios/Classes/ConnectCallKitManager.swift) reports the call to **CallKit** (`CXProvider`/`CXCallController`).
- **Android** → [`ConnectTelecomManager.kt`](../packages/flutter_amazon_connect_webrtc/android/src/main/kotlin/com/chimeflutter/connect_webrtc/ConnectTelecomManager.kt) reports it to **Telecom** (`androidx.core.telecom.CallsManager`, self-managed).

## The critical audio-handoff rule

The OS — not the app — activates the audio session for a system call. So Chime media starts **after**
that, never in `join()`:

- **iOS:** `audioVideo.start(callKitEnabled: true)` is called from `CXProvider(_:didActivate:)`
  (per AWS's CallKit guidance — *"call it here but not before, or audio will not start properly"*).
- **Android:** `audioVideo.start()` is called from the Telecom `onSetActive` callback. With
  core-telecom, the app must **not** drive `AudioManager.setCommunicationDevice`/`startBluetoothSco`
  itself — Telecom owns routing; Chime keeps its default `VoiceCall` audio stream (`STREAM_VOICE_CALL`).

## iOS entitlements & capabilities checklist

Configured in the host app ([`native/ios-host`](../native/ios-host)); enable the matching Xcode
capabilities on your own bundle id.

- [x] **Background Modes** → *Voice over IP* + *Audio, AirPlay…* → `Info.plist` `UIBackgroundModes = [voip, audio]`
- [x] `NSMicrophoneUsageDescription`, `NSCameraUsageDescription` (mic / video)
- [x] **Push Notifications** capability → `aps-environment` entitlement (only needed for *incoming* PushKit calls)
- [x] **CallKit needs no entitlement** — just link the framework
- iOS 14+ (CallKit `CXProviderConfiguration()` initializer). On iOS 13 the modern init is unavailable.

## Android permissions & manifest checklist

Configured in both the plugin manifest and the host app ([`native/android-host`](../native/android-host));
`MainActivity` requests the runtime ones.

- [x] `MANAGE_OWN_CALLS` — self-managed Telecom (and prerequisite for the `phoneCall` FGS type)
- [x] `RECORD_AUDIO` (runtime), `CAMERA` (runtime, video), `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_CONNECT`
- [x] `POST_NOTIFICATIONS` (runtime, API 33+), `USE_FULL_SCREEN_INTENT` (incoming full-screen; auto-granted to calling apps on API 34+)
- [x] `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_PHONE_CALL` + `FOREGROUND_SERVICE_MICROPHONE`; service `android:foregroundServiceType="phoneCall|microphone"`
- API 26+ (`androidx.core.telecom.CallsManager` is `@RequiresApi(26)`) — matches `minSdk 26`.

## Call flow (outbound, customer-initiated)

```
user taps Call ─▶ controller.startCall ─▶ plugin join(callKitEnabled:true)
   iOS:   build Chime session (no audio) → CXStartCallAction → CallKit UI → didActivate → Chime audio starts → connected → reportOutgoingCall(connectedAt)
   Android: build Chime session (no audio) → CallsManager.addCall → onSetActive → Chime audio starts → connected
user taps end (in-app OR system UI) ─▶ CXEndCallAction / Telecom disconnect ─▶ Chime stop ─▶ DELETE /calls/{contactId}
```

Mute from the system UI maps to `realtimeLocalMute()`, and in-app mute is routed through
`CXSetMutedCallAction` (iOS) so the system UI stays in sync.

## Incoming calls (agent → customer) — future scope

v1 is customer-initiated (outbound). For agent callbacks, add a VoIP push:
- **iOS:** PushKit (`PKPushRegistry`, `desiredPushTypes = [.voIP]`); the push handler MUST call
  `CXProvider.reportNewIncomingCall(...)` before the completion handler (iOS 13+ rule, or the OS
  terminates the app). Needs an APNs VoIP key (topic `<bundleid>.voip`).
- **Android:** FCM high-priority push → `CallsManager.addCall(DIRECTION_INCOMING)` + a full-screen
  `CallStyle` notification.
The backend would send the push after starting the WebRTC contact for the customer's device token.

## Verification note

The CallKit/Telecom code follows Apple's and Google's current docs and AWS's iOS CallKit sample, but
requires **a real device** to verify (audio session activation, cellular-call interruption, BT
routing). There is no official AWS doc for Chime↔Android-Telecom coexistence — validate the Android
lifecycle on-device. See the per-claim sources in the host READMEs and specs.
