package com.chimeflutter.hostapp

import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * A demo FEATURE screen: proves any screen can start a support call with its own routing context
 * (billing, payments, a product id) without touching the Flutter integration — the engine and
 * bridge live once in [HostApplication], and [SupportCallLauncher] is the only surface a feature
 * needs.
 */
class PaymentsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
        }
        root.addView(TextView(this).apply { text = getString(R.string.payments_title); textSize = 24f })
        root.addView(
            TextView(this).apply {
                text = "£120.00 — Acme Energy\n£54.20 — City Water"
                setPadding(0, 24, 0, 24)
            },
        )
        root.addView(
            Button(this).apply {
                text = getString(R.string.call_about_payment)
                setOnClickListener {
                    SupportCallLauncher.launch(
                        this@PaymentsActivity,
                        context = mapOf(
                            "issueType" to "billing",
                            "lastScreen" to "payments",
                            "productId" to "PAY-8842",
                        ),
                    )
                }
            },
        )
        setContentView(root)
    }
}
