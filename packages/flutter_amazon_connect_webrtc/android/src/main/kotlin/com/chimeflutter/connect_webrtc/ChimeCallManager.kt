package com.chimeflutter.connect_webrtc

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import com.amazonaws.services.chime.sdk.meetings.audiovideo.AttendeeInfo
import com.amazonaws.services.chime.sdk.meetings.audiovideo.AudioVideoObserver
import com.amazonaws.services.chime.sdk.meetings.audiovideo.SignalUpdate
import com.amazonaws.services.chime.sdk.meetings.audiovideo.VolumeUpdate
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.RemoteVideoSource
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.VideoRenderView
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.VideoTileObserver
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.VideoTileState
import com.amazonaws.services.chime.sdk.meetings.realtime.RealtimeObserver
import com.amazonaws.services.chime.sdk.meetings.session.DefaultMeetingSession
import com.amazonaws.services.chime.sdk.meetings.session.MeetingSession
import com.amazonaws.services.chime.sdk.meetings.session.MeetingSessionStatus
import com.amazonaws.services.chime.sdk.meetings.session.MeetingSessionStatusCode
import com.amazonaws.services.chime.sdk.meetings.utils.logger.ConsoleLogger
import com.amazonaws.services.chime.sdk.meetings.utils.logger.LogLevel

/**
 * Owns the Amazon Chime meeting session and coordinates with Android Telecom (via
 * [ConnectTelecomManager]) when system-call UI is requested.
 *
 * Two modes:
 *  - **Telecom** (systemCallUI + API 26+): Telecom owns the call lifecycle, system UI and audio
 *    routing/focus. Chime media is started from the Telecom `onSetActive` callback; this class does
 *    NOT request audio focus or drive `AudioManager` routing.
 *  - **Standalone**: this class requests audio focus, starts a microphone foreground service, and
 *    starts Chime media immediately.
 *
 * Observer callbacks arrive on background threads; [emit] marshals to the main thread (done by the
 * plugin's emitter). NOTE: verify observer signatures against amazon-chime-sdk 0.25.4 when building.
 */
class ChimeCallManager(
    private val context: Context,
    private val emit: (Map<String, Any?>) -> Unit,
) : AudioVideoObserver, RealtimeObserver, VideoTileObserver {

    private val logger = ConsoleLogger(LogLevel.INFO)
    private var meetingSession: MeetingSession? = null
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var telecom: ConnectTelecomManager? = null
    private var usingTelecom = false
    private var started = false
    private var isMuted = false
    private var focusRequest: android.media.AudioFocusRequest? = null

    private val audioVideo get() = meetingSession?.audioVideo

    /** [args] is the full method-channel map: the CallSession fields plus `callKitEnabled`,
     * `callDisplayName`, `callType`. */
    fun join(args: Map<String, Any?>) {
        val configuration = ChimeMeetingSessionAdapter.makeConfiguration(args)
        // An answered incoming (simulated-outbound) call always uses Telecom when available so the
        // system owns audio focus/routing, same as an outgoing system-UI call.
        val asIncoming = args["asIncoming"] as? Boolean ?: false
        val systemCallUI = ((args["callKitEnabled"] as? Boolean ?: false) || asIncoming) &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        val displayName = args["callDisplayName"] as? String ?: "Support"
        val isVideo = (args["callType"] as? String) == "video"

        val session = DefaultMeetingSession(configuration, logger, context)
        meetingSession = session
        session.audioVideo.apply {
            addAudioVideoObserver(this@ChimeCallManager)
            addRealtimeObserver(this@ChimeCallManager)
            addVideoTileObserver(this@ChimeCallManager)
        }
        started = false
        emitState("connecting")

        if (systemCallUI) {
            usingTelecom = true
            val manager = ConnectTelecomManager(context)
            telecom = manager
            if (asIncoming) {
                manager.startAnsweredIncomingCall(
                    displayName = displayName,
                    isVideo = isVideo,
                    onActive = { startMedia() },
                    onDisconnected = { stopMedia() },
                    onMuteChanged = { muted -> applyMuteFromSystem(muted) },
                )
            } else {
                manager.startOutgoingCall(
                    displayName = displayName,
                    isVideo = isVideo,
                    onActive = { startMedia() },
                    onDisconnected = { stopMedia() },
                    onMuteChanged = { muted -> applyMuteFromSystem(muted) },
                )
            }
        } else {
            usingTelecom = false
            requestAudioFocus()
            startMedia()
        }
    }

    /** Starts the Chime media (once). Called immediately (standalone) or from Telecom onSetActive. */
    private fun startMedia() {
        if (started) return
        started = true
        startForegroundService()
        audioVideo?.start()
        audioVideo?.startRemoteVideo()
        if (isMuted) audioVideo?.realtimeLocalMute()
    }

    fun leave() {
        if (usingTelecom) {
            telecom?.endCall() // → onDisconnect → stopMedia()
        } else {
            stopMedia()
        }
    }

    /** Idempotent teardown of the media session. */
    private fun stopMedia() {
        val session = meetingSession ?: return
        session.audioVideo.apply {
            stopLocalVideo()
            stopRemoteVideo()
            removeAudioVideoObserver(this@ChimeCallManager)
            removeRealtimeObserver(this@ChimeCallManager)
            removeVideoTileObserver(this@ChimeCallManager)
            stop()
        }
        meetingSession = null
        started = false
        if (!usingTelecom) abandonAudioFocus()
        stopForegroundService()
        telecom = null
        usingTelecom = false
        emitState("disconnected")
    }

    fun setMuted(muted: Boolean): Boolean {
        val av = audioVideo ?: return false
        val ok = if (muted) av.realtimeLocalMute() else av.realtimeLocalUnmute()
        if (ok) {
            isMuted = muted
            emit(mapOf("type" to "muteChanged", "muted" to muted))
        }
        return ok
    }

    /** Called when the user mutes from the system call UI (Telecom `isMuted` flow). */
    private fun applyMuteFromSystem(muted: Boolean) {
        if (muted != isMuted) setMuted(muted)
    }

    fun setLocalVideoEnabled(enabled: Boolean) {
        val av = audioVideo ?: return
        if (enabled) av.startLocalVideo() else av.stopLocalVideo()
    }

    fun switchCamera() {
        audioVideo?.switchCamera()
    }

    fun setSpeakerphone(enabled: Boolean) {
        if (usingTelecom) {
            // Telecom owns audio routing — route the change through it (never AudioManager directly).
            if (telecom?.setSpeaker(enabled) == true) {
                emit(mapOf("type" to "audioRouteChanged", "route" to if (enabled) "speaker" else "receiver"))
            }
            return
        }
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = enabled
        emit(mapOf("type" to "audioRouteChanged", "route" to if (enabled) "speaker" else "receiver"))
    }

    fun bindVideoView(view: VideoRenderView, tileId: Int) {
        audioVideo?.bindVideoView(view, tileId)
    }

    fun unbindVideoView(tileId: Int) {
        audioVideo?.unbindVideoView(tileId)
    }

    // MARK: audio focus (standalone only)

    private fun requestAudioFocus() {
        val request = android.media.AudioFocusRequest
            .Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .build()
        focusRequest = request
        audioManager.requestAudioFocus(request)
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    }

    private fun abandonAudioFocus() {
        focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        focusRequest = null
        audioManager.mode = AudioManager.MODE_NORMAL
    }

    // MARK: foreground service

    private fun startForegroundService() {
        val intent = Intent(context, CallForegroundService::class.java)
        context.startForegroundService(intent)
    }

    private fun stopForegroundService() {
        context.stopService(Intent(context, CallForegroundService::class.java))
    }

    private fun emitState(state: String, reason: String? = null) {
        val event = mutableMapOf<String, Any?>("type" to "stateChanged", "state" to state)
        if (reason != null) event["reason"] = reason
        emit(event)
    }

    // MARK: AudioVideoObserver

    override fun onAudioSessionStartedConnecting(reconnecting: Boolean) {
        if (reconnecting) emitState("reconnecting")
    }

    override fun onAudioSessionStarted(reconnecting: Boolean) {
        emitState("connected")
    }

    override fun onAudioSessionDropped() {
        emitState("reconnecting")
    }

    override fun onAudioSessionStopped(sessionStatus: MeetingSessionStatus) {
        val ok = sessionStatus.statusCode == MeetingSessionStatusCode.OK
        if (!ok) {
            emit(
                mapOf(
                    "type" to "error", "code" to "sessionEnded",
                    "message" to (sessionStatus.statusCode?.name ?: "unknown"), "fatal" to true,
                ),
            )
        }
        // Route teardown through the same path so the system call UI is dismissed too.
        if (usingTelecom) telecom?.endCall() else stopMedia()
    }

    override fun onAudioSessionCancelledReconnect() {
        emitState("failed", "reconnect cancelled")
    }

    override fun onConnectionRecovered() {
        emit(mapOf("type" to "networkQualityChanged", "quality" to "good"))
    }

    override fun onConnectionBecamePoor() {
        emit(mapOf("type" to "networkQualityChanged", "quality" to "poor"))
    }

    override fun onVideoSessionStartedConnecting() {}
    override fun onVideoSessionStarted(sessionStatus: MeetingSessionStatus) {}
    override fun onVideoSessionStopped(sessionStatus: MeetingSessionStatus) {}
    override fun onRemoteVideoSourceAvailable(sources: List<RemoteVideoSource>) {}
    override fun onRemoteVideoSourceUnavailable(sources: List<RemoteVideoSource>) {}
    override fun onCameraSendAvailabilityUpdated(available: Boolean) {}

    // MARK: RealtimeObserver

    override fun onAttendeesJoined(attendeeInfo: Array<AttendeeInfo>) {
        attendeeInfo.forEach {
            emit(
                mapOf(
                    "type" to "participantJoined",
                    "attendeeId" to it.attendeeId,
                    "externalUserId" to it.externalUserId,
                ),
            )
        }
    }

    override fun onAttendeesLeft(attendeeInfo: Array<AttendeeInfo>) {
        attendeeInfo.forEach { emit(mapOf("type" to "participantLeft", "attendeeId" to it.attendeeId)) }
    }

    override fun onAttendeesDropped(attendeeInfo: Array<AttendeeInfo>) {
        attendeeInfo.forEach { emit(mapOf("type" to "participantLeft", "attendeeId" to it.attendeeId)) }
    }

    override fun onAttendeesMuted(attendeeInfo: Array<AttendeeInfo>) {}
    override fun onAttendeesUnmuted(attendeeInfo: Array<AttendeeInfo>) {}
    override fun onVolumeChanged(volumeUpdates: Array<VolumeUpdate>) {}
    override fun onSignalStrengthChanged(signalUpdates: Array<SignalUpdate>) {}

    // MARK: VideoTileObserver

    override fun onVideoTileAdded(tileState: VideoTileState) {
        if (tileState.isLocalTile) {
            emit(mapOf("type" to "localVideoAvailable", "tileId" to tileState.tileId))
        } else {
            emit(
                mapOf(
                    "type" to "remoteVideoAvailable",
                    "tileId" to tileState.tileId,
                    "attendeeId" to tileState.attendeeId,
                ),
            )
        }
    }

    override fun onVideoTileRemoved(tileState: VideoTileState) {
        audioVideo?.unbindVideoView(tileState.tileId)
        emit(mapOf("type" to "videoTileRemoved", "tileId" to tileState.tileId))
    }

    override fun onVideoTilePaused(tileState: VideoTileState) {}
    override fun onVideoTileResumed(tileState: VideoTileState) {}
    override fun onVideoTileSizeChanged(tileState: VideoTileState) {}
}
