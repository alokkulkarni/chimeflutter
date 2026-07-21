package com.chimeflutter.hostapp

import android.app.Activity
import io.flutter.embedding.android.FlutterActivity

/**
 * App-wide entry point for the embedded support call — the "integrate once, launch from anywhere"
 * seam. The heavy integration (cached FlutterEngine + host bridge) lives ONCE in [HostApplication];
 * feature screens never touch it. Any activity, fragment or feature module starts a call with one
 * line:
 *
 *     SupportCallLauncher.launch(activity, context = mapOf("issueType" to "billing", "lastScreen" to "payments"))
 *
 * `context` is that entry point's routing contribution: the host bridge overlays it on the
 * app-wide base context in `getCustomerContext`, and the backend forwards the allow-listed keys to
 * Amazon Connect as contact attributes — so each feature controls how its calls are routed without
 * declaring any integration of its own.
 *
 * Runtime permissions (mic/camera) are requested by the module itself on call start;
 * pre-requesting them (as [MainActivity] demonstrates) is optional UX polish.
 */
object SupportCallLauncher {

    /** The launching feature's context — read by the host bridge on the next getCustomerContext. */
    @Volatile
    var launchContext: Map<String, String> = emptyMap()
        private set

    fun launch(from: Activity, context: Map<String, String> = emptyMap()) {
        launchContext = context
        from.startActivity(FlutterActivity.withCachedEngine(HostApplication.ENGINE_ID).build(from))
    }
}
