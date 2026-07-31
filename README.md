# Vedrix

*(formerly Sutra / Markdown Viewer)*

One quiet home for everything you read, annotate, and write — **Markdown, PDF, Word, PowerPoint, Excel, and plain text** — in a fast, offline, native app. Double-click any supported file in Finder and it opens rendered and readable, with a table-of-contents sidebar, automatic dark mode, and live reload when the file changes on disk.

Built with [Tauri 2](https://tauri.app) (native WebView shell, ~10 MB app) around a dependency-light web core: `markdown-it` + `highlight.js` + `DOMPurify` + GitHub markdown CSS, with PDF.js, mammoth, SheetJS, Turndown, markmap, KaTeX, Mermaid and Excalidraw all vendored locally in [src/vendor](src/vendor) so the app works fully offline. Runs on macOS, Windows and Linux desktops, and on Android.

## Features

**Read**
- **GitHub Flavored Markdown** — tables, task lists, strikethrough, autolinks, typographer quotes, KaTeX math and Mermaid diagrams
- **Syntax highlighting** for fenced code blocks (highlight.js)
- **More formats**: PDF (PDF.js 6 with WASM image decoders, lazy page rendering, outline sidebar), PowerPoint `.pptx` (positioned text + images, slide titles in the sidebar), Word `.docx` (mammoth.js), Excel/CSV (SheetJS), plain text/JSON/logs; legacy `.doc`/`.ppt` get an "Open in default app" fallback
- **Chrome-style tabs** — multiple files at once, ⌘W to close, session restored on relaunch
- **Table of contents** with scroll-sync highlighting, plus a **mind-map view (⌘M)** — any document's topic tree as an interactive markmap

**Write & annotate**
- **Rich editor** with a right-hand inspector (Style · Format · Paragraph · Insert · Text) that swaps to a compact toolbar on narrow screens; underline, line-spacing, block types, lists, tables, math and diagram blocks
- **Edit as Markdown** — convert an open PDF, Word or HTML document into an editable Markdown copy, saved through a Save-As dialog
- **Highlights & margin notes** anchored by character offset, listed in a Notes sidebar and stored alongside the file
- **Source/rich toggle** for md/text, debounced auto-save

**AI, canvas & present** *(AI is bring-your-own-key: Claude, OpenAI, Gemini, or local Ollama)*
- **Vedrix AI** — summarize, chat with, and translate the open document; rewrite selected text (grammar, tone, length)
- **AI → Canvas** — turn a document into an editable Excalidraw board; freeform canvas as a first-class document kind with cross-linked doc cards
- **Present as slides (⌘⇧P)** — render a Markdown document as a themed 16:9 deck

**Organize & export**
- **Vault-wide search** — a native folder search surfaced in the command palette (⌘K), with snippets that jump to the match
- **Export** — Markdown (from any format), themed standalone HTML, CSV, and print-to-PDF with typography, layout, margin and header/footer controls
- **Themes** — System, GitHub Light/Dark, Dracula, Nord, Monokai, One Dark, Solarized Light/Dark, Sepia
- **Settings (⌘,)** — content width, font family, font size, line spacing, profile name, session restore
- **Live reload**, relative-image resolution, and sanitized rendering (raw HTML through DOMPurify, scripts stripped)

## Building

Requires Node and Rust (`brew install rustup && rustup-init -y`).

```bash
npm install
PATH="/opt/homebrew/opt/rustup/bin:$PATH" npx tauri build --bundles app
```

Artifacts land in `src-tauri/target/release/bundle/`:
- `macos/Vedrix.app` — drag into `/Applications`
- `dmg/Vedrix_0.9.1_aarch64.dmg` — installer image (run `npx tauri build` without `--bundles app` for the DMG)

First launch of the unsigned app: right-click → Open (Gatekeeper). To make it the default app for `.md` files: right-click any `.md` file → Get Info → Open with: Vedrix → Change All…

Cross-platform notes — Windows/Linux installers and Android (`.apk`/`.aab`) — are in [docs/BUILDING.md](docs/BUILDING.md). Pushing a `v*` tag builds signed installers for every desktop platform via [.github/workflows/release.yml](.github/workflows/release.yml).

## Development

The web core runs standalone in a browser too:

```bash
python3 -m http.server 8721 --directory src
# open http://localhost:8721/index.html?demo
```

`?demo` loads [src/samples/demo.md](src/samples/demo.md), which exercises every rendering feature. In browser mode, files open via the File System Access API (Chrome) with the same live-reload behavior; in the Tauri app, file access goes through Rust commands in [src-tauri/src/lib.rs](src-tauri/src/lib.rs).

## Architecture notes

- **Frontend** — [src/index.html](src/index.html) (markup), [src/app.js](src/app.js) (~5.6k lines: rendering, tabs, editor, AI, canvas, search, annotations), [src/app.css](src/app.css) + [src/themes.css](src/themes.css). Detects Tauri via `window.__TAURI__` and falls back to browser APIs otherwise. Third-party libraries are prebuilt and loaded from [src/vendor](src/vendor) — no bundler.
- **Backend** — [src-tauri/src/lib.rs](src-tauri/src/lib.rs) exposes commands for file I/O (`read_md_file`, `stat_md_file`, `read_file_bytes`, `write_file`, `write_bytes`), the library sidecar (`read_library`, `write_library`), folder listing/search (`list_dir_tree`, `search_folder`), and export/print (`save_export`, `print_page`). macOS `RunEvent::Opened` handling bridges Finder-initiated opens (Apple events, not argv) via a pending-file slot.
- File association is declared in `tauri.conf.json` under `bundle.fileAssociations`. The bundle identifier stays `com.adithya.sutra` so existing library/settings data survives the rename.

## Status

`v0.9.1` — first release under the Vedrix name and logo. See the [releases page](https://github.com/Adithyahavaldar/Vedrix/releases) for installers.
