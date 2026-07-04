# Sutra — Features & Functionality (for Design)

_Living document for the design team. Describes what exists today, how it behaves, and where the UX/UI needs design work. Version as of 2026-07-04._

* * *

## 1\. What Sutra is

**A local-first, instant document workspace.** Open Markdown, PDF, Word, PowerPoint, Excel, HTML, or plain text — read it beautifully, edit it like a document, visualize it, and never touch a cloud. One fast window; no accounts; works offline.

**Positioning:** _“Every document your day throws at you — opened in under a second, readable like a book, editable like Notion, and yours alone.”_

**Platforms (one codebase):** macOS ✅, Android ✅, Windows/Linux ✅ (installers). iOS planned. The UI must work identically on desktop (mouse/keyboard, ≥720px) and mobile (touch, ≤720px).

**Tech reality designers should know:** Sutra is a native shell (Tauri) around a web UI. Rendering and editing happen in a webview. There is **no design-system framework** — it’s hand-built CSS with a themeable variable layer (see §12). Documents are stored as **Markdown files on disk** (this constrains what editing can persist — see §7).

* * *

## 2\. The core screen (information architecture)

```
┌────────────────────────────────────────────────────────────┐
│ TOPBAR:  ☰   [tab][tab][tab]  +      ✦ ⟨map⟩ ⟨Aa⟩ ⟨edit⟩  Open  ⏱ ☀ │
├──────────┬─────────────────────────────────────────────────┤
│ SIDEBAR  │                                                  │
│ (Contents│              CONTENT PANE                        │
│  or Files│   (rendered doc / editor / pages / map / graph)  │
│  tabs)   │                                                  │
│          │                                    [AI PANEL →]   │
└──────────┴─────────────────────────────────────────────────┘
```

-   **Topbar** — sidebar toggle, tab strip, new-tab, contextual actions (mind map, format-specific toggle, edit), Open, history, settings/theme.
-   **Sidebar** — two modes via sub-tabs: **Contents** (document outline) and **Files** (folder tree, when a folder is open). Resizable, collapsible; becomes a slide-in **drawer** on mobile.
-   **Content pane** — hosts one of several “panes”: reader, editor, paged viewer, mind map, knowledge graph.
-   **AI panel** — right-side dock (full-screen sheet on mobile).

**Design opportunity:** the topbar is getting crowded as features grow. The contextual buttons (map/format-toggle/edit) appear/disappear per document type. A cleaner, more legible command surface is a priority design task (see §13).

* * *

## 3\. Opening documents & supported formats

**Ways to open:** double-click in Finder/Explorer (file association), drag-and-drop onto the window, ⌘O / Open button, `+` new tab, Android document picker / share sheet (planned), recent-files list.

**Formats and how each renders:**

| Format | Rendering | Interactivity today | Target interactivity |
| --- | --- | --- | --- |
| **Markdown** (.md) | GitHub-style, syntax-highlighted code, tables, task lists, math (KaTeX), diagrams (Mermaid), callouts | Full read + edit | — |
| **PDF** | Page canvases + selectable text layer | Scroll, select/copy, zoom, find, PDF→Markdown “reading mode” | Annotations, form fields |
| **Word** (.docx) | Converted to styled HTML | Read, find, export, mind map | Edit (later) |
| **PowerPoint** (.pptx) | Slides rendered as pages | Scroll through slides | **Presentation mode** (full-screen, arrow-key slideshow) — see §9 |
| **Excel** (.xlsx/.xls/.csv) | Tables per sheet | Read, find | Sheet tabs, sort/filter, big-sheet virtualization |
| **HTML** (.html) | **Two modes:** Interactive (scripts run, full prototypes/dashboards) · Reader (script-stripped, TOC/find) | Interactive = fully live; Reader = read/search | Link-nav policy, per-tab default |
| **Text/JSON/logs** | Monospace, read + edit | Full | Syntax highlighting for code files |

**Design note — “make every format interactive”:** each format has a different ceiling. Markdown/HTML/text are fully interactive. PDF is interactive within reading (select, zoom, find). PPTX’s natural “interactive” form is a **slideshow/presenter mode** (the biggest format-specific design task). Excel’s is **sortable/filterable sheets**. The doc should treat “interactivity” per format, not as one feature.

* * *

## 4\. Tabs & session

-   **Chrome-style tabs** — multiple documents open at once; each remembers scroll position, zoom, edit state.
-   **Draggable to reorder**, close button per tab, dirty-dot when unsaved, live-reload dot when the file is being watched.
-   **Session restore** — reopens your tabs on relaunch (toggle in Settings).
-   Mobile: tab strip is horizontally scrollable; ⌘⌥←/→ or swipe to switch.

**Design opportunity:** at 10+ tabs the strip is cramped. A **tab overview** (grid with previews) and/or **vertical tab list** is worth designing. This also connects to the requested **project grouping** (§10) — tabs could be grouped/ colored.

* * *

## 5\. Reading experience

-   **10 themes** — System, GitHub Light/Dark, Dracula, Nord, Monokai, One Dark, Solarized Light/Dark, Sepia. Each themes the whole app _and_ code syntax colors. Chosen from a swatch grid in Settings.
-   **Typography controls** — content width (Narrow/Normal/Wide/Full), font family (System/Serif/Mono), font size. In Settings; also reachable from the editor “Aa” button.
-   **Table of contents** — auto-built from headings for every format (including extracted PDF/PPTX topics); scroll-synced active highlight; click to jump.
-   **Find (⌘F)** — in-document search with match count, next/prev, highlights; works in Markdown, Office docs, PDF (page text), and Reader-mode HTML.
-   **Zoom** — for PDF/slides (fit-width, %, pinch on mobile).
-   **Auto-hiding scroll indicator** — custom thin thumb that appears only while scrolling (native bars hidden).
-   **Reading position memory** — reopen any file where you left off.

**Design opportunities:** the theme picker, typography panel, and reading controls are functional but visually plain. This is prime surface for design polish. Also: a distraction-free/focus reading mode is unbuilt and desirable.

* * *

## 6\. Multi-format specifics worth designing

-   **PDF reading mode (“Aa”)** — converts a PDF’s text into clean Markdown (Safari Reader-style) in a new tab: headings from font sizes, paragraphs, lists. Good candidate for a nicer toggle affordance and a “before/after” transition.
-   **HTML Interactive/Reader toggle (“⚡/Aa”)** — Interactive runs the page live (dashboards, prototypes) in an isolated frame; Reader strips scripts for reading/search. Needs a clearer, more discoverable mode indicator.
-   **Spreadsheets** — currently stacked tables. Design need: sheet tabs, sticky headers, and eventually sort/filter controls.

* * *

## 7\. Editing (Notion-grade, markdown-first)

Sutra has a full editor reachable with **⌘E**. Two surfaces, toggled by a floating **Text / Source / Done** pill:

-   **Text (WYSIWYG-style)** — the _rendered_ document becomes directly editable. You type into the beautiful view, not raw syntax. This is the default.
-   **Source** — a raw-markdown code editor (CodeMirror) for precise syntax work.
-   **Done** — exits and saves.

**Editing toolbar** (top, in edit mode): `↶ ↷ | Block-type ▾ | B I S </> H(highlight) 🔗 | • 1. ☑ | ─ ⊞ 🖼 ∑ ⤳ | Aa`

-   Undo/redo (custom history stack, depth 200)
-   Block type dropdown: Paragraph, H1–H4, Quote, Code block
-   Marks: bold, italic, strike, inline code, highlight, link (mini popover)
-   Lists: bullet, numbered, to-do checkboxes
-   Insert: divider, table, image (file picker → relative path), math block, mermaid diagram
-   “Aa”: document appearance (font/size/width)

**Notion-style interactions:**

-   **Selection bubble** — select text → floating B/I/S/code/highlight/link.
-   **Slash menu** — type `/` → searchable block palette (17 blocks incl. headings, lists, to-do, table, divider, image, math, diagram, callouts).
-   **Autoformat while typing** — `##` →H2, `-` →bullet, `[]` →to-do, `>` →quote, ` ``` `→code, `1.` →numbered.

**Power editing (E3):**

-   **Table tools** — cursor in a cell shows a bar: add/delete row/column.
-   **Drag-to-reorder blocks** — ⠿ handle on hover; drag any block to reorder.
-   **Callouts** — `/callout` inserts colored note/tip/warning admonition blocks.
-   **Find & replace** — replace / replace-all in the find bar.
-   **Highlight** — `<mark>` text; survives save.

**The storage constraint (important for design):** documents save as **Markdown**. Markdown can express headings, bold/italic/strike, code, links, images, lists, tasks, tables, quotes, dividers, math, mermaid, callouts, highlight. It **cannot** natively express per-character fonts/colors/sizes or alignment. Document-level font/size/width is a _view setting_, not saved into the file. Per-selection color would need opt-in inline HTML. **Design should not promise per-character typography as a core editing feature** unless we consciously move to a richer storage format (a product decision, currently “no”).

**Design opportunities:** the toolbar iconography is placeholder-grade (emoji/ unicode). A proper icon set, a refined selection bubble, a polished slash menu, and mobile editing ergonomics (toolbar above keyboard) are all open.

* * *

## 8\. Visualization

-   **Mind map (⌘M)** — any document’s heading/topic tree rendered as an interactive, collapsible mind map (markmap). Works for MD, PDF, DOCX, PPTX. Export as SVG, Mermaid mindmap, or Markdown outline.
-   **Knowledge graph (⌘G)** — when a folder is open, a force-directed graph of files linked by `[[wikilinks]]` and relative links (Obsidian-style). Drag nodes, click to open.

**Design opportunities:** both are functional D3/markmap renders with minimal styling. Node design, colors (ties to §10 categorization), layout controls, and a legend are open design work.

* * *

## 9\. Folder / library mode

-   **Open a folder (⌘⇧O)** → the sidebar’s **Files** tab shows a file tree.
-   Browse a docs folder like a mini-wiki; relative and `[[wiki]]` links navigate in-app; back/forward (⌘\[ / ⌘\]).
-   Feeds the knowledge graph.

**This is where “project grouping / categorization” lands** (§10). Today the file tree is a plain nested list. The requested color-coding, icons, and grouping are a **major design area**.

* * *

## 10\. ⭐ Requested: Projects, grouping & categorization (to design)

**User goal:** organize documents into projects/groups with **color coding, icons, and more** — so the library isn’t a flat list.

This is greenfield for design. Proposed scope for the design team to shape:

-   **Projects/Collections** — named groups a user creates. Each has:
    -   a **color** (from a palette; ties into themes)
    -   an **icon** (emoji and/or icon set)
    -   optional description
-   **Assignment** — a document/folder belongs to one or more projects. Drag a tab or file into a project; or right-click → Add to project.
-   **Surfaces that show grouping:**
    -   Sidebar: a **Projects** section above/beside Files, colored & icon’d.
    -   Tabs: optional colored underline/group by project.
    -   Empty/home screen: project cards as entry points.
    -   Mind map & graph: node colors inherit project color.
-   **Categorization vs. Projects** — do we also want lightweight **tags/labels** (many-per-doc, filterable) in addition to projects (folder-like)? Design to recommend the model. Likely: **Projects = primary organization (1:1-ish), Tags = cross-cutting labels.**
-   **Filtering/search** — filter the library by project/tag/color.
-   **Persistence** — stored in local app data (not inside the .md files), so it works across formats and never pollutes documents.

**Key design questions:** Where does project management live (dedicated view vs. sidebar section)? How is a “home/dashboard” of projects presented? How do colors coexist with the 10 themes without clashing? Icon system (emoji vs. custom set)? Mobile representation?

**Deliverable for design:** a projects/library IA + visual system, including the home screen, sidebar treatment, color/icon palette, and the create/assign flows.

* * *

## 11\. ⭐ Requested: Import & Export (to design + build)

**Today (built):** Export a document → Markdown, HTML (themed, self-contained), CSV (sheets), PDF (via print). PDF→Markdown reading mode. Opening files = import.

**Requested expansion:**

-   **Export to more formats** — DOCX, PPTX, images (PNG of a rendered doc/mind map), EPUB, plain text, and “copy as rich text.” A **pandoc sidecar** (optional download) can unlock the long tail (LaTeX, ODT, etc.).
-   **Import flows** — beyond open-file: import a folder as a project, import from a URL (fetch a page → Reader/Markdown), paste HTML → Markdown, import from other note apps (Obsidian vault, Notion export .zip).
-   **Batch export** — export a whole project/folder to a chosen format.

**Design needs:** an **Export dialog** (format picker + options: theme, page size, include/exclude TOC) and an **Import entry point** (formats, source: file/ folder/URL/clipboard/other-app). Today export is a flat menu — it needs a real dialog with previews and options. Also a consistent place for both in the IA.

* * *

## 12\. AI companion

-   **AI panel (✦ / ⌘J)** — right-side chat grounded in the open document.
    -   Summarize document, Translate, generate an AI **Concept Map** (feeds the mind-map view).
    -   Chat with the document.
-   **Bring-your-own key** — user provides an API key in Settings; provider-open.
-   Mobile: full-screen sheet.

**Design opportunities:** the panel is functional but plain. Message design, streaming states, action affordances (summarize/translate/concept-map as first-class buttons vs. buried), inline “ask about this selection”, and a non-chat “quick actions” surface are all open.

* * *

## 13\. Mobile UX (built, needs polish)

At ≤720px Sutra switches to a mobile layout:

-   Topbar collapses to `☰ · tabs · + · ✦ · ⋯`; the rest moves into a **⋯ overflow menu**.
-   Sidebar becomes a **slide-in drawer** with backdrop.
-   AI panel becomes a **full-screen sheet**.
-   **Safe-area insets** keep the topbar clear of the status bar / notch.
-   40px touch targets, pinch-to-zoom on PDFs/slides, contenteditable editing with the on-screen keyboard.

**Design opportunities:** the mobile toolbar for editing (should dock above the keyboard), the overflow menu (could be a bottom sheet), tab switching (a tab sheet vs. the cramped strip), and gesture affordances (swipe-back, pull actions).

* * *

## 14\. Settings, history, personalization

-   **Settings** — theme grid, typography, profile name (greets you on the home screen), session-restore toggle, AI key, clear history.
-   **History** — every opened file (with location + time), reopenable; recents on the home screen.
-   **Home/empty screen** — icon, greeting, format hint, recent files. This is a prime **design canvas** — today minimal; could become a project dashboard (§10).

* * *

## 15\. Design system (current constraints)

-   **Theming via CSS variables:** `--bg` (content), `--panel` (bars/chrome), `--border`, `--fg`, `--text-muted`, `--accent`, `--hover`, `--ok`. Every surface uses these; a new theme = one variable block. Designs should be expressed in these tokens so they work across all 10 themes.
-   **Type:** system font stack default; serif and mono options.
-   **Iconography:** currently a mix of inline SVG (topbar) and emoji/unicode (toolbar). **A unified icon set is an explicit design need.**
-   **Components in play:** tabs, buttons (icon + text), segmented controls, swatches, floating popovers/bubbles, menus, modals (Settings/shortcuts), side panels, toolbars, pills, file tree, cards (recents).
-   **Motion:** minimal today (drawer slide, scroll-thumb fade). Opportunity for a considered, restrained motion system.

**Ask to design:** a proper component library / design tokens in Figma that map to these CSS variables, plus the icon set — so engineering can implement 1:1.

* * *

## 16\. Priorities for the design team

1.  **Projects / grouping / categorization** (§10) — biggest net-new IA + visual system. Home/dashboard, sidebar, colors, icons, tags.
2.  **Command surface & topbar** (§2, §4) — declutter, contextual actions, tab grouping/overview.
3.  **Editor polish** (§7) — icon set, selection bubble, slash menu, mobile editing toolbar.
4.  **Import/Export dialog** (§11) — real dialogs with options/preview.
5.  **Per-format interactivity** (§3) — esp. **PPTX presentation mode**, Excel sheet UX.
6.  **Home screen** (§14) — from minimal to a real entry point / dashboard.
7.  **Component library + icon set + tokens** (§15) — the foundation that makes all of the above implementable consistently.

## 17\. Open product questions (design + product to resolve)

-   Projects vs. tags: one model or both? Primary org unit?
-   Does Sutra get a persistent “home/dashboard,” or stay document-first?
-   How far does editing go for non-Markdown formats (edit DOCX? never)?
-   Per-selection color/fonts: keep markdown-pure, or offer a richer opt-in mode?
-   Presentation mode scope for PPTX (and Markdown slides?).
-   Mobile: how much editing is realistic vs. read-first?