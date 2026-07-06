# Sutra — UI/UX Audit

**Date:** 2026-07-06 · **Method:** hands-on testing (desktop 1280px + mobile 375px, cold start & loaded states) plus a full code-level antipattern scan of `index.html` / `app.js` / `app.css` / `themes.css`.

Severity: **C**ritical (feature broken/unreachable) · **H**igh (misleading or blocking) · **M**edium (friction/inconsistency) · **L**ow (polish).

---

## Critical — broken or unreachable functionality

### C1. Projects are unusable on Android (hover-only affordances)
`.proj-rowadd`, `.proj-rowmore` (app.css) are `opacity: 0` until `:hover`, and 20×20px. `.pd-x` (remove doc) is the same pattern. Touch devices have no hover — **verified opacity 0 on the mobile viewport**. The only fallbacks are right-click context menus, which don't exist on touch. Net effect: the entire add-file/edit/delete project flow we shipped is invisible on Android.
**Fix:** on `body.mobile`, render these controls always-visible at reduced opacity with ≥40px hit areas (padding, not icon size); or move all row actions into a tap-to-open row menu.

### C2. Translate uses `window.prompt()` (app.js:3610)
Native prompt breaks the design language on desktop and **can be a silent no-op in Android WebView** — Translate would simply do nothing.
**Fix:** small in-app input dialog (reuse the modal pattern), with recent-language chips.

### C3. Destructive actions have zero confirmation
"Delete project" (also deletes all its file assignments) and "Clear history" execute instantly with no confirm and no undo. One mis-tap = silent data loss — worse on mobile where mis-taps are common (and the ⋯ menu items sit next to each other).
**Fix:** design-consistent confirm step for Delete project, and an "Undo" toast for both (keep the data for ~8s before committing).

---

## High — misleading or blocking UX

### H1. Mac-isms shown on Android
- Search chip renders a **⌘K** badge on touch (verified at 375px).
- All tooltips embed ⌘ shortcuts (`title="Toggle sidebar (⌘B)"` etc.).
- AI error says *"add one in Settings (⌘,)"*.
- AI settings note says *"Stored only on this Mac"*.
**Fix:** platform-aware strings — hide `.kbd` hints and ⌘ text under `body.mobile`; "this device" instead of "this Mac".

### H2. AI panel is a dead end without an API key
You can open the panel, type a full question, hit send — and only then learn via a plain-text info line that there's no key. The error is not actionable (no button), and its hint is a Mac shortcut.
**Fix:** when no key is configured, the panel shows a setup card ("Connect an AI provider" → button that opens Settings pre-navigated to the AI section via `showSettingsSection('ai')`). Make error rows carry an action button.

### H3. Context bar collides at mobile widths
At 375px the Read/Edit segment overlaps and clips ("Ed…"), and the meta text wraps awkwardly (verified in screenshot).
**Fix:** mobile layout for `#context-bar` — drop the word-count meta, keep path + Read/Edit + Saved; let the segment shrink gracefully.

### H4. Cold-start (first-run) screen is off-design and passive
The very first screen a new user sees: 📄 emoji, "Sutra", and "press ⌘O" / "Tap ＋ above" — no button, no drop-zone affordance, none of the design language. It's the weakest surface in the app and it's the first impression.
**Fix:** first-run version of the designed Home — brand tile, a real **Open a file** button, "or drop a file anywhere" hint, optional "Open sample document".

### H5. Mobile/desktop mode is frozen at load
`body.mobile` is computed once. Resizing a desktop window across the breakpoint (verified: 800→1280px) leaves the app in the wrong mode — mobile toolbar, drawer sidebar — until reload.
**Fix:** listen on `mobileMQ` `change` and re-run the mode application + `updateSidebar()`.

### H6. Accessibility baseline missing
- 47+ icon-only buttons have `title` but **no `aria-label`** (TalkBack/VoiceOver users get nothing).
- No `:focus-visible` styles — keyboard users can't see where they are.
- Modals (settings, project, export, palette) don't trap focus and don't restore it on close.
**Fix:** one a11y pass: `aria-label` on every icon button, a global `:focus-visible` outline, minimal focus trap + restore in the modal helper.

### H7. Strikethrough silently fails (demo + editor round-trip)
The demo doc's `~strikethrough~` renders as literal tildes (markdown-it needs `~~`). Verified: no `<del>`/`<s>` in the rendered demo.
**Fix:** correct the demo to `~~…~~`; confirm the editor's Strike command emits `~~`; optionally enable single-tilde.

---

## Medium — friction and inconsistency

| # | Finding | Detail | Fix |
|---|---|---|---|
| M1 | Touch targets under 40px | tab close 18×18, project buttons 20×20, findbar buttons 24px, stepper 26px | mobile sizing pass — pad hit areas to ≥40px |
| M2 | Settings save on `change` only | typing an API key then closing the modal (Esc / backdrop) can discard the value before blur fires | switch text inputs to `input` events |
| M3 | Inconsistent menu/dialog behavior | some close on `mousedown`-outside, some on `click`; Enter-key semantics vary across inputs | standardize on one pattern (mousedown-outside + Esc; Enter submits) |
| M4 | Empty states without actions | History: "No files opened yet"; Home "Jump back in" can render empty | add an "Open a file" action to each |
| M5 | Silent failures | PDF page render errors → blank space; missing PDF text layer → Find silently finds nothing; `catch` blocks swallow | inline notice per failed page; one-time toast "text search unavailable for this PDF" |
| M6 | Edit toolbar overflow (mobile) | 749px of tools in a 375px bar; scrolls but no affordance | edge-fade gradient + momentum scroll |
| M7 | Scroll position not restored | recents store a position but reopening a file lands at top | apply saved position on open |
| M8 | localStorage quota unhandled | library/settings writes can throw (esp. Android WebView) and die silently | wrap in try/catch → toast |

## Low — polish

| # | Finding | Fix |
|---|---|---|
| L1 | `--text-muted` contrast is borderline in some themes; labels at 10.5px | contrast check per theme; floor at 11.5px |
| L2 | `⌘O` kbd renders ambiguously (reads as "⌘0" in the mono font) | spell it out or use a font variant |
| L3 | Tabs truncate hard at mobile ("de…") with min-width 96px | tighter min-width + middle-ellipsis |
| L4 | "Search" chip actually opens the command palette | label it "Search & commands" on desktop |

---

## Fix plan

**Phase 1 — Touch & safety (critical path, do first)** ✅ **DONE 2026-07-06**
C1 touch-visible project controls (always-visible, 34px on mobile) · C2 `prompt()` → in-app language dialog with chips · C3 undo-toast for Delete project & Clear history · H1 platform-aware copy (⌘K badge hidden on mobile, "this device") · H2 AI setup card + actionable error buttons deep-linking to Settings→AI · H3 context-bar mobile layout (meta hidden, no collision).

**Phase 2 — First impressions & correctness**
H4 first-run screen · H5 live breakpoint switching · H7 strikethrough · M1 touch-target pass · M2 `input`-event saves · M4 empty-state actions.

**Phase 3 — Quality & a11y**
H6 aria-labels + focus-visible + modal focus management · M5/M8 surface silent failures · M7 scroll restore · M3 interaction consistency · L1–L4 polish.

Each phase is independently shippable (build + install + APK + push).
