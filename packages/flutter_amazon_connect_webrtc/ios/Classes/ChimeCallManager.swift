import AmazonChimeSDK
import AVFoundation
import Foundation

/// Receives call events from the manager. The plugin implements this and marshals every emission to
/// the main thread before pushing it onto the Flutter event channel (threading rule, spec §B.2).
protocol ChimeEventEmitter: AnyObject {
    func emit(_ event: [String: Any])
}

/// Owns the Amazon Chime `MeetingSession` lifecycle and the device audio session, and translates
/// Chime observer callbacks into the plugin's event contract.
final class ChimeCallManager: NSObject {
    private let logger = ConsoleLogger(name: "ChimeFlutter")
    private weak var emitter: ChimeEventEmitter?
    private(set) var meetingSession: MeetingSession?
    private var isMuted = false
    private var mediaStarted = false

    init(emitter: ChimeEventEmitter) {
        self.emitter = emitter
        super.init()
    }

    // MARK: - Commands

    func join(sessionMap: [String: Any], callKitEnabled: Bool) throws {
        let configuration = try ChimeMeetingSessionAdapter.makeConfiguration(from: sessionMap)
        // With CallKit, the OS activates the audio session in the CXProvider's `didActivate`
        // delegate — we only set the category/mode here and must NOT call setActive ourselves.
        try configureAudioSession(activate: !callKitEnabled)

        let session = DefaultMeetingSession(configuration: configuration, logger: logger)
        meetingSession = session

        let audioVideo = session.audioVideo
        audioVideo.addAudioVideoObserver(observer: self)
        audioVideo.addRealtimeObserver(observer: self)
        audioVideo.addVideoTileObserver(observer: self)

        emitState("connecting")

        if callKitEnabled {
            // CRITICAL: with CallKit, `audioVideo.start(callKitEnabled:)` MUST be called from the
            // CXProvider's `didActivate` (via startAudioVideoForCallKit()) — never here — or audio
            // will not start (per AWS's CallKit integration guidance).
            return
        }

        try audioVideo.start(callKitEnabled: false)
        // Remote video is opt-in on the Chime iOS SDK — without this the agent's video tile never
        // arrives (parity with Android). Harmless for audio-only calls.
        audioVideo.startRemoteVideo()
    }

    /// Called by the CallKit coordinator from `CXProvider(_:didActivate:)`. Starts the Chime media
    /// once CallKit has activated the audio session (idempotent — didActivate may fire more than once).
    func startAudioVideoForCallKit() {
        guard let audioVideo = meetingSession?.audioVideo, !mediaStarted else { return }
        mediaStarted = true
        do {
            try audioVideo.start(callKitEnabled: true)
            audioVideo.startRemoteVideo()
            if isMuted { _ = audioVideo.realtimeLocalMute() }
        } catch {
            emitter?.emit(["type": "error", "code": "sdkError",
                           "message": "audio start failed: \(error)", "fatal": true])
            emitState("failed")
        }
    }

    func leave() {
        if let audioVideo = meetingSession?.audioVideo {
            audioVideo.stopLocalVideo()
            audioVideo.stopRemoteVideo()
            audioVideo.removeAudioVideoObserver(observer: self)
            audioVideo.removeRealtimeObserver(observer: self)
            audioVideo.removeVideoTileObserver(observer: self)
            audioVideo.stop()
        }
        meetingSession = nil
        mediaStarted = false
        isMuted = false
        deactivateAudioSession()
        emitState("disconnected")
    }

    @discardableResult
    func setMuted(_ muted: Bool) -> Bool {
        guard let audioVideo = meetingSession?.audioVideo else { return false }
        let ok = muted ? audioVideo.realtimeLocalMute() : audioVideo.realtimeLocalUnmute()
        if ok {
            isMuted = muted
            emitter?.emit(["type": "muteChanged", "muted": muted])
        }
        return ok
    }

    func setLocalVideoEnabled(_ enabled: Bool) throws {
        guard let audioVideo = meetingSession?.audioVideo else { return }
        if enabled {
            try audioVideo.startLocalVideo()
        } else {
            audioVideo.stopLocalVideo()
        }
    }

    func switchCamera() {
        meetingSession?.audioVideo.switchCamera()
    }

    func setSpeakerphone(_ enabled: Bool) {
        // Prefer the Chime SDK's device controller — it owns the audio session (with CallKit, a raw
        // AVAudioSession override can be reverted by the system). Fall back to the session override
        // if the expected device isn't listed.
        if let audioVideo = meetingSession?.audioVideo {
            let devices = audioVideo.listAudioDevices()
            let target = devices.first {
                enabled ? $0.type == .audioBuiltInSpeaker : $0.type == .audioHandset
            }
            if let target = target {
                audioVideo.chooseAudioDevice(mediaDevice: target)
                emitter?.emit(["type": "audioRouteChanged", "route": enabled ? "speaker" : "receiver"])
                return
            }
        }
        let session = AVAudioSession.sharedInstance()
        try? session.overrideOutputAudioPort(enabled ? .speaker : .none)
        emitter?.emit(["type": "audioRouteChanged", "route": enabled ? "speaker" : "receiver"])
    }

    /// Binds a native render view to a tile (called by the platform view factory).
    func bindVideoView(_ view: VideoRenderView, tileId: Int) {
        meetingSession?.audioVideo.bindVideoView(videoView: view, tileId: tileId)
    }

    func unbindVideoView(tileId: Int) {
        meetingSession?.audioVideo.unbindVideoView(tileId: tileId)
    }

    // MARK: - Audio session (VoIP)

    private func configureAudioSession(activate: Bool) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat,
                                options: [.allowBluetooth, .allowBluetoothA2DP])
        if activate {
            try session.setActive(true)
        }
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Helpers

    private func emitState(_ state: String, reason: String? = nil) {
        var event: [String: Any] = ["type": "stateChanged", "state": state]
        if let reason = reason { event["reason"] = reason }
        emitter?.emit(event)
    }
}

// MARK: - AudioVideoObserver

extension ChimeCallManager: AudioVideoObserver {
    func audioSessionDidStartConnecting(reconnecting: Bool) {
        if reconnecting { emitState("reconnecting") }
    }

    func audioSessionDidStart(reconnecting: Bool) {
        emitState("connected")
    }

    func audioSessionDidDrop() {
        emitState("reconnecting")
    }

    func audioSessionDidStopWithStatus(sessionStatus: MeetingSessionStatus) {
        let ok = sessionStatus.statusCode == .ok
        emitState(ok ? "disconnected" : "failed", reason: "\(sessionStatus.statusCode)")
        if !ok {
            emitter?.emit(["type": "error", "code": "sessionEnded",
                           "message": "\(sessionStatus.statusCode)", "fatal": true])
        }
    }

    func audioSessionDidCancelReconnect() {
        emitState("failed", reason: "reconnect cancelled")
    }

    func connectionDidRecover() {
        emitter?.emit(["type": "networkQualityChanged", "quality": "good"])
    }

    func connectionDidBecomePoor() {
        emitter?.emit(["type": "networkQualityChanged", "quality": "poor"])
    }

    func videoSessionDidStartConnecting() {}

    func videoSessionDidStartWithStatus(sessionStatus: MeetingSessionStatus) {}

    func videoSessionDidStopWithStatus(sessionStatus: MeetingSessionStatus) {}

    func remoteVideoSourcesDidBecomeAvailable(sources: [RemoteVideoSource]) {}

    func remoteVideoSourcesDidBecomeUnavailable(sources: [RemoteVideoSource]) {}

    func cameraSendAvailabilityDidChange(available: Bool) {}
}

// MARK: - RealtimeObserver

extension ChimeCallManager: RealtimeObserver {
    func attendeesDidJoin(attendeeInfo: [AttendeeInfo]) {
        for info in attendeeInfo {
            emitter?.emit(["type": "participantJoined",
                           "attendeeId": info.attendeeId,
                           "externalUserId": info.externalUserId])
        }
    }

    func attendeesDidLeave(attendeeInfo: [AttendeeInfo]) {
        for info in attendeeInfo {
            emitter?.emit(["type": "participantLeft", "attendeeId": info.attendeeId])
        }
    }

    func attendeesDidDrop(attendeeInfo: [AttendeeInfo]) {
        for info in attendeeInfo {
            emitter?.emit(["type": "participantLeft", "attendeeId": info.attendeeId])
        }
    }

    func attendeesDidMute(attendeeInfo: [AttendeeInfo]) {}
    func attendeesDidUnmute(attendeeInfo: [AttendeeInfo]) {}
    func volumeDidChange(volumeUpdates: [VolumeUpdate]) {}
    func signalStrengthDidChange(signalUpdates: [SignalUpdate]) {}
}

// MARK: - VideoTileObserver

extension ChimeCallManager: VideoTileObserver {
    func videoTileDidAdd(tileState: VideoTileState) {
        if tileState.isLocalTile {
            emitter?.emit(["type": "localVideoAvailable", "tileId": tileState.tileId])
        } else {
            emitter?.emit(["type": "remoteVideoAvailable",
                           "tileId": tileState.tileId,
                           "attendeeId": tileState.attendeeId])
        }
    }

    func videoTileDidRemove(tileState: VideoTileState) {
        meetingSession?.audioVideo.unbindVideoView(tileId: tileState.tileId)
        emitter?.emit(["type": "videoTileRemoved", "tileId": tileState.tileId])
    }

    func videoTileDidPause(tileState: VideoTileState) {}
    func videoTileDidResume(tileState: VideoTileState) {}
    func videoTileSizeDidChange(tileState: VideoTileState) {}
}
