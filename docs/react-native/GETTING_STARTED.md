# Getting Started (React Native) — "Call support" in your RN app, end to end

This guide takes a React Native developer from zero to a real VoIP/video call into Amazon Connect
using **`react-native-amazon-connect-webrtc`**. It assumes no prior AWS or native-code knowledge:
every file you must touch is spelled out with the reason why.

> The library is the React Native sibling of this repo's Flutter plugin — same backend, same native
> Amazon Chime SDK managers, same behaviour. If you use Flutter instead, read
> [docs/GETTING_STARTED.md](../GETTING_STARTED.md).

---

## 1. How it works (one minute)

```
Your RN app ── POST /calls {context} ──▶ Backend (API GW + Lambda) ── StartWebRTCContact ──▶ Amazon Connect
     ▲                                        │                                                  │ (flow routes
     │        Meeting + Attendee credentials  ◀┘                                                  │  by attributes)
     │
 JS controller ──▶ Native module (Swift/Kotlin) ──▶ Amazon Chime SDK ◀══ WebRTC media ══▶ Agent
                        └─▶ CallKit (iOS) / Telecom (Android): OS-level "real call"
```

- **Your app never holds AWS credentials.** It calls your backend with customer context
  (`issueType`, `tier`, …); the Lambda calls `StartWebRTCContact` and returns join credentials.
- Those credentials go to the **native Amazon Chime SDK** which runs the actual media, registered
  with **CallKit/Telecom** so the OS shows a real call.
- The **contact attributes route the call** to the right Connect queue (e.g. `tier=gold` →
  Priority).

## 2. Prerequisites

- React Native app on **RN ≥ 0.71** (autolinking assumed).
- iOS: Xcode 16+, CocoaPods, deployment target **iOS 15.0+**. Verify
  `xcode-select -p` prints `…/Xcode.app/…` (not CommandLineTools).
- Android: **minSdk 26**, compileSdk 35+, JDK 17.
- An Amazon Connect instance + the deployed backend from this repo. If you haven't done that yet,
  follow **§3 and §4 of the [main getting-started guide](../GETTING_STARTED.md)** (Connect console
  setup ~10 min, `sam deploy` ~5 min). You come back with one value: the **`ApiBaseUrl`** output,
  e.g. `https://abc123xyz.execute-api.eu-west-2.amazonaws.com/v1`.
- **A real phone.** CallKit/Telecom/microphones misbehave on simulators.

## Choose your integration path

| You have… | Use | Sections |
|-----------|-----|----------|
| A **React Native app** | the library directly (controller or the prebuilt `ConnectCallScreen`) | §3 – §8 |
| An **existing native iOS/Android app** (Swift/Kotlin, no RN yet) | brownfield embedding: the library's `ConnectCallApp` mini-app + your native host | §3, then §9 |

Both paths use the same backend, the same native modules, and the same JS core.

## 3. Install the library

```bash
npm install react-native-amazon-connect-webrtc
# or from this repo during development:
npm install file:../chimeflutter/packages/react-native-amazon-connect-webrtc
```

The library has **zero runtime npm dependencies** — it adds nothing else to your JS bundle.

## 4. iOS setup (3 steps)

**Step 1 — Pods.** The podspec pulls `AmazonChimeSDK ~> 0.27` automatically:

```bash
cd ios && pod install
```

If your Podfile pins a platform below 15, raise it: `platform :ios, '15.0'`.

**Step 2 — `ios/<YourApp>/Info.plist`.** Usage strings (iOS kills apps that touch the mic/camera
without them) + background modes (keeps the call alive when the user leaves the app):

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Used for voice calls with support.</string>
<key>NSCameraUsageDescription</key>
<string>Used for video calls with support.</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
  <string>voip</string>
</array>
```

**Step 3 — Xcode → your target → Signing & Capabilities.** Add **Background Modes**, tick *Audio,
AirPlay, and Picture in Picture* and *Voice over IP*. **CallKit itself needs no entitlement.**

Permissions are prompted natively by the library the first time you start a call — no extra
permission package needed.

## 5. Android setup (2 steps)

**Step 1 — nothing to link.** Autolinking picks the module up; the library's manifest already
declares every permission and the foreground service (merged into your app automatically):
`RECORD_AUDIO`, `CAMERA`, `MANAGE_OWN_CALLS`, `POST_NOTIFICATIONS`, the typed
`FOREGROUND_SERVICE_PHONE_CALL|MICROPHONE` pair, and the `CallForegroundService` that shows the
ongoing-call notification.

**Step 2 — `android/app/build.gradle`:** make sure `minSdkVersion 26` or higher (Jetpack Telecom's
`CallsManager` requires API 26). Runtime permission prompts (mic/camera/notifications) are driven
by the library through `PermissionsAndroid` when you start a call.

## 6. Build a call screen (complete, copy-paste)

```tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Platform, StyleSheet, Text, View } from 'react-native';
import {
  CallState,
  ConnectVideoView,
  ConnectWebRtcController,
} from 'react-native-amazon-connect-webrtc';

const BACKEND_BASE_URL = 'https://YOUR_API_ID.execute-api.eu-west-2.amazonaws.com/v1';

export function CallScreen() {
  const controller = useMemo(
    () =>
      new ConnectWebRtcController(
        { backendBaseUrl: BACKEND_BASE_URL, callKitEnabled: true, callDisplayName: 'Support' },
        async () => '', // tokenProvider: return your session JWT once your API has auth
      ),
    [],
  );
  const [state, setState] = useState<CallState>('idle');
  const [muted, setMuted] = useState(false);
  const [remoteTile, setRemoteTile] = useState<number | null>(null);
  const [localTile, setLocalTile] = useState<number | null>(null);

  useEffect(() => {
    const offState = controller.onStateChanged(setState);
    const offEvent = controller.onEvent((e) => {
      if (e.type === 'remoteVideoAvailable') setRemoteTile(e.tileId);
      if (e.type === 'localVideoAvailable') setLocalTile(e.tileId);
      if (e.type === 'videoTileRemoved') {
        setRemoteTile((t) => (t === e.tileId ? null : t));
        setLocalTile((t) => (t === e.tileId ? null : t));
      }
      if (e.type === 'muteChanged') setMuted(e.muted);
    });
    return () => {
      offState();
      offEvent();
      controller.dispose();
    };
  }, [controller]);

  const start = (callType: 'audio' | 'video') =>
    controller
      .startCall({
        callType,
        context: { issueType: 'billing', tier: 'gold' }, // → Connect contact attributes → queue
        device: {
          platform: Platform.OS === 'ios' ? 'iOS' : 'Android',
          osVersion: String(Platform.Version),
          appVersion: '1.0.0',
          deviceModel: 'unknown',
          locale: 'en-GB',
          networkType: 'wifi',
        },
      })
      .catch((e) => console.warn('call failed:', e.code, e.message));

  return (
    <View style={styles.root}>
      {remoteTile != null && <ConnectVideoView tileId={remoteTile} style={styles.remote} />}
      {localTile != null && (
        <ConnectVideoView tileId={localTile} mirror style={styles.localPreview} />
      )}
      <Text style={styles.state}>{state}</Text>

      {state === 'idle' || state === 'disconnected' || state === 'failed' ? (
        <View style={styles.row}>
          <Button title="Audio call" onPress={() => start('audio')} />
          <Button title="Video call" onPress={() => start('video')} />
        </View>
      ) : (
        <View style={styles.row}>
          <Button title={muted ? 'Unmute' : 'Mute'} onPress={() => controller.setMuted(!muted)} />
          <Button title="Speaker" onPress={() => controller.setSpeakerphone(true)} />
          <Button title="IVR: press 1" onPress={() => controller.sendDtmf('1')} />
          <Button title="Hang up" color="red" onPress={() => controller.endCall()} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#101223', padding: 24 },
  remote: { ...StyleSheet.absoluteFillObject },
  localPreview: { position: 'absolute', top: 48, right: 16, width: 104, height: 156, borderRadius: 12 },
  state: { color: 'white', textAlign: 'center', marginBottom: 16, fontSize: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-evenly', marginBottom: 24 },
});
```

For a full DTMF **keypad** (digits `0-9 * #`), render 12 buttons that each call
`controller.sendDtmf(digit)` — the library creates the Participant Service connection lazily and
retries once on expiry, exactly like the Flutter module's keypad.

## 7. Your first call — what you should see

1. Agent: open the Connect **Agent Workspace/CCP**, go **Available**.
2. App on a **real device** → *Audio call* → mic prompt (first run) → `connecting → ringing →
   connected`. iOS shows the green call indicator/Dynamic Island; Android shows the ongoing-call
   notification.
3. The agent's CCP pops the contact, routed by your flow's attribute checks (`tier=gold` →
   Priority in the demo flow).
4. Try mute (system UI stays in sync — that's CallKit/Telecom), speaker (routes through the
   platform call framework, so it actually gets loud), `sendDtmf('1')` against an IVR menu, and
   hang up from either side.

## 8. Troubleshooting

| Symptom | Cause → Fix |
|---------|-------------|
| `native module 'ConnectWebrtc' not found` | Pods not installed / app not rebuilt after install → `cd ios && pod install`, rebuild; Android: full rebuild (`npx react-native run-android`) |
| Mic prompt never appears, join fails `permissionDenied` (iOS) | Missing `NSMicrophoneUsageDescription` → §4 step 2 |
| Call goes `connecting → failed` immediately | Wrong/missing `backendBaseUrl` or backend not deployed → `curl <ApiBaseUrl>/health` |
| `backendBaseUrl must be https://` error | The library rejects cleartext endpoints by design; use the real API Gateway URL (http allowed only for localhost/`10.0.2.2`) |
| 403 `AccessDeniedException` from the backend | Stack deployed in a different region/account than the Connect instance |
| No remote video tile | Agent/flow video not enabled, or you didn't render `ConnectVideoView` from the `remoteVideoAvailable` event |
| Speaker button not louder | Don't touch `AVAudioSession`/`AudioManager` yourself — CallKit/Telecom owns routing; use `controller.setSpeakerphone(...)` only |
| Android build: `CallsManager requires API 26` | Raise `minSdkVersion` to 26 (§5 step 2) |
| Audio silent with CallKit enabled (iOS) | Something started media before CallKit activated the audio session. The library handles the ordering (`didActivate` → start) — check you haven't added another CallKit integration to the same call |

## 9. Embedding in an EXISTING native iOS/Android app (brownfield)

This is the React Native equivalent of the repo's Flutter add-to-app setup
(`flutter_call_module` + the two native hosts). The library ships everything JS-side; your native
app hosts one React Native runtime and mounts the ready-made call mini-app.

### 9.1 The three concepts (mirror of the Flutter ones)

1. **The library ships a registered mini-app.** `registerConnectCallApp()` registers a complete,
   self-contained call screen (chooser/auto-dial, controls, DTMF keypad, video tiles) under the
   AppRegistry name **`ConnectCallApp`** — the counterpart of `flutter_call_module`'s `mainHost`.
2. **Config flows in as `initialProperties`.** Where Flutter needed a MethodChannel (`getConfig`),
   RN lets the native host pass a plain dictionary when mounting the view:
   `{backendBaseUrl, enabledCallTypes, authToken, context, callDisplayName}` — the host owns
   config and auth, exactly like the Flutter host bridge.
3. **Keep ONE React instance alive app-wide** (the counterpart of Flutter's cached engine). The
   *view* can be dismissed while the JS runtime and the native call session keep running — that's
   what enables "browse the app during the call" with a return-to-call banner. Your host observes
   call state **natively** (no JS): `Notification.Name.connectWebrtcEvent` on iOS,
   `ConnectWebrtcHostEvents.listener` on Android.

### 9.2 One-time RN plumbing in the native project

Follow React Native's official "Integration with Existing Apps" guide for the boilerplate
(a `package.json` + `index.js` next to your native project, Metro, and the RN pods/gradle wiring),
then install the library:

```bash
npm install react-native react-native-amazon-connect-webrtc
```

```js
// index.js — the JS entry of the embedded bundle
import { registerConnectCallApp } from 'react-native-amazon-connect-webrtc';
registerConnectCallApp();               // registers 'ConnectCallApp'
```

### 9.3 iOS host (Swift)

`cd ios && pod install` (the RN pods + this library's pod autolink). Then, in your app:

```swift
import React

/// Keep ONE bridge alive for the app's lifetime (counterpart of Flutter's cached engine).
final class ReactNativeHost {
    static let shared = ReactNativeHost()
    let bridge: RCTBridge

    private init() {
        // Debug: Metro. Release: the bundled JS (RCTBundleURLProvider handles both).
        let url = RCTBundleURLProvider.sharedSettings()
            .jsBundleURL(forBundleRoot: "index")
        bridge = RCTBridge(bundleURL: url, moduleProvider: nil, launchOptions: nil)!
    }
}

/// Present the call screen — config goes in as initialProperties (the RN "host bridge").
func presentCallScreen(from presenter: UIViewController) {
    let rootView = RCTRootView(
        bridge: ReactNativeHost.shared.bridge,
        moduleName: "ConnectCallApp",
        initialProperties: [
            "backendBaseUrl": "https://YOUR_API_ID.execute-api.eu-west-2.amazonaws.com/v1",
            "enabledCallTypes": "audio,video",     // or "audio" / "video" → auto-dial
            "authToken": "",                        // your session JWT once the API has auth
            "context": ["issueType": "billing", "tier": "gold"],
            "callDisplayName": "Support",
        ])
    let vc = UIViewController()
    vc.view = rootView
    vc.modalPresentationStyle = .pageSheet       // swipe down = minimize; the call keeps running
    presenter.present(vc, animated: true)
}

// Observe call state natively (green "return to call" banner, auto-dismiss on end):
NotificationCenter.default.addObserver(forName: .connectWebrtcEvent, object: nil, queue: .main) { note in
    guard let type = note.userInfo?["type"] as? String else { return }
    if type == "stateChanged", let state = note.userInfo?["state"] as? String {
        // connecting/connected/… → show banner while a call is active and the sheet is dismissed
        // disconnected/failed    → hide banner, dismiss the call screen if presented
    }
}
```

Info.plist / capabilities are the same as §4 (mic + camera usage strings, `UIBackgroundModes`
`audio`+`voip`, Background Modes capability).

### 9.4 Android host (Kotlin)

Wire RN into the app per the official brownfield guide (RN gradle plugin, `ReactApplication` /
`ReactNativeHost` in your `Application` — this keeps the single React instance alive), and make
sure `ConnectWebrtcPackage` is registered (autolinking does this). Then:

```kotlin
// The call screen Activity — mounts the mini-app with initialProps (the RN "host bridge").
class CallActivity : ReactActivity() {
    override fun getMainComponentName() = "ConnectCallApp"

    override fun createReactActivityDelegate() =
        object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
            override fun getLaunchOptions() = Bundle().apply {
                putString("backendBaseUrl", "https://YOUR_API_ID.execute-api.eu-west-2.amazonaws.com/v1")
                putString("enabledCallTypes", "audio,video")  // or "audio"/"video" → auto-dial
                putString("authToken", "")
                putBundle("context", Bundle().apply {
                    putString("issueType", "billing"); putString("tier", "gold")
                })
                putString("callDisplayName", "Support")
            }
        }
}
```

```kotlin
// In your Application.onCreate() — native call-state without touching JS:
ConnectWebrtcHostEvents.listener = { event ->
    if (event["type"] == "stateChanged") {
        val state = event["state"] as? String
        // active states → show a "return to call" banner (relaunch CallActivity to return)
        // disconnected/failed → hide the banner / finish CallActivity
    }
}
```

The system **back gesture minimizes** (finishes the Activity) while the call keeps running — the
library's Telecom session + foreground service and your retained React instance carry it, exactly
like the Flutter host. Manifest permissions come from the library; request the runtime ones
(mic/camera/notifications) before launching `CallActivity`, or let the mini-app prompt.

### 9.5 The host contract at a glance

| Direction | Mechanism | Payload |
|-----------|-----------|---------|
| Host → JS (config/auth/context) | `initialProperties` / `launchOptions` | `backendBaseUrl` (required), `enabledCallTypes`, `authToken`, `context`, `callDisplayName`, `device` |
| JS → Host (call events) | iOS `Notification.Name.connectWebrtcEvent` · Android `ConnectWebrtcHostEvents.listener` | the raw event map: `{type: 'stateChanged', state: …}`, `{type: 'error', …}`, … |
| Minimize | platform-native: sheet swipe-down (iOS) / back gesture (Android) | call keeps running (CallKit/Telecom + retained React instance) |

## 10. Receiving calls — agent-initiated ("simulated outbound")

The library can also receive calls an **agent** places to the app: the backend starts the contact
on the customer's behalf, routes it straight to the agent's personal queue (their voice slot is
occupied while your phone rings — Connect offers them nothing else), and wakes the device with an
APNs **VoIP** push (iOS) / high-priority **FCM** data push (Android). The OS incoming-call UI
appears even with the app killed; on answer the app joins the exact same media path:

```tsx
await backendClient.registerDevice(customerId, Platform.OS === 'ios' ? 'iOS' : 'Android', token);
controller.onEvent((e) => {
  if (e.type === 'incomingCallAnswered') controller.answerIncomingCall(e.callId, e.isVideo ? 'video' : 'audio');
  if (e.type === 'incomingCallDeclined') controller.declineIncomingCall(e.callId);
});
await controller.handlePendingIncomingCall(); // cold start
```

One-time setup (SNS platform applications, the outbound contact flow, PushKit in your iOS
AppDelegate, a FirebaseMessagingService on Android) is a dedicated step-by-step guide:
**[../OUTBOUND_CALLS.md](../OUTBOUND_CALLS.md)**.

## 11. Before production

- **Add authentication** in front of the API and return the session token from `tokenProvider`
  (sent as `Authorization: Bearer …`; empty string = no header).
- Security posture, API contract and the full reference:
  [INTEGRATION.md](./INTEGRATION.md) · publishing the package: [PUBLISHING.md](./PUBLISHING.md) ·
  backend runbook: [../DEPLOYMENT.md](../DEPLOYMENT.md) ·
  agent-initiated calls: [../OUTBOUND_CALLS.md](../OUTBOUND_CALLS.md).
