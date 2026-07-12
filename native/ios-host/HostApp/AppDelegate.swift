import Flutter
import FlutterPluginRegistrant
import UIKit

/// Host-side runtime configuration handed to the embedded Flutter module over the bridge.
/// In add-to-app, Dart `--dart-define`s do NOT flow through the embedded engine, so the host is the
/// source of truth for these values.
enum HostConfig {
    /// The `ApiBaseUrl` output of `sam deploy` (docs/DEPLOYMENT.md). A BACKEND_BASE_URL environment
    /// variable in the Xcode scheme overrides it if set.
    static let backendBaseUrl =
        ProcessInfo.processInfo.environment["BACKEND_BASE_URL"]
            ?? ""
}

/// Native iOS host that embeds the ChimeFlutter module via add-to-app.
///
/// The **system call UI (CallKit) lives in the `flutter_amazon_connect_webrtc` plugin**; this host
/// owns configuration + (optionally) auth, embeds the Flutter engine, and presents the call screen.
/// Uses the UIScene lifecycle (see ``SceneDelegate``).
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    lazy var flutterEngine = FlutterEngine(name: "chime_call_engine")
    var bridgeChannel: FlutterMethodChannel?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Run the add-to-app Dart entrypoint (native/flutter_call_module/lib/main.dart → `mainHost`).
        flutterEngine.run(withEntrypoint: "mainHost")
        GeneratedPluginRegistrant.register(with: flutterEngine)
        setupHostBridge()
        return true
    }

    // MARK: - UIScene lifecycle

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(
            name: "Default Configuration",
            sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    // MARK: - Host bridge (config/auth/context → Dart; call state ← Dart)

    private func setupHostBridge() {
        let channel = FlutterMethodChannel(
            name: "com.chimeflutter.host/bridge",
            binaryMessenger: flutterEngine.binaryMessenger)
        bridgeChannel = channel

        channel.setMethodCallHandler { call, result in
            switch call.method {
            case "getConfig":
                result(["backendBaseUrl": HostConfig.backendBaseUrl])
            case "getAuthToken":
                // Return YOUR app's session/bearer token here if you front the backend API with
                // auth. Empty string = no Authorization header.
                result(AuthService.shared.currentJwt())
            case "getCustomerContext":
                result([
                    "issueType": "billing",
                    "tier": AuthService.shared.customerTier,
                    "lastScreen": "card_details",
                ])
            case "onCallStateChanged":
                let state = (call.arguments as? [String: Any])?["state"] as? String ?? ""
                NSLog("Call state: \(state)")
                NotificationCenter.default.post(
                    name: .chimeCallStateChanged, object: nil, userInfo: ["state": state])
                result(nil)
            case "onCallEnded":
                NotificationCenter.default.post(name: .chimeCallEnded, object: nil)
                result(nil)
            case "minimize":
                // Hide the call screen; the call keeps running (CallKit + cached engine). The home
                // screen shows a "return to call" banner.
                NotificationCenter.default.post(name: .chimeCallMinimized, object: nil)
                result(nil)
            default:
                result(FlutterMethodNotImplemented)
            }
        }
    }

    /// Called by the native home screen to start a call inside the embedded Flutter module.
    func startCall(callType: String) {
        bridgeChannel?.invokeMethod("startCall", arguments: ["callType": callType])
    }
}

/// UIScene window setup (replaces the pre-scene `UIWindow` in the app delegate).
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene,
              let app = UIApplication.shared.delegate as? AppDelegate else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UIHostingControllerFactory.make(app: app)
        window.makeKeyAndVisible()
        self.window = window
    }
}

extension Notification.Name {
    static let chimeCallEnded = Notification.Name("chimeCallEnded")
    static let chimeCallStateChanged = Notification.Name("chimeCallStateChanged")
    static let chimeCallMinimized = Notification.Name("chimeCallMinimized")
}
