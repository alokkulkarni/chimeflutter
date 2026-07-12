# CI & Test Execution

Where each test suite runs, and why. See [specs/006-test-strategy](../specs/006-test-strategy.md).

| Suite | Command | Runner | Needs |
|-------|---------|--------|-------|
| Backend unit + integration (80 tests) | `cd backend && npm ci && npm test` | Node 20 | nothing external (AWS SDK mocked) |
| Backend build check | `PATH=$PWD/node_modules/.bin:$PATH sam build` | Node 20 + SAM | esbuild on PATH |
| Dart unit (models, controller, backend client) | `cd packages/flutter_amazon_connect_webrtc && flutter test` | Flutter 3.19+ | Flutter SDK |
| iOS adapter (XCTest) | `xcodebuild test -scheme flutter_amazon_connect_webrtc` (via example `ios/`) | macOS + Xcode 15 | AmazonChimeSDK pod |
| Android adapter (JUnit) | `cd android && ./gradlew test` | JDK 17 + Android SDK | Chime SDK artifact |
| iOS host app build | `cd native/ios-host && xcodegen generate && pod install && xcodebuild build` | macOS + Xcode 15 + xcodegen | Flutter module + pods |
| Android host app build | `cd native/android-host && ./gradlew :app:assembleDebug` | JDK 17 + Android SDK | Flutter module (`:flutter`) |

> **CallKit/Telecom** paths (system call UI, audio-session handoff, cellular-call interruption, BT
> routing) require a **real device** and cannot be verified in CI or this environment — see
> [SYSTEM_CALL_UI.md](./SYSTEM_CALL_UI.md). The `androidx.core.telecom` lifecycle has no official
> AWS Chime reference and must be validated on-device.

## Example GitHub Actions matrix

```yaml
name: ci
on: [push, pull_request]
jobs:
  backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd backend && npm ci && npm test
      - uses: aws-actions/setup-sam@v2
      - run: cd backend && export PATH="$PWD/node_modules/.bin:$PATH" && sam build

  flutter:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with: { flutter-version: '3.24.x' }
      - run: cd packages/flutter_amazon_connect_webrtc && flutter pub get && flutter analyze && flutter test

  android-adapter:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 17 }
      - run: cd packages/flutter_amazon_connect_webrtc/android && ./gradlew test

  ios-adapter:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with: { flutter-version: '3.24.x' }
      - run: cd packages/flutter_amazon_connect_webrtc/example && flutter build ios --config-only
      - run: cd packages/flutter_amazon_connect_webrtc/example/ios && pod install
      - run: xcodebuild test -workspace Runner.xcworkspace -scheme flutter_amazon_connect_webrtc -destination 'platform=iOS Simulator,name=iPhone 15'
```

## Verification status

Verified locally on a Mac with Flutter 3.44.6 + CocoaPods 1.17:

- **Backend** — `npm test` green (80 tests), `sam build` OK, `sam validate` OK.
- **Flutter plugin** — `flutter analyze` clean, `flutter test` green (**28 tests**).
- **Module + example** — `flutter analyze` clean.
- **iOS integration** — `pod install` succeeds; resolves **AmazonChimeSDK 0.27.3** +
  **AmazonChimeSDKMedia 0.25.3**; `ChimeFlutterHost.xcworkspace` generated.
- **Connect flow** — validated by the flow-language validator.

Not runnable without a device / full Xcode + Android SDK (documented in
[SYSTEM_CALL_UI.md](./SYSTEM_CALL_UI.md)): the native XCTest/JUnit adapter suites, a full
`xcodebuild`/`gradlew assemble`, and on-device CallKit/Telecom audio behaviour.
