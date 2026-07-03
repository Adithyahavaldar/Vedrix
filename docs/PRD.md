# PRD — Markdown Viewer (working title)

**Version:** 1.0 · **Date:** 2026-07-03 · **Owner:** Adithya · **Status:** Draft for review
**Current shipped version:** v0.4 (macOS, unsigned, personal use)

---

## 1. Product summary

A **local-first, instant document reader** that opens Markdown, PDF, Word, PowerPoint, Excel, and plain text in one fast, beautiful, tabbed window — with topic sidebars for every format, reader-grade themes, and (coming) light editing, cross-format export, mind maps, and an AI reading companion. Ships on **macOS, Windows, Android, iOS** from one Tauri 2 codebase.

**Positioning in one line:** *"Every document your day throws at you, opened in under a second, readable like a book — no accounts, no cloud, no subscription."*

**Reference competitors:** Obsidian (heavier, edit-first, md-only), Marked 2 (md-only, macOS-only), Preview/Adobe (PDF-only, no reading experience), NotebookLM (cloud, AI-first, no local files). None combine *multi-format + local-first + reading-first + cross-platform*.

---

## 2. Problem statement

Knowledge workers receive documents in 6+ formats daily, and each format opens in a different heavyweight app with a different UI — Word takes seconds to launch to read a two-page memo, PDFs open in browsers without navigation aids, and Markdown opens as raw text. There is no single lightweight tool that treats *reading* documents as the primary job. The cost: constant context-switching, lost reading positions, no way to see a document's structure at a glance, and documents that are effectively unreadable on the machine they live on.

Evidence (founder-as-user): daily workflow spans md project references (100+ headings), design-tool PDFs, pptx decks, docx proposals, and mixed Devanagari/English documents — previously requiring 5 different apps.

## 3. Goals

**User goals**
1. **Instant reading:** any supported file opens and paints in < 1s (md/text) / < 3s (typical PDF) on a 2020+ machine.
2. **Never lose your place:** sessions, tabs, and reading positions survive restarts, 100% of the time.
3. **Structure at a glance:** ≥ 90% of text-based documents produce a meaningful topic sidebar (not page numbers).
4. **One tool, five platforms:** identical core experience on macOS, Windows, Android, iOS.

**Business goals**
5. **v1.0 public release** (signed macOS + Windows) within 6 weeks of PRD approval.
6. **1,000 downloads in the first 90 days** post-public-launch; **4.5★+ average** store rating.
7. **Pro conversion ≥ 4%** of monthly active users within 6 months of Pro launch (one-time unlock, benchmark: indie utility apps 2–5%).

## 4. Non-goals

- **Full editor / IDE ambitions** — editing ships as a lightweight ⌘E mode for md/text only; we will not build WYSIWYG, plugins-for-editing, or compete with Obsidian on authoring. *(Why: reading-first identity is the differentiator.)*
- **Cloud sync, accounts, collaboration** — local-first is the product. *(Why: trust + zero infra cost + differentiation.)*
- **Editing PDF/DOCX/PPTX content** — view/convert only. *(Why: different product, enormous scope.)*
- **Plugin ecosystem in v1–v2** — revisit after the reading core plateaus. *(Why: premature platform-building.)*
- **Linux as a launch target** — Tauri supports it; we defer QA/packaging until demand shows. *(Why: focus.)*

## 5. Personas & user stories

**P1 — "The Builder" (primary; founder archetype):** developer/founder juggling specs, decks, and PDFs across projects.
- As a builder, I want every project doc to open in the same tabbed window so that reading a spec doesn't mean launching three apps.
- As a builder, I want ⌘F search inside any document (including PDFs) so that I can find "hash chain" without re-reading 20 pages.
- As a builder, I want to edit a typo in a markdown doc with ⌘E so that small fixes don't require opening an editor.
- As a builder, I want any document as a mind map so that I can grasp/present its structure in seconds.

**P2 — "The Researcher/Student":** reads long PDFs and scanned papers, takes notes elsewhere.
- As a researcher, I want PDF reading mode (PDF→MD) so that a dense two-column paper becomes a clean readable page.
- As a researcher, I want the topic sidebar on scanned/complex PDFs so that navigation doesn't depend on the author's bookmarks.
- As a researcher, I want my reading position remembered per file so that a 300-page document resumes where I left it.

**P3 — "The Operator" (office/admin):** receives docx/xlsx/pptx daily, reads on desktop and phone.
- As an operator, I want attachments from my phone's share sheet to open in the app so that I can read a deck on the go.
- As an operator, I want to export a Word file to PDF/MD so that I can archive or forward it in the format the recipient needs.

**Edge/error stories**
- As any user, when a file's format is unsupported or corrupt, I want a clear panel with an "Open in default app" escape hatch (never a blank screen).
- As any user, when a PDF is a pure image scan, I want an honest "no text layer" indication (and OCR when available) instead of a fake outline.

## 6. Requirements

### Release v1.0 — "Public desktop" (P0 = cannot ship without)

| # | Requirement | Priority | Acceptance criteria (abbrev.) |
|---|---|---|---|
| R1 | ⌘F in-document search (md/html-kinds + PDF text) | P0 | Match count, highlight, Enter/⇧Enter cycling; PDF matches jump to page |
| R2 | PDF text selection layer + zoom (fit-width/page/%) | P0 | Text selectable/copyable on all text PDFs; zoom persists per tab |
| R3 | Reading-position memory per file | P0 | Reopen within ±1 viewport of last position, across app restarts |
| R4 | Relative `.md` links open in-app; ⌘[/] back-forward | P0 | Links to local md/files open as tabs; history navigable |
| R5 | Native menu bar + shortcuts; real app icon + name | P0 | All features reachable via menus; branded icon in Dock/Finder |
| R6 | Windows build (WebView2), installer, titlebar layout | P0 | Feature parity checklist passes on Win 10/11; MSI/NSIS installer |
| R7 | Code signing + notarization (macOS), signing (Win) | P0 | No Gatekeeper/SmartScreen scare screens |
| R8 | Auto-updater + crash-safe session | P0 | In-app update prompt; forced-quit never loses tabs |
| R9 | Mermaid + KaTeX rendering in md | P1 | Diagrams/math render offline; failures degrade to code block |
| R10 | Onboarding: first-run tour + shortcut sheet (⌘/) | P1 | Dismissible, < 5 screens |

### Release v1.5 — "Create, convert, visualize"

| # | Requirement | Priority |
|---|---|---|
| R11 | ⌘E edit mode (CodeMirror source + live preview, autosave, dirty-dot) — md/text only | P0 |
| R12 | Export/Convert menu tier 1: MD→HTML(themed), MD→PDF, DOCX/PPTX/XLSX→MD, XLSX→CSV | P0 |
| R13 | PDF→MD reading mode toggle (headings/paragraphs/lists from text-layer heuristics) | P0 |
| R14 | Mind map view (markmap) from any document's topic tree; export map as SVG/MD outline | P0 |
| R15 | MD→DOCX export | P1 |
| R16 | Map varieties: outline tree, org-chart, Mermaid flowchart export | P1 |
| R17 | Pandoc sidecar (optional download) for full conversion matrix | P2 |

### Release v2.0 — "Mobile + AI + Pro"

| # | Requirement | Priority |
|---|---|---|
| R18 | Android app (tab-switcher sheet, drawer sidebar, share-sheet intake, pinch zoom) | P0 |
| R19 | iOS app (same mobile UI layer) | P0 |
| R20 | Pro unlock: licensing, purchase flow (Paddle/LemonSqueezy desktop; IAP mobile) | P0 |
| R21 | AI companion (Pro): summarize, chat-with-doc, AI concept maps, PDF→MD cleanup — user-provided or bundled API key | P0 |
| R22 | OCR for scanned PDFs (Apple Vision on macOS/iOS; Tesseract wasm elsewhere) | P1 |
| R23 | Folder/wiki mode + cross-file knowledge graph | P1 |
| R24 | Full-text search across library/history | P2 |

## 7. Product architecture

### 7.1 Current (v0.4)

```
┌────────────────────────── macOS app (Tauri 2, ~10 MB) ─────────────────────────┐
│  ┌──────────────────── WebView (WKWebView) ────────────────────┐               │
│  │  index.html + app.css/themes.css + app.js (vanilla, no build)│               │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────────────────────────┐  │  ┌──────────┐ │
│  │  │ Tab/UI  │ │ Settings │ │ Format renderers             │  │  │ Rust core│ │
│  │  │ manager │ │ themes   │ │ md: markdown-it + hljs       │  │  │ commands │ │
│  │  │ history │ │ profile  │ │ pdf: PDF.js 6 (+wasm,fonts)  │◄─┼─►│ read txt │ │
│  │  │ session │ │ (local-  │ │ docx: mammoth → HTML         │  │  │ read bin │ │
│  │  │ TOC     │ │ Storage) │ │ pptx: JSZip + own parser     │  │  │ stat/mtime│ │
│  │  └─────────┘ └──────────┘ │ xlsx/csv: SheetJS            │  │  │ pending  │ │
│  │        DOMPurify sanitizes│ text: pre                    │  │  │ open ext │ │
│  │        all rendered HTML  └──────────────────────────────┘  │  │ diag log │ │
│  └──────────────────────────────────────────────────────────────┘  └──────────┘ │
│  macOS integration: file associations (Info.plist), RunEvent::Opened,           │
│  overlay titlebar, asset protocol (relative images)                             │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Key properties: all libraries vendored (fully offline); one webview, no build step; formats normalized to either **HTML-in-scroller** (md/docx/xlsx/text) or **paged canvases** (pdf/pptx); every format emits a **topic tree** that powers the shared sidebar — and, next, mind maps.

### 7.2 Target (v2.0)

```
                    ┌──────────── Shared web frontend (one codebase) ────────────┐
                    │  UI shell: desktop layout ←→ mobile layout (responsive +   │
                    │  platform flag: tabs strip ↔ tab sheet, sidebar ↔ drawer)  │
                    │  Core services (JS modules):                               │
                    │   • DocumentModel: {kind, source, topicTree, view state}   │
                    │   • Renderer registry (md/pdf/docx/pptx/sheet/text/…)      │
                    │   • ViewModes: read | edit (CM) | reading-mode | mind map  │
                    │   • Convert engine: AST/HTML → md/html/pdf/docx/csv        │
                    │   • Search service (in-doc now, library index later)       │
                    │   • AI service (provider-abstracted; BYO key or Pro proxy) │
                    │   • Licensing/Pro gate                                     │
                    └───────────────┬────────────────────────────────────────────┘
                                    │ Tauri IPC (commands, events, raw bytes)
        ┌───────────────────────────┴───────────────────────────────┐
        │                      Rust core (portable)                 │
        │  fs read/write/stat · watcher · converter sidecar mgmt ·  │
        │  OCR bridge (Vision/tesseract) · license verify ·         │
        │  settings store (JSON file; localStorage → file migration)│
        └───────┬───────────────┬───────────────┬───────────┬───────┘
                │               │               │           │
        ┌───────┴──────┐ ┌──────┴──────┐ ┌──────┴─────┐ ┌───┴────────┐
        │ macOS (WK)   │ │ Windows     │ │ Android    │ │ iOS (WK)   │
        │ .app/.dmg    │ │ (WebView2)  │ │ (WebView)  │ │ .ipa       │
        │ notarized    │ │ MSI + sign  │ │ AAB, Play  │ │ App Store  │
        └──────────────┘ └─────────────┘ └────────────┘ └────────────┘
                CI: GitHub Actions matrix (tauri-action) → sign → release → update feed
```

**Architecture decisions (ADR summary)**
1. **No frontend framework/build step** — vanilla JS has carried 5 formats + theming with zero tooling risk; revisit only if mobile UI complexity demands it (escape hatch: incremental adoption of lit/preact in one module).
2. **Engine differences are handled by polyfill, not forking** — e.g., WKWebView lacked async-iterable ReadableStream (broke PDF.js text extraction); fixed with a guarded polyfill. Same discipline for WebView2/Android quirks.
3. **Everything renders to either HTML or paged canvases + a topic tree** — this "narrow waist" is what makes search, TOC, mind maps, reading mode, and export cheap to add per format.
4. **Settings migrate from localStorage to a JSON file in app-data** (Rust-owned) before mobile — webview storage is too fragile across OS updates and needed for cross-device manual sync.
5. **AI is provider-abstracted** — v1: user's own Anthropic key; Pro option later: proxied key with usage caps (the only server component in the product, kept optional).

## 8. Execution plan

### Workstreams

- **WS-A Reader polish** (R1–R5, R9, R10) — pure frontend + light Rust.
- **WS-B Platform & distribution** (R6–R8, CI, signing, updater, branding) — mostly config/infra.
- **WS-C Create/Convert** (R11–R17) — frontend + write commands + converters.
- **WS-D Visualize** (R14, R16, R23) — markmap/graph rendering on the topic-tree waist.
- **WS-E Mobile** (R18, R19) — responsive UI layer + mobile plugins + store ops.
- **WS-F Monetize + AI** (R20–R22) — licensing, purchase flow, AI service.

### Milestones & timeline (solo founder + AI-assisted dev; calendar weeks)

| Week | Milestone | Contents | Gate to pass |
|---|---|---|---|
| W1–2 | **M1: v1.0-beta desktop** | WS-A complete on macOS; branding (name+icon) decided | Daily-driver test: 1 week of real use, zero data loss |
| W3–4 | **M2: v1.0 public** | WS-B: Windows port, signing both OS, CI, updater, landing page | Clean install on fresh macOS+Win machines; SmartScreen/Gatekeeper silent |
| W5–6 | **M3: v1.5** | WS-C tier-1 + WS-D rung-1 (edit, export, reading mode, mind maps) | Convert/export round-trip QA suite passes |
| W7–9 | **M4: mobile alpha** | WS-E Android first (sideload APK), mobile UI layer; iOS build boots | Read all 6 formats + share-sheet intake on 2 real devices |
| W10–12 | **M5: v2.0** | iOS polish, store submissions, WS-F (Pro + AI v1) | Store approvals; purchase → unlock → restore flow verified |

*Buffer built in: store review cycles (1–7 days each) overlap W10–12. If solo bandwidth is < full-time, stretch each block ×1.5–2; the sequence holds.*

### Definition of done (every milestone)
Feature checklist passes on all target platforms → no P0 bugs open → README/docs updated → tagged release built by CI (never a laptop build).

## 9. Resources

**People (lean plan)**
- 1 × founder-engineer (you) + AI pair (Claude Code) — all workstreams. Realistic at the stated timeline if ~full-time.
- *Optional accelerators:* freelance designer for icon/branding/store assets (~1 week, $500–1.5k); Android/iOS QA via friends+TestFlight/internal track (free).

**Money (year-1 run costs)**
| Item | Cost |
|---|---|
| Apple Developer Program (notarization + App Store) | $99/yr |
| Google Play registration | $25 once |
| Windows code-signing cert (OV via Azure Trusted Signing) | ~$10–120/yr |
| Domain + static landing page (GitHub Pages/Cloudflare) | ~$15/yr |
| Payment provider (Paddle/LemonSqueezy) | % of sales only |
| LLM API for AI features | $0 (BYO key) → usage-based if Pro-proxied |
| CI (GitHub Actions, public repo or free tier) | $0 |
| **Total fixed** | **≈ $150–260/yr** |

**Tooling:** GitHub (repo, Actions, Releases, Pages) · tauri-action CI · Paddle or LemonSqueezy (desktop licensing + payments, handles VAT) · TestFlight + Play internal track · Plausible/none for site analytics.

## 10. Monetization

- **Free (forever):** all reading features, all formats, themes, tabs, search, sessions — the full "best viewer" promise, on every platform. Free is the moat and the funnel.
- **Pro (one-time, ~$25 desktop / ~$15 mobile IAP, own-key AI included):** AI companion (summarize, chat, concept maps, PDF→MD cleanup), advanced export (DOCX, pandoc matrix), mind-map varieties + knowledge graph, OCR. One-time fits local-first trust; price anchors against Marked 2 ($14, md-only) and Obsidian Commercial ($50/yr).
- **Explicitly rejected:** subscriptions for local features; ads; telemetry-funded anything.

## 11. Success metrics

**Leading (first 30–90 days after each release)**
- Crash-free sessions ≥ 99.5% (crash reporter, opt-in).
- Median open-to-paint: md < 300 ms, typical PDF < 3 s (built-in perf marks, local only).
- ≥ 60% of beta users still using at day 14 (TestFlight/Play console).
- Topic-sidebar success rate ≥ 90% on a 100-doc benchmark corpus (internal QA metric).

**Lagging (6 months)**
- 1,000+ downloads across platforms; 4.5★+ store average.
- Pro conversion ≥ 4% of MAU (stretch 7%); refund rate < 3%.
- ≥ 30% of sessions open a non-md format (validates multi-format bet).

**Measurement note:** local-first means no default telemetry. Metrics come from store consoles, opt-in crash reports, and an opt-in anonymous ping (count-only). This is a stated product value, not a gap.

## 12. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Per-engine webview bugs ×4 platforms (the ReadableStream class of problem) | High | Medium | Guarded polyfills; per-platform smoke-test checklist in CI; test on real devices early (M4 gate) |
| Mobile UX is a real redesign, not a port | High | Medium | Dedicated mobile UI layer in W7–9; Android-first to iterate cheaply |
| App Store review friction (BYO API key rules, "reader" app rules) | Medium | Medium | AI as Pro IAP or desktop-only initially; no external purchase links on iOS |
| PPTX/PDF fidelity complaints at public scale | Medium | Medium | Set expectations in-product ("approximation" badge + open-in-default); fidelity ladder as ongoing work |
| Solo-founder bandwidth; timeline slips | High | Low | Milestones are independently shippable; v1.0 alone is a complete product |
| Big-co feature overlap (Apple/Google add reading modes) | Low | Medium | Multi-format + local-first + cross-platform combo remains un-replicated; speed is the defense |
| One-time pricing caps revenue | Medium | Low | Acceptable for indie scale; AI-proxy Pro tier is the optional recurring lever later |

## 13. Open questions

1. **Product name + brand** — "Markdown Viewer" undersells a multi-format reader; blocks store listings, domain, icon. *(Owner: Adithya; blocking M1.)*
2. **AI key model at launch** — BYO-key only (simple, private) vs. bundled proxy (better UX, needs server + cost controls)? *(Owner: Adithya; blocks R21 design, not earlier milestones.)*
3. **Pro pricing final** — $19/$25/$29 desktop; regional pricing for India? *(Owner: Adithya; blocking M5.)*
4. **Opt-in telemetry** — ship a count-only anonymous ping, or zero-telemetry as a marketing stance? *(Blocking landing-page copy, not code.)*
5. **Linux** — free to build via CI; do we publish unsupported builds? *(Non-blocking.)*
6. **Repo visibility** — open-core (viewer OSS, Pro closed) vs. fully closed? Affects trust, contributions, and Pro enforcement. *(Owner: Adithya; decide before public launch.)*

## 14. Appendix

- **Roadmap & ideation:** `docs/ROADMAP.md` (themes 1–10, phasing A–E).
- **Known engineering notes:** WKWebView ReadableStream polyfill (app.js top); brew-rustup PATH (`/opt/homebrew/opt/rustup/bin`); DMG bundling requires non-headless session; assets embed into the binary (keep personal files out of `src/`).
- **Benchmark corpus (to build, W1):** 100 real-world docs across formats/scripts for sidebar-quality and perf regression testing.
