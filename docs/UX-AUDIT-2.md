# UI/UX audit — post-Notion-features pass

**Date:** 2026-08-13 · **Scope:** the whole app after N1–N8 · **Method:** measured, not eyeballed

The app grew seven feature phases in one run (properties, databases, blocks,
relations/formulas, history/comments, publish, workspace AI). Each phase added
chrome. This audit measures what that accumulation did to consistency, layout
and accessibility — and every finding below is now fixed.

---

## Method

Eyeballing misses duplication. The last audit did, and a duplicated control was
caught by the user rather than by me. So this one starts with a **complete
control inventory**: enumerate every interactive element in every zone, then
diff the zones against each other.

1. **Control inventory** — enumerate `button, select, input, textarea` per zone, by accessible name.
2. **Cross-zone diff** — the same name appearing in two zones is either intentional (contextual) or a defect.
3. **Token census** — count every distinct `border-radius`, `font-size`, control height in the CSS.
4. **Measured accessibility** — compute WCAG contrast ratios per theme; measure hit targets in the live DOM.
5. **Live layout probes** — measure real boxes (overflow, wrapping, gaps) in the running app rather than reading CSS.

### What the inventory found

| Zone | Controls |
| --- | --- |
| Topbar | 9 |
| Nav rail | 7 |
| Sidebar | 7 |
| Edit toolbar (narrow screens) | 18 |
| Editor inspector (wide screens) | 28 |
| Selection bubble / menu | 7 / 8 |
| Highlight popover | 8 |
| AI panel | 9 |

---

## Findings & fixes

### A — Accessibility

**A1 · Muted text failed WCAG AA in 4 of 9 themes.** `--text-muted` carries 139
rules — property labels, metadata, captions, hints. Measured against each
theme's own background:

| Theme | Was | Now |
| --- | --- | --- |
| Solarized Light | **2.48:1** ❌ | 4.79:1 ✅ |
| Solarized Dark | **3.38:1** ❌ | 4.71:1 ✅ |
| One Dark | **3.73:1** ❌ | 4.77:1 ✅ |
| Sepia | **3.76:1** ❌ | 4.58:1 ✅ |

AA requires 4.5:1 for text under 18.66px. Replacements were computed by nudging
each colour toward its background's opposite while preserving hue, so the themes
still look like themselves.

**A2 · Sidebar tabs were 30px tall** — below the 32px minimum held elsewhere and
well under a comfortable touch target. Now 34px.

### B — Duplication & consistency

**B1 · The nav rail had two controls both titled "Home".** The brand mark and
the house icon were separate buttons with identical accessible names — a screen
reader would announce "Home, Home". The mark is now *"Vedrix — home"*, so the
two are distinguishable, and the house icon remains the single nav target.
*This is the exact defect class that slipped through the previous audit.*

**B2 · Capability parity was broken between the two editor chromes.** The app
shows an inspector on wide screens and a compact toolbar on narrow ones — they
must be equivalent. **Underline existed only in the inspector**, so it silently
disappeared on mobile and in narrow windows. Added to the toolbar. Parity is now
enforced by test: the only remaining toolbar-only control is `Aa` (document
appearance), which is intentional — the inspector has its own Text section.

**B3 · One command, two names.** "Insert table"/"Insert image" in the toolbar vs
"Table"/"Image" in the inspector. Unified.

### C — Layout

**C1 · The AI chip row wrapped to two lines.** Six chips (Summarize, Translate,
Concept map, Canvas board, Ask vault, Fill properties) wrapped at panel width,
taking **72px** of vertical space above the composer. Now a single quiet
scrolling row: **38px**, with scroll-snap and no visible scrollbar.

**C2 · Property keys were stranded from their values.** `.prop-key` was a fixed
`168px` column, so a short label like "Status" sat ~120px away from its value,
reading as two unrelated things. The key now hugs its text (`min 96px`,
`max 168px`) so short properties stay legible as pairs and long ones still align.

**C3 · A document with no headings showed an unexplained blank panel.** The
outline builder returns early below two headings, leaving an empty sidebar where
content is expected. Now says *"No outline — this document has no headings yet."*

### D — Design-system drift

Seven phases of new chrome introduced a lot of near-duplicate values. Census:

| | Before | After |
| --- | --- | --- |
| `border-radius` values | **18** | **8** |
| `font-size` values | 21 | 17 (remainder are display/heading sizes) |

Radii were mapped onto a scale (4 / 6 / 8 / 10 / 12 / 16 / 20 / pill) by nearest
neighbour, and half-pixel font strays (11.5, 12.5, 13.5, 14.5) collapsed onto
integers — 190 and 246 declarations normalised respectively. The change is
deliberately near-invisible: the goal was to remove *arbitrary* variation, not to
restyle anything the design already got right.

### E — Information architecture

**E1 · Themes were crowding out commands.** The palette had 27 entries, **10 of
them themes** — 37% of the default list was one setting. Themes are now
`onlyWhenSearching`: the default list shows real commands, while ⌘K → "dracula"
still jumps straight there. Default rows dropped from 16 to 6 in the same state.

---

## What was deliberately not changed

- **Toolbar ↔ inspector duplication** is by design: they are mutually exclusive
  responsive chromes, not two ways to do the same thing at once.
- **Selection bubble repeating bold/italic/link** is contextual proximity — the
  point is to reach them without travelling to the toolbar.
- **Large display type** (26–40px headings) stayed varied; that variation is a
  type scale, not drift.

## Verified

Every fix was confirmed in the running app, not just in source: rail titles,
chrome parity by set-diff, chip row height, property gap, outline empty state,
tab height, and palette default-vs-search behaviour.
