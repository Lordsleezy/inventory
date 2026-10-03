package com.floor.kiosk

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * The kiosk hides the status bar, so this draws the battery percent in the
 * top-right corner and keeps it there while Floor or Square is in front.
 * The view does not take touches, so the hidden maintenance gesture still works.
 */
class BatteryOverlayService : Service() {
    private var label: TextView? = null
    private var receiver: BroadcastReceiver? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val reading = batteryReading(this)
        if (!promoteToForeground(reading)) {
            stopSelf()
            return START_NOT_STICKY
        }
        showOverlay()
        return START_STICKY
    }

    override fun onDestroy() {
        receiver?.let { runCatching { unregisterReceiver(it) } }
        receiver = null
        label?.let { view ->
            runCatching { windowManager().removeView(view) }
        }
        label = null
        super.onDestroy()
    }

    private fun promoteToForeground(reading: BatteryReading?): Boolean {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL, "Battery", NotificationManager.IMPORTANCE_MIN)
            channel.setShowBadge(false)
            channel.setSound(null, null)
            manager.createNotificationChannel(channel)
        }
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_charging)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(reading?.label ?: "Battery")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .build()
        return runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
            } else {
                startForeground(NOTIF_ID, notification)
            }
        }.onFailure { Log.w(TAG, "foreground start failed", it) }.isSuccess
    }

    private fun showOverlay() {
        if (label != null) {
            paint(batteryReading(this))
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            Log.w(TAG, "overlay permission missing; battery stays on the register screen only")
            return
        }
        val text = TextView(this).apply {
            textSize = 14f
            setPadding(dp(10), dp(4), dp(10), dp(4))
            setBackgroundResource(R.drawable.battery_chip)
        }
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = dp(14)
            y = dp(10)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }
        runCatching { windowManager().addView(text, params) }
            .onFailure {
                Log.w(TAG, "overlay add failed", it)
                return
            }
        label = text
        val watch = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                paint(batteryReading(context))
            }
        }
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(watch, filter, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(watch, filter)
        }
        receiver = watch
        paint(batteryReading(this))
    }

    private fun paint(reading: BatteryReading?) {
        val text = label ?: return
        val value = reading ?: return
        text.text = value.label
        text.setTextColor(getColor(value.colorRes))
        val manager = getSystemService(NotificationManager::class.java)
        val current = manager.getNotificationChannel(CHANNEL)
        if (current != null) {
            val updated = NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_idle_charging)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(value.label)
                .setOngoing(true)
                .setSilent(true)
                .build()
            manager.notify(NOTIF_ID, updated)
        }
    }

    private fun windowManager() = getSystemService(WindowManager::class.java)

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val TAG = "FloorKiosk"
        private const val CHANNEL = "battery"
        private const val NOTIF_ID = 41

        fun start(context: Context) {
            val intent = Intent(context, BatteryOverlayService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }
    }
}

internal data class BatteryReading(val percent: Int, val charging: Boolean) {
    val label: String get() = "$percent%"
    val colorRes: Int
        get() = when {
            percent <= 15 && !charging -> R.color.floor_danger
            charging -> R.color.floor_accent
            else -> R.color.floor_text
        }
}

internal fun batteryReading(context: Context): BatteryReading? {
    val sticky = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
    val level = sticky.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = sticky.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
    if (level < 0) return null
    val status = sticky.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
    val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    return BatteryReading(level * 100 / scale, charging)
}
