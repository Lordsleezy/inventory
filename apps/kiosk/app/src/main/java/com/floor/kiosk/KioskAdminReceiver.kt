package com.floor.kiosk

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent

class KioskAdminReceiver : DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        val config = KioskConfig.load(context)
        KioskPolicy.apply(context, config)
    }

    override fun onLockTaskModeExiting(context: Context, intent: Intent) {
        if (KioskPolicy.maintenanceActive(context)) return
        if (!KioskPolicy.isDeviceOwner(context)) return
        context.startActivity(
            Intent(context, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
