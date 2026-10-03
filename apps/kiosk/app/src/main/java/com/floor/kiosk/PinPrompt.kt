package com.floor.kiosk

import android.app.Dialog
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** Full-screen numeric pad. The caller decides what a correct PIN does. */
class PinPrompt(
    private val activity: AppCompatActivity,
    private val heading: String,
    /** When true, the pad waits for OK so a new PIN can be 4 to 8 digits. */
    private val flexible: Boolean = false,
    private val onSubmit: (pin: String, prompt: PinPrompt) -> Unit,
) {
    private val digits = StringBuilder()
    private val dots: TextView
    private val error: TextView
    private val dialog: Dialog

    init {
        val density = activity.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(COLOR_BG)
            setPadding(dp(24), dp(48), dp(24), dp(32))
        }
        root.addView(label(heading, 14f, COLOR_MUTE, dp(8)))
        dots = label("————", 28f, COLOR_TEXT, dp(8)).apply {
            letterSpacing = 0.4f
            gravity = Gravity.CENTER
        }
        root.addView(dots, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        error = label("", 14f, COLOR_DANGER, dp(12)).apply { gravity = Gravity.CENTER }
        root.addView(error, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        val grid = GridLayout(activity).apply { columnCount = 3 }
        val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", if (flexible) "ok" else "cancel", "0", "del")
        for (key in keys) {
            val button = TextView(activity).apply {
                text = when (key) {
                    "cancel" -> "Cancel"
                    "ok" -> "OK"
                    "del" -> "Delete"
                    else -> key
                }
                gravity = Gravity.CENTER
                setTextColor(if (key == "cancel" || key == "del" || key == "ok") COLOR_MUTE else COLOR_TEXT)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, if (key == "cancel" || key == "del" || key == "ok") 16f else 28f)
                typeface = Typeface.create("sans-serif", Typeface.NORMAL)
                setBackgroundColor(COLOR_PANEL)
                setOnClickListener { onKey(key) }
            }
            val params = GridLayout.LayoutParams().apply {
                width = 0
                height = dp(72)
                columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f)
                setMargins(dp(6), dp(6), dp(6), dp(6))
            }
            grid.addView(button, params)
        }
        root.addView(grid, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        dialog = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen).apply {
            setContentView(root)
            setCancelable(true)
            setOnCancelListener { dismiss() }
            window?.setBackgroundDrawable(ColorDrawable(COLOR_BG))
            window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
        }
    }

    fun show() {
        digits.clear()
        render()
        dialog.show()
    }

    fun dismiss() {
        dialog.dismiss()
    }

    fun reject(message: String) {
        digits.clear()
        error.text = message
        render()
    }

    private fun onKey(key: String) {
        error.text = ""
        when (key) {
            "cancel" -> dismiss()
            "ok" -> {
                if (digits.length !in 4..8) {
                    error.text = "Use 4 to 8 digits"
                    return
                }
                onSubmit(digits.toString(), this)
                return
            }
            "del" -> if (digits.isNotEmpty()) digits.deleteAt(digits.length - 1)
            else -> if (digits.length < 8) digits.append(key)
        }
        render()
        if (!flexible && key != "del" && digits.length >= 4) {
            val expected = KioskConfig.load(activity).pin.length
            if (digits.length == expected) onSubmit(digits.toString(), this)
        }
    }

    private fun render() {
        dots.text = if (digits.isEmpty()) "————" else "●".repeat(digits.length)
    }

    private fun label(text: String, sp: Float, color: Int, bottom: Int): TextView =
        TextView(activity).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
            setTextColor(color)
            setPadding(0, 0, 0, bottom)
            gravity = Gravity.CENTER
        }

    private companion object {
        const val COLOR_BG = 0xFF0B0B0B.toInt()
        const val COLOR_PANEL = 0xFF1A1A1A.toInt()
        const val COLOR_TEXT = 0xFFEDEDED.toInt()
        const val COLOR_MUTE = 0xFF8A8A8A.toInt()
        const val COLOR_DANGER = 0xFFFF4D4D.toInt()
    }
}
