import AVFoundation
import Foundation
import React

/// Shares the active `ChimeCallManager` between the module and the video view manager (they are
/// separate objects instantiated by React Native).
final class ChimeSessionHolder {
    static let shared = ChimeSessionHolder()
    var callManager: ChimeCallManager?
    private init() {}
}

/// React Native module for iOS. Same responsibilities as the Flutter plugin's
/// `ConnectWebrtcPlugin`: wires JS methods to ``ChimeCallManager``, keeps ``ConnectCallKitManager``
/// in sync, and emits every native event to JS on the main thread.
@objc(ConnectWebrtc)
class ConnectWebrtcModule: RCTEventEmitter, ChimeEventEmitter {
    private var callManager: ChimeCallManager!
    private let callKitManager = ConnectCallKitManager.shared
    private var usingCallKit = false
    private var hasListeners = false

    override init() {
        super.init()
        callManager = ChimeCallManager(emitter: self)
        ChimeSessionHolder.shared.callManager = callManager
        // Bind the shared CallKit singleton (which the host's PushKit delegate may already have
        // used to show an incoming call) to this bridge's media manager and event stream.
        ConnectCallKitManager.shared.chime = callManager
        ConnectCallKitManager.shared.eventListener = { [weak self] event in
            self?.emit(event)
        }
    }

    @objc override static func requiresMainQueueSetup() -> Bool { false }

    override func supportedEvents() -> [String]! { ["ConnectWebrtcEvent"] }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    // MARK: - Permissions (Android uses PermissionsAndroid from JS; iOS prompts natively)

    @objc(requestPermissions:resolver:rejecter:)
    func requestPermissions(
        _ needsCamera: Bool,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        AVAudioSession.sharedInstance().requestRecordPermission { micGranted in
            guard micGranted else { resolve(false); return }
            guard needsCamera else { resolve(true); return }
            AVCaptureDevice.requestAccess(for: .video) { cameraGranted in
                resolve(cameraGranted)
            }
        }
    }

    // MARK: - Methods (contract mirrors specs/003 §B.1)

    @objc(join:resolver:rejecter:)
    func join(
        _ args: NSDictionary,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let session = args as? [String: Any] else {
            reject("sdkError", "invalid arguments for join", nil)
            return
        }
        let callKitEnabled = (session["callKitEnabled"] as? Bool) ?? false
        let displayName = (session["callDisplayName"] as? String) ?? "Support"
        let isVideo = (session["callType"] as? String) == "video"
        let asIncoming = (session["asIncoming"] as? Bool) ?? false
        do {
            // Builds the media session; with CallKit, audio starts later in didActivate (or
            // immediately for an answered incoming call whose didActivate already fired).
            try callManager.join(sessionMap: session, callKitEnabled: callKitEnabled || asIncoming)
            usingCallKit = callKitEnabled || asIncoming
            if callKitEnabled && !asIncoming {
                callKitManager.startOutgoingCall(displayName: displayName, isVideo: isVideo)
            }
            // asIncoming: CallKit is already showing the answered call from reportIncomingCall.
            resolve(nil)
        } catch let error as ChimeAdapterError {
            reject("sdkError", "adapter: \(error)", error)
        } catch {
            reject("sdkError", error.localizedDescription, error)
        }
    }

    @objc(reportIncomingCall:resolver:rejecter:)
    func reportIncomingCall(
        _ args: NSDictionary,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        // JS-side push delivery. NOTE: on iOS, VoIP pushes normally arrive in the HOST app's
        // PushKit delegate, which must call ConnectCallKitManager.shared.reportIncomingCall
        // directly (Apple requires it synchronously); this method covers in-app signalling.
        guard let callId = args["callId"] as? String, !callId.isEmpty else {
            reject("sdkError", "reportIncomingCall requires a callId", nil)
            return
        }
        usingCallKit = true
        callKitManager.reportIncomingCall(
            callId: callId,
            displayName: (args["displayName"] as? String) ?? "Support",
            isVideo: (args["isVideo"] as? Bool) ?? false,
            timeoutSeconds: (args["timeoutSeconds"] as? Int) ?? 45)
        resolve(nil)
    }

    @objc(dismissIncomingCall:rejecter:)
    func dismissIncomingCall(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        callKitManager.dismissIncomingCall()
        resolve(nil)
    }

    @objc(getPendingIncomingCall:rejecter:)
    func getPendingIncomingCall(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        resolve(callKitManager.consumePendingAnsweredCall())
    }

    @objc(leave:rejecter:)
    func leave(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        if usingCallKit {
            callKitManager.requestEnd() // triggers CXEndCallAction → callManager.leave()
        } else {
            callManager.leave()
        }
        resolve(nil)
    }

    @objc(setMuted:resolver:rejecter:)
    func setMuted(
        _ muted: Bool,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        if usingCallKit {
            callKitManager.requestMuted(muted) // CXSetMutedCallAction keeps system UI in sync
            resolve(true)
        } else {
            resolve(callManager.setMuted(muted))
        }
    }

    @objc(setLocalVideoEnabled:resolver:rejecter:)
    func setLocalVideoEnabled(
        _ enabled: Bool,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        do {
            try callManager.setLocalVideoEnabled(enabled)
            resolve(nil)
        } catch {
            reject("sdkError", error.localizedDescription, error)
        }
    }

    @objc(switchCamera:rejecter:)
    func switchCamera(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        callManager.switchCamera()
        resolve(nil)
    }

    @objc(setSpeakerphoneEnabled:resolver:rejecter:)
    func setSpeakerphoneEnabled(
        _ enabled: Bool,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        callManager.setSpeakerphone(enabled)
        resolve(nil)
    }

    // MARK: - ChimeEventEmitter

    func emit(_ event: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // Keep CallKit in sync with the Chime media lifecycle (on the main thread).
            if self.usingCallKit,
               let type = event["type"] as? String, type == "stateChanged",
               let state = event["state"] as? String {
                switch state {
                case "connected": self.callKitManager.reportConnected()
                case "disconnected", "failed": self.callKitManager.reportRemoteEnded()
                default: break
                }
            }
            if self.hasListeners {
                self.sendEvent(withName: "ConnectWebrtcEvent", body: event)
            }
            // Host-app channel (brownfield embedding): native hosts observe call events without
            // touching JS — e.g. to drive a "return to call" banner or dismiss the call screen.
            NotificationCenter.default.post(
                name: .connectWebrtcEvent, object: nil, userInfo: event)
        }
    }
}

public extension Notification.Name {
    /// Posted (on the main thread) for every call event, with the event map as `userInfo`.
    /// `userInfo["type"]` is the discriminator; for `stateChanged`, `userInfo["state"]` is one of
    /// connecting/connected/reconnecting/disconnected/failed.
    static let connectWebrtcEvent = Notification.Name("ConnectWebrtcEvent")
}
