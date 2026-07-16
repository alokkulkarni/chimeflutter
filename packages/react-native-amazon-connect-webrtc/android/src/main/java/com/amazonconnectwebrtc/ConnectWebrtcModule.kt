package com.amazonconnectwebrtc

import android.Manifest
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/** Shares the active [ChimeCallManager] between the module and the video view manager. */
object ChimeSessionHolder {
    @Volatile var callManager: ChimeCallManager? = null
}

/**
 * Host-app channel (brownfield embedding): native hosts set [listener] to observe call events
 * without touching JS — e.g. to drive a "return to call" banner or finish the call activity when
 * the call ends. Invoked on the main thread with the raw event map (`type` is the discriminator;
 * for `stateChanged`, `state` is connecting/connected/reconnecting/disconnected/failed).
 */
object ConnectWebrtcHostEvents {
    @Volatile @JvmStatic
    var listener: ((Map<String, Any?>) -> Unit)? = null
}

/**
 * React Native module for Android. Same responsibilities as the Flutter plugin's
 * `ConnectWebrtcPlugin`: wires JS methods to [ChimeCallManager] (which coordinates with Android
 * Telecom) and emits every native event to JS on the main thread.
 */
class ConnectWebrtcModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val callManager =
        ChimeCallManager(reactContext.applicationContext) { event -> emit(event) }

    init {
        ChimeSessionHolder.callManager = callManager
        // Forward incoming-call (simulated outbound) answer/decline events to JS + host listeners.
        // Anything that fired before this point (cold start) is parked and drained via
        // getPendingIncomingCall.
        ConnectIncomingCallCenter.listener = { event -> emit(event) }
    }

    override fun invalidate() {
        ConnectIncomingCallCenter.listener = null
        super.invalidate()
    }

    override fun getName(): String = NAME

    /**
     * Permission *check* only. Android runtime prompts are driven from JS with `PermissionsAndroid`
     * (an Activity concern); the JS bridge calls this method on iOS, where prompting is native.
     */
    @ReactMethod
    fun requestPermissions(needsCamera: Boolean, promise: Promise) {
        val mic = ContextCompat.checkSelfPermission(reactContext, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        val camera = !needsCamera ||
            ContextCompat.checkSelfPermission(reactContext, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        promise.resolve(mic && camera)
    }

    @ReactMethod
    fun join(args: ReadableMap, promise: Promise) {
        try {
            // The full args map carries the CallSession fields + callKitEnabled/callDisplayName,
            // exactly like the Flutter method-channel contract (specs/003 §B.1).
            callManager.join(args.toHashMap())
            promise.resolve(null)
        } catch (e: ChimeMeetingSessionAdapter.MissingFieldException) {
            promise.reject("sdkError", "adapter: ${e.message}", e)
        } catch (e: SecurityException) {
            promise.reject("permissionDenied", e.message, e)
        } catch (e: Exception) {
            promise.reject("sdkError", e.message, e)
        }
    }

    @ReactMethod
    fun leave(promise: Promise) {
        callManager.leave()
        promise.resolve(null)
    }

    @ReactMethod
    fun setMuted(muted: Boolean, promise: Promise) {
        promise.resolve(callManager.setMuted(muted))
    }

    @ReactMethod
    fun setLocalVideoEnabled(enabled: Boolean, promise: Promise) {
        try {
            callManager.setLocalVideoEnabled(enabled)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("sdkError", e.message, e)
        }
    }

    @ReactMethod
    fun switchCamera(promise: Promise) {
        callManager.switchCamera()
        promise.resolve(null)
    }

    @ReactMethod
    fun setSpeakerphoneEnabled(enabled: Boolean, promise: Promise) {
        callManager.setSpeakerphone(enabled)
        promise.resolve(null)
    }

    @ReactMethod
    fun reportIncomingCall(args: ReadableMap, promise: Promise) {
        val callId = args.getString("callId")
        if (callId.isNullOrEmpty()) {
            promise.reject("sdkError", "reportIncomingCall requires a callId", null)
            return
        }
        ConnectIncomingCallCenter.reportIncomingCall(
            context = reactContext.applicationContext,
            callId = callId,
            displayName = args.getString("displayName") ?: "Support",
            isVideo = if (args.hasKey("isVideo")) args.getBoolean("isVideo") else false,
            timeoutSeconds = if (args.hasKey("timeoutSeconds")) args.getInt("timeoutSeconds") else 45,
        )
        promise.resolve(null)
    }

    @ReactMethod
    fun dismissIncomingCall(promise: Promise) {
        ConnectIncomingCallCenter.dismissIncomingCall(reactContext.applicationContext)
        promise.resolve(null)
    }

    @ReactMethod
    fun getPendingIncomingCall(promise: Promise) {
        val pending = ConnectIncomingCallCenter.consumePendingAnsweredCall()
        promise.resolve(pending?.let { Arguments.makeNativeMap(it) })
    }

    /** Required by NativeEventEmitter — subscription bookkeeping happens on the JS side. */
    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) = Unit

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) = Unit

    /** Marshals every event to the main thread before crossing into JS (spec §B.2). */
    private fun emit(event: Map<String, Any?>) {
        mainHandler.post {
            if (reactContext.hasActiveReactInstance()) {
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(EVENT_NAME, Arguments.makeNativeMap(event))
            }
            // Host-app channel (brownfield embedding) — see [ConnectWebrtcHostEvents].
            ConnectWebrtcHostEvents.listener?.invoke(event)
        }
    }

    companion object {
        const val NAME = "ConnectWebrtc"
        const val EVENT_NAME = "ConnectWebrtcEvent"
    }
}
