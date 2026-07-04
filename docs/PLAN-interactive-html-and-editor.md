# Plan — Interactive HTML + Full Editor

*Drafted 2026-07-04. Status: awaiting approval.*

---

# Part 1 — Interactive HTML (prototypes, dashboards, full sites)

## Problem

HTML currently renders in a script-stripped sandbox: perfect for *reading* an
HTML document, useless for a Chart.js dashboard, a website prototype, or
anything interactive — they render blank or dead. The user expectation is
"double-click my prototype → it works."

## Design: two modes per HTML tab

| | **Interactive** (new, default) | **Reader** (current behavior) |
|---|---|---|
| Scripts | ✅ run | ❌ stripped |
| Page CSS | ✅ | ✅ |
| Relative assets (`./app.js`, `./style.css`, images) | ✅ real files load | images only |
| Sutra TOC / ⌘F / export / mind map | ❌ (isolated) | ✅ |
| Isolation | full cross-origin | sandboxed, no scripts |

A toggle on the tab (like the PDF "Aa") switches modes; per-tab choice
remembered. Reader is the fallback when a page fails or you just want to read.

## How Interactive mode works

- **Desktop/Android:** `iframe.src = convertFileSrc(path)` — the file loads as
  a real URL over the asset protocol. Consequences, all good:
  - relative `<script src>`, `<link href>`, images, fonts, even multi-file
    site folders resolve from disk → **full prototypes work**, not just
    single files
  - the asset origin (`asset://` / `http://asset.localhost`) is
    **cross-origin from the app**, so page JS cannot touch Sutra's DOM,
    settings, or Tauri IPC — isolation comes from the browser's own
    origin model, not from us sanitizing anything
- The frame fills the pane and owns its scrolling (dashboards manage their own
  layout); Sutra's scroll-thumb and reader width are disabled for this mode.
- `fetch()`/XHR from the page to external APIs works (dashboards often need
  live data). Local-first purists can stay in Reader mode.
- **Browser dev mode:** `srcdoc` + `sandbox="allow-scripts"` (opaque origin —
  never combined with `allow-same-origin`); relative assets unavailable there.

## Security model (explicit)

- Interactive pages run JS **in an isolated origin**: no access to Sutra's
  window, localStorage, or IPC. Verify during implementation that `__TAURI__`
  is not injected into cross-origin frames (test + assert in a diag).
- `target=_blank` / external links from the frame → open in the system
  browser, never inside Sutra.
- Never `allow-same-origin` + `allow-scripts` together on srcdoc (that combo
  would let the page reach the parent).

## Work items (≈ half a day)

1. `renderHtmlDoc` gains mode branch (`t.htmlMode: 'live' | 'reader'`).
2. Toggle button + per-tab persistence; Reader keeps today's TOC/find path.
3. Frame-fills-pane layout mode (`#scroller` overflow off for live HTML).
4. Link/nav policy: intercept top-level navigations out of the frame.
5. IPC-exposure test on all three platforms (desktop, Android, browser).
6. Samples: `samples/demo-dashboard.html` (Chart.js-style inline JS) to prove it.

---

# Part 2 — Full editor (Notion-grade, phased)

## The core constraint to decide up front

Sutra stores documents as **markdown**. Markdown can express: headings,
bold/italic/strike, inline & block code, links, images, lists, task lists,
tables, quotes, dividers, math, mermaid. Markdown **cannot** express:
per-character fonts/sizes/colors, alignment, columns, callout backgrounds.

**Decision (recommended):** stay markdown-first.
- Everything markdown-expressible gets first-class editing UI.
- *Document-level* appearance (font family, size, width) stays in Settings —
  surfaced compactly in the edit toolbar as an "Aa" popover (this is what
  the "fonts / size" ask maps to without breaking files).
- *Per-selection* color/highlight ships later as **opt-in "rich extras"**
  persisted as inline HTML spans inside the markdown (valid md; renders
  everywhere in Sutra; degrades gracefully in other editors). Toggle in
  Settings, default off.

Alternative considered and rejected: adopting a prebuilt editor (Toast UI /
TipTap). Rejected because: TipTap/ProseMirror requires a bundler (breaks the
no-build architecture), Toast UI imposes its own look (breaks the
"reading and editing look identical" identity) and its md dialect fights our
pipeline (mermaid/KaTeX/typographer). We keep the contenteditable engine we
already shipped and grow a command layer on it.

## Architecture

```
┌──────────────── Edit session ────────────────┐
│ contenteditable #content (rendered view)     │
│   ▲ commands            ▲ history            │
│ CommandLayer          HistoryStack           │
│  toggleMark(bold…)     snapshot(innerHTML +  │
│  setBlock(h1/quote…)    selection bookmark)  │
│  insert(table/task/…)   undo/redo ⌘Z/⇧⌘Z     │
│   ▲            ▲            ▲                │
│ Toolbar   SelectionBubble  SlashMenu ("/")   │
└───────── richToMarkdown() on save ───────────┘
```

- **CommandLayer**: each op is a small DOM transform on the current
  Selection/Range (with `execCommand` used where it's still reliable:
  bold/italic/lists). Every op ends with a *normalize pass* that guarantees
  the DOM stays markdown-convertible.
- **HistoryStack (undo/redo)**: native contenteditable undo breaks the moment
  we mutate DOM programmatically — so we own history: snapshot on every
  command + debounced typing snapshots; selection restored via bookmark
  markers; depth 200. ⌘Z / ⇧⌘Z (and toolbar buttons).
- **Round-trip safety net**: golden-file tests — `samples/roundtrip.md`
  containing every construct; edit-mode enter→exit must preserve it. Run in
  preview on every editor change.

## Phases

### E1 — Toolbar + undo/redo (~1 day) ← the visible leap
Fixed toolbar appears under the topbar in edit mode:

`↶ ↷ │ [Paragraph ▾] │ B I S <> │ 🔗 │ • 1. ☑ │ ❝ ─ │ ⊞ 🖼 ∑ ⤳ │ Aa`

- Undo / redo (HistoryStack)
- Block dropdown: Paragraph, H1–H4, Quote, Code block, Bullet / Numbered /
  To-do list
- Marks: bold, italic, strike, inline code; link add/edit (mini popover)
- Insert: table (3×3), image (file picker → relative path), divider,
  math block, mermaid block
- To-do: checkbox insertion + click-to-toggle (already works) + toolbar entry
- "Aa" popover: document font, size, width (bridges to Settings)
- Mobile: same toolbar, horizontally scrollable, docked above the keyboard
  (visualViewport API)

### E2 — Notion feel (~1 day)
- **Selection bubble**: floating mini-toolbar (B I S code link + block menu)
  on text selection — the Notion signature interaction
- **Slash menu**: typing `/` opens a searchable block palette (Heading 2,
  To-do, Table, Mermaid, Math, Divider…) inserted at the caret
- **Markdown autoformat while typing**: `# ` → H1, `- ` → bullet, `[] ` →
  to-do, ` ``` ` → code block, `> ` → quote (the "it just knows" feel)

### E3 — Power editing (~1–2 days)
- Table editing grips: add/remove row/column, header toggle (hover controls)
- Block drag-handles to reorder paragraphs/blocks (Notion's ⠿)
- Toggle blocks via `<details>` (md-legal, renders collapsed)
- Callouts (styled blockquote convention: `> [!note]` — GitHub-flavored)
- Opt-in rich extras: text color / highlight persisted as inline HTML
- Find & replace in edit mode

### Deliberately out (for now)
Real-time collaboration, comments, per-block databases — different product.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| contenteditable quirks differ per WebView (WK vs Blink vs Android) | command layer avoids exotic APIs; test matrix = mac app + Android emulator + preview |
| Turndown loses an edge case | golden-file round-trip test gate on every editor PR |
| Selection lost across programmatic edits | bookmark-marker technique (insert sentinel spans, restore, remove) |
| Toolbar crowds small screens | priority+overflow design; bubble/slash carry most weight on mobile |

## Suggested execution order

1. **Part 1 (Interactive HTML)** — small, unblocks your prototypes/dashboards
   immediately.
2. **E1 toolbar+undo** — the biggest visible editor jump.
3. **E2 bubble+slash+autoformat** — the "feels like Notion" moment.
4. **E3** — power features, can trail.

Total: ~3–4 working days for the full plan; each step ships independently.
