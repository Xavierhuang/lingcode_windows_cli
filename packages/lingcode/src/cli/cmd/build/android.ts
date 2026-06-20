import fs from "node:fs/promises"
import path from "node:path"

// A minimal, modern, buildable Android Compose app — the starting point
// `lingcode build` scaffolds before the agent loop iterates on it. Versions are
// pinned to a known-good 2026 baseline (AGP 8.7 / Kotlin 2.0 / compileSdk 35).
//
// Note: the Gradle *wrapper jar* is binary and not emitted here; the build step
// runs `gradle wrapper` (system Gradle) to materialize `./gradlew` before the
// first build. Everything else needed to compile a debug APK is written.

export type ScaffoldInput = {
  dir: string
  appName: string
  pkg: string // e.g. dev.lingcode.myapp
}

function files(input: ScaffoldInput): Record<string, string> {
  const { appName, pkg } = input
  const pkgPath = pkg.replace(/\./g, "/")
  return {
    "settings.gradle.kts": `pluginManagement {
  repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
  repositories { google(); mavenCentral() }
}
rootProject.name = ${JSON.stringify(appName)}
include(":app")
`,
    "build.gradle.kts": `plugins {
  id("com.android.application") version "8.7.0" apply false
  id("org.jetbrains.kotlin.android") version "2.0.21" apply false
  id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
`,
    "gradle.properties": `org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
kotlin.code.style=official
`,
    "gradle/wrapper/gradle-wrapper.properties": `distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip
distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`,
    "app/build.gradle.kts": `plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = ${JSON.stringify(pkg)}
  compileSdk = 35

  defaultConfig {
    applicationId = ${JSON.stringify(pkg)}
    minSdk = 24
    targetSdk = 35
    versionCode = 1
    versionName = "0.1"
  }

  buildFeatures { compose = true }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
}

dependencies {
  implementation(platform("androidx.compose:compose-bom:2024.10.00"))
  implementation("androidx.activity:activity-compose:1.9.3")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.ui:ui")
}
`,
    "app/src/main/AndroidManifest.xml": `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application
    android:label="${appName}"
    android:theme="@android:style/Theme.Material.Light.NoActionBar">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`,
    [`app/src/main/java/${pkgPath}/MainActivity.kt`]: `package ${pkg}

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      MaterialTheme {
        Surface { Greeting() }
      }
    }
  }
}

@Composable
fun Greeting() {
  Text("Hello from ${appName} — built by lingcode")
}
`,
  }
}

export async function scaffoldAndroid(input: ScaffoldInput): Promise<string[]> {
  const written: string[] = []
  for (const [rel, content] of Object.entries(files(input))) {
    const abs = path.join(input.dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, "utf8")
    written.push(rel)
  }
  return written.sort()
}
