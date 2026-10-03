plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val generatedKioskAssets = layout.buildDirectory.dir("generated/kioskAssets")
val generateKioskConfig = tasks.register("generateKioskConfig") {
    val template = layout.projectDirectory.file("kiosk.config.template.json")
    val output = generatedKioskAssets.map { it.file("kiosk.config.json") }
    inputs.file(template)
    outputs.file(output)
    // Keep the admin PIN out of the repository and task output.
    outputs.upToDateWhen { false }
    doLast {
        val pin = System.getenv("FLOOR_KIOSK_PIN")
            ?: error("Set FLOOR_KIOSK_PIN to the kiosk admin PIN before building")
        require(pin.matches(Regex("[0-9]{4,8}"))) { "FLOOR_KIOSK_PIN must be 4 to 8 digits" }
        val file = output.get().asFile
        file.parentFile.mkdirs()
        file.writeText(template.asFile.readText().replace("__FLOOR_KIOSK_PIN__", pin))
    }
}

android {
    namespace = "com.floor.kiosk"
    sourceSets.getByName("main").assets.srcDir(generatedKioskAssets)
    compileSdk = 35

    defaultConfig {
        applicationId = "com.floor.kiosk"
        minSdk = 28
        targetSdk = 35
        versionCode = 4
        versionName = "1.0.3"
    }

    signingConfigs {
        create("release") {
            val store = rootProject.file(".keystore/kiosk-release.jks")
            if (store.exists()) {
                storeFile = store
                storePassword = "floor-kiosk"
                keyAlias = "kiosk"
                keyPassword = "floor-kiosk"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.matching {
    it.name == "mergeReleaseAssets" || it.name == "mergeDebugAssets" ||
        it.name.contains("Lint") || it.name.contains("lint")
}
    .configureEach { dependsOn(generateKioskConfig) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
