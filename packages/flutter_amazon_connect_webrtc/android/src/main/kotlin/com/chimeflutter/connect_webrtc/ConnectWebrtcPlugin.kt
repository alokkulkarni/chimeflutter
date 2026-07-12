package com.chimeflutter.connect_webrtc

import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Flutter plugin entry point for Android. Wires the method/event channels and the video PlatformView
 * factory to [ChimeCallManager]. Every event is marshalled to the main thread before being pushed to
 * the Flutter event sink (spec §B.2 threading rule).
 */
class ConnectWebrtcPlugin :
    FlutterPlugin, MethodChannel.MethodCallHandler, EventChannel.StreamHandler {

    private lateinit var methodChannel: MethodChannel
    private lateinit var eventChannel: EventChannel
    private lateinit var callManager: ChimeCallManager
    private var eventSink: EventChannel.EventSink? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        callManager = ChimeCallManager(binding.applicationContext) { event -> emit(event) }

        methodChannel = MethodChannel(binding.binaryMessenger, "com.chimeflutter.connect_webrtc/methods")
        methodChannel.setMethodCallHandler(this)

        eventChannel = EventChannel(binding.binaryMessenger, "com.chimeflutter.connect_webrtc/events")
        eventChannel.setStreamHandler(this)

        binding.platformViewRegistry.registerViewFactory(
            "com.chimeflutter.connect_webrtc/video_view",
            ConnectVideoViewFactory(callManager),
        )
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methodChannel.setMethodCallHandler(null)
        eventChannel.setStreamHandler(null)
    }

    @Suppress("UNCHECKED_CAST")
    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "join" -> {
                    val args = call.arguments as? Map<String, Any?> ?: emptyMap()
                    // The full args map carries the CallSession fields + callKitEnabled/callDisplayName.
                    callManager.join(args)
                    result.success(null)
                }
                "leave" -> {
                    callManager.leave()
                    result.success(null)
                }
                "setMuted" -> result.success(callManager.setMuted(call.argument<Boolean>("muted") ?: false))
                "setLocalVideoEnabled" -> {
                    callManager.setLocalVideoEnabled(call.argument<Boolean>("enabled") ?: false)
                    result.success(null)
                }
                "switchCamera" -> {
                    callManager.switchCamera()
                    result.success(null)
                }
                "setSpeakerphoneEnabled" -> {
                    callManager.setSpeakerphone(call.argument<Boolean>("enabled") ?: false)
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        } catch (e: ChimeMeetingSessionAdapter.MissingFieldException) {
            result.error("sdkError", "adapter: ${e.message}", null)
        } catch (e: SecurityException) {
            result.error("permissionDenied", e.message, null)
        } catch (e: Exception) {
            result.error("sdkError", e.message, null)
        }
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        eventSink = events
    }

    override fun onCancel(arguments: Any?) {
        eventSink = null
    }

    private fun emit(event: Map<String, Any?>) {
        mainHandler.post { eventSink?.success(event) }
    }
}
