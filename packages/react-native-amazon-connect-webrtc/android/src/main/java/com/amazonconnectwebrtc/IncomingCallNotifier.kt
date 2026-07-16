package com.amazonconnectwebrtc

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person

/**
 * Posts the full-screen incoming-call notification (Android's ring UI for self-managed VoIP apps).
 * Uses `NotificationCompat.CallStyle` (system call look with Answer/Decline) with a full-screen
 * intent so the call shows over the lock screen; falls back to a plain high-priority notification
 * with action buttons if CallStyle rejects the configuration on some OEM/API combination.
 *
 * Requires the host app to hold POST_NOTIFICATIONS (runtime, API 33+) — see docs/OUTBOUND_CALLS.md.
 */
internal object IncomingCallNotifier {
    private const val CHANNEL_ID = "connect_incoming_calls"
    internal const val NOTIFICATION_ID = 0x436F4C

    fun show(context: Context, displayName: String, isVideo: Boolean) {
        ensureChannel(context)

        val answer = actionIntent(context, IncomingCallActionReceiver.ACTION_ANSWER, 0)
        val decline = actionIntent(context, IncomingCallActionReceiver.ACTION_DECLINE, 1)
        val fullScreen = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
            PendingIntent.getActivity(
                context,
                2,
                it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
        val contentText = if (isVideo) "Incoming video call" else "Incoming call"

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(displayName)
            .setContentText(contentText)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .apply { fullScreen?.let { setFullScreenIntent(it, true) } }

        val person = Person.Builder().setName(displayName).setImportant(true).build()
        val notification = runCatching {
            builder
                .setStyle(
                    NotificationCompat.CallStyle.forIncomingCall(person, decline, answer)
                        .setIsVideo(isVideo),
                )
                .build()
        }.getOrElse {
            // CallStyle has strict preconditions on some builds — degrade to plain actions.
            builder
                .setStyle(null)
                .addAction(0, "Decline", decline)
                .addAction(0, "Answer", answer)
                .build()
        }

        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted — the push was still delivered; the app can only ring
            // when foregrounded. Documented host requirement.
        }
    }

    fun dismiss(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }

    private fun ensureChannel(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Incoming calls",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Incoming support calls"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun actionIntent(context: Context, action: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, IncomingCallActionReceiver::class.java).setAction(action)
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
