# Getting Started — put "Call support" in your app, end to end

This guide takes you from an empty AWS account to a phone that places a real VoIP/video call into
Amazon Connect, using the `flutter_amazon_connect_webrtc` library. It is written for someone doing
this for the **first time**: every command, every file you must touch, and every native-side config
is spelled out, with the reasons why.

**What you'll have at the end:** a "Call support" button in your app. Tapping it starts a call that
your OS treats like a real phone call (CallKit on iOS, Telecom on Android — lock-screen controls,
proper audio routing, "like WhatsApp"), routed to the right Amazon Connect queue based on who the
customer is, with an in-call DTMF keypad for IVR menus.

---

## 1. How it works (read this once — it explains every later step)

```
┌────────────────────┐  1. POST /calls {context}   ┌──────────────────┐  2. StartWebRTCContact  ┌────────────────┐
│  YOUR APP           │ ──────────────────────────▶ │  Backend          │ ──────────────────────▶ │ Amazon Connect │
│  ┌───────────────┐  │                             │  (API GW + Lambda)│                         │ (contact flow  │
│  │ Flutter plugin │ │ ◀────────────────────────── │                   │ ◀────────────────────── │  → queue →     │
│  └──────┬────────┘  │  3. Meeting + Attendee      └──────────────────┘                         │  agent)        │
│         │ join       │     (join credentials)                                                   └───────┬────────┘
│  ┌──────▼────────┐  │                                                                                   │
│  │ Chime SDK      │ │ ◀══════════════ 4. WebRTC media (audio/video) ══════════════════════════════════─┘
│  │ (native)       │ │
│  └───────────────┘  │
└────────────────────┘
```

Four pieces, four responsibilities:

1. **The backend** (in [`backend/`](../backend), deployed with AWS SAM) is the only thing that
   talks to the Amazon Connect *control plane*. Your app never holds AWS credentials, instance IDs
   or flow IDs — it just calls `POST /calls` with the customer's context, and the Lambda calls
   `StartWebRTCContact` and returns **join credentials** (a Chime `Meeting` + `Attendee`).
2. **The Flutter plugin** (`flutter_amazon_connect_webrtc`) fetches those credentials, then hands
   them to the **native Amazon Chime SDK** (Swift on iOS, Kotlin on Android) which does the actual
   WebRTC media. The plugin also registers the call with **CallKit / Telecom** so the OS knows a
   call is happening.
3. **Amazon Connect** receives the contact together with **contact attributes** (e.g.
   `issueType=billing`, `tier=gold`). Your contact flow branches on those attributes to pick the
   queue — that's how "gold" customers reach the priority queue.
4. **Your app** renders the call UI (or embeds the ready-made one in
   [`native/flutter_call_module`](../native/flutter_call_module)) and supplies configuration.

Keep this model in mind: **backend = control plane, plugin = media plane, attributes = routing.**

---

## 2. Prerequisites

### Accounts
- An **AWS account** with an **Amazon Connect instance** (any region that supports in-app calling,
  e.g. `eu-west-2`). Note your **instance ID** (Connect console → your instance → the ID in the ARN).
- AWS CLI configured (`aws configure`) with rights to deploy CloudFormation/SAM stacks.

### Tools (the versions this repo is verified against)

| Tool | Version | Check with |
|------|---------|-----------|
| Flutter SDK | 3.x (stable) | `flutter --version` |
| Node.js | 20+ | `node --version` |
| AWS SAM CLI | latest | `sam --version` |
| Xcode (iOS) | 16+ with full app; run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` | `xcode-select -p` must print `…/Xcode.app/…`, **not** `…/CommandLineTools` |
| CocoaPods (iOS) | 1.15+ | `pod --version` |
| Android Studio / SDK | compileSdk **36** installed | SDK Manager |
| JDK (Android) | 17 | `java -version` |

Native toolchain the reference Android host pins (copy these if you hit version errors):
**Gradle 8.11.1 · Android Gradle Plugin 8.9.2 · Kotlin 2.3.21 · compileSdk 36 · minSdk 26**.
The iOS side needs **iOS 15.0+ deployment target** (the plugin's podspec requires ≥ 14).

> ⚠️ The `xcode-select` line above is not optional. If it points at CommandLineTools, Flutter's
> native-assets build step fails with an inscrutable `PhaseScriptExecution failed` error.

### A phone
CallKit, Telecom, microphones and speakers behave differently (or not at all) on simulators.
**Test calls on a real device.**

---

## 3. Prepare Amazon Connect (console, ~10 minutes)

1. **Enable in-app calling** — Connect console → your instance → **Communication widgets** →
   enable *in-app, web and video calling*. (Your app calls the `StartWebRTCContact` API directly;
   you do **not** embed the web widget.)
2. **Create the contact flow** — you need a **standard inbound flow** (there is no special "WebRTC"
   flow type) that reads the injected attributes and routes:

   ```
   Entry → Check contact attributes ($.Attributes.tier == "gold") → Set working queue: Priority
         → Check contact attributes ($.Attributes.issueType)
              ├─ "billing" → Set working queue: Billing
              ├─ "tech"    → Set working queue: Technical
              └─ default   → Set working queue: General
         → Transfer to queue
   ```

   Fastest path: import the ready-made flow JSON in
   [`docs/connect/chimeflutter-inapp-routing.json`](./connect/chimeflutter-inapp-routing.json)
   (instructions + queue placeholders: [`docs/connect/README.md`](./connect/README.md)). **Publish**
   the flow, then copy its **flow ID**: open the flow → *Show additional flow information* → the ID
   is the last segment of the ARN.
3. **Agent** — give your test agent's security profile the **CCP** permission (and *Video calls –
   Access* if you want video). Have the agent open the Agent Workspace/CCP and go **Available**
   when you test.

You now have the two values the backend needs: **instance ID** and **contact flow ID**.

---

## 4. Deploy the backend (~5 minutes)

```bash
cd backend
npm ci                                      # install exact dependency versions
npm test                                    # 79 tests must pass — they run offline
export PATH="$PWD/node_modules/.bin:$PATH"  # so SAM's esbuild builder finds esbuild
sam build
sam deploy --guided \
  --stack-name chimeflutter-backend \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ConnectInstanceId=<your-connect-instance-id> \
    ConnectContactFlowId=<your-flow-id> \
    LogLevel=info
```

`sam deploy --guided` asks a few questions — accept the defaults, **deploy in the same region and
account as your Connect instance** (the Lambda's IAM policy is built from them; cross-region =
AccessDenied).

When it finishes, the stack **Outputs** include:

```
ApiBaseUrl   https://abc123xyz.execute-api.eu-west-2.amazonaws.com/v1
```

**Copy `ApiBaseUrl` — it is the single most important config value in this guide.** Every client
below calls it `backendBaseUrl`. Smoke-test it:

```bash
curl https://abc123xyz.execute-api.eu-west-2.amazonaws.com/v1/health
# → {"status":"ok","service":"chimeflutter-backend"}
```

> ⚠️ **The API deploys with NO authentication** so you can bring your own identity provider later
> (the client already sends `Authorization: Bearer <token>` when you give it one — see §8). Fine
> for development; **do not go to production with an open API** — anyone with the URL could start
> contacts into your instance. See [`docs/DEPLOYMENT.md §2`](./DEPLOYMENT.md).

---

## 5. Choose your integration path

| You have… | Use | Section |
|-----------|-----|---------|
| A **Flutter app** (or are starting fresh) | the plugin directly | §6 |
| An **existing native iOS/Android app** (Swift/Kotlin) | add-to-app: embed the Flutter *module*, which ships a complete call UI | §7 |

Both paths use the same backend and the same plugin underneath.

---

## 6. Path A — a Flutter app using the plugin directly

### 6.1 Add the dependency

```yaml
# pubspec.yaml
dependencies:
  flutter_amazon_connect_webrtc:
    path: ../packages/flutter_amazon_connect_webrtc   # or your pub/git reference once published
```

### 6.2 iOS project configuration (3 files — all required)

**(a) `ios/Podfile`** — two things: the platform version, and the permission macros. The
`permission_handler` pod **compiles each permission out unless its macro is defined** — without
this block the mic prompt never appears and every request instantly returns "denied":

```ruby
platform :ios, '15.0'

post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'PERMISSION_MICROPHONE=1'
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'PERMISSION_CAMERA=1'
    end
  end
end
```

**(b) `ios/Runner/Info.plist`** — usage strings (the OS kills apps that access mic/camera without
them) and background modes (keeps the call alive when the user leaves the app):

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

**(c) Xcode → target → Signing & Capabilities** — add the **Background Modes** capability and tick
*Audio, AirPlay, and Picture in Picture* + *Voice over IP* (this is what writes the plist array
above). **CallKit itself needs no entitlement** — nothing else to request from Apple.

Then: `cd ios && pod install` (rerun after any plugin change).

### 6.3 Android project configuration (2 files)

**(a) `android/app/build.gradle`** — `minSdk 26` (Telecom + Chime requirements), Java/Kotlin 17.

**(b) `android/app/src/main/AndroidManifest.xml`** — the full permission set (copy verbatim; each
line is load-bearing):

```xml
<!-- Media plane (Chime) -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<!-- Telecom self-managed VoIP (OS shows a real call) -->
<uses-permission android:name="android.permission.MANAGE_OWN_CALLS" />
<!-- Ongoing-call notification -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />
<!-- Keep the call alive in the background (Android 14 typed foreground service) -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_PHONE_CALL" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
```

Runtime prompts (`RECORD_AUDIO`, `CAMERA`, `POST_NOTIFICATIONS`) are handled by the plugin's
permission service before joining — you don't write permission code on this path.

### 6.4 The Dart code

```dart
import 'package:flutter_amazon_connect_webrtc/flutter_amazon_connect_webrtc.dart';

final controller = ConnectWebRtcController(
  config: ConnectWebRtcConfig(
    backendBaseUrl: Uri.parse('https://abc123xyz.execute-api.eu-west-2.amazonaws.com/v1'),
    callKitEnabled: true,          // register with CallKit / Telecom (the "like WhatsApp" part)
    callDisplayName: 'Support',
  ),
  tokenProvider: () async => '',   // return your session JWT once you add auth (empty = none)
);

// Start a call — context drives the Connect queue routing:
await controller.startCall(CallRequest(
  callType: CallType.audio,        // or CallType.video
  device: DeviceInfo.forCurrentPlatform(appVersion: '1.0.0'),
  context: {'issueType': 'billing', 'tier': 'gold'},
));

// React to state and events:
controller.states.listen((s) => debugPrint('call state: $s'));
controller.events.listen((e) {
  if (e is RemoteVideoTileAdded) { /* setState(() => remoteTile = e.tileId) */ }
});

// In-call controls:
await controller.setMuted(true);
await controller.setSpeakerphone(true); // routes via CallKit/Telecom — never AudioManager directly
await controller.sendDtmf('1');         // IVR "press 1" — sent via the Connect Participant Service
await controller.endCall();
```

Video tiles are widgets: `ConnectVideoView(tileId: remoteTile)` fills a `Positioned.fill`, local
preview uses `mirror: true`. A complete working screen (chooser, controls, keypad, video) is in
[`packages/flutter_amazon_connect_webrtc/example/lib/main.dart`](../packages/flutter_amazon_connect_webrtc/example/lib/main.dart)
— and the fuller one in [`native/flutter_call_module/lib/main.dart`](../native/flutter_call_module/lib/main.dart).

Run it: `flutter run --dart-define=BACKEND_BASE_URL=https://…/v1` (the example reads that define).
**Skip to §9 (first call).**

---

## 7. Path B — embedding in an existing NATIVE app (add-to-app)

This is the path the two reference hosts implement. Read §7.1 before typing anything — add-to-app
has three concepts that, once understood, make every file below obvious.

### 7.1 The three concepts

1. **You embed a Flutter *module*, not a Flutter app.** Only a project created with
   `flutter create --template=module` generates the hidden `.ios/` and `.android/` glue folders
   that native builds hook into (`podhelper.rb` for CocoaPods, AAR artifacts for Gradle). This repo
   ships one, with a complete WhatsApp-style call UI:
   [`native/flutter_call_module`](../native/flutter_call_module).
2. **`--dart-define` does NOT reach an embedded engine.** All runtime config (backend URL, enabled
   call types, auth token, customer context) flows from **your native code** to Dart over one
   `MethodChannel` — the **host bridge** (`com.chimeflutter.host/bridge`). Your native app is the
   source of truth; §7.4/§7.5 show the exact Swift/Kotlin.
3. **Cache one FlutterEngine at app start.** Starting an engine takes ~1s; caching it at launch
   makes the call screen open instantly — and because the engine (and the native call session)
   outlive the call screen, the user can **dismiss the call UI and keep browsing your app while
   the call continues** (your app shows a "return to call" bar).

**The bridge contract** (implement all of these in your native handler):

| Direction | Method | Payload → Reply | Purpose |
|-----------|--------|-----------------|---------|
| Dart → native | `getConfig` | → `{backendBaseUrl, enabledCallTypes}` | runtime config (§8) |
| Dart → native | `getAuthToken` | → `String` (empty = no auth header) | your session JWT |
| Dart → native | `getCustomerContext` | → `{issueType, tier, …}` | routing attributes |
| Dart → native | `minimize` | → – | user swiped the call screen away; hide it, keep the call |
| native → Dart | `startCall` | `{callType: "audio"|"video"}` | start a call from native UI |
| native → Dart | `endCall`, `setMuted` | – / `{muted: bool}` | control from native UI |
| Dart → native | `onCallStateChanged` | `{state}` | drive your "return to call" banner |
| Dart → native | `onCallEnded` | `{state}` | dismiss the call screen |

### 7.2 Prepare the module (once, and after every clean checkout)

```bash
cd native/flutter_call_module
flutter pub get          # generates .ios/ and .android/ (the add-to-app glue)
```

### 7.3 iOS host — every file explained

Reference: [`native/ios-host`](../native/ios-host). Steps for wiring it into *your* app:

**Step 1 — Podfile.** Load the module's podhelper and enable the permission macros
(same reason as §6.2a):

```ruby
platform :ios, '15.0'

flutter_application_path = '../flutter_call_module'    # ← path to the module from YOUR app
load File.join(flutter_application_path, '.ios', 'Flutter', 'podhelper.rb')

target 'HostApp' do                                    # ← your app target
  use_frameworks!
  install_all_flutter_pods(flutter_application_path)
end

post_install do |installer|
  flutter_post_install(installer) if defined?(flutter_post_install)
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'PERMISSION_MICROPHONE=1'
      config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'PERMISSION_CAMERA=1'
    end
  end
end
```

Run `pod install`, then **always open the `.xcworkspace`** (not the `.xcodeproj`).

**Step 2 — engine + bridge in your AppDelegate.** This is the heart of the integration
(full file: [`HostApp/AppDelegate.swift`](../native/ios-host/HostApp/AppDelegate.swift)):

```swift
import Flutter
import FlutterPluginRegistrant

/// Your app is the source of truth for config (dart-defines don't reach embedded engines).
enum HostConfig {
    static let backendBaseUrl =
        ProcessInfo.processInfo.environment["BACKEND_BASE_URL"] ?? ""       // §8
    static let enabledCallTypes =
        ProcessInfo.processInfo.environment["ENABLED_CALL_TYPES"] ?? "audio,video"
}

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    lazy var flutterEngine = FlutterEngine(name: "chime_call_engine")
    var bridgeChannel: FlutterMethodChannel?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        flutterEngine.run(withEntrypoint: "mainHost")   // the module's add-to-app entrypoint
        GeneratedPluginRegistrant.register(with: flutterEngine)
        setupHostBridge()
        return true
    }

    private func setupHostBridge() {
        let channel = FlutterMethodChannel(
            name: "com.chimeflutter.host/bridge",
            binaryMessenger: flutterEngine.binaryMessenger)
        bridgeChannel = channel

        channel.setMethodCallHandler { call, result in
            switch call.method {
            case "getConfig":
                result(["backendBaseUrl": HostConfig.backendBaseUrl,
                        "enabledCallTypes": HostConfig.enabledCallTypes])
            case "getAuthToken":
                result("")                               // ← your session JWT when you add auth
            case "getCustomerContext":
                result(["issueType": "billing", "tier": "gold"])   // ← from YOUR user session
            case "onCallStateChanged":
                // update your "return to call" banner
                result(nil)
            case "onCallEnded":
                // dismiss the call screen if it is presented
                result(nil)
            case "minimize":
                // hide the call screen; the call keeps running
                result(nil)
            default:
                result(FlutterMethodNotImplemented)
            }
        }
    }
}
```

**Step 3 — present the call screen.** Show a `FlutterViewController` on the cached engine as a
**sheet** — users minimize it with the platform-native swipe-down, exactly like WhatsApp:

```swift
let callVC = FlutterViewController(engine: appDelegate.flutterEngine, nibName: nil, bundle: nil)
callVC.modalPresentationStyle = .pageSheet   // swipe down = minimize; call keeps running
present(callVC, animated: true)
```

(The reference host does this from SwiftUI with a `.sheet` — see
[`HostApp/HostRoot.swift`](../native/ios-host/HostApp/HostRoot.swift), which also implements the
green "🔊 Tap to return to call" bar shown above the navigation stack while minimized.)

**Step 4 — Info.plist + capabilities.** Same as §6.2 b/c: mic + camera usage strings,
`UIBackgroundModes` = `audio` + `voip`, Background Modes capability. No CallKit entitlement exists.

**Step 5 — two Xcode gotchas (both hit during this repo's bring-up):**
- Build Settings → **User Script Sandboxing = No** (Flutter's build phase writes outside the sandbox).
- Debugging Dart on iOS 17+? Edit Scheme → Run → uncheck nothing, but add the **LLDB Init File**:
  `$(SRCROOT)/../flutter_call_module/.ios/Flutter/ephemeral/flutter_lldbinit` — without it the
  debugger crashes the app with `EXC_BAD_ACCESS` the moment Dart runs.

### 7.4 Android host — every file explained

Reference: [`native/android-host`](../native/android-host). The module is consumed as **AARs**
(prebuilt archives) — *not* source-included. (Source mode breaks on plugins that use Kotlin-DSL
build scripts, e.g. `device_info_plus`.) That has one workflow consequence, boxed below.

**Step 1 — build the module AARs:**

```bash
cd native/flutter_call_module
flutter build aar --no-profile
# → build/host/outputs/repo/  (a local maven repository)
```

> 📦 **The one Android rule to remember:** the host consumes *prebuilt* AARs. After ANY Dart
> change (module or plugin), rerun `flutter build aar --no-profile` before building the host —
> otherwise you run stale Dart. (iOS recompiles Dart in Xcode's build phase; Android does not.)

**Step 2 — root `build.gradle`:** declare where the AARs and Flutter engine artifacts live:

```groovy
buildscript {
    ext.kotlin_version = '2.3.21'        // Flutter 3.4x AARs need a modern Kotlin — older ICEs
    dependencies {
        classpath 'com.android.tools.build:gradle:8.9.2'
        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version"
    }
}
allprojects {
    repositories {
        google(); mavenCentral()
        maven { url "${rootProject.projectDir}/../flutter_call_module/build/host/outputs/repo" }
        maven { url 'https://storage.googleapis.com/download.flutter.io' }
    }
}
```

**Step 3 — `app/build.gradle`:** `compileSdk 36` (the AAR metadata requires it), `minSdk 26`,
Java 17, and the module dependency:

```groovy
android { compileSdk 36; defaultConfig { minSdk 26 } /* Java 17 compile options */ }
dependencies {
    debugImplementation  'com.chimeflutter.callmodule:flutter_debug:1.0'
    releaseImplementation 'com.chimeflutter.callmodule:flutter_release:1.0'
    implementation 'androidx.core:core-telecom:1.0.0'
}
```

**Step 4 — manifest:** the full permission block from §6.3b, plus the two activities — yours and
Flutter's:

```xml
<application android:name=".HostApplication" …>
    <activity android:name=".MainActivity" android:exported="true">…</activity>
    <!-- The Flutter call UI, launched with the cached engine: -->
    <activity
        android:name="io.flutter.embedding.android.FlutterActivity"
        android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"
        android:hardwareAccelerated="true"
        android:windowSoftInputMode="adjustResize" />
</application>
```

**Step 5 — engine + bridge in your Application class** (full file:
[`HostApplication.kt`](../native/android-host/app/src/main/kotlin/com/chimeflutter/hostapp/HostApplication.kt)):

```kotlin
class HostApplication : Application() {
    lateinit var flutterEngine: FlutterEngine
    private var bridge: MethodChannel? = null

    override fun onCreate() {
        super.onCreate()
        flutterEngine = FlutterEngine(this)
        flutterEngine.dartExecutor.executeDartEntrypoint(
            DartExecutor.DartEntrypoint(
                FlutterInjector.instance().flutterLoader().findAppBundlePath(),
                "mainHost",                                   // the module's add-to-app entrypoint
            ),
        )
        FlutterEngineCache.getInstance().put(ENGINE_ID, flutterEngine)

        bridge = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.chimeflutter.host/bridge")
        bridge?.setMethodCallHandler { call, result ->
            when (call.method) {
                "getConfig" -> result.success(mapOf(
                    "backendBaseUrl" to HostConfig.backendBaseUrl,
                    "enabledCallTypes" to HostConfig.enabledCallTypes,
                ))
                "getAuthToken" -> result.success("")          // ← your session JWT when you add auth
                "getCustomerContext" -> result.success(
                    mapOf("issueType" to "billing", "tier" to "gold"))  // ← from YOUR user session
                "onCallStateChanged" -> { /* update your return-to-call banner */ result.success(null) }
                "onCallEnded" -> { /* finish the call activity */ result.success(null) }
                "minimize" -> {
                    (currentActivity as? io.flutter.embedding.android.FlutterActivity)?.finish()
                    result.success(null)                      // call keeps running (Telecom + engine)
                }
                else -> result.notImplemented()
            }
        }
    }
    companion object { const val ENGINE_ID = "chime_call_engine" }
}

object HostConfig {
    val backendBaseUrl: String =
        System.getenv("BACKEND_BASE_URL") ?: "https://YOUR_API_ID.execute-api.<region>.amazonaws.com/v1"
    val enabledCallTypes: String = System.getenv("ENABLED_CALL_TYPES") ?: "audio,video"
}
```

**Step 6 — open the call screen** (after requesting `RECORD_AUDIO` / `CAMERA` /
`POST_NOTIFICATIONS` at runtime — see
[`MainActivity.kt`](../native/android-host/app/src/main/kotlin/com/chimeflutter/hostapp/MainActivity.kt)):

```kotlin
startActivity(FlutterActivity.withCachedEngine(HostApplication.ENGINE_ID).build(this))
```

The user minimizes with the system **back gesture** (the call keeps running under Telecom + the
foreground service); your `onCallStateChanged` handler shows the green "return to call" banner
that relaunches the same intent.

**Step 7 — build:**

```bash
cd native/android-host          # or your app
./gradlew :app:assembleDebug    # needs local.properties with sdk.dir, or ANDROID_HOME set
```

### 7.5 Module UI you get for free

The module's call screen already implements: audio/video chooser (or auto-dial, §8), CallKit/Telecom
registration, mute / speaker / camera-flip, remote + local (PiP) video tiles, a **DTMF keypad**
("press 1 for billing" — digits travel via the Connect Participant Service, not the audio stream),
platform-native minimize, and a friendly setup screen when `backendBaseUrl` is missing.

---

## 8. Configuration reference — every knob, and exactly where it lives

| Value | What it does | Pure Flutter (§6) | iOS host (§7) | Android host (§7) |
|-------|--------------|-------------------|---------------|-------------------|
| `backendBaseUrl` | the deployed `ApiBaseUrl` — where calls start | `ConnectWebRtcConfig(backendBaseUrl:)` | `HostConfig.backendBaseUrl` in `AppDelegate.swift`; override via scheme env var `BACKEND_BASE_URL` | `HostConfig.backendBaseUrl` in `HostApplication.kt` |
| `enabledCallTypes` | `"audio,video"` = show the Audio/Video chooser; `"audio"` or `"video"` = **skip the chooser and dial that type immediately** when the call screen opens (audio-only also hides the in-call video/flip buttons) | your own UI decides | `HostConfig.enabledCallTypes`; scheme env var `ENABLED_CALL_TYPES` | `HostConfig.enabledCallTypes` |
| `tokenProvider` / `getAuthToken` | bearer token sent as `Authorization` (empty = none) | `tokenProvider:` closure | `getAuthToken` bridge case | `getAuthToken` bridge case |
| customer context | contact attributes Connect routes on (server allow-lists keys: `issueType, tier, …` — see `AllowedClientAttributeKeys` in [`backend/template.yaml`](../backend/template.yaml)) | `CallRequest(context:)` | `getCustomerContext` bridge case | `getCustomerContext` bridge case |
| `callKitEnabled` | register with CallKit/Telecom (leave `true`) | `ConnectWebRtcConfig` | set in the module | set in the module |

To set an Xcode **scheme environment variable**: Product → Scheme → Edit Scheme… → Run →
Arguments → Environment Variables → `+`. These apply to Xcode launches; for TestFlight/production
builds, put real values in `HostConfig` (or wire your own remote config).

---

## 9. Your first call — what you should see

1. Agent side: open the Connect **Agent Workspace/CCP**, set yourself **Available**.
2. App side: launch on a **real device** → tap *Call support* → (chooser, unless you set a single
   `enabledCallTypes`) → OS mic prompt (first run) → status goes `connecting → ringing → connected`.
3. The OS treats it as a real call: iOS shows the green call indicator/Dynamic Island; Android
   shows the ongoing-call notification.
4. The agent's CCP pops the contact — routed by your flow to the queue matching the attributes
   (`tier=gold` → Priority in the demo).
5. In-call: try mute, speaker (it routes through CallKit/Telecom, so it actually gets loud),
   **Keypad** → press digits to drive an IVR, and minimize (swipe down on iOS / back gesture on
   Android) → browse your app with the green bar showing → tap it to return.
6. Hang up from either side; state goes `disconnected` and the backend `DELETE /calls/{contactId}`
   fires best-effort.

---

## 10. Troubleshooting (every one of these was hit while building this repo)

| Symptom | Cause → Fix |
|---------|-------------|
| Mic/camera permission **instantly denied**, no prompt (iOS) | `permission_handler` macros missing → §6.2a Podfile `post_install` block, then `pod install` |
| `cannot load …/.ios/Flutter/podhelper.rb` | You pointed the Podfile at a Flutter *app* or never ran `flutter pub get` in the **module** → §7.2 |
| `PhaseScriptExecution failed` building iOS | `xcode-select` points at CommandLineTools → `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`; also set User Script Sandboxing = No |
| `EXC_BAD_ACCESS` the moment the app runs under the Xcode debugger | Missing LLDB init file → §7.3 step 5 |
| Call goes `connecting → failed` immediately | `backendBaseUrl` missing/wrong (the module shows a setup screen when unset) or backend not deployed → §4 smoke test |
| Backend returns 403 `AccessDeniedException` on start | Stack deployed in a different region/account than the Connect instance → §4 |
| Backend paths look like `/v1/v1/calls` | You appended `/v1` to a base URL that already ends in `/v1` — the stage supplies it |
| Android: `flutter.compileSdkVersion` unresolved / Kotlin "incompatible classes" ICE | Source-mode include or old Kotlin → AAR mode (§7.4) with Kotlin 2.3.21, AGP 8.9.2 |
| Android: `Dependency requires compileSdk 36` | Bump `compileSdk 36` (§7.4 step 3) |
| Android: `SDK location not found` | Create `local.properties` with `sdk.dir=/Users/you/Library/Android/sdk` (or set `ANDROID_HOME`) |
| Dart changes don't show up in the Android host | Stale AARs → rerun `flutter build aar --no-profile` (the boxed rule in §7.4) |
| Speaker button doesn't get louder | Something routes audio via `AVAudioSession`/`AudioManager` directly — CallKit/Telecom owns routing; use `controller.setSpeakerphone(...)` only |
| Video call connects but no remote video | Ensure the flow/agent have video enabled (§3.3) and you render `ConnectVideoView` from the `RemoteVideoTileAdded` event |

---

## 11. Before production

- **Add authentication** in front of the API (JWT authorizer for your IdP / API key / WAF). The
  client side is already done — return the token from `tokenProvider` / `getAuthToken`.
- Trim iOS `UIBackgroundModes` to `audio` + `voip` if you experimented with more.
- Review [`specs/005-security.md`](../specs/005-security.md) (attribute allow-listing, redaction,
  the StopContact ownership caveat) and the production checklist in
  [`docs/PUBLISHING.md`](./PUBLISHING.md).
- Rotate/regenerate any endpoint you ever committed or shared while testing.

---

## 12. Receiving calls — agent-initiated ("simulated outbound")

Everything above is the customer dialing **out**. The libraries can also receive calls the
**agent initiates**: the backend starts the contact on the customer's behalf, routes it straight
to that agent's personal queue (occupying their voice slot so they get no other calls while your
phone rings), and wakes the device with an APNs **VoIP** push (iOS) / high-priority **FCM** data
push (Android). The app shows the OS incoming-call UI and, on answer, joins over the exact same
media path.

The Dart surface is small:

```dart
await backend.registerDevice(customerId: ..., platform: ..., pushToken: ...); // once, after sign-in
controller.events.listen((e) { /* IncomingCallAnswered → controller.answerIncomingCall(...) */ });
await controller.handlePendingIncomingCall(); // cold start: user answered before Flutter ran
```

The one-time setup (SNS platform applications, the outbound contact flow import, PushKit wiring in
the iOS host, a FirebaseMessagingService on Android) is a step-by-step guide of its own:
**[OUTBOUND_CALLS.md](./OUTBOUND_CALLS.md)**.

---

**Deeper dives:** [`INTEGRATION.md`](./INTEGRATION.md) (concepts) ·
[`OUTBOUND_CALLS.md`](./OUTBOUND_CALLS.md) (agent-initiated calls into the app) ·
[`DEPLOYMENT.md`](./DEPLOYMENT.md) (backend runbook) · [`PUBLISHING.md`](./PUBLISHING.md)
(publishing the library + full integrator reference) ·
[`SYSTEM_CALL_UI.md`](./SYSTEM_CALL_UI.md) (CallKit/Telecom details) ·
[`specs/003-api-contracts.md`](../specs/003-api-contracts.md) (every API/channel contract).
