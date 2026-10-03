package com.floor.kiosk

import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class KioskActivity : AppCompatActivity() {
    private lateinit var config: KioskConfig
    private val hotspotTaps = ArrayDeque<Long>()
    private var batteryReceiver: BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_kiosk)
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // The home screen has nowhere to go. Back must not leave the register.
            }
        })
        findViewById<android.view.View>(R.id.admin_hotspot).setOnClickListener { onHotspot() }
        findViewById<android.view.View>(R.id.floor_button).setOnClickListener {
            openApp(config.floorPackage, config.floorLabel)
        }
        findViewById<android.view.View>(R.id.square_button).setOnClickListener {
            openApp(config.squarePackage, config.squareLabel)
        }
        findViewById<android.view.View>(R.id.blink_button).setOnClickListener {
            openApp(BLINK_PACKAGE, "Blink")
        }
        findViewById<android.view.View>(R.id.browser_button).setOnClickListener {
            openApp(BROWSER_PACKAGE, "Browser")
        }
        findViewById<android.view.View>(R.id.motion_alarm_toggle).setOnClickListener {
            BlinkAlarm.setSilent(this, !BlinkAlarm.isSilent(this))
            bind()
        }
        handleCommand(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleCommand(intent)
    }

    override fun onResume() {
        super.onResume()
        config = KioskConfig.load(this)
        bind()
        showBattery()
        if (KioskPolicy.maintenanceActive(this)) {
            startActivity(Intent(this, MaintenanceActivity::class.java))
            return
        }
        enterLock()
        keepScreenOnWhilePlugged()
    }

    override fun onDestroy() {
        batteryReceiver?.let { runCatching { unregisterReceiver(it) } }
        batteryReceiver = null
        super.onDestroy()
    }

    /** Overlay covers Floor and Square. This label is the fallback on the register itself. */
    private fun showBattery() {
        BatteryOverlayService.start(this)
        val label = findViewById<TextView>(R.id.battery)
        val overlay = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)
        label.visibility = if (overlay) View.GONE else View.VISIBLE
        if (overlay) return
        paintBattery(label)
        if (batteryReceiver != null) return
        batteryReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                paintBattery(label)
            }
        }
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(batteryReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(batteryReceiver, filter)
        }
    }

    private fun paintBattery(label: TextView) {
        val reading = batteryReading(this) ?: return
        label.text = reading.label
        label.setTextColor(getColor(reading.colorRes))
    }

    private fun bind() {
        findViewById<TextView>(R.id.title).text = config.title.uppercase()
        findViewById<TextView>(R.id.subtitle).text = config.subtitle
        val floorReady = KioskPolicy.launchable(this, config.floorPackage)
        val squareReady = KioskPolicy.launchable(this, config.squarePackage)
        val blinkReady = KioskPolicy.launchable(this, BLINK_PACKAGE)
        val browserReady = KioskPolicy.launchable(this, BROWSER_PACKAGE)
        findViewById<TextView>(R.id.floor_label).text = config.floorLabel
        findViewById<TextView>(R.id.floor_hint).text = if (floorReady) "Inventory and sales" else "Not installed"
        findViewById<TextView>(R.id.square_label).text = config.squareLabel
        findViewById<TextView>(R.id.square_hint).text = if (squareReady) "Card payments" else "Not installed"
        findViewById<TextView>(R.id.blink_hint).text = if (blinkReady) "Cameras" else "Not installed"
        findViewById<TextView>(R.id.browser_hint).text = if (browserReady) "Web" else "Not installed"
        findViewById<android.view.View>(R.id.floor_button).alpha = if (floorReady) 1f else 0.45f
        findViewById<android.view.View>(R.id.square_button).alpha = if (squareReady) 1f else 0.45f
        findViewById<android.view.View>(R.id.blink_button).alpha = if (blinkReady) 1f else 0.45f
        findViewById<android.view.View>(R.id.browser_button).alpha = if (browserReady) 1f else 0.45f
        findViewById<TextView>(R.id.motion_alarm_toggle).text =
            if (BlinkAlarm.isSilent(this)) "Motion alarm: SILENT — tap to turn on"
            else "Motion alarm: ON — tap to silence"
        val status = when {
            KioskPolicy.isDeviceOwner(this) -> "Locked to this screen"
            else -> "Not device owner yet. USB provisioning still needs to run."
        }
        findViewById<TextView>(R.id.status).text = status
    }

    private fun enterLock() {
        dressWindow()
        if (!KioskPolicy.isDeviceOwner(this)) return
        KioskPolicy.apply(this, config)
        runCatching { startLockTask() }
        KioskPolicy.hideStatusBar(this)
        dressWindow()
    }

    private fun dressWindow() {
        WindowCompat.setDecorFitsSystemWindows(window, true)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.statusBars())
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
    }

    private fun keepScreenOnWhilePlugged() {
        val battery = runCatching {
            registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }.getOrNull()
        val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        if (plugged != 0) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun openApp(packageName: String, label: String) {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        if (launch == null) {
            Toast.makeText(this, "$label is not installed", Toast.LENGTH_SHORT).show()
            return
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(launch)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "Could not open $label", Toast.LENGTH_SHORT).show()
        }
    }

    private fun onHotspot() {
        val now = SystemClock.elapsedRealtime()
        hotspotTaps.addLast(now)
        while (hotspotTaps.isNotEmpty() && now - hotspotTaps.first() > 5_000) hotspotTaps.removeFirst()
        if (hotspotTaps.size < 7) return
        hotspotTaps.clear()
        askPin(getString(R.string.pin_title)) { enterMaintenance() }
    }

    private fun askPin(title: String, onOk: () -> Unit) {
        if (KioskPolicy.pinLockedOut(this)) {
            Toast.makeText(this, "Too many attempts. Wait a minute.", Toast.LENGTH_SHORT).show()
            return
        }
        PinPrompt(this, title) { pin, prompt ->
            if (KioskPolicy.pinLockedOut(this)) {
                prompt.reject("Too many attempts. Wait a minute.")
                return@PinPrompt
            }
            if (pin != config.pin) {
                KioskPolicy.notePinFailure(this)
                prompt.reject(if (KioskPolicy.pinLockedOut(this)) "Too many attempts. Wait a minute." else "Wrong PIN")
                return@PinPrompt
            }
            KioskPolicy.notePinSuccess(this)
            prompt.dismiss()
            onOk()
        }.show()
    }

    private fun enterMaintenance() {
        KioskPolicy.beginMaintenance(this, config.maintenanceMinutes)
        val until = System.currentTimeMillis() + KioskPolicy.maintenanceRemainingMs(this)
        MaintenanceAlarm.schedule(this, until)
        runCatching { stopLockTask() }
        startActivity(Intent(this, MaintenanceActivity::class.java))
    }

    private fun handleCommand(intent: Intent?) {
        val command = intent?.getStringExtra("command") ?: return
        val pin = intent.getStringExtra("pin")
        config = KioskConfig.load(this)
        if (pin != config.pin) return
        when (command) {
            "maintenance" -> enterMaintenance()
            "relinquish" -> {
                runCatching { stopLockTask() }
                KioskPolicy.relinquish(this, config)
                Toast.makeText(this, "Device owner removed", Toast.LENGTH_LONG).show()
            }
            "configure" -> {
                val updates = mutableMapOf<String, String>()
                for (key in listOf(
                    "newPin", "title", "subtitle", "floorPackage", "floorLabel",
                    "squarePackage", "squareLabel", "extraPackages", "maintenanceMinutes",
                )) {
                    intent.getStringExtra(key)?.let { updates[key] = it }
                }
                KioskConfig.applyUpdate(this, pin, updates)
                config = KioskConfig.load(this)
                if (KioskPolicy.isDeviceOwner(this)) KioskPolicy.apply(this, config)
            }
        }
        setIntent(Intent(intent).apply { removeExtra("command"); removeExtra("pin") })
    }

    companion object {
        private const val BLINK_PACKAGE = "com.immediasemi.android.blink"
        private const val BROWSER_PACKAGE = "com.android.chrome"
    }
}
