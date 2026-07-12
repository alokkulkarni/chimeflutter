package com.chimeflutter.connect_webrtc

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person

/**
 * Foreground service that keeps the VoIP call alive in the background. Declared with
 * `foregroundServiceType="phoneCall|microphone"` (Telecom + mic). Shows an ongoing `CallStyle`
 * notification so the OS presents it as a real call.
 */
class CallForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannel()

        val caller = Person.Builder().setName("Support call").setImportant(true).build()
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentTitle(getString(R.string.call_in_progress))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangUpIntent()))
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+: declare the FGS types at start time (phoneCall + microphone).
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_NOT_STICKY
    }

    private fun hangUpIntent() = android.app.PendingIntent.getBroadcast(
        this,
        0,
        Intent(ACTION_HANG_UP).setPackage(packageName),
        android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.call_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }

    companion object {
        const val ACTION_HANG_UP = "com.chimeflutter.connect_webrtc.HANG_UP"
        private const val CHANNEL_ID = "chimeflutter_call"
        private const val NOTIFICATION_ID = 4269
    }
}
