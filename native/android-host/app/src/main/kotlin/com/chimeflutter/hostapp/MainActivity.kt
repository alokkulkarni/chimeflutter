package com.chimeflutter.hostapp

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import io.flutter.embedding.android.FlutterActivity

/**
 * Native home screen. "Call support" requests the runtime permissions a VoIP call needs, then starts
 * the call in the embedded Flutter module and shows its UI via the cached engine. The plugin reports
 * the call to Telecom, so Android treats it as a real call.
 */
class MainActivity : AppCompatActivity() {

    private val permissions: Array<String> = buildList {
        add(Manifest.permission.RECORD_AUDIO)
        add(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }.toTypedArray()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants[Manifest.permission.RECORD_AUDIO] == true) launchCall()
        }

    private var returnToCallButton: Button? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val app = application as HostApplication

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        // WhatsApp-style green call bar — full-width at the very top of the chrome, visible while a
        // call runs minimized (call survives via Telecom + foreground service + cached engine).
        // In a real app, host this in a shared base layout so it persists across every screen.
        returnToCallButton = Button(this).apply {
            text = getString(R.string.return_to_call)
            visibility = android.view.View.GONE
            isAllCaps = false
            setBackgroundColor(0xFF16A34A.toInt())
            setTextColor(0xFFFFFFFF.toInt())
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
            setOnClickListener {
                startActivity(FlutterActivity.withCachedEngine(HostApplication.ENGINE_ID).build(this@MainActivity))
            }
        }
        root.addView(returnToCallButton)

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f,
            )
        }
        content.addView(TextView(this).apply { text = getString(R.string.account_title); textSize = 24f })
        content.addView(
            Button(this).apply {
                text = getString(R.string.call_support)
                setOnClickListener { requestPermissionsThenCall() }
            },
        )
        // A separate FEATURE screen with its own call entry point — proves any screen can start a
        // call (with its own context) via SupportCallLauncher, without extra integration.
        content.addView(
            Button(this).apply {
                text = getString(R.string.payments_title)
                setOnClickListener {
                    startActivity(android.content.Intent(this@MainActivity, PaymentsActivity::class.java))
                }
            },
        )
        root.addView(content)
        setContentView(root)

        app.onCallStateChanged = { _ -> runOnUiThread { refreshBanner() } }
    }

    override fun onResume() {
        super.onResume()
        refreshBanner()
    }

    private fun refreshBanner() {
        returnToCallButton?.visibility =
            if ((application as HostApplication).isCallActive) android.view.View.VISIBLE
            else android.view.View.GONE
    }

    private fun requestPermissionsThenCall() {
        val missing = permissions.any {
            checkSelfPermission(it) != android.content.pm.PackageManager.PERMISSION_GRANTED
        }
        if (missing) permissionLauncher.launch(permissions) else launchCall()
    }

    private fun launchCall() {
        // Launch via the app-wide launcher with THIS entry point's routing context — the Flutter
        // integration (engine + bridge) stays in HostApplication.
        SupportCallLauncher.launch(
            this,
            context = mapOf(
                "issueType" to "general",
                "lastScreen" to "home",
            ),
        )
    }
}
