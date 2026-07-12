# chime_call_module — Flutter add-to-app module

The Flutter **module** that the native iOS and Android host apps embed. It depends on the
`flutter_amazon_connect_webrtc` plugin and exposes the `mainHost` entrypoint + the in-call UI, wired
to the native host over the `com.chimeflutter.host/bridge` channel.

> A Flutter **module** (this) is different from a Flutter **app** (the plugin's `example/`). Only a
> module's `pubspec.yaml` has the `flutter: module:` block, and only a module generates the hidden
> `.ios/` and `.android/` projects that CocoaPods (`podhelper.rb`) and Gradle
> (`include_flutter.groovy`) reference. **This is why the hosts embed this module, not the example.**

## Prepare it (required before building either host)

```bash
cd native/flutter_call_module
flutter pub get          # generates .ios/ and .android/ (the add-to-app glue)
```

- iOS host → [`../ios-host/Podfile`](../ios-host/Podfile) loads `.ios/Flutter/podhelper.rb`.
- Android host → [`../android-host/settings.gradle`](../android-host/settings.gradle) evaluates
  `.android/include_flutter.groovy`.

Run standalone for a quick check: `flutter run --dart-define=BACKEND_BASE_URL=https://…/v1`.

## Configuration

Embedded (add-to-app) runs read config from the host's `getConfig` bridge reply; standalone runs
read the dart-defines. Bridge values win when both are present.

| Bridge key / dart-define | Values | Behaviour |
|--------------------------|--------|-----------|
| `backendBaseUrl` / `BACKEND_BASE_URL` | `https://…/v1` | The deployed backend (`ApiBaseUrl` output of `sam deploy`). Missing → setup screen. |
| `enabledCallTypes` / `ENABLED_CALL_TYPES` | `audio,video` (default) · `audio` · `video` | Both → the call screen shows the Audio/Video chooser. Exactly one → the chooser is skipped and that type **dials immediately** when the screen opens (after a hang-up a single redial button is shown instead — no auto-redial loop). Audio-only also hides the in-call Video/Flip buttons. Empty/unrecognised → both. |

Hosts set these in `HostConfig`: iOS
[`../ios-host/HostApp/AppDelegate.swift`](../ios-host/HostApp/AppDelegate.swift) · Android
[`../android-host/.../HostApplication.kt`](../android-host/app/src/main/kotlin/com/chimeflutter/hostapp/HostApplication.kt).

## Entrypoints

- `main()` — standalone run.
- `mainHost()` (`@pragma('vm:entry-point')`) — what the hosts run on their cached `FlutterEngine`.
