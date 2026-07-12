#!/usr/bin/env bash
#
# prepare-flutter-module.sh — generate the add-to-app glue for native/flutter_call_module so the
# native iOS (CocoaPods) and Android (Gradle) hosts can embed it.
#
# WHY THIS IS NEEDED: a Flutter *module* generates hidden `.ios/` and `.android/` ephemeral projects
# (containing `Flutter/podhelper.rb` and `.android/include_flutter.groovy`). These are produced by the
# Flutter tool on YOUR machine — they are never committed. Until they exist, `pod install` /
# Gradle sync fail with "cannot load podhelper.rb" / missing include_flutter.groovy.
#
# Run this once (and after changing the module's pubspec):
#   scripts/prepare-flutter-module.sh
#
set -euo pipefail

MODULE_DIR="$(cd "$(dirname "$0")/.." && pwd)/native/flutter_call_module"

if ! command -v flutter >/dev/null 2>&1; then
  echo "✖ Flutter is not on PATH. Install Flutter (https://docs.flutter.dev/get-started/install)"
  echo "  then re-run this script. (It generates the .ios/.android module scaffolding.)"
  exit 1
fi

# NOTE: never pipe `flutter` into head/tail — the Flutter tool crashes on SIGPIPE (broken pipe).
echo "▶ flutter version:"; flutter --version || true
cd "$MODULE_DIR"

echo "▶ flutter pub get (generates .ios/ and .android/ for the module)…"
flutter pub get || true

# If pub get alone didn't scaffold the ephemeral platform projects, regenerate them without losing
# the custom pubspec.yaml / lib/main.dart.
if [ ! -f .ios/Flutter/podhelper.rb ] || [ ! -f .android/include_flutter.groovy ]; then
  echo "▶ Scaffolding module platform projects (preserving your code)…"
  cp pubspec.yaml .pubspec.bak
  cp lib/main.dart .main.bak
  flutter create --template module --org com.chimeflutter --project-name chime_call_module .
  mv -f .pubspec.bak pubspec.yaml
  mv -f .main.bak lib/main.dart
  flutter pub get
fi

echo ""
if [ -f .ios/Flutter/podhelper.rb ]; then
  echo "✅ iOS glue ready:     $MODULE_DIR/.ios/Flutter/podhelper.rb"
else
  echo "✖ iOS glue MISSING — .ios/Flutter/podhelper.rb was not generated. Check the flutter output above."
  exit 1
fi
if [ -f .android/include_flutter.groovy ]; then
  echo "✅ Android glue ready: $MODULE_DIR/.android/include_flutter.groovy"
else
  echo "✖ Android glue MISSING — .android/include_flutter.groovy was not generated."
  exit 1
fi

echo ""
echo "Next:"
echo "  iOS:     cd native/ios-host && pod install && open ChimeFlutterHost.xcworkspace"
echo "  Android: open native/android-host in Android Studio, or ./gradlew :app:assembleDebug"
