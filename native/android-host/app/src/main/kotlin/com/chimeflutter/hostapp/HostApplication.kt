package com.chimeflutter.hostapp

import android.app.Application
import android.util.Log
import io.flutter.FlutterInjector
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel

/**
 * Native Android host that embeds the ChimeFlutter module via add-to-app.
 *
 * The **system call UI (Telecom) lives in the `flutter_amazon_connect_webrtc` plugin**, so this host
 * only pre-warms a cached FlutterEngine (running the `mainHost` Dart entrypoint) and installs the
 * host bridge that supplies the JWT + customer context (FR-H2/H3). The OS shows a real call because
 * the plugin reports it to Telecom.
 */
class HostApplication : Application() {

    lateinit var flutterEngine: FlutterEngine
        private set
    private var bridge: MethodChannel? = null

    /** Invoked by the bridge when the Flutter side reports the call ended (to finish the activity). */
    var onCallEnded: (() -> Unit)? = null

    /** Current call state as reported by the Flutter side; drives the "return to call" banner. */
    var callState: String = "idle"
        private set
    val isCallActive: Boolean
        get() = callState in setOf("connecting", "ringing", "connected", "reconnecting")

    /** Set by MainActivity to refresh its banner when the call state changes. */
    var onCallStateChanged: ((String) -> Unit)? = null

    /** Top resumed activity — used by the `minimize` bridge call to dismiss the call screen. */
    var currentActivity: android.app.Activity? = null

    override fun onCreate() {
        super.onCreate()

        flutterEngine = FlutterEngine(this)
        flutterEngine.dartExecutor.executeDartEntrypoint(
            DartExecutor.DartEntrypoint(
                FlutterInjector.instance().flutterLoader().findAppBundlePath(),
                "mainHost",
            ),
        )
        FlutterEngineCache.getInstance().put(ENGINE_ID, flutterEngine)

        // Track the top activity so the `minimize` bridge call can dismiss the call screen.
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacksAdapter() {
            override fun onActivityResumed(activity: android.app.Activity) {
                currentActivity = activity
            }
            override fun onActivityPaused(activity: android.app.Activity) {
                if (currentActivity == activity) currentActivity = null
            }
        })

        bridge = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.chimeflutter.host/bridge")
        bridge?.setMethodCallHandler { call, result ->
            when (call.method) {
                "getConfig" -> result.success(
                    mapOf(
                        "backendBaseUrl" to HostConfig.backendBaseUrl,
                        "enabledCallTypes" to HostConfig.enabledCallTypes,
                    ),
                )
                "getAuthToken" -> result.success(AuthService.currentJwt())
                "getCustomerContext" -> result.success(
                    mapOf(
                        "issueType" to "billing",
                        "tier" to AuthService.customerTier,
                        "lastScreen" to "card_details",
                    ),
                )
                "onCallStateChanged" -> {
                    @Suppress("UNCHECKED_CAST")
                    val state = (call.arguments as? Map<String, Any?>)?.get("state") as? String ?: ""
                    Log.d("ChimeFlutterHost", "call state: $state")
                    callState = state
                    onCallStateChanged?.invoke(state)
                    result.success(null)
                }
                "onCallEnded" -> {
                    callState = "disconnected"
                    onCallStateChanged?.invoke(callState)
                    onCallEnded?.invoke()
                    result.success(null)
                }
                "minimize" -> {
                    // Dismiss the call screen; the call keeps running (Telecom + foreground service
                    // + cached engine). MainActivity shows a "return to call" banner.
                    (currentActivity as? io.flutter.embedding.android.FlutterActivity)?.finish()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    /** Starts a call inside the embedded Flutter module (native → Dart). */
    fun startCall(callType: String) {
        bridge?.invokeMethod("startCall", mapOf("callType" to callType))
    }

    companion object {
        const val ENGINE_ID = "chime_call_engine"
    }
}

/** No-op base so we only override the lifecycle callbacks we need. */
open class ActivityLifecycleCallbacksAdapter : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: android.app.Activity, savedInstanceState: android.os.Bundle?) {}
    override fun onActivityStarted(activity: android.app.Activity) {}
    override fun onActivityResumed(activity: android.app.Activity) {}
    override fun onActivityPaused(activity: android.app.Activity) {}
    override fun onActivityStopped(activity: android.app.Activity) {}
    override fun onActivitySaveInstanceState(activity: android.app.Activity, outState: android.os.Bundle) {}
    override fun onActivityDestroyed(activity: android.app.Activity) {}
}

/**
 * Host-side runtime configuration handed to the embedded Flutter module over the bridge (dart-defines
 * do not flow through the embedded engine in add-to-app).
 */
object HostConfig {
    /** The `ApiBaseUrl` output of `sam deploy` — TODO: paste your deployed URL here. */
    val backendBaseUrl: String =
        System.getenv("BACKEND_BASE_URL") ?: "https://YOUR_API_ID.execute-api.eu-west-2.amazonaws.com/v1"

    /**
     * Which call types the in-app support UI offers: "audio,video" (default — the user picks on
     * the audio/video chooser), "audio" or "video" (the chooser is skipped and that type dials
     * immediately when the call screen opens).
     */
    val enabledCallTypes: String = System.getenv("ENABLED_CALL_TYPES") ?: "audio,video"
}

/** Placeholder for the host's real auth/session. Replace with your identity layer. */
object AuthService {
    const val customerTier = "gold"

    fun currentJwt(): String {
        // Return your app's own session/bearer token here if you front the backend API with auth
        // (it is sent as `Authorization: Bearer <token>`). Empty = no Authorization header.
        return System.getenv("DEMO_JWT") ?: ""
    }
}
