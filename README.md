# Sutra (formerly Markdown Viewer)

A fast, lightweight macOS app for *reading* Markdown files. Double-click any `.md` file in Finder and see it rendered GitHub-style — headings, tables, task lists, syntax-highlighted code — with a table of contents sidebar, automatic dark mode, and live reload when the file changes on disk.

Built with [Tauri](https://tauri.app) (native WebView shell, ~10 MB app) around a dependency-light web core: `markdown-it` + `highlight.js` + `DOMPurify` + GitHub markdown CSS, all vendored locally in [src/vendor](src/vendor) so the app works fully offline.

## Features

- **GitHub Flavored Markdown** — tables, task lists, strikethrough, autolinks, typographer quotes
- **Syntax highlighting** for fenced code blocks (highlight.js)
- **Chrome-style tabs** — multiple files at once, ⌘W to close, session restored on relaunch
- **More formats**: PDF (PDF.js 6 with WASM image decoders, lazy page rendering, and a contents sidebar from the PDF outline or page list), PowerPoint `.pptx` (built-in slide renderer: positioned text + images, slide titles in the sidebar), Word `.docx` (mammoth.js), Excel/CSV (SheetJS), plain text/JSON/logs; legacy `.doc`/`.ppt` get an "Open in default app" fallback
- **Mind map view (⌘M)** — any document's topic tree as an interactive markmap; export as SVG, Mermaid mindmap, or Markdown outline
- **Edit mode (⌘E)** — CodeMirror source + live preview for md/text, debounced auto-save
- **Export** — Markdown (from any format via Turndown/PDF extraction), themed standalone HTML, CSV, print-to-PDF
- **Themes** — System, GitHub Light/Dark, Dracula, Nord, Monokai, One Dark, Solarized Light/Dark, Sepia
- **Settings (⌘,)** — content width, font family (system/serif/mono), font size, profile name, session restore
- **History** of opened files (clock icon), plus recents on the empty screen
- **Table of contents sidebar** with scroll-sync highlighting (toggle with the ☰ button)
- **Auto-hiding overlay scrollbars** — visible only while scrolling
- **Live reload** — edit the file in any editor and the view updates within a second
- **Relative images** resolve against the opened file's directory
- **Sanitized rendering** — raw HTML passes through DOMPurify, scripts are stripped
- Open files via double-click (file association), drag-and-drop, ⌘O, or `Open…`

## Building

Requires Node and Rust (`brew install rustup && rustup-init -y`).

```bash
npm install
PATH="/opt/homebrew/opt/rustup/bin:$PATH" npx tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`:
- `macos/Sutra.app` — drag into `/Applications`
- `dmg/Markdown Viewer_0.1.0_aarch64.dmg` — installer image

First launch of the unsigned app: right-click → Open (Gatekeeper).

To make it the default app for `.md` files: right-click any `.md` file → Get Info → Open with: Markdown Viewer → Change All…

## Development

The web core runs standalone in a browser too:

```bash
python3 -m http.server 8721 --directory src
# open http://localhost:8721/index.html?demo
```

`?demo` loads [src/samples/demo.md](src/samples/demo.md), which exercises every rendering feature. In browser mode, files open via the File System Access API (Chrome) with the same live-reload behavior; in the Tauri app, file access goes through Rust commands in [src-tauri/src/lib.rs](src-tauri/src/lib.rs).

## Architecture notes

- `src/index.html` — the whole frontend: rendering, TOC, drag-drop, live-reload polling. Detects Tauri via `window.__TAURI__` and falls back to browser APIs otherwise.
- `src-tauri/src/lib.rs` — three commands (`read_md_file`, `stat_md_file`, `take_pending_file`) plus macOS `RunEvent::Opened` handling for Finder-initiated opens (Apple events, not argv). A pending-file slot bridges the race between the OS delivering the path and the webview finishing its load.
- File association is declared in `tauri.conf.json` under `bundle.fileAssociations`.

## Roadmap (from the ideation plan)

- v0.2: in-document search, print/PDF export, relative `.md` links opening in-app
- v0.3: folder/wiki mode with a file tree, Mermaid, KaTeX, custom themes
