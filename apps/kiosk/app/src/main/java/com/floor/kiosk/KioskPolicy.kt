package com.floor.kiosk

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.UserManager
import android.provider.Settings
import android.util.Log

/**
 * Device-owner policies for a counter appliance.
 *
 * Deliberately NOT set:
 * - DISALLOW_DEBUGGING_FEATURES (USB debugging must keep working)
 * - DISALLOW_FACTORY_RESET (recovery-mode wipe must keep working)
 * - DISALLOW_MODIFY_ACCOUNTS (a Google account is added after provisioning so Play can update Square)
 * - DISALLOW_INSTALL_APPS (would also block Play updates)
 */
object KioskPolicy {
    private const val TAG = "FloorKiosk"
    private const val PREFS = "floor_kiosk"
    private const val MAINTENANCE_UNTIL = "maintenance_until"
    private const val PIN_LOCKOUT_UNTIL = "pin_lockout_until"

    /** Safe-mode is an employee escape hatch. It does not block recovery. */
    private val RESTRICTIONS = listOf(
        UserManager.DISALLOW_SAFE_BOOT,
        UserManager.DISALLOW_ADD_USER,
        UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
    )

    fun admin(context: Context): ComponentName = ComponentName(context, KioskAdminReceiver::class.java)

    fun dpm(context: Context): DevicePolicyManager =
        context.getSystemService(DevicePolicyManager::class.java)

    fun isDeviceOwner(context: Context): Boolean =
        dpm(context).isDeviceOwnerApp(context.packageName)

    fun maintenanceActive(context: Context): Boolean =
        System.currentTimeMillis() < prefs(context).getLong(MAINTENANCE_UNTIL, 0L)

    fun maintenanceRemainingMs(context: Context): Long =
        (prefs(context).getLong(MAINTENANCE_UNTIL, 0L) - System.currentTimeMillis()).coerceAtLeast(0L)

    fun beginMaintenance(context: Context, minutes: Int) {
        val until = System.currentTimeMillis() + minutes.coerceIn(1, 120) * 60_000L
        prefs(context).edit().putLong(MAINTENANCE_UNTIL, until).apply()
        if (!isDeviceOwner(context)) return
        runCatching { dpm(context).setStatusBarDisabled(admin(context), false) }
            .onFailure { Log.w(TAG, "status bar re-enable failed", it) }
    }

    fun endMaintenance(context: Context) {
        prefs(context).edit().remove(MAINTENANCE_UNTIL).apply()
    }

    fun pinLockedOut(context: Context): Boolean =
        System.currentTimeMillis() < prefs(context).getLong(PIN_LOCKOUT_UNTIL, 0L)

    fun notePinFailure(context: Context) {
        val prefs = prefs(context)
        val fails = prefs.getInt("pin_fails", 0) + 1
        val editor = prefs.edit().putInt("pin_fails", fails)
        if (fails >= 5) {
            editor.putLong(PIN_LOCKOUT_UNTIL, System.currentTimeMillis() + 60_000L)
            editor.putInt("pin_fails", 0)
        }
        editor.apply()
    }

    fun notePinSuccess(context: Context) {
        prefs(context).edit().putInt("pin_fails", 0).remove(PIN_LOCKOUT_UNTIL).apply()
    }

    fun apply(context: Context, config: KioskConfig) {
        if (!isDeviceOwner(context)) return
        val dpm = dpm(context)
        val admin = admin(context)
        val packages = lockPackages(context, config)
        runCatching { dpm.setLockTaskPackages(admin, packages) }
            .onFailure { Log.e(TAG, "setLockTaskPackages failed", it) }
        runCatching { dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_HOME) }
            .onFailure { Log.e(TAG, "setLockTaskFeatures failed", it) }
        runCatching { dpm.setKeyguardDisabled(admin, true) }
            .onFailure { Log.w(TAG, "setKeyguardDisabled failed", it) }
        for (restriction in restrictions()) {
            runCatching { dpm.addUserRestriction(admin, restriction) }
                .onFailure { Log.w(TAG, "restriction $restriction failed", it) }
        }
        for (pkg in listOf(context.packageName, config.floorPackage, config.squarePackage)) {
            if (pkg.isBlank()) continue
            runCatching { dpm.setUninstallBlocked(admin, pkg, true) }
                .onFailure { Log.w(TAG, "uninstall block $pkg failed", it) }
        }
        grantRuntimePermissions(context, config)
        val home = IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        runCatching {
            dpm.addPersistentPreferredActivity(admin, home, ComponentName(context, KioskActivity::class.java))
        }.onFailure { Log.e(TAG, "persistent home failed", it) }
        runCatching {
            Settings.Global.putInt(
                context.contentResolver,
                Settings.Global.STAY_ON_WHILE_PLUGGED_IN,
                BatteryManager.BATTERY_PLUGGED_AC or
                    BatteryManager.BATTERY_PLUGGED_USB or
                    BatteryManager.BATTERY_PLUGGED_WIRELESS,
            )
        }.onFailure { Log.w(TAG, "stay_on_while_plugged_in not writable from the app", it) }
        // Long-press power opens Assistant on this Moto, which sits on top of lock task.
        // 0 is "do nothing" (AOSP LONG_PRESS_POWER_NOTHING). Short-press still sleeps.
        lockPowerButton(context, nothing = true)
    }

    /** Stop long-press power from opening Assistant or the global actions menu. */
    fun lockPowerButton(context: Context, nothing: Boolean) {
        val cr = context.contentResolver
        val longPress = if (nothing) 0 else 1
        runCatching { Settings.Global.putInt(cr, "power_button_long_press", longPress) }
            .onFailure { Log.w(TAG, "power_button_long_press failed", it) }
        runCatching { Settings.Global.putInt(cr, "power_button_very_long_press", longPress) }
            .onFailure { Log.w(TAG, "power_button_very_long_press failed", it) }
        runCatching { Settings.Secure.putInt(cr, "assist_long_press_home_enabled", 0) }
        runCatching { Settings.Secure.putInt(cr, "search_long_press_home_enabled", 0) }
        runCatching { Settings.Secure.putInt(cr, "assist_touch_gesture_enabled", 0) }
    }

    fun hideStatusBar(context: Context) {
        if (!isDeviceOwner(context)) return
        runCatching { dpm(context).setStatusBarDisabled(admin(context), true) }
            .onFailure { Log.w(TAG, "setStatusBarDisabled failed", it) }
    }

    fun relinquish(context: Context, config: KioskConfig) {
        if (!isDeviceOwner(context)) return
        val dpm = dpm(context)
        val admin = admin(context)
        runCatching { dpm.setStatusBarDisabled(admin, false) }
        runCatching { dpm.setKeyguardDisabled(admin, false) }
        runCatching { dpm.setLockTaskPackages(admin, emptyArray()) }
        for (restriction in restrictions()) {
            runCatching { dpm.clearUserRestriction(admin, restriction) }
        }
        for (pkg in listOf(context.packageName, config.floorPackage, config.squarePackage)) {
            if (pkg.isBlank()) continue
            runCatching { dpm.setUninstallBlocked(admin, pkg, false) }
        }
        runCatching { dpm.clearPackagePersistentPreferredActivities(admin, context.packageName) }
        lockPowerButton(context, nothing = false)
        dpm.clearDeviceOwnerApp(context.packageName)
        endMaintenance(context)
        Log.i(TAG, "device owner cleared")
    }

    fun lockPackages(context: Context, config: KioskConfig): Array<String> {
        val names = linkedSetOf(context.packageName)
        if (config.floorPackage.isNotBlank()) names.add(config.floorPackage)
        if (config.squarePackage.isNotBlank()) names.add(config.squarePackage)
        names.add("com.immediasemi.android.blink")
        config.extraPackages.filter { it.isNotBlank() }.forEach { names.add(it) }
        // The "Allow USB debugging?" screen has to be able to open while the
        // register is locked. The shade stays closed: lock task does not enable
        // notifications, and the status bar is disabled separately.
        names.add("com.android.systemui")
        names.add(usbConfirmPackage())
        runCatching {
            context.packageManager.getInstalledPackages(PackageManager.MATCH_UNINSTALLED_PACKAGES)
        }.getOrNull()?.forEach { pkg ->
            val name = pkg.packageName
            if (name.startsWith("com.squareup")) names.add(name)
        }
        // A second pass without the flag, in case MATCH_UNINSTALLED is filtered.
        runCatching { context.packageManager.getInstalledPackages(0) }.getOrNull()?.forEach { pkg ->
            val name = pkg.packageName
            if (name.startsWith("com.squareup")) names.add(name)
        }
        return names.toTypedArray()
    }

    /** OEM builds can point the USB prompt at a package other than SystemUI. */
    private fun usbConfirmPackage(): String {
        val component = runCatching {
            val cls = Class.forName("android.os.SystemProperties")
            val get = cls.getMethod("get", String::class.java, String::class.java)
            get.invoke(
                null,
                "ro.usb.adb.confirmation",
                "com.android.systemui/com.android.systemui.usb.UsbDebuggingActivity",
            ) as String
        }.getOrDefault("com.android.systemui/com.android.systemui.usb.UsbDebuggingActivity")
        val pkg = component.substringBefore("/").trim()
        return if (pkg.isEmpty()) "com.android.systemui" else pkg
    }

    fun launchable(context: Context, packageName: String): Boolean {
        if (packageName.isBlank()) return false
        return context.packageManager.getLaunchIntentForPackage(packageName) != null
    }

    private fun restrictions(): List<String> {
        val list = RESTRICTIONS.toMutableList()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            list.add(UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES_GLOBALLY)
        }
        return list
    }

    private fun grantRuntimePermissions(context: Context, config: KioskConfig) {
        val dpm = dpm(context)
        val admin = admin(context)
        val perms = listOf(
            android.Manifest.permission.CAMERA,
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.ACCESS_COARSE_LOCATION,
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.POST_NOTIFICATIONS,
            android.Manifest.permission.BLUETOOTH_CONNECT,
            android.Manifest.permission.BLUETOOTH_SCAN,
            android.Manifest.permission.BLUETOOTH_ADVERTISE,
            android.Manifest.permission.READ_MEDIA_IMAGES,
            android.Manifest.permission.NEARBY_WIFI_DEVICES,
        )
        val targets = listOf(config.floorPackage, config.squarePackage, context.packageName)
        for (pkg in targets) {
            if (pkg.isBlank()) continue
            for (perm in perms) {
                runCatching {
                    dpm.setPermissionGrantState(
                        admin,
                        pkg,
                        perm,
                        DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
                    )
                }
            }
        }
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
