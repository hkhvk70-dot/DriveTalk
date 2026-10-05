import java.net.URI

plugins { alias(libs.plugins.android.application) }

// Configure your own HTTPS deployment at build time; no owner's server is bundled.
val homeUrl = providers.gradleProperty("DRIVETALK_HOME_URL").orElse("https://console.example.invalid/dashboard/").get()
val homeUri = URI(homeUrl)
require(homeUri.scheme == "https" && !homeUri.host.isNullOrBlank() && homeUri.userInfo == null)
require(homeUri.query == null && homeUri.fragment == null && homeUri.path.endsWith("/") && homeUri.path != "/")
require(homeUri.normalize() == homeUri && !homeUri.rawPath.contains('%'))
require(homeUri.port == -1 || homeUri.port in 1..65535)
require(!homeUrl.contains('"') && !homeUrl.contains('\\') && homeUrl.all { it.code >= 32 })

android {
    namespace = "org.drivetalk.app"
    compileSdk = 36
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "org.drivetalk.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("boolean", "OFFLINE_ASR", providers.gradleProperty("DRIVETALK_OFFLINE_ASR").orElse("false").get())
        buildConfigField("String", "HOME_URL", "\"$homeUrl\"")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}
dependencies { implementation("androidx.activity:activity:1.8.0")
    implementation("com.alphacephei:vosk-android:0.3.75@aar")
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    testImplementation("junit:junit:4.13.2") }
