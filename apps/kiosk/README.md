# Floor phone kiosk

The Android launcher is in `apps/kiosk`. It runs as device owner on the store phone and shows Floor, Square, Blink, and Browser (Chrome). The PIN is injected at build time and must never be committed.

Set `FLOOR_KIOSK_PIN` to the phone's current admin PIN in the local shell, then build `:app:assembleRelease` with Android SDK 35 and Gradle. Keep the existing `.keystore/kiosk-release.jks` private: an update must use the same signing key as the installed device-owner app. Install the resulting `app/build/outputs/apk/release/app-release.apk` with `adb install -r`.

The kiosk keeps USB debugging and recovery factory reset available. Seven taps in the top-right corner open the admin PIN prompt. The `Blink` button opens `com.immediasemi.android.blink`; install Blink from Google Play before using it.

Blink motion notifications trigger a six-second alarm on the phone. The kiosk home screen's **Motion alarm** control toggles a persistent silent mode. Notification access for `com.floor.kiosk/.BlinkMotionListener` must be enabled once on each device; lock task notifications and the notification shade remain disabled.
