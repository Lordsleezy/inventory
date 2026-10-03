package com.floor.kiosk

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_LOCKED_BOOT_COMPLETED) return
        // A reboot ends maintenance. The counter comes back locked.
        KioskPolicy.endMaintenance(context)
        if (KioskPolicy.isDeviceOwner(context)) {
            KioskPolicy.apply(context, KioskConfig.load(context))
        }
        BatteryOverlayService.start(context)
        context.startActivity(
            Intent(context, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

class MaintenanceAlarm : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (KioskPolicy.maintenanceActive(context)) return
        Log.i(TAG, "maintenance window ended")
        context.startActivity(
            Intent(context, KioskActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
    }

    companion object {
        private const val TAG = "FloorKiosk"

        fun schedule(context: Context, atEpochMs: Long) {
            val alarm = context.getSystemService(AlarmManager::class.java)
            val pending = PendingIntent.getBroadcast(
                context,
                7,
                Intent(context, MaintenanceAlarm::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            try {
                alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atEpochMs, pending)
            } catch (_: SecurityException) {
                alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atEpochMs, pending)
            }
        }
    }
}

/**
 * Shell-driven setup and teardown. Every action requires the current PIN so
 * another app on the device cannot reconfigure the register by guessing the action name.
 */
class ConfigReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pin = intent.getStringExtra("pin")
        when (intent.action) {
            ACTION_TEST_ALARM -> {
                if (pin == KioskConfig.load(context).pin) BlinkAlarm.play(context)
            }
            ACTION_APPLY -> {
                val updates = mutableMapOf<String, String>()
                for (key in UPDATE_KEYS) {
                    intent.getStringExtra(key)?.let { updates[key] = it }
                }
                val updated = KioskConfig.applyUpdate(context, pin, updates) ?: return
                if (KioskPolicy.isDeviceOwner(context)) KioskPolicy.apply(context, updated)
                context.startActivity(
                    Intent(context, KioskActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                )
            }
            ACTION_RELINQUISH, ACTION_MAINTENANCE -> {
                context.startActivity(
                    Intent(context, KioskActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        .putExtra("command", if (intent.action == ACTION_RELINQUISH) "relinquish" else "maintenance")
                        .putExtra("pin", pin),
                )
            }
        }
    }

    companion object {
        const val ACTION_APPLY = "com.floor.kiosk.APPLY_CONFIG"
        const val ACTION_RELINQUISH = "com.floor.kiosk.RELINQUISH"
        const val ACTION_MAINTENANCE = "com.floor.kiosk.MAINTENANCE"
        const val ACTION_TEST_ALARM = "com.floor.kiosk.TEST_ALARM"
        private val UPDATE_KEYS = listOf(
            "newPin",
            "title",
            "subtitle",
            "floorPackage",
            "floorLabel",
            "squarePackage",
            "squareLabel",
            "extraPackages",
            "maintenanceMinutes",
        )
    }
}
