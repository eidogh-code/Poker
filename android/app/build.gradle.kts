import java.util.Properties

plugins {
    id("com.android.application")
}

// Ключ подписи хранится вне репозитория. Где искать его настройки:
// 1) переменная окружения POKER_KEYSTORE_PROPERTIES (так делает GitHub Actions),
// 2) android/keystore.properties,
// 3) ~/.android/poker-release.properties.
// Если ничего нет, релизная сборка подписывается отладочным ключом — APK ставится, но обновлять его придётся с удалением.
val signingFile = listOfNotNull(
    System.getenv("POKER_KEYSTORE_PROPERTIES")?.let(::File),
    rootProject.file("keystore.properties"),
    File(System.getProperty("user.home"), ".android/poker-release.properties"),
).firstOrNull { it.isFile }

val signingProps = Properties().apply { signingFile?.inputStream()?.use(::load) }

android {
    namespace = "com.eidogh.poker"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.eidogh.poker"
        minSdk = 24
        targetSdk = 35
        versionCode = 3
        versionName = "1.2.0"
    }

    signingConfigs {
        if (signingFile != null) {
            create("release") {
                storeFile = signingFile.parentFile.resolve(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Игра одна на все платформы: та же папка poker/, что в Windows и в браузере.
    sourceSets["main"].assets.srcDirs("../../poker")
}

base.archivesName.set("Poker-${android.defaultConfig.versionName}")

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
