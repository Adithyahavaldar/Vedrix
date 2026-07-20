# Building Sutra across platforms

Sutra is one Tauri 2 codebase. The web frontend (`src/`) is identical everywhere; only packaging and a few platform shims differ.

## Local macOS build (what we use now)

```bash
npm install
PATH="/opt/homebrew/opt/rustup/bin:$PATH" npx tauri build --bundles app
ditto "src-tauri/target/release/bundle/macos/Sutra.app" "/Applications/Sutra.app"
```

Notes:

-   `--bundles app` skips the DMG (DMG bundling drives Finder via AppleScript and fails in a headless shell). For a shareable DMG, run `npx tauri build` from a normal Terminal.
-   macOS-only window chrome (overlay titlebar, hidden title) lives in `src-tauri/tauri.macos.conf.json`, merged over `tauri.conf.json` at build time.

## Windows

**You cannot build a Windows binary on macOS** — Tauri needs the Windows toolchain + WebView2. Two ways to get one:

1.  **CI (recommended):** push a tag `vX.Y.Z`; the GitHub Actions workflow (`.github/workflows/release.yml`) builds macOS (arm+intel), Windows `.msi`, and Linux `.deb`/AppImage, and attaches them to a draft Release.
    
2.  **On a Windows machine:**
    
    ```powershell
    # once: install Rust (rustup), Node, and WebView2 (preinstalled on Win 11)
    npm install
    npx tauri build          # produces an .msi + .exe (NSIS) installer
    ```
    

Windows specifics already handled in code:

-   Native window decorations (no overlay titlebar) — the traffic-light inset is gated to `body.mac` only.
-   `open_externally` uses `cmd /C start` on Windows, `open` on macOS, `xdg-open` on Linux.
-   File-open on launch comes via argv (already handled in `setup()`), not the macOS `RunEvent::Opened` Apple event.
-   Diagnostics write to the OS temp dir (`std::env::temp_dir()`), not `/tmp`.

Signing (to avoid SmartScreen warnings): set an OV/EV cert. Azure Trusted Signing is the cheapest path; wire its secrets into the workflow.

## Android

**The responsive mobile UI is done** — at ≤720px viewport width Sutra switches to: a slide-in drawer sidebar (hamburger), a collapsed topbar with a `⋯` overflow menu, a full-screen AI sheet, 40px touch targets, and pinch-to-zoom on PDFs/slides. This activates automatically inside the Android webview.

Prerequisites (this Mac currently has **Java 8 and no SDK** — all three needed):

-   **JDK 17+** — `brew install openjdk@17` (Tauri’s Gradle needs 17, not 8).
    
-   **Android Studio** — installs the SDK + platform tools.
    
-   **Android SDK + NDK** — via Android Studio’s SDK Manager (NDK is under “SDK Tools”).
    
-   Env vars in your shell profile:
    
    ```bash
    export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
    export ANDROID_HOME="$HOME/Library/Android/sdk"
    export NDK_HOME="$ANDROID_HOME/ndk/<version>"
    ```
    

Then:

```bash
npx tauri android init      # one-time; scaffolds gen/android
npx tauri android dev       # run on an emulator or USB device
npx tauri android build     # produces an .aab for Play ($25 one-time)
```

Still to do for a shippable Android app: file intake from the OS share sheet / document picker (Android doesn’t use file associations the way desktop does), and Play Store assets. The reading UI itself already works on a phone.

## Product identity note

App name is **Sutra** (bundle id `com.adithya.sutra`) with a custom icon (golden thread “S” + bindu on indigo). Same identity carries across all platforms.

## iOS

```bash
npx tauri ios init          # one-time; needs Xcode
npx tauri ios dev
npx tauri ios build         # needs Apple Developer Program ($99/yr)
```

## Release checklist

1.  Bump `version` in `src-tauri/tauri.conf.json` **and** the `?v=NNN` asset query in `src/index.html` (busts the WebView cache).
2.  Commit, tag `vX.Y.Z`, push the tag.
3.  CI builds all platforms → draft GitHub Release.
4.  Add signing secrets to the repo so installers are trusted (see workflow env).
5.  Publish the release.

  

-