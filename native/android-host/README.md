# Native Android host app (add-to-app + Telecom)

A **proper, buildable native Android app** (Gradle) that embeds the ChimeFlutter module and places
VoIP/WebRTC calls into Amazon Connect. The OS treats the call as a **real call** ("like WhatsApp")
because the `flutter_amazon_connect_webrtc` plugin reports it to **Android Telecom** (Jetpack
`androidx.core.telecom` `CallsManager`, self-managed).

## Architecture

```
MainActivity (native) ─"Call support"─▶ FlutterActivity (cached FlutterEngine, entrypoint `mainHost`)
      │  bridge: com.chimeflutter.host/bridge                      │
      │  ← getAuthToken / getCustomerContext                       ▼
      │  → startCall / (endCall)                          ConnectWebRtcController
      └───────────────────────────────────────────────────────────┤
                                        flutter_amazon_connect_webrtc (plugin)
                                        ├── ConnectTelecomManager  → Telecom CallsManager (system UI)
                                        └── ChimeCallManager       → Amazon Chime SDK (media)
                                                    media starts in Telecom onSetActive
```

The host owns **auth + context** and requests runtime permissions; the plugin owns **Telecom + Chime**
(Telecom owns audio routing/focus; Chime rides `STREAM_VOICE_CALL`).

## Build & run  (verified: `BUILD SUCCESSFUL`)

The Flutter module is consumed as **AARs** (Flutter's recommended host integration — source-mode
`include_flutter` cannot feed the `flutter.*` extension to Kotlin-DSL plugins like
`device_info_plus`). Toolchain: **Gradle 8.11.1 · AGP 8.9.2 · Kotlin 2.3.21 · compileSdk 36**.

```bash
# 1. Build the Flutter module AARs (repeat whenever the Dart/plugin code changes):
(cd ../flutter_call_module && flutter build aar --no-profile)

# 2. Build the host (committed wrapper), or open this folder in Android Studio:
./gradlew :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk. Run on a device (API 26+).
```

> The app consumes `com.chimeflutter.callmodule:flutter_debug/-release:1.0` from the module's
> `build/host/outputs/repo` maven (declared in the root `build.gradle`), plus Flutter engine
> artifacts from `download.flutter.io`. A duplicate `libsqlite3.so` (Amplify) is resolved via
> `packagingOptions.jniLibs.pickFirsts`.

`app/build.gradle` sets `implementation project(':flutter')`, `minSdk 26`, `compileSdk 35`, Java 17.

## Permissions (already wired) — required for "like WhatsApp"

Declared in [`app/src/main/AndroidManifest.xml`](./app/src/main/AndroidManifest.xml); `MainActivity`
requests the dangerous ones at runtime before starting a call.

| Permission | Why |
|------------|-----|
| `MANAGE_OWN_CALLS` | self-managed Telecom (prerequisite for the `phoneCall` FGS type) |
| `RECORD_AUDIO`, `CAMERA` | Chime mic/camera (runtime) |
| `POST_NOTIFICATIONS` | ongoing call notification (runtime, API 33+) |
| `USE_FULL_SCREEN_INTENT` | full-screen incoming-call UI (auto-granted to calling apps on API 34+) |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_PHONE_CALL` + `FOREGROUND_SERVICE_MICROPHONE` | keep the call alive; service type is `phoneCall|microphone` |
| `BLUETOOTH_CONNECT` | BT audio routing (API 31+) |

The plugin's `CallForegroundService` posts a `NotificationCompat.CallStyle` ongoing notification.

## Key files

| File | Role |
|------|------|
| [`settings.gradle`](./settings.gradle) | includes the Flutter add-to-app module |
| [`app/build.gradle`](./app/build.gradle) | app module (`:flutter` dep, minSdk 26, Java 17) |
| [`HostApplication.kt`](./app/src/main/kotlin/com/chimeflutter/hostapp/HostApplication.kt) | cached `FlutterEngine` + host bridge |
| [`MainActivity.kt`](./app/src/main/kotlin/com/chimeflutter/hostapp/MainActivity.kt) | native home; runtime permissions; launches the Flutter call UI |

Embedded module: [`native/flutter_call_module`](../flutter_call_module) (run `flutter pub get` there
first). Dart entrypoint: its `lib/main.dart` → `mainHost`, with `ConnectWebRtcConfig(callKitEnabled: true)`.

> **Note:** `androidx.core.telecom` is `@RequiresApi(26)`, so the plugin uses Telecom on API 26+ and
> falls back to a plain mic foreground service on lower (not applicable here — `minSdk 26`). There is
> no official AWS doc for Chime↔Telecom coexistence; the lifecycle is faithful to Google's guide but
> should be validated on-device.
