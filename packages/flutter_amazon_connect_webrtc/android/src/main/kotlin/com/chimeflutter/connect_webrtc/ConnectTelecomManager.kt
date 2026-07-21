package com.chimeflutter.connect_webrtc

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
        onRouteChanged: (String) -> Unit = {},
    ) {
        val attributes = CallAttributesCompat(
            displayName = displayName,
            address = Uri.parse("sip:support@chimeflutter"),
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
                // Report the ACTIVE endpoint (earpiece/speaker/bluetooth/wired headset) so the app
                // UI can mirror the system call screen's route indicator.
                launch { currentCallEndpoint.collect { onRouteChanged(routeName(it)) } }
            }
        }
    }

    /**
     * Registers an ALREADY-ANSWERED incoming (simulated-outbound) call with Telecom. The user
     * consented on the incoming-call notification, so the call is added with DIRECTION_INCOMING
     * and answered programmatically — Telecom then owns audio focus/routing exactly like the
     * outgoing path. Media starts via [onActive] (idempotent across answer/onSetActive/onAnswer).
     */
    fun startAnsweredIncomingCall(
        displayName: String,
        isVideo: Boolean,
        onActive: () -> Unit,
        onDisconnected: () -> Unit,
        onMuteChanged: (Boolean) -> Unit,
        onRouteChanged: (String) -> Unit = {},
    ) {
        val callType = if (isVideo) {
            CallAttributesCompat.CALL_TYPE_VIDEO_CALL
        } else {
            CallAttributesCompat.CALL_TYPE_AUDIO_CALL
        }
        val attributes = CallAttributesCompat(
            displayName = displayName,
            address = Uri.parse("sip:support@chimeflutter"),
            direction = CallAttributesCompat.DIRECTION_INCOMING,
            callType = callType,
        )

        callJob = scope.launch {
            callsManager.addCall(
                attributes,
                onAnswer = { markActive(onActive) },
                onDisconnect = { _ -> onDisconnected() },
                onSetActive = { markActive(onActive) },
                onSetInactive = { /* hold — not supported; media keeps running */ },
            ) {
                control = this
                launch {
                    when (answer(callType)) {
                        is CallControlResult.Success -> markActive(onActive)
                        is CallControlResult.Error -> onDisconnected()
                    }
                }
                launch { isMuted.collect { onMuteChanged(it) } }
                launch { availableEndpoints.collect { endpoints = it } }
                launch { currentCallEndpoint.collect { onRouteChanged(routeName(it)) } }
            }
        }
    }

    private fun markActive(onActive: () -> Unit) {
        if (started) return
        started = true
        onActive()
    }

    /**
     * Routes audio to/away from the speaker via Telecom (the routing owner when core-telecom is in
     * use — calling AudioManager directly would conflict). Speaker OFF returns to what the OS would
     * pick — bluetooth, then wired headset, then the earpiece — matching the system call screen.
     * Returns false if no matching endpoint. The resulting route is reported via the
     * `currentCallEndpoint` collector, not assumed by the caller.
     */
    fun setSpeaker(enabled: Boolean): Boolean {
        val preference = if (enabled) {
            listOf(CallEndpointCompat.TYPE_SPEAKER)
        } else {
            listOf(
                CallEndpointCompat.TYPE_BLUETOOTH,
                CallEndpointCompat.TYPE_WIRED_HEADSET,
                CallEndpointCompat.TYPE_EARPIECE,
            )
        }
        val target = preference.firstNotNullOfOrNull { wanted -> endpoints.firstOrNull { it.type == wanted } }
            ?: return false
        val current = control ?: return false
        scope.launch { current.requestEndpointChange(target) }
        return true
    }

    /** Maps a Telecom endpoint onto the event contract's routes (`speaker|receiver|bluetooth|headset`). */
    private fun routeName(endpoint: CallEndpointCompat): String = when (endpoint.type) {
        CallEndpointCompat.TYPE_SPEAKER -> "speaker"
        CallEndpointCompat.TYPE_BLUETOOTH -> "bluetooth"
        CallEndpointCompat.TYPE_WIRED_HEADSET -> "headset"
        else -> "receiver" // earpiece / streaming / unknown
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
