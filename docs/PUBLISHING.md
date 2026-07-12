# Publishing `flutter_amazon_connect_webrtc` & Integrating It Into Your App

This is the complete guide for (A) **publishing** the Flutter library and (B) everything a
third‑party developer must configure to **integrate** it — Dart, iOS, Android, backend — including
every pitfall we hit building the reference apps, with fixes.

---

## Part A — Publishing the library

The package lives at [`packages/flutter_amazon_connect_webrtc`](../packages/flutter_amazon_connect_webrtc).
It is a **federated-style plugin in one package**: Dart API + iOS (Swift/CallKit/Chime SDK) + Android
(Kotlin/Telecom/Chime SDK).

### A.1 Choose a distribution channel

| Channel | When | How consumers depend on it |
|---|---|---|
| **pub.dev** (public) | Open-sourcing it | `flutter_amazon_connect_webrtc: ^1.0.0` |
| **Git dependency** | Team/private use, fastest | `git: { url: …, path: packages/flutter_amazon_connect_webrtc, ref: v1.0.0 }` |
| **Private pub server** ([unpub](https://pub.dev/packages/unpub), Cloudsmith, JFrog) | Enterprises with artifact governance | `hosted: { name: …, url: https://pub.yourco.com }` |
| **Path dependency** | Monorepo apps | `path: ../packages/flutter_amazon_connect_webrtc` |

### A.2 Pre-publish checklist (pub.dev)

1. **pubspec.yaml metadata** — set a real `homepage:`/`repository:` (currently a placeholder),
   remove `publish_to: none`, keep `version:` semver.
2. **LICENSE** — present (MIT). pub.dev requires one.
3. **CHANGELOG.md** — create it; pub.dev renders it. Start with `## 1.0.0`.
4. **README.md for the package** — pub.dev shows the package README, not the repo root's. Put the
   quickstart (Part B.2 below) in `packages/flutter_amazon_connect_webrtc/README.md`.
5. **API docs** — the public API is doc-commented; verify with `dart doc`.
6. **Dry run + publish**:
   ```bash
   cd packages/flutter_amazon_connect_webrtc
   flutter analyze && flutter test          # gate: clean + 28 tests green
   dart pub publish --dry-run               # fix every warning it reports
   dart pub publish
   ```
7. **Versioning** — semver. Native-interface changes (channel contract, podspec/gradle deps) are
   **breaking** → major bump. Tag releases in git (`v1.0.0`) so git-dependency users can pin refs.

### A.3 What ships in the package

- `lib/` — Dart API: `ConnectWebRtcController`, `ConnectWebRtcConfig`, models, `ConnectVideoView`,
  typed exceptions.
- `ios/` — Swift: CallKit integration, Chime meeting session, PlatformView; podspec pins
  `AmazonChimeSDK ~> 0.27.0`, **iOS 14+**.
- `android/` — Kotlin: Jetpack Telecom (`androidx.core:core-telecom`), Chime session, foreground
  service, PlatformView; gradle pins `software.aws.chimesdk:amazon-chime-sdk:0.25.4`, **minSdk 26**.
- The **backend is NOT part of the package** — integrators deploy their own (Part B.6) or implement
  the same HTTP contract.

---

## Part B — Integrator guide (for any developer using the library)

### B.0 What this library does

Lets a customer in your app place a **VoIP audio / WebRTC video call into Amazon Connect** using the
native Amazon Chime SDK, with **OS-level calling** (CallKit on iOS, Telecom on Android — lock-screen
controls, correct audio routing, "like WhatsApp"). Your customer context (issue type, tier, …) is
sent as Connect **contact attributes** so your contact flow routes to the right queue.

```
Your app ──(Dart API)── plugin ──HTTPS──▶ your backend ──▶ connect:StartWebRTCContact
                          │◀── CallSession (Chime meeting + attendee) ──┘
                          └── native Chime SDK ══ WebRTC media ══▶ Amazon Connect queue/agent
```

### B.1 Prerequisites

| Requirement | Detail |
|---|---|
| Amazon Connect instance | with **in-app/web calling** enabled; a **published inbound contact flow** that routes on your attributes (importable example: [`docs/connect/chimeflutter-inapp-routing.json`](./connect/README.md)) |
| A backend | deploy [`backend/`](../backend) with SAM (5 min, Part B.6) **or** implement the [HTTP contract](../specs/003-api-contracts.md) in your own stack |
| Flutter | 3.19+ |
| iOS | 15+ device (CallKit/audio need real hardware), Xcode 15+ |
| Android | minSdk 26 (Android 8.0), compileSdk 35+, JDK 17+ |

### B.2 Dart quickstart

```yaml
dependencies:
  flutter_amazon_connect_webrtc: ^1.0.0
```

```dart
final controller = ConnectWebRtcController(
  config: ConnectWebRtcConfig(
    backendBaseUrl: Uri.parse('https://<your-api>/v1'),
    callKitEnabled: true,            // OS call UI: CallKit (iOS) / Telecom (Android)
    callDisplayName: 'Support',      // name shown in the system call UI
  ),
  // YOUR auth: return your session/bearer token (sent as `Authorization: Bearer <token>`),
  // or '' for no Authorization header. The plugin never stores it.
  tokenProvider: () async => myAuth.currentToken(),
);

// Start a call — context drives Connect queue routing (server allow-lists the keys).
await controller.startCall(CallRequest(
  callType: CallType.audio,                        // or CallType.video
  device: DeviceInfo.forCurrentPlatform(appVersion: '1.0.0'),
  context: {'issueType': 'billing', 'tier': 'gold'},
));

controller.state;                                  // ValueListenable<CallState>
controller.events.listen((e) { /* tiles, participants, errors */ });
await controller.setMuted(true);
await controller.setSpeakerphone(true);
await controller.sendDtmf('1');              // IVR keypad ("Press 1 for billing…")
await controller.enableLocalVideo();
await controller.endCall();
controller.dispose();
```

Video tiles: listen for `LocalVideoTileAdded` / `RemoteVideoTileAdded` events and render
`ConnectVideoView(tileId: …)` (a PlatformView hosting the Chime render view). Full API reference:
the doc comments + [`specs/003-api-contracts.md`](../specs/003-api-contracts.md).

Lifecycle: `idle → connecting → ringing → connected ⇄ reconnecting → disconnected | failed`.
All failures are typed (`PermissionDeniedException`, `AuthException`, `RateLimitedException`,
`BackendException`, `MediaException`).

### B.3 iOS host configuration (required)

**1. Podfile** — platform floor **and** the permission macros (without the macros,
`permission_handler` compiles permissions out and *returns denied without ever prompting*):

```ruby
platform :ios, '15.0'    # plugin minimum is 14.0 (CallKit CXProviderConfiguration())

post_install do |installer|
  # flutter_post_install(installer) if defined?(flutter_post_install)   # add-to-app only
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'PERMISSION_MICROPHONE=1'
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'PERMISSION_CAMERA=1'
    end
  end
end
```

**2. Info.plist**:
```xml
<key>NSMicrophoneUsageDescription</key><string>Voice calls with support</string>
<key>NSCameraUsageDescription</key><string>Video calls with support</string>
<key>UIBackgroundModes</key>
<array><string>audio</string><string>voip</string></array>
```

**3. Xcode capabilities** — *Background Modes* (Voice over IP + Audio). CallKit itself needs **no
entitlement**. (*Push Notifications*/`aps-environment` only when you add PushKit inbound calls.)

**4. Build settings** — `ENABLE_USER_SCRIPT_SANDBOXING = NO` (Xcode 15+ default breaks Flutter's
build script phase).

**5. Debug runs on iOS 17+/26** — set the scheme's **LLDB Init File** to
`$(SRCROOT)/Flutter/ephemeral/flutter_lldbinit` (app) or
`…/<module>/.ios/Flutter/ephemeral/flutter_lldbinit` (add-to-app), or run Release. Otherwise
debug-mode Dart fails with `EXC_BAD_ACCESS (debugger assist: not detected)`.

### B.4 Android host configuration (required)

**1. Gradle** — `minSdk 26`, `compileSdk 35+` (36 for Flutter 3.44 AARs), JDK 17, and a modern
toolchain (verified combo: Gradle 8.11.1 / AGP 8.9.2 / Kotlin 2.3.21).

**2. Permissions** — the plugin's manifest already declares everything (`RECORD_AUDIO`, `CAMERA`,
`MANAGE_OWN_CALLS`, `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT`, `FOREGROUND_SERVICE` +
`FOREGROUND_SERVICE_PHONE_CALL|MICROPHONE`, `BLUETOOTH_CONNECT`, …). Your app must **request the
runtime ones** before starting a call:

```kotlin
requestPermissions(arrayOf(
    Manifest.permission.RECORD_AUDIO,
    Manifest.permission.CAMERA,                    // video calls
    Manifest.permission.POST_NOTIFICATIONS,        // API 33+
))
```

**3. Nothing else** — the Telecom registration, `phoneCall|microphone` foreground service and
`CallStyle` notification are inside the plugin.

### B.5 Add-to-app (embedding in an existing native app)

If your app is native (not Flutter), embed via a **Flutter module** that depends on this plugin —
reference implementation: [`native/flutter_call_module`](../native/flutter_call_module) +
[`native/ios-host`](../native/ios-host) + [`native/android-host`](../native/android-host). Key facts
learned the hard way:

- **A module, not an app**: only `flutter create --template module` projects generate the
  `.ios/podhelper.rb` / `.android/include_flutter.groovy` glue hosts need. Run `flutter pub get` in
  the module before the first host build.
- **`--dart-define` does NOT reach an embedded engine.** Pass runtime config (backend URL, etc.)
  from the host over a MethodChannel. The reference bridge contract
  (`com.chimeflutter.host/bridge`): host implements `getConfig`, `getAuthToken`,
  `getCustomerContext`, `minimize`; module calls back `onCallStateChanged`, `onCallEnded`; host can
  drive `startCall` / `endCall` / `setMuted`.
- **`getConfig` keys**: `backendBaseUrl` (required) and `enabledCallTypes` — `"audio,video"`
  (default: the call screen shows an Audio/Video chooser) or `"audio"` / `"video"` (the chooser is
  skipped and that type dials immediately when the screen opens; video-only controls are hidden on
  audio-only). Set them in `HostConfig` (iOS `AppDelegate.swift` / Android `HostApplication.kt`);
  standalone module runs use the equivalent dart-defines (`BACKEND_BASE_URL`,
  `ENABLED_CALL_TYPES`). Unrecognised/empty values fall back to both.
- **Android: consume the module as AARs** (`flutter build aar`), not source-include —
  source-mode `include_flutter` cannot feed the `flutter.*` extension to Kotlin-DSL plugins
  (e.g. `device_info_plus`), which breaks the build. Wire the two maven repos + 
  `debugImplementation '<module-group>:flutter_debug:1.0'` etc.
- **Cache one `FlutterEngine`** at app start (`mainHost` entrypoint) so the call screen opens
  instantly and survives being dismissed — that's what enables "browse the app during the call"
  (minimize → green call bar → return).

### B.6 The backend

Deploy the reference backend (API Gateway + Lambda, SAM):

```bash
cd backend && npm ci && npm test
export PATH="$PWD/node_modules/.bin:$PATH" && sam build
sam deploy --guided --parameter-overrides \
  ConnectInstanceId=<your-instance-id> ConnectContactFlowId=<your-flow-id>
# → output ApiBaseUrl = the plugin's backendBaseUrl
```

Its IAM is least-privilege (`StartWebRTCContact`/`StopContact` on your instance + `contact/*` +
`contact-flow/*` only). Contract details, attribute allow-listing and error envelope:
[`specs/003-api-contracts.md`](../specs/003-api-contracts.md).

> ⚠️ **Auth is bring-your-own.** The API deploys **unauthenticated** so you can integrate your own
> identity. Before production, front it with your auth: re-attach an API Gateway JWT/Lambda
> authorizer for your IdP, an API key, or WAF rules. The plugin already sends
> `Authorization: Bearer <tokenProvider()>` whenever your `tokenProvider` returns a token — so
> enabling a JWT authorizer requires **zero client changes**.

### B.7 Troubleshooting (every one of these happened for real)

| Symptom | Cause → Fix |
|---|---|
| `pod install`: “cannot load podhelper.rb” | Pointing at a Flutter *app*, not a *module*; or `flutter pub get` not run in the module. |
| `pod install`: “higher minimum deployment target” | Podfile `platform :ios` below 14 → set 15. |
| Xcode: `PhaseScriptExecution failed` on Flutter build script | 1) `xcrun --show-sdk-path --sdk iphonesimulator` failing because `xcode-select` points at CommandLineTools → `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. 2) User Script Sandboxing → set to **No**. |
| `Module 'x' not found` in `GeneratedPluginRegistrant` | Plugin set changed after last `pod install` → `flutter pub get` (module) + `pod install` (host). |
| App won’t launch: “doesn’t declare the proper UIBackgroundMode” | `UIBackgroundModes` policy on new iOS — declare `audio` + `voip`. |
| Debug run: `EXC_BAD_ACCESS (debugger assist: not detected)` | LLDB Init File not set (B.3.5) — or run Release. |
| Call fails instantly with `permissionDenied`, no OS prompt | Missing `PERMISSION_MICROPHONE=1`/`PERMISSION_CAMERA=1` Podfile macros (B.3.1). |
| Speaker button doesn’t go loud | Fixed in ≥1.0: routing goes through Chime’s device controller (iOS) / Telecom endpoints (Android) — don’t drive `AVAudioSession`/`AudioManager` yourself. |
| Android: `flutter.compileSdkVersion` unresolved in a plugin’s `.kts` | Source-mode add-to-app include → consume the module as **AARs** (B.5). |
| Android: duplicate `lib*.so` from two deps | `packagingOptions { jniLibs { pickFirsts += ['**/libX.so'] } }`. |
| Backend 502 `UPSTREAM_ERROR` | Check the Lambda’s CloudWatch log: commonly missing IAM on `…instance/<id>/contact-flow/*`, wrong/unpublished ContactFlowId, or in-app calling not enabled on the instance. |
| Contact reaches Connect but wrong queue | Contact flow must branch on `$.Attributes.<key>`; only server-allow-listed keys pass through. |

### B.8 Production checklist

- [ ] Your auth in front of the API (B.6) — the demo deploy is open.
- [ ] `StopContact` ownership check if you expose DELETE broadly ([known limitation](../specs/005-security.md)).
- [ ] Real APNs/CallKit review items: `voip` background mode justified, mic/camera purpose strings.
- [ ] Test on real devices: cellular-call interruption, Bluetooth routing, backgrounding mid-call.
- [ ] Pin plugin + Chime SDK versions; watch `amazon-chime-sdk-ios/-android` releases.
