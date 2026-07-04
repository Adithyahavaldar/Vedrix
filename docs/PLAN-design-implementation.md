# Plan — Implementing the Design Handoff

*Drafted 2026-07-05. Source: `Modern markdown editor app.zip` →
`design_handoff_sutra/` (README spec + `Sutra Prototype.dc.html` interactive +
`Aurora Editor.dc.html` comps). Status: awaiting go / decisions.*

---

## 1. What the handoff is

A **high-fidelity redesign of the entire app** plus several **net-new
surfaces**, delivered as HTML design references (not production code). The
README is a near-complete spec: exact tokens, fonts, icon paths, spacing,
motion, and per-screen behavior. It explicitly says: **recreate inside Sutra's
existing CSS-variable environment — no new framework, map hexes to theme
variables.** This is a **re-skin + additions of the working app**, not a rewrite.
All current functionality is preserved.

## 2. Two buckets of work

**A. Visual system (re-skin everything that already exists):**
- New fonts: **Hanken Grotesk** (UI/body), **Newsreader** (reading headings /
  serif), **Geist Mono** (code, badges, kbd). Bundle locally for offline.
- Expanded tokens per theme: add `--panel2`, `--accent-fg`, `--code-bg`,
  `--card` to all 10 themes (spec gives Sepia + One Dark; derive the other 8).
- **Icon set**: one stroke family (24×24, `stroke-width 1.6`, `currentColor`,
  no emoji). Replace today's emoji/unicode glyphs. AI sparkle is the only filled
  icon.
- Re-skin: topbar, **context bar** (new: path · mode segmented · read-time ·
  Saved), tabs (format badges, LIVE pill, dirty dot), sidebar (Contents/Files
  sub-tabs, reading-progress bar, "Ask about this doc" card), reader typography,
  editor toolbar, selection bubble, slash menu, AI panel, settings, toasts.
- Format badges (MD/HTML/PDF/DOC/PPT/XLS/TXT rounded squares, mono label).

**B. Net-new features/surfaces:**
1. **Command palette (⌘K)** — action search + theme switch. Self-contained.
2. **Projects & grouping** — color+icon projects, tags; sidebar Projects group;
   new-project modal; tab underlines; persistence in local app-data sidecar
   keyed by file path (never in the .md). *Model resolved by design: Projects =
   primary (folder-like, ~1/doc), Tags = cross-cutting labels.*
3. **Home / Projects dashboard** — 64px nav rail + greeting, project cards,
   "jump back in" recents, AI quick-actions, import rows, activity feed. A new
   *entry point* (app becomes home-or-document, not document-only).
4. **Export dialog** — format list (incl. DOCX/PPTX/PNG/EPUB, pandoc-tagged) +
   options + live preview. Replaces today's flat export menu.
5. **PPTX presentation mode** — full-screen presenter (current+next slide,
   notes, timer, progress dots, ←/→).
6. Reading-progress + scroll-sync polish; quick-action chips; AI streaming
   states with Insert-as-note/Copy.

## 3. Decisions needed before/within build

1. **Collaborator avatars (MK/JD/+3 in the topbar).** Sutra is local-first,
   single-user; there is **no collaboration backend**. Options: (a) omit them
   (most honest), (b) render as a static "Share" affordance stub for visual
   parity. **Recommendation: omit for now**, revisit if real sharing is ever a
   product goal. *Need your call.*
2. **Home dashboard changes the app's entry model.** Today Sutra opens straight
   into a document/empty state. The design adds a Home with a nav rail. Confirm
   we want Home as a first-class screen (recommended — it's where Projects
   live) vs. keeping document-first with Projects only in the sidebar.
3. **Other 8 themes' new tokens** — I'll derive `--panel2/--card/--code-bg/
   --accent-fg` for the 8 themes the spec didn't enumerate, matching its method
   (panel2 ≈ slightly-lifted panel, card ≈ raised bg, code-bg ≈ tinted bg,
   accent-fg = readable-on-accent). Flag any you want to hand-tune.
4. **Fonts bundled locally** (offline requirement) → ~300–500KB of woff2 added
   to `src/vendor/fonts/`. Fine, just noting the size.
5. **Scope is multi-day.** Phased below; each phase ships independently.

## 4. Phased implementation

Ordered so the app *looks* redesigned ASAP, then gains the new surfaces. Each
phase = build → verify in preview → build both platforms → install → push.

### D1 — Visual foundation *(biggest visual ROI; no new data model)*
Fonts + expanded tokens (all 10 themes) + icon set + re-skin every existing
surface (topbar, context bar, tabs, sidebar, reader type, editor toolbar,
bubble, slash, AI panel, settings, toasts, format badges). After D1 the app
*is* the redesign visually, with today's feature set.

### D2 — Command palette (⌘K)
Overlay, fuzzy action list, theme switcher, keyboard nav. Wire to existing
commands (new doc, mode toggle, edit, AI, summarize, mind map, export, themes).

### D3 — Projects & grouping (data + UI)
Local sidecar store (JSON/SQLite keyed by path) for projects+tags; Rust
commands to read/write it; sidebar Projects group; new-project modal
(color/icon); right-click Add-to-project / tag; tab underline; mind-map/graph
node tinting by project color.

### D4 — Home / Projects dashboard
Nav rail + home screen (greeting, project cards, recents, quick-actions, import
rows, activity). Routing between Home and document view. Depends on D3.

### D5 — Export dialog + PPTX presentation mode
Rich export modal (format+options+preview; DOCX/PPTX/PNG/EPUB via libs/pandoc
sidecar where needed); PPTX presenter mode (full-screen slideshow).

**Continuous:** mobile parity for each surface (drawer, bottom nav, sheets,
safe-areas already exist — extend to new surfaces); round-trip + regression
checks; keep all existing shortcuts/behaviors.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Re-skin breaks existing behavior | Re-skin CSS/markup surface-by-surface; verify each in preview before moving on; keep JS logic intact |
| 10 themes × new tokens = drift | Derive tokens programmatically from existing per-theme values; visual-check a light + a dark theme per phase |
| Fonts hurt first-paint / offline | Bundle woff2 locally, `font-display:swap`, subset if needed |
| Home dashboard scope creep | Ship D4 behind the nav rail; Projects (D3) is usable in the sidebar even without Home |
| Collaboration implied but absent | Decision #1 — omit avatars; don't imply features we don't have |
| Icon swap misses a spot | Central `icon()` map (as the prototype does) so every glyph comes from one source |

## 6. Recommendation

Start with **D1 (visual foundation)** — it transforms how the whole app looks and
feels using only re-skin work, no risky new data model, and everything after
sits on it. Then D2 (palette, quick), D3 (projects), D4 (home), D5 (export +
present).

**Open the two decisions in §3 (collaborator avatars; Home as a first-class
screen), then greenlight D1.**
