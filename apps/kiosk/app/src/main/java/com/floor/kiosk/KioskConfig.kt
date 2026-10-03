package com.floor.kiosk

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Store-agnostic kiosk settings. Asset defaults ship with the app. Shared
 * preferences override them after provisioning or an admin PIN change.
 * Nothing in here is specific to one retailer.
 */
data class KioskConfig(
    val title: String,
    val subtitle: String,
    val pin: String,
    val floorPackage: String,
    val floorLabel: String,
    val squarePackage: String,
    val squareLabel: String,
    val extraPackages: List<String>,
    val maintenanceMinutes: Int,
) {
    fun withPin(next: String): KioskConfig = copy(pin = next)

    companion object {
        private const val PREFS = "floor_kiosk"

        fun load(context: Context): KioskConfig {
            val raw = readAsset(context)
            val defaults = fromJson(raw)
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val assetRev = JSONObject(raw).optInt("pinRevision", 1)
            val savedRev = prefs.getInt("pinRevision", 0)
            if (savedRev < assetRev) {
                prefs.edit().putString("pin", defaults.pin).putInt("pinRevision", assetRev).apply()
            }
            val extra = prefs.getString("extraPackages", null)
            return defaults.copy(
                title = prefs.getString("title", null) ?: defaults.title,
                subtitle = prefs.getString("subtitle", null) ?: defaults.subtitle,
                pin = prefs.getString("pin", null) ?: defaults.pin,
                floorPackage = prefs.getString("floorPackage", null) ?: defaults.floorPackage,
                floorLabel = prefs.getString("floorLabel", null) ?: defaults.floorLabel,
                squarePackage = prefs.getString("squarePackage", null) ?: defaults.squarePackage,
                squareLabel = prefs.getString("squareLabel", null) ?: defaults.squareLabel,
                extraPackages = extra?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }
                    ?: defaults.extraPackages,
                maintenanceMinutes = prefs.getInt("maintenanceMinutes", defaults.maintenanceMinutes),
            )
        }

        fun save(context: Context, config: KioskConfig) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("title", config.title)
                .putString("subtitle", config.subtitle)
                .putString("pin", config.pin)
                .putString("floorPackage", config.floorPackage)
                .putString("floorLabel", config.floorLabel)
                .putString("squarePackage", config.squarePackage)
                .putString("squareLabel", config.squareLabel)
                .putString("extraPackages", config.extraPackages.joinToString(","))
                .putInt("maintenanceMinutes", config.maintenanceMinutes)
                .apply()
        }

        /**
         * Apply a provisioning broadcast. [authPin] must match the current PIN.
         * Returns the updated config, or null when the PIN is wrong.
         */
        fun applyUpdate(context: Context, authPin: String?, updates: Map<String, String>): KioskConfig? {
            val current = load(context)
            if (authPin.isNullOrBlank() || authPin != current.pin) return null
            var next = current
            updates["newPin"]?.let { if (it.length in 4..8 && it.all(Char::isDigit)) next = next.copy(pin = it) }
            updates["title"]?.let { if (it.isNotBlank()) next = next.copy(title = it) }
            updates["subtitle"]?.let { next = next.copy(subtitle = it) }
            updates["floorPackage"]?.let { if (it.isNotBlank()) next = next.copy(floorPackage = it) }
            updates["floorLabel"]?.let { if (it.isNotBlank()) next = next.copy(floorLabel = it) }
            updates["squarePackage"]?.let { if (it.isNotBlank()) next = next.copy(squarePackage = it) }
            updates["squareLabel"]?.let { if (it.isNotBlank()) next = next.copy(squareLabel = it) }
            updates["extraPackages"]?.let { raw ->
                next = next.copy(extraPackages = raw.split(',').map { it.trim() }.filter { it.isNotEmpty() })
            }
            updates["maintenanceMinutes"]?.toIntOrNull()?.let {
                if (it in 1..120) next = next.copy(maintenanceMinutes = it)
            }
            save(context, next)
            return next
        }

        private fun readAsset(context: Context): String =
            context.assets.open("kiosk.config.json").bufferedReader().use { it.readText() }

        private fun fromJson(raw: String): KioskConfig {
            val json = JSONObject(raw)
            return KioskConfig(
                title = json.optString("title", "Register"),
                subtitle = json.optString("subtitle", ""),
                pin = json.getString("pin"),
                floorPackage = json.optString("floorPackage", "com.openboxindustries.floor"),
                floorLabel = json.optString("floorLabel", "Floor"),
                squarePackage = json.optString("squarePackage", "com.squareup"),
                squareLabel = json.optString("squareLabel", "Square"),
                extraPackages = json.optJSONArray("extraPackages").toList(),
                maintenanceMinutes = json.optInt("maintenanceMinutes", 10).coerceIn(1, 120),
            )
        }

        private fun JSONArray?.toList(): List<String> {
            if (this == null) return emptyList()
            return buildList {
                for (i in 0 until length()) {
                    val value = optString(i).trim()
                    if (value.isNotEmpty()) add(value)
                }
            }
        }
    }
}
