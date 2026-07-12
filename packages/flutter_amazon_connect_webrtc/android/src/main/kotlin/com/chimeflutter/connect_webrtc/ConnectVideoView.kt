package com.chimeflutter.connect_webrtc

import android.content.Context
import android.view.View
import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.DefaultVideoRenderView
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformView
import io.flutter.plugin.platform.PlatformViewFactory

/** Factory for the video-tile PlatformView; hosts Chime's [DefaultVideoRenderView]. */
class ConnectVideoViewFactory(private val callManager: ChimeCallManager) :
    PlatformViewFactory(StandardMessageCodec.INSTANCE) {

    override fun create(context: Context, viewId: Int, args: Any?): PlatformView {
        @Suppress("UNCHECKED_CAST")
        val params = args as? Map<String, Any?> ?: emptyMap()
        return ConnectVideoPlatformView(context, params, callManager)
    }
}

class ConnectVideoPlatformView(
    context: Context,
    params: Map<String, Any?>,
    private val callManager: ChimeCallManager,
) : PlatformView {

    private val tileId = (params["tileId"] as? Int) ?: -1
    private val renderView = DefaultVideoRenderView(context)

    init {
        renderView.mirror = (params["mirror"] as? Boolean) ?: false
        if (tileId >= 0) callManager.bindVideoView(renderView, tileId)
    }

    override fun getView(): View = renderView

    override fun dispose() {
        if (tileId >= 0) callManager.unbindVideoView(tileId)
    }
}
