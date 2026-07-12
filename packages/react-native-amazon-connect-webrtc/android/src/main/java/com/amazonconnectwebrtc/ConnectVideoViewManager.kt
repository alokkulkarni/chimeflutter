package com.amazonconnectwebrtc

import com.amazonaws.services.chime.sdk.meetings.audiovideo.video.DefaultVideoRenderView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import java.util.WeakHashMap

/** Renders one Chime video tile in the native [DefaultVideoRenderView] (JS name: ConnectVideoView). */
class ConnectVideoViewManager : SimpleViewManager<DefaultVideoRenderView>() {

    /** Which tile each live view is bound to, so onDropViewInstance can unbind it. */
    private val boundTiles = WeakHashMap<DefaultVideoRenderView, Int>()

    override fun getName(): String = "ConnectVideoView"

    override fun createViewInstance(reactContext: ThemedReactContext): DefaultVideoRenderView =
        DefaultVideoRenderView(reactContext)

    @ReactProp(name = "mirror", defaultBoolean = false)
    fun setMirror(view: DefaultVideoRenderView, mirror: Boolean) {
        view.mirror = mirror
    }

    @ReactProp(name = "tileId", defaultInt = -1)
    fun setTileId(view: DefaultVideoRenderView, tileId: Int) {
        val current = boundTiles[view]
        if (current == tileId || tileId < 0) return
        current?.let { ChimeSessionHolder.callManager?.unbindVideoView(it) }
        ChimeSessionHolder.callManager?.bindVideoView(view, tileId)
        boundTiles[view] = tileId
    }

    override fun onDropViewInstance(view: DefaultVideoRenderView) {
        boundTiles.remove(view)?.let { ChimeSessionHolder.callManager?.unbindVideoView(it) }
        super.onDropViewInstance(view)
    }
}
