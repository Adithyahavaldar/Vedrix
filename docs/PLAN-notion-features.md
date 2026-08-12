# Ideation — Vedrix as a local-first Notion

**Status:** ideation / not committed to a release · **Date:** 2026-08-01 · **Owner:** Adithya

---

## 1. The one-line thesis

> **Notion, if your workspace were a folder of files you own.**

Notion won by making one idea feel effortless: *everything is a block, and any collection of blocks can become a database.* Its cost is that your work lives in someone else's database, reachable only through their app, only online, only while you keep paying.

Vedrix already has the opposite property — **plain files on disk, opened instantly, offline, no account.** The opportunity is not to clone Notion's feature list; it's to deliver Notion's *feel* on top of files that outlive the app.

**The bet:** most people don't need real-time multiplayer. They need structure, views, linking, and a fast editor. That subset is ~85% of daily Notion use, and *all of it* can be done markdown-first.

### The non-negotiable constraint

Every feature below is judged against one rule:

> **If Vedrix disappeared tomorrow, the user's work must still open in any text editor, and still make sense.**

This rule is what makes the product different. It also *kills* certain features outright — those are named honestly in §7 rather than quietly dropped.

---

## 2. Where Vedrix already stands

Far more of the foundation exists than a blank-slate plan would assume. This ideation builds on shipped code, not greenfield.

| Notion pillar | Vedrix already has | Gap to close |
| --- | --- | --- |
| Block editor | Rich editor, slash menu, callouts (`> [!note]`), tables, math, Mermaid, inspector | Toggles, columns, transclusion, templates |
| Wiki / knowledge | Vault-wide search, graph view, mind map, projects & tags, folder tree | `[[wikilinks]]`, backlinks, page tree as primary nav |
| Databases | Projects, tags, library sidecar | Folder-as-database, views, filters, relations, formulas |
| Collaboration | Highlights & margin notes (sidecar), export, static-site publish (this hub) | Comments on blocks, version history, share links |
| AI | Chat, summarize, translate, rewrite, AI→Canvas | AI over the *workspace*, not just the open doc |
| Canvas | Excalidraw, doc cards, cross-linking | — (already ahead of Notion here) |

**Read:** the editor and knowledge layers are ~70% there. **Databases are the real build.** Collaboration is the honest-limits conversation.

---

## 3. The architecture: files as the source of truth

Four primitives. Everything else composes from them.

### 3.1 Page = a Markdown file

```markdown
---
title: Q3 launch plan
status: In progress
owner: [[people/adithya]]
due: 2026-09-30
tags: [launch, marketing]
---

# Q3 launch plan
...
```

Frontmatter *is* the property system. No hidden database — open it in any editor and the properties are readable prose. This is the single highest-leverage decision in the document: it makes properties, databases, filters, and rollups all fall out of a format users already own.

### 3.2 Database = a folder + a schema file

```
Projects/                      ← the database
├── _vedrix.db.yaml            ← schema + saved views
├── q3-launch.md               ← a row (a page)
├── website-redesign.md        ← a row
└── hiring.md                  ← a row
```

```yaml
# _vedrix.db.yaml
name: Projects
properties:
  status:  { type: select, options: [Backlog, In progress, Done], color: true }
  owner:   { type: relation, to: People }
  due:     { type: date }
  effort:  { type: number, format: days }
  done:    { type: formula, expr: 'status == "Done"' }
views:
  - { name: Board,    type: board,    group: status, sort: [due asc] }
  - { name: This week,type: table,    filter: 'due <= today + 7d and status != "Done"' }
  - { name: Calendar, type: calendar, date: due }
```

A row is a page. A page is a file. A view is a saved query — **views never own data**, so deleting the schema file loses your *views*, never your *content*.

### 3.3 Link = `[[wikilink]]`

One syntax for page links, relations, transclusion, and block references:

| Form | Meaning |
| --- | --- |
| `[[Q3 launch]]` | link to a page |
| `[[people/adithya]]` | a relation value in frontmatter |
| `[[Q3 launch#Risks]]` | link to a section |
| `[[Q3 launch#^b7f2]]` | link to a specific block |
| `![[Q3 launch#Risks]]` | **transclude** (Notion's synced block) |

Backlinks are just the reverse index of this — computed, never authored.

### 3.4 Index = a disposable cache

A local SQLite index makes queries, backlinks, and search instant across thousands of files.

> **It is a cache, not a second source of truth.** Delete it and Vedrix rebuilds it from the files. Nothing lives only in the index. This is what keeps "markdown-first" honest as the workspace scales — the alternative (re-parsing every file per keystroke) collapses at ~500 pages.

---

## 4. The four pillars

### Pillar A — Blocks & page building

Notion's editor feels good because of *structure you can manipulate*, not because of exotic block types.

| Feature | Markdown representation | Notes |
| --- | --- | --- |
| Slash menu | — | **Ships today** |
| Callouts | `> [!note]` | **Ships today** (GitHub-compatible) |
| Toggle / collapsible | `<details><summary>` | Valid MD; renders everywhere |
| Columns | `::: columns` fenced directive | Degrades to stacked content |
| Block handles (drag, ⋮⋮) | — | Partly ships (drag-reorder exists) |
| Block IDs | `^b7f2` trailing anchor | Obsidian-compatible |
| Synced blocks | `![[page#^id]]` transclusion | Renders live; source is one file |
| Templates | `.md` files in `_templates/` | A template *is* a page |
| Database inline in a page | ` ```vedrix-view ` fenced block | Embeds a saved view |

**Design stance:** every Notion-specific block must degrade to something a human can read in a plain text editor. `<details>` and fenced directives pass; a proprietary JSON blob does not.

### Pillar B — Databases & views

The centerpiece build. Five view types, one query engine.

- **Table** — the spreadsheet grid; inline-editable cells writing back to frontmatter
- **Board** — kanban grouped by any select property; drag = rewrite one frontmatter field
- **Calendar** — grouped by a date property
- **Gallery** — cards with a cover image (first image in the page, or a `cover:` key)
- **List** — the minimal view; a filtered index

**Property types:** text · number · select · multi-select · date · checkbox · URL · email · person · relation · rollup · formula · created/edited time.

**The interaction that must feel perfect:** drag a card between board columns → the `status:` line in that file changes → the file is saved → the view re-renders. If that round-trip is instant and lossless, the whole product is credible. If it stutters or mangles frontmatter, nothing else matters.

**Relations & rollups** — a relation is a `[[wikilink]]` in frontmatter; a rollup walks the relation and aggregates (`sum`, `count`, `latest`). Both computed from files at query time.

**Formulas** — a small, *sandboxed* expression language (no arbitrary JS: it would execute untrusted content from files). Supports arithmetic, comparisons, dates, and a stdlib of ~30 functions. Deliberately closer to Notion 1.0 formulas than to a spreadsheet.

### Pillar C — Wiki & knowledge

Where Vedrix can *beat* Notion, because a filesystem is already a tree.

- **Page tree** — the folder tree becomes primary navigation; nesting is real directories
- **Backlinks pane** — "Linked mentions" + "Unlinked mentions" (text matches on the page title)
- **Graph view** — **ships today**; upgrade to use the real link index
- **Quick find** — **ships today** (vault search); add page-title fuzzy jump (⌘P)
- **Breadcrumbs** — from the file path, free
- **Favorites / pinned** — sidecar
- **Daily notes** — a dated page per day, `Journal/2026-08-01.md`, one shortcut away

### Pillar D — Collaboration & sharing

The pillar where local-first forces real trade-offs. Handled by *tiering* rather than pretending.

**Tier 1 — solo, ships naturally**
- **Comments on blocks** — extend the existing annotations sidecar to anchor to block IDs
- **Version history** — if the folder is a git repo, read history from git; otherwise periodic snapshots in `.vedrix/history/`. Timeline UI, diff view, restore.
- **Publish to web** — export a folder as a static site. *This document is the proof it works.*

**Tier 2 — async multi-user, via the user's own sync**
- Files sync through Dropbox/iCloud/git — Vedrix stays out of it
- Comments and presence are per-user sidecar files, merged on read (no write conflicts)
- Conflict UI when two versions of a file diverge

**Tier 3 — real-time multiplayer — deliberately deferred (see §7)**

---

## 5. Phasing

Each phase ships something usable alone. No phase depends on a later one.

| Phase | Theme | Headline capability | Rough size |
| --- | --- | --- | --- |
| **N1** | **Pages & properties** | Frontmatter property editor, page tree nav, `[[wikilinks]]` + backlinks, ⌘P quick-jump | M |
| **N2** | **The index** | SQLite index + file watcher; instant search/backlinks at 10k pages | M |
| **N3** | **Databases v1** | Folder-as-database, schema file, **table + board views**, filters/sorts/groups | L |
| **N4** | **Blocks** | Toggles, columns, block IDs, transclusion, templates, inline database views | M |
| **N5** | **Databases v2** | Relations, rollups, formulas, calendar + gallery views | L |
| **N6** | **History & comments** | Git/snapshot timeline, restore, block comments | M |
| **N7** | **Publish** | Folder → static site, themes, one-command deploy | S |
| **N8** | **Workspace AI** | Ask across the whole vault; AI fills properties; AI builds views from a sentence | M |

**Suggested first cut:** **N1 → N3.** Properties, links, and a working board view is the smallest set that makes someone say *"this is my Notion now."* N2 slots in when the vault gets big enough to feel slow — which is a good problem.

---

## 6. What makes this *better* than Notion (the reasons to switch)

Parity alone never moves anyone. These are the wedges:

1. **Instant.** No spinner, no page-load. Local files open in milliseconds — Notion's most common complaint.
2. **Offline, always.** On a plane, in a basement, on bad hotel wifi.
3. **Your files, forever.** No export ritual, no lock-in. It's already a folder.
4. **One app for docs *and* PDFs, Word, slides, sheets.** Notion can't open your PDFs and annotate them; Vedrix already does.
5. **A real canvas.** Excalidraw beats Notion's non-existent whiteboard.
6. **AI over a vault you own**, with your own key — not a metered add-on.
7. **Git-native.** Real version history, branches, and diffs for people who want it.

---

## 7. Honest limits (what we are *not* building, and why)

Naming these up front is what keeps the plan trustworthy.

| Not building | Why | What we do instead |
| --- | --- | --- |
| **Real-time multiplayer cursors** | Needs always-on servers + CRDTs; kills the local-first, no-account premise | Async collaboration via the user's own sync; revisit as an *optional* opt-in relay |
| **Per-cell rich text in databases** | Frontmatter is structured data; rich text in a YAML cell isn't representable in plain text | Rich content lives in the page body, where it belongs |
| **Notion's permission system** | Requires accounts + a server to enforce; file permissions are the OS's job | OS/folder permissions; per-share-link controls when publishing |
| **Arbitrary JS formulas** | Executing expressions from files is a code-execution vector | Sandboxed expression language, ~30 functions |
| **100% Notion import fidelity** | Notion exports lose block IDs and database relations | Best-effort importer, explicit report of what didn't survive |
| **Web app / mobile parity on day one** | Desktop + Android is the current surface | Publish-to-web covers read-only sharing |

---

## 8. The risks worth watching

- **Frontmatter round-trip fidelity.** Editing a property must never reorder keys, drop comments, or reformat a user's YAML. *Mitigation:* surgical line-level edits, never full-file re-serialization. **This is the single highest-risk mechanic in the plan** — if it corrupts one file, trust is gone.
- **Index drift.** Files change outside the app. *Mitigation:* filesystem watcher + checksum on open; the index is always rebuildable.
- **Scale.** 10k-page vaults must stay instant. *Mitigation:* N2 exists for exactly this; measure before optimizing.
- **Scope gravity.** "All of Notion" is unbounded. *Mitigation:* the §7 list is a contract, and each phase must ship alone.
- **Two products in one app.** A reader/annotator *and* a workspace. *Mitigation:* the workspace is what you get when you open a *folder*; opening a single file stays exactly as fast and simple as today.

---

## 9. Open questions

1. **Does the folder tree become primary navigation**, or stay secondary to the current tabs-and-recents model?
2. **Obsidian compatibility** — matching its `[[link]]`, `^block-id`, and frontmatter conventions makes vaults portable between both apps. Adopt as a hard compatibility target, or only as inspiration?
3. **How opinionated should the schema file be?** One `_vedrix.db.yaml` per folder is simple; a single workspace-level config is tidier but less portable.
4. **Is the daily-note / journal workflow in scope**, or is that a different product?
5. **What is the Pro line?** If Vedrix is ever paid: sync relay, publish hosting, and AI credits are the natural candidates — all optional, none gating local use.

---

*This is an ideation, not a commitment. It is deliberately larger than the next release. See [ROADMAP](ROADMAP.md) for what is actually scheduled, and [PRD](PRD.md) for the shipped product's requirements.*
