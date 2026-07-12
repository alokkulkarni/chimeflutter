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

## Entrypoints

- `main()` — standalone run.
- `mainHost()` (`@pragma('vm:entry-point')`) — what the hosts run on their cached `FlutterEngine`.
