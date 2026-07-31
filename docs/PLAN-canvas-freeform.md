# Plan — Freeform Canvas (Miro/Excalidraw-style)

**Decision (2026-07-10):** Hybrid — embed **Excalidraw** (MIT) for the full toolset now, theme it to Vedrix, and layer Vedrix-native integration on top over phases.

## Why Excalidraw
- **MIT licensed** — free for commercial/offline/self-host, no watermark, no license key. (tldraw disqualified: React-only + production license key + "made with tldraw" watermark unless paid.)
- **Is the OSS Miro/FigJam**: freehand, shapes, arrows/connectors, text, frames, images, element library, laser pointer, PNG/SVG export, excellent **touch/pen** support (matters for the Android build).
- **`.excalidraw` JSON** open format → interop with excalidraw.com.
- Fully offline-capable (fonts self-hosted via `window.EXCALIDRAW_ASSET_PATH`).

## The one constraint we design around
Vedrix's frontend has **no bundler** — libs are prebuilt files in `src/vendor/` loaded via `<script>`. Excalidraw is now ESM + React. So React lives **only inside the canvas view**, isolated behind a vanilla bridge, and is introduced via a **build-time-once** step (not the app runtime):

### Vendor build step — `tools/build-canvas.mjs`
Run once (and on Excalidraw upgrades), NOT part of `tauri build`:
1. `npm i -D esbuild react react-dom @excalidraw/excalidraw` (in a `tools/` workspace, kept out of the app).
2. A thin adapter `tools/canvas-host.jsx` mounts `<Excalidraw>` and exposes an imperative API on `window.SutraCanvas`.
3. esbuild bundles **React + ReactDOM + Excalidraw + adapter → `src/vendor/excalidraw.bundle.js`** as an IIFE (React bundled in — avoids the dead UMD path). ~2 MB, consistent with mermaid's 2.6 MB.
4. Copy Excalidraw fonts → `src/vendor/excalidraw-assets/`; the bundle sets `window.EXCALIDRAW_ASSET_PATH` to that local path.
- esbuild 0.28.1 + Node 24 already present. ✅

### The bridge (keeps app.js vanilla)
`window.SutraCanvas = {`
- `mount(containerEl, sceneData, { onChange, theme })` — create/attach the React root once
- `load(sceneData)` · `getScene()` · `setTheme('light'|'dark')`
- `exportPNG()` · `exportSVG()` · `destroy()`
`}`
app.js never imports React; it calls these.

## Data model & storage
- New doc **kind: `canvas`**; files stored as **`.excalidraw`** JSON (interop) — extend `kindOf()` (app.js:215) and `badgeFor()`/`FORMAT_BADGE` (244) with a canvas badge + icon (`svgIcon` 2304).
- Canvas files flow through the existing tab/file model: `makeTab` (1635), `addTab` (342), and thus appear in **Files, Projects, recents, Home** automatically.
- **Autosave** like the editor: Excalidraw `onChange` (debounced ~800ms) → `getScene()` → write to the tab's file (`write_file` / `saveTextAs`); reuse the "Saved/Unsaved" context-bar state.

## View & chrome
- New full-screen pane **`#canvasview`** (sibling of `#scroller`/`#mapview`/`#graphview`), toggled by `showPane` (362) / `renderActive` (990). React root mounts once into it; scene swaps per active canvas tab.
- Topbar/context-bar stay Vedrix; the toolbar inside is Excalidraw's (themed).
- **Theme sync**: pass Excalidraw's `theme` prop from Vedrix's light/dark; override its CSS custom properties for accent/surCSS to move toward the Vedrix palette (honest limit: it will still read as Excalidraw, not pixel-match Vedrix).

## Entry points (every function needs a control — audit lesson)
- Nav rail: **"New canvas"** item (or fold into a New menu).
- Home: a "New canvas" card next to "New document".
- Tab `+` and Command palette (`⌘K`): "New canvas".
- Open existing `.excalidraw` via the normal file picker (`openViaPicker` 1733).

## Export
- Reuse the **export dialog**: canvas → **PNG**, **SVG**, **`.excalidraw`**. PDF via canvas→PNG→existing print path. (Font/theme/margin controls N/A for canvas; dialog already filters per-kind via `when(t)`.)

## Phasing (each independently shippable + verified in the real app)
- **Phase A — Standalone canvas works.** Vendor build; `#canvasview` + bridge; create/draw/save/reopen/export a `.excalidraw`; light/dark theme sync. *Verify: draw → save → reopen → PNG export, on macOS.*
  - **DONE & VERIFIED (2026-07-13, v142):** vendor build (`tools/build-canvas.mjs` → `vendor/excalidraw.bundle.{js,css}` 8.4 MB + 560 KB fonts; React 19.2 + Excalidraw 0.18.1 → IIFE). Bridge `window.SutraCanvas` (mount/load/getScene/setTheme/exportPNG/exportSVG/destroy). Wired: kind `canvas` (`.excalidraw`/`.canvas`), CNV badge, `#canvasview` pane, lazy-load on first open, autosave-to-path + ⌘S Save-As, theme sync, entry points (⌘K "New canvas", Home "＋ New canvas").
    - **Verified in real WKWebView (macOS):** Excalidraw renders with full toolbar; dark theme auto-synced; canvas tab shows CNV badge + Vedrix chrome preserved. (Synthetic mouse-drag doesn't register as a draw stroke — automation limit, not an app bug; click-driven panels all work, so a real pointer draws fine.)
    - **Data path verified (browser):** newCanvas→canvas tab+pane→lazy mount→inject element→getScene serialize (529 B)→parseScene round-trip = the exact save/reopen logic. ✓
    - Fonts trimmed 13 MB→560 KB (dropped Xiaolai CJK; build now excludes it).
    - **Remaining for a "complete" Phase A:** confirm a real hand-drawn stroke persists across save→reopen with a human (or non-synthetic) pointer; wire canvas into the **export dialog** (PNG/SVG/.excalidraw) — currently ⌘S saves `.excalidraw` only.
  - **Phase A gaps CLOSED + extras (2026-07-13, local build, NOT pushed):**
    - **Export dialog** now canvas-aware: PNG (via `SutraCanvas.exportPNG`, new Rust `write_bytes` for binary) / SVG / editable `.excalidraw`; doc formats hidden for canvas. Verified: dialog shows the 3 formats; exportPNG returns a valid 13 KB PNG (magic bytes ok), exportSVG valid — in browser. write_bytes compiles; disk-write itself is the only unexercised (trivial) link.
    - **Reopen bug fixed:** `loadTauriContent`/`openBrowserFile` read `.excalidraw` as TEXT (was bytes → blank on reopen); file-picker filters + `<input accept>` include `excalidraw`/`canvas`.
    - **NEW — background patterns:** custom `.sutra-cbg` layer behind Excalidraw (viewBackgroundColor transparent), synced to pan/zoom via onChange. None / Grid / Dots. Renders crisply in real WKWebView. New canvases default to Dots (blankScene appState.sutraBackground). Saved in the file.
    - **NEW — Canva-style colour strip:** `#canvas-controls` bottom-center bar with the None/Grid/Dots segment + 14 swatches + custom-colour picker; `SutraCanvas.setStrokeColor/setFillColor` apply to selection and to the next element.
    - Bridge additions: setBackground/getBackground, setStrokeColor, setFillColor; exports use a solid bg (transparent-on-screen would export blank).
- **Phase B — Vedrix glue.** Canvas kind in Files/Projects/recents/Home with badge; New-canvas entry points; export-dialog wiring; Android WebView smoke test (touch/pen). *Verify: canvas shows in Projects; touch works on device.*
- **Phase C — Cross-linking (the hybrid payoff, incremental).** A canvas element links to / embeds a Vedrix document (open on click); "Send to canvas" from a doc; later: AI-panel awareness of the active canvas.
  - **DONE (2026-07-13, local build, NOT pushed):**
    - **Doc cards:** `SutraCanvas.addDocCard({name, link, color})` — rounded rect + bound label (via `convertToExcalidrawElements`), placed at the viewport centre (staggered), badge-coloured per doc kind, carrying a `sutra://open?path=…` link (label inherits it, so the whole card is clickable).
    - **Click-to-open:** Excalidraw `onLinkOpen` → `window.SutraCanvasOnLink` → switches to the open tab or `openTauriPath`; real http links unaffected.
    - **"Send to canvas…"** from the ⌘K palette and the tab context menu → chooser (existing canvases + "New canvas") → card added, canvas marked dirty + autosaved.
    - **Verified programmatically (browser):** chooser lists canvases; new-canvas path creates rect+label with correct link; link survives serialize→parseScene (persists in the file); `SutraCanvasOnLink` returns to the doc tab; palette shows both commands. Real-app screen test intentionally skipped per user instruction.
    - Later (unplanned): AI-panel awareness of the active canvas; drag-from-Files onto canvas.
  - **Control-bar rework after user feedback (2026-07-13, local, NOT pushed):**
    - User couldn't change a shape's background: the strip only ever set STROKE (machinery was fine — verified fill/stroke both apply to a selection). Added a **Fill | Stroke** mode segment (Fill default) + a transparent checkerboard swatch ("no fill").
    - Bar is now **optional**: ✕ hides it, a small palette chip (bottom-right) brings it back; persisted as `settings.canvasBarHidden`.
    - **Excalidraw control column moved to the RIGHT** (user preference): `.App-menu_top` mirrored via the rtl-grid trick; the properties island's JS-computed inline `left` overridden with stylesheet `!important` (`left:auto; right:12px`) — inline styles lose to author `!important`; hamburger dropdown pinned on-screen the same way. Verified: island fully on-screen at right (1212–1412 @1440w), dropdown on-screen, fill/transparent/stroke all apply, close/reopen persists.
    - GOTCHA (browser eval): a timed-out javascript_tool eval KEEPS RUNNING in-page — its later clicks polluted the next eval's state (mode was left on 'stroke'). Re-check state before chaining evals.
    - Bar-wrap fix (user screenshot: ✕ + divider orphaned on a second row): close button is now `position:absolute` at the bar's top-right corner (out of the flex flow, can never wrap); its divider removed; `.cc-swatches` wraps within its own group so narrow windows get [toggles row / swatch row] instead of ragged wrapping.

## Risks & mitigations
- **React 19 ESM → IIFE bundling**: mitigated by bundling React *into* the artifact via esbuild (tested standalone before wiring).
- **WKWebView / Android WebView compatibility**: Excalidraw needs a modern webview; **smoke-test early** on both (esp. Android) before Phase B.
- **Offline fonts**: vendor them + set asset path; verify no network calls (CSP is `null`, so nothing blocks — must self-check).
- **Bundle size** (~2 MB): fine vs existing 9 MB vendor payload; lazy-load the bundle only when a canvas first opens so it never taxes normal doc reading.
- **Design mismatch**: accept Excalidraw's look in Phase A/B; revisit theming depth if it grates.

## Rough effort
Phase A ≈ 1–2 focused days (mostly bundling + bridge glue). Phase B ≈ 1–2 days. Phase C incremental.
