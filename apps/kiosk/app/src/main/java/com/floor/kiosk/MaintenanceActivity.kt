package com.floor.kiosk

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MaintenanceActivity : AppCompatActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            if (!KioskPolicy.maintenanceActive(this@MaintenanceActivity)) {
                finish()
                return
            }
            val seconds = (KioskPolicy.maintenanceRemainingMs(this@MaintenanceActivity) / 1000).toInt()
            findViewById<TextView>(R.id.maintenance_timer).text =
                "Returns to the register in ${seconds / 60}m ${seconds % 60}s"
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_maintenance)
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Stay here. The timer, or Resume, is what leaves maintenance.
            }
        })
        findViewById<android.view.View>(R.id.action_settings).setOnClickListener {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
        findViewById<android.view.View>(R.id.action_play).setOnClickListener {
            val launch = packageManager.getLaunchIntentForPackage("com.android.vending")
            if (launch != null) startActivity(launch)
        }
        findViewById<android.view.View>(R.id.action_floor).setOnClickListener {
            open(KioskConfig.load(this).floorPackage)
        }
        findViewById<android.view.View>(R.id.action_square).setOnClickListener {
            open(KioskConfig.load(this).squarePackage)
        }
        findViewById<android.view.View>(R.id.action_pin).setOnClickListener { changePin() }
        findViewById<android.view.View>(R.id.action_resume).setOnClickListener {
            KioskPolicy.endMaintenance(this)
            finish()
        }
        findViewById<android.view.View>(R.id.action_relinquish).setOnClickListener { confirmRelinquish() }
    }

    override fun onResume() {
        super.onResume()
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }

    private fun open(packageName: String) {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        startActivity(launch)
    }

    private fun changePin() {
        val current = KioskConfig.load(this)
        PinPrompt(this, "New PIN", flexible = true) { first, prompt ->
            if (first.length !in 4..8) {
                prompt.reject("Use 4 to 8 digits")
                return@PinPrompt
            }
            prompt.dismiss()
            PinPrompt(this, "Repeat PIN", flexible = true) { second, again ->
                if (second != first) {
                    again.reject("PINs did not match")
                    return@PinPrompt
                }
                KioskConfig.save(this, current.withPin(second))
                again.dismiss()
            }.show()
        }.show()
    }

    private fun confirmRelinquish() {
        val config = KioskConfig.load(this)
        PinPrompt(this, "Remove device owner") { pin, prompt ->
            if (pin != config.pin) {
                prompt.reject("Wrong PIN")
                return@PinPrompt
            }
            prompt.dismiss()
            runCatching { stopLockTask() }
            KioskPolicy.relinquish(this, config)
            KioskPolicy.endMaintenance(this)
            finish()
        }.show()
    }
}
