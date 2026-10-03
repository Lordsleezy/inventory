package com.floor.kiosk

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/** Plays the local alarm for Blink motion alerts, even while the shade is hidden. */
class BlinkMotionListener : NotificationListenerService() {
    private val seen = mutableMapOf<String, Long>()

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != BLINK_PACKAGE || sbn.isOngoing) return
        val notification = sbn.notification ?: return
        val extras = notification.extras
        val content = listOfNotNull(
            extras.getCharSequence(Notification.EXTRA_TITLE),
            extras.getCharSequence(Notification.EXTRA_TEXT),
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT),
            extras.getCharSequence(Notification.EXTRA_SUB_TEXT),
        ).joinToString(" ")
        val channel = notification.channelId.orEmpty()
        if (!MOTION_TERMS.containsMatchIn("$channel $content")) return
        if (seen[sbn.key] == sbn.postTime) return
        seen[sbn.key] = sbn.postTime
        if (seen.size > 100) seen.clear()
        Log.i(TAG, "Blink motion alert received")
        BlinkAlarm.play(this)
    }

    override fun onDestroy() {
        BlinkAlarm.stop()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "FloorKiosk"
        private const val BLINK_PACKAGE = "com.immediasemi.android.blink"
        private val MOTION_TERMS = Regex(
            "\\b(motion|movement|person detected|vehicle detected|animal detected|package detected)\\b",
            RegexOption.IGNORE_CASE,
        )
    }
}
