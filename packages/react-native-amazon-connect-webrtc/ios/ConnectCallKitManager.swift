import AVFoundation
import CallKit
import Foundation

/// Reports calls to **CallKit** so iOS treats them as real phone calls (system call UI, lock-screen
/// controls, correct audio routing, interop with cellular calls) — "like WhatsApp".
///
/// It owns the `CXProvider`/`CXCallController` and coordinates with ``ChimeCallManager`` in the same
/// process, so the Chime↔CallKit audio handoff is direct: Chime media is started only from
/// `provider(_:didActivate:)`, exactly as AWS's CallKit integration guidance requires.
///
/// ## Incoming (simulated-outbound) calls
/// This class is a **public singleton** so the HOST APP can report an incoming call from its
/// PushKit delegate *before any React Native bridge exists* (Apple requires
/// `reportNewIncomingCall` synchronously for every VoIP push):
///
/// ```swift
/// // In pushRegistry(_:didReceiveIncomingPushWith:for:completion:)
/// let d = payload.dictionaryPayload
/// ConnectCallKitManager.shared.reportIncomingCall(
///     callId: d["callId"] as? String ?? "",
///     displayName: d["displayName"] as? String ?? "Support",
///     isVideo: (d["callType"] as? String) == "video",
///     timeoutSeconds: Int(d["timeoutSeconds"] as? String ?? "45") ?? 45)
/// ```
///
/// When the user answers, the answer is forwarded to JS (event `incomingCallAnswered`) — or
/// parked in ``pendingAnsweredCall`` until the JS side attaches (cold start) and drains it via
/// `getPendingIncomingCall`.
public final class ConnectCallKitManager: NSObject, CXProviderDelegate {
    public static let shared = ConnectCallKitManager()

    private let provider: CXProvider
    private let callController = CXCallController()
    /// Attached by the module at creation; nil while only the ring UI is active (cold start).
    weak var chime: ChimeCallManager?
    /// Module event bridge (marshals onto the RCTEventEmitter / NotificationCenter channel).
    var eventListener: (([String: Any]) -> Void)?
    private var currentCallId: UUID?
    private var endingViaCallKit = false

    // Incoming (simulated-outbound) call state — at most one at a time.
    private var incomingCallId: String?
    private var incomingIsVideo = false
    private var incomingAnswered = false
    private var ringTimer: Timer?
    /// The answer that happened before the JS bridge attached; drained by `getPendingIncomingCall`.
    private var pendingAnsweredCall: [String: Any]?

    override private init() {
        // iOS 14+: CXProviderConfiguration() derives the app name shown in the system call UI from
        // the bundle (CFBundleDisplayName / CFBundleName) — `localizedName` is read-only. The per-call
        // party name is set via the CXHandle.
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallsPerCallGroup = 1
        configuration.maximumCallGroups = 1
        configuration.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: nil)
    }

    // MARK: - Called by the plugin

    /// Request an OUTGOING call. CallKit then invokes `perform CXStartCallAction`.
    func startOutgoingCall(displayName: String, isVideo: Bool) {
        let uuid = UUID()
        currentCallId = uuid
        let handle = CXHandle(type: .generic, value: displayName)
        let action = CXStartCallAction(call: uuid, handle: handle)
        action.isVideo = isVideo
        callController.request(CXTransaction(action: action)) { error in
            if let error = error { NSLog("CallKit start error: \(error)") }
        }
    }

    /// User tapped end in the app — route through CallKit so the system UI dismisses.
    func requestEnd() {
        guard let uuid = currentCallId else { return }
        callController.request(CXTransaction(action: CXEndCallAction(call: uuid))) { _ in }
    }

    /// User toggled mute in the app — route through CallKit to keep the system UI in sync.
    func requestMuted(_ muted: Bool) {
        guard let uuid = currentCallId else { return }
        callController.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted))) { _ in }
    }

    /// Chime reported the media session is up → tell CallKit the outgoing call connected.
    /// (Incoming calls are already "connected" in CallKit from the moment they are answered.)
    func reportConnected() {
        guard let uuid = currentCallId, incomingCallId == nil else { return }
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    /// The call ended remotely (agent/network), not via a CallKit action → tell CallKit.
    func reportRemoteEnded() {
        guard let uuid = currentCallId, !endingViaCallKit else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        currentCallId = nil
        clearIncomingState()
    }

    /// Drains the parked cold-start answer (called by the module's `getPendingIncomingCall`).
    func consumePendingAnsweredCall() -> [String: Any]? {
        let pending = pendingAnsweredCall
        pendingAnsweredCall = nil
        return pending
    }

    // MARK: - Host-facing incoming-call API

    /// Report an incoming (simulated-outbound) Connect call to CallKit. MUST be called
    /// synchronously from the PushKit `didReceiveIncomingPushWith` callback — Apple terminates
    /// apps that receive a VoIP push without reporting a call.
    public func reportIncomingCall(
        callId: String,
        displayName: String,
        isVideo: Bool,
        timeoutSeconds: Int = 45,
        completion: ((Error?) -> Void)? = nil
    ) {
        let uuid = UUID()
        currentCallId = uuid
        incomingCallId = callId
        incomingIsVideo = isVideo
        incomingAnswered = false

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: displayName)
        update.localizedCallerName = displayName
        update.hasVideo = isVideo

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if error != nil {
                self?.clearIncomingState()
                self?.currentCallId = nil
            }
            completion?(error)
        }
        startRingTimer(seconds: timeoutSeconds)
    }

    /// Dismisses a still-ringing incoming call (caller cancelled / answered elsewhere).
    public func dismissIncomingCall() {
        guard let uuid = currentCallId, incomingCallId != nil, !incomingAnswered else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        currentCallId = nil
        clearIncomingState()
    }

    // MARK: - Incoming-call internals

    private func startRingTimer(seconds: Int) {
        ringTimer?.invalidate()
        ringTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(seconds), repeats: false) {
            [weak self] _ in
            guard let self = self, let uuid = self.currentCallId,
                  let callId = self.incomingCallId, !self.incomingAnswered else { return }
            self.provider.reportCall(with: uuid, endedAt: Date(), reason: .unanswered)
            self.currentCallId = nil
            self.notify(["type": "incomingCallMissed", "callId": callId])
            self.clearIncomingState()
        }
    }

    private func clearIncomingState() {
        ringTimer?.invalidate()
        ringTimer = nil
        incomingCallId = nil
        incomingIsVideo = false
        incomingAnswered = false
    }

    private func notify(_ event: [String: Any]) {
        if let listener = eventListener {
            listener(event)
        } else if (event["type"] as? String) == "incomingCallAnswered" {
            // JS is not attached yet (cold start) — park the answer for pickup at startup.
            pendingAnsweredCall = event
        }
        // Declines/misses with no listener need no parking: the backend ring timeout releases the agent.
    }

    // MARK: - CXProviderDelegate

    public func providerDidReset(_ provider: CXProvider) {
        chime?.leave()
        currentCallId = nil
        clearIncomingState()
    }

    public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        // Media session was already built in ChimeCallManager.join(callKitEnabled: true); audio
        // itself starts in didActivate. Just acknowledge and mark "connecting".
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let callId = incomingCallId else {
            action.fail()
            return
        }
        ringTimer?.invalidate()
        incomingAnswered = true
        // JS now exchanges the callId for join credentials and joins with asIncoming=true; the
        // media starts when both the session exists and CallKit has activated the audio session.
        notify(["type": "incomingCallAnswered", "callId": callId, "isVideo": incomingIsVideo])
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if let callId = incomingCallId, !incomingAnswered {
            // Declined from the ring UI: no media exists yet — just notify so JS tells the
            // backend to release the agent (the server ring-timeout is the cold-start fallback).
            notify(["type": "incomingCallDeclined", "callId": callId])
            currentCallId = nil
            clearIncomingState()
            action.fulfill()
            return
        }
        endingViaCallKit = true
        chime?.leave()
        currentCallId = nil
        clearIncomingState()
        action.fulfill()
        endingViaCallKit = false
    }

    public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        _ = chime?.setMuted(action.isMuted)
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit activated the audio session — NOW start the Chime media. For an answered
        // incoming call the media session may not exist yet (credentials still being fetched);
        // ChimeCallManager remembers the activation and starts on join.
        chime?.startAudioVideoForCallKit()
    }

    public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        chime?.callKitAudioSessionEnded()
    }
}
