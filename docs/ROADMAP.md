# Markdown Viewer — Roadmap & Ideation

*Drafted 2026-07-03, after v0.4 (tabs, themes, multi-format, topic sidebars).*

## Where we are

A 10 MB native viewer that opens MD / PDF / DOCX / PPTX / XLSX / CSV / text in
Chrome-style tabs, with 10 themes, topic sidebars for every format, live
reload, history, session restore, resizable sidebar, and auto-hiding scroll
indicators. The core "double-click → read" promise is delivered. The next
phases turn a *viewer* into a *reading workspace*.

---

## Theme 1 — Deeper reading & navigation

| Feature | Notes | Effort |
|---|---|---|
| ⌘F in-document search | Find bar, highlights, match count, Enter/⇧Enter. MD **and** PDF (PDF.js exposes per-page text) | M |
| PDF text selection & copy | Add PDF.js invisible text layer over each canvas | M |
| PDF zoom | Fit-width / fit-page / % zoom, pinch gesture | S–M |
| Reading position memory | Store scroll position in history; reopen where you left off | S |
| Relative `.md` links in-app | Click local md link → new tab. Foundation for wiki mode | S |
| Back/forward nav | ⌘[ / ⌘] across link jumps and TOC clicks | S |
| Mermaid + KaTeX | Diagrams + math in markdown | S |
| Presentation mode | Full-screen slide-per-screen for PPTX and MD (H2 = slide) | M |

## Theme 2 — From files to a library

- **Folder / wiki mode** — open a folder → file tree beside Contents (two sidebar tabs). (M)
- **Full-text search across library** — index folder + history (FlexSearch or similar). (M–L)
- **Pinned tabs** for daily-driver docs. (S)
- **Split view** — two documents side by side. (M)
- **Tab overview** (⌘⇧A) — grid of open tabs with previews. (M)

## Theme 3 — Light document workflows (view-first, no editing)

- **Annotations & highlights** — select → highlight/margin note, stored sidecar (file untouched), listed in a sidebar panel. (L)
- **Bookmarks / reading list** — star docs/positions; "Continue reading" on the empty screen. (S)
- **Export engine** — styled print/⌘P, MD → PDF/HTML in current theme, copy-as-rich-text. (M)
- **OCR for scanned PDFs** — Apple Vision framework (on-device, strong Indic script support) for image-only pages → topics + search work on scans. (M–L)

## Theme 4 — AI layer

- Summarize document/section (side panel).
- Chat with the open document (user's Claude API key in settings).
- Smart topics when heading heuristics fail.
- Inline translation toggle (Devanagari ↔ English mixed documents).

## Theme 5 — Format depth

- **PPTX fidelity ladder**: bullets/indent → shape fills → tables → layout/master inheritance → charts-as-tables → speaker notes. Each rung standalone. (S each)
- **XLSX**: sheet tabs UI, virtualized big sheets, number formats. (M)
- **New formats**: `.ipynb` notebooks, EPUB, images, syntax-highlighted source files. (S–M each)

## Theme 6 — macOS citizenship

- Custom app icon (still the default Tauri icon — overdue). (S)
- Native menu bar + Dock recent-files menu. (S–M)
- Quick Look extension. (M)
- `mdv` CLI. (S)
- Signing, notarization, auto-updater — needed the day it's shared. (M)

## Theme 7 — Performance & robustness

- Virtualized rendering for very large markdown files; parse in a worker.
- PDF memory cap (destroy far-off-screen canvases); re-render pages on window resize.

---

## Theme 8 — Create & convert *(added 2026-07-03)*

- **Export/Convert menu**, built as a ladder:
  - Tier 1: MD → self-contained themed HTML; MD → PDF (themed print pipeline);
    DOCX/PPTX/XLSX → MD (existing HTML pipeline + Turndown); XLSX → CSV.
  - Tier 2: MD → DOCX (`docx` JS library).
  - Tier 3: optional **pandoc sidecar** (one-time ~30 MB download) for the full
    matrix — EPUB, LaTeX, ODT.
- **Edit mode (⌘E)** — per-tab toggle: CodeMirror source + live preview
  side-by-side, debounced auto-save (live-reload watcher paused during writes),
  dirty-dot on tab. MD/plain-text only; app stays reader-first by default.
- **PDF → MD reading mode** — extends the existing per-line font-size
  extraction: size tiers → headings, spacing → paragraphs, bullet glyphs →
  lists. Toggle on every PDF tab (Safari Reader-style). Tables/multi-column are
  best-effort v1; AI cleanup pass later (Theme 4). Output is a real MD tab →
  exportable via the Convert menu.

## Theme 9 — Mind maps & graphs *(added 2026-07-03)*

Ladder, each rung standalone:
1. **Structure mind map** — the heading/topic tree we already build for every
   format, rendered with **markmap** (vendorable, interactive). "Mind map"
   toggle on any tab — works for PDFs and decks too. Quick win.
2. **Map varieties** — same tree, more renderers: outline tree, org-chart,
   Mermaid flowchart/timeline (also exportable as markdown/mermaid).
3. **AI concept maps** (NotebookLM-style) — LLM emits concept hierarchy /
   relationship JSON, rendered with the same engines.
4. **Knowledge graph across files** — needs folder mode; parse `[[links]]` and
   relative links → force-directed library graph (Cytoscape.js), Obsidian-style.

## Theme 10 — Productization: Android · iOS · Windows · macOS *(added 2026-07-03)*

Tauri 2 supports all four natively; the frontend is dependency-light vanilla
web, so the codebase carries over. Sequencing by effort:

1. **Windows** (days): WebView2/Chromium (more standards-compliant than
   WKWebView; polyfills already guarded). Needs Windows titlebar layout
   (traffic-light overlay is macOS-only), MSI/NSIS installer, signing cert.
2. **Android**: `tauri android init`; real work is mobile UX — tab switcher
   sheet, sidebar drawer, pinch/touch gestures, share-sheet open-with,
   document-picker storage. Play Store: $25 one-time.
3. **iOS**: mobile UI carries over; Apple Developer Program $99/yr, stricter
   review.
4. **Plumbing**: GitHub Actions CI matrix (tauri-action, all targets),
   auto-updater, crash reporting, branding (name, icon, landing page).

**Monetization framing:** free core viewer everywhere + one-time Pro unlock
(AI features, mind maps, pro export). Subscriptions fight the local-first
identity.

---

## Deliberately not building

- **Cloud sync / accounts** — local-first is the feature.
- **Plugin system** — premature until the reading core plateaus.
- ~~Editing~~ — *reversed 2026-07-03 by product decision*: lightweight ⌘E edit
  mode ships in Phase B, but reader-first identity stays (no IDE ambitions).

## Phasing

| Phase | Contents | Rough size |
|---|---|---|
| **A — Serious reader** ✅ *shipped 2026-07-03 (v0.9)* | ⌘F, PDF selection + zoom, position memory, relative links, Mermaid/KaTeX, app icon ("Sutra" branding), native menus, shortcuts sheet | done |
| **B — Create & convert** ◐ *core shipped 2026-07-03* | ⌘E edit mode ✅ · Export MD/HTML/CSV + print-to-PDF ✅ · PDF→MD reading mode ✅ · remaining: MD→DOCX (R15), pandoc sidecar (R17) | done except R15/R17 |
| **C — Visualize** ✅ *shipped 2026-07-03* | Mind map view (⌘M, markmap) for every format ✅ · exports SVG / Mermaid mindmap / MD outline ✅ · folder/wiki mode (⌘⇧O) ✅ · knowledge graph of [[wikilinks]] + relative links (⌘G, d3-force) ✅ | done |
| **D — AI companion** ✅ *shipped 2026-07-03* | Provider-agnostic AI — **any** model (Anthropic, OpenAI, Google, OpenRouter, Groq, DeepSeek, Mistral, Ollama, LM Studio, custom) via preset dropdown + editable base URL / model / key ✅ · calls routed through a Rust proxy (bypasses CORS + macOS ATS so local http endpoints work) ✅ · Summarize ✅ · Chat ✅ · Translate → new tab ✅ · AI concept map ✅ · schema-with-graceful-fallback for JSON ✅ | done |
| **E — Productize** ◐ *in progress 2026-07-03* | Cross-platform code (open_externally mac/win/linux, temp-dir diag, platform-split window config, mac-gated titlebar, `#[cfg(desktop)]` menu) ✅ · GitHub Actions release matrix ✅ · `docs/BUILDING.md` ✅ · **Responsive mobile UI** (≤720px: drawer sidebar, ⋯ overflow menu, full-screen AI sheet, 40px touch targets, PDF pinch-zoom, mobile-aware empty state + onboarding) ✅ · **Android APK built & verified running on Android 14 emulator** (toolchain: JDK17 + SDK34 + NDK 27.2; `~/Desktop/Sutra-debug.apk`) ✅ · remaining: run Windows build via CI, signing/notarization, auto-updater, Android share-sheet file intake + Play release, iOS (needs Xcode), Pro packaging | in progress |
| Continuous | One PPTX fidelity rung + one perf item per phase; library features (search-all, split view, annotations, OCR) slot in where they unblock a phase | — |

Ordering logic: B before C (export/edit infra is what mind-map export reuses);
E last because each prior phase multiplies what ships on five platforms — but
the Windows build is cheap enough to pull forward anytime as a proof point.

**Recommendation:** Phase A next, then B.
