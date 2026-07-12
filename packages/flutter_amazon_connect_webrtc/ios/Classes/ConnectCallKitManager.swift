import AVFoundation
import CallKit
import Foundation

/// Reports the call to **CallKit** so iOS treats it as a real phone call (system call UI, lock-screen
/// controls, correct audio routing, interop with cellular calls) — "like WhatsApp".
///
/// It owns the `CXProvider`/`CXCallController` and coordinates with ``ChimeCallManager`` in the same
/// process, so the Chime↔CallKit audio handoff is direct: Chime media is started only from
/// `provider(_:didActivate:)`, exactly as AWS's CallKit integration guidance requires.
final class ConnectCallKitManager: NSObject, CXProviderDelegate {
    private let provider: CXProvider
    private let callController = CXCallController()
    private weak var chime: ChimeCallManager?
    private var currentCallId: UUID?
    private var endingViaCallKit = false

    init(chime: ChimeCallManager) {
        // iOS 14+: CXProviderConfiguration() derives the app name shown in the system call UI from
        // the bundle (CFBundleDisplayName / CFBundleName) — `localizedName` is read-only. The per-call
        // party name is set via the CXHandle in startOutgoingCall(displayName:).
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallsPerCallGroup = 1
        configuration.maximumCallGroups = 1
        configuration.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: configuration)
        self.chime = chime
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
    func reportConnected() {
        guard let uuid = currentCallId else { return }
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    /// The call ended remotely (agent/network), not via a CallKit action → tell CallKit.
    func reportRemoteEnded() {
        guard let uuid = currentCallId, !endingViaCallKit else { return }
        provider.reportCall(with: uuid, endedAt: Date(), reason: .remoteEnded)
        currentCallId = nil
    }

    // MARK: - CXProviderDelegate

    func providerDidReset(_ provider: CXProvider) {
        chime?.leave()
        currentCallId = nil
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        // Media session was already built in ChimeCallManager.join(callKitEnabled: true); audio
        // itself starts in didActivate. Just acknowledge and mark "connecting".
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        endingViaCallKit = true
        chime?.leave()
        currentCallId = nil
        action.fulfill()
        endingViaCallKit = false
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        _ = chime?.setMuted(action.isMuted)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit activated the audio session — NOW start the Chime media.
        chime?.startAudioVideoForCallKit()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}
}
