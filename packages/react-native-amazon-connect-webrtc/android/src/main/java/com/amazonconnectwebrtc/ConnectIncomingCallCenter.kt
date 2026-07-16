package com.amazonconnectwebrtc

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper

/**
 * Singleton coordinator for INCOMING (simulated-outbound) Connect calls.
 *
 * HOST-FACING: the app's `FirebaseMessagingService.onMessageReceived` calls [reportIncomingCall]
 * when the FCM data push (`type == "incomingConnectCall"`) arrives — even when no React bridge is
 * running. This posts the full-screen incoming-call notification (see [IncomingCallNotifier]) and
 * starts the local ring timeout. Answer/decline notification actions land in
 * [IncomingCallActionReceiver], which forwards here.
 *
 * When the user answers, the event is forwarded to the JS side (`incomingCallAnswered` on the
 * module event stream) — or parked until the bridge attaches (cold start) and drained via the
 * `getPendingIncomingCall` module method. Declines that cannot reach JS are recovered by
 * the backend's ring-timeout sweeper, which releases the waiting agent.
 */
object ConnectIncomingCallCenter {

    data class RingingCall(val callId: String, val displayName: String, val isVideo: Boolean)

    @Volatile
    private var current: RingingCall? = null

    @Volatile
    private var answered = false

    /** Set by the module while a React bridge is attached; events flow to JS and the host-event hook. */
    @Volatile
    internal var listener: ((Map<String, Any?>) -> Unit)? = null

    @Volatile
    private var pendingAnswered: Map<String, Any?>? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    private var timeout: Runnable? = null

    /**
     * Shows the incoming-call UI for a simulated-outbound call. Safe to call from any thread
     * (FCM delivers on a background thread). At most one incoming call rings at a time — a new
     * report replaces a previous unanswered one.
     */
    @JvmStatic
    @JvmOverloads
    @Synchronized
    fun reportIncomingCall(
        context: Context,
        callId: String,
        displayName: String,
        isVideo: Boolean,
        timeoutSeconds: Int = 45,
    ) {
        val appContext = context.applicationContext
        cancelTimeout()
        current = RingingCall(callId, displayName, isVideo)
        answered = false
        IncomingCallNotifier.show(appContext, displayName, isVideo)
        val runnable = Runnable { onTimeout(appContext) }
        timeout = runnable
        mainHandler.postDelayed(runnable, timeoutSeconds * 1000L)
    }

    /** Dismisses a still-ringing call (caller cancelled / answered elsewhere). Module-facing. */
    @JvmStatic
    @Synchronized
    fun dismissIncomingCall(context: Context) {
        if (current == null || answered) return
        IncomingCallNotifier.dismiss(context.applicationContext)
        cancelTimeout()
        current = null
    }

    /** Drains the parked cold-start answer (module `getPendingIncomingCall`). */
    @Synchronized
    internal fun consumePendingAnsweredCall(): Map<String, Any?>? {
        val pending = pendingAnswered
        pendingAnswered = null
        return pending
    }

    /** Notification "Answer" action. Brings the app to the foreground and notifies/parks the event. */
    @Synchronized
    internal fun onAnswerAction(context: Context) {
        val call = current ?: return
        if (answered) return
        answered = true
        cancelTimeout()
        IncomingCallNotifier.dismiss(context.applicationContext)
        current = null

        // Bring the host app to the foreground so the JS side can join the call.
        context.applicationContext.packageManager
            .getLaunchIntentForPackage(context.packageName)
            ?.let { launch ->
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.applicationContext.startActivity(launch)
            }

        dispatch(
            mapOf(
                "type" to "incomingCallAnswered",
                "callId" to call.callId,
                "isVideo" to call.isVideo,
            ),
        )
    }

    /** Notification "Decline" action. */
    @Synchronized
    internal fun onDeclineAction(context: Context) {
        val call = current ?: return
        if (answered) return
        cancelTimeout()
        IncomingCallNotifier.dismiss(context.applicationContext)
        current = null
        dispatch(mapOf("type" to "incomingCallDeclined", "callId" to call.callId))
    }

    @Synchronized
    private fun onTimeout(context: Context) {
        val call = current ?: return
        if (answered) return
        IncomingCallNotifier.dismiss(context)
        current = null
        timeout = null
        dispatch(mapOf("type" to "incomingCallMissed", "callId" to call.callId))
    }

    private fun cancelTimeout() {
        timeout?.let { mainHandler.removeCallbacks(it) }
        timeout = null
    }

    private fun dispatch(event: Map<String, Any?>) {
        val active = listener
        if (active != null) {
            active(event)
        } else if (event["type"] == "incomingCallAnswered") {
            // Cold start: the bridge is not running yet — park the answer for pickup at startup.
            pendingAnswered = event
        }
        // Declines/misses with no listener need no parking: the backend ring timeout releases the agent.
    }
}
