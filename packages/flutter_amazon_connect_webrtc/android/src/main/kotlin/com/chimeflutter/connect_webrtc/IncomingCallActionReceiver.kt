package com.chimeflutter.connect_webrtc

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Receives the Answer/Decline actions from the incoming-call notification. */
class IncomingCallActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_ANSWER = "com.chimeflutter.connect_webrtc.INCOMING_ANSWER"
        const val ACTION_DECLINE = "com.chimeflutter.connect_webrtc.INCOMING_DECLINE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_ANSWER -> ConnectIncomingCallCenter.onAnswerAction(context)
            ACTION_DECLINE -> ConnectIncomingCallCenter.onDeclineAction(context)
        }
    }
}
