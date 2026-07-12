import AmazonChimeSDK
import Flutter
import UIKit

/// Flutter plugin entry point for iOS. Wires the method/event channels and the video PlatformView
/// factory to the ``ChimeCallManager``. Implements ``ChimeEventEmitter`` and marshals every event to
/// the main thread before pushing it onto the Flutter event sink (threading rule, spec §B.2).
public class ConnectWebrtcPlugin: NSObject, FlutterPlugin, FlutterStreamHandler, ChimeEventEmitter {
    private var eventSink: FlutterEventSink?
    private var callManager: ChimeCallManager!
    private var callKitManager: ConnectCallKitManager?
    private var usingCallKit = false

    public static func register(with registrar: FlutterPluginRegistrar) {
        let instance = ConnectWebrtcPlugin()
        instance.callManager = ChimeCallManager(emitter: instance)

        let methods = FlutterMethodChannel(
            name: "com.chimeflutter.connect_webrtc/methods",
            binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(instance, channel: methods)

        let events = FlutterEventChannel(
            name: "com.chimeflutter.connect_webrtc/events",
            binaryMessenger: registrar.messenger())
        events.setStreamHandler(instance)

        let factory = ConnectVideoViewFactory(callManager: instance.callManager)
        registrar.register(factory, withId: "com.chimeflutter.connect_webrtc/video_view")
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any]
        switch call.method {
        case "join":
            guard let args = args else { result(invalidArgs()); return }
            let callKitEnabled = (args["callKitEnabled"] as? Bool) ?? false
            let displayName = (args["callDisplayName"] as? String) ?? "Support"
            let isVideo = (args["callType"] as? String) == "video"
            do {
                // Builds the media session; with CallKit, audio starts later in didActivate.
                try callManager.join(sessionMap: args, callKitEnabled: callKitEnabled)
                usingCallKit = callKitEnabled
                if callKitEnabled {
                    let manager = callKitManager ?? ConnectCallKitManager(chime: callManager)
                    callKitManager = manager
                    manager.startOutgoingCall(displayName: displayName, isVideo: isVideo)
                }
                result(nil)
            } catch {
                result(mapError(error))
            }
        case "leave":
            if usingCallKit {
                callKitManager?.requestEnd() // triggers CXEndCallAction → callManager.leave()
            } else {
                callManager.leave()
            }
            result(nil)
        case "setMuted":
            let muted = (args?["muted"] as? Bool) ?? false
            if usingCallKit {
                callKitManager?.requestMuted(muted) // CXSetMutedCallAction keeps system UI in sync
                result(true)
            } else {
                result(callManager.setMuted(muted))
            }
        case "setLocalVideoEnabled":
            do {
                try callManager.setLocalVideoEnabled((args?["enabled"] as? Bool) ?? false)
                result(nil)
            } catch {
                result(mapError(error))
            }
        case "switchCamera":
            callManager.switchCamera()
            result(nil)
        case "setSpeakerphoneEnabled":
            callManager.setSpeakerphone((args?["enabled"] as? Bool) ?? false)
            result(nil)
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    // MARK: - FlutterStreamHandler

    public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        eventSink = events
        return nil
    }

    public func onCancel(withArguments arguments: Any?) -> FlutterError? {
        eventSink = nil
        return nil
    }

    // MARK: - ChimeEventEmitter

    public func emit(_ event: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // Keep CallKit in sync with the Chime media lifecycle (on the main thread).
            if self.usingCallKit,
               let type = event["type"] as? String, type == "stateChanged",
               let state = event["state"] as? String {
                switch state {
                case "connected": self.callKitManager?.reportConnected()
                case "disconnected", "failed": self.callKitManager?.reportRemoteEnded()
                default: break
                }
            }
            self.eventSink?(event)
        }
    }

    // MARK: - Helpers

    private func mapError(_ error: Error) -> FlutterError {
        if error is PermissionError {
            return FlutterError(code: "permissionDenied", message: "\(error)", details: nil)
        }
        if let adapterError = error as? ChimeAdapterError {
            return FlutterError(code: "sdkError", message: "adapter: \(adapterError)", details: nil)
        }
        return FlutterError(code: "sdkError", message: error.localizedDescription, details: nil)
    }

    private func invalidArgs() -> FlutterError {
        FlutterError(code: "sdkError", message: "invalid arguments for method", details: nil)
    }
}
