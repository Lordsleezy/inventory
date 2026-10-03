package com.floor.kiosk

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlin.math.PI
import kotlin.math.sin

/** A short, distinct siren on the alarm audio stream. The user can silence it on the kiosk home. */
object BlinkAlarm {
    private const val PREFS = "floor_kiosk"
    private const val SILENT = "blink_alarm_silent"
    private const val TAG = "FloorKiosk"
    private const val SAMPLE_RATE = 22050
    private const val SECONDS = 6
    private val handler = Handler(Looper.getMainLooper())
    private var track: AudioTrack? = null
    private var manager: AudioManager? = null
    private var previousVolume: Int? = null
    private val stopAction = Runnable { stop() }

    fun isSilent(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(SILENT, false)

    fun setSilent(context: Context, silent: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(SILENT, silent).apply()
        if (silent) stop()
    }

    fun play(context: Context) {
        if (isSilent(context)) return
        stop()
        try {
            val audio = context.getSystemService(AudioManager::class.java)
            manager = audio
            previousVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
            audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
            val samples = siren()
            track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(samples.size * 2)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            track?.write(samples, 0, samples.size)
            track?.play()
            handler.postDelayed(stopAction, SECONDS * 1_000L + 500L)
        } catch (error: Exception) {
            Log.e(TAG, "Could not play Blink motion alarm", error)
            stop()
        }
    }

    fun stop() {
        handler.removeCallbacks(stopAction)
        track?.let {
            runCatching { it.stop() }
            it.release()
        }
        track = null
        previousVolume?.let { volume ->
            runCatching { manager?.setStreamVolume(AudioManager.STREAM_ALARM, volume, 0) }
        }
        previousVolume = null
        manager = null
    }

    private fun siren(): ShortArray {
        val samples = ShortArray(SAMPLE_RATE * SECONDS)
        for (i in samples.indices) {
            val frequency = if ((i / (SAMPLE_RATE / 4)) % 2 == 0) 880.0 else 660.0
            // Fade each edge to avoid clicks when the pitch changes.
            val edge = i % (SAMPLE_RATE / 4)
            val fade = minOf(1.0, edge / 200.0, ((SAMPLE_RATE / 4) - edge) / 200.0)
            samples[i] = (sin(2.0 * PI * frequency * i / SAMPLE_RATE) * 22_000 * fade).toInt().toShort()
        }
        return samples
    }
}
