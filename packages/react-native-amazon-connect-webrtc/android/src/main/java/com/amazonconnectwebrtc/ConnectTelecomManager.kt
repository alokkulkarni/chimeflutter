package com.amazonconnectwebrtc

import android.content.Context
import android.net.Uri
import android.os.Build
import android.telecom.DisconnectCause
import androidx.annotation.RequiresApi
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlResult
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallEndpointCompat
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Reports the call to Android Telecom via the Jetpack **core-telecom** `CallsManager` so the OS
 * treats it as a real call (system call UI, audio routing/focus, interop with cellular calls) —
 * "like WhatsApp". Owns the `CallControlScope`; coordinates with [ChimeCallManager] in the same
 * process. Requires API 26 (`CallsManager` is `@RequiresApi(26)`).
 *
 * IMPORTANT (per Google's guide): when using core-telecom, the app must NOT drive audio routing via
 * `AudioManager.setCommunicationDevice`/`startBluetoothSco` itself — Telecom owns routing. Chime is
 * started with the default `VoiceCall` audio stream so its media rides `STREAM_VOICE_CALL`.
 *
 * NOTE: verify the call lifecycle on-device — there is no official AWS doc for Chime↔Telecom.
 */
@RequiresApi(Build.VERSION_CODES.O)
class ConnectTelecomManager(context: Context) {

    private val callsManager = CallsManager(context)
    private val scope = CoroutineScope(Dispatchers.Main)
    private var callJob: Job? = null
    private var control: CallControlScope? = null
    private var started = false
    private var endpoints: List<CallEndpointCompat> = emptyList()

    init {
        callsManager.registerAppWithTelecom(
            CallsManager.CAPABILITY_BASELINE or CallsManager.CAPABILITY_SUPPORTS_VIDEO_CALLING,
        )
    }

    fun startOutgoingCall(
        displayName: String,
        isVideo: Boolean,
        onActive: () -> Unit,
        onDisconnected: () -> Unit,
        onMuteChanged: (Boolean) -> Unit,
    ) {
        val attributes = CallAttributesCompat(
            displayName = displayName,
            address = Uri.parse("sip:support@connectwebrtc"),
            direction = CallAttributesCompat.DIRECTION_OUTGOING,
            callType = if (isVideo) {
                CallAttributesCompat.CALL_TYPE_VIDEO_CALL
            } else {
                CallAttributesCompat.CALL_TYPE_AUDIO_CALL
            },
        )

        callJob = scope.launch {
            callsManager.addCall(
                attributes,
                onAnswer = { /* incoming only — unused for outgoing */ },
                onDisconnect = { _ -> onDisconnected() },
                onSetActive = { markActive(onActive) },
                onSetInactive = { /* hold — not supported; media keeps running */ },
            ) {
                control = this
                // Outgoing call → transition to active; that starts the Chime media (onActive).
                launch {
                    when (setActive()) {
                        is CallControlResult.Success -> markActive(onActive)
                        is CallControlResult.Error -> onDisconnected()
                    }
                }
                // Reflect the system-UI mute toggle onto the Chime session.
                launch { isMuted.collect { onMuteChanged(it) } }
                // Track available audio endpoints so the app's speaker toggle can route via Telecom.
                launch { availableEndpoints.collect { endpoints = it } }
            }
        }
    }

    private fun markActive(onActive: () -> Unit) {
        if (started) return
        started = true
        onActive()
    }

    /**
     * Routes audio to the speaker/earpiece via Telecom (the routing owner when core-telecom is in
     * use — calling AudioManager directly would conflict). Returns false if no matching endpoint.
     */
    fun setSpeaker(enabled: Boolean): Boolean {
        val wantedType =
            if (enabled) CallEndpointCompat.TYPE_SPEAKER else CallEndpointCompat.TYPE_EARPIECE
        val target = endpoints.firstOrNull { it.type == wantedType } ?: return false
        val current = control ?: return false
        scope.launch { current.requestEndpointChange(target) }
        return true
    }

    /** Ends the Telecom call (from an app-initiated hang-up). Triggers the `onDisconnect` callback. */
    fun endCall() {
        val current = control
        scope.launch {
            current?.disconnect(DisconnectCause(DisconnectCause.LOCAL))
            control = null
            callJob?.cancel()
        }
    }
}
