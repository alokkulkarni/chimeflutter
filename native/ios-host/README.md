# Native iOS host app (add-to-app + CallKit)

A **proper, buildable native iOS app** (XcodeGen + CocoaPods) that embeds the ChimeFlutter module and
places VoIP/WebRTC calls into Amazon Connect. The OS treats the call as a **real phone call**
("like WhatsApp") because the `flutter_amazon_connect_webrtc` plugin reports it to **CallKit**.

## Architecture

```
SwiftUI HomeView ─"Call support"─▶ FlutterViewController (cached FlutterEngine, entrypoint `mainHost`)
      │  bridge: com.chimeflutter.host/bridge                     │
      │  ← getAuthToken / getCustomerContext                      ▼
      │  → startCall / (endCall)                          ConnectWebRtcController
      └──────────────────────────────────────────────────────────┤
                                        flutter_amazon_connect_webrtc (plugin)
                                        ├── ConnectCallKitManager  → CallKit (system call UI)
                                        └── ChimeCallManager       → Amazon Chime SDK (media)
                                                    audio starts in CXProvider didActivate
```

The host owns **auth + context**; the plugin owns **CallKit + Chime** (same process, so the
CallKit↔Chime audio handoff is correct — Chime audio starts only in `provider(_:didActivate:)`).

## Build & run

**`ChimeFlutterHost.xcodeproj` is committed** — open it directly in Xcode. To build (embed the Flutter
module + Amazon Chime SDK) you then run `pod install`, which produces the `.xcworkspace`:

```bash
cd native/ios-host
open ChimeFlutterHost.xcodeproj                                   # opens immediately

# To build, first generate the module glue (.ios/Flutter/podhelper.rb) — needs Flutter installed:
../../scripts/prepare-flutter-module.sh                           # or: (cd ../flutter_call_module && flutter pub get)
pod install                                                       # → ChimeFlutterHost.xcworkspace
open ChimeFlutterHost.xcworkspace                                 # use the workspace to build/run
# Set a Team + unique bundle id, then run on a real device (CallKit/audio need a device).
```

> Regenerate the project after editing `project.yml` with `brew install xcodegen && xcodegen generate`.

### Runtime configuration (`HostConfig` in [`HostApp/AppDelegate.swift`](./HostApp/AppDelegate.swift))

Both values are read from **scheme environment variables** (Product → Scheme → Edit Scheme… → Run →
Arguments → Environment Variables) and handed to the Flutter module over the `getConfig` bridge:

| Env var | Values | Behaviour |
|---------|--------|-----------|
| `BACKEND_BASE_URL` | the `ApiBaseUrl` output of `sam deploy` | Where calls are started. Missing → the module shows its setup screen. |
| `ENABLED_CALL_TYPES` | `audio,video` (default) · `audio` · `video` | Both → the call screen shows the Audio/Video chooser. One → the chooser is skipped and that type dials immediately when the call screen opens. |

Auth is bring-your-own: return your app's session token from `AuthService.currentJwt()` (empty =
no `Authorization` header; see [docs/DEPLOYMENT.md §2](../../docs/DEPLOYMENT.md)).

## Entitlements & capabilities (already wired) — required for "like WhatsApp"

| File | Key | Why |
|------|-----|-----|
| [`HostApp/Info.plist`](./HostApp/Info.plist) | `UIBackgroundModes = [audio, voip]` | keep the call alive & play audio in the background |
| | `NSMicrophoneUsageDescription` / `NSCameraUsageDescription` | Chime mic/camera |
| [`HostApp/HostApp.entitlements`](./HostApp/HostApp.entitlements) | `aps-environment` | Push Notifications capability (for future PushKit inbound calls) |
| Xcode → Signing & Capabilities | **Background Modes** (Voice over IP + Audio) and **Push Notifications** | produce the above |

> **CallKit itself needs no entitlement.** For *incoming* calls (agent calls the customer) you'd add
> PushKit VoIP push handling in the AppDelegate (report to CallKit within the push handler) and an APNs
> VoIP key — scaffolding noted but out of v1 scope (v1 is customer‑initiated outbound).

## Key files

| File | Role |
|------|------|
| [`project.yml`](./project.yml) | XcodeGen target (Info.plist, entitlements, sources) |
| [`HostApp/AppDelegate.swift`](./HostApp/AppDelegate.swift) | cached `FlutterEngine`, plugin registration, host bridge |
| [`HostApp/HostRoot.swift`](./HostApp/HostRoot.swift) | SwiftUI home + presents the Flutter call screen |
| [`Podfile`](./Podfile) | embeds the Flutter module + its pods (incl. `AmazonChimeSDK`) |

Embedded module: [`native/flutter_call_module`](../flutter_call_module) (run `flutter pub get` there
first). Dart entrypoint: its `lib/main.dart` → `mainHost`, with `ConnectWebRtcConfig(callKitEnabled: true)`.
