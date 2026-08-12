'use strict';

/* ============================================================
   Markdown Viewer — app logic
   Runs both in a plain browser (File System Access API) and
   inside the Tauri app (window.__TAURI__ present).
   ============================================================ */

const TAURI = window.__TAURI__ || null;
const $ = (id) => document.getElementById(id);

// WebKit lacks async iteration on ReadableStream, which PDF.js v6 relies on
// inside getTextContent — polyfill it so text extraction works in the app.
if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype.values = function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result;
        } catch (e) { reader.releaseLock(); throw e; }
      },
      async return(value) {
        if (!preventCancel) { const p = reader.cancel(value); reader.releaseLock(); await p; }
        else reader.releaseLock();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  ReadableStream.prototype[Symbol.asyncIterator] = ReadableStream.prototype.values;
}

const contentEl = $('content'), tocEl = $('toc'), scrollerEl = $('scroller'),
      emptyEl = $('empty'), pagesHostEl = $('pages'), unsupportedEl = $('unsupported');

/* ---------- Markdown engine ---------- */

const md = window.markdownit({
  html: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value; }
      catch (_) {}
    }
    return '';
  },
}).use(window.markdownitTaskLists).use(wikiLinkPlugin)
  .use(columnsPlugin).use(blockIdPlugin).use(embedPlugin);

/* ---------- Settings ---------- */

const THEMES = [
  { key: 'system',          label: 'System',          base: 'system', sw: ['#f6f8fa', '#0d1117', '#0969da'] },
  { key: 'github-light',    label: 'GitHub Light',    base: 'light',  sw: ['#ffffff', '#f6f8fa', '#0969da'] },
  { key: 'github-dark',     label: 'GitHub Dark',     base: 'dark',   sw: ['#0d1117', '#010409', '#4493f8'] },
  { key: 'dracula',         label: 'Dracula',         base: 'dark',   sw: ['#282a36', '#bd93f9', '#ff79c6'] },
  { key: 'nord',            label: 'Nord',            base: 'dark',   sw: ['#2e3440', '#88c0d0', '#81a1c1'] },
  { key: 'monokai',         label: 'Monokai',         base: 'dark',   sw: ['#272822', '#a6e22e', '#f92672'] },
  { key: 'one-dark',        label: 'One Dark',        base: 'dark',   sw: ['#282c34', '#61afef', '#c678dd'] },
  { key: 'solarized-light', label: 'Solarized Light', base: 'light',  sw: ['#fdf6e3', '#268bd2', '#859900'] },
  { key: 'solarized-dark',  label: 'Solarized Dark',  base: 'dark',   sw: ['#002b36', '#268bd2', '#2aa198'] },
  { key: 'sepia',           label: 'Sepia',           base: 'light',  sw: ['#f4ecd8', '#a15c22', '#5b4636'] },
];
const WIDTHS = { narrow: '660px', normal: '820px', wide: '1080px', full: '3000px' };

const DEFAULT_SETTINGS = {
  theme: 'system',
  width: 'normal',
  font: 'system',      // system | serif | mono
  fontSize: 16,
  lineSpacing: 1.7,    // reader line-height
  profileName: '',
  restoreSession: true,
};

let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('mv_settings') || '{}')); } catch (_) {}

// Quota-safe localStorage write — a full disk/quota must not fail silently
// (Android WebView quotas especially). Toast at most once a minute.
let _lsWarnedAt = 0;
function lsSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch (_) {
    if (Date.now() - _lsWarnedAt > 60000) { _lsWarnedAt = Date.now(); toast('Storage is full — recent changes may not persist'); }
  }
}

function saveSettings() { lsSet('mv_settings', JSON.stringify(settings)); }

const sysDark = window.matchMedia('(prefers-color-scheme: dark)');

function applySettings() {
  const theme = THEMES.find(t => t.key === settings.theme) || THEMES[0];
  document.documentElement.dataset.theme = theme.key;
  document.documentElement.dataset.font = settings.font;
  const dark = theme.base === 'dark' || (theme.base === 'system' && sysDark.matches);
  $('css-md-light').disabled = dark;
  $('css-md-dark').disabled = !dark;
  $('css-hl-light').disabled = dark;
  $('css-hl-dark').disabled = !dark;
  document.documentElement.style.setProperty('--reader-width', WIDTHS[settings.width] || WIDTHS.normal);
  document.documentElement.style.setProperty('--reader-fs', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--reader-lh', settings.lineSpacing || 1.7);
  renderSettingsUI();
  if (!$('editor-inspector').hidden) syncInspector();
}
sysDark.addEventListener('change', applySettings);

/* ---------- Recents / history ---------- */

let recents = [];
try {
  recents = JSON.parse(localStorage.getItem('mv_recents') || '[]')
    .filter(r => r.path && !r.path.startsWith('content://')); // purge stale Android URIs
} catch (_) {}

function recordRecent(name, path) {
  if (!path) return; // browser-mode files can't be reopened later
  if (path.startsWith('content://')) return; // Android URIs aren't reopenable after restart
  const prev = recents.find(r => r.path === path);
  recents = recents.filter(r => r.path !== path);
  recents.unshift({ name, path, ts: Date.now(), pos: prev ? prev.pos : 0 });
  recents = recents.slice(0, 50);
  lsSet('mv_recents', JSON.stringify(recents));
  renderRecents();
}

// Re-apply a saved scroll position until the content is tall enough to hold it
// (PDF pages and images render progressively, so an immediate set gets clamped).
function restoreScrollWhenReady(tab, pos, tries = 0) {
  if (activeTab() !== tab) return;
  tab.scrollTop = pos;
  scrollerEl.scrollTop = pos;
  if (Math.abs(scrollerEl.scrollTop - pos) > 4 && tries < 8) {
    setTimeout(() => restoreScrollWhenReady(tab, pos, tries + 1), 250);
  }
}

function savedPosition(path) {
  const r = recents.find(r => r.path === path);
  return (r && r.pos) || 0;
}

let posTimer = null;
function rememberPosition() {
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    const t = activeTab();
    if (!t || !t.path) return;
    const r = recents.find(r => r.path === t.path);
    if (r) {
      r.pos = scrollerEl.scrollTop;
      lsSet('mv_recents', JSON.stringify(recents));
    }
  }, 600);
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function recentRow(r) {
  const btn = document.createElement('button');
  btn.className = 'recent-row';
  const dir = r.path.slice(0, r.path.lastIndexOf('/'));
  btn.innerHTML = `<span class="r-name"></span><span class="r-dir"></span><span class="r-time"></span>`;
  btn.querySelector('.r-name').textContent = r.name;
  btn.querySelector('.r-dir').textContent = dir.replace(/^\/Users\/[^/]+/, '~');
  btn.querySelector('.r-time').textContent = timeAgo(r.ts);
  btn.addEventListener('click', () => {
    $('history-panel').hidden = true;
    if (TAURI) openTauriPath(r.path);
  });
  return btn;
}

function renderRecents() {
  const box = $('empty-recents');
  box.innerHTML = '';
  if (TAURI && recents.length) {
    const t = document.createElement('div');
    t.className = 'recents-title toc-title';
    t.textContent = 'Recent files';
    box.appendChild(t);
    recents.slice(0, 6).forEach(r => box.appendChild(recentRow(r)));
  }
  const list = $('history-list');
  list.innerHTML = '';
  if (!recents.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'No files opened yet';
    const b = document.createElement('button');
    b.className = 'none-act'; b.textContent = 'Open a file…';
    b.addEventListener('click', () => { $('history-panel').hidden = true; openViaPicker(); });
    none.appendChild(b);
    list.innerHTML = ''; list.appendChild(none);
  } else {
    recents.forEach(r => list.appendChild(recentRow(r)));
  }
}

/* ---------- Tabs ---------- */

let tabs = [];        // {id, name, path?, handle?, kind, html?, bytes?, pagesEl?, mtime, scrollTop, live}
let activeId = null;
let nextTabId = 1;

function kindOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['md', 'markdown', 'mdown'].includes(ext)) return 'md';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (['xlsx', 'xls', 'csv', 'tsv'].includes(ext)) return 'sheet';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['excalidraw', 'canvas'].includes(ext)) return 'canvas';
  if (['txt', 'log', 'json', 'js', 'ts', 'py', 'sh', 'yaml', 'yml', 'toml', 'xml', 'rs', 'css'].includes(ext)) return 'text';
  return 'unsupported';
}

const TEXT_KINDS = ['md', 'text'];
const BYTE_KINDS = ['pdf', 'docx', 'pptx', 'sheet'];
const PAGED_KINDS = ['pdf', 'pptx'];

function activeTab() { return tabs.find(t => t.id === activeId) || null; }

// format → { label, color } for tab/tree/list badges (design spec)
const FORMAT_BADGE = {
  md:   { label: 'MD',  color: '#b5623a' },
  html: { label: 'HTML', color: '#5a86b0' },
  pdf:  { label: 'PDF', color: '#c05a4a' },
  docx: { label: 'DOC', color: '#2f6fb0' },
  pptx: { label: 'PPT', color: '#c8912a' },
  sheet:{ label: 'XLS', color: '#3f8f5a' },
  text: { label: 'TXT', color: '#8a7f6d' },
  canvas:{ label: 'CNV', color: '#6d5ac2' },
  unsupported: { label: '?', color: '#8a7f6d' },
};
function badgeFor(kind) { return FORMAT_BADGE[kind] || FORMAT_BADGE.text; }

function renderTabStrip() {
  const strip = $('tabs');
  strip.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    const isLiveHtml = t.kind === 'html' && effectiveHtmlMode(t) === 'live';
    el.className = 'tab' + (t.id === activeId ? ' active' : '') + (isLiveHtml ? ' live-html' : '');
    el.title = t.path || t.name;
    el.dataset.id = t.id;
    const b = badgeFor(t.kind);
    el.innerHTML = `<span class="tab-badge"></span><span class="tab-name"></span><span class="tab-live">LIVE</span><span class="tab-dirty" title="Unsaved changes"></span><button class="tab-close" title="Close (⌘W)">×</button>`;
    const badgeEl = el.querySelector('.tab-badge');
    badgeEl.textContent = b.label; badgeEl.style.background = b.color;
    if (t.dirty) el.classList.add('dirty');
    const proj = projectOf(t.path);
    if (proj) { el.dataset.projectColor = '1'; el.style.setProperty('--proj', proj.color); }
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openTabAssignMenu(e, t); });
    el.querySelector('.tab-name').textContent = t.name;
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.tab-close')) return;
      switchTab(t.id);
      startTabDrag(e, t.id);
    });
    el.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
    strip.appendChild(el);
  }
  document.title = activeTab() ? activeTab().name + ' — Vedrix' : 'Vedrix';
}

/* drag a tab left/right to reorder */
function startTabDrag(e, id) {
  const startX = e.clientX;
  let dragging = false;
  const move = (ev) => {
    if (!dragging && Math.abs(ev.clientX - startX) > 6) dragging = true;
    if (!dragging) return;
    const strip = $('tabs');
    const el = strip.querySelector(`.tab[data-id="${id}"]`);
    if (!el) return;
    el.classList.add('dragging');
    const i = tabs.findIndex(t => t.id === id);
    for (const sib of strip.children) {
      if (sib === el) continue;
      const r = sib.getBoundingClientRect();
      const j = tabs.findIndex(t => t.id === +sib.dataset.id);
      const crossed = (j < i && ev.clientX < r.left + r.width / 2) ||
                      (j > i && ev.clientX > r.left + r.width / 2);
      if (crossed) {
        tabs.splice(j, 0, tabs.splice(i, 1)[0]);
        renderTabStrip();
        const el2 = strip.querySelector(`.tab[data-id="${id}"]`);
        if (el2) el2.classList.add('dragging');
        break;
      }
    }
  };
  const up = () => {
    const el = $('tabs').querySelector(`.tab[data-id="${id}"]`);
    if (el) el.classList.remove('dragging');
    if (dragging) saveSession();
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function switchTab(id) {
  const prev = activeTab();
  if (prev) prev.scrollTop = scrollerEl.scrollTop;
  if (!$('findbar').hidden) closeFind();
  graphOpen = false;
  activeId = id;
  renderTabStrip();
  renderActive();
  saveSession();
}

function disposeTab(t) {
  if (t._doc) { try { t._doc.destroy(); } catch (_) {} }
  if (t._observer) t._observer.disconnect();
  (t._urls || []).forEach(u => URL.revokeObjectURL(u));
}

function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i === -1) return;
  const wasActive = tabs[i].id === activeId;
  disposeTab(tabs[i]);
  tabs.splice(i, 1);
  if (wasActive) activeId = tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : null;
  renderTabStrip();
  renderActive();
  saveSession();
}

function addTab(tab) {
  tab.id = nextTabId++;
  tab.scrollTop = 0;
  tabs.push(tab);
  activeId = tab.id;
  renderTabStrip();
  renderActive();
  recordRecent(tab.name, tab.path);
  saveSession();
}

function saveSession() {
  if (!TAURI) return;
  const paths = tabs.filter(t => t.path).map(t => t.path);
  const active = activeTab();
  lsSet('mv_session', JSON.stringify({ paths, activePath: active && active.path }));
}

/* ---------- Panes & TOC ---------- */

function showPane(pane) {
  emptyEl.hidden = pane !== 'empty';
  scrollerEl.hidden = pane !== 'content' && pane !== 'pages';
  contentEl.hidden = pane !== 'content';
  pagesHostEl.hidden = pane !== 'pages';
  unsupportedEl.hidden = pane !== 'unsupported';
  $('mapview').hidden = pane !== 'map';
  $('graphview').hidden = pane !== 'graph';
  $('canvasview').hidden = pane !== 'canvas';
  $('dbview').hidden = pane !== 'db';
  $('home').hidden = pane !== 'home';
  // canvas and database own their full pane — no TOC/outline applies to them
  $('sidebar').style.display = (pane === 'home' || pane === 'canvas' || pane === 'db') ? 'none' : '';
}

function slugify(text, used) {
  let slug = text.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-') || 'section';
  while (used.has(slug)) slug += '-x';
  used.add(slug);
  return slug;
}

let tocObserver = null;

/* sidebar shell: Contents (toc) / Files (folder tree) */
let folder = null;          // { root, tree }
let sideMode = 'toc';
let sidebarCollapsed = false;

/* ============================================================
   Projects & grouping (D3) — persisted in a local sidecar
   (app-data via Rust, or localStorage in browser); keyed by
   file path, NEVER written into the documents themselves.
   library = { projects:[{id,name,color,icon}], assign:{path:projId}, tags:{path:[..]} }
   ============================================================ */

const PROJECT_PALETTE = ['#b5623a', '#4f8a80', '#5a6bb0', '#8a5a80', '#7a8a4a', '#c8912a', '#c05a4a', '#4a7ba6'];
// Full stroke-icon package for projects (one family, 24×24, 1.6 stroke)
const PROJECT_ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M19 3v16"/>',
  star: '<path d="M12 3l2.6 6 6.4.5-4.9 4.2 1.6 6.3L12 17l-5.7 3 1.6-6.3L3 9.5 9.4 9z"/>',
  graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="9" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8 7.5l8 1M8 16l1-6"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5"/>',
  rocket: '<path d="M5 15c-1 1-1 4-1 4s3 0 4-1M14 4c3-1 6 2 5 5-1 4-6 8-6 8l-4-4s4-5 5-9z"/><circle cx="14.5" cy="9.5" r="1.3"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5c-.6.6-1 1.3-1 2.1H9c0-.8-.4-1.5-1-2.1A6 6 0 0 1 12 3z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  brush: '<path d="M4 20c2 1 5-1 5-3l8-9-3-3-9 8c-2 0-4 3-1 7z"/>',
  camera: '<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/>',
  heart: '<path d="M12 20s-7-4.5-9-9C1.5 7.5 4 4 7 4c2 0 3.5 1.5 5 3.5C13.5 5.5 15 4 17 4c3 0 5.5 3.5 4 7-2 4.5-9 9-9 9z"/>',
  chart: '<path d="M4 20V4M4 20h16M8 16v-4M13 16V8M18 16v-7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9h16M8 3v4M16 3v4"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-2 4-4 2 2-4z"/>',
  leaf: '<path d="M5 19c8 2 14-4 14-12 0-1 0-2-.5-2.5C10 5 5 10 5 19z"/><path d="M9 15c2-3 5-5 8-6"/>',
  shield: '<path d="M12 3l7 3v6c0 5-3 7-7 9-4-2-7-4-7-9V6z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
};
const PROJECT_ICON_KEYS = Object.keys(PROJECT_ICONS);

let library = { projects: [], assign: {}, tags: {} };
const projectsOpen = new Set();  // expanded project ids in sidebar

async function loadLibrary() {
  try {
    let raw;
    if (TAURI) raw = await TAURI.core.invoke('read_library');
    else raw = localStorage.getItem('mv_library') || '';
    if (raw) library = JSON.parse(raw);
    library.projects ||= []; library.assign ||= {}; library.tags ||= {}; library.annotations ||= {};
  } catch (_) { library = { projects: [], assign: {}, tags: {}, annotations: {} }; }
}

async function saveLibrary() {
  const raw = JSON.stringify(library);
  try {
    if (TAURI) await TAURI.core.invoke('write_library', { contents: raw });
    else lsSet('mv_library', raw);
  } catch (err) { console.error('saveLibrary', err); }
}

function projectById(id) { return library.projects.find(p => p.id === id) || null; }
function projectOf(path) { return path ? projectById(library.assign[path]) : null; }
function docsInProject(id) { return Object.keys(library.assign).filter(p => library.assign[p] === id); }

function projIconSvg(key) { return `<svg viewBox="0 0 24 24">${PROJECT_ICONS[key] || PROJECT_ICONS.folder}</svg>`; }

function createProject({ name, color, icon, desc }) {
  const id = 'p' + Date.now().toString(36) + Math.floor(performance.now()).toString(36);
  library.projects.push({ id, name, color, icon, desc: desc || '' });
  saveLibrary();
  return id;
}

function assignToProject(path, projId) {
  if (!path) return;
  if (projId) library.assign[path] = projId; else delete library.assign[path];
  saveLibrary();
  renderProjects();
  renderTabStrip();
}

/* ---- new/edit-project modal ---- */
const projDraft = { color: PROJECT_PALETTE[0], icon: 'layers', onCreate: null, editId: null };

function openProjectModal(onCreate, editProject) {
  projDraft.editId = editProject ? editProject.id : null;
  projDraft.color = editProject ? editProject.color : PROJECT_PALETTE[0];
  projDraft.icon = editProject ? editProject.icon : 'layers';
  projDraft.onCreate = onCreate || null;
  $('proj-name').value = editProject ? editProject.name : '';
  $('proj-desc').value = editProject ? (editProject.desc || '') : '';
  $('proj-create').textContent = editProject ? 'Save changes' : 'Create project';
  // color swatches
  const cw = $('proj-colors'); cw.innerHTML = '';
  PROJECT_PALETTE.forEach(c => {
    const b = document.createElement('button'); b.className = 'proj-sw'; b.style.background = c;
    b.classList.toggle('sel', c === projDraft.color);
    b.addEventListener('click', () => { projDraft.color = c; syncProjPreview(); });
    cw.appendChild(b);
  });
  // icon grid (full package — scrolls)
  const iw = $('proj-icons'); iw.innerHTML = '';
  PROJECT_ICON_KEYS.forEach(k => {
    const b = document.createElement('button'); b.className = 'proj-ic'; b.innerHTML = projIconSvg(k);
    b.classList.toggle('sel', k === projDraft.icon);
    b.addEventListener('click', () => { projDraft.icon = k; syncProjPreview(); });
    iw.appendChild(b);
  });
  $('project-overlay').hidden = false;
  syncProjPreview();
  setTimeout(() => $('proj-name').focus(), 30);
}

function syncProjPreview() {
  $('proj-colors').querySelectorAll('.proj-sw').forEach((b, i) => b.classList.toggle('sel', PROJECT_PALETTE[i] === projDraft.color));
  $('proj-icons').querySelectorAll('.proj-ic').forEach((b, i) => b.classList.toggle('sel', PROJECT_ICON_KEYS[i] === projDraft.icon));
  const tile = $('proj-preview-icon');
  tile.innerHTML = projIconSvg(projDraft.icon);
  tile.style.background = colorTint(projDraft.color, 0.18);
  tile.style.color = projDraft.color;
  $('proj-preview-name').textContent = $('proj-name').value.trim() || 'New project';
}

function colorTint(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/* ============================================================
   Home / Projects dashboard (D4)
   ============================================================ */

let homeShown = false;

function greeting() {
  // no Date.now allowed in some contexts, but here it's fine (browser)
  const h = new Date().getHours();
  const g = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return settings.profileName ? `${g}, ${settings.profileName}` : g;
}

function showHome() {
  homeShown = true;
  renderHome();
  showPane('home');
  $('context-bar').hidden = true;
  document.querySelectorAll('#nav-rail .nr-btn').forEach(b => b.classList.toggle('sel', b.dataset.nav === 'home'));
}

function hideHome() {
  homeShown = false;
  document.querySelectorAll('#nav-rail .nr-btn').forEach(b => b.classList.remove('sel'));
  renderActive();
}

function renderHome() {
  $('home-greeting').textContent = greeting();
  const nDocs = new Set(Object.keys(library.assign)).size;
  $('home-sub').textContent = `${library.projects.length} project${library.projects.length === 1 ? '' : 's'} · ${recents.length} recent file${recents.length === 1 ? '' : 's'}`;
  // project cards
  const pc = $('home-projects'); pc.innerHTML = '';
  if (!library.projects.length) {
    pc.innerHTML = `<button class="home-proj-empty" id="home-proj-empty">＋ Create your first project<span>Group documents with a color and icon</span></button>`;
    pc.querySelector('#home-proj-empty').addEventListener('click', () => openProjectModal((id) => { projectsOpen.add(id); renderHome(); }));
  } else {
    for (const p of library.projects) {
      const docs = docsInProject(p.id);
      const card = document.createElement('button');
      card.className = 'home-card';
      card.style.setProperty('--pc', p.color);
      card.innerHTML = `<span class="hc-bar"></span><span class="hc-icon">${projIconSvg(p.icon)}</span><span class="hc-name"></span><span class="hc-meta">${docs.length} doc${docs.length === 1 ? '' : 's'}</span>`;
      card.querySelector('.hc-icon').style.background = colorTint(p.color, 0.16);
      card.querySelector('.hc-icon').style.color = p.color;
      card.querySelector('.hc-name').textContent = p.name;
      card.addEventListener('click', () => { projectsOpen.clear(); projectsOpen.add(p.id); hideHome(); sideMode = 'files'; sidebarCollapsed = false; renderProjects(); updateSidebar(); });
      pc.appendChild(card);
    }
  }
  // recents
  const rl = $('home-recents'); rl.innerHTML = '';
  if (!recents.length) {
    const empty = document.createElement('div');
    empty.className = 'home-empty';
    empty.textContent = 'No recent documents yet. ';
    const b = document.createElement('button');
    b.className = 'home-link'; b.textContent = 'Open a file';
    b.addEventListener('click', () => { hideHome(); openViaPicker(); });
    empty.appendChild(b);
    rl.appendChild(empty);
  }
  else recents.slice(0, 8).forEach(r => {
    const proj = projectOf(r.path);
    const badge = badgeFor(kindOf(r.name));
    const row = document.createElement('button');
    row.className = 'home-recent';
    row.innerHTML = `<span class="hr-badge" style="background:${badge.color}">${badge.label}</span><span class="hr-name"></span>${proj ? `<span class="hr-proj"><span class="hr-dot" style="background:${proj.color}"></span>${escapeHtmlText(proj.name)}</span>` : ''}<span class="hr-time">${timeAgo(r.ts)}</span>`;
    row.querySelector('.hr-name').textContent = r.name;
    row.addEventListener('click', () => { hideHome(); if (TAURI) openTauriPath(r.path); });
    rl.appendChild(row);
  });
}

function wireHome() {
  const nav = $('nav-rail');
  nav.hidden = false;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav], .nr-mark'); if (!btn) return;
    const nav2 = btn.dataset.nav || 'home';
    if (nav2 === 'home') showHome();
    else if (nav2 === 'files') { hideHome(); sideMode = 'files'; sidebarCollapsed = false; updateSidebar(); }
    else if (nav2 === 'projects') { hideHome(); sideMode = 'files'; sidebarCollapsed = false; renderProjects(); updateSidebar(); }
    else if (nav2 === 'graph') { hideHome(); if (typeof toggleGraph === 'function') toggleGraph(); }
    else if (nav2 === 'history') { hideHome(); $('history-panel').hidden = false; }
    else if (nav2 === 'settings') { hideHome(); $('settings-overlay').hidden = false; }
  });
  $('home-new').addEventListener('click', () => { hideHome(); openViaPicker(); });
  $('home-new-canvas').addEventListener('click', () => newCanvas());
  $('home-new-proj').addEventListener('click', () => openProjectModal((id) => { projectsOpen.add(id); renderHome(); }));
  $('home-open').addEventListener('click', () => { hideHome(); openViaPicker(); });
  $('home-open-folder').addEventListener('click', () => { hideHome(); if (typeof openFolder === 'function') openFolder(); });
  $('home-ai').addEventListener('click', () => { hideHome(); toggleAiPanel(true); });
}

/* ---- Projects sidebar group ---- */
function renderProjects() {
  const host = $('projects');
  if (!host) return;
  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'proj-head';
  head.innerHTML = `<span>PROJECTS</span><button class="proj-add" title="New project">${svgIcon('plus')}</button>`;
  head.querySelector('.proj-add').addEventListener('click', () => openProjectModal((id) => { const t = activeTab(); if (t && t.path) assignToProject(t.path, id); }));
  host.appendChild(head);
  if (!library.projects.length) {
    const empty = document.createElement('div');
    empty.className = 'proj-empty';
    empty.textContent = 'Group documents into color-coded projects.';
    host.appendChild(empty);
    return;
  }
  for (const p of library.projects) {
    const open = projectsOpen.has(p.id);
    const docs = docsInProject(p.id);
    const row = document.createElement('div');
    row.className = 'proj-row';
    const tileIcon = `<span class="proj-ic-tile" style="background:${colorTint(p.color, 0.18)};color:${p.color}">${projIconSvg(p.icon)}</span>`;
    row.innerHTML = `<span class="proj-chevron${open ? ' open' : ''}">▸</span>${tileIcon}<span class="proj-name"></span><button class="proj-rowadd" title="Add a document to this project">＋</button><button class="proj-rowmore" title="Project options">⋯</button><span class="proj-count">${docs.length}</span>`;
    row.querySelector('.proj-name').textContent = p.name;
    row.addEventListener('click', (e) => { if (e.target.closest('button')) return; if (open) projectsOpen.delete(p.id); else projectsOpen.add(p.id); renderProjects(); });
    row.querySelector('.proj-rowadd').addEventListener('click', (e) => { e.stopPropagation(); openAddDocMenu(e, p); });
    row.querySelector('.proj-rowmore').addEventListener('click', (e) => { e.stopPropagation(); openProjectContext(e, p); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); openProjectContext(e, p); });
    host.appendChild(row);
    if (open) {
      const list = document.createElement('div'); list.className = 'proj-docs';
      if (!docs.length) { const d = document.createElement('div'); d.className = 'proj-doc-empty'; d.textContent = 'No documents yet'; list.appendChild(d); }
      for (const path of docs) {
        const b = document.createElement('button'); b.className = 'proj-doc';
        const badge = badgeFor(kindOf(path.split('/').pop()));
        b.innerHTML = `<span class="pd-badge" style="background:${badge.color}">${badge.label}</span><span class="pd-name"></span><span class="pd-x" title="Remove from project">✕</span>`;
        b.querySelector('.pd-name').textContent = path.split('/').pop();
        b.querySelector('.pd-x').addEventListener('click', (e) => { e.stopPropagation(); assignToProject(path, null); });
        b.addEventListener('click', () => { if (TAURI) openTauriPath(path); });
        list.appendChild(b);
      }
      const add = document.createElement('button'); add.className = 'proj-doc proj-doc-add';
      add.innerHTML = `<span class="pd-plus">＋</span><span>Add a document…</span>`;
      add.addEventListener('click', (e) => openAddDocMenu(e, p));
      list.appendChild(add);
      host.appendChild(list);
    }
  }
}

// small menu: add the current document, or pick a file
function openAddDocMenu(e, p) {
  const m = $('assign-menu');
  const t = activeTab();
  let html = '<div class="am-label">Add to “' + escapeHtmlText(p.name) + '”</div>';
  if (t && t.path && library.assign[t.path] !== p.id) html += `<button data-a="current">Add current document<span class="am-sub">${escapeHtmlText(t.name)}</span></button>`;
  html += `<button data-a="pick"><span class="am-plus">+</span> Choose a file…</button>`;
  m.innerHTML = html;
  const cur = m.querySelector('[data-a="current"]');
  if (cur) cur.addEventListener('click', () => { m.hidden = true; assignToProject(t.path, p.id); projectsOpen.add(p.id); renderProjects(); });
  m.querySelector('[data-a="pick"]').addEventListener('click', () => { m.hidden = true; addFileToProject(p.id); });
  showMenuAt(m, e.clientX, e.clientY);
}

function openProjectContext(e, p) {
  const m = $('assign-menu');
  m.innerHTML = `<button data-a="add">Add a document…</button><button data-a="edit">Edit project…</button><div class="am-sep"></div><button data-a="delete">Delete project</button>`;
  m.querySelector('[data-a="add"]').addEventListener('click', (ev) => { m.hidden = true; openAddDocMenu(ev, p); });
  m.querySelector('[data-a="edit"]').addEventListener('click', () => { m.hidden = true; openProjectModal(null, p); });
  m.querySelector('[data-a="delete"]').addEventListener('click', () => {
    // delete with undo: snapshot the project + its assignments, restore on tap
    const snapProject = p;
    const snapAssigns = Object.keys(library.assign).filter(k => library.assign[k] === p.id);
    library.projects = library.projects.filter(x => x.id !== p.id);
    snapAssigns.forEach(k => delete library.assign[k]);
    saveLibrary(); renderProjects(); renderTabStrip(); if (homeShown) renderHome(); m.hidden = true;
    toastAction(`Deleted “${p.name}”`, 'Undo', () => {
      library.projects.push(snapProject);
      snapAssigns.forEach(k => { library.assign[k] = snapProject.id; });
      saveLibrary(); renderProjects(); renderTabStrip(); if (homeShown) renderHome();
    });
  });
  showMenuAt(m, e.clientX, e.clientY);
}

/* ---- tab → Add to project (right-click) ---- */
function openTabAssignMenu(e, t) {
  if (!t.path) return; // only persisted files can be grouped
  const m = $('assign-menu');
  const cur = library.assign[t.path];
  let html = '<div class="am-label">Add to project</div>';
  for (const p of library.projects) {
    html += `<button data-p="${p.id}"><span class="am-dot" style="background:${p.color}"></span>${escapeHtmlText(p.name)}${cur === p.id ? ' <span class="am-check">✓</span>' : ''}</button>`;
  }
  html += `<button data-p="__new"><span class="am-plus">+</span> New project…</button>`;
  if (cur) html += `<div class="am-sep"></div><button data-p="">Remove from project</button>`;
  if (t.kind !== 'canvas') html += `<div class="am-sep"></div><button data-send-cv="1"><span class="am-plus">→</span> Send to canvas…</button>`;
  m.innerHTML = html;
  m.querySelectorAll('button[data-p]').forEach(btn => btn.addEventListener('click', () => {
    const v = btn.dataset.p;
    m.hidden = true;
    if (v === '__new') openProjectModal((id) => assignToProject(t.path, id));
    else assignToProject(t.path, v || null);
  }));
  const cvBtn = m.querySelector('button[data-send-cv]');
  if (cvBtn) cvBtn.addEventListener('click', () => { m.hidden = true; sendDocToCanvas(t, e); });
  showMenuAt(m, e.clientX, e.clientY);
}

function escapeHtmlText(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

function openTabAssignMenuCentered(t) {
  openTabAssignMenu({ preventDefault() {}, clientX: window.innerWidth / 2 - 95, clientY: window.innerHeight / 2 - 60 }, t);
}

function showMenuAt(m, x, y) {
  m.hidden = false;
  const mainRect = document.body.getBoundingClientRect();
  m.style.left = Math.min(x, mainRect.width - m.offsetWidth - 8) + 'px';
  m.style.top = Math.min(y, mainRect.height - m.offsetHeight - 8) + 'px';
  const close = (ev) => { if (!ev.target.closest('#assign-menu')) { m.hidden = true; document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

function wireProjectModal() {
  $('proj-name').addEventListener('input', () => { $('proj-preview-name').textContent = $('proj-name').value.trim() || 'New project'; });
  $('proj-cancel').addEventListener('click', () => { $('project-overlay').hidden = true; });
  $('project-overlay').addEventListener('mousedown', (e) => { if (e.target === $('project-overlay')) $('project-overlay').hidden = true; });
  $('proj-create').addEventListener('click', () => {
    const name = $('proj-name').value.trim(); if (!name) { $('proj-name').focus(); return; }
    if (projDraft.editId) {
      const p = projectById(projDraft.editId);
      if (p) { p.name = name; p.color = projDraft.color; p.icon = projDraft.icon; p.desc = $('proj-desc').value.trim(); saveLibrary(); }
      $('project-overlay').hidden = true;
      renderProjects(); renderTabStrip(); if (homeShown) renderHome();
      return;
    }
    const id = createProject({ name, color: projDraft.color, icon: projDraft.icon, desc: $('proj-desc').value.trim() });
    $('project-overlay').hidden = true;
    projectsOpen.add(id);
    if (projDraft.onCreate) projDraft.onCreate(id);
    renderProjects();
    if (homeShown) renderHome();
  });
}

// Add a document to a project via the OS picker (works even with no tab open)
async function addFileToProject(projId) {
  let path = null;
  if (TAURI) {
    const picked = await TAURI.core.invoke('plugin:dialog|open', { options: { multiple: false, directory: false } });
    path = typeof picked === 'string' ? picked : (picked && picked.path);
  }
  if (path) { assignToProject(path, projId); projectsOpen.add(projId); renderProjects(); }
  else toast('Open a file, then use “Add to project”.');
}


function updateSidebar() {
  const hasToc = !tocEl.classList.contains('hidden');
  const hasFiles = !!folder || library.projects.length > 0;
  const hasNotes = canAnnotate(activeTab());
  const at = activeTab();
  const hasLinks = !!(at && at.kind === 'md');
  $('side-tabs').hidden = !(hasFiles || hasNotes || hasLinks);
  const notesBtn = document.querySelector('#side-tabs button[data-m="notes"]');
  if (notesBtn) notesBtn.hidden = !hasNotes;
  const linksBtn = document.querySelector('#side-tabs button[data-m="links"]');
  if (linksBtn) linksBtn.hidden = !hasLinks;
  let mode = sideMode;
  if (mode === 'files' && !hasFiles) mode = 'toc';
  if (mode === 'notes' && !hasNotes) mode = 'toc';
  if (mode === 'links' && !hasLinks) mode = 'toc';
  tocEl.hidden = mode !== 'toc';
  $('files-pane').hidden = mode !== 'files';
  $('filetree').hidden = !folder;
  $('notes-pane').hidden = mode !== 'notes';
  $('links-pane').hidden = mode !== 'links';
  if (mode === 'notes') renderNotesPane();
  if (mode === 'links') renderLinksPane();
  document.querySelectorAll('#side-tabs button').forEach(b => b.classList.toggle('sel', b.dataset.m === mode));
  $('sidebar').classList.toggle('hidden', sidebarCollapsed || (!hasToc && !hasFiles && !hasNotes));
  if (typeof reclampDocks === 'function') reclampDocks();   // freed/consumed width → re-fit both docks
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  updateSidebar();
  syncDrawerBackdrop();
}

// On mobile the sidebar is an overlay drawer — show a backdrop behind it.
function syncDrawerBackdrop() {
  const open = document.body.classList.contains('mobile')
    && !$('sidebar').classList.contains('hidden');
  $('drawer-backdrop').hidden = !open;
}

// Close the drawer after picking something (mobile only).
function closeDrawerIfMobile() {
  if (document.body.classList.contains('mobile') && !sidebarCollapsed) {
    sidebarCollapsed = true;
    updateSidebar();
    syncDrawerBackdrop();
  }
}

function clearToc() {
  tocEl.innerHTML = '';
  if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
  tocEl.classList.add('hidden');
  updateSidebar();
}

function tocSkeleton() {
  const head = document.createElement('div');
  head.className = 'toc-head';
  head.innerHTML = `<span class="toc-title">Contents</span><span class="toc-pct" id="toc-pct">0%</span>`;
  tocEl.appendChild(head);
  const prog = document.createElement('div');
  prog.className = 'toc-prog';
  prog.innerHTML = `<div class="toc-prog-fill" id="toc-prog-fill"></div>`;
  tocEl.appendChild(prog);
  const list = document.createElement('div');
  list.className = 'toc-list';
  list.id = 'toc-list';
  tocEl.appendChild(list);
  // "Ask about this doc" card
  const card = document.createElement('button');
  card.className = 'toc-ask';
  card.innerHTML = `<span class="toc-ask-head"><span class="toc-ask-icon"><svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/></svg></span>Ask about this doc</span><span class="toc-ask-sub">Summarize · find open questions · draft</span>`;
  card.addEventListener('click', () => { if (typeof aiQuick === 'function') aiQuick('summarize'); else toggleAiPanel(); });
  tocEl.appendChild(card);
  tocEl.classList.remove('hidden');
  updateSidebar();
}

// TOC entries append into #toc-list (not tocEl directly) so the card stays last
function tocListEl() { return $('toc-list') || tocEl; }

function updateReadingProgress() {
  const fill = $('toc-prog-fill'); if (!fill) return;
  const max = scrollerEl.scrollHeight - scrollerEl.clientHeight;
  const pct = max > 0 ? Math.round(scrollerEl.scrollTop / max * 100) : 0;
  fill.style.width = pct + '%';
  const p = $('toc-pct'); if (p) p.textContent = pct + '%';
}

/* TOC from rendered headings (md / docx) */
function buildHeadingToc() {
  clearToc();
  const headings = [...contentEl.querySelectorAll('h1, h2, h3')];
  if (headings.length < 2) return;
  tocSkeleton();
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent;
    a.className = 'lvl-' + h.tagName[1];
    a.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    tocListEl().appendChild(a);
  }
  tocObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      tocEl.querySelectorAll('a').forEach(a => a.classList.remove('active'));
      const link = tocEl.querySelector(`a[href="#${CSS.escape(entry.target.id)}"]`);
      if (link) link.classList.add('active');
    }
  }, { root: scrollerEl, rootMargin: '0px 0px -80% 0px' });
  headings.forEach(h => tocObserver.observe(h));
}

/* TOC from a list of {label, level, page} for paged documents (pdf / pptx).
   `page` is 1-based and maps to .doc-page[data-page] elements. */
function buildPagedToc(t) {
  clearToc();
  const items = t._tocItems || [];
  if (!items.length) return;
  tocSkeleton();
  items.forEach((it, i) => {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = it.label;
    a.className = 'lvl-' + Math.min(3, Math.max(1, it.level));
    a.dataset.i = i;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const el = t.pagesEl && t.pagesEl.querySelector(`.doc-page[data-page="${it.page}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    tocListEl().appendChild(a);
  });
  highlightPagedToc(t);
}

/* proportional scroll-indicator thumb, drawn over the scrolling element */
function updateThumb(el, thumb) {
  const sh = el.scrollHeight, ch = el.clientHeight;
  if (sh <= ch + 2) { thumb.classList.remove('visible'); return false; }
  const rect = el.getBoundingClientRect();
  const mainRect = $('main').getBoundingClientRect();
  const h = Math.max(32, ch * ch / sh);
  const top = (el.scrollTop / (sh - ch)) * (ch - h);
  thumb.style.height = h + 'px';
  thumb.style.top = (rect.top - mainRect.top + top) + 'px';
  thumb.style.left = (rect.right - mainRect.left - 10) + 'px';
  return true;
}

function currentPage(t) {
  if (!t.pagesEl) return 1;
  const top = scrollerEl.scrollTop + 80;
  let cur = 1;
  for (const el of t.pagesEl.querySelectorAll('.doc-page')) {
    if (el.offsetTop <= top) cur = +el.dataset.page;
    else break;
  }
  return cur;
}

function highlightPagedToc(t) {
  const items = t._tocItems || [];
  if (!items.length) return;
  const page = currentPage(t);
  let sel = 0;
  items.forEach((it, i) => { if (it.page <= page) sel = i; });
  tocEl.querySelectorAll('a').forEach(a => a.classList.toggle('active', +a.dataset.i === sel));
}

/* ---------- Context bar (path · mode · read-time · saved) ---------- */

function readTime(t) {
  const txt = t.text || (t.html ? t.html.replace(/<[^>]+>/g, ' ') : '');
  const words = (txt.trim().match(/\S+/g) || []).length;
  if (!words) return '';
  return `${Math.max(1, Math.round(words / 220))} min read · ${words.toLocaleString()} words`;
}

function updateContextBar(t) {
  const bar = $('context-bar');
  if (!t || t.kind === 'unsupported') { bar.hidden = true; return; }
  bar.hidden = false;
  // path + filename
  const pathEl = $('ctx-path');
  if (t.path) {
    const dir = t.path.slice(0, t.path.lastIndexOf('/') + 1).replace(/^\/Users\/[^/]+/, '~');
    pathEl.innerHTML = '';
    pathEl.append(document.createTextNode(dir), Object.assign(document.createElement('b'), { textContent: t.name }));
  } else {
    pathEl.innerHTML = ''; pathEl.append(Object.assign(document.createElement('b'), { textContent: t.name }));
  }
  // mode segmented control
  const modes = modesFor(t);
  const seg = $('ctx-modes');
  seg.hidden = modes.length < 2;
  seg.innerHTML = '';
  for (const m of modes) {
    const btn = document.createElement('button');
    btn.textContent = m.label;
    btn.className = m.active ? 'sel' : '';
    btn.addEventListener('click', m.onClick);
    seg.appendChild(btn);
  }
  // meta (read time) — text-ish docs only
  const meta = (['md', 'text', 'docx'].includes(t.kind)) ? readTime(t) : '';
  $('ctx-meta').textContent = meta;
  $('ctx-meta-sep').hidden = !meta || modes.length < 2;
  // saved state
  $('ctx-saved').classList.toggle('dirty', !!t.dirty);
  $('ctx-saved').firstChild && ($('ctx-saved').lastChild.textContent = t.dirty ? ' Unsaved' : ' Saved');
}

// which modes a tab exposes, for the context-bar segmented control
function modesFor(t) {
  if (t.kind === 'md' || t.kind === 'text') {
    return [
      { label: 'Read', active: !t.editing, onClick: () => { if (t.editing) toggleEdit(); } },
      { label: 'Edit', active: !!t.editing, onClick: () => { if (!t.editing) toggleEdit(); } },
    ];
  }
  if (t.kind === 'html') {
    const live = effectiveHtmlMode(t) === 'live';
    return [
      { label: 'Reader', active: !live, onClick: () => { if (live) toggleHtmlMode(); } },
      { label: 'Live', active: live, onClick: () => { if (!live) toggleHtmlMode(); } },
    ];
  }
  return [];
}

/* ---------- Rendering ---------- */

function renderActive() {
  homeShown = false;
  const t = activeTab();
  // clear the interactive-HTML pane flags unless we're about to render live
  // HTML — otherwise a stuck .html-live disables #scroller overflow (no scroll)
  if (!(t && t.kind === 'html')) contentEl.classList.remove('html-host', 'html-live');
  updateContextBar(t);
  const rb = $('reader-btn');
  rb.hidden = !(t && (t.kind === 'pdf' || t.kind === 'html' || t.kind === 'pptx'));
  if (t && t.kind === 'html') {
    const live = effectiveHtmlMode(t) === 'live';
    rb.textContent = live ? 'Aa' : '⚡';
    rb.title = live ? 'Reader mode — read, search, and export this page'
                    : 'Interactive mode — run the page with scripts';
  } else if (t && t.kind === 'pdf') {
    rb.textContent = 'Aa';
    rb.title = 'Reading mode — convert this PDF to Markdown';
  } else if (t && t.kind === 'pptx') {
    rb.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/></svg>';
    rb.title = 'Present (full-screen slideshow)';
  }
  $('map-btn').hidden = !(t && t.kind !== 'unsupported' && t.kind !== 'canvas');
  $('export-btn').hidden = !(t && t.kind !== 'unsupported');
  markActiveFile();
  if (!$('ai-panel').hidden) renderAiChat();
  if (graphOpen && folder) { renderGraph(); return; }
  if (!t || !t.editing) syncEditorPane(null);
  if (!t) { clearToc(); showPane('empty'); return; }

  if (t.viewMode === 'map' && t.kind !== 'unsupported') {
    if (PAGED_KINDS.includes(t.kind) && !t._tocItems) {
      ensurePaged(t).then(() => { if (activeId === t.id && t.viewMode === 'map') renderMap(t); })
        .catch(err => console.error('map failed', err));
    } else {
      renderMap(t);
    }
    return;
  }

  if (t.kind === 'unsupported') {
    clearToc();
    applyRichState(null);
    $('unsupported-name').textContent = t.name;
    $('open-external').hidden = !(TAURI && t.path);
    showPane('unsupported');
    return;
  }

  if (t.kind === 'canvas') {
    clearToc();
    applyRichState(null);
    renderCanvas(t);
    return;
  }

  if (t.kind === 'db') {
    clearToc();
    applyRichState(null);
    renderDb(t);
    return;
  }

  if (t.kind === 'html') {
    applyRichState(null);
    renderHtmlDoc(t);
    applyZoom(t);
    showPane('content');
    return;
  }

  if (PAGED_KINDS.includes(t.kind)) {
    applyRichState(null);
    pagesHostEl.innerHTML = '';
    showPane('pages');
    ensurePaged(t).then(() => {
      if (activeId !== t.id) return;
      if (t.pagesEl.parentElement !== pagesHostEl) {
        pagesHostEl.innerHTML = '';
        pagesHostEl.appendChild(t.pagesEl);
      }
      buildPagedToc(t);
      applyZoom(t);
      scrollerEl.scrollTop = t.scrollTop || 0;
      renderVisiblePages(t);
    }).catch(err => console.error('render failed', t.name, err));
    return;
  }

  // html kinds
  contentEl.classList.remove('html-host');
  contentEl.innerHTML = t.html || '';
  fixupContent(t);
  applyAnnotations(t);           // re-draw saved highlights/notes
  renderProps(t);                // frontmatter → property panel
  decorateWikiLinks(t);          // resolve [[links]] against the vault
  loadBacklinks(t);              // reverse index (async)
  renderEmbeds(t);               // ![[page]] transclusion (async)
  renderInlineViews(t);          // ```vedrix-view database blocks (async)
  renderEnhancements(t).then(() => { if (activeId === t.id && ['md', 'docx', 'sheet'].includes(t.kind)) buildHeadingToc(); });
  if (['md', 'docx', 'sheet'].includes(t.kind)) buildHeadingToc(); else clearToc();
  applyZoom(t);
  showPane('content');
  syncEditorPane(t);
  applyRichState(t);
  scrollerEl.scrollTop = t.scrollTop || 0;
}

/* ---------- HTML documents (sandboxed frame — page keeps its own CSS) ---------- */

/* HTML tabs have two modes:
   - 'live'   (default): scripts RUN. Real file paths load as an asset-protocol
     URL, so relative css/js/images — whole site prototypes — work. Isolation
     comes from the browser origin model: the asset origin is cross-origin
     from the app, so page JS can never reach Sutra's window/IPC/storage.
     Pathless HTML (browser mode, Android content URIs) runs via srcdoc in an
     OPAQUE origin (sandbox="allow-scripts" only — never with allow-same-origin).
   - 'reader': today's script-stripped sandbox; TOC/⌘F/export work. */

function effectiveHtmlMode(t) {
  return t.htmlMode || 'live';
}

function toggleHtmlMode() {
  const t = activeTab();
  if (!t || t.kind !== 'html') return;
  t.htmlMode = effectiveHtmlMode(t) === 'live' ? 'reader' : 'live';
  renderActive();
}

function renderHtmlDoc(t) {
  clearToc();
  const live = effectiveHtmlMode(t) === 'live';
  contentEl.classList.add('html-host');
  contentEl.classList.toggle('html-live', live);
  contentEl.innerHTML = '';
  const f = document.createElement('iframe');
  f.className = 'html-frame';

  if (live) {
    if (TAURI && t.path && !t.path.startsWith('content://')) {
      // real URL: relative assets + multi-file prototypes resolve from disk.
      // allow-same-origin = the frame's OWN asset origin (cross-origin from
      // the app, so the parent stays unreachable). No allow-top-navigation.
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
      f.src = TAURI.core.convertFileSrc(t.path) + '?mv=' + (t.mtime || 0);
    } else {
      // no real path: run the markup in an opaque origin. Scripts run;
      // parent, storage, and relative files are all unreachable.
      f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
      f.srcdoc = t.rawHtml || '';
    }
    t._frame = f;
    contentEl.appendChild(f);
    return; // cross-origin/opaque: no TOC/resize/find access by design
  }

  // ---- reader mode: script-stripped, same-origin so TOC/find/height work ----
  f.setAttribute('sandbox', 'allow-same-origin');
  let src = DOMPurify.sanitize(t.rawHtml || '', { WHOLE_DOCUMENT: true });
  if (TAURI && t.path && !t.path.startsWith('content://')) {
    const dir = t.path.slice(0, t.path.lastIndexOf('/') + 1);
    const base = `<base href="${TAURI.core.convertFileSrc(dir)}/">`;
    src = /<head[^>]*>/i.test(src) ? src.replace(/<head[^>]*>/i, m => m + base) : base + src;
  }
  f.srcdoc = src;
  f.addEventListener('load', () => {
    const d = f.contentDocument;
    if (!d) return;
    const style = d.createElement('style');
    style.textContent = '::highlight(mv-find){background:rgba(255,200,0,.4)} ::highlight(mv-find-cur){background:#f5c518;color:#1a1a1a}';
    (d.head || d.documentElement).appendChild(style);
    const resize = () => {
      f.style.height = Math.max(
        d.documentElement ? d.documentElement.scrollHeight : 0,
        d.body ? d.body.scrollHeight : 0, 200) + 'px';
    };
    resize();
    setTimeout(resize, 400);
    setTimeout(resize, 1500); // late images
    if (activeId === t.id) {
      buildIframeToc(t, f);
      scrollerEl.scrollTop = t.scrollTop || 0;
    }
  });
  t._frame = f;
  contentEl.appendChild(f);
}

function buildIframeToc(t, frame) {
  clearToc();
  const doc = frame.contentDocument;
  if (!doc) return;
  const headings = [...doc.querySelectorAll('h1, h2, h3')].filter(h => h.textContent.trim());
  if (headings.length < 2) return;
  tocSkeleton();
  for (const h of headings) {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = h.textContent.trim().slice(0, 90);
    a.className = 'lvl-' + h.tagName[1];
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const fr = frame.getBoundingClientRect(), sr = scrollerEl.getBoundingClientRect();
      scrollerEl.scrollTop += fr.top + h.getBoundingClientRect().top - sr.top - 12;
    });
    tocListEl().appendChild(a);
  }
  updateSidebar();
}

let mermaidSeq = 0;
async function renderEnhancements(t) {
  if (t.kind === 'md') renderCallouts();
  // KaTeX math ($…$, $$…$$) — markdown only
  if (t.kind === 'md' && window.renderMathInElement) {
    try {
      renderMathInElement(contentEl, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true },
        ],
        throwOnError: false,
      });
    } catch (_) {}
  }
  // Mermaid diagrams from ```mermaid fences
  if (t.kind === 'md' && window.mermaid) {
    const fences = [...contentEl.querySelectorAll('pre > code.language-mermaid')];
    if (fences.length) {
      const theme = THEMES.find(th => th.key === settings.theme) || THEMES[0];
      const dark = theme.base === 'dark' || (theme.base === 'system' && sysDark.matches);
      mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
      for (const code of fences) {
        const div = document.createElement('div');
        div.className = 'mermaid';
        div.id = 'mmd-' + (++mermaidSeq);
        div.dataset.src = code.textContent; // kept for edit round-trip / export
        div.textContent = code.textContent;
        code.parentElement.replaceWith(div);
      }
      try { await mermaid.run({ nodes: contentEl.querySelectorAll('.mermaid') }); } catch (_) {}
    }
  }
}

function fixupContent(t) {
  const used = new Set();
  contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => { h.id = slugify(h.textContent, used); });
  contentEl.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (/^https?:\/\//i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
  });
  if (TAURI && t.path) {
    const dir = t.path.slice(0, t.path.lastIndexOf('/'));
    contentEl.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src');
      if (!/^(https?:|data:|file:|asset:|blob:)/i.test(src)) {
        img.setAttribute('data-orig-src', src); // restored on edit round-trip
        img.src = TAURI.core.convertFileSrc(src.startsWith('/') ? src : dir + '/' + src);
      }
    });
    // relative links to local files open in-app
    contentEl.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (/^(https?:|mailto:|tel:|#)/i.test(href)) return;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const clean = decodeURIComponent(href.split('#')[0]);
        if (!clean) return;
        const abs = clean.startsWith('/') ? clean : dir + '/' + clean;
        navStack.push(t.path);
        navForward.length = 0;
        openTauriPath(abs);
      });
    });
  }
}

/* ==========================================================================
   N1 — Pages & properties (local-first "Notion" layer)

   Four pieces, all file-first: YAML frontmatter IS the property system,
   [[wikilinks]] are the one link syntax, backlinks are the reverse index,
   and ⌘P jumps to any page by title. Nothing is stored outside the files.
   ========================================================================== */

/* ---- Frontmatter: parse + SURGICAL write ----------------------------------
   The write path never re-serializes the whole block — it rewrites exactly
   one line — so key order, comments, quoting style and spacing all survive.
   (Round-trip fidelity here is the single highest-risk mechanic in N1: a
   property edit must never mangle a file the user hand-wrote.) */

const FM_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// → { fm: the raw block incl. delimiters (or ''), body: everything after }
function splitFm(text) {
  const m = (text || '').match(FM_RE);
  if (!m) return { fm: '', body: text || '' };
  return { fm: m[0], body: (text || '').slice(m[0].length) };
}

// Scalar → display value. Deliberately tiny: we support the YAML subset that
// round-trips safely (scalars + inline/block lists), never arbitrary YAML.
function fmScalar(raw) {
  let v = (raw || '').trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
  return v;
}

// → [{ key, value, list, line }] in file order
function parseFm(text) {
  const { fm } = splitFm(text);
  if (!fm) return [];
  const lines = fm.split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || !line.trim()) continue;
    // block-list continuation ("  - item") belongs to the previous key
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && out.length) {
      const prev = out[out.length - 1];
      prev.list = prev.list || [];
      prev.list.push(fmScalar(item[1]));
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_][A-Za-z0-9_ -]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim(), rest = m[2];
    const entry = { key, value: fmScalar(rest), line: i };
    // note: a [[wikilink]] relation also starts with '[' — it is NOT an inline list
    if (/^\[.*\]$/.test(rest.trim()) && !/^\[\[.*\]\]$/.test(rest.trim())) {   // inline list [a, b]
      entry.list = rest.trim().slice(1, -1).split(',').map(fmScalar).filter(Boolean);
      entry.inline = true;
    } else if (!rest.trim()) {
      entry.list = [];                                   // maybe a block list
    }
    out.push(entry);
  }
  return out;
}

function fmSerializeValue(v) {
  // Quote list items that contain YAML-significant characters. Without this a
  // list of [[wikilinks]] serializes to [[[a]], [[b]]] — which reads back as one
  // mangled link, i.e. we would write a format we cannot parse.
  if (Array.isArray(v)) {
    return '[' + v.map(x => {
      const s = String(x);
      return /[[\]{},:#"']/.test(s) ? JSON.stringify(s) : s;
    }).join(', ') + ']';
  }
  const s = String(v);
  // quote only when YAML would otherwise misread it
  return /^[\s]|[\s]$|^[#&*!|>%@`]|:\s|^-\s|^$/.test(s) ? JSON.stringify(s) : s;
}

// Surgical single-key rewrite. Adds the key (or a whole frontmatter block)
// when absent; removes the line when value is null.
function fmSet(text, key, value) {
  const { fm, body } = splitFm(text);
  const nl = /\r\n/.test(text || '') ? '\r\n' : '\n';
  if (!fm) {
    if (value == null) return text;
    // keep a blank line between the block and the body — otherwise a file that
    // gains its first property reads as "---# Heading"
    const gap = body && !body.startsWith('\n') ? nl : '';
    return '---' + nl + key + ': ' + fmSerializeValue(value) + nl + '---' + nl + gap + (body || '');
  }
  const lines = fm.split(/\r?\n/);
  const entry = parseFm(text).find(e => e.key === key);
  if (entry) {
    // drop any block-list continuation lines that belong to this key
    let end = entry.line;
    while (end + 1 < lines.length - 1 && /^\s+-\s+/.test(lines[end + 1])) end++;
    if (value == null) lines.splice(entry.line, end - entry.line + 1);
    else lines.splice(entry.line, end - entry.line + 1, key + ': ' + fmSerializeValue(value));
  } else {
    if (value == null) return text;
    lines.splice(lines.length - 1, 0, key + ': ' + fmSerializeValue(value));  // before closing ---
  }
  return lines.join(nl) + body;
}

/* ---- Property types -------------------------------------------------------
   Inferred from the value, not declared. Keeps files portable: any editor
   writing `status: Done` gets a select chip here for free. */
function propType(entry) {
  if (entry.list) return 'list';
  const v = (entry.value || '').trim();
  if (/^(true|false|yes|no)$/i.test(v)) return 'checkbox';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
  if (/^\d{4}-\d{2}-\d{2}(T[\d:]+)?/.test(v)) return 'date';
  if (/^\[\[.+\]\]$/.test(v)) return 'relation';
  if (/^https?:\/\//i.test(v)) return 'url';
  return 'text';
}

const PROP_ICONS = {
  text:'M4 7h16M4 12h10M4 17h13', number:'M6 4l-1 16M14 4l-1 16M4 9h16M3 15h16',
  date:'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13H4zM4 10h16M9 3v4M15 3v4',
  checkbox:'M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 12l3 3 5-6',
  list:'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  relation:'M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-6-6l-1.5 1.5M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 6 6l1.5-1.5',
  url:'M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-6-6l-1.5 1.5M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 6 6l1.5-1.5',
};

/* ---- The property panel (above the document, never inside the editor) ----
   It lives OUTSIDE #content on purpose: #content becomes contentEditable in
   rich mode, so anything inside it would be typed into — and serialized back
   into the markdown body. */
function renderProps(t) {
  const panel = $('props-panel');
  if (!panel) return;
  const show = !!(t && t.kind === 'md' && !t.presenting);
  const entries = show ? parseFm(t.text || '') : [];
  if (!show) { panel.hidden = true; panel.innerHTML = ''; return; }
  panel.hidden = false;
  panel.innerHTML = '';
  // a page with no properties still offers the way in — otherwise the whole
  // property system is invisible on the (very common) file with no frontmatter
  panel.classList.toggle('empty', !entries.length);

  entries.forEach(e => {
    const type = propType(e);
    const row = document.createElement('div');
    row.className = 'prop-row';
    const k = document.createElement('button');
    k.className = 'prop-key'; k.type = 'button'; k.title = type;
    k.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + (PROP_ICONS[type] || PROP_ICONS.text) + '"/></svg><span></span>';
    k.querySelector('span').textContent = e.key;
    row.appendChild(k);

    const val = document.createElement('div');
    val.className = 'prop-val prop-' + type;
    if (type === 'list') {
      (e.list || []).forEach(item => {
        const chip = document.createElement('span');
        chip.className = 'prop-chip'; chip.textContent = item; val.appendChild(chip);
      });
      if (!(e.list || []).length) val.innerHTML = '<span class="prop-empty">Empty</span>';
    } else if (type === 'checkbox') {
      const on = /^(true|yes)$/i.test(e.value);
      const cb = document.createElement('button');
      cb.className = 'prop-check' + (on ? ' on' : ''); cb.type = 'button';
      cb.innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M5 12l4 4L19 6"/></svg>' : '';
      cb.addEventListener('click', () => setProp(t, e.key, on ? 'false' : 'true'));
      val.appendChild(cb);
    } else if (type === 'relation') {
      const name = e.value.replace(/^\[\[|\]\]$/g, '');
      const a = document.createElement('a');
      a.className = 'wikilink'; a.textContent = name; a.href = '#';
      a.addEventListener('click', ev => { ev.preventDefault(); openWikiLink(name, t); });
      val.appendChild(a);
    } else if (type === 'url') {
      const a = document.createElement('a');
      a.href = e.value; a.target = '_blank'; a.rel = 'noopener'; a.textContent = e.value;
      val.appendChild(a);
    } else {
      val.textContent = e.value || '';
      if (!e.value) val.innerHTML = '<span class="prop-empty">Empty</span>';
    }
    if (!['checkbox', 'relation', 'url'].includes(type)) {
      val.tabIndex = 0;
      val.addEventListener('click', () => editProp(t, e, val));
      val.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); editProp(t, e, val); } });
    }
    row.appendChild(val);
    panel.appendChild(row);
  });

  const add = document.createElement('button');
  add.className = 'prop-add'; add.type = 'button';
  add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg> Add a property';
  add.addEventListener('click', () => addProp(t));
  panel.appendChild(add);
}

let propsAdding = false;

// Inline edit of one property value.
function editProp(t, entry, valEl) {
  const isList = !!entry.list;
  const input = document.createElement('input');
  input.className = 'prop-input';
  input.value = isList ? (entry.list || []).join(', ') : (entry.value || '');
  valEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save) {
      const raw = input.value.trim();
      setProp(t, entry.key, isList ? raw.split(',').map(s => s.trim()).filter(Boolean) : raw);
    } else renderProps(t);
  };
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
}

// Inline "new property" row. (Deliberately not window.prompt: WKWebView
// suppresses it in some configurations, which would make the button dead.)
function addProp(t) {
  const panel = $('props-panel');
  if (!panel || panel.querySelector('.prop-new')) return;
  const row = document.createElement('div');
  row.className = 'prop-row prop-new';
  const input = document.createElement('input');
  input.className = 'prop-input prop-new-key';
  input.placeholder = 'Property name…';
  row.appendChild(input);
  panel.insertBefore(row, panel.querySelector('.prop-add'));
  input.focus();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    const name = input.value.trim();
    row.remove();
    if (save && name) setProp(t, name, ''); else renderProps(t);
  };
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
}

// The one place a property write happens: surgical edit → persist → re-render.
function setProp(t, key, value) {
  if (!t) return;
  const next = fmSet(t.text || '', key, value);
  if (next === t.text) { renderProps(t); return; }
  t.text = next;
  t.fm = splitFm(next).fm;
  renderProps(t);
  setDirty(t, true);
  saveEditor(t);
  if (folder) pageIndex.dirty = true;
}

/* ---- [[wikilinks]] --------------------------------------------------------
   One syntax for page links and relations. Registered as a markdown-it inline
   rule so code spans/fences are respected for free. */
function wikiLinkPlugin(mdit) {
  mdit.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src, pos = state.pos;
    if (src.charCodeAt(pos) !== 0x5B || src.charCodeAt(pos + 1) !== 0x5B) return false;
    const end = src.indexOf(']]', pos + 2);
    if (end < 0) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner || inner.includes('[[')) return false;
    if (!silent) {
      const pipe = inner.indexOf('|');
      const target = (pipe > -1 ? inner.slice(0, pipe) : inner).trim();
      const label = (pipe > -1 ? inner.slice(pipe + 1) : inner).trim();
      const open = state.push('link_open', 'a', 1);
      open.attrs = [['href', '#'], ['class', 'wikilink'], ['data-wiki', target]];
      const txt = state.push('text', '', 0);
      txt.content = label;
      state.push('link_close', 'a', -1);
    }
    state.pos = end + 2;
    return true;
  });
}

/* ---- Page index (titles for resolution, ⌘P and backlinks) ---- */
const pageIndex = { pages: [], root: null, dirty: true };

function buildPageIndex() {
  pageIndex.pages = [];
  if (!folder || !folder.tree) return;
  const walk = (entries) => {
    for (const e of entries) {
      if (e.dir) { walk(e.children || []); continue; }
      if (!/\.(md|markdown|mdown)$/i.test(e.name)) continue;
      pageIndex.pages.push({
        name: e.name,
        title: e.name.replace(/\.(md|markdown|mdown)$/i, ''),
        path: e.path,
        rel: folder.root && e.path.startsWith(folder.root) ? e.path.slice(folder.root.length + 1) : e.path,
      });
    }
  };
  walk(folder.tree);
  pageIndex.root = folder.root;
  pageIndex.dirty = false;
}

// Resolve "[[Some page]]" → an indexed page (exact title, then path suffix, then case-insensitive)
function resolveWiki(target) {
  if (pageIndex.dirty) buildPageIndex();
  const t = target.replace(/\.(md|markdown)$/i, '').trim();
  const lower = t.toLowerCase();
  return pageIndex.pages.find(p => p.title === t)
      || pageIndex.pages.find(p => p.rel.replace(/\.(md|markdown)$/i, '') === t)
      || pageIndex.pages.find(p => p.title.toLowerCase() === lower)
      || pageIndex.pages.find(p => p.rel.toLowerCase().replace(/\.(md|markdown)$/i, '') === lower)
      || null;
}

async function openWikiLink(target, from) {
  const hit = resolveWiki(target);
  if (!hit) { toast('No page named “' + target + '”'); return; }
  if (from && from.path) { navStack.push(from.path); navForward.length = 0; }
  await openTauriPath(hit.path);
}

// Mark resolved/unresolved links after render so missing pages read as missing.
function decorateWikiLinks(t) {
  contentEl.querySelectorAll('a.wikilink[data-wiki]').forEach(a => {
    const target = a.getAttribute('data-wiki');
    const hit = folder ? resolveWiki(target) : null;
    a.classList.toggle('missing', !hit);
    if (!hit) a.title = folder ? 'No page named “' + target + '”' : 'Open a folder to link pages';
    a.addEventListener('click', (e) => { e.preventDefault(); openWikiLink(target, t); });
  });
}

/* ---- Backlinks ------------------------------------------------------------
   The reverse index — computed, never authored. Reuses the native
   search_folder command rather than adding a second scanner. */
const backlinks = { forPath: null, items: [], loading: false };

async function loadBacklinks(t) {
  backlinks.items = []; backlinks.forPath = t && t.path; backlinks.loading = true;
  if (!t || !t.path || !folder || !TAURI) { backlinks.loading = false; return; }
  const title = t.name.replace(/\.(md|markdown|mdown)$/i, '');
  try {
    const hits = await TAURI.core.invoke('search_folder', { root: folder.root, query: '[[' + title });
    backlinks.items = (hits || []).filter(h => h.path !== t.path);
  } catch (err) { backlinks.items = []; }
  backlinks.loading = false;
  if (activeId === t.id && sideMode === 'links') renderLinksPane();
}

function renderLinksPane() {
  const host = $('links-pane');
  if (!host) return;
  host.innerHTML = '';
  const t = activeTab();
  if (!t) return;
  const head = (label, n) => {
    const h = document.createElement('div');
    h.className = 'links-head';
    h.textContent = label + (n != null ? ' · ' + n : '');
    host.appendChild(h);
  };
  // outgoing
  const out = [...contentEl.querySelectorAll('a.wikilink[data-wiki]')]
    .map(a => a.getAttribute('data-wiki'))
    .filter((v, i, arr) => arr.indexOf(v) === i);
  head('Links from this page', out.length);
  if (!out.length) host.appendChild(emptyNote('No [[links]] yet'));
  out.forEach(target => {
    const hit = folder ? resolveWiki(target) : null;
    const row = document.createElement('button');
    row.className = 'link-row' + (hit ? '' : ' missing');
    row.innerHTML = '<span class="lr-title"></span><span class="lr-sub"></span>';
    row.querySelector('.lr-title').textContent = target;
    row.querySelector('.lr-sub').textContent = hit ? hit.rel : 'Not created yet';
    if (hit) row.addEventListener('click', () => openWikiLink(target, t));
    host.appendChild(row);
  });
  // incoming
  head('Linked mentions', backlinks.loading ? null : backlinks.items.length);
  if (backlinks.loading) host.appendChild(emptyNote('Searching…'));
  else if (!backlinks.items.length) host.appendChild(emptyNote(folder ? 'No pages link here yet' : 'Open a folder to see backlinks'));
  backlinks.items.forEach(h => {
    const row = document.createElement('button');
    row.className = 'link-row';
    row.innerHTML = '<span class="lr-title"></span><span class="lr-sub"></span>';
    row.querySelector('.lr-title').textContent = h.name.replace(/\.(md|markdown)$/i, '');
    row.querySelector('.lr-sub').textContent = h.snippet || '';
    row.addEventListener('click', () => { navStack.push(t.path); navForward.length = 0; openTauriPath(h.path); });
    host.appendChild(row);
  });
}

function emptyNote(text) {
  const d = document.createElement('div');
  d.className = 'links-empty'; d.textContent = text;
  return d;
}

/* ---- ⌘P — jump to any page by title ---- */
function openPageJump() {
  buildPageIndex();
  if (!folder) toast('Open a folder (⌘⇧O) to jump across your whole vault');
  openCmd();
  cmdState.pageMode = true;
  $('cmd-input').placeholder = 'Jump to a page…';
  filterCmd('');
  $('cmd-input').focus();
}

/* ---------- Link navigation history ---------- */

const navStack = [];    // paths we came FROM (⌘[)
const navForward = [];  // paths we went BACK from (⌘])

function navBack() {
  const t = activeTab();
  if (!navStack.length) return;
  if (t && t.path) navForward.push(t.path);
  openTauriPath(navStack.pop());
}
function navFwd() {
  const t = activeTab();
  if (!navForward.length) return;
  if (t && t.path) navStack.push(t.path);
  openTauriPath(navForward.pop());
}

/* html-producing converters (md / text / docx / sheet) */
async function buildHtml(kind, { text, bytes }) {
  // frontmatter is the property system — rendered by the property panel, not
  // as document body (markdown-it would otherwise emit it as <hr> + text)
  if (kind === 'md') return DOMPurify.sanitize(md.render(splitFm(text).body), { ADD_ATTR: ['data-wiki', 'data-bid', 'data-embed', 'data-cols', 'open'] });
  if (kind === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'plaintext';
    pre.textContent = text;
    return pre.outerHTML;
  }
  if (kind === 'docx') {
    const result = await window.mammoth.convertToHtml({ arrayBuffer: bytes });
    return DOMPurify.sanitize(result.value);
  }
  if (kind === 'sheet') {
    const wb = XLSX.read(bytes, { type: 'array' });
    let html = '';
    for (const name of wb.SheetNames) {
      const sheetHtml = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
      html += `<section class="sheet-section"><h2>${name}</h2>${sheetHtml}</section>`;
    }
    return DOMPurify.sanitize(html);
  }
  return '';
}

/* ---------- PDF rendering (PDF.js) ---------- */

async function ensurePaged(t) {
  if (t.pagesEl) return;
  if (t.kind === 'pdf') return buildPdfPages(t);
  if (t.kind === 'pptx') return buildPptxPages(t);
}

function pdfjsReady() {
  if (window.pdfjsLib) return Promise.resolve();
  return new Promise(r => window.addEventListener('pdfjs-ready', r, { once: true }));
}

async function buildPdfPages(t) {
  await pdfjsReady();
  // pdf.js transfers the buffer to its worker — hand it a copy
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(t.bytes.slice(0)),
    wasmUrl: new URL('vendor/wasm/', location.href).href,
    standardFontDataUrl: new URL('vendor/standard_fonts/', location.href).href,
  }).promise;
  t._doc = doc;
  t.pagesEl = document.createElement('div');
  t.pagesEl.className = 'doc-pages';

  const first = await doc.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  for (let i = 1; i <= doc.numPages; i++) {
    const holder = document.createElement('div');
    holder.className = 'doc-page pdf-page';
    holder.dataset.page = i;
    holder.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
    t.pagesEl.appendChild(holder);
  }

  // lazy-render pages as they approach the viewport
  t._observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && !entry.target.dataset.rendered) {
        entry.target.dataset.rendered = '1';
        renderPdfPage(t, +entry.target.dataset.page, entry.target);
      }
    }
  }, { root: scrollerEl, rootMargin: '600px 0px' });
  t.pagesEl.querySelectorAll('.pdf-page').forEach(h => t._observer.observe(h));

  t._tocItems = await pdfToc(doc);
}

/* manual fallback for lazy rendering — covers contexts where the
   IntersectionObserver stays silent (hidden windows, zero-size viewports) */
function renderVisiblePages(t) {
  if (!t || t.kind !== 'pdf' || !t.pagesEl || !t._doc) return;
  const vh = scrollerEl.clientHeight;
  const top = scrollerEl.scrollTop;
  let eager = 0;
  for (const h of t.pagesEl.querySelectorAll('.pdf-page')) {
    if (h.dataset.rendered) continue;
    const visible = vh > 0
      ? (h.offsetTop < top + vh + 600 && h.offsetTop + h.offsetHeight > top - 600)
      : eager < 3;
    if (visible) {
      h.dataset.rendered = '1';
      eager++;
      renderPdfPage(t, +h.dataset.page, h);
    }
  }
}

async function renderPdfPage(t, num, holder) {
  try {
    // cancel any in-flight render for this holder (rapid zoom changes)
    if (holder._renderTask) { try { holder._renderTask.cancel(); } catch (_) {} holder._renderTask = null; }
    if (holder._textLayer) { try { holder._textLayer.cancel(); } catch (_) {} holder._textLayer = null; }
    const page = await t._doc.getPage(num);
    const vp = page.getViewport({ scale: 1 });
    holder.style.aspectRatio = `${vp.width} / ${vp.height}`;
    const width = holder.clientWidth || 800;
    const scale = width / vp.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = '100%';
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    holder._renderTask = task;
    await task.promise;
    holder._renderTask = null;
    // selectable text layer on top of the canvas
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    textDiv.style.setProperty('--scale-factor', scale);
    holder.replaceChildren(canvas, textDiv);
    try {
      const tl = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport: page.getViewport({ scale }),
      });
      holder._textLayer = tl;
      await tl.render();
      holder._textLayer = null;
      if (num === 1) diag('textLayer p1 spans=' + textDiv.childElementCount);
    } catch (_) { t._textLayerFailed = true; /* text layer is progressive enhancement */ }
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    console.error('pdf page', num, err);
    // don't leave silent blank space — say which page broke
    holder.innerHTML = `<div class="page-error">Page ${num} failed to render</div>`;
  }
}

function diag(msg) {
  if (TAURI) TAURI.core.invoke('diag', { msg: String(msg) }).catch(() => {});
}

async function pdfToc(doc) {
  const items = [];
  async function walk(entries, level) {
    for (const e of entries || []) {
      try {
        let dest = e.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          const idx = await doc.getPageIndex(dest[0]);
          items.push({ label: e.title || 'Untitled', level, page: idx + 1 });
        }
      } catch (_) {}
      if (e.items && level < 3) await walk(e.items, level + 1);
    }
  }
  try {
    await walk(await doc.getOutline(), 1);
  } catch (err) { diag('pdfToc getOutline error: ' + err); }
  diag('pdfToc: outline items=' + items.length + ' pages=' + doc.numPages);
  if (items.length) return items;
  // no embedded outline — detect headings from the text itself
  let detected = [];
  try {
    detected = await pdfHeadingToc(doc);
  } catch (err) { diag('pdfHeadingToc top-level error: ' + (err && err.stack || err)); }
  diag('pdfToc: detected=' + detected.length + ' first=' + (detected[0] && detected[0].label));
  if (detected.length >= 2) return detected;
  if (doc.numPages < 2) return [];
  return Array.from({ length: doc.numPages }, (_, i) => ({ label: 'Page ' + (i + 1), level: 1, page: i + 1 }));
}

/* Heuristic outline for PDFs without bookmarks: per page, group text
   into lines and treat the noticeably-larger lines as headings. */
async function pdfHeadingToc(doc) {
  const items = [];
  const maxPages = Math.min(doc.numPages, 150);
  let prev = '';
  for (let p = 1; p <= maxPages; p++) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const lines = new Map(); // y → {size, text[]}
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const size = Math.hypot(it.transform[2], it.transform[3]);
        const y = Math.round(it.transform[5] / 2) * 2;
        const l = lines.get(y) || { size: 0, text: [] };
        l.size = Math.max(l.size, size);
        l.text.push(it.str);
        lines.set(y, l);
      }
      if (!lines.size) continue;
      const sizes = [...lines.values()].map(l => l.size).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)];
      const cands = [...lines.entries()]
        .filter(([, l]) => l.size >= Math.max(median * 1.25, 9) && lines.size > 1)
        .sort((a, b) => b[0] - a[0]) // PDF y-axis points up → top of page first
        .slice(0, 2);
      let first = true;
      for (const [, l] of cands) {
        const label = l.text.join(' ').replace(/\s+/g, ' ').trim().slice(0, 90);
        if (label.length < 3 || label === prev) continue;
        prev = label;
        items.push({ label, level: first ? 1 : 2, page: p });
        first = false;
      }
    } catch (err) { if (p <= 3) diag('pdfHeadingToc page ' + p + ': name=' + (err && err.name) + ' msg=' + (err && err.message) + ' :: ' + (err && err.stack || '')); }
  }
  return items;
}

/* ---------- PPTX rendering (JSZip + own parser) ---------- */

const EMU_PER_PX = 9525;

function xfind(el, name) { return el.getElementsByTagNameNS('*', name); }

async function buildPptxPages(t) {
  const zip = await JSZip.loadAsync(t.bytes.slice(0));
  const parse = async (path) => {
    const f = zip.file(path.replace(/^\//, ''));
    if (!f) return null;
    return new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  };

  const pres = await parse('ppt/presentation.xml');
  const sldSz = xfind(pres, 'sldSz')[0];
  const cx = +sldSz.getAttribute('cx'), cy = +sldSz.getAttribute('cy');
  const naturalW = cx / EMU_PER_PX; // px at 100%

  const presRels = await parse('ppt/_rels/presentation.xml.rels');
  const relMap = {};
  for (const r of xfind(presRels, 'Relationship')) relMap[r.getAttribute('Id')] = r.getAttribute('Target');
  const slidePaths = [...xfind(pres, 'sldId')].map(s => {
    const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let target = relMap[rid] || '';
    return target.startsWith('/') ? target.slice(1) : 'ppt/' + target;
  }).filter(p => p.includes('slide'));

  t.pagesEl = document.createElement('div');
  t.pagesEl.className = 'doc-pages';
  t._urls = [];
  t._tocItems = [];

  for (let s = 0; s < slidePaths.length; s++) {
    const { el, title } = await renderPptxSlide(zip, parse, slidePaths[s], cx, cy, naturalW, t._urls);
    el.dataset.page = s + 1;
    t.pagesEl.appendChild(el);
    t._tocItems.push({ label: title || 'Slide ' + (s + 1), level: 1, page: s + 1 });
  }
}

async function renderPptxSlide(zip, parse, path, cx, cy, naturalW, urls) {
  const doc = await parse(path);
  const slide = document.createElement('div');
  slide.className = 'doc-page pptx-slide';
  slide.style.aspectRatio = `${cx} / ${cy}`;

  if (!doc) return { el: slide, title: '' };

  // slide-level image relationships
  const relDoc = await parse(path.replace(/slides\//, 'slides/_rels/') + '.rels');
  const rels = {};
  if (relDoc) for (const r of xfind(relDoc, 'Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');

  // slide background (solid fill only)
  const bg = xfind(doc, 'bg')[0];
  if (bg) {
    const clr = xfind(bg, 'srgbClr')[0];
    if (clr) slide.style.background = '#' + clr.getAttribute('val');
  }

  let title = '';
  const spTree = xfind(doc, 'spTree')[0];
  if (!spTree) return { el: slide, title };

  const pct = (v, total) => (v / total * 100).toFixed(3) + '%';
  const getXfrm = (shape) => {
    const xfrm = xfind(shape, 'xfrm')[0];
    if (!xfrm) return null;
    const off = xfind(xfrm, 'off')[0], ext = xfind(xfrm, 'ext')[0];
    if (!off || !ext) return null;
    return { x: +off.getAttribute('x'), y: +off.getAttribute('y'), w: +ext.getAttribute('cx'), h: +ext.getAttribute('cy') };
  };

  for (const shape of spTree.children) {
    const tag = shape.localName;

    if (tag === 'sp') {
      const box = document.createElement('div');
      box.className = 'pptx-text';
      const xf = getXfrm(shape);
      if (xf) {
        box.style.left = pct(xf.x, cx); box.style.top = pct(xf.y, cy);
        box.style.width = pct(xf.w, cx); box.style.minHeight = pct(xf.h, cy);
      } else {
        box.classList.add('flow');
      }
      const isTitle = !![...xfind(shape, 'ph')].find(p => /title/i.test(p.getAttribute('type') || ''));
      let boxText = '';
      for (const p of xfind(shape, 'p')) {
        const para = document.createElement('div');
        para.className = 'pptx-para';
        for (const r of xfind(p, 'r')) {
          const tEl = xfind(r, 't')[0];
          if (!tEl) continue;
          const span = document.createElement('span');
          span.textContent = tEl.textContent;
          boxText += tEl.textContent + ' ';
          const rPr = xfind(r, 'rPr')[0];
          const szAttr = rPr && rPr.getAttribute('sz');
          const sz = szAttr ? +szAttr : (isTitle ? 3200 : 1800);
          // sz is hundredths of a point → px at natural size → cqw (responsive)
          const px = sz / 100 * 96 / 72;
          span.style.fontSize = (px / naturalW * 100).toFixed(3) + 'cqw';
          if (rPr && rPr.getAttribute('b') === '1') span.style.fontWeight = '700';
          if (rPr && rPr.getAttribute('i') === '1') span.style.fontStyle = 'italic';
          const clr = rPr && xfind(rPr, 'srgbClr')[0];
          if (clr) span.style.color = '#' + clr.getAttribute('val');
          para.appendChild(span);
        }
        if (para.childNodes.length) box.appendChild(para);
      }
      if (isTitle && !title) title = boxText.trim();
      if (box.childNodes.length) slide.appendChild(box);
    }

    if (tag === 'pic') {
      const blip = xfind(shape, 'blip')[0];
      if (!blip) continue;
      const rid = blip.getAttribute('r:embed') || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      let target = rels[rid];
      if (!target) continue;
      target = target.startsWith('/') ? target.slice(1) : 'ppt/' + target.replace(/^(\.\.\/)+/, '');
      const f = zip.file(target);
      if (!f) continue;
      const blob = await f.async('blob');
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = document.createElement('img');
      img.src = url;
      img.className = 'pptx-img';
      const xf = getXfrm(shape);
      if (xf) {
        img.style.left = pct(xf.x, cx); img.style.top = pct(xf.y, cy);
        img.style.width = pct(xf.w, cx); img.style.height = pct(xf.h, cy);
      }
      slide.appendChild(img);
    }
  }
  return { el: slide, title };
}

/* ---------- Opening files ---------- */

async function loadTauriContent(kind, path) {
  if (TEXT_KINDS.includes(kind) || kind === 'html' || kind === 'canvas') {
    const f = await TAURI.core.invoke('read_md_file', { path });
    return { text: f.text, mtime: f.mtime };
  }
  const mtime = await TAURI.core.invoke('stat_md_file', { path });
  const bytes = await TAURI.core.invoke('read_file_bytes', { path });
  return { bytes, mtime };
}

async function makeTab(base, kind, { text, bytes }) {
  const tab = { ...base, kind, live: kind !== 'unsupported' };
  if (PAGED_KINDS.includes(kind)) {
    tab.bytes = bytes;
  } else if (kind === 'canvas') {
    tab.scene = parseScene(text);             // Excalidraw JSON; blank if unreadable
  } else if (kind === 'html') {
    tab.rawHtml = text;                       // rendered in a sandboxed frame
    tab.html = DOMPurify.sanitize(text);      // for TOC / mind map / export
  } else if (kind !== 'unsupported') {
    tab.html = await buildHtml(kind, { text, bytes });
    if (TEXT_KINDS.includes(kind)) { tab.text = text; tab.fm = splitFm(text).fm; }
  }
  return tab;
}

/* Android's document picker returns an opaque content:// URI — no filename,
   no extension. Read the bytes through the fs plugin (which resolves Android
   content URIs), detect the format from magic bytes, and derive a readable
   name from the content itself. */
async function readContentUri(uri) {
  const raw = await TAURI.core.invoke('plugin:fs|read_file', { path: uri });
  const bytes = raw instanceof Uint8Array ? raw
    : raw instanceof ArrayBuffer ? new Uint8Array(raw)
    : new Uint8Array(raw);
  const kind = await sniffKind(bytes);
  const text = (TEXT_KINDS.includes(kind) || kind === 'html') ? new TextDecoder('utf-8').decode(bytes) : null;
  return { kind, bytes, text, name: deriveName(kind, text) };
}

async function sniffKind(b) {
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf'; // %PDF
  if (b.length >= 2 && b[0] === 0x50 && b[1] === 0x4B) {   // PK — OOXML zip
    try {
      const names = Object.keys((await JSZip.loadAsync(b.slice(0))).files);
      if (names.some(n => n.startsWith('word/'))) return 'docx';
      if (names.some(n => n.startsWith('ppt/'))) return 'pptx';
      if (names.some(n => n.startsWith('xl/'))) return 'sheet';
    } catch (_) {}
    return 'unsupported';
  }
  const head = new TextDecoder('utf-8').decode(b.slice(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'html';
  return 'md'; // default: render text as markdown
}

function deriveName(kind, text) {
  if (kind === 'html' && text) {
    const m = text.match(/<title[^>]*>([^<]+)<\/title>/i) || text.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (m) return m[1].trim().slice(0, 60) + '.html';
    return 'Page.html';
  }
  if (TEXT_KINDS.includes(kind) && text) {
    const m = text.match(/^\s*#{1,6}\s+(.+)$/m) || text.match(/^\s*(\S.+)$/m);
    if (m) return m[1].trim().replace(/[#*`_]/g, '').slice(0, 60) + '.md';
  }
  return { pdf: 'Document.pdf', docx: 'Document.docx', pptx: 'Presentation.pptx', sheet: 'Spreadsheet.xlsx' }[kind] || 'Document';
}

const _opening = new Set(); // guard against double-fire (touch + click, dialog double-resolve)

async function openTauriPath(path) {
  const existing = tabs.find(t => t.path === path);
  if (existing) { switchTab(existing.id); return; }
  if (_opening.has(path)) return;
  _opening.add(path);
  try {
    // Android content/file URIs: read via fs plugin + content sniffing
    if (path.startsWith('content://') || path.startsWith('file://')) {
      const { kind, bytes, text, name } = await readContentUri(path);
      const tab = await makeTab({ name, path, mtime: 0 }, kind, { text, bytes });
      tab.live = false; // content URIs aren't watchable for live-reload
      addTab(tab);
      return;
    }
    const name = path.split('/').pop();
    const kind = kindOf(name);
    const loaded = kind === 'unsupported' ? { mtime: 0 } : await loadTauriContent(kind, path);
    const tab = await makeTab({ name, path, mtime: loaded.mtime }, kind, loaded);
    addTab(tab);
    const pos = savedPosition(path);
    if (pos) restoreScrollWhenReady(tab, pos);
  } catch (err) {
    console.error('Failed to open', path, err);
    diag('openTauriPath error: ' + (err && err.message || err));
  } finally {
    _opening.delete(path);
  }
}

async function openBrowserFile(file, handle) {
  const kind = kindOf(file.name);
  const loaded = (TEXT_KINDS.includes(kind) || kind === 'html' || kind === 'canvas')
    ? { text: await file.text() }
    : kind === 'unsupported' ? {} : { bytes: await file.arrayBuffer() };
  const tab = await makeTab({ name: file.name, handle, mtime: file.lastModified }, kind, loaded);
  tab.live = !!handle && kind !== 'unsupported';
  addTab(tab);
}

async function openViaPicker() {
  if (TAURI) {
    const picked = await TAURI.core.invoke('plugin:dialog|open', {
      options: {
        filters: [
          { name: 'All supported', extensions: ['md', 'markdown', 'mdown', 'pdf', 'docx', 'pptx', 'xlsx', 'xls', 'csv', 'txt', 'log', 'json', 'html', 'htm', 'excalidraw', 'canvas'] },
          { name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] },
        ],
        multiple: false,
        directory: false,
      },
    });
    diag('picker returned: ' + JSON.stringify(picked));
    if (picked) openTauriPath(typeof picked === 'string' ? picked : picked.path);
    return;
  }
  if (window.showOpenFilePicker) {
    let handle;
    try { [handle] = await window.showOpenFilePicker(); } catch (_) { return; }
    openBrowserFile(await handle.getFile(), handle);
  } else {
    $('file-input').click();
  }
}

/* ---------- Live reload ---------- */

async function refreshTab(t, loaded) {
  disposeTab(t);
  t._doc = t._observer = t.pagesEl = t._tocItems = null;
  t._urls = [];
  const fresh = await makeTab({ name: t.name, path: t.path, handle: t.handle, mtime: t.mtime }, t.kind, loaded);
  t.html = fresh.html;
  t.bytes = fresh.bytes;
  t.scrollTop = scrollerEl.scrollTop;
  if (t.id === activeId) renderActive();
}

setInterval(async () => {
  const t = activeTab();
  if (!t || !t.live || t.editing) return;
  try {
    if (TAURI && t.path) {
      const mtime = await TAURI.core.invoke('stat_md_file', { path: t.path });
      if (mtime === t.mtime) return;
      t.mtime = mtime;
      await refreshTab(t, await loadTauriContent(t.kind, t.path));
    } else if (t.handle) {
      const file = await t.handle.getFile();
      if (file.lastModified === t.mtime) return;
      t.mtime = file.lastModified;
      await refreshTab(t, TEXT_KINDS.includes(t.kind)
        ? { text: await file.text() } : { bytes: await file.arrayBuffer() });
    }
  } catch (_) { /* file moved/deleted; keep last render */ }
}, 1000);

/* ---------- Find in document ---------- */

const findState = { query: '', ranges: [], pdfMatches: [], current: -1 };

function openFind() {
  const t = activeTab();
  if (!t) return;
  // scanned/image-only PDFs have no text layer — say so instead of finding nothing
  if (t.kind === 'pdf' && t._textLayerFailed && !t._tlWarned) {
    t._tlWarned = true;
    toast('This PDF has no selectable text — search may find nothing');
  }
  $('findbar').hidden = false;
  updateReplaceRow();
  $('find-input').focus();
  $('find-input').select();
}

function closeFind() {
  $('findbar').hidden = true;
  clearFindHighlights();
  findState.query = '';
  findState.ranges = [];
  findState.pdfMatches = [];
  findState.current = -1;
  findState.frame = null;
}

function findWindow() {
  // html documents live in a sandboxed frame with their own highlight registry
  return findState.frame && findState.frame.contentWindow ? findState.frame.contentWindow : window;
}

function clearFindHighlights() {
  const W = findWindow();
  if (W.CSS && W.CSS.highlights) {
    W.CSS.highlights.delete('mv-find');
    W.CSS.highlights.delete('mv-find-cur');
  }
}

function updateFindCount() {
  const n = findState.ranges.length || findState.pdfMatches.length;
  $('find-count').textContent = n ? `${findState.current + 1}/${n}` : (findState.query ? '0' : '');
}

async function runFind(q) {
  clearFindHighlights();
  findState.query = q;
  findState.ranges = [];
  findState.pdfMatches = [];
  findState.current = -1;
  const t = activeTab();
  if (!t || !q || q.length < 2) { updateFindCount(); return; }

  if (t.kind === 'pdf') {
    // search the cached full text of every page; navigate page-by-page
    if (!t._pageTexts) {
      t._pageTexts = [];
      for (let p = 1; p <= t._doc.numPages; p++) {
        try {
          const tc = await (await t._doc.getPage(p)).getTextContent();
          t._pageTexts[p] = tc.items.map(i => i.str).join(' ').toLowerCase();
        } catch (_) { t._pageTexts[p] = ''; }
      }
    }
    if (findState.query !== q) return; // stale (user kept typing)
    const lq = q.toLowerCase();
    t._pageTexts.forEach((txt, p) => {
      let i = 0;
      while (txt && (i = txt.indexOf(lq, i)) !== -1) { findState.pdfMatches.push({ page: p }); i += lq.length; }
    });
    if (findState.pdfMatches.length) gotoMatch(1); else updateFindCount();
    return;
  }

  // interactive HTML frames are cross-origin/opaque — search needs Reader mode
  if (t.kind === 'html' && effectiveHtmlMode(t) === 'live') {
    $('find-count').textContent = 'Reader mode only';
    return;
  }

  // DOM-based kinds (md/docx/sheet/text/pptx/html): real ranges + highlights
  findState.frame = (t.kind === 'html') ? t._frame : null;
  const root = t.kind === 'html' ? (t._frame && t._frame.contentDocument && t._frame.contentDocument.body)
    : PAGED_KINDS.includes(t.kind) ? t.pagesEl : contentEl;
  if (!root) { updateFindCount(); return; }
  const rootDoc = root.ownerDocument;
  const lq = q.toLowerCase();
  const walker = rootDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.data.toLowerCase();
    let i = 0;
    while ((i = text.indexOf(lq, i)) !== -1) {
      const r = rootDoc.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      findState.ranges.push(r);
      i += q.length;
    }
  }
  const W = findWindow();
  if (W.CSS && W.CSS.highlights && findState.ranges.length) {
    W.CSS.highlights.set('mv-find', new W.Highlight(...findState.ranges));
  }
  if (findState.ranges.length) gotoMatch(1); else updateFindCount();
}

function gotoMatch(dir) {
  const n = findState.ranges.length || findState.pdfMatches.length;
  if (!n) return;
  findState.current = ((findState.current + dir) % n + n) % n;
  if (findState.ranges.length) {
    const r = findState.ranges[findState.current];
    const W = findWindow();
    if (W.CSS && W.CSS.highlights) W.CSS.highlights.set('mv-find-cur', new W.Highlight(r));
    let top = r.getBoundingClientRect().top;
    if (findState.frame) top += findState.frame.getBoundingClientRect().top; // frame → app coords
    const srect = scrollerEl.getBoundingClientRect();
    scrollerEl.scrollTop += top - srect.top - srect.height * 0.35;
  } else {
    const m = findState.pdfMatches[findState.current];
    const t = activeTab();
    const el = t.pagesEl && t.pagesEl.querySelector(`.doc-page[data-page="${m.page}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
  }
  updateFindCount();
}

function wireFind() {
  let debounce;
  $('find-input').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runFind(e.target.value), 220);
  });
  $('find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('find-next').addEventListener('click', () => gotoMatch(1));
  $('find-prev').addEventListener('click', () => gotoMatch(-1));
  $('find-close').addEventListener('click', closeFind);
}

/* ---------- Zoom (paged documents) ---------- */

function applyZoom(t) {
  const paged = t && PAGED_KINDS.includes(t.kind);
  $('zoom-pill').hidden = !paged;
  if (!paged) { pagesHostEl.style.maxWidth = ''; return; }
  const z = t.zoom || 1;
  $('zoom-label').textContent = Math.round(z * 100) + '%';
  const base = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--reader-width')) || 820;
  pagesHostEl.style.maxWidth = z === 1 ? '' : Math.round(base * z) + 'px';
}

function zoomPaged(delta) {
  const t = activeTab();
  if (!t || !PAGED_KINDS.includes(t.kind)) return;
  t.zoom = delta === 0 ? 1 : Math.min(3, Math.max(0.5, +((t.zoom || 1) + delta).toFixed(2)));
  applyZoom(t);
  if (t.kind === 'pdf' && t.pagesEl) {
    // re-render at the new width for crisp text
    t.pagesEl.querySelectorAll('.pdf-page').forEach(h => { delete h.dataset.rendered; h.replaceChildren(); });
    renderVisiblePages(t);
  }
}

function wireZoom() {
  $('zoom-in-btn').addEventListener('click', () => zoomPaged(0.15));
  $('zoom-out-btn').addEventListener('click', () => zoomPaged(-0.15));
  $('zoom-label').addEventListener('click', () => zoomPaged(0));
}

/* ---------- Edit mode (⌘E) ---------- */

let cm = null, cmSilent = false, previewTimer = null, saveTimer = null;

function isEditable(t) {
  return !!(t && TEXT_KINDS.includes(t.kind) && (t.path || (t.handle && t.handle.createWritable) || t.scratch));
}

// Save an in-memory (scratch) text doc to a real file, then it autosaves normally.
async function saveDocAs(t) {
  const json = t.text || '';
  const suggested = (t.name || 'Document').replace(/\.[^.]*$/, '') + '.md';
  if (TAURI) {
    try {
      const path = await TAURI.core.invoke('plugin:dialog|save', { options: { defaultPath: suggested } });
      if (!path) return false;
      t.mtime = await TAURI.core.invoke('write_file', { path, contents: json });
      t.path = path; t.name = path.split('/').pop(); t.scratch = false;
      setDirty(t, false); renderTabStrip(); recordRecent(t.name, t.path); saveSession();
      return true;
    } catch (err) { console.error(err); toast('Save failed'); return false; }
  }
  await saveTextAs(json, suggested);   // browser fallback: download
  return true;
}

// Convert a PDF / Word / HTML document into an editable Markdown copy.
async function editAsMarkdown() {
  const t = activeTab();
  if (!t || !['pdf', 'docx', 'html'].includes(t.kind)) { toast('Open a PDF, Word or HTML document'); return; }
  toast('Converting to Markdown…');
  let mdText;
  try {
    mdText = t.kind === 'pdf' ? await pdfToMarkdown(t) : htmlToMarkdown(t.html || '');
  } catch (err) { console.error(err); toast('Conversion failed'); return; }
  if (!mdText || !mdText.trim()) { toast('No editable text found in this document'); return; }
  const tab = await makeTab({ name: stem(t.name) + '.md', mtime: 0 }, 'md', { text: mdText });
  tab.scratch = true;          // in-memory until the user saves a copy
  tab.editing = true; tab.editSurface = 'rich';
  addTab(tab);
  historyReset(); setTimeout(historySnapshot, 80);
  toast('Editable Markdown copy — ⌘S to save it as a file');
}

async function toggleEdit() {
  const t = activeTab();
  if (!isEditable(t)) return;
  if (t.editing) {
    // leaving edit mode: capture pending rich edits, re-render canonical
    if ((t.editSurface || 'rich') === 'rich') t.text = richToMarkdown(t);
    t.editing = false;
    t.html = await buildHtml(t.kind, { text: t.text });
    saveEditor(t);
  } else {
    t.editing = true;
    t.editSurface = t.editSurface || 'rich'; // edit the text, not the syntax
    historyReset();
    setTimeout(historySnapshot, 80); // baseline for undo
  }
  renderActive();
}

async function setEditSurface(surface) {
  const t = activeTab();
  if (!t || !t.editing) return;
  if (t.editSurface === surface) return;
  if (t.editSurface !== 'source') t.text = richToMarkdown(t); // capture rich edits
  t.editSurface = surface;
  t.html = await buildHtml(t.kind, { text: t.text });
  if (surface === 'rich') { historyReset(); setTimeout(historySnapshot, 80); }
  renderActive();
}

/* Rich (WYSIWYG-style) editing: the rendered view itself becomes editable;
   on save the DOM is converted back to markdown. Diagram/math blocks are
   atomic (contenteditable=false) and restored from their original source. */
function applyRichState(t) {
  const rich = !!(t && t.editing && (t.editSurface || 'rich') === 'rich' && TEXT_KINDS.includes(t.kind));
  contentEl.contentEditable = rich ? 'true' : 'false';
  document.body.classList.toggle('rich-editing', rich);
  layoutEditorChrome(rich);
  if (!rich) { closeLinkPop(); closeSlashMenu(); $('sel-bubble').hidden = true; $('table-tools').hidden = true; $('block-handle').hidden = true; }
  updateReplaceRow();
  if (rich) renderCallouts();
  const pill = $('edit-pill');
  pill.hidden = !(t && t.editing && TEXT_KINDS.includes(t.kind));
  if (!pill.hidden) {
    $('pill-rich').classList.toggle('sel', (t.editSurface || 'rich') === 'rich');
    $('pill-source').classList.toggle('sel', t.editSurface === 'source');
  }
  if (rich) {
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}
    contentEl.querySelectorAll('.mermaid, .katex-display, .katex').forEach(el =>
      el.setAttribute('contenteditable', 'false'));
    contentEl.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.disabled = false; });
  }
}

function isRichEditing() {
  const t = activeTab();
  return !!(t && t.editing && (t.editSurface || 'rich') === 'rich' && TEXT_KINDS.includes(t.kind));
}

function richToMarkdown(t) {
  if (t.kind === 'text') return contentEl.innerText.replace(/\n+$/, '\n');
  const clone = contentEl.cloneNode(true);
  clone.querySelectorAll('.drop-indicator').forEach(el => el.remove());
  serializeCallouts(clone);
  clone.querySelectorAll('img[data-orig-src]').forEach(i => i.setAttribute('src', i.getAttribute('data-orig-src')));
  clone.querySelectorAll('.mermaid').forEach(d => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = d.dataset.src || '';
    pre.appendChild(code);
    d.replaceWith(pre);
  });
  clone.querySelectorAll('.katex-display').forEach(k => {
    const ann = k.querySelector('annotation[encoding="application/x-tex"]');
    k.replaceWith(document.createTextNode('\n$$' + (ann ? ann.textContent : '') + '$$\n'));
  });
  clone.querySelectorAll('.katex').forEach(k => {
    const ann = k.querySelector('annotation[encoding="application/x-tex"]');
    k.replaceWith(document.createTextNode('$' + (ann ? ann.textContent : '') + '$'));
  });
  clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
  // (wikilinks are restored by a turndown rule in htmlToMarkdown — a text node
  //  here would get its brackets escaped to \[\[…\]\])
  // frontmatter lives outside the editable body — re-attach it verbatim so a
  // rich-edit round-trip can never drop the page's properties
  return (t.fm || '') + htmlToMarkdown(clone.innerHTML);
}

/* ---------- Editor history (undo/redo) ----------
   Native contenteditable undo can't survive programmatic DOM commands,
   so we own history: innerHTML snapshots + node-path selection bookmarks. */

const editHistory = { stack: [], idx: -1, max: 200, silent: false };

function nodePath(node) {
  const p = [];
  while (node && node !== contentEl) {
    const parent = node.parentNode;
    if (!parent) return null;
    p.unshift([...parent.childNodes].indexOf(node));
    node = parent;
  }
  return node === contentEl ? p : null;
}

function nodeFromPath(p) {
  let n = contentEl;
  for (const i of p) { n = n.childNodes[i]; if (!n) return null; }
  return n;
}

function saveSelection() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0);
  if (!contentEl.contains(r.startContainer)) return null;
  const sp = nodePath(r.startContainer), ep = nodePath(r.endContainer);
  if (!sp || !ep) return null;
  return { sp, so: r.startOffset, ep, eo: r.endOffset };
}

function restoreSelection(sel) {
  if (!sel) return;
  const sn = nodeFromPath(sel.sp), en = nodeFromPath(sel.ep);
  if (!sn || !en) return;
  try {
    const lim = n => n.nodeType === 3 ? n.length : n.childNodes.length;
    const r = document.createRange();
    r.setStart(sn, Math.min(sel.so, lim(sn)));
    r.setEnd(en, Math.min(sel.eo, lim(en)));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  } catch (_) {}
}

function historyReset() {
  editHistory.stack = [];
  editHistory.idx = -1;
}

function historySnapshot() {
  if (editHistory.silent || !isRichEditing()) return;
  const html = contentEl.innerHTML;
  if (editHistory.idx >= 0 && editHistory.stack[editHistory.idx].html === html) return;
  editHistory.stack.length = editHistory.idx + 1; // drop redo tail
  editHistory.stack.push({ html, sel: saveSelection() });
  if (editHistory.stack.length > editHistory.max) editHistory.stack.shift();
  editHistory.idx = editHistory.stack.length - 1;
}

function applyHistoryEntry() {
  const s = editHistory.stack[editHistory.idx];
  if (!s) return;
  editHistory.silent = true;
  contentEl.innerHTML = s.html;
  applyRichState(activeTab());
  restoreSelection(s.sel);
  editHistory.silent = false;
  onRichInput(); // mark dirty + schedule save from restored state
}

function editUndo() { if (editHistory.idx > 0) { historySnapshot(); editHistory.idx--; applyHistoryEntry(); } }
function editRedo() { if (editHistory.idx < editHistory.stack.length - 1) { editHistory.idx++; applyHistoryEntry(); } }

/* ---------- Editor commands ---------- */

function selElement() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const n = s.getRangeAt(0).commonAncestorContainer;
  const el = n.nodeType === 1 ? n : n.parentElement;
  return el && contentEl.contains(el) ? el : null;
}

function currentBlock() {
  let el = selElement();
  while (el && el.parentElement !== contentEl) el = el.parentElement;
  return el;
}

function placeCaret(el, atStart) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(!!atStart);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function insertBlockAfterCurrent(el) {
  const blk = currentBlock();
  if (blk) blk.after(el); else contentEl.appendChild(el);
  const p = document.createElement('p');
  p.innerHTML = '<br>';
  el.after(p);
  placeCaret(p, true);
}

function toggleInlineCode() {
  const el = selElement();
  const codeAnc = el && el.closest('code');
  if (codeAnc && contentEl.contains(codeAnc) && !codeAnc.closest('pre')) {
    const parent = codeAnc.parentNode;
    while (codeAnc.firstChild) parent.insertBefore(codeAnc.firstChild, codeAnc);
    parent.removeChild(codeAnc);
    return;
  }
  const s = getSelection();
  if (!s.rangeCount || s.getRangeAt(0).collapsed) return;
  const r = s.getRangeAt(0);
  const code = document.createElement('code');
  try { r.surroundContents(code); }
  catch (_) { code.appendChild(r.extractContents()); r.insertNode(code); }
}

function toggleTask() {
  let el = selElement();
  let li = el && el.closest('li');
  if (!li) { document.execCommand('insertUnorderedList'); el = selElement(); li = el && el.closest('li'); }
  if (!li || !contentEl.contains(li)) return;
  const existing = li.querySelector(':scope > input[type="checkbox"]');
  if (existing) {
    existing.remove();
    li.classList.remove('task-list-item');
  } else {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    li.classList.add('task-list-item');
    li.prepend(cb, ' ');
    const list = li.closest('ul, ol');
    if (list) list.classList.add('contains-task-list');
  }
}

function insertTable() {
  const tbl = document.createElement('table');
  tbl.innerHTML = '<thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead>'
    + '<tbody>' + '<tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>'.repeat(2) + '</tbody>';
  insertBlockAfterCurrent(tbl);
  placeCaret(tbl.querySelector('td'), true);
}

async function insertImage() {
  const t = activeTab();
  if (!TAURI || !t || !t.path) return;
  const picked = await TAURI.core.invoke('plugin:dialog|open', {
    options: { filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }], multiple: false, directory: false },
  });
  if (!picked) return;
  const abs = typeof picked === 'string' ? picked : picked.path;
  const dir = t.path.slice(0, t.path.lastIndexOf('/') + 1);
  const rel = abs.startsWith(dir) ? abs.slice(dir.length) : abs;
  const img = document.createElement('img');
  img.setAttribute('data-orig-src', rel);
  img.src = TAURI.core.convertFileSrc(abs);
  img.alt = rel.split('/').pop();
  const p = document.createElement('p');
  p.appendChild(img);
  insertBlockAfterCurrent(p);
}

function insertMathBlock() {
  const p = document.createElement('p');
  p.textContent = '$$ E = mc^2 $$';
  insertBlockAfterCurrent(p);
  placeCaret(p, false);
}

function insertMermaidBlock() {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = 'flowchart LR\n  A[Start] --> B[Finish]';
  pre.appendChild(code);
  insertBlockAfterCurrent(pre);
}

function setBlockType(v) {
  // formatBlock is still the most reliable cross-webview block transform
  document.execCommand('formatBlock', false, v === 'p' ? 'p' : v);
}

/* ---------- Link popover ---------- */

let linkSavedSel = null;

function openLinkPop() {
  if (!isRichEditing()) return;
  const s = getSelection();
  if (!s.rangeCount) return;
  linkSavedSel = saveSelection();
  const el = selElement();
  const a = el && el.closest('a');
  $('link-input').value = a ? a.getAttribute('href') : '';
  const rect = s.getRangeAt(0).getBoundingClientRect();
  const mainRect = $('main').getBoundingClientRect();
  const pop = $('link-pop');
  pop.hidden = false;
  pop.style.left = Math.max(8, Math.min(rect.left - mainRect.left, mainRect.width - 320)) + 'px';
  pop.style.top = (rect.bottom - mainRect.top + 8) + 'px';
  $('link-input').focus();
}

function closeLinkPop() { $('link-pop').hidden = true; linkSavedSel = null; }

function applyLink() {
  const url = $('link-input').value.trim();
  restoreSelection(linkSavedSel);
  execEditorCmd(() => {
    if (!url) { document.execCommand('unlink'); return; }
    const el = selElement();
    const a = el && el.closest('a');
    if (a && contentEl.contains(a)) a.setAttribute('href', url);
    else document.execCommand('createLink', false, url);
  });
  closeLinkPop();
}

/* ---------- Icon set (design stroke family) ---------- */

const ICON_PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  swap: '<path d="M7 4l-3 3 3 3M4 7h13M17 20l3-3-3-3M20 17H7"/>',
  pencil: '<path d="M4 20h4L18 8l-4-4L4 16z"/>',
  map: '<circle cx="12" cy="12" r="3"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>',
  export: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  theme: '<circle cx="12" cy="12" r="4.2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2"/>',
  ai: '<path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/>',
  find: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  present: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  canvas: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
};
function svgIcon(name, filled) {
  return `<svg viewBox="0 0 24 24">${ICON_PATHS[name] || ''}</svg>`.replace('<svg ', filled ? '<svg data-filled ' : '<svg ');
}

/* ---------- Annotations: highlights + margin notes (reflowable docs) ----------
   Stored in the library sidecar keyed by file path (never in the document),
   anchored by character offsets into the rendered text so they survive reopen.
   Applies to md / docx / text / html reader views. */

const HL_COLORS = { yellow: '#ffd43b', green: '#8ce99a', blue: '#74c0fc', pink: '#faa2c1', orange: '#ffc078' };
const ANNOTATABLE = ['md', 'docx', 'text', 'html'];
function canAnnotate(t) { return t && t.path && ANNOTATABLE.includes(t.kind) && t.kind !== 'unsupported'; }
function annsFor(path) { return (library.annotations && library.annotations[path]) || []; }
function setAnns(path, list) {
  library.annotations ||= {};
  if (list.length) library.annotations[path] = list; else delete library.annotations[path];
  saveLibrary();
}

// char offset of a (node, offset) point within root's text — robust to the
// point sitting on an element node (child index) as well as a text node.
function pointOffset(root, node, off) {
  const r = document.createRange();
  r.setStart(root, 0);
  try { r.setEnd(node, off); } catch (_) { return 0; }
  return r.toString().length;
}
function rangeToOffsets(root, range) {
  return { start: pointOffset(root, range.startContainer, range.startOffset), end: pointOffset(root, range.endContainer, range.endOffset) };
}
// build a DOM Range for a [start,end) char span within root
function offsetsToRange(root, start, end) {
  const r = document.createRange();
  let n = 0, set = false;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cur;
  while ((cur = w.nextNode())) {
    const len = cur.data.length;
    if (!set && start <= n + len) { r.setStart(cur, Math.max(0, start - n)); set = true; }
    if (set && end <= n + len) { r.setEnd(cur, Math.max(0, end - n)); return r; }
    n += len;
  }
  return set ? r : null;
}
// wrap every text segment of `range` in its own <mark> (handles multi-element spans)
function wrapRange(range, cls, ds) {
  const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode;
  const nodes = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n; while ((n = w.nextNode())) { if (range.intersectsNode(n)) nodes.push(n); }
  const marks = [];
  for (const node of nodes) {
    const seg = document.createRange();
    seg.selectNodeContents(node);
    if (node === range.startContainer) seg.setStart(node, range.startOffset);
    if (node === range.endContainer) seg.setEnd(node, range.endOffset);
    if (seg.collapsed) continue;
    const m = document.createElement('mark');
    m.className = cls;
    Object.assign(m.dataset, ds);
    try { seg.surroundContents(m); marks.push(m); } catch (_) {}
  }
  return marks;
}

function applyAnnotations(t) {
  if (!canAnnotate(t)) return;
  for (const a of annsFor(t.path)) {
    const range = offsetsToRange(contentEl, a.start, a.end);
    if (!range) continue;
    const marks = wrapRange(range, 'sutra-hl' + (a.note ? ' has-note' : ''), { hlId: a.id });
    marks.forEach(m => { m.style.setProperty('--hlc', HL_COLORS[a.color] || HL_COLORS.yellow); });
  }
}

let _hlSel = null;   // pending selection range while the popover is open
let _hlEdit = null;  // id of the highlight being edited

function readSelectionRange() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return null;
  const r = s.getRangeAt(0);
  if (!contentEl.contains(r.commonAncestorContainer)) return null;
  if (!r.toString().trim()) return null;
  return r;
}

// show the highlight popover above a rect (selection or an existing mark)
function showHlPop(rect, mode) {
  const pop = $('hl-pop');
  pop.dataset.mode = mode;                 // 'create' | 'edit'
  pop.hidden = false;
  const mr = $('main').getBoundingClientRect();
  const pw = pop.offsetWidth || 210, ph = pop.offsetHeight || 40;
  let left = rect.left + rect.width / 2 - mr.left - pw / 2;
  left = Math.max(8, Math.min(left, mr.width - pw - 8));
  let top = rect.top - mr.top - ph - 8;
  if (top < 6) top = rect.bottom - mr.top + 8;   // flip below if no room above
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}
function hideHlPop() { $('hl-pop').hidden = true; $('hl-note-pop').hidden = true; _hlSel = null; _hlEdit = null; }

// create a highlight from the current selection
function createHighlight(color) {
  const t = activeTab();
  if (!t || !_hlSel) return null;
  const { start, end } = rangeToOffsets(contentEl, _hlSel);
  if (end <= start) return null;
  const a = { id: 'h' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), color, start, end, quote: _hlSel.toString().slice(0, 400), note: '', ts: Date.now() };
  const list = annsFor(t.path).concat(a);
  setAnns(t.path, list);
  const range = offsetsToRange(contentEl, a.start, a.end);
  if (range) wrapRange(range, 'sutra-hl', { hlId: a.id }).forEach(m => m.style.setProperty('--hlc', HL_COLORS[color]));
  getSelection().removeAllRanges();
  if (sideMode === 'notes') renderNotesPane();
  return a;
}
function recolorHighlight(id, color) {
  const t = activeTab();
  const list = annsFor(t.path); const a = list.find(x => x.id === id);
  if (!a) return; a.color = color; setAnns(t.path, list);
  contentEl.querySelectorAll(`.sutra-hl[data-hl-id="${id}"]`).forEach(m => m.style.setProperty('--hlc', HL_COLORS[color]));
  if (sideMode === 'notes') renderNotesPane();
}
function removeHighlight(id) {
  const t = activeTab();
  setAnns(t.path, annsFor(t.path).filter(x => x.id !== id));
  contentEl.querySelectorAll(`.sutra-hl[data-hl-id="${id}"]`).forEach(m => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); });
  hideHlPop();
  if (sideMode === 'notes') renderNotesPane();
}
function saveNote(id, text) {
  const t = activeTab();
  const list = annsFor(t.path); const a = list.find(x => x.id === id);
  if (!a) return; a.note = text.trim(); setAnns(t.path, list);
  contentEl.querySelectorAll(`.sutra-hl[data-hl-id="${id}"]`).forEach(m => m.classList.toggle('has-note', !!a.note));
  if (sideMode === 'notes') renderNotesPane();
}

function openNoteEditor(id) {
  const t = activeTab(); const a = annsFor(t.path).find(x => x.id === id); if (!a) return;
  const np = $('hl-note-pop'); const ta = $('hl-note-text');
  ta.value = a.note || '';
  np.hidden = false;
  const pop = $('hl-pop');
  np.style.left = pop.style.left; np.style.top = (parseFloat(pop.style.top) + 34) + 'px';
  $('hl-pop').hidden = true;
  setTimeout(() => ta.focus(), 20);
  ta.onblur = () => { saveNote(id, ta.value); np.hidden = true; };
}

function wireAnnotations() {
  // read-mode selection → show the create popover
  document.addEventListener('selectionchange', () => {
    if (isRichEditing()) return;
    const t = activeTab();
    if (!canAnnotate(t)) return;
    clearTimeout(wireAnnotations._t);
    wireAnnotations._t = setTimeout(() => {
      const r = readSelectionRange();
      if (r) { _hlSel = r; _hlEdit = null; showHlPop(r.getBoundingClientRect(), 'create'); }
      else if ($('hl-pop').dataset.mode === 'create') $('hl-pop').hidden = true;
    }, 120);
  });
  // click an existing highlight → edit popover
  contentEl.addEventListener('click', (e) => {
    const m = e.target.closest('.sutra-hl');
    if (!m || isRichEditing()) return;
    e.preventDefault();
    _hlEdit = m.dataset.hlId; _hlSel = null;
    showHlPop(m.getBoundingClientRect(), 'edit');
    const a = annsFor(activeTab().path).find(x => x.id === _hlEdit);
    if (a && a.note) openNoteEditor(_hlEdit);
  });
  // popover buttons
  $('hl-pop').addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  $('hl-pop').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const color = b.dataset.color;
    if (color) { if (_hlEdit) recolorHighlight(_hlEdit, color); else { const a = createHighlight(color); _hlEdit = a && a.id; } }
    else if (b.dataset.act === 'note') { const id = _hlEdit || (createHighlight('yellow') || {}).id; if (id) openNoteEditor(id); return; }
    else if (b.dataset.act === 'remove' && _hlEdit) { removeHighlight(_hlEdit); return; }
    hideHlPop();
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#hl-pop, #hl-note-pop, .sutra-hl')) hideHlPop();
  });
}

function renderNotesPane() {
  const host = $('notes-pane'); if (!host) return;
  const t = activeTab();
  const list = t ? annsFor(t.path) : [];
  host.innerHTML = '';
  if (!list.length) { host.innerHTML = '<div class="notes-empty">No highlights yet. Select text in the document to highlight it.</div>'; return; }
  list.sort((a, b) => a.start - b.start);
  for (const a of list) {
    const row = document.createElement('div'); row.className = 'note-row';
    row.innerHTML = `<span class="note-dot" style="background:${HL_COLORS[a.color] || HL_COLORS.yellow}"></span>`
      + `<div class="note-body"><div class="note-quote"></div>${a.note ? '<div class="note-text"></div>' : ''}</div>`
      + `<button class="note-del" title="Remove">✕</button>`;
    row.querySelector('.note-quote').textContent = a.quote;
    if (a.note) row.querySelector('.note-text').textContent = a.note;
    row.querySelector('.note-body').addEventListener('click', () => scrollToHighlight(a.id));
    row.querySelector('.note-del').addEventListener('click', (e) => { e.stopPropagation(); removeHighlight(a.id); });
    host.appendChild(row);
  }
}
function scrollToHighlight(id) {
  const m = contentEl.querySelector(`.sutra-hl[data-hl-id="${id}"]`);
  if (!m) return;
  const top = m.getBoundingClientRect().top, srect = scrollerEl.getBoundingClientRect();
  scrollerEl.scrollTop += top - srect.top - srect.height * 0.35;
  m.classList.add('flash'); setTimeout(() => m.classList.remove('flash'), 900);
}

/* ---------- Command palette (⌘K) ---------- */

const cmdState = { items: [], filtered: [], idx: 0, query: '', searchItems: [], searchQuery: '' };

function cmdActions() {
  const t = activeTab();
  const list = [
    { id: 'newtab', label: 'Open a document', hint: '⌘O', icon: 'plus', run: openViaPicker },
    { id: 'new-canvas', label: 'New canvas', hint: '', icon: 'canvas', run: () => { closeCmd(); newCanvas(); } },
    { id: 'find', label: 'Find in document', hint: '⌘F', icon: 'find', run: () => { closeCmd(); openFind(); } },
  ];
  if (t && (t.kind === 'md' || t.kind === 'text')) list.push({ id: 'edit', label: t.editing ? 'Stop editing' : 'Edit document', hint: '⌘E', icon: 'pencil', run: () => { closeCmd(); toggleEdit(); } });
  if (t && t.kind === 'html') list.push({ id: 'mode', label: 'Toggle Reader / Live', hint: '', icon: 'swap', run: () => { closeCmd(); toggleHtmlMode(); } });
  if (t && t.kind === 'pdf') list.push({ id: 'reader', label: 'Reading mode (PDF → Markdown)', hint: '', icon: 'swap', run: () => { closeCmd(); openReadingMode(); } });
  if (t && t.kind === 'pptx') list.push({ id: 'present', label: 'Present (full-screen slideshow)', hint: '', icon: 'present', run: () => { closeCmd(); startPresentation(); } });
  if (t && t.kind !== 'unsupported') list.push({ id: 'map', label: 'Open mind map', hint: '⌘M', icon: 'map', run: () => { closeCmd(); toggleMap(); } });
  list.push({ id: 'ai', label: 'Open AI assistant', hint: '⌘J', icon: 'ai', filled: true, run: () => { closeCmd(); if ($('ai-panel').hidden) toggleAiPanel(); } });
  if (folder) list.push({ id: 'jump', label: 'Jump to a page', hint: '⌘P', icon: 'doc', run: () => { closeCmd(); setTimeout(openPageJump, 0); } });
  if (folder) {
    listTemplates().forEach(tpl => list.push({
      id: 'tpl-' + tpl.rel, label: 'New page from template: ' + tpl.title, hint: '', icon: 'doc',
      run: () => { closeCmd(); newFromTemplate(tpl); },
    }));
    list.push({ id: 'publish', label: 'Publish this folder as a site…', hint: '', icon: 'doc', run: () => { closeCmd(); publishSite(folder.root); } });
    list.push({ id: 'open-db', label: 'Open this folder as a database', hint: '', icon: 'doc', run: () => { closeCmd(); createDatabaseHere(folder.root); } });
    list.push({ id: 'new-db', label: 'New database here', hint: '', icon: 'doc', run: () => { closeCmd(); createDatabaseHere(folder.root); } });
  }
  if (t && t.kind === 'md') {
    list.push({ id: 'add-prop', label: 'Add a page property', hint: '', icon: 'doc', run: () => { closeCmd(); setTimeout(() => addProp(activeTab()), 30); } });
    list.push({ id: 'show-links', label: 'Show links & backlinks', hint: '', icon: 'find', run: () => { closeCmd(); sideMode = 'links'; sidebarCollapsed = false; updateSidebar(); } });
  }
  if (t) list.push({ id: 'summarize', label: 'Summarize this document', hint: 'AI', icon: 'ai', filled: true, run: () => { closeCmd(); toggleAiPanel(true); if (typeof aiQuick === 'function') aiQuick('summarize'); } });
  if (t) list.push({ id: 'export', label: 'Export…', hint: '', icon: 'export', run: () => { closeCmd(); openExportDialog(); } });
  list.push({ id: 'open-folder', label: 'Open a folder (wiki mode)', hint: '⌘⇧O', icon: 'doc', run: () => { closeCmd(); if (typeof openFolder === 'function') openFolder(); } });
  list.push({ id: 'new-project', label: 'New project…', hint: '', icon: 'layers', run: () => { closeCmd(); openProjectModal((id) => { const t = activeTab(); if (t && t.path) assignToProject(t.path, id); sideMode = 'files'; updateSidebar(); }); } });
  if (t && t.path) list.push({ id: 'add-to-project', label: 'Add this document to a project…', hint: '', icon: 'layers', run: () => { closeCmd(); openTabAssignMenuCentered(t); } });
  if (t && t.path && t.kind !== 'canvas') list.push({ id: 'send-canvas', label: 'Send to canvas…', hint: '', icon: 'canvas', run: () => { closeCmd(); sendDocToCanvas(t); } });
  if (t && t.kind !== 'canvas' && t.kind !== 'unsupported') list.push({ id: 'ai-board', label: 'Turn into a canvas board (AI)', hint: 'AI', icon: 'canvas', run: () => { closeCmd(); toggleAiPanel(true); aiToCanvas(); } });
  if (t && TEXT_KINDS.includes(t.kind)) list.push({ id: 'present-md', label: 'Present as slides', hint: '⌘⇧P', icon: 'present', run: () => { closeCmd(); startMdPresentation(); } });
  if (t && ['pdf', 'docx', 'html'].includes(t.kind)) list.push({ id: 'edit-md', label: 'Edit as Markdown', hint: '', icon: 'pencil', run: () => { closeCmd(); editAsMarkdown(); } });
  for (const th of THEMES) list.push({ id: 'theme:' + th.key, label: 'Theme: ' + th.label, hint: '', icon: 'theme', sw: th.sw, run: () => { settings.theme = th.key; saveSettings(); applySettings(); closeCmd(); } });
  return list;
}

function openCmd() {
  cmdState.items = cmdActions();
  cmdState.idx = 0;
  cmdState.pageMode = false;
  cmdState.searchItems = []; cmdState.searchQuery = '';   // no stale hits from last time
  $('cmd-overlay').hidden = false;
  $('cmd-input').value = '';
  $('cmd-input').placeholder = folder ? 'Search files, content and commands…' : 'Search files and commands…';
  filterCmd('');
  $('cmd-input').focus();
}
function closeCmd() { $('cmd-overlay').hidden = true; }

let _searchTimer = 0, _searchToken = 0;
function filterCmd(q) {
  const lq = q.toLowerCase().trim();
  cmdState.query = lq;
  // ⌘P page-jump: titles only, no commands, no content search
  if (cmdState.pageMode) {
    if (pageIndex.dirty) buildPageIndex();
    const scored = pageIndex.pages
      .map(p => ({ p, i: p.title.toLowerCase().indexOf(lq) }))
      .filter(x => !lq || x.i > -1 || x.p.rel.toLowerCase().includes(lq))
      .sort((a, b) => (a.i < 0) - (b.i < 0) || a.i - b.i || a.p.title.localeCompare(b.p.title))
      .slice(0, 50);
    cmdState.filtered = scored.map(({ p }) => ({
      page: true, label: p.title, hint: p.rel, icon: 'doc',
      run: () => { closeCmd(); const t = activeTab(); if (t && t.path) { navStack.push(t.path); navForward.length = 0; } openTauriPath(p.path); },
    }));
    cmdState.idx = Math.min(cmdState.idx, Math.max(0, cmdState.filtered.length - 1));
    renderCmd();
    return;
  }
  const cmds = lq ? cmdState.items.filter(a => a.label.toLowerCase().includes(lq)) : cmdState.items;
  // content-search results (folder / wiki mode) sit below the commands
  const hits = (lq.length >= 2 && cmdState.searchQuery === lq) ? cmdState.searchItems : [];
  cmdState.filtered = [...cmds, ...hits];
  cmdState.idx = Math.min(cmdState.idx, Math.max(0, cmdState.filtered.length - 1));
  renderCmd();
  // kick a debounced native content search across the open folder
  clearTimeout(_searchTimer);
  if (folder && TAURI && lq.length >= 2) {
    const token = ++_searchToken;
    _searchTimer = setTimeout(async () => {
      try {
        const rows = await TAURI.core.invoke('search_folder', { root: folder.root, query: lq });
        if (token !== _searchToken) return;                 // stale — user kept typing
        cmdState.searchQuery = lq;
        cmdState.searchItems = rows.map(r => ({
          search: true, path: r.path, name: r.name, line: r.line, count: r.count,
          snippet: r.snippet, col: r.col, q: lq,
          run: () => openAtQuery(r.path, lq),
        }));
        if (cmdState.query === lq) filterCmd(q);            // re-render with results in
      } catch (err) { console.error('search failed', err); }
    }, 160);
  } else { cmdState.searchItems = []; cmdState.searchQuery = ''; }
}

function renderCmd() {
  const list = $('cmd-list');
  list.innerHTML = '';
  if (!cmdState.filtered.length) {
    list.innerHTML = cmdState.query
      ? `<div class="cmd-none">No matches${folder ? '' : ' — open a folder (⌘⇧O) to search across files'}</div>`
      : '<div class="cmd-none">Type to search files, content and commands</div>';
    return;
  }
  let sawSearch = false;
  cmdState.filtered.forEach((a, i) => {
    if (a.search && !sawSearch) {                            // section header before the first hit
      sawSearch = true;
      const h = document.createElement('div'); h.className = 'cmd-section'; h.textContent = 'In documents';
      list.appendChild(h);
    }
    const row = document.createElement('button');
    row.className = 'cmd-row' + (a.search ? ' cmd-search' : '') + (i === cmdState.idx ? ' sel' : '');
    if (a.search) {
      row.innerHTML = `<span class="cmd-ic">${svgIcon('find')}</span>`
        + `<span class="cmd-hit"><span class="cmd-hit-name"></span><span class="cmd-hit-snip"></span></span>`
        + `<span class="cmd-hint">${a.count > 1 ? a.count + ' hits' : ''}</span>`;
      row.querySelector('.cmd-hit-name').textContent = a.name;
      row.querySelector('.cmd-hit-snip').append(highlightSnippet(a.snippet, a.col, a.q.length));
    } else {
      const swatch = a.sw ? `<span class="cmd-sw">${a.sw.map(c => `<i style="background:${c}"></i>`).join('')}</span>` : '';
      row.innerHTML = `<span class="cmd-ic${a.filled ? ' filled' : ''}">${svgIcon(a.icon, a.filled)}</span><span class="cmd-label"></span>${swatch}${a.hint ? `<span class="cmd-hint">${a.hint}</span>` : ''}`;
      row.querySelector('.cmd-label').textContent = a.label;
    }
    row.addEventListener('mousemove', () => { if (cmdState.idx !== i) { cmdState.idx = i; renderCmd(); } });
    row.addEventListener('click', () => a.run());
    list.appendChild(row);
  });
}

// snippet with the matched term wrapped in <mark>, built safely (no innerHTML)
function highlightSnippet(snippet, col, len) {
  const frag = document.createDocumentFragment();
  const c = Math.max(0, Math.min(col, snippet.length));
  frag.append(document.createTextNode(snippet.slice(0, c)));
  const m = document.createElement('mark'); m.textContent = snippet.slice(c, c + len);
  frag.append(m, document.createTextNode(snippet.slice(c + len)));
  return frag;
}

// open (or switch to) a file and highlight/scroll to the search term
async function openAtQuery(path, query) {
  closeCmd();
  await openTauriPath(path);
  setTimeout(() => {
    if (!activeTab()) return;
    $('findbar').hidden = false;
    updateReplaceRow();
    $('find-input').value = query;
    runFind(query);
  }, 380);
}

function cmdKeydown(e) {
  const n = cmdState.filtered.length;
  if (e.key === 'Escape') { e.preventDefault(); closeCmd(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); cmdState.idx = (cmdState.idx + 1) % n; renderCmd(); scrollCmdSel(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmdState.idx = (cmdState.idx - 1 + n) % n; renderCmd(); scrollCmdSel(); }
  else if (e.key === 'Enter') { e.preventDefault(); const a = cmdState.filtered[cmdState.idx]; if (a) a.run(); }
}
function scrollCmdSel() { const el = $('cmd-list').querySelector('.cmd-row.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); }

function wireCmd() {
  $('cmd-input').addEventListener('input', (e) => filterCmd(e.target.value));
  $('cmd-input').addEventListener('keydown', cmdKeydown);
  $('cmd-overlay').addEventListener('mousedown', (e) => { if (e.target === $('cmd-overlay')) closeCmd(); });
}

/* ---------- Selection bubble (floating mini-toolbar) ---------- */

function updateSelBubble() {
  const bubble = $('sel-bubble');
  if (!isRichEditing() || slashState.active) { bubble.hidden = true; return; }
  const s = getSelection();
  if (!s.rangeCount || s.getRangeAt(0).collapsed) { bubble.hidden = true; return; }
  const r = s.getRangeAt(0);
  if (!contentEl.contains(r.commonAncestorContainer)) { bubble.hidden = true; return; }
  const el = selElement();
  if (el && el.closest('pre')) { bubble.hidden = true; return; } // not in code blocks
  const rect = r.getBoundingClientRect();
  if (!rect.width && !rect.height) { bubble.hidden = true; return; }
  const mainRect = $('main').getBoundingClientRect();
  bubble.hidden = false;
  const bw = bubble.offsetWidth || 180;
  bubble.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - bw / 2 - mainRect.left, mainRect.width - bw - 8)) + 'px';
  bubble.style.top = Math.max(6, rect.top - mainRect.top - bubble.offsetHeight - 8) + 'px';
}

function wireSelBubble() {
  const bubble = $('sel-bubble');
  bubble.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
  bubble.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (btn && EDITOR_CMDS[btn.dataset.cmd]) {
      EDITOR_CMDS[btn.dataset.cmd]();
      updateSelBubble();
    }
  });
}

/* ---------- AI selection menu (Actions + Rewrite) ---------- */

const REWRITES = {
  grammar:  'Fix spelling, grammar and punctuation. Keep the meaning, voice and any Markdown formatting identical.',
  positive: 'Rewrite it in a warmer, more positive and constructive tone, keeping the meaning.',
  punchier: 'Make it punchier and more concise — stronger verbs, less filler — keeping the meaning.',
  shorter:  'Make it noticeably shorter while keeping the key meaning.',
  longer:   'Expand it with a little more detail and clarity in the same voice.',
};

let _selRange = null;   // the selection captured when the menu opened
function selMenuText() { return _selRange ? _selRange.toString() : ''; }
function restoreSel() {
  if (!_selRange) return false;
  contentEl.focus();
  const s = getSelection(); s.removeAllRanges(); s.addRange(_selRange);
  return true;
}

function openSelMenu() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed) return;
  _selRange = s.getRangeAt(0).cloneRange();
  const rect = _selRange.getBoundingClientRect();
  const menu = $('sel-menu');
  menu.hidden = false;
  const mr = $('main').getBoundingClientRect();
  const mw = menu.offsetWidth || 240, mh = menu.offsetHeight || 300;
  let left = Math.max(8, Math.min(rect.left - mr.left, mr.width - mw - 8));
  let top = rect.bottom - mr.top + 8;
  if (top + mh > mr.height - 8) top = Math.max(8, rect.top - mr.top - mh - 8);
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
  $('sel-bubble').hidden = true;
}
function closeSelMenu() { $('sel-menu').hidden = true; }

async function aiRewriteSel(kind) {
  const text = selMenuText().trim();
  if (!text) return;
  closeSelMenu();
  toast('Rewriting…');
  try {
    const out = (await callAI({
      system: 'You are an inline text editor. ' + REWRITES[kind] + ' Reply with ONLY the rewritten text — no quotes, no preamble, no explanation. Preserve the original language.',
      messages: [{ role: 'user', content: text }],
    })).trim();
    if (!out) throw new Error('empty result');
    if (restoreSel()) execEditorCmd(() => document.execCommand('insertText', false, out));
  } catch (err) { toast('AI: ' + (err.message || err)); }
}

async function translateSel() {
  const text = selMenuText().trim(); if (!text) return;
  const lang = await askLanguage(); if (!lang) return;
  toast('Translating…');
  try {
    const out = (await callAI({ system: 'Translate the text into ' + lang + '. Reply with ONLY the translation — no quotes or notes.', messages: [{ role: 'user', content: text }] })).trim();
    if (out && restoreSel()) execEditorCmd(() => document.execCommand('insertText', false, out));
  } catch (e) { toast('AI: ' + e.message); }
}

function wireSelMenu() {
  const ai = $('sb-ai');
  ai.addEventListener('mousedown', (e) => e.preventDefault());
  ai.addEventListener('click', openSelMenu);
  const menu = $('sel-menu');
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.rw) { aiRewriteSel(b.dataset.rw); return; }
    const text = selMenuText();
    if (b.dataset.act === 'copy') navigator.clipboard.writeText(text).then(() => toast('Copied'));
    else if (b.dataset.act === 'translate') { closeSelMenu(); translateSel(); return; }
    else if (b.dataset.act === 'search') {
      const url = 'https://www.google.com/search?q=' + encodeURIComponent(text.slice(0, 300));
      if (TAURI) TAURI.core.invoke('open_externally', { path: url }); else window.open(url, '_blank');
    }
    closeSelMenu();
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#sel-menu, #sb-ai')) closeSelMenu(); });
}

/* ---------- Slash menu ("/" block palette) ---------- */

const SLASH_ITEMS = [
  { k: 'text paragraph', label: 'Paragraph', hint: 'Plain text', run: () => setBlockType('p') },
  { k: 'heading 1 h1 title', label: 'Heading 1', hint: '# Large heading', run: () => setBlockType('h1') },
  { k: 'heading 2 h2', label: 'Heading 2', hint: '## Section heading', run: () => setBlockType('h2') },
  { k: 'heading 3 h3', label: 'Heading 3', hint: '### Subsection', run: () => setBlockType('h3') },
  { k: 'quote blockquote', label: 'Quote', hint: '> Quoted text', run: () => setBlockType('blockquote') },
  { k: 'code block pre', label: 'Code block', hint: 'Monospaced block', run: () => setBlockType('pre') },
  { k: 'bullet list ul', label: 'Bullet list', hint: '- item', run: () => document.execCommand('insertUnorderedList') },
  { k: 'numbered ordered list ol', label: 'Numbered list', hint: '1. item', run: () => document.execCommand('insertOrderedList') },
  { k: 'todo task checkbox', label: 'To-do', hint: '- [ ] task', run: toggleTask },
  { k: 'table grid', label: 'Table', hint: '3×3 with header', run: insertTable },
  { k: 'divider rule hr', label: 'Divider', hint: 'Horizontal rule', run: () => insertBlockAfterCurrent(document.createElement('hr')) },
  { k: 'image picture photo', label: 'Image', hint: 'From a file', run: null /* async special */ },
  { k: 'math equation katex', label: 'Math block', hint: '$$ … $$', run: insertMathBlock },
  { k: 'diagram mermaid flowchart', label: 'Diagram', hint: 'Mermaid block', run: insertMermaidBlock },
  { k: 'callout note info admonition', label: 'Callout', hint: '> [!note]', run: () => insertCallout('note') },
  { k: 'callout warning', label: 'Callout: Warning', hint: '> [!warning]', run: () => insertCallout('warning') },
  { k: 'callout tip', label: 'Callout: Tip', hint: '> [!tip]', run: () => insertCallout('tip') },
  { k: 'toggle collapse details accordion', label: 'Toggle list', hint: 'Collapsible block', run: insertToggle },
  { k: 'columns split side by side', label: 'Columns', hint: 'Two columns', run: () => insertColumns(2) },
  { k: 'columns three 3', label: 'Columns: 3', hint: 'Three columns', run: () => insertColumns(3) },
  { k: 'embed transclude synced block page', label: 'Embed a page', hint: '![[page]]', run: insertEmbedPrompt },
  { k: 'database view table inline', label: 'Database view', hint: 'Embed a database', run: insertInlineDbView },
  { k: 'block id anchor reference', label: 'Block id', hint: 'Anchor for embeds', run: addBlockId },
];

const slashState = { active: false, query: '', sel: null, idx: 0 };

function openSlashMenu() {
  slashState.active = true;
  slashState.query = '';
  slashState.idx = 0;
  $('sel-bubble').hidden = true;
  renderSlashMenu();
}

function closeSlashMenu() {
  slashState.active = false;
  $('slash-menu').hidden = true;
}

function slashMatches() {
  const q = slashState.query.toLowerCase();
  return SLASH_ITEMS.filter(it => !q || it.k.includes(q) || it.label.toLowerCase().includes(q));
}

function renderSlashMenu() {
  const menu = $('slash-menu');
  const items = slashMatches();
  if (!items.length) { closeSlashMenu(); return; }
  slashState.idx = Math.min(slashState.idx, items.length - 1);
  menu.innerHTML = '';
  items.forEach((it, i) => {
    const b = document.createElement('button');
    b.className = i === slashState.idx ? 'sel' : '';
    b.innerHTML = `<span class="sl-label"></span><span class="sl-hint"></span>`;
    b.querySelector('.sl-label').textContent = it.label;
    b.querySelector('.sl-hint').textContent = it.hint;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => acceptSlash(it));
    menu.appendChild(b);
  });
  // position at the caret
  const s = getSelection();
  let rect = null;
  if (s.rangeCount) rect = s.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height && !rect.top)) {
    const blk = currentBlock();
    rect = blk ? blk.getBoundingClientRect() : contentEl.getBoundingClientRect();
  }
  const mainRect = $('main').getBoundingClientRect();
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(rect.left - mainRect.left, mainRect.width - 280)) + 'px';
  menu.style.top = Math.min(rect.bottom - mainRect.top + 6, mainRect.height - menu.offsetHeight - 8) + 'px';
}

function deleteSlashText() {
  // remove the typed "/query" by walking back from the LIVE caret — robust
  // against node splits and element-relative bookmarks (empty paragraphs)
  try {
    const s = getSelection();
    if (!s.rangeCount) return;
    const r = s.getRangeAt(0);
    let node = r.startContainer, off = r.startOffset;
    if (node.nodeType !== 3) {
      node = node.childNodes[Math.max(0, off - 1)];
      while (node && node.nodeType !== 3 && node.lastChild) node = node.lastChild;
      if (!node || node.nodeType !== 3) return;
      off = node.length;
    }
    const len = 1 + slashState.query.length;
    const del = document.createRange();
    del.setStart(node, Math.max(0, off - len));
    del.setEnd(node, off);
    del.deleteContents();
    s.removeAllRanges();
    s.addRange(del);
  } catch (_) {}
}

function acceptSlash(item) {
  closeSlashMenu();
  if (item.label === 'Image') {
    execEditorCmd(deleteSlashText);
    insertImage().then(() => { historySnapshot(); onRichInput(); });
    return;
  }
  execEditorCmd(() => { deleteSlashText(); item.run(); });
}

function handleSlashKeydown(e) {
  if (!slashState.active) return false;
  const items = slashMatches();
  if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return true; }
  if (e.key === 'ArrowDown') { e.preventDefault(); slashState.idx = (slashState.idx + 1) % items.length; renderSlashMenu(); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); slashState.idx = (slashState.idx - 1 + items.length) % items.length; renderSlashMenu(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (items[slashState.idx]) acceptSlash(items[slashState.idx]); return true; }
  if (e.key === 'Backspace') {
    if (!slashState.query) { closeSlashMenu(); return false; } // let it delete the "/"
    slashState.query = slashState.query.slice(0, -1);
    setTimeout(renderSlashMenu, 0);
    return false; // let the char delete in the document too
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === ' ') { closeSlashMenu(); return false; }
    slashState.query += e.key;
    setTimeout(renderSlashMenu, 0);
    return false; // type through into the document
  }
  return false;
}

/* ---------- Markdown autoformat while typing ---------- */

const AUTOFORMAT = {
  '#': () => setBlockType('h1'),
  '##': () => setBlockType('h2'),
  '###': () => setBlockType('h3'),
  '####': () => setBlockType('h4'),
  '>': () => setBlockType('blockquote'),
  '-': () => document.execCommand('insertUnorderedList'),
  '*': () => document.execCommand('insertUnorderedList'),
  '1.': () => document.execCommand('insertOrderedList'),
  '[]': () => toggleTask(),
  '```': () => setBlockType('pre'),
};

function tryAutoformat() {
  // caret must sit right after a pattern at the very start of a paragraph
  const s = getSelection();
  if (!s.rangeCount || !s.getRangeAt(0).collapsed) return false;
  const r = s.getRangeAt(0);
  const node = r.startContainer;
  if (node.nodeType !== 3) return false;
  const blk = currentBlock();
  if (!blk || blk.tagName !== 'P') return false;
  if (node.parentElement.closest('pre, code')) return false;
  const before = node.data.slice(0, r.startOffset);
  if (blk.textContent.slice(0, before.length) !== before) return false; // not at block start
  const fn = AUTOFORMAT[before.trim()];
  if (!fn || before.trim() !== before) return false;
  execEditorCmd(() => {
    node.data = node.data.slice(r.startOffset);
    placeCaret(blk, true);
    fn();
  });
  return true;
}

function wireRichTyping() {
  contentEl.addEventListener('keydown', (e) => {
    if (!isRichEditing()) return;
    if (handleSlashKeydown(e)) return;
    if (e.key === '/' && !slashState.active) {
      const el = selElement();
      if (el && el.closest('pre, code')) return; // no slash menu in code
      setTimeout(openSlashMenu, 0);              // open after "/" inserts
      return;
    }
    if (e.key === ' ' && tryAutoformat()) { e.preventDefault(); }
  });
  contentEl.addEventListener('blur', () => setTimeout(() => { if (!document.activeElement.closest('#slash-menu')) closeSlashMenu(); }, 150));
}

/* ---------- E3: block drag-to-reorder ---------- */

let hoverBlock = null;

function topBlockFromPoint(x, y) {
  for (const el of contentEl.children) {
    const r = el.getBoundingClientRect();
    if (y >= r.top - 4 && y <= r.bottom + 4) return el;
  }
  return null;
}

function positionBlockHandle() {
  const h = $('block-handle');
  if (!isRichEditing() || !hoverBlock || !contentEl.contains(hoverBlock)) { h.hidden = true; return; }
  const r = hoverBlock.getBoundingClientRect();
  const mainRect = $('main').getBoundingClientRect();
  h.hidden = false;
  h.style.left = (r.left - mainRect.left - 22) + 'px';
  h.style.top = (r.top - mainRect.top + 2) + 'px';
}

function wireBlockDrag() {
  contentEl.addEventListener('mousemove', (e) => {
    if (!isRichEditing() || dragging) return;
    const blk = topBlockFromPoint(e.clientX, e.clientY);
    if (blk && blk !== hoverBlock) { hoverBlock = blk; positionBlockHandle(); }
  });
  scrollerEl.addEventListener('scroll', () => { if (isRichEditing()) positionBlockHandle(); }, { passive: true });

  let dragging = false, dragEl = null, indicator = null;
  const handle = $('block-handle');
  handle.addEventListener('mousedown', (e) => {
    if (!isRichEditing() || !hoverBlock) return;
    e.preventDefault();
    dragging = true;
    dragEl = hoverBlock;
    dragEl.classList.add('block-dragging');
    indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
    contentEl.appendChild(indicator);
    historySnapshot();
    const move = (ev) => {
      const over = topBlockFromPoint(ev.clientX, ev.clientY);
      if (!over || over === dragEl || over === indicator) return;
      const r = over.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      over[after ? 'after' : 'before'](indicator);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      dragging = false;
      dragEl.classList.remove('block-dragging');
      if (indicator.parentNode) indicator.replaceWith(dragEl);
      indicator = null;
      historySnapshot();
      onRichInput();
      positionBlockHandle();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  handle.addEventListener('click', (e) => {
    if (hoverBlock) { const r = document.createRange(); r.selectNode(hoverBlock); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
}

/* ---------- E3: table row/column tools ---------- */

let activeCell = null;

function updateTableTools() {
  const tools = $('table-tools');
  if (!isRichEditing()) { tools.hidden = true; return; }
  const el = selElement();
  const cell = el && el.closest('td, th');
  if (!cell || !contentEl.contains(cell)) { tools.hidden = true; activeCell = null; return; }
  activeCell = cell;
  const table = cell.closest('table');
  const r = table.getBoundingClientRect();
  const mainRect = $('main').getBoundingClientRect();
  tools.hidden = false;
  tools.style.left = Math.max(8, r.left - mainRect.left) + 'px';
  tools.style.top = Math.max(6, r.top - mainRect.top - tools.offsetHeight - 6) + 'px';
}

function cellIndex(cell) { return [...cell.parentElement.children].indexOf(cell); }

function tableOp(op) {
  if (!activeCell) return;
  const cell = activeCell, row = cell.parentElement, table = cell.closest('table');
  const ci = cellIndex(cell);
  const allRows = [...table.querySelectorAll('tr')];
  const newCell = (tag) => { const c = document.createElement(tag); c.innerHTML = '&nbsp;'; return c; };
  execEditorCmd(() => {
    if (op === 'row-above' || op === 'row-below') {
      const tr = document.createElement('tr');
      for (let i = 0; i < row.children.length; i++) tr.appendChild(newCell('td'));
      row[op === 'row-above' ? 'before' : 'after'](tr);
    } else if (op === 'col-left' || op === 'col-right') {
      const at = ci + (op === 'col-right' ? 1 : 0);
      allRows.forEach(tr => {
        const isHead = tr.parentElement.tagName === 'THEAD' || tr.querySelector('th');
        const c = newCell(isHead ? 'th' : 'td');
        if (isHead) c.textContent = 'Column';
        const ref = tr.children[at];
        if (ref) tr.insertBefore(c, ref); else tr.appendChild(c);
      });
    } else if (op === 'del-row') {
      if (row.closest('thead')) return; // keep header
      if (table.querySelectorAll('tbody tr').length > 1) row.remove();
    } else if (op === 'del-col') {
      if (row.children.length > 1) allRows.forEach(tr => { if (tr.children[ci]) tr.children[ci].remove(); });
    }
  });
  setTimeout(updateTableTools, 0);
}

function wireTableTools() {
  $('table-tools').addEventListener('mousedown', (e) => e.preventDefault());
  $('table-tools').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-t]');
    if (btn) tableOp(btn.dataset.t);
  });
}

/* ---------- E3: callouts ---------- */

const CALLOUT_TYPES = { note: '📝', tip: '💡', important: '❗', warning: '⚠️', caution: '🔥' };

function renderCallouts() {
  contentEl.querySelectorAll('blockquote').forEach(bq => {
    if (bq.classList.contains('callout')) return;
    const m = bq.textContent.trim().match(/^\[!(\w+)\]/i);
    if (!m) return;
    const type = m[1].toLowerCase();
    if (!CALLOUT_TYPES[type]) return;
    bq.classList.add('callout');
    bq.dataset.callout = type;
    // strip the [!type] marker from the first NON-whitespace text node
    const walker = document.createTreeWalker(bq, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.data.trim()) { node.data = node.data.replace(/^\s*\[!\w+\]\s?/i, ''); break; }
    }
    const label = document.createElement('div');
    label.className = 'callout-head';
    label.contentEditable = 'false';
    label.textContent = CALLOUT_TYPES[type] + ' ' + type[0].toUpperCase() + type.slice(1);
    bq.prepend(label);
  });
}

function insertCallout(type) {
  const bq = document.createElement('blockquote');
  bq.className = 'callout';
  bq.dataset.callout = type;
  const label = document.createElement('div');
  label.className = 'callout-head'; label.contentEditable = 'false';
  label.textContent = CALLOUT_TYPES[type] + ' ' + type[0].toUpperCase() + type.slice(1);
  const p = document.createElement('p'); p.innerHTML = 'Callout text';
  bq.append(label, p);
  insertBlockAfterCurrent(bq);
  placeCaret(p, true);
}

/* callouts → markdown: strip the visual head; the blockquote.callout keeps
   its class + data-callout so the Turndown rule can emit `> [!type]`. */
function serializeCallouts(clone) {
  clone.querySelectorAll('blockquote.callout .callout-head').forEach(h => h.remove());
}

/* ---------- E3: find & replace ---------- */

function doReplaceOne() {
  const t = activeTab();
  if (!isRichEditing() || !findState.ranges.length || findState.current < 0) return;
  const rep = $('replace-input').value;
  const r = findState.ranges[findState.current];
  execEditorCmd(() => {
    r.deleteContents();
    r.insertNode(document.createTextNode(rep));
  });
  setTimeout(() => { runFind(findState.query).then(() => gotoMatch(1)); }, 0);
}

function doReplaceAll() {
  const t = activeTab();
  if (!isRichEditing() || !findState.query) return;
  const q = findState.query, rep = $('replace-input').value;
  execEditorCmd(() => {
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    const lq = q.toLowerCase();
    let node, count = 0;
    const nodes = [];
    while ((node = walker.nextNode())) if (node.data.toLowerCase().includes(lq)) nodes.push(node);
    for (const n of nodes) {
      let out = '', i = 0, data = n.data;
      const low = data.toLowerCase();
      let j;
      while ((j = low.indexOf(lq, i)) !== -1) { out += data.slice(i, j) + rep; i = j + q.length; count++; }
      out += data.slice(i);
      n.data = out;
    }
    $('find-count').textContent = count + ' replaced';
  });
  setTimeout(() => runFind(findState.query), 0);
}

function updateReplaceRow() {
  $('replace-row').hidden = !isRichEditing();
}

/* ---------- E3: highlight ---------- */

function toggleHighlight() {
  const s = getSelection();
  if (!s.rangeCount || s.getRangeAt(0).collapsed) return;
  const el = selElement();
  const mk = el && el.closest('mark');
  if (mk && contentEl.contains(mk)) {
    const parent = mk.parentNode;
    while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
    parent.removeChild(mk);
    return;
  }
  const r = s.getRangeAt(0);
  const mark = document.createElement('mark');
  try { r.surroundContents(mark); }
  catch (_) { mark.appendChild(r.extractContents()); r.insertNode(mark); }
}

/* ---------- Toolbar dispatch + state ---------- */

function execEditorCmd(fn) {
  if (!isRichEditing()) return;
  historySnapshot();
  fn();
  historySnapshot();
  onRichInput();
  updateToolbarState();
}

const EDITOR_CMDS = {
  undo: () => editUndo(),
  redo: () => editRedo(),
  bold: () => execEditorCmd(() => document.execCommand('bold')),
  italic: () => execEditorCmd(() => document.execCommand('italic')),
  underline: () => execEditorCmd(() => document.execCommand('underline')),
  strike: () => execEditorCmd(() => document.execCommand('strikeThrough')),
  code: () => execEditorCmd(toggleInlineCode),
  link: () => openLinkPop(),
  ul: () => execEditorCmd(() => document.execCommand('insertUnorderedList')),
  ol: () => execEditorCmd(() => document.execCommand('insertOrderedList')),
  task: () => execEditorCmd(toggleTask),
  hr: () => execEditorCmd(() => insertBlockAfterCurrent(document.createElement('hr'))),
  table: () => execEditorCmd(insertTable),
  image: () => insertImage().then(() => { historySnapshot(); onRichInput(); }),
  math: () => execEditorCmd(insertMathBlock),
  mermaid: () => execEditorCmd(insertMermaidBlock),
  highlight: () => execEditorCmd(toggleHighlight),
  aa: () => { $('settings-overlay').hidden = false; },
};

function updateToolbarState() {
  const tb = $('edit-toolbar'), insp = $('editor-inspector');
  if (tb.hidden && insp.hidden) return;
  const el = selElement();
  const q = (cmd) => { try { return document.queryCommandState(cmd); } catch (_) { return false; } };
  // mark the same command in whichever chrome is visible (toolbar or inspector)
  const scope = tb.hidden ? insp : tb;
  const mark = (name, on) => {
    const b = scope.querySelector(`[data-cmd="${name}"]`);
    if (b) b.classList.toggle('on', !!on);
  };
  mark('bold', q('bold'));
  mark('italic', q('italic'));
  mark('underline', q('underline'));
  mark('strike', q('strikeThrough'));
  mark('code', el && el.closest('code') && !el.closest('pre'));
  mark('link', el && el.closest('a'));
  const blk = currentBlock();
  const tag = blk ? blk.tagName.toLowerCase() : 'p';
  const blockVal = ['h1', 'h2', 'h3', 'h4', 'blockquote', 'pre'].includes(tag) ? tag : 'p';
  if (!tb.hidden) $('tb-block').value = blockVal;
  if (!insp.hidden) $('insp-block').value = blockVal;
}

// Choose the editor chrome by width: the right inspector on wide screens, the
// compact top toolbar when the window is too narrow for a 264px panel (mobile).
function layoutEditorChrome(rich) {
  if (rich === undefined) rich = isRichEditing();
  const wide = $('main').clientWidth >= 900;
  const useInspector = rich && wide;
  $('editor-inspector').hidden = !useInspector;
  $('edit-toolbar').hidden = !(rich && !wide);
  document.body.classList.toggle('has-inspector', useInspector);
  if (useInspector) syncInspector();
}

// Push current settings into the inspector's Style/Text controls.
function syncInspector() {
  document.querySelectorAll('#editor-inspector .insp-style').forEach(b =>
    b.classList.toggle('on', b.dataset.font === settings.font));
  document.querySelectorAll('#insp-width button').forEach(b =>
    b.classList.toggle('sel', b.dataset.v === settings.width));
  const fv = $('insp-fs-val'), lv = $('insp-lh-val');
  if (fv) fv.textContent = settings.fontSize + 'px';
  if (lv) lv.textContent = (settings.lineSpacing || 1.7).toFixed(1);
  updateToolbarState();
}

function wireInspector() {
  const insp = $('editor-inspector');
  // preserve the selection: don't let button clicks steal focus (as the toolbar does)
  insp.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') && !e.target.closest('#insp-block')) e.preventDefault();
  });
  insp.addEventListener('click', (e) => {
    const cmdBtn = e.target.closest('button[data-cmd]');
    if (cmdBtn && EDITOR_CMDS[cmdBtn.dataset.cmd]) { EDITOR_CMDS[cmdBtn.dataset.cmd](); return; }
    const styleBtn = e.target.closest('.insp-style');
    if (styleBtn) { settings.font = styleBtn.dataset.font; saveSettings(); applySettings(); syncInspector(); return; }
    const widthBtn = e.target.closest('#insp-width button');
    if (widthBtn) { settings.width = widthBtn.dataset.v; saveSettings(); applySettings(); syncInspector(); return; }
  });
  $('insp-block').addEventListener('change', (e) => { execEditorCmd(() => setBlockType(e.target.value)); contentEl.focus(); });
  $('insp-fs-minus').addEventListener('click', () => { settings.fontSize = Math.max(12, settings.fontSize - 1); saveSettings(); applySettings(); syncInspector(); });
  $('insp-fs-plus').addEventListener('click', () => { settings.fontSize = Math.min(24, settings.fontSize + 1); saveSettings(); applySettings(); syncInspector(); });
  $('insp-lh-minus').addEventListener('click', () => { settings.lineSpacing = Math.max(1.2, Math.round(((settings.lineSpacing || 1.7) - 0.1) * 10) / 10); saveSettings(); applySettings(); syncInspector(); });
  $('insp-lh-plus').addEventListener('click', () => { settings.lineSpacing = Math.min(2.4, Math.round(((settings.lineSpacing || 1.7) + 0.1) * 10) / 10); saveSettings(); applySettings(); syncInspector(); });
}

function wireEditorToolbar() {
  $('edit-toolbar').addEventListener('mousedown', (e) => {
    // keep the text selection: don't let toolbar clicks steal focus
    if (e.target.closest('button, select') && !e.target.closest('#tb-block')) e.preventDefault();
  });
  $('edit-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (btn && EDITOR_CMDS[btn.dataset.cmd]) EDITOR_CMDS[btn.dataset.cmd]();
  });
  $('tb-block').addEventListener('change', (e) => {
    execEditorCmd(() => setBlockType(e.target.value));
    contentEl.focus();
  });
  document.addEventListener('selectionchange', () => {
    if (!isRichEditing()) return;
    clearTimeout(window._tbStateTimer);
    window._tbStateTimer = setTimeout(() => { updateToolbarState(); updateSelBubble(); updateTableTools(); }, 120);
  });
  $('link-apply').addEventListener('click', applyLink);
  $('link-remove').addEventListener('click', () => { $('link-input').value = ''; applyLink(); });
  $('link-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeLinkPop(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!$('link-pop').hidden && !e.target.closest('#link-pop')) closeLinkPop();
  });
}

let richTimer = null;
function onRichInput() {
  const t = activeTab();
  if (!t || !isRichEditing()) return;
  setDirty(t, true);
  clearTimeout(richTimer);
  richTimer = setTimeout(() => {
    t.text = richToMarkdown(t);
    historySnapshot(); // typing checkpoint for undo
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveEditor(t), 500);
  }, 500);
}

function syncEditorPane(t) {
  const editing = !!(t && t.editing && t.editSurface === 'source' && TEXT_KINDS.includes(t.kind));
  document.body.classList.toggle('editing', editing);
  $('editor-pane').hidden = !editing;
  if (!editing) return;
  if (!cm) {
    $('editor-pane').innerHTML = '';
    cm = CodeMirror((el) => $('editor-pane').appendChild(el), {
      mode: 'markdown',
      lineNumbers: true,
      lineWrapping: true,
      value: '',
    });
    cm.on('change', onEditorChange);
  }
  if (cm.getValue() !== (t.text || '')) {
    cmSilent = true;
    cm.setValue(t.text || '');
    cmSilent = false;
  }
  setTimeout(() => cm.refresh(), 0);
}

function setDirty(t, dirty) {
  t.dirty = dirty;
  const el = $('tabs').querySelector(`.tab[data-id="${t.id}"]`);
  if (el) el.classList.toggle('dirty', dirty);
  if (t.id === activeId) $('ctx-saved').classList.toggle('dirty', dirty);
}

function onEditorChange() {
  if (cmSilent) return;
  const t = activeTab();
  if (!t || !t.editing) return;
  t.text = cm.getValue();
  t.fm = splitFm(t.text).fm;      // source edits can change the frontmatter directly
  setDirty(t, true);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    t.html = await buildHtml(t.kind, { text: t.text });
    if (activeId === t.id && t.editing) {
      contentEl.innerHTML = t.html;
      fixupContent(t);
      renderProps(t);
      decorateWikiLinks(t);
      renderEnhancements(t).then(() => { if (activeId === t.id) buildHeadingToc(); });
      buildHeadingToc();
    }
  }, 300);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveEditor(t), 900);
}

async function saveEditor(t) {
  try {
    if (TAURI && t.path) {
      t.mtime = await TAURI.core.invoke('write_file', { path: t.path, contents: t.text });
    } else if (t.handle && t.handle.createWritable) {
      const w = await t.handle.createWritable();
      await w.write(t.text);
      await w.close();
      t.mtime = (await t.handle.getFile()).lastModified;
    } else return;
    setDirty(t, false);
  } catch (err) {
    console.error('save failed', err);
  }
}

/* ---------- Dock resizing (sidebar + AI panel) ----------
   One pointer-based implementation for both docks: works with mouse, trackpad,
   touch and pen; rAF-throttled so dragging stays at frame rate; and clamped
   against the live viewport so a dock can never crush the document. */

const DOCK_MIN_CONTENT = 320;   // the document never gets narrower than this
// `collapseAt`: drag the divider past this and the dock closes entirely
// (⌘B / ⌘J bring it back at its remembered width).
const DOCKS = {
  toc: { panel: 'sidebar',  handle: 'toc-resize', side: 'left',  min: 180, def: 250, key: 'tocWidth', collapseAt: 140 },
  ai:  { panel: 'ai-panel', handle: 'ai-resize',  side: 'right', min: 280, def: 340, key: 'aiWidth',  collapseAt: 200 },
};

function collapseDock(which) {
  if (which === 'toc') { sidebarCollapsed = true; updateSidebar(); syncDrawerBackdrop(); }
  else toggleAiPanel(false);
}

function dockVisible(d) {
  const el = $(d.panel);
  if (!el || el.hidden) return false;
  if (d.panel === 'sidebar') return !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';
  return true;
}

// How wide this dock may get right now: measured from the live layout — total
// width minus every other fixed-width sibling (rail, other dock, the resize
// handles themselves) minus the document's minimum. The flexible content panes
// are skipped since they're what we're budgeting for.
const DOCK_FLEX_PANES = ['scroller', 'canvasview', 'mapview', 'graphview', 'empty', 'unsupported', 'home', 'pages'];
function dockMax(which) {
  const d = DOCKS[which], panel = $(d.panel), main = $('main');
  let used = 0;
  for (const kid of main.children) {
    if (kid === panel || DOCK_FLEX_PANES.includes(kid.id)) continue;
    if (kid.hidden || getComputedStyle(kid).display === 'none') continue;
    used += kid.offsetWidth;
  }
  return Math.max(d.min, main.clientWidth - used - DOCK_MIN_CONTENT);
}

function setDockWidth(which, w, { save = false } = {}) {
  const d = DOCKS[which];
  const clamped = Math.round(Math.min(dockMax(which), Math.max(d.min, w)));
  $(d.panel).style.width = clamped + 'px';
  settings[d.key] = clamped;
  if (save) saveSettings();
  return clamped;
}

function wireDockResizer(which) {
  const d = DOCKS[which];
  const handle = $(d.handle), panel = $(d.panel);
  if (!handle || !panel) return;
  let raf = 0, next = null;

  const flush = () => { raf = 0; if (next != null) setDockWidth(which, next); };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;   // left/primary only
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}  // keeps the drag alive off-handle
    handle.classList.add('dragging');
    document.body.classList.add('dock-resizing');     // kills text selection + iframe steal
    const r = panel.getBoundingClientRect();
    const anchor = d.side === 'left' ? r.left : r.right;

    const move = (ev) => {
      const raw = d.side === 'left' ? ev.clientX - anchor : anchor - ev.clientX;
      // dragged past the threshold → close the dock and end the drag
      if (raw < d.collapseAt) { next = null; up(); collapseDock(which); return; }
      // near the threshold, hint that letting go here would close it
      panel.classList.toggle('will-collapse', raw < d.collapseAt + 45);
      next = raw;
      if (!raf) raf = requestAnimationFrame(flush);    // ≤1 layout per frame
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (next != null) setDockWidth(which, next);
      handle.classList.remove('dragging');
      panel.classList.remove('will-collapse');
      document.body.classList.remove('dock-resizing');
      saveSettings();   // only ever holds a >= min width — collapse never persists one
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  // double-click the divider → back to the default width
  handle.addEventListener('dblclick', () => setDockWidth(which, d.def, { save: true }));
}

// Re-clamp on window resize so a wide dock can't squeeze the document when the
// window shrinks (and let it grow back to the user's width when it re-widens).
function reclampDocks() {
  for (const which of Object.keys(DOCKS)) {
    const d = DOCKS[which];
    if (!dockVisible(d)) continue;
    setDockWidth(which, settings[d.key] || d.def);
  }
}

function wireDockResizers() {
  for (const which of Object.keys(DOCKS)) {
    const d = DOCKS[which];
    if (settings[d.key]) $(d.panel).style.width = settings[d.key] + 'px';
    wireDockResizer(which);
  }
  // Watch the actual container, not just window.resize — this catches every
  // size change (window, zoom, OS chrome) and can't be missed. #main's own size
  // doesn't change when we resize a dock, so there's no feedback loop.
  // (Called directly: ResizeObserver already batches to one callback per frame,
  // and this keeps the reflow off the rAF queue.)
  if (window.ResizeObserver) new ResizeObserver(() => { reclampDocks(); layoutEditorChrome(); }).observe($('main'));
  window.addEventListener('resize', reclampDocks);   // belt and braces
  reclampDocks();
}

/* ---------- Freeform canvas (Excalidraw, lazy-loaded) ---------- */

function blankScene() { return { type: 'excalidraw', version: 2, source: 'sutra', elements: [], appState: { sutraBackground: 'dots' }, files: {} }; }
function parseScene(text) {
  if (!text) return blankScene();
  try { const s = JSON.parse(text); if (s && Array.isArray(s.elements)) return s; } catch (_) {}
  return blankScene();
}
function canvasTheme() {
  const th = THEMES.find(x => x.key === settings.theme) || THEMES[0];
  const base = th.base === 'system' ? (sysDark.matches ? 'dark' : 'light') : th.base;
  return base === 'dark' ? 'dark' : 'light';
}

// The 8 MB Excalidraw bundle loads only when a canvas is first opened — normal
// document reading never pays for it.
let _canvasLibP = null;
function ensureCanvasLib() {
  if (window.SutraCanvas) return Promise.resolve();
  if (_canvasLibP) return _canvasLibP;
  _canvasLibP = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = 'vendor/excalidraw.bundle.css';
    document.head.appendChild(link);
    const s = document.createElement('script');
    s.src = 'vendor/excalidraw.bundle.js';
    s.onload = () => window.SutraCanvas ? resolve() : reject(new Error('bundle loaded but SutraCanvas missing'));
    s.onerror = () => reject(new Error('failed to load canvas bundle'));
    document.body.appendChild(s);
  });
  return _canvasLibP;
}

// A curated Canva-style colour strip (Sutra palette + common colours).
const CANVAS_COLORS = ['#1e1e1e', '#ffffff', '#e03131', '#e8590c', '#f08c00', '#2f9e44',
  '#0c8599', '#1971c2', '#6741d9', '#c2255c', '#b5623a', '#5a6bb0', '#4f8a80', '#868e96'];

let _canvasTabId = null;          // which canvas tab is currently mounted
let _canvasSuppressUntil = 0;     // ignore Excalidraw's onChange bursts right after (re)load
async function renderCanvas(t) {
  showPane('canvas');
  $('canvasview').dataset.theme = canvasTheme();
  try { await ensureCanvasLib(); } catch (e) { toast('Canvas failed to load'); console.error(e); return; }
  if (activeId !== t.id) return;
  // Excalidraw mounts into a dedicated child so our control bar (a sibling)
  // is never reconciled away by React.
  let mount = document.getElementById('canvas-mount');
  if (!mount) { mount = document.createElement('div'); mount.id = 'canvas-mount'; mount.style.cssText = 'position:absolute;inset:0'; $('canvasview').appendChild(mount); }
  _canvasSuppressUntil = Date.now() + 800;
  if (!window.__canvasMounted) {
    window.SutraCanvas.mount(mount, t.scene, { theme: canvasTheme(), onChange: onCanvasChange });
    window.__canvasMounted = true;
  } else if (_canvasTabId !== t.id) {
    window.SutraCanvas.load(t.scene);
  }
  window.SutraCanvas.setTheme(canvasTheme());
  _canvasTabId = t.id;
  ensureCanvasControls();
  setTimeout(syncCanvasControls, 140);
}

let _ccMode = 'fill'; // what the swatches change: 'fill' (background) or 'stroke'
function applyCanvasColor(color) {
  if (!window.SutraCanvas) return;
  if (_ccMode === 'fill') window.SutraCanvas.setFillColor(color);
  else window.SutraCanvas.setStrokeColor(color);
}

function ensureCanvasControls() {
  if (document.getElementById('canvas-controls')) return;
  const cc = document.createElement('div'); cc.id = 'canvas-controls';
  // background: None / Grid / Dots
  const seg = document.createElement('div'); seg.className = 'cc-seg';
  for (const [v, label] of [['none', 'None'], ['grid', 'Grid'], ['dots', 'Dots']]) {
    const b = document.createElement('button'); b.dataset.bg = v; b.textContent = label;
    b.addEventListener('click', () => { window.SutraCanvas && window.SutraCanvas.setBackground(v); syncCanvasControls(); });
    seg.appendChild(b);
  }
  cc.appendChild(seg);
  cc.appendChild(Object.assign(document.createElement('div'), { className: 'cc-div' }));
  // what the swatches paint: Fill (shape background) or Stroke
  const mode = document.createElement('div'); mode.className = 'cc-seg cc-mode';
  for (const [v, label] of [['fill', 'Fill'], ['stroke', 'Stroke']]) {
    const b = document.createElement('button'); b.dataset.mode = v; b.textContent = label;
    b.addEventListener('click', () => { _ccMode = v; syncCanvasControls(); });
    mode.appendChild(b);
  }
  cc.appendChild(mode);
  // colour strip (transparent first — "no fill")
  const sw = document.createElement('div'); sw.className = 'cc-swatches';
  const clear = document.createElement('button'); clear.className = 'cc-sw cc-clear'; clear.title = 'Transparent';
  clear.addEventListener('click', () => { applyCanvasColor('transparent'); sw.querySelectorAll('.cc-sw').forEach(x => x.classList.remove('sel')); clear.classList.add('sel'); });
  sw.appendChild(clear);
  for (const c of CANVAS_COLORS) {
    const b = document.createElement('button'); b.className = 'cc-sw'; b.style.background = c; b.dataset.color = c; b.title = c;
    b.addEventListener('click', () => {
      applyCanvasColor(c);
      sw.querySelectorAll('.cc-sw').forEach(x => x.classList.remove('sel')); b.classList.add('sel');
    });
    sw.appendChild(b);
  }
  const more = document.createElement('label'); more.className = 'cc-more'; more.title = 'Custom colour';
  more.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>';
  const inp = document.createElement('input'); inp.type = 'color';
  inp.addEventListener('input', () => applyCanvasColor(inp.value));
  more.appendChild(inp); sw.appendChild(more);
  cc.appendChild(sw);
  // close — pinned to the bar's corner (never participates in wrapping)
  const close = document.createElement('button'); close.className = 'cc-close'; close.title = 'Hide this bar';
  close.textContent = '✕';
  close.addEventListener('click', () => { settings.canvasBarHidden = true; saveSettings(); syncCanvasBarVisibility(); });
  cc.appendChild(close);
  $('canvasview').appendChild(cc);
  // reopen chip (shown when the bar is hidden)
  const chip = document.createElement('button'); chip.id = 'canvas-bar-chip'; chip.title = 'Canvas colours & background';
  chip.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="14" cy="7.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="15.5" cy="13" r="1.4" fill="currentColor" stroke="none"/><path d="M12 21a9 9 0 0 1 0-18"/></svg>';
  chip.addEventListener('click', () => { settings.canvasBarHidden = false; saveSettings(); syncCanvasBarVisibility(); });
  $('canvasview').appendChild(chip);
  syncCanvasBarVisibility();
}

function syncCanvasBarVisibility() {
  const cc = document.getElementById('canvas-controls');
  const chip = document.getElementById('canvas-bar-chip');
  if (cc) cc.hidden = !!settings.canvasBarHidden;
  if (chip) chip.hidden = !settings.canvasBarHidden;
}

function syncCanvasControls() {
  const cc = document.getElementById('canvas-controls');
  if (!cc || !window.SutraCanvas) return;
  const bg = window.SutraCanvas.getBackground();
  cc.querySelectorAll('.cc-seg button[data-bg]').forEach(b => b.classList.toggle('sel', b.dataset.bg === bg));
  cc.querySelectorAll('.cc-mode button').forEach(b => b.classList.toggle('sel', b.dataset.mode === _ccMode));
}

function onCanvasChange() {
  if (Date.now() < _canvasSuppressUntil) return;
  const t = tabs.find(x => x.id === _canvasTabId);
  if (!t) return;
  t.scene = window.SutraCanvas.getScene();
  setDirty(t, true);
  if (TAURI && t.path) {                        // autosave only once it has a home
    clearTimeout(t._canvasSaveTimer);
    t._canvasSaveTimer = setTimeout(() => saveCanvas(t), 1000);
  }
}

async function saveCanvas(t) {
  if (!(TAURI && t.path)) return saveCanvasAs(t);
  try {
    const scene = (t.id === _canvasTabId && window.SutraCanvas) ? window.SutraCanvas.getScene() : t.scene;
    t.scene = scene;
    t.mtime = await TAURI.core.invoke('write_file', { path: t.path, contents: JSON.stringify(scene) });
    setDirty(t, false);
  } catch (err) { console.error('canvas save failed', err); toast('Canvas save failed'); }
}

// First save of a new canvas: pick a location, then autosave to it thereafter.
async function saveCanvasAs(t) {
  const scene = (t.id === _canvasTabId && window.SutraCanvas) ? window.SutraCanvas.getScene() : t.scene;
  t.scene = scene;
  const json = JSON.stringify(scene);
  const suggested = (t.name || 'Canvas').replace(/\.(excalidraw|canvas)$/i, '') + '.excalidraw';
  if (TAURI) {
    try {
      const path = await TAURI.core.invoke('plugin:dialog|save', { options: { defaultPath: suggested } });
      if (!path) return false;
      t.mtime = await TAURI.core.invoke('write_file', { path, contents: json });
      t.path = path; t.name = path.split('/').pop();
      setDirty(t, false); renderTabStrip(); recordRecent(t.name, t.path); saveSession();
      return true;
    } catch (err) { console.error(err); toast('Canvas save failed'); return false; }
  }
  await saveTextAs(json, suggested);            // browser fallback: download
  return true;
}

function newCanvas() {
  hideHome();
  addTab({ name: 'Untitled canvas.excalidraw', kind: 'canvas', live: true, scene: blankScene(), path: null });
}

/* ---- AI → Canvas: turn a document into an editable board ---- */

const BOARD_STROKE = ['#b5623a', '#5a6bb0', '#4f8a80', '#8a5a80', '#7a8a4a'];

// Lay out a {label, children} hierarchy as a left→right tree of cards + arrows.
function layoutBoard(root) {
  const CW = 214, CH = 60, HGAP = 96, VGAP = 24;
  const nodes = [], edges = [];
  let leafY = 0, uid = 0;
  const walk = (n, depth, parentId) => {
    const id = 'b' + (uid++);
    const kids = Array.isArray(n.children) ? n.children : [];
    let y;
    if (!kids.length) { y = leafY; leafY += CH + VGAP; }
    else {
      const ys = kids.map(k => walk(k, depth + 1, id));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    const stroke = depth === 0 ? '#1e1e1e' : BOARD_STROKE[(depth - 1) % BOARD_STROKE.length];
    nodes.push({
      id, label: (n.label || '').slice(0, 90), x: depth * (CW + HGAP), y, w: CW, h: CH, depth,
      stroke, text: stroke, fontSize: depth === 0 ? 18 : 15,
      bg: depth === 0 ? colorTint('#b5623a', 0.14) : 'transparent',
    });
    if (parentId != null) edges.push({ from: parentId, to: id });
    return y;
  };
  walk(root, 0, null);
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
  for (const e of edges) {
    const p = byId[e.from], c = byId[e.to];
    e.x = p.x + p.w; e.y = p.y + p.h / 2; e.w = c.x - (p.x + p.w); e.h = (c.y + c.h / 2) - (p.y + p.h / 2);
  }
  return { nodes, edges };
}

async function aiToCanvas() {
  const t = activeTab();
  if (!t || aiBusy) return;
  if (t.kind === 'canvas') { toast('Open a document first, then turn it into a board'); return; }
  aiBusy = true;
  const busyEl = aiMsgEl('info', 'building a canvas board'); busyEl.classList.add('busy');
  try {
    const context = (await docText(t)).slice(0, 350000);
    const raw = await callAI({
      system: 'Turn this document into a visual board as a hierarchy. Root label = the document’s core topic (not the filename). 4–8 main branches = its major sections or themes; each branch has 2–5 concise child points capturing the key ideas. Labels: short, meaningful noun phrases (2–7 words) — not generic section names. Respond as JSON: {"root":{"label":"…","children":[{"label":"…","children":[{"label":"…"}]}]}}',
      messages: [{ role: 'user', content: '<document title="' + t.name + '">\n' + context + '\n</document>' }],
      schema: MAP_SCHEMA,
    });
    const tree = parseJsonLoose(raw).root;
    if (!tree) throw new Error('Could not extract a structure from this document');
    const { nodes, edges } = layoutBoard(tree);
    busyEl.remove();
    // open a fresh canvas tab and draw the board onto it
    addTab({ name: stem(t.name) + ' — board.excalidraw', kind: 'canvas', live: true, scene: blankScene(), path: null });
    const boardTabId = activeId;
    await ensureCanvasLib();
    for (let i = 0; i < 80 && _canvasTabId !== boardTabId; i++) await new Promise(r => setTimeout(r, 80));
    if (window.SutraCanvas && _canvasTabId === boardTabId) {
      _canvasSuppressUntil = Date.now() + 400;
      window.SutraCanvas.buildBoard(nodes, edges);
      const ct = tabs.find(x => x.id === boardTabId);
      if (ct) { ct.scene = window.SutraCanvas.getScene(); setDirty(ct, true); }
      aiMsgEl('info', 'Board created — drag cards to rearrange, style them, and ⌘S to save.');
    } else {
      aiMsgEl('info', '⚠ Canvas didn’t load in time');
    }
    if (mobileMQ.matches) toggleAiPanel(false);
  } catch (err) { busyEl.remove(); aiErrorEl(err); }
  finally { aiBusy = false; }
}

/* ---- Doc ⇄ canvas cross-linking (Phase C) ---- */

// Clicking a card's sutra:// link on the canvas opens the document.
window.SutraCanvasOnLink = (href) => {
  if (!href || !href.startsWith('sutra://open')) return false; // let real URLs behave normally
  try {
    const path = decodeURIComponent(href.split('path=')[1] || '');
    if (path) {
      const existing = tabs.find(x => x.path === path);
      if (existing) switchTab(existing.id);
      else if (TAURI) openTauriPath(path);
      else toast('Linked file opens in the desktop app');
    }
  } catch (err) { console.error('canvas link failed', err); }
  return true;
};

// Add a card for document tab `t` onto canvas tab `ct` (mounting it first).
async function addDocCardToCanvas(ct, t) {
  switchTab(ct.id);
  for (let i = 0; i < 60 && !(window.SutraCanvas && _canvasTabId === ct.id); i++) await new Promise(r => setTimeout(r, 100));
  if (!(window.SutraCanvas && _canvasTabId === ct.id)) { toast('Canvas didn’t load'); return; }
  const ok = window.SutraCanvas.addDocCard({
    name: t.name,
    link: 'sutra://open?path=' + encodeURIComponent(t.path),
    color: badgeFor(t.kind).color,
  });
  if (!ok) return;
  // mark + persist directly (the post-mount onChange guard would swallow this)
  ct.scene = window.SutraCanvas.getScene();
  setDirty(ct, true);
  if (TAURI && ct.path) { clearTimeout(ct._canvasSaveTimer); ct._canvasSaveTimer = setTimeout(() => saveCanvas(ct), 800); }
  toast('Added “' + t.name + '” to the canvas');
}

// "Send to canvas…" — pick an open canvas or spin up a new one.
function sendDocToCanvas(t, ev) {
  if (!t || !t.path || t.kind === 'canvas') return;
  const canvases = tabs.filter(x => x.kind === 'canvas');
  const m = $('assign-menu');
  let html = '<div class="am-label">Send to canvas</div>';
  for (const c of canvases) {
    html += `<button data-cv="${c.id}"><span class="am-dot" style="background:${FORMAT_BADGE.canvas.color}"></span>${escapeHtmlText(c.name)}</button>`;
  }
  html += `<button data-cv="__new"><span class="am-plus">+</span> New canvas</button>`;
  m.innerHTML = html;
  m.querySelectorAll('button[data-cv]').forEach(btn => btn.addEventListener('click', () => {
    m.hidden = true;
    const v = btn.dataset.cv;
    if (v === '__new') { newCanvas(); addDocCardToCanvas(activeTab(), t); }
    else { const ct = tabs.find(x => x.id === +v); if (ct) addDocCardToCanvas(ct, t); }
  }));
  showMenuAt(m, ev && ev.clientX ? ev.clientX : innerWidth / 2, ev && ev.clientY ? ev.clientY : 120);
}

// Save a binary blob (canvas PNG) to disk via the native dialog.
async function saveBlobAs(blob, suggested) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (TAURI) {
    const path = await TAURI.core.invoke('plugin:dialog|save', { options: { defaultPath: suggested } });
    if (!path) return false;
    await TAURI.core.invoke('write_bytes', { path, contents: Array.from(bytes) });
    return true;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = suggested; a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

async function exportCanvas(t, fmt) {
  if (!window.SutraCanvas || _canvasTabId !== t.id) { toast('Open the canvas first'); return; }
  const base = (t.name || 'Canvas').replace(/\.(excalidraw|canvas)$/i, '');
  try {
    if (fmt === 'png') {
      const blob = await window.SutraCanvas.exportPNG(2);
      if (blob && await saveBlobAs(blob, base + '.png')) toast('Exported ' + base + '.png');
    } else if (fmt === 'svg') {
      const svg = await window.SutraCanvas.exportSVG();
      if (svg && await saveTextAs(svg, base + '.svg')) toast('Exported ' + base + '.svg');
    } else if (fmt === 'excalidraw') {
      const json = JSON.stringify(window.SutraCanvas.getScene());
      if (await saveTextAs(json, base + '.excalidraw')) toast('Exported ' + base + '.excalidraw');
    }
  } catch (err) { console.error('canvas export failed', err); toast('Export failed'); }
}

/* ---------- Export / convert ---------- */

const stem = (name) => name.replace(/\.[^.]+$/, '');

function htmlToMarkdown(html) {
  // Pre-pass: turndown short-circuits "blank" elements (no text content) before
  // any custom rule runs, so an empty marker span can never serialize itself.
  // Turn block-id markers into the text turndown will happily carry through.
  if (/vx-bid/.test(html)) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    tmp.querySelectorAll('.vx-bid[data-bid]').forEach(s =>
      s.replaceWith(document.createTextNode(' ^' + s.getAttribute('data-bid'))));
    html = tmp.innerHTML;
  }
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  if (window.turndownPluginGfm) td.use(turndownPluginGfm.gfm);
  // the gfm plugin emits single-tilde ~text~, which markdown-it doesn't parse —
  // without this override an edit round-trip silently un-strikes text
  td.addRule('strikethrough2', { filter: ['del', 's', 'strike'], replacement: (c) => '~~' + c + '~~' });
  // keep <mark> highlights as inline HTML (valid markdown, renders in Sutra)
  td.keep(['mark']);
  // underline has no markdown syntax — round-trip as inline <u> (GFM renders it,
  // and children are still converted so <u>**bold**</u> survives)
  td.addRule('underline', { filter: ['u'], replacement: (c) => c ? '<u>' + c + '</u>' : '' });
  registerBlockRules(td);
  // [[wikilinks]] restore to their source form — a rule (not a text node) so the
  // brackets aren't escaped to \[\[…\]\]
  td.addRule('wikilink', {
    filter: (n) => n.nodeName === 'A' && n.classList.contains('wikilink') && n.hasAttribute('data-wiki'),
    replacement: (content, node) => {
      const target = node.getAttribute('data-wiki');
      const label = (content || '').trim();
      return '[[' + target + (label && label !== target ? '|' + label : '') + ']]';
    },
  });
  // callouts → GitHub-style `> [!type]` blockquote (built directly so the
  // marker isn't escaped to \[!type\])
  td.addRule('callout', {
    filter: (n) => n.nodeName === 'BLOCKQUOTE' && n.classList.contains('callout'),
    replacement: (content, node) => {
      const type = node.getAttribute('data-callout') || 'note';
      const body = content.replace(/^\n+|\n+$/g, '').split('\n').map(l => l ? '> ' + l : '>').join('\n');
      return '\n> [!' + type + ']\n' + body + '\n\n';
    },
  });
  return td.turndown(html);
}

// WKWebView silently ignores window.print(); route through the native panel.
// Also make the OUTPUT print-worthy: swap to a readable theme while the
// panel is open (dark themes print as pale-gray-on-white otherwise), give
// the print job a clean filename, and honor the chosen page size.
function appPrint(opts = {}) {
  const want = opts.theme || 'light';                 // 'light' | 'dark' | 'current'
  const t = activeTab();
  const prevTitle = document.title;
  if (t) document.title = stem(t.name);               // → suggested PDF filename
  // page size + margins + typography (print-only styles)
  const MARGINS = { compact: '8mm', normal: '14mm', wide: '22mm' };
  const margin = MARGINS[opts.margin] || MARGINS.normal;
  // Typography as PRINT-ONLY CSS — immune to any focus/applySettings race
  // that could revert a live DOM swap before the panel renders.
  const FAMS = {
    system: "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif",
    serif: "'Newsreader', 'Iowan Old Style', Georgia, serif",
    mono: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  };
  let ps = document.getElementById('print-page-style');
  if (!ps) { ps = document.createElement('style'); ps.id = 'print-page-style'; document.head.appendChild(ps); }
  ps.textContent = `@page { size: ${opts.page === 'letter' ? 'letter' : 'A4'}; margin: ${margin}; }`
    + (opts.size ? `\n@media print { .markdown-body { font-size: ${opts.size}px !important; } }` : '')
    + (opts.font && FAMS[opts.font] ? `\n@media print { .markdown-body { font-family: ${FAMS[opts.font]} !important; } }` : '');
  // Header/footer as flow blocks at the top and bottom of the printed content.
  // (WebKit's print engine has no reliable per-page running header: @page margin
  // boxes are unsupported, position:fixed paints page 1 only, and a thead/tfoot
  // wrap fragments incorrectly. Flowing blocks are the one mechanism that always
  // renders, so header = document masthead, footer = closing line.)
  // MUST target the reader content by id — when the export dialog is open its
  // preview pane (#export-preview-inner) is also a .markdown-body and comes
  // first in the DOM, so querySelector('.markdown-body') would inject into the
  // preview (hidden at print) and nothing would reach the PDF.
  const body = document.getElementById('content');
  document.getElementById('print-hf-top')?.remove();
  document.getElementById('print-hf-bot')?.remove();
  if (body && opts.header) {
    const h = document.createElement('div');
    h.id = 'print-hf-top'; h.className = 'print-run print-run-top'; h.textContent = opts.header;
    body.insertBefore(h, body.firstChild);
  }
  if (body && opts.footer) {
    const f = document.createElement('div');
    f.id = 'print-hf-bot'; f.className = 'print-run print-run-bot'; f.textContent = opts.footer;
    body.appendChild(f);
  }
  // theme swap (only when the effective base differs from the request)
  const cur = THEMES.find(th => th.key === settings.theme) || THEMES[0];
  const curBase = cur.base === 'system' ? (sysDark.matches ? 'dark' : 'light') : cur.base;
  let prevTheme = null;
  if (want !== 'current' && want !== curBase) {
    prevTheme = settings.theme;
    settings.theme = want === 'dark' ? 'github-dark' : 'github-light';
    applySettings();
  }
  // restore once the print panel closes and the window regains focus.
  // NOTE: do NOT remove the header/footer blocks here — the 'focus' event
  // fires when the native print sheet appears, which would strip them out
  // before the PDF is actually rendered. They're display:none on screen, so
  // they stay harmlessly in #content until the next print() clears them.
  const restore = () => {
    document.title = prevTitle;
    if (prevTheme) { settings.theme = prevTheme; applySettings(); }
  };
  if (TAURI) {
    window.addEventListener('focus', restore, { once: true });
    TAURI.core.invoke('print_page').catch((e) => { toast('Printing unavailable: ' + e); restore(); });
  } else {
    window.print();
    restore();
  }
}

// Returns: true = saved via dialog · a string = saved to that fallback path ·
// false = user cancelled. Throws on write failure.
async function saveTextAs(text, suggested) {
  if (TAURI) {
    try {
      const path = await TAURI.core.invoke('plugin:dialog|save', { options: { defaultPath: suggested } });
      if (!path) return false;                       // user cancelled — not a success
      await TAURI.core.invoke('write_file', { path, contents: text });
      return true;
    } catch (err) {
      // Android has no save dialog — write to a reachable app dir instead
      const dest = await TAURI.core.invoke('save_export', { filename: suggested, contents: text });
      return dest;
    }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = suggested;
    a.click();
    URL.revokeObjectURL(a.href);
    return true;
  }
}

async function buildStandaloneHtml(t, opts = {}) {
  const theme = THEMES.find(th => th.key === settings.theme) || THEMES[0];
  const curDark = theme.base === 'dark' || (theme.base === 'system' && sysDark.matches);
  const dark = opts.theme === 'dark' ? true : opts.theme === 'light' ? false : curDark;
  const cssMd = await (await fetch(dark ? 'vendor/github-markdown-dark.css' : 'vendor/github-markdown-light.css')).text();
  const cssHl = await (await fetch(dark ? 'vendor/hljs-github-dark.css' : 'vendor/hljs-github-light.css')).text();
  const body = t.html || contentEl.innerHTML;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.name}</title>
<style>${cssMd}
${cssHl}
body{margin:0;background:${dark ? '#0d1117' : '#ffffff'};}
.markdown-body{max-width:860px;margin:0 auto;padding:48px 32px;${opts.size ? `font-size:${opts.size}px;` : ''}${FONT_STACKS[opts.font] ? `font-family:${FONT_STACKS[opts.font]};` : ''}}</style>
</head><body><article class="markdown-body">${body}</article></body></html>`;
}

/* ---------- PPTX presentation mode ---------- */

const presentState = { active: false, idx: 0, slides: [] };

function startPresentation() {
  const t = activeTab();
  if (!t || t.kind !== 'pptx' || !t.pagesEl) return;
  presentState.slides = [...t.pagesEl.querySelectorAll('.doc-page')];
  if (!presentState.slides.length) return;
  presentState.active = true;
  presentState.idx = currentPage(t) - 1 || 0;
  $('present-overlay').hidden = false;
  renderPresent();
  try { $('present-overlay').requestFullscreen && $('present-overlay').requestFullscreen(); } catch (_) {}
}

// --- Markdown → slide deck ---
// Split a markdown doc into slide fragments: explicit `---` separators, else
// fall back to splitting at each top-level (# / ##) heading so any doc presents.
function buildMdSlides(t) {
  let src = (t.text || '');
  src = src.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, ''); // drop YAML frontmatter
  let parts = src.split(/\r?\n[ \t]*---+[ \t]*(?=\r?\n)/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) {
    // no explicit breaks — one slide per top heading (keep any preamble as slide 1)
    const chunks = []; let cur = [];
    for (const line of src.split(/\r?\n/)) {
      if (/^#{1,2}\s/.test(line) && cur.some(l => l.trim())) { chunks.push(cur.join('\n')); cur = []; }
      cur.push(line);
    }
    if (cur.length) chunks.push(cur.join('\n'));
    parts = chunks.map(s => s.trim()).filter(Boolean);
  }
  return parts;
}
function mdSlideEls(frags) {
  return frags.map((frag) => {
    const el = document.createElement('div');
    el.className = 'doc-page slide-md';
    const body = document.createElement('div');
    body.className = 'markdown-body';
    body.innerHTML = DOMPurify.sanitize(md.render(frag));
    el.appendChild(body);
    return el;
  });
}
function startMdPresentation() {
  const t = activeTab();
  if (!t || !TEXT_KINDS.includes(t.kind)) { toast('Open a Markdown document to present'); return; }
  const frags = buildMdSlides(t);
  if (!frags.length) { toast('Nothing to present'); return; }
  presentState.slides = mdSlideEls(frags);
  presentState.active = true;
  presentState.idx = 0;
  $('present-overlay').hidden = false;
  $('present-overlay').classList.add('md-deck');
  renderPresent();
  try { $('present-overlay').requestFullscreen && $('present-overlay').requestFullscreen(); } catch (_) {}
}

function renderPresent() {
  const stage = $('present-stage');
  stage.innerHTML = '';
  const slide = presentState.slides[presentState.idx];
  if (slide) { const c = slide.cloneNode(true); c.classList.add('present-slide'); stage.appendChild(c); }
  const n = presentState.slides.length;
  $('present-count').textContent = `${presentState.idx + 1} / ${n}`;
  // dots
  const dots = $('present-dots'); dots.innerHTML = '';
  for (let i = 0; i < n; i++) { const d = document.createElement('span'); d.className = 'p-dot' + (i === presentState.idx ? ' on' : ''); d.addEventListener('click', () => { presentState.idx = i; renderPresent(); }); dots.appendChild(d); }
  // next thumb
  const nt = $('present-next-thumb'); nt.innerHTML = '';
  if (presentState.idx + 1 < n) { const c = presentState.slides[presentState.idx + 1].cloneNode(true); c.classList.add('present-thumb'); nt.appendChild(c); }
}

function presentNav(d) {
  presentState.idx = Math.max(0, Math.min(presentState.slides.length - 1, presentState.idx + d));
  renderPresent();
}

function exitPresentation() {
  presentState.active = false;
  $('present-overlay').hidden = true;
  $('present-overlay').classList.remove('md-deck');
  try { document.fullscreenElement && document.exitFullscreen(); } catch (_) {}
}

function wirePresent() {
  $('present-prev').addEventListener('click', () => presentNav(-1));
  $('present-next').addEventListener('click', () => presentNav(1));
  $('present-exit').addEventListener('click', exitPresentation);
  document.addEventListener('keydown', (e) => {
    if (!presentState.active) return;
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); presentNav(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); presentNav(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); exitPresentation(); }
  });
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  let el = $('mv-toast');
  if (!el) { el = document.createElement('div'); el.id = 'mv-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
}

// Toast with an action button — used as an Undo affordance for destructive actions
function toastAction(msg, actionLabel, onAction, ms = 8000) {
  let el = $('mv-toast');
  if (!el) { el = document.createElement('div'); el.id = 'mv-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  const b = document.createElement('button');
  b.className = 'toast-act'; b.textContent = actionLabel;
  b.addEventListener('click', () => { el.classList.remove('show'); clearTimeout(toastTimer); onAction(); });
  el.appendChild(b);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------- Export dialog (format list · options · live preview) ---------- */

const IS_ANDROID = /android/i.test(navigator.userAgent);
const EXPORT_FORMATS = [
  // canvas formats (real, via the Excalidraw bridge)
  { id: 'png', label: 'PNG image', desc: 'Rasterised canvas @2×', icon: 'doc', when: t => t.kind === 'canvas' },
  { id: 'svg', label: 'SVG image', desc: 'Vector canvas', icon: 'doc', when: t => t.kind === 'canvas' },
  { id: 'excalidraw', label: 'Excalidraw', desc: 'Editable .excalidraw copy', icon: 'canvas', when: t => t.kind === 'canvas' },
  // document formats
  { id: 'pdf', label: 'PDF', desc: 'Print-ready, themed', icon: 'doc', when: t => !IS_ANDROID && t.kind !== 'canvas' },
  { id: 'html', label: 'HTML', desc: 'Self-contained page', icon: 'doc', when: t => t.kind !== 'pptx' && t.kind !== 'canvas' },
  { id: 'md', label: 'Markdown', desc: 'Portable .md', icon: 'doc', when: t => t.kind !== 'canvas' },
  { id: 'csv', label: 'CSV', desc: 'First sheet, comma-separated', icon: 'doc', when: t => t.kind === 'sheet' },
  { id: 'docx', label: 'Word', desc: 'Best-effort .docx', icon: 'doc', pandoc: true, soon: true },
  { id: 'epub', label: 'EPUB', desc: 'E-reader book', icon: 'book', pandoc: true, soon: true },
];
const exportState = { fmt: 'pdf', font: 'current', size: 16, margin: 'normal', header: '', footer: '' };
const FONT_STACKS = {
  system: "'Hanken Grotesk', -apple-system, sans-serif",
  serif: "'Newsreader', Georgia, serif",
  mono: "'Geist Mono', ui-monospace, monospace",
};

function openExportDialog() {
  const t = activeTab();
  if (!t) return;
  const avail = EXPORT_FORMATS.filter(f => !f.soon && (!f.when || f.when(t)));
  exportState.fmt = (t.kind === 'sheet') ? 'csv' : (avail[0] ? avail[0].id : 'md');
  // restore last-used typography/layout; header & footer start fresh per doc
  const prefs = settings.exportPrefs || {};
  exportState.font = prefs.font || 'current';
  exportState.size = prefs.size || settings.fontSize || 16;
  exportState.header = ''; exportState.footer = '';
  $('exp-header').value = ''; $('exp-footer').value = '';
  document.querySelectorAll('#exp-font button').forEach(b => b.classList.toggle('sel', b.dataset.v === exportState.font));
  document.querySelectorAll('#exp-margin button').forEach(b => b.classList.toggle('sel', b.dataset.v === (prefs.margin || 'normal')));
  document.querySelectorAll('#exp-page button').forEach(b => b.classList.toggle('sel', b.dataset.v === (prefs.page || 'a4')));
  buildHfChips('exp-header-chips', 'exp-header');
  buildHfChips('exp-footer-chips', 'exp-footer');
  // format list — only formats that apply to this document kind
  const fl = $('export-formats'); fl.innerHTML = '';
  for (const f of EXPORT_FORMATS) {
    if (f.when && !f.when(t)) continue;
    const b = document.createElement('button');
    b.className = 'exp-fmt' + (f.id === exportState.fmt ? ' sel' : '') + (f.soon ? ' soon' : '');
    b.dataset.fmt = f.id;
    b.innerHTML = `<span class="exp-fmt-ic">${svgIcon(f.icon)}</span><span class="exp-fmt-txt"><b>${f.label}</b><em>${f.desc}</em></span>${f.pandoc ? '<span class="exp-tag">pandoc</span>' : ''}${f.soon ? '<span class="exp-tag soon">soon</span>' : ''}`;
    b.addEventListener('click', () => { if (f.soon) return; exportState.fmt = f.id; syncExportDialog(); });
    fl.appendChild(b);
  }
  $('export-overlay').hidden = false;
  syncExportDialog();
}

// Auto-suggestions for header/footer — resolved from the open document
function exportSuggestions() {
  const t = activeTab();
  const list = [];
  const h1 = contentEl.querySelector('h1');
  if (h1 && h1.textContent.trim()) list.push({ label: 'Title', value: h1.textContent.trim() });
  if (t) list.push({ label: 'File name', value: stem(t.name) });
  list.push({ label: 'Date', value: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) });
  if (settings.profileName) list.push({ label: settings.profileName, value: settings.profileName });
  list.push({ label: 'Confidential', value: 'Confidential' });
  return list;
}

function buildHfChips(chipsId, inputId) {
  const host = $(chipsId); host.innerHTML = '';
  for (const s of exportSuggestions()) {
    const b = document.createElement('button');
    b.className = 'exp-chip'; b.textContent = s.label; b.title = s.value;
    b.addEventListener('click', () => {
      const input = $(inputId);
      input.value = input.value.trim() ? input.value.trim() + '  ·  ' + s.value : s.value;
      exportState[inputId === 'exp-header' ? 'header' : 'footer'] = input.value;
    });
    host.appendChild(b);
  }
}

function syncExportDialog() {
  const t = activeTab();
  $('export-formats').querySelectorAll('.exp-fmt').forEach(b => b.classList.toggle('sel', b.dataset.fmt === exportState.fmt));
  const isPdf = exportState.fmt === 'pdf';
  const isHtmlish = exportState.fmt === 'pdf' || exportState.fmt === 'html';
  $('exp-theme-group').style.display = isHtmlish ? '' : 'none';
  $('exp-font-group').style.display = isHtmlish ? '' : 'none';
  $('exp-size-group').style.display = isHtmlish ? '' : 'none';
  $('exp-page-group').style.display = isPdf ? '' : 'none';
  $('exp-margin-group').style.display = isPdf ? '' : 'none';
  $('exp-hf-group').style.display = isPdf ? '' : 'none';
  $('export-preview').style.display = isHtmlish ? '' : 'none';
  const f = EXPORT_FORMATS.find(x => x.id === exportState.fmt);
  $('exp-note').textContent = f.pandoc ? 'Needs the optional pandoc helper for full fidelity.' : '';
  $('export-dest').textContent = `${stem(t.name)}.${exportState.fmt === 'md' ? 'md' : exportState.fmt}`;
  $('exp-fs-val').textContent = exportState.size + 'px';
  // live preview (mini render of the doc) — reflects font + size choices
  if (isHtmlish) {
    const inner = $('export-preview-inner');
    inner.className = 'markdown-body';
    inner.innerHTML = (t.html || contentEl.innerHTML || '').slice(0, 4000);
    const fam = FONT_STACKS[exportState.font] || '';
    inner.style.fontFamily = fam;
    inner.style.fontSize = exportState.size + 'px';
  }
}

function wireExportDialog() {
  $('export-close').addEventListener('click', () => { $('export-overlay').hidden = true; });
  $('export-cancel').addEventListener('click', () => { $('export-overlay').hidden = true; });
  $('export-overlay').addEventListener('mousedown', (e) => { if (e.target === $('export-overlay')) $('export-overlay').hidden = true; });
  document.querySelectorAll('#exp-theme button, #exp-page button, #exp-font button, #exp-margin button').forEach(b => b.addEventListener('click', () => {
    b.parentElement.querySelectorAll('button').forEach(x => x.classList.remove('sel')); b.classList.add('sel');
    if (b.parentElement.id === 'exp-font') { exportState.font = b.dataset.v; syncExportDialog(); }
  }));
  $('exp-fs-minus').addEventListener('click', () => { exportState.size = Math.max(10, exportState.size - 1); syncExportDialog(); });
  $('exp-fs-plus').addEventListener('click', () => { exportState.size = Math.min(22, exportState.size + 1); syncExportDialog(); });
  $('exp-header').addEventListener('input', (e) => { exportState.header = e.target.value; });
  $('exp-footer').addEventListener('input', (e) => { exportState.footer = e.target.value; });
  $('export-go').addEventListener('click', () => {
    const fmt = exportState.fmt;
    const opts = {
      theme: document.querySelector('#exp-theme .sel')?.dataset.v || 'light',
      page: document.querySelector('#exp-page .sel')?.dataset.v || 'a4',
      margin: document.querySelector('#exp-margin .sel')?.dataset.v || 'normal',
      font: exportState.font, size: exportState.size,
      header: exportState.header.trim(), footer: exportState.footer.trim(),
    };
    // remember for next time
    settings.exportPrefs = { font: opts.font, size: opts.size, margin: opts.margin, page: opts.page };
    saveSettings();
    $('export-overlay').hidden = true;
    if (fmt === 'pdf') appPrint(opts);
    else exportActive(fmt, opts);
  });
}

async function exportActive(fmt, opts = {}) {
  const t = activeTab();
  if (!t) return;
  if (t.kind === 'canvas') { await exportCanvas(t, fmt); return; }
  if (fmt === 'docx' || fmt === 'epub') { toast('“' + fmt.toUpperCase() + '” export needs the pandoc helper (coming soon)'); return; }
  try {
    let result;
    if (fmt === 'md') {
      const text = TEXT_KINDS.includes(t.kind) ? (t.text || '')
        : t.mdText ? t.mdText
        : t.kind === 'pdf' ? await pdfToMarkdown(t)
        : htmlToMarkdown(t.html || contentEl.innerHTML);
      if (!text.trim()) { toast('Nothing to export — this document has no extractable text'); return; }
      result = await saveTextAs(text, stem(t.name) + '.md');
    } else if (fmt === 'html') {
      if (PAGED_KINDS.includes(t.kind) && t.kind !== 'pdf') { toast('HTML export isn’t available for slides yet'); return; }
      const source = t.kind === 'pdf'
        ? { ...t, html: DOMPurify.sanitize(md.render(await pdfToMarkdown(t))) }
        : t;
      result = await saveTextAs(await buildStandaloneHtml(source, opts), stem(t.name) + '.html');
    } else if (fmt === 'csv') {
      if (t.kind !== 'sheet' || !t.bytes) { toast('CSV export works on spreadsheets only'); return; }
      const wb = XLSX.read(t.bytes, { type: 'array' });
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
      result = await saveTextAs(csv, stem(t.name) + '.csv');
    }
    if (result === false) return;                       // cancelled — say nothing
    if (typeof result === 'string') toast('Saved to ' + result);
    else toast('Exported ' + stem(t.name) + '.' + fmt);
  } catch (err) {
    toast('Export failed: ' + (err && err.message || err));
  }
}

/* ---------- PDF → Markdown reading mode ---------- */

async function pdfToMarkdown(t) {
  if (!t._doc) return '';
  const doc = t._doc;
  const out = [];
  const maxP = Math.min(doc.numPages, 300);
  for (let p = 1; p <= maxP; p++) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const lines = new Map();
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = Math.round(it.transform[5] / 2) * 2;
        const size = Math.hypot(it.transform[2], it.transform[3]);
        const l = lines.get(y) || { size: 0, parts: [] };
        l.size = Math.max(l.size, size);
        l.parts.push({ x: it.transform[4], s: it.str });
        lines.set(y, l);
      }
      const ordered = [...lines.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, l]) => ({
          size: l.size,
          text: l.parts.sort((a, b) => a.x - b.x).map(pt => pt.s).join(' ').replace(/\s+/g, ' ').trim(),
        }))
        .filter(l => l.text);
      if (!ordered.length) continue;
      const sizes = ordered.map(l => l.size).sort((a, b) => a - b);
      const med = sizes[Math.floor(sizes.length / 2)];
      let para = [];
      const flush = () => { if (para.length) { out.push(para.join(' '), ''); para = []; } };
      for (const l of ordered) {
        const bullet = /^[•·▪‣]\s*/.test(l.text) || /^[-–]\s+/.test(l.text);
        if (l.size >= med * 1.6 && l.text.length < 120) { flush(); out.push('# ' + l.text, ''); }
        else if (l.size >= med * 1.25 && l.text.length < 140) { flush(); out.push('## ' + l.text, ''); }
        else if (bullet) { flush(); out.push('- ' + l.text.replace(/^([•·▪‣]|[-–])\s*/, '')); }
        else para.push(l.text);
      }
      flush();
    } catch (_) {}
  }
  return out.join('\n');
}

async function openReadingMode() {
  const t = activeTab();
  if (!t || t.kind !== 'pdf' || !t._doc) return;
  const mdText = await pdfToMarkdown(t);
  if (!mdText.trim()) return;
  const tab = await makeTab({ name: stem(t.name) + ' — reading.md', mtime: 0 }, 'md', { text: mdText });
  tab.live = false;
  tab.mdText = mdText;
  addTab(tab);
}

/* ---------- Folder mode ---------- */

async function openFolder(root) {
  if (!TAURI) return;
  if (!root) {
    root = await TAURI.core.invoke('plugin:dialog|open', { options: { directory: true, multiple: false } });
    if (!root) return;
  }
  try {
    const tree = await TAURI.core.invoke('list_dir_tree', { path: root });
    folder = { root, tree };
    pageIndex.dirty = true;                 // vault changed → re-index page titles
    settings.lastFolder = root;
    saveSettings();
    sideMode = 'files';
    renderFileTree();
    updateSidebar();
    diag('folder open: entries=' + tree.length + ' root=' + root);
  } catch (err) { console.error('open folder failed', err); diag('folder open failed: ' + err); }
}

function closeFolder() {
  folder = null;
  delete settings.lastFolder;
  saveSettings();
  sideMode = 'toc';
  graphOpen = false;
  updateSidebar();
  renderActive();
}

function renderFileTree() {
  const host = $('filetree');
  host.innerHTML = '';
  if (!folder) return;
  const head = document.createElement('div');
  head.className = 'ft-head';
  head.innerHTML = `<span class="ft-root"></span>
    <button class="icon-btn" id="ft-graph" title="Knowledge graph (⌘G)">◉</button>
    <button class="icon-btn" id="ft-close" title="Close folder">✕</button>`;
  head.querySelector('.ft-root').textContent = folder.root.split('/').pop();
  host.appendChild(head);
  const build = (entries, parent) => {
    for (const e of entries) {
      if (e.dir) {
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = e.name;
        det.appendChild(sum);
        build(e.children, det);
        parent.appendChild(det);
      } else {
        const btn = document.createElement('button');
        btn.className = 'ft-file';
        btn.textContent = e.name;
        btn.dataset.path = e.path;
        btn.addEventListener('click', () => openTauriPath(e.path));
        parent.appendChild(btn);
      }
    }
  };
  build(folder.tree, host);
  head.querySelector('#ft-graph').addEventListener('click', toggleGraph);
  head.querySelector('#ft-close').addEventListener('click', closeFolder);
  markActiveFile();
}

function markActiveFile() {
  const t = activeTab();
  document.querySelectorAll('#filetree .ft-file').forEach(b => {
    const on = !!(t && t.path === b.dataset.path);
    b.classList.toggle('active', on);
    if (on) { let p = b.parentElement; while (p && p.tagName === 'DETAILS') { p.open = true; p = p.parentElement; } }
  });
}

/* ---------- Knowledge graph (⌘G) ---------- */

let graphOpen = false;
let graphSim = null;

function toggleGraph() {
  if (!folder) {
    // no folder open → the graph has nothing to draw; say so instead of dying silently
    toast('Knowledge graph needs a folder — open one first (⌘⇧O)');
    if (TAURI && typeof openFolder === 'function') openFolder();
    return;
  }
  graphOpen = !graphOpen;
  if (graphOpen) renderGraph(); else renderActive();
}

function flatMdFiles(entries, out = []) {
  for (const e of entries) {
    if (e.dir) flatMdFiles(e.children, out);
    else if (/\.(md|markdown|mdown)$/i.test(e.name)) out.push(e);
  }
  return out;
}

async function buildGraphData() {
  const files = flatMdFiles(folder.tree).slice(0, 200);
  const byName = new Map();   // lowercase stem and name → path
  for (const f of files) {
    byName.set(f.name.toLowerCase(), f.path);
    byName.set(stem(f.name).toLowerCase(), f.path);
  }
  const nodes = files.map(f => ({ id: f.path, label: stem(f.name), links: 0 }));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = [];
  for (const f of files) {
    let text = '';
    try { text = (await TAURI.core.invoke('read_md_file', { path: f.path })).text; } catch (_) { continue; }
    const dir = f.path.slice(0, f.path.lastIndexOf('/'));
    const targets = new Set();
    for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
      const p = byName.get(m[1].trim().toLowerCase());
      if (p && p !== f.path) targets.add(p);
    }
    for (const m of text.matchAll(/\]\(([^)#\s]+\.(?:md|markdown|mdown))\)/gi)) {
      const rel = decodeURIComponent(m[1]);
      const abs = rel.startsWith('/') ? rel : dir + '/' + rel;
      const norm = abs.split('/').reduce((a, seg) => {
        if (seg === '..') a.pop(); else if (seg !== '.') a.push(seg);
        return a;
      }, []).join('/');
      if (nodeIds.has(norm) && norm !== f.path) targets.add(norm);
    }
    for (const target of targets) edges.push({ source: f.path, target });
  }
  const deg = new Map();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) || 0) + 1);
    deg.set(e.target, (deg.get(e.target) || 0) + 1);
  }
  nodes.forEach(n => { n.links = deg.get(n.id) || 0; });
  return { nodes, edges };
}

async function renderGraph() {
  clearToc();
  showPane('graph');
  const svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();
  if (graphSim) { graphSim.stop(); graphSim = null; }
  const { nodes, edges } = await buildGraphData();
  diag('graph: nodes=' + nodes.length + ' edges=' + edges.length);
  if (!graphOpen) return;
  const w = $('graphview').clientWidth || 900;
  const h = $('graphview').clientHeight || 600;
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.3, 4]).on('zoom', (ev) => g.attr('transform', ev.transform)));
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const link = g.append('g').selectAll('line').data(edges).join('line').attr('stroke-width', 1.2);
  const node = g.append('g').selectAll('g').data(nodes).join('g');
  node.append('circle')
    .attr('r', d => 5 + Math.min(9, d.links * 1.6))
    .attr('fill', d => d.links ? accent : 'color-mix(in srgb, currentColor 40%, transparent)')
    .on('click', (_, d) => { graphOpen = false; openTauriPath(d.id); });
  node.append('text').attr('dy', -12).attr('text-anchor', 'middle').text(d => d.label.slice(0, 28));
  node.call(d3.drag()
    .on('start', (ev, d) => { if (!ev.active) graphSim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
    .on('end', (ev, d) => { if (!ev.active) graphSim.alphaTarget(0); d.fx = null; d.fy = null; }));
  graphSim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(90))
    .force('charge', d3.forceManyBody().strength(-220))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collide', d3.forceCollide(26))
    .on('tick', () => {
      link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
      node.attr('transform', d => `translate(${d.x},${d.y})`);
    });
}

/* ---------- AI assistant (⌘J) ---------- */

// Provider presets. `format` picks the request/response shape:
//   'anthropic' → /v1/messages (x-api-key)
//   'openai'    → /v1/chat/completions (Bearer) — the de-facto standard that
//                 OpenAI, Google, Ollama, LM Studio, OpenRouter, Groq, etc. all speak.
const AI_PRESETS = {
  anthropic: { format: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-opus-4-8', keyHint: 'sk-ant-…', note: 'Get a key at console.anthropic.com.' },
  openai:    { format: 'openai',    base: 'https://api.openai.com/v1',     model: 'gpt-4o',          keyHint: 'sk-…',     note: 'Get a key at platform.openai.com.' },
  google:    { format: 'openai',    base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyHint: 'AIza…', note: 'Gemini via its OpenAI-compatible endpoint. Key at aistudio.google.com.' },
  openrouter:{ format: 'openai',    base: 'https://openrouter.ai/api/v1',  model: 'anthropic/claude-opus-4.8', keyHint: 'sk-or-…', note: 'One key, hundreds of models. openrouter.ai/keys.' },
  groq:      { format: 'openai',    base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyHint: 'gsk_…', note: 'Very fast inference. console.groq.com.' },
  deepseek:  { format: 'openai',    base: 'https://api.deepseek.com/v1',   model: 'deepseek-chat',   keyHint: 'sk-…',     note: 'platform.deepseek.com.' },
  mistral:   { format: 'openai',    base: 'https://api.mistral.ai/v1',     model: 'mistral-large-latest', keyHint: '…',   note: 'console.mistral.ai.' },
  ollama:    { format: 'openai',    base: 'http://localhost:11434/v1',     model: 'llama3.1',        keyHint: '(none)',   note: 'Local, private, free. Run: ollama serve.' },
  lmstudio:  { format: 'openai',    base: 'http://localhost:1234/v1',      model: 'local-model',     keyHint: '(none)',   note: 'Local server in LM Studio → Developer tab.' },
  custom:    { format: 'openai',    base: '',                              model: '',                keyHint: '…',        note: 'Any OpenAI-compatible endpoint. Set the base URL and model above.' },
};
const AI_MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']; // legacy fallback
const MAP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['root'],
  properties: {
    root: {
      type: 'object', additionalProperties: false, required: ['label', 'children'],
      properties: {
        label: { type: 'string' },
        children: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['label', 'children'],
            properties: {
              label: { type: 'string' },
              children: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
  },
};

async function docText(t) {
  if (!t) return '';
  if (TEXT_KINDS.includes(t.kind)) return t.text || '';
  if (t.kind === 'pdf') return await pdfToMarkdown(t);
  if (t.kind === 'pptx') return t.pagesEl ? t.pagesEl.textContent : '';
  return t.html ? htmlToMarkdown(t.html) : '';
}

function aiConfig() {
  const providerKey = settings.aiProvider || 'anthropic';
  const preset = AI_PRESETS[providerKey] || AI_PRESETS.anthropic;
  return {
    format: preset.format,
    base: (settings.aiBase || preset.base || '').replace(/\/+$/, ''),
    model: (settings.aiModel || preset.model || '').trim(),
    key: (settings.aiKey || '').trim(),
    local: /localhost|127\.0\.0\.1/.test(settings.aiBase || preset.base || ''),
  };
}

// POST JSON to an AI endpoint. In the Tauri app this goes through Rust
// (no CORS, no ATS block on http://localhost, keys never touch a page origin);
// in the browser preview it falls back to direct fetch.
async function aiPost(url, headers, bodyObj) {
  const body = JSON.stringify(bodyObj);
  if (TAURI) {
    const r = await TAURI.core.invoke('ai_fetch', { url, headers, body });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: r.body };
  }
  const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { ok: resp.ok, status: resp.status, text: await resp.text() };
}

// Unified LLM call. `schema` requests JSON output; if the endpoint can't honor
// a schema natively we fall back to prompt-instructed JSON (parsed leniently),
// so ANY provider — cloud or local — works.
async function callAI({ system, messages, schema }) {
  const cfg = aiConfig();
  if (!cfg.model) throw new Error('No model set — choose a provider and model in Settings');
  if (!cfg.key && !cfg.local) throw new Error('No API key — add one in Settings');
  if (!cfg.base) throw new Error('No API base URL — set one in Settings');

  if (cfg.format === 'anthropic') {
    const body = { model: cfg.model, max_tokens: 8192, system, messages };
    if (schema) body.output_config = { format: { type: 'json_schema', schema } };
    const r = await aiPost(cfg.base + '/messages', {
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }, body);
    if (!r.ok) throw new Error(apiErr(r));
    const data = JSON.parse(r.text);
    if (data.stop_reason === 'refusal') throw new Error('The model declined this request.');
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }

  // openai-compatible
  const authHeaders = cfg.key ? { authorization: 'Bearer ' + cfg.key } : {};
  const body = { model: cfg.model, max_tokens: 8192, messages: [{ role: 'system', content: system }, ...messages] };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema, strict: true } };
  let r = await aiPost(cfg.base + '/chat/completions', authHeaders, body);
  // some OpenAI-compatible servers reject json_schema — retry with plain prompt
  if (!r.ok && schema) {
    delete body.response_format;
    body.messages = [{ role: 'system', content: system + '\n\nReturn ONLY valid minified JSON, no prose, no code fences.' }, ...messages];
    r = await aiPost(cfg.base + '/chat/completions', authHeaders, body);
  }
  if (!r.ok) throw new Error(apiErr(r));
  const data = JSON.parse(r.text);
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('Empty response from model.');
  if (choice.finish_reason === 'content_filter') throw new Error('The model declined this request.');
  return (choice.message && choice.message.content) || '';
}

function apiErr(r) {
  let msg = 'API error ' + r.status;
  try {
    const j = JSON.parse(r.text);
    msg = (j.error && (j.error.message || j.error)) || j.message || msg;
  } catch (_) {
    if (r.status === 404) msg += ' — check the base URL';
    else if (r.text) msg = r.text.slice(0, 200);
  }
  if (r.status === 401 || r.status === 403) msg = 'Unauthorized — check your API key';
  return typeof msg === 'string' ? msg : JSON.stringify(msg);
}

// tolerant JSON extraction for schema-less fallbacks
function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  throw new Error('Model did not return valid JSON.');
}

function aiMsgEl(role, content) {
  const div = document.createElement('div');
  div.className = 'ai-msg ' + role;
  if (role === 'assistant') {
    const label = document.createElement('div');
    label.className = 'ai-label';
    label.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/></svg> Vedrix';
    div.appendChild(label);
    const inner = document.createElement('div');
    inner.className = 'markdown-body';
    inner.innerHTML = DOMPurify.sanitize(md.render(content));
    div.appendChild(inner);
    // Insert-as-note / Copy actions on completed replies
    const actions = document.createElement('div');
    actions.className = 'ai-actions';
    const insert = document.createElement('button'); insert.textContent = 'Insert as note';
    insert.addEventListener('click', () => aiInsertAsNote(content));
    const copy = document.createElement('button'); copy.textContent = 'Copy';
    copy.addEventListener('click', () => { navigator.clipboard.writeText(content).then(() => toast('Copied')); });
    actions.append(insert, copy);
    div.appendChild(actions);
  } else {
    div.textContent = content;
  }
  $('ai-messages').appendChild(div);
  $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
  return div;
}

// Insert an AI reply as a callout note into the current markdown document
function aiInsertAsNote(content) {
  const t = activeTab();
  if (!t || !(t.kind === 'md' || t.kind === 'text')) { toast('Open a markdown doc to insert notes'); return; }
  if (!t.editing) toggleEdit();
  setTimeout(() => {
    if (!isRichEditing()) return;
    const bq = document.createElement('blockquote');
    bq.className = 'callout'; bq.dataset.callout = 'note';
    const head = document.createElement('div'); head.className = 'callout-head'; head.contentEditable = 'false';
    head.textContent = '📝 Note'; bq.appendChild(head);
    const body = document.createElement('div'); body.innerHTML = DOMPurify.sanitize(md.render(content)); bq.appendChild(body);
    execEditorCmd(() => insertBlockAfterCurrent(bq));
    onRichInput();
    toast('Inserted as a note');
  }, t.editing ? 0 : 350);
}

function renderAiChat() {
  const t = activeTab();
  $('ai-messages').innerHTML = '';
  const chat = (t && t.aiChat) || [];
  for (const m of chat) aiMsgEl(m.role, m.content);
  // No provider configured → show a setup card instead of letting the user
  // type a question that can only fail.
  if (!chat.length) {
    const cfg = aiConfig();
    if (!cfg.model || !cfg.base || (!cfg.key && !cfg.local)) {
      const card = document.createElement('div');
      card.className = 'ai-setup';
      card.innerHTML = `
        <div class="ai-setup-ic"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z"/></svg></div>
        <div class="ai-setup-t">Connect an AI provider</div>
        <div class="ai-setup-d">Chat with your documents, summarize, translate, and build concept maps. Works with Claude, OpenAI, Gemini — or free local models via Ollama.</div>`;
      const b = document.createElement('button');
      b.className = 'btn-accent'; b.textContent = 'Open AI settings';
      b.addEventListener('click', openAiSettings);
      card.appendChild(b);
      $('ai-messages').appendChild(card);
    }
  }
}

// Deep-link into Settings → AI assistant
function openAiSettings() {
  $('settings-overlay').hidden = false;
  showSettingsSection('ai');
  if (mobileMQ.matches) toggleAiPanel(false); // panel is full-screen on mobile; get it out of the way
}

// Error row with a fix-it button when the problem is fixable in Settings
function aiErrorEl(err) {
  const el = aiMsgEl('info', '⚠ ' + err.message);
  if (/settings/i.test(err.message)) {
    const b = document.createElement('button');
    b.className = 'ai-fixbtn'; b.textContent = 'Open AI settings';
    b.addEventListener('click', openAiSettings);
    el.appendChild(b);
  }
  return el;
}

let aiBusy = false;
async function aiAsk(userText, { system, transient } = {}) {
  const t = activeTab();
  if (!t || aiBusy) return;
  aiBusy = true;
  t.aiChat = t.aiChat || [];
  if (!transient) { t.aiChat.push({ role: 'user', content: userText }); aiMsgEl('user', userText); }
  const busyEl = aiMsgEl('info', 'thinking'); busyEl.classList.add('busy');
  try {
    const context = (await docText(t)).slice(0, 350000);
    const sys = (system || 'You are a reading assistant inside a document viewer. Answer using the document below. Be concise and specific; quote sparingly.')
      + '\n\n<document title="' + t.name + '">\n' + context + '\n</document>';
    const msgs = t.aiChat.length ? t.aiChat.map(m => ({ role: m.role, content: m.content })) : [{ role: 'user', content: userText }];
    const answer = await callAI({ system: sys, messages: msgs });
    busyEl.remove();
    t.aiChat.push({ role: 'assistant', content: answer });
    aiMsgEl('assistant', answer);
  } catch (err) {
    busyEl.remove();
    aiErrorEl(err);
    if (!transient) t.aiChat.pop();
  } finally { aiBusy = false; }
}

async function aiConceptMap() {
  const t = activeTab();
  if (!t || aiBusy) return;
  aiBusy = true;
  const busyEl = aiMsgEl('info', 'building concept map'); busyEl.classList.add('busy');
  try {
    const context = (await docText(t)).slice(0, 350000);
    const raw = await callAI({
      system: 'Extract the conceptual structure of the document as a mind map. Root label = the core topic (not the filename). 4-8 first-level concepts, each with 2-6 sub-concepts. Labels must be short (2-6 words) and capture meaning, not section names. Respond as JSON: {"root":{"label":"…","children":[{"label":"…","children":[{"label":"…"}]}]}}',
      messages: [{ role: 'user', content: '<document title="' + t.name + '">\n' + context + '\n</document>' }],
      schema: MAP_SCHEMA,
    });
    const tree = parseJsonLoose(raw).root;
    const convert = (n) => ({ content: escHtml(n.label), children: (n.children || []).map(convert) });
    t.aiTree = convert(tree);
    t.mapSource = 'ai';
    t.viewMode = 'map';
    busyEl.remove();
    aiMsgEl('info', 'Concept map ready — shown in the map view (⌘M toggles back to reading).');
    renderActive();
  } catch (err) {
    busyEl.remove();
    aiErrorEl(err);
  } finally { aiBusy = false; }
}

// In-app language picker (window.prompt breaks the design and is a no-op in some webviews)
const LANG_SUGGESTIONS = ['English', 'Hindi', 'Spanish', 'French', 'German', 'Japanese', 'Chinese'];
function askLanguage() {
  return new Promise((resolve) => {
    const ov = $('lang-overlay'), input = $('lang-input');
    const chips = $('lang-chips'); chips.innerHTML = '';
    const langs = [...new Set([settings.aiLastLang, ...LANG_SUGGESTIONS].filter(Boolean))].slice(0, 7);
    const done = (val) => { ov.hidden = true; cleanup(); resolve(val ? val.trim() : null); };
    for (const l of langs) {
      const b = document.createElement('button'); b.className = 'lang-chip'; b.textContent = l;
      b.addEventListener('click', () => done(l));
      chips.appendChild(b);
    }
    input.value = settings.aiLastLang || '';
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
      else if (e.key === 'Escape') { e.stopPropagation(); done(null); }
    };
    const onDown = (e) => { if (e.target === ov) done(null); };
    const cleanup = () => { input.removeEventListener('keydown', onKey); ov.removeEventListener('mousedown', onDown); go.onclick = cancel.onclick = null; };
    const go = $('lang-go'), cancel = $('lang-cancel');
    go.onclick = () => done(input.value);
    cancel.onclick = () => done(null);
    input.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', onDown);
    ov.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

async function aiTranslate() {
  const t = activeTab();
  if (!t || aiBusy) return;
  const lang = await askLanguage();
  if (!lang) return;
  settings.aiLastLang = lang; saveSettings();
  aiBusy = true;
  const busyEl = aiMsgEl('info', 'translating to ' + lang); busyEl.classList.add('busy');
  try {
    const context = (await docText(t)).slice(0, 300000);
    const out = await callAI({
      system: 'You are a translator. Translate the document into ' + lang + '. Preserve Markdown structure (headings, lists, tables, code). Translate prose only; leave code, URLs, and proper nouns as-is. Output only the translated Markdown.',
      messages: [{ role: 'user', content: context }],
    });
    busyEl.remove();
    const tab = await makeTab({ name: stem(t.name) + ' — ' + lang + '.md', mtime: 0 }, 'md', { text: out });
    tab.live = false; tab.mdText = out;
    addTab(tab);
    aiMsgEl('info', 'Translation opened in a new tab.');
  } catch (err) {
    busyEl.remove();
    aiErrorEl(err);
  } finally { aiBusy = false; }
}

function toggleAiPanel(wantOpen) {
  const panel = $('ai-panel');
  panel.hidden = wantOpen === true ? false : (wantOpen === false ? true : !panel.hidden);
  $('ai-btn').classList.toggle('on', !panel.hidden);
  $('ai-resize').hidden = panel.hidden || mobileMQ.matches; // no resize when full-screen sheet
  if (typeof reclampDocks === 'function') reclampDocks();    // both docks share the width budget
  if (!panel.hidden) { renderAiChat(); $('ai-input').focus(); }
}

function wireAi() {
  $('ai-btn').addEventListener('click', toggleAiPanel);
  $('ai-close').addEventListener('click', toggleAiPanel);
  $('ai-summarize').addEventListener('click', () =>
    aiAsk('Summarize this document: key points, structure, and anything actionable. Use short sections.'));
  $('ai-translate').addEventListener('click', aiTranslate);
  $('ai-conceptmap').addEventListener('click', aiConceptMap);
  $('ai-board').addEventListener('click', aiToCanvas);
  const send = () => {
    const v = $('ai-input').value.trim();
    if (!v) return;
    $('ai-input').value = '';
    aiAsk(v);
  };
  $('ai-send').addEventListener('click', send);
  $('ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
}

/* ---------- Mind map view (⌘M) ---------- */

let mmInstance = null;

function topicItems(t) {
  if (!t) return [];
  if (PAGED_KINDS.includes(t.kind)) {
    return (t._tocItems || []).map(i => ({ label: i.label, level: i.level }));
  }
  const div = document.createElement('div');
  div.innerHTML = t.html || '';
  return [...div.querySelectorAll('h1, h2, h3, h4')].map(h => ({
    label: h.textContent.trim(),
    level: +h.tagName[1],
  })).filter(i => i.label);
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildTopicTree(t) {
  const root = { content: escHtml(stem(t.name)), children: [] };
  const stack = [{ node: root, level: 0 }];
  for (const it of topicItems(t)) {
    const node = { content: escHtml(it.label), children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= it.level) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, level: it.level });
  }
  return root;
}

function toggleMap() {
  const t = activeTab();
  if (!t || t.kind === 'unsupported' || t.kind === 'canvas') return;
  t.viewMode = t.viewMode === 'map' ? 'read' : 'map';
  renderActive();
}

function renderMap(t) {
  clearToc();
  showPane('map');
  $('map-source').hidden = !t.aiTree;
  $('map-source').textContent = t.mapSource === 'ai' ? 'Doc map' : 'AI map';
  const tree = (t.mapSource === 'ai' && t.aiTree) ? t.aiTree : buildTopicTree(t);
  const svg = $('map-svg');
  if (mmInstance) { try { mmInstance.destroy(); } catch (_) {} mmInstance = null; }
  svg.innerHTML = '';
  try {
    mmInstance = window.markmap.Markmap.create(svg, {
      autoFit: true,
      duration: 0,
      maxWidth: 320,
      spacingVertical: 8,
    }, tree);
  } catch (err) {
    console.error('markmap failed', err);
    diag('markmap create failed: ' + (err && err.message));
  }
  setTimeout(() => {
    const g = svg.querySelector('g');
    diag('map: nodes=' + svg.querySelectorAll('g.markmap-node').length +
         ' transform=' + (g ? g.getAttribute('transform') : 'none'));
  }, 700);
}

const plainLabel = (s) => s.replace(/&(amp|lt|gt);/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>' }[m]))
  .replace(/[()\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();

function treeToMermaid(root) {
  const lines = ['mindmap', `  root((${plainLabel(root.content)}))`];
  const walk = (n, depth) => {
    for (const c of n.children) {
      lines.push('  '.repeat(depth + 1) + plainLabel(c.content));
      walk(c, depth + 1);
    }
  };
  walk(root, 1);
  return lines.join('\n');
}

function treeToOutline(root) {
  const lines = ['# ' + plainLabel(root.content), ''];
  const walk = (n, depth) => {
    for (const c of n.children) {
      lines.push('  '.repeat(depth) + '- ' + plainLabel(c.content));
      walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}

function mapSvgText() {
  const svg = $('map-svg');
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xhtml', 'http://www.w3.org/1999/xhtml');
  const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#333';
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fff';
  const style = document.createElement('style');
  style.textContent = `svg{background:${bg};font:300 15px/1.4 -apple-system,'Segoe UI',sans-serif;color:${fg}} foreignObject{color:${fg};overflow:visible} .markmap-link{fill:none} circle{cursor:default}`;
  clone.insertBefore(style, clone.firstChild);
  return clone.outerHTML;
}

function wireMap() {
  $('map-btn').addEventListener('click', toggleMap);
  $('export-btn').addEventListener('click', openExportDialog);
  $('map-fit').addEventListener('click', () => mmInstance && mmInstance.fit());
  $('map-source').addEventListener('click', () => {
    const t = activeTab();
    if (!t) return;
    t.mapSource = t.mapSource === 'ai' ? 'doc' : 'ai';
    renderMap(t);
  });
  $('map-export-svg').addEventListener('click', () => {
    const t = activeTab();
    if (t) saveTextAs(mapSvgText(), stem(t.name) + ' — map.svg');
  });
  $('map-export-mermaid').addEventListener('click', () => {
    const t = activeTab();
    if (t) saveTextAs('```mermaid\n' + treeToMermaid(buildTopicTree(t)) + '\n```\n', stem(t.name) + ' — mindmap.md');
  });
  $('map-export-outline').addEventListener('click', () => {
    const t = activeTab();
    if (t) saveTextAs(treeToOutline(buildTopicTree(t)), stem(t.name) + ' — outline.md');
  });
}

/* ---------- Settings UI ---------- */

function renderSettingsUI() {
  const grid = $('theme-grid');
  if (!grid.childElementCount) {
    for (const th of THEMES) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.dataset.key = th.key;
      b.innerHTML = `<span class="sw-preview">${th.sw.map(c => `<i style="background:${c}"></i>`).join('')}</span><span class="sw-label"></span>`;
      b.querySelector('.sw-label').textContent = th.label;
      b.addEventListener('click', () => { settings.theme = th.key; saveSettings(); applySettings(); });
      grid.appendChild(b);
    }
  }
  grid.querySelectorAll('.swatch').forEach(s => s.classList.toggle('sel', s.dataset.key === settings.theme));
  document.querySelectorAll('#seg-width button').forEach(b => b.classList.toggle('sel', b.dataset.v === settings.width));
  document.querySelectorAll('#seg-font button').forEach(b => b.classList.toggle('sel', b.dataset.v === settings.font));
  $('fs-val').textContent = settings.fontSize + 'px';
  $('profile-name').value = settings.profileName;
  $('restore-session').checked = settings.restoreSession;
  renderAiSettings();
  syncTypePreview();
  $('empty-title').textContent = settings.profileName ? `Welcome back, ${settings.profileName}` : 'Vedrix';
}

// Live type sample in the Reading section — reflects font family + size instantly
function syncTypePreview() {
  const tp = $('type-preview'); if (!tp) return;
  tp.style.setProperty('--reader-fs', settings.fontSize + 'px');
  tp.classList.toggle('tp-serif', settings.font === 'serif');
  tp.classList.toggle('tp-mono', settings.font === 'mono');
}

// Switch which settings section is visible
function showSettingsSection(sec) {
  document.querySelectorAll('#settings-nav .set-nav-item[data-sec]').forEach(b => b.classList.toggle('sel', b.dataset.sec === sec));
  document.querySelectorAll('.settings-section').forEach(s => { s.hidden = s.dataset.sec !== sec; });
}

function renderAiSettings() {
  const provider = settings.aiProvider || 'anthropic';
  const preset = AI_PRESETS[provider] || AI_PRESETS.anthropic;
  $('ai-preset').value = provider;
  $('ai-base').value = settings.aiBase || preset.base;
  $('ai-model').value = settings.aiModel || preset.model;
  $('ai-key').value = settings.aiKey || '';
  $('ai-key').placeholder = preset.keyHint;
  $('ai-note').textContent = (mobileMQ.matches ? 'Stored only on this device. ' : 'Stored only on this Mac. ') + preset.note;
}

function wireSettings() {
  $('settings-close').addEventListener('click', () => { $('settings-overlay').hidden = true; });
  $('settings-overlay').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) $('settings-overlay').hidden = true; });
  document.querySelectorAll('#settings-nav .set-nav-item[data-sec]').forEach(b =>
    b.addEventListener('click', () => showSettingsSection(b.dataset.sec)));
  document.querySelectorAll('#seg-width button').forEach(b =>
    b.addEventListener('click', () => { settings.width = b.dataset.v; saveSettings(); applySettings(); syncTypePreview(); }));
  document.querySelectorAll('#seg-font button').forEach(b =>
    b.addEventListener('click', () => { settings.font = b.dataset.v; saveSettings(); applySettings(); syncTypePreview(); }));
  $('fs-minus').addEventListener('click', () => { settings.fontSize = Math.max(12, settings.fontSize - 1); saveSettings(); applySettings(); renderSettingsUI(); });
  $('fs-plus').addEventListener('click', () => { settings.fontSize = Math.min(24, settings.fontSize + 1); saveSettings(); applySettings(); renderSettingsUI(); });
  // 'input' not 'change': closing the modal before blur must not discard the value
  $('profile-name').addEventListener('input', (e) => {
    settings.profileName = e.target.value.trim(); saveSettings();
    $('empty-title').textContent = settings.profileName ? `Welcome back, ${settings.profileName}` : 'Vedrix';
  });
  $('ai-preset').addEventListener('change', (e) => {
    const p = e.target.value;
    settings.aiProvider = p;
    // switching provider resets base+model to that provider's defaults
    const preset = AI_PRESETS[p] || AI_PRESETS.anthropic;
    settings.aiBase = preset.base;
    settings.aiModel = preset.model;
    saveSettings();
    renderAiSettings();
  });
  $('ai-base').addEventListener('input', (e) => { settings.aiBase = e.target.value.trim(); saveSettings(); });
  $('ai-model').addEventListener('input', (e) => { settings.aiModel = e.target.value.trim(); saveSettings(); });
  $('ai-key').addEventListener('input', (e) => { settings.aiKey = e.target.value.trim(); saveSettings(); });
  $('restore-session').addEventListener('change', (e) => { settings.restoreSession = e.target.checked; saveSettings(); });
  $('clear-history').addEventListener('click', () => {
    // clear with undo: keep the snapshot until the toast times out
    const snap = recents;
    recents = [];
    localStorage.removeItem('mv_recents');
    renderRecents();
    toastAction('History cleared', 'Undo', () => {
      recents = snap;
      try { lsSet('mv_recents', JSON.stringify(recents)); } catch (_) {}
      renderRecents();
    });
  });
}

/* ---------- History panel ---------- */

// Load the bundled sample document (same file the ?demo flag uses)
async function openSampleDoc() {
  try {
    const text = await fetch('samples/demo.md').then(r => r.text());
    addTab(await makeTab({ name: 'Welcome tour.md', mtime: 0 }, 'md', { text }));
  } catch (_) { toast('Could not load the sample'); }
}

function wireEmpty() {
  $('empty-open').addEventListener('click', () => openViaPicker());
  $('empty-sample').addEventListener('click', openSampleDoc);
}

/* ---------- Accessibility ---------- */

// Icon-only buttons carry their label in title; mirror it to aria-label so
// screen readers announce them (strip trailing shortcut hints like "(⌘B)").
function applyAriaLabels(root) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('button[title]:not([aria-label])').forEach(b =>
    b.setAttribute('aria-label', b.title.replace(/\s*\([^)]*\)\s*$/, '')));
}

// Modal focus management: remember where focus was, keep Tab inside the open
// dialog, and put focus back when it closes.
const FOCUS_OVERLAYS = ['settings-overlay', 'project-overlay', 'lang-overlay', 'export-overlay', 'shortcuts-overlay', 'cmd-overlay'];
let _lastFocus = null;
function wireA11y() {
  applyAriaLabels(document);
  // keep labels on dynamically created buttons too
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1) applyAriaLabels(n.matches && n.matches('button') ? n.parentNode || n : n);
    }
  }).observe(document.body, { childList: true, subtree: true });

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      const el = m.target;
      if (!el.hidden) {
        _lastFocus = document.activeElement;
        setTimeout(() => {  // let the overlay's own focus() win first
          if (!el.contains(document.activeElement)) {
            const f = el.querySelector('input:not([type="hidden"]), textarea, select, button');
            if (f) f.focus();
          }
        }, 80);
      } else if (_lastFocus) {
        if (_lastFocus.isConnected) _lastFocus.focus();
        _lastFocus = null;
      }
    }
  });
  FOCUS_OVERLAYS.forEach(id => { const el = $(id); if (el) obs.observe(el, { attributes: true, attributeFilter: ['hidden'] }); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const open = FOCUS_OVERLAYS.map(id => $(id)).find(el => el && !el.hidden);
    if (!open) return;
    const foci = [...open.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!foci.length) return;
    const first = foci[0], last = foci[foci.length - 1];
    if (!open.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

function wireHistory() {
  document.addEventListener('mousedown', (e) => {
    if (!$('history-panel').hidden && !e.target.closest('#history-panel')) $('history-panel').hidden = true;
  });
}

/* ---------- Global events ---------- */

/* ---------- Mobile / touch layout ---------- */

const mobileMQ = window.matchMedia('(max-width: 720px)');

function applyMobile() {
  const isMobile = mobileMQ.matches;
  document.body.classList.toggle('mobile', isMobile);
  if (isMobile) {
    // start with the drawer closed so content is visible on first paint
    if (!sidebarCollapsed) { sidebarCollapsed = true; updateSidebar(); }
  }
  syncDrawerBackdrop();
}

function toggleOverflowMenu(show) {
  const m = $('overflow-menu');
  const open = show === undefined ? m.hidden : show;
  if (open) {
    const t = activeTab();
    m.querySelector('[data-act="map"]').classList.toggle('hide', !(t && t.kind !== 'unsupported'));
    const readerItem = m.querySelector('[data-act="reader"]');
    readerItem.classList.toggle('hide', !(t && (t.kind === 'pdf' || t.kind === 'html')));
    if (t && t.kind === 'html') {
      readerItem.textContent = effectiveHtmlMode(t) === 'live' ? 'Reader mode' : 'Interactive mode';
    } else {
      readerItem.textContent = 'Reading mode';
    }
    m.querySelector('[data-act="edit"]').classList.toggle('hide', !isEditable(t));
    m.querySelector('[data-act="export"]').classList.toggle('hide', !t);
    m.querySelector('[data-act="find"]').classList.toggle('hide', !t);
  }
  m.hidden = !open;
}

const OVERFLOW_ACTIONS = {
  open: openViaPicker,
  ai: toggleAiPanel,
  map: toggleMap,
  reader: () => {
    const t = activeTab();
    if (t && t.kind === 'html') toggleHtmlMode(); else if (t && t.kind === 'pptx') startPresentation(); else openReadingMode();
  },
  edit: toggleEdit,
  export: openExportDialog,
  find: openFind,
  history: () => { $('history-panel').hidden = false; },
  settings: () => { $('settings-overlay').hidden = false; },
};

function wireMobile() {
  applyMobile();
  mobileMQ.addEventListener('change', applyMobile);

  $('overflow-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleOverflowMenu(); });
  $('overflow-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    toggleOverflowMenu(false);
    const fn = OVERFLOW_ACTIONS[btn.dataset.act];
    if (fn) fn();
  });
  document.addEventListener('click', (e) => {
    if (!$('overflow-menu').hidden && !e.target.closest('#overflow-menu, #overflow-btn')) toggleOverflowMenu(false);
  });

  // backdrop closes the drawer
  $('drawer-backdrop').addEventListener('click', () => { sidebarCollapsed = true; updateSidebar(); syncDrawerBackdrop(); });
  // picking a heading or a file closes the drawer
  tocEl.addEventListener('click', (e) => { if (e.target.closest('a')) closeDrawerIfMobile(); });
  $('filetree').addEventListener('click', (e) => { if (e.target.closest('button')) closeDrawerIfMobile(); });

  // pinch-to-zoom on paged documents (PDF / slides)
  let pinchBase = null;
  scrollerEl.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2) return;
    const t = activeTab();
    if (!t || !PAGED_KINDS.includes(t.kind)) return;
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    if (pinchBase == null) { pinchBase = { d, zoom: t.zoom || 1 }; return; }
    e.preventDefault();
    const target = Math.min(3, Math.max(0.5, pinchBase.zoom * (d / pinchBase.d)));
    if (Math.abs(target - (t.zoom || 1)) > 0.04) { t.zoom = +target.toFixed(2); applyZoom(t); }
  }, { passive: false });
  scrollerEl.addEventListener('touchend', (e) => {
    if (e.touches.length < 2 && pinchBase) {
      pinchBase = null;
      const t = activeTab();
      if (t && t.kind === 'pdf' && t.pagesEl) {  // re-render crisp at final zoom
        t.pagesEl.querySelectorAll('.pdf-page').forEach(h => { delete h.dataset.rendered; h.replaceChildren(); });
        renderVisiblePages(t);
      }
    }
  });
}

// isolation self-check: the demo dashboard postMessages what it can see
window.addEventListener('message', (e) => {
  if (e.data && e.data.mvIsolation) {
    diag('html-live isolation: tauri=' + e.data.tauri + ' parentDom=' + e.data.parentDom + ' storage=' + e.data.storage);
  }
});

function wireGlobal() {
  $('open-btn').addEventListener('click', openViaPicker);
  $('new-tab').addEventListener('click', openViaPicker);
  $('search-chip').addEventListener('click', openCmd);
  $('toc-toggle').addEventListener('click', toggleSidebar);
  $('reader-btn').addEventListener('click', () => {
    const t = activeTab();
    if (t && t.kind === 'html') toggleHtmlMode(); else if (t && t.kind === 'pptx') startPresentation(); else openReadingMode();
  });
  $('pill-rich').addEventListener('click', () => setEditSurface('rich'));
  $('pill-source').addEventListener('click', () => setEditSurface('source'));
  $('pill-done').addEventListener('click', toggleEdit);
  contentEl.addEventListener('input', onRichInput);
  contentEl.addEventListener('change', onRichInput); // task-list checkboxes
  document.querySelectorAll('#side-tabs button').forEach(b =>
    b.addEventListener('click', () => { sideMode = b.dataset.m; updateSidebar(); }));
  $('open-external').addEventListener('click', () => {
    const t = activeTab();
    if (t && t.path) TAURI.core.invoke('open_externally', { path: t.path });
  });
  $('file-input').addEventListener('change', async (e) => {
    for (const file of e.target.files) await openBrowserFile(file, null);
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'o') { e.preventDefault(); openViaPicker(); }
    else if (mod && e.key === 'w') { e.preventDefault(); if (activeTab()) closeTab(activeId); }
    else if (mod && e.key === ',') { e.preventDefault(); $('settings-overlay').hidden = false; }
    else if (mod && e.key === 'f') { e.preventDefault(); openFind(); }
    else if (mod && e.key === 'e') { e.preventDefault(); toggleEdit(); }
    else if (mod && e.key === 'm' && !e.altKey) { e.preventDefault(); toggleMap(); }
    else if (mod && e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); const t = activeTab(); if (t && TEXT_KINDS.includes(t.kind)) startMdPresentation(); }
    else if (mod && e.key === 'p') { e.preventDefault(); appPrint(); }
    else if (mod && e.key === 's') {
      const t = activeTab();
      if (t && t.kind === 'canvas') { e.preventDefault(); saveCanvas(t); }
      else if (t && !t.path && TEXT_KINDS.includes(t.kind)) { e.preventDefault(); if ((t.editSurface || 'rich') === 'rich') t.text = richToMarkdown(t); saveDocAs(t); }
    }
    else if (mod && e.key === 'b') {
      e.preventDefault();
      if (isRichEditing()) EDITOR_CMDS.bold(); else toggleSidebar();
    }
    else if (mod && e.key === 'i' && isRichEditing()) { e.preventDefault(); EDITOR_CMDS.italic(); }
    else if (mod && e.key === 'u' && isRichEditing()) { e.preventDefault(); EDITOR_CMDS.underline(); }
    else if (mod && e.key === 'k') { e.preventDefault(); if (isRichEditing()) openLinkPop(); else openCmd(); }
    else if (mod && !e.shiftKey && e.key === 'p') { e.preventDefault(); openPageJump(); }
    else if (mod && !e.shiftKey && e.key === 'z' && isRichEditing()) { e.preventDefault(); editUndo(); }
    else if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z') && isRichEditing()) { e.preventDefault(); editRedo(); }
    else if (mod && e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); openFolder(); }
    else if (mod && e.key === 'g') { e.preventDefault(); toggleGraph(); }
    else if (mod && e.key === 'j') { e.preventDefault(); toggleAiPanel(); }
    else if (mod && e.key === '/') { e.preventDefault(); $('shortcuts-overlay').hidden = false; }
    else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomPaged(0.15); }
    else if (mod && e.key === '-') { e.preventDefault(); zoomPaged(-0.15); }
    else if (mod && e.key === '0') { e.preventDefault(); zoomPaged(0); }
    else if (mod && e.key === '[') { e.preventDefault(); navBack(); }
    else if (mod && e.key === ']') { e.preventDefault(); navFwd(); }
    else if (e.key === 'Escape') {
      $('settings-overlay').hidden = true;
      $('history-panel').hidden = true;
      $('shortcuts-overlay').hidden = true;
      $('cmd-overlay').hidden = true;
      $('project-overlay').hidden = true;
      $('assign-menu').hidden = true;
      $('export-overlay').hidden = true;
      if (!$('findbar').hidden) closeFind();
    }
    else if (mod && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const i = tabs.findIndex(t => t.id === activeId);
      if (i !== -1 && tabs.length > 1) {
        const n = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
        switchTab(tabs[n].id);
      }
    }
  });
  wireFind();
  wireCmd();
  wireAnnotations();
  wireDb();
  wireSelMenu();
  wireEditorToolbar();
  wireInspector();
  wireSelBubble();
  wireRichTyping();
  wireBlockDrag();
  wireTableTools();
  $('replace-one').addEventListener('click', doReplaceOne);
  $('replace-all').addEventListener('click', doReplaceAll);
  $('replace-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doReplaceOne(); } });
  wireZoom();
  wireMap();
  wireAi();

  // scroll-indicator thumbs (visible only while scrolling) + paged-TOC highlight
  for (const [el, thumb] of [[scrollerEl, $('thumb-scroller')], [tocEl, $('thumb-toc')]]) {
    let timer;
    el.addEventListener('scroll', () => {
      if (updateThumb(el, thumb)) {
        thumb.classList.add('visible');
        clearTimeout(timer);
        timer = setTimeout(() => thumb.classList.remove('visible'), 800);
      }
      if (el === scrollerEl) {
        rememberPosition();
        updateReadingProgress();
        const t = activeTab();
        if (t && PAGED_KINDS.includes(t.kind)) { highlightPagedToc(t); renderVisiblePages(t); }
      }
    }, { passive: true });
  }

  wireDockResizers();

  // browser drag & drop (Tauri intercepts drops natively — see wireTauri)
  if (!TAURI) {
    let depth = 0;
    document.addEventListener('dragenter', (e) => { e.preventDefault(); if (++depth === 1) document.body.classList.add('dragover'); });
    document.addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth === 0) document.body.classList.remove('dragover'); });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragover');
      for (const item of e.dataTransfer.items || []) {
        if (item.getAsFileSystemHandle) {
          const handle = await item.getAsFileSystemHandle();
          if (handle && handle.kind === 'file') { await openBrowserFile(await handle.getFile(), handle); continue; }
        }
        const f = item.getAsFile && item.getAsFile();
        if (f) await openBrowserFile(f, null);
      }
    });
  }
}

function wireTauri() {
  if (!TAURI) return;
  document.body.classList.add('tauri');
  // macOS uses an overlay titlebar (traffic lights inset into our topbar);
  // Windows/Linux use native decorations, so no left inset there.
  if (/Mac/i.test(navigator.platform || navigator.userAgent)) document.body.classList.add('mac');
  TAURI.event.listen('open-file', (e) => openTauriPath(e.payload));
  TAURI.event.listen('menu', (e) => {
    const id = e.payload;
    if (id === 'open') openViaPicker();
    else if (id === 'close-tab') { if (activeTab()) closeTab(activeId); }
    else if (id === 'settings') $('settings-overlay').hidden = false;
    else if (id === 'find') openFind();
    else if (id === 'toggle-toc') tocEl.classList.toggle('hidden');
    else if (id === 'zoom-in') zoomPaged(0.15);
    else if (id === 'zoom-out') zoomPaged(-0.15);
    else if (id === 'zoom-fit') zoomPaged(0);
    else if (id === 'shortcuts') $('shortcuts-overlay').hidden = false;
    else if (id === 'edit-mode') toggleEdit();
    else if (id === 'mind-map') toggleMap();
    else if (id === 'open-folder') openFolder();
    else if (id === 'knowledge-graph') toggleGraph();
    else if (id === 'ai-panel') toggleAiPanel();
    else if (id === 'export-md') exportActive('md');
    else if (id === 'export-html') exportActive('html');
    else if (id === 'export-csv') exportActive('csv');
    else if (id === 'print' || id === 'print-doc') appPrint();
  });
  TAURI.event.listen('tauri://drag-enter', () => document.body.classList.add('dragover'));
  TAURI.event.listen('tauri://drag-leave', () => document.body.classList.remove('dragover'));
  TAURI.event.listen('tauri://drag-drop', async (e) => {
    document.body.classList.remove('dragover');
    for (const p of (e.payload.paths || [])) await openTauriPath(p);
  });
}

/* ---------- Boot ---------- */

async function boot() {
  applySettings();
  await loadLibrary();
  wireSettings();
  wireHistory();
  wireEmpty();
  wireA11y();
  wireGlobal();
  wireMobile();
  wireTauri();
  wireProjectModal();
  wireExportDialog();
  wirePresent();
  if (!mobileMQ.matches) wireHome();
  renderProjects();
  renderRecents();
  renderActive();

  if (TAURI) {
    if (settings.lastFolder) {
      try { await openFolder(settings.lastFolder); sideMode = 'toc'; updateSidebar(); } catch (_) {}
    }
    let session = null;
    try { session = JSON.parse(localStorage.getItem('mv_session') || 'null'); } catch (_) {}
    const pending = await TAURI.core.invoke('take_pending_file');
    if (settings.restoreSession && session && session.paths) {
      for (const p of session.paths) {
        if (p === pending) continue;
        try { await TAURI.core.invoke('stat_md_file', { path: p }); await openTauriPath(p); } catch (_) {}
      }
      if (!pending && session.activePath) {
        const t = tabs.find(t => t.path === session.activePath);
        if (t) switchTab(t.id);
      }
    }
    if (pending) await openTauriPath(pending);
    // open to Home when nothing else is showing (desktop entry point)
    if (!tabs.length && !mobileMQ.matches) showHome();
    // first-run shortcuts sheet is desktop-only (⌘ keys don't exist on touch)
    if (!localStorage.getItem('mv_seen')) {
      lsSet('mv_seen', '1');
      if (!mobileMQ.matches) setTimeout(() => { $('shortcuts-overlay').hidden = false; }, 600);
    }
    if (localStorage.getItem('mv_automap')) {
      localStorage.removeItem('mv_automap');
      setTimeout(() => toggleMap(), 1500);
    }
    if (localStorage.getItem('mv_autograph')) {
      localStorage.removeItem('mv_autograph');
      setTimeout(() => toggleGraph(), 1500);
    }
    if (localStorage.getItem('mv_aitest')) {
      localStorage.removeItem('mv_aitest');
      try {
        const reply = await callAI({ system: 'Reply with exactly OK.', messages: [{ role: 'user', content: 'ping' }] });
        diag('aitest: reply=' + JSON.stringify(reply).slice(0, 80));
      } catch (err) { diag('aitest: ERROR ' + err.message); }
    }
  } else if (new URLSearchParams(location.search).has('demo')) {
    const text = await fetch('samples/demo.md').then(r => r.text());
    addTab(await makeTab({ name: 'demo.md', mtime: 0 }, 'md', { text }));
  }
}

boot();

/* ==========================================================================
   N3 — Databases v1  (folder-as-database)

   A database is a FOLDER. Each .md file in it is a row; its frontmatter holds
   the properties (N1 already owns that read/write path). A `_vedrix.db.yaml`
   file next to the rows declares the schema and saved views.

   The schema file never owns content: delete it and you lose your *views*,
   never your notes. Every edit here ends as a surgical fmSet() on one file.
   ========================================================================== */

const DB_SCHEMA_FILE = '_vedrix.db.yaml';
const DB_TYPES = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'relation', 'formula', 'rollup'];
const DB_SELECT_COLORS = ['#2f6bff', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65758b'];

let db = null;   // { folder, schema, rows, viewIdx, search }

/* ---------- YAML-lite (the subset the schema file is allowed to use) ------ */

function ylScalar(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return '';
  if ((v[0] === '"' && v.endsWith('"') && v.length > 1)) { try { return JSON.parse(v); } catch (_) { return v.slice(1, -1); } }
  if (v[0] === "'" && v.endsWith("'") && v.length > 1) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// {a: b, c: [d, e]} / [a, b] — quote-aware, so values may contain , { } [ ]
function ylFlow(src) {
  let i = 0;
  const s = String(src);
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function value() {
    skip();
    if (s[i] === '{') return map();
    if (s[i] === '[') return list();
    const start = i;
    let q = null;
    while (i < s.length) {
      const c = s[i];
      if (q) { if (c === q) q = null; i++; continue; }
      if (c === '"' || c === "'") { q = c; i++; continue; }
      if (c === ',' || c === '}' || c === ']') break;
      i++;
    }
    return ylScalar(s.slice(start, i));
  }
  function map() {
    const o = {}; i++;
    for (;;) {
      skip();
      if (i >= s.length || s[i] === '}') { i++; break; }
      const ks = i;
      let q = null;
      while (i < s.length) {
        const c = s[i];
        if (q) { if (c === q) q = null; i++; continue; }
        if (c === '"' || c === "'") { q = c; i++; continue; }
        if (c === ':' || c === '}') break;
        i++;
      }
      const key = String(ylScalar(s.slice(ks, i)));
      if (s[i] === ':') i++;
      o[key] = value();
      skip();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; break; }
      if (i >= s.length) break;
    }
    return o;
  }
  function list() {
    const a = []; i++;
    for (;;) {
      skip();
      if (i >= s.length || s[i] === ']') { i++; break; }
      a.push(value());
      skip();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; break; }
      if (i >= s.length) break;
    }
    return a;
  }
  return value();
}

function parseYamlLite(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const lines = raw.filter(l => l.trim() && !/^\s*#/.test(l) && l.trim() !== '---' && l.trim() !== '...');
  const ind = (l) => (l.match(/^ */) || [''])[0].length;
  let i = 0;
  function block(base) {
    const isList = /^\s*-\s/.test(lines[i] || '');
    const out = isList ? [] : {};
    while (i < lines.length) {
      const line = lines[i];
      const at = ind(line);
      if (at < base) break;
      if (at > base) { i++; continue; }        // defensive: skip stray deeper line
      const t = line.trim();
      if (t.startsWith('- ')) {
        if (!Array.isArray(out)) break;
        const rest = t.slice(2).trim();
        if (rest.startsWith('{') || rest.startsWith('[')) { out.push(ylFlow(rest)); i++; continue; }
        const m = rest.match(/^([^:]+):\s*(.*)$/);
        if (m) {                                  // "- name: X" + deeper sibling keys
          const obj = {};
          const v = m[2].trim();
          obj[m[1].trim()] = (v.startsWith('{') || v.startsWith('[')) ? ylFlow(v) : ylScalar(v);
          i++;
          while (i < lines.length && ind(lines[i]) > at && !lines[i].trim().startsWith('- ')) {
            const cm = lines[i].trim().match(/^([^:]+):\s*(.*)$/);
            if (!cm) { i++; continue; }
            const cv = cm[2].trim();
            if (!cv) { const key = cm[1].trim(); i++; obj[key] = (i < lines.length && ind(lines[i]) > at) ? block(ind(lines[i])) : null; }
            else { obj[cm[1].trim()] = (cv.startsWith('{') || cv.startsWith('[')) ? ylFlow(cv) : ylScalar(cv); i++; }
          }
          out.push(obj);
          continue;
        }
        out.push(ylScalar(rest)); i++; continue;
      }
      const m = t.match(/^([^:]+):\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1].trim(), rest = m[2].trim();
      if (!rest) {
        i++;
        out[key] = (i < lines.length && ind(lines[i]) > at) ? block(ind(lines[i])) : null;
      } else {
        out[key] = (rest.startsWith('{') || rest.startsWith('[')) ? ylFlow(rest) : ylScalar(rest);
        i++;
      }
    }
    return out;
  }
  return block(ind(lines[0] || ''));
}

function ylDumpScalar(v) {
  if (v == null) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  return /^[\s]|[\s]$|[:,{}[\]#]|^$/.test(s) ? JSON.stringify(s) : s;
}

function ylDumpFlow(o) {
  if (Array.isArray(o)) return '[' + o.map(ylDumpFlow).join(', ') + ']';
  if (o && typeof o === 'object') {
    return '{ ' + Object.keys(o).filter(k => o[k] != null && o[k] !== '')
      .map(k => k + ': ' + ylDumpFlow(o[k])).join(', ') + ' }';
  }
  return ylDumpScalar(o);
}

// Canonical schema file. Deliberately flow-style for properties/views so the
// file stays short and round-trips through parseYamlLite exactly.
function dumpSchema(schema) {
  const out = ['# Vedrix database — this file declares the schema and saved views.',
               '# Your notes live in the .md files next to it; deleting this loses only the views.',
               'name: ' + ylDumpScalar(schema.name || 'Database')];
  out.push('properties:');
  const props = schema.properties || {};
  Object.keys(props).forEach(k => out.push('  ' + k + ': ' + ylDumpFlow(props[k])));
  out.push('views:');
  (schema.views || []).forEach(v => out.push('  - ' + ylDumpFlow(v)));
  return out.join('\n') + '\n';
}

function dbDefaultSchema(name) {
  return {
    name: name || 'Database',
    properties: {
      Status: { type: 'select', options: ['Backlog', 'In progress', 'Done'] },
      Due: { type: 'date' },
    },
    views: [
      { name: 'Table', type: 'table' },
      { name: 'Board', type: 'board', group: 'Status' },
    ],
  };
}

/* ---------- storage layer (Tauri, with an in-memory mock for tests) ------- */

const dbFs = {
  async scan(folder) {
    if (TAURI) return TAURI.core.invoke('scan_db', { folder });
    return (window.__dbMock && window.__dbMock.scan(folder)) || [];
  },
  async read(path) {
    if (TAURI) { try { return (await TAURI.core.invoke('read_md_file', { path })).text; } catch (_) { return ''; } }
    return (window.__dbMock && window.__dbMock.files[path]) || '';
  },
  async write(path, contents) {
    if (TAURI) return TAURI.core.invoke('write_file', { path, contents });
    if (window.__dbMock) window.__dbMock.files[path] = contents;
  },
};

const dbJoin = (folder, name) => folder.replace(/[/\\]+$/, '') + '/' + name;

/* ---------- load ---------------------------------------------------------- */

// frontmatter block (raw) → { key: value } using the N1 parser
function dbProps(fmText) {
  // null prototype: a property named "constructor" or "__proto__" must resolve
  // to the file's data or nothing at all — never to something off Object.prototype
  const out = Object.create(null);
  parseFm(fmText || '').forEach(e => { out[e.key] = e.list && (e.inline || e.list.length) ? e.list : e.value; });
  return out;
}

async function dbLoad(folder) {
  const schemaText = await dbFs.read(dbJoin(folder, DB_SCHEMA_FILE));
  let schema = schemaText ? parseYamlLite(schemaText) : null;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) schema = dbDefaultSchema(folder.split(/[/\\]/).pop());
  schema.properties = schema.properties || {};
  schema.views = (schema.views || []).filter(v => v && v.name);
  if (!schema.views.length) schema.views = [{ name: 'Table', type: 'table' }];
  const scanned = await dbFs.scan(folder);
  const rows = scanned.map(r => ({ path: r.path, name: r.name, title: r.name.replace(/\.md$/i, ''), mtime: r.mtime, props: dbProps(r.fm) }));
  // any frontmatter key that isn't declared yet becomes a text property, so a
  // folder of existing notes shows its real data instead of empty columns
  rows.forEach(r => Object.keys(r.props).forEach(k => {
    if (!schema.properties[k]) schema.properties[k] = { type: Array.isArray(r.props[k]) ? 'multi_select' : 'text' };
  }));
  return { folder, schema, rows, viewIdx: 0, search: '', rel: {} };
}

async function dbSaveSchema() {
  if (!db) return;
  await dbFs.write(dbJoin(db.folder, DB_SCHEMA_FILE), dumpSchema(db.schema));
}

/* ---------- filter / sort / group ---------------------------------------- */

function dbCmp(a, b) {
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && !isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a == null ? '' : a).localeCompare(String(b == null ? '' : b), undefined, { numeric: true, sensitivity: 'base' });
}

function dbCellText(row, key) {
  // formulas and rollups are computed, so filter/sort/search see real values
  if (db && db.schema && dbIsComputed(key)) return String(dbValue(row, key));
  const v = row.props[key];
  if (Array.isArray(v)) return v.join(', ');
  return v == null ? '' : String(v);
}

function dbMatchesFilter(row, f) {
  const v = dbCellText(row, f.prop);
  const want = f.value == null ? '' : String(f.value);
  switch (f.op) {
    case 'is': return v.toLowerCase() === want.toLowerCase();
    case 'is not': return v.toLowerCase() !== want.toLowerCase();
    case 'contains': return v.toLowerCase().includes(want.toLowerCase());
    case 'is empty': return !v.trim();
    case 'is not empty': return !!v.trim();
    case '>': return dbCmp(v, want) > 0;
    case '<': return dbCmp(v, want) < 0;
    default: return true;
  }
}

function dbVisibleRows() {
  if (!db) return [];
  const view = db.schema.views[db.viewIdx] || {};
  let rows = db.rows.slice();
  const q = (db.search || '').trim().toLowerCase();
  if (q) rows = rows.filter(r => r.title.toLowerCase().includes(q) ||
    Object.keys(r.props).some(k => dbCellText(r, k).toLowerCase().includes(q)));
  const filters = Array.isArray(view.filter) ? view.filter : (view.filter ? [view.filter] : []);
  filters.forEach(f => { if (f && f.prop) rows = rows.filter(r => dbMatchesFilter(r, f)); });
  const sorts = Array.isArray(view.sort) ? view.sort : (view.sort ? [view.sort] : []);
  if (sorts.length) {
    rows.sort((a, b) => {
      for (const s of sorts) {
        const key = s.prop || s.property;
        if (!key) continue;
        const d = dbCmp(dbCellText(a, key), dbCellText(b, key)) * (String(s.dir || 'asc').startsWith('desc') ? -1 : 1);
        if (d) return d;
      }
      return 0;
    });
  }
  return rows;
}

function dbSelectOptions(key) {
  const p = (db.schema.properties || {})[key] || {};
  const declared = Array.isArray(p.options) ? p.options.map(String) : [];
  const seen = new Set(declared.map(s => s.toLowerCase()));
  db.rows.forEach(r => {
    const v = dbCellText(r, key).trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); declared.push(v); }
  });
  return declared;
}

const dbOptColor = (key, opt) => DB_SELECT_COLORS[
  Math.abs([...String(key + '·' + opt)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % DB_SELECT_COLORS.length];

/* ---------- writes: every edit is one surgical frontmatter rewrite -------- */

async function dbSetRowProp(row, key, value) {
  const text = await dbFs.read(row.path);
  const next = fmSet(text, key, value === '' || value == null ? null : value);
  if (next !== text) await dbFs.write(row.path, next);
  if (value === '' || value == null) delete row.props[key]; else row.props[key] = value;
  // keep an open tab for this file in sync so the editor doesn't clobber it
  const open = tabs.find(t => t.path === row.path);
  if (open) { open.text = next; if (activeTab() === open) renderActive(); }
}

async function dbNewRow() {
  if (!db) return;
  const base = 'Untitled';
  let name = base + '.md', n = 2;
  while (db.rows.some(r => r.name.toLowerCase() === name.toLowerCase())) name = base + ' ' + (n++) + '.md';
  const path = dbJoin(db.folder, name);
  await dbFs.write(path, '---\n---\n\n# ' + name.replace(/\.md$/, '') + '\n');
  db.rows.push({ path, name, title: name.replace(/\.md$/, ''), mtime: Date.now() / 1000, props: {} });
  renderDbBody();
  toast('Added ' + name);
}

/* ---------- render -------------------------------------------------------- */

function renderDb(t) {
  showPane('db');
  const host = $('dbview');
  if (!db || db.folder !== t.dbFolder) {
    host.innerHTML = '<div class="db-loading">Loading database…</div>';
    dbLoad(t.dbFolder)
      .then(async (loaded) => {
        await dbLoadRelations(loaded);      // rollups need their target rows in hand
        db = loaded;
        t.name = (db.schema.name || t.name) + '';
        renderTabStrip();
      })
      .catch(err => {
        console.error('database load failed', err);
        host.innerHTML = '<div class="db-loading">Could not read this folder.</div>';
        throw err;                       // don't fall through to a render with no data
      })
      // rendering is a separate step: a bug in here must not be reported as
      // "could not read this folder" — that blames the user's files for our bug
      .then(() => { try { renderDbAll(); } catch (e) { console.error('database render failed', e); host.innerHTML = '<div class="db-loading">This database could not be displayed.</div>'; } })
      .catch(() => {});
    return;
  }
  renderDbAll();
}

function renderDbAll() {
  const host = $('dbview');
  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'db-head';
  const title = document.createElement('div');
  title.className = 'db-title';
  title.textContent = db.schema.name || 'Database';
  head.appendChild(title);

  const tabsEl = document.createElement('div');
  tabsEl.className = 'db-views';
  db.schema.views.forEach((v, i) => {
    const b = document.createElement('button');
    b.className = 'db-view' + (i === db.viewIdx ? ' on' : '');
    b.textContent = v.name || ('View ' + (i + 1));
    b.addEventListener('click', () => { db.viewIdx = i; renderDbAll(); });
    tabsEl.appendChild(b);
  });
  const addView = document.createElement('button');
  addView.className = 'db-view db-view-add';
  addView.textContent = '+';
  addView.title = 'Add a view';
  addView.addEventListener('click', dbAddView);
  tabsEl.appendChild(addView);
  head.appendChild(tabsEl);

  const sp = document.createElement('span'); sp.className = 'db-sp'; head.appendChild(sp);

  const search = document.createElement('input');
  search.className = 'db-search';
  search.placeholder = 'Search…';
  search.value = db.search || '';
  search.addEventListener('input', () => { db.search = search.value; renderDbBody(); });
  head.appendChild(search);

  const newBtn = document.createElement('button');
  newBtn.className = 'db-new';
  newBtn.textContent = '+ New';
  newBtn.addEventListener('click', dbNewRow);
  head.appendChild(newBtn);
  host.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'db-bar';
  bar.id = 'db-bar';
  host.appendChild(bar);

  const body = document.createElement('div');
  body.className = 'db-body';
  body.id = 'db-body';
  host.appendChild(body);

  renderDbBar();
  renderDbBody();
}

function dbPropNames() { return Object.keys(db.schema.properties || {}); }

function renderDbBar() {
  const bar = $('db-bar');
  if (!bar) return;
  const view = db.schema.views[db.viewIdx] || {};
  bar.innerHTML = '';

  const mk = (label, value, opts, onPick) => {
    const wrap = document.createElement('label');
    wrap.className = 'db-ctl';
    wrap.appendChild(Object.assign(document.createElement('span'), { textContent: label }));
    const sel = document.createElement('select');
    opts.forEach(o => {
      const op = document.createElement('option');
      op.value = o.value; op.textContent = o.label;
      if (String(o.value) === String(value)) op.selected = true;
      sel.appendChild(op);
    });
    sel.addEventListener('change', () => onPick(sel.value));
    wrap.appendChild(sel);
    bar.appendChild(wrap);
  };

  mk('View', view.type || 'table',
    [{ value: 'table', label: 'Table' }, { value: 'board', label: 'Board' },
     { value: 'calendar', label: 'Calendar' }, { value: 'gallery', label: 'Gallery' }],
    v => {
      view.type = v;
      if (v === 'board' && !view.group) view.group = dbPropNames()[0] || '';
      if (v === 'calendar' && !view.date) view.date = dbPropNames().find(p => (db.schema.properties[p] || {}).type === 'date') || '';
      dbSaveSchema(); renderDbAll();
    });

  if ((view.type || 'table') === 'calendar') {
    mk('Date by', view.date || '',
      dbPropNames().map(p => ({ value: p, label: p })),
      v => { view.date = v; dbSaveSchema(); renderDbBody(); });
  }
  if ((view.type || 'table') === 'board') {
    mk('Group by', view.group || '',
      dbPropNames().map(p => ({ value: p, label: p })),
      v => { view.group = v; dbSaveSchema(); renderDbBody(); });
  }

  const sorts = Array.isArray(view.sort) ? view.sort : (view.sort ? [view.sort] : []);
  const s0 = sorts[0] || {};
  mk('Sort', s0.prop || '',
    [{ value: '', label: 'None' }, { value: '__title', label: 'Name' }].concat(dbPropNames().map(p => ({ value: p, label: p }))),
    v => { view.sort = v ? [{ prop: v, dir: (s0.dir || 'asc') }] : []; dbSaveSchema(); renderDbBody(); });
  if (s0.prop) {
    mk('Dir', s0.dir || 'asc',
      [{ value: 'asc', label: 'Asc' }, { value: 'desc', label: 'Desc' }],
      v => { view.sort = [{ prop: s0.prop, dir: v }]; dbSaveSchema(); renderDbBody(); });
  }

  // filter chips
  const filters = Array.isArray(view.filter) ? view.filter : (view.filter ? [view.filter] : []);
  filters.forEach((f, idx) => {
    const chip = document.createElement('span');
    chip.className = 'db-chip';
    chip.textContent = `${f.prop} ${f.op} ${f.value == null ? '' : f.value}`.trim();
    const x = document.createElement('button');
    x.textContent = '✕';
    x.title = 'Remove filter';
    x.addEventListener('click', () => { filters.splice(idx, 1); view.filter = filters; dbSaveSchema(); renderDbBar(); renderDbBody(); });
    chip.appendChild(x);
    bar.appendChild(chip);
  });
  const addF = document.createElement('button');
  addF.className = 'db-addfilter';
  addF.textContent = '+ Filter';
  addF.addEventListener('click', () => {
    const prop = dbPropNames()[0];
    if (!prop) { toast('Add a property first'); return; }
    const next = filters.concat([{ prop, op: 'contains', value: '' }]);
    view.filter = next;
    dbSaveSchema(); renderDbBar(); renderDbBody();
    setTimeout(() => { const el = bar.querySelector('.db-chip:last-of-type'); if (el) dbEditFilter(el, view, next.length - 1); }, 0);
  });
  bar.appendChild(addF);
}

function dbEditFilter(chipEl, view, idx) {
  const filters = view.filter;
  const f = filters[idx];
  chipEl.innerHTML = '';
  chipEl.classList.add('editing');
  const propSel = document.createElement('select');
  dbPropNames().forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; if (p === f.prop) o.selected = true; propSel.appendChild(o); });
  const opSel = document.createElement('select');
  ['contains', 'is', 'is not', 'is empty', 'is not empty', '>', '<'].forEach(op => {
    const o = document.createElement('option'); o.value = op; o.textContent = op; if (op === f.op) o.selected = true; opSel.appendChild(o);
  });
  const val = document.createElement('input');
  val.className = 'db-filter-val';
  val.value = f.value == null ? '' : f.value;
  val.placeholder = 'value';
  const done = document.createElement('button');
  done.textContent = '✓';
  const apply = () => {
    f.prop = propSel.value; f.op = opSel.value; f.value = val.value;
    view.filter = filters; dbSaveSchema(); renderDbBar(); renderDbBody();
  };
  done.addEventListener('click', apply);
  val.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
  opSel.addEventListener('change', () => { val.style.display = /empty/.test(opSel.value) ? 'none' : ''; });
  val.style.display = /empty/.test(f.op) ? 'none' : '';
  [propSel, opSel, val, done].forEach(el => chipEl.appendChild(el));
  propSel.focus();
}

function renderDbBody() {
  const body = $('db-body');
  if (!body || !db) return;
  const view = db.schema.views[db.viewIdx] || {};
  body.innerHTML = '';
  const rows = dbVisibleRows();
  if (!db.rows.length) {
    body.innerHTML = '<div class="db-empty"><b>No pages yet</b><span>Every .md file in this folder becomes a row. Add one with “+ New”.</span></div>';
    return;
  }
  const vtype = view.type || 'table';
  if (vtype === 'board') renderDbBoard(body, rows, view);
  else if (vtype === 'calendar') renderDbCalendar(body, rows, view);
  else if (vtype === 'gallery') renderDbGallery(body, rows);
  else renderDbTable(body, rows);
  const count = document.createElement('div');
  count.className = 'db-count';
  count.textContent = rows.length + ' of ' + db.rows.length + (db.rows.length === 1 ? ' page' : ' pages');
  body.appendChild(count);
}

/* ---------- table --------------------------------------------------------- */

function renderDbTable(host, rows) {
  const props = dbPropNames();
  const wrap = document.createElement('div');
  wrap.className = 'db-tablewrap';
  const table = document.createElement('table');
  table.className = 'db-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(Object.assign(document.createElement('th'), { textContent: 'Name', className: 'db-th-name' }));
  props.forEach(p => {
    const th = document.createElement('th');
    th.textContent = p;
    th.title = (db.schema.properties[p] || {}).type || 'text';
    hr.appendChild(th);
  });
  const addTh = document.createElement('th');
  addTh.className = 'db-th-add';
  const addBtn = document.createElement('button');
  addBtn.textContent = '+';
  addBtn.title = 'Add a property';
  addBtn.addEventListener('click', dbAddProperty);
  addTh.appendChild(addBtn);
  hr.appendChild(addTh);
  thead.appendChild(hr);
  table.appendChild(thead);

  const tb = document.createElement('tbody');
  rows.forEach(row => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.className = 'db-name';
    const a = document.createElement('button');
    a.className = 'db-open';
    a.textContent = row.title;
    a.title = 'Open ' + row.name;
    a.addEventListener('click', () => dbOpenRow(row));
    nameTd.appendChild(a);
    tr.appendChild(nameTd);
    props.forEach(p => tr.appendChild(dbCell(row, p)));
    tr.appendChild(document.createElement('td'));
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

function dbCell(row, key) {
  const td = document.createElement('td');
  td.className = 'db-cell';
  const type = ((db.schema.properties[key] || {}).type) || 'text';
  const value = dbCellText(row, key);

  // formulas and rollups are derived — there is nothing in the file to edit
  if (type === 'formula' || type === 'rollup') {
    const v = String(value);
    td.className = 'db-cell db-computed';
    td.title = type === 'formula'
      ? 'Formula: ' + ((db.schema.properties[key] || {}).expr || '')
      : 'Rollup of ' + ((db.schema.properties[key] || {}).target || '');
    if (/^⚠/.test(v)) td.classList.add('db-fx-error');
    td.textContent = v || '—';
    if (!v) td.classList.add('db-blank');
    return td;
  }

  // relations open a picker over the target database
  if (type === 'relation') {
    const names = dbWikiNames(row.props[key]);
    if (!names.length) td.appendChild(Object.assign(document.createElement('span'), { className: 'db-blank', textContent: '—' }));
    names.forEach(n => {
      const chip = document.createElement('button');
      chip.className = 'db-rel';
      chip.textContent = n;
      chip.addEventListener('click', (e) => { e.stopPropagation(); openWikiLink(n); });
      td.appendChild(chip);
    });
    td.classList.add('db-editable');
    td.addEventListener('click', () => dbEditRelation(td, row, key));
    return td;
  }

  if (type === 'checkbox') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = /^(true|yes|1|x|done)$/i.test(value);
    cb.addEventListener('change', () => dbSetRowProp(row, key, cb.checked ? 'true' : 'false'));
    td.appendChild(cb);
    return td;
  }
  if (type === 'select' || type === 'multi_select') {
    const parts = type === 'multi_select' ? value.split(',').map(s => s.trim()).filter(Boolean) : (value ? [value] : []);
    parts.forEach(v => {
      const pill = document.createElement('span');
      pill.className = 'db-pill';
      pill.textContent = v;
      pill.style.setProperty('--pill', dbOptColor(key, v));
      td.appendChild(pill);
    });
    if (!parts.length) td.appendChild(Object.assign(document.createElement('span'), { className: 'db-blank', textContent: '—' }));
    td.classList.add('db-editable');
    td.addEventListener('click', () => dbEditCell(td, row, key, type));
    return td;
  }
  td.textContent = value || '—';
  if (!value) td.classList.add('db-blank');
  td.classList.add('db-editable');
  td.addEventListener('click', () => dbEditCell(td, row, key, type));
  return td;
}

function dbEditCell(td, row, key, type) {
  if (td.querySelector('input, select')) return;
  const current = dbCellText(row, key);
  let input;
  if (type === 'select') {
    input = document.createElement('select');
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = '—'; input.appendChild(blank);
    const opts = dbSelectOptions(key);
    if (current && !opts.some(o => o.toLowerCase() === current.toLowerCase())) opts.push(current);
    opts.forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o; if (o === current) op.selected = true; input.appendChild(op); });
    const other = document.createElement('option'); other.value = '__new'; other.textContent = '+ New option…'; input.appendChild(other);
  } else {
    input = document.createElement('input');
    input.type = type === 'date' ? 'date' : type === 'number' ? 'number' : 'text';
    input.value = current;
  }
  input.className = 'db-input';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  if (input.select) try { input.select(); } catch (_) {}
  let closed = false;
  const commit = async (save) => {
    if (closed) return; closed = true;
    let v = save ? input.value : current;
    if (save && v === '__new') {
      const el = document.createElement('input');
      el.className = 'db-input'; el.placeholder = 'New option…';
      td.innerHTML = ''; td.appendChild(el); el.focus();
      closed = false;
      const fin = async (ok) => {
        if (closed) return; closed = true;
        const nv = ok ? el.value.trim() : '';
        if (nv) {
          const p = db.schema.properties[key] || (db.schema.properties[key] = { type: 'select' });
          p.options = Array.isArray(p.options) ? p.options : [];
          if (!p.options.some(o => String(o).toLowerCase() === nv.toLowerCase())) { p.options.push(nv); dbSaveSchema(); }
          await dbSetRowProp(row, key, nv);
        }
        renderDbBody();
      };
      el.addEventListener('blur', () => fin(true));
      el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fin(true); } else if (e.key === 'Escape') fin(false); });
      return;
    }
    if (save && v !== current) await dbSetRowProp(row, key, v);
    renderDbBody();
  };
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  if (type === 'select') input.addEventListener('change', () => commit(true));
}

/* ---------- board --------------------------------------------------------- */

function renderDbBoard(host, rows, view) {
  const key = view.group || dbPropNames()[0];
  if (!key) { host.innerHTML = '<div class="db-empty"><b>Nothing to group by</b><span>Add a property first.</span></div>'; return; }
  const cols = dbSelectOptions(key);
  const board = document.createElement('div');
  board.className = 'db-board';
  const groups = [{ opt: '', label: 'No ' + key }].concat(cols.map(o => ({ opt: o, label: o })));
  groups.forEach(g => {
    const col = document.createElement('div');
    col.className = 'db-col';
    col.dataset.opt = g.opt;
    const h = document.createElement('div');
    h.className = 'db-col-head';
    const dot = document.createElement('i');
    dot.className = 'db-dot';
    dot.style.background = g.opt ? dbOptColor(key, g.opt) : 'var(--border)';
    h.appendChild(dot);
    h.appendChild(Object.assign(document.createElement('span'), { textContent: g.label }));
    const mine = rows.filter(r => (dbCellText(r, key).trim() || '') === g.opt);
    h.appendChild(Object.assign(document.createElement('b'), { textContent: String(mine.length) }));
    col.appendChild(h);
    const list = document.createElement('div');
    list.className = 'db-col-list';
    mine.forEach(r => list.appendChild(dbCard(r, key)));
    col.appendChild(list);
    const add = document.createElement('button');
    add.className = 'db-col-add';
    add.textContent = '+ New';
    add.addEventListener('click', async () => { await dbNewRow(); const last = db.rows[db.rows.length - 1]; if (g.opt) await dbSetRowProp(last, key, g.opt); renderDbBody(); });
    col.appendChild(add);
    board.appendChild(col);
  });
  host.appendChild(board);
}

function dbCard(row, groupKey) {
  const card = document.createElement('div');
  card.className = 'db-card';
  card.dataset.path = row.path;
  const t = document.createElement('div');
  t.className = 'db-card-title';
  t.textContent = row.title;
  card.appendChild(t);
  const meta = document.createElement('div');
  meta.className = 'db-card-meta';
  dbPropNames().filter(p => p !== groupKey).slice(0, 3).forEach(p => {
    const v = dbCellText(row, p);
    if (!v) return;
    const s = document.createElement('span');
    s.className = 'db-card-prop';
    s.textContent = v;
    meta.appendChild(s);
  });
  if (meta.children.length) card.appendChild(meta);
  dbWireCardDrag(card, row, groupKey);
  return card;
}

// Pointer-events drag (not HTML5 DnD): works with touch on Android, and can be
// driven by synthetic events in tests.
function dbWireCardDrag(card, row, groupKey) {
  card.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    let dragging = false, ghost = null;
    const onMove = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      if (!dragging) {
        dragging = true;
        card.classList.add('dragging');
        ghost = card.cloneNode(true);
        ghost.className = 'db-card db-ghost';
        ghost.style.width = card.offsetWidth + 'px';
        document.body.appendChild(ghost);
        try { card.setPointerCapture(e.pointerId); } catch (_) {}
      }
      ghost.style.left = (ev.clientX - 20) + 'px';
      ghost.style.top = (ev.clientY - 14) + 'px';
      document.querySelectorAll('.db-col').forEach(c => c.classList.remove('drop'));
      const col = dbColAt(ev.clientX, ev.clientY);
      if (col) col.classList.add('drop');
    };
    const onUp = async (ev) => {
      card.removeEventListener('pointermove', onMove);
      card.removeEventListener('pointerup', onUp);
      card.removeEventListener('pointercancel', onUp);
      if (ghost) ghost.remove();
      card.classList.remove('dragging');
      document.querySelectorAll('.db-col').forEach(c => c.classList.remove('drop'));
      if (!dragging) { dbOpenRow(row); return; }         // a click, not a drag
      const col = dbColAt(ev.clientX, ev.clientY);
      if (!col) return;
      const opt = col.dataset.opt || '';
      if ((dbCellText(row, groupKey).trim() || '') === opt) return;
      await dbSetRowProp(row, groupKey, opt || null);
      renderDbBody();
    };
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
    card.addEventListener('pointercancel', onUp);
  });
}

function dbColAt(x, y) {
  return [...document.querySelectorAll('.db-col')].find(c => {
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }) || null;
}

/* ---------- actions ------------------------------------------------------- */

function dbOpenRow(row) {
  if (TAURI && row.path) openTauriPath(row.path);
  else toast('Open the folder in the app to edit this page');
}

function dbAddProperty() {
  const bar = $('db-bar');
  if (!bar || bar.querySelector('.db-newprop')) return;
  const wrap = document.createElement('span');
  wrap.className = 'db-chip db-newprop editing';
  const name = document.createElement('input');
  name.placeholder = 'Property name…';
  name.className = 'db-filter-val';
  const type = document.createElement('select');
  DB_TYPES.forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t.replace('_', '-'); type.appendChild(o); });
  const ok = document.createElement('button');
  ok.textContent = '✓';
  const commit = () => {
    const n = name.value.trim();
    if (n && !db.schema.properties[n]) {
      db.schema.properties[n] = { type: type.value };
      if (type.value === 'select' || type.value === 'multi_select') db.schema.properties[n].options = [];
      dbSaveSchema();
    }
    wrap.remove();
    renderDbBar(); renderDbBody();
  };
  ok.addEventListener('click', commit);
  name.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') { wrap.remove(); } });
  [name, type, ok].forEach(el => wrap.appendChild(el));
  bar.appendChild(wrap);
  name.focus();
}

function dbAddView() {
  const type = (db.schema.views[db.viewIdx] || {}).type === 'board' ? 'table' : 'board';
  const v = { name: type === 'board' ? 'Board' : 'Table', type };
  if (type === 'board') v.group = dbPropNames()[0] || '';
  db.schema.views.push(v);
  db.viewIdx = db.schema.views.length - 1;
  dbSaveSchema();
  renderDbAll();
}

/* ---------- entry points -------------------------------------------------- */

async function openDatabase(folderPath) {
  if (!folderPath) { toast('Open a folder first'); return; }
  const name = folderPath.split(/[/\\]/).filter(Boolean).pop() || 'Database';
  const existing = tabs.find(t => t.kind === 'db' && t.dbFolder === folderPath);
  if (existing) { activate(existing.id); return; }
  const tab = await makeTab({ name, mtime: 0 }, 'db', { text: '' });
  tab.dbFolder = folderPath;
  tab.kind = 'db';
  db = null;                       // force a fresh load for this folder
  addTab(tab);
}

// Turn the open folder into a database: writes the schema file if absent.
async function createDatabaseHere(folderPath) {
  const target = folderPath || (folder && folder.root);
  if (!target) { toast('Open a folder first (⌘⇧O)'); return; }
  const schemaPath = dbJoin(target, DB_SCHEMA_FILE);
  const existing = await dbFs.read(schemaPath);
  if (!existing) {
    const name = target.split(/[/\\]/).filter(Boolean).pop() || 'Database';
    await dbFs.write(schemaPath, dumpSchema(dbDefaultSchema(name)));
    toast('Created ' + DB_SCHEMA_FILE);
  }
  db = null;
  await openDatabase(target);
}

function wireDb() {
  // reload when the folder changes underneath us (e.g. a row edited in a tab)
  window.addEventListener('focus', () => {
    const t = activeTab();
    if (t && t.kind === 'db' && db && db.folder === t.dbFolder) {
      dbLoad(db.folder).then(next => {
        const view = db.viewIdx, search = db.search;
        db = next; db.viewIdx = Math.min(view, db.schema.views.length - 1); db.search = search;
        if (activeTab() === t) renderDbBody();
      }).catch(() => {});
    }
  });
}

/* ==========================================================================
   N4 — Blocks

   Notion's editor feels good because of structure you can manipulate. Every
   block here must degrade to something a human can read in a plain text
   editor — that is the rule that decides the syntax:

     toggle        <details><summary>       valid MD, renders on GitHub
     columns       ::: columns / :: col     literal markers, content readable
     block id      ^b7f2                    Obsidian-compatible anchor
     transclusion  ![[page#^b7f2]]          one source of truth, rendered live
     inline view   ```vedrix-view fence     an N3 database embedded in a page

   No proprietary JSON blobs. Each has a matching turndown rule so a rich
   edit round-trips back to the same source.
   ========================================================================== */

/* ---------- markdown-it plugins ------------------------------------------ */

// ::: columns / :: col / ::: — a container the reader can still parse by eye
function columnsPlugin(mdit) {
  mdit.block.ruler.before('fence', 'vxcolumns', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const line = state.src.slice(start, state.eMarks[startLine]).trim();
    if (!/^:::\s*columns\s*$/i.test(line)) return false;
    if (silent) return true;
    let depth = 1, close = -1;
    for (let ln = startLine + 1; ln < endLine; ln++) {
      const l = state.src.slice(state.bMarks[ln] + state.tShift[ln], state.eMarks[ln]).trim();
      if (/^:::\s*columns\s*$/i.test(l)) depth++;
      else if (/^:::\s*$/.test(l)) { depth--; if (!depth) { close = ln; break; } }
    }
    if (close < 0) return false;                       // unterminated → not a container
    const body = state.getLines(startLine + 1, close, 0, false);
    const parts = body.split(/^[ \t]*::[ \t]*col[ \t]*$/mi).map(s => s.trim());
    const token = state.push('vxcolumns', 'div', 0);
    token.block = true;
    token.meta = { parts: parts.length > 1 ? parts.filter((p, i) => i > 0 || p) : parts };
    state.line = close + 1;
    return true;
  });
  mdit.renderer.rules.vxcolumns = (tokens, idx) => {
    const parts = tokens[idx].meta.parts;
    return '<div class="vx-columns" data-cols="' + parts.length + '">' +
      parts.map(p => '<div class="vx-col">' + mdit.render(p) + '</div>').join('') + '</div>';
  };
}

// a trailing " ^b7f2" marks the block so it can be linked and transcluded
function blockIdPlugin(mdit) {
  mdit.inline.ruler.before('text', 'vxbid', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x5E) return false;   // ^
    const m = /^\^([A-Za-z0-9_-]{2,32})[ \t]*$/.exec(state.src.slice(state.pos));
    if (!m) return false;                                          // only at the very end
    if (!silent) {
      const t = state.push('html_inline', '', 0);
      t.content = '<span class="vx-bid" data-bid="' + vxAttr(m[1]) + '" contenteditable="false"></span>';
    }
    state.pos = state.src.length;
    return true;
  });
}

// ![[page]] / ![[page#Heading]] / ![[page#^id]] on its own line → live embed
function embedPlugin(mdit) {
  mdit.block.ruler.before('paragraph', 'vxembed', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const line = state.src.slice(start, state.eMarks[startLine]).trim();
    const m = /^!\[\[([^\]]+)\]\]$/.exec(line);
    if (!m) return false;
    if (silent) return true;
    const token = state.push('vxembed', 'div', 0);
    token.block = true;
    token.meta = { target: m[1].trim() };
    state.line = startLine + 1;
    return true;
  });
  mdit.renderer.rules.vxembed = (tokens, idx) => {
    const target = tokens[idx].meta.target;
    return '<div class="vx-embed" data-embed="' + vxAttr(target) + '" contenteditable="false">' +
      '<div class="vx-embed-head"><span class="vx-embed-src">' + escHtml(String(target)) + '</span></div>' +
      '<div class="vx-embed-body vx-embed-load">Loading…</div></div>';
  };
}

function vxAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

/* ---------- transclusion: resolve, slice, render -------------------------- */

// "#Heading" → that section; "#^id" → the block carrying that id; else whole page
function extractFragment(text, frag) {
  const body = splitFm(text).body;
  if (!frag) return body.trim();
  if (frag.startsWith('^')) {
    const id = frag.slice(1);
    const re = new RegExp('\\^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*$');
    const lines = body.split(/\r?\n/);
    const hit = lines.findIndex(l => re.test(l));
    if (hit < 0) return '';
    // walk back to the start of that block (blank line or start of file)
    let from = hit;
    while (from > 0 && lines[from - 1].trim()) from--;
    return lines.slice(from, hit + 1).join('\n').replace(re, '').trim();
  }
  const lines = body.split(/\r?\n/);
  const want = frag.trim().toLowerCase();
  const at = lines.findIndex(l => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, '').trim().toLowerCase() === want);
  if (at < 0) return '';
  const level = (lines[at].match(/^#+/) || ['#'])[0].length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(at, end).join('\n').trim();
}

async function renderEmbeds(t) {
  const nodes = [...contentEl.querySelectorAll('.vx-embed[data-embed]:not([data-vx-done])')];
  for (const el of nodes) {
    el.setAttribute('data-vx-done', '1');
    const raw = el.getAttribute('data-embed') || '';
    const hash = raw.indexOf('#');
    const target = (hash > -1 ? raw.slice(0, hash) : raw).trim();
    const frag = hash > -1 ? raw.slice(hash + 1).trim() : '';
    const body = el.querySelector('.vx-embed-body');
    const head = el.querySelector('.vx-embed-head');
    const hit = resolveWiki(target);
    if (!hit) {
      body.className = 'vx-embed-body vx-embed-missing';
      body.textContent = 'No page named “' + target + '”';
      continue;
    }
    if (head) {
      const open = document.createElement('button');
      open.className = 'vx-embed-open';
      open.textContent = 'Open';
      open.title = 'Open ' + hit.title;
      open.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openWikiLink(target); });
      head.appendChild(open);
    }
    try {
      const text = TAURI ? (await TAURI.core.invoke('read_md_file', { path: hit.path })).text
                         : ((window.__dbMock && window.__dbMock.files[hit.path]) || '');
      const slice = extractFragment(text, frag);
      if (!slice) {
        body.className = 'vx-embed-body vx-embed-missing';
        body.textContent = frag ? 'Nothing found at “' + frag + '” in ' + hit.title : hit.title + ' is empty';
        continue;
      }
      body.className = 'vx-embed-body markdown-body';
      body.innerHTML = DOMPurify.sanitize(md.render(slice), { ADD_ATTR: ['data-wiki', 'data-bid', 'data-embed', 'data-cols'] });
      body.querySelectorAll('.vx-embed').forEach(n => n.remove());   // one level deep only
    } catch (err) {
      body.className = 'vx-embed-body vx-embed-missing';
      body.textContent = 'Could not read ' + hit.title;
    }
  }
}

/* ---------- inline database view (```vedrix-view) ------------------------- */

async function renderInlineViews(t) {
  const blocks = [...contentEl.querySelectorAll('pre > code.language-vedrix-view, pre > code.language-vedrix')]
    .map(c => c.parentElement)
    .filter(p => !p.hasAttribute('data-vx-done'));
  for (const pre of blocks) {
    pre.setAttribute('data-vx-done', '1');
    const spec = parseYamlLite(pre.textContent || '') || {};
    const host = document.createElement('div');
    host.className = 'vx-dbview';
    host.contentEditable = 'false';
    host.dataset.spec = pre.textContent || '';
    pre.replaceWith(host);
    const folderName = String(spec.folder || spec.database || '').trim();
    if (!folderName) { host.innerHTML = '<div class="vx-dbview-empty">Set <code>folder:</code> to embed a database.</div>'; continue; }
    const root = folder && folder.root;
    const path = /^[/~]|^[A-Za-z]:/.test(folderName) ? folderName : (root ? root.replace(/[/\\]+$/, '') + '/' + folderName : folderName);
    try {
      const loaded = await dbLoad(path);
      const view = (loaded.schema.views || []).find(v => String(v.name).toLowerCase() === String(spec.view || '').toLowerCase())
                 || loaded.schema.views[0] || { type: 'table' };
      renderInlineTable(host, loaded, view, spec, path);
    } catch (err) {
      host.innerHTML = '<div class="vx-dbview-empty">Could not read database “' + escHtml(String(folderName)) + '”.</div>';
    }
  }
}

function renderInlineTable(host, loaded, view, spec, path) {
  const head = document.createElement('div');
  head.className = 'vx-dbview-head';
  head.appendChild(Object.assign(document.createElement('span'), { className: 'vx-dbview-name', textContent: loaded.schema.name || 'Database' }));
  head.appendChild(Object.assign(document.createElement('span'), { className: 'vx-dbview-view', textContent: view.name || 'Table' }));
  const open = document.createElement('button');
  open.className = 'vx-dbview-open';
  open.textContent = 'Open database';
  open.addEventListener('click', () => openDatabase(path));
  head.appendChild(open);
  host.appendChild(head);

  const prev = db;
  db = loaded;                                  // dbVisibleRows reads the module state
  let rows;
  try {
    const idx = loaded.schema.views.indexOf(view);
    loaded.viewIdx = idx < 0 ? 0 : idx;
    rows = dbVisibleRows();
  } finally { db = prev; }

  const limit = Number(spec.limit) > 0 ? Number(spec.limit) : 8;
  const shown = rows.slice(0, limit);
  const props = Object.keys(loaded.schema.properties || {}).slice(0, 3);
  const wrap = document.createElement('div');
  wrap.className = 'vx-dbview-wrap';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(Object.assign(document.createElement('th'), { textContent: 'Name' }));
  props.forEach(p => hr.appendChild(Object.assign(document.createElement('th'), { textContent: p })));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tb = document.createElement('tbody');
  shown.forEach(r => {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    const a = document.createElement('button');
    a.className = 'vx-dbview-row';
    a.textContent = r.title;
    a.addEventListener('click', () => { if (TAURI && r.path) openTauriPath(r.path); });
    td.appendChild(a);
    tr.appendChild(td);
    props.forEach(p => {
      const cell = document.createElement('td');
      const v = (loaded.schema.properties[p] || {}).type === 'select' ? '' : '';
      const text = Array.isArray(r.props[p]) ? r.props[p].join(', ') : (r.props[p] == null ? '' : String(r.props[p]));
      if (text && (loaded.schema.properties[p] || {}).type === 'select') {
        const pill = document.createElement('span');
        pill.className = 'db-pill';
        pill.textContent = text;
        pill.style.setProperty('--pill', dbOptColor(p, text));
        cell.appendChild(pill);
      } else cell.textContent = text || '—';
      tr.appendChild(cell);
    });
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
  host.appendChild(wrap);
  const foot = document.createElement('div');
  foot.className = 'vx-dbview-foot';
  foot.textContent = rows.length > limit ? `Showing ${limit} of ${rows.length}` : `${rows.length} ${rows.length === 1 ? 'page' : 'pages'}`;
  host.appendChild(foot);
}

/* ---------- insert (slash menu) ------------------------------------------ */

function insertToggle() {
  const d = document.createElement('details');
  d.open = true;
  const s = document.createElement('summary');
  s.textContent = 'Toggle';
  const p = document.createElement('p');
  p.innerHTML = '<br>';
  d.appendChild(s);
  d.appendChild(p);
  insertBlockAfterCurrent(d);
  placeCaretIn(s);
}

function insertColumns(n = 2) {
  const wrap = document.createElement('div');
  wrap.className = 'vx-columns';
  wrap.dataset.cols = String(n);
  for (let i = 0; i < n; i++) {
    const col = document.createElement('div');
    col.className = 'vx-col';
    const p = document.createElement('p');
    p.innerHTML = '<br>';
    col.appendChild(p);
    wrap.appendChild(col);
  }
  insertBlockAfterCurrent(wrap);
  placeCaretIn(wrap.querySelector('.vx-col p'));
}

function insertEmbedPrompt() {
  const blk = currentBlock();
  if (!blk) return;
  // type the syntax for them and leave the caret inside the brackets
  const p = document.createElement('p');
  p.textContent = '![[]]';
  insertBlockAfterCurrent(p);
  const tn = p.firstChild;
  const sel = getSelection();
  const r = document.createRange();
  r.setStart(tn, 3); r.setEnd(tn, 3);
  sel.removeAllRanges(); sel.addRange(r);
  toast('Type a page name between the brackets');
}

function insertInlineDbView() {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-vedrix-view';
  code.textContent = 'folder: ' + ((folder && folder.root) ? '' : '') + '\nview: Table\nlimit: 8';
  pre.appendChild(code);
  insertBlockAfterCurrent(pre);
  placeCaretIn(code);
  toast('Set folder: to a database folder name');
}

function addBlockId() {
  const blk = currentBlock();
  if (!blk) { toast('Put the caret in a block first'); return; }
  if (blk.querySelector('.vx-bid')) { toast('This block already has an id'); return; }
  const id = Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 4);
  const span = document.createElement('span');
  span.className = 'vx-bid';
  span.dataset.bid = id;
  span.contentEditable = 'false';
  blk.appendChild(document.createTextNode(' '));
  blk.appendChild(span);
  onRichInput();
  navigator.clipboard && navigator.clipboard.writeText('![[' + (activeTab() ? activeTab().name.replace(/\.md$/i, '') : '') + '#^' + id + ']]')
    .then(() => toast('Block id ^' + id + ' — embed syntax copied'), () => toast('Block id ^' + id));
}

function placeCaretIn(el) {
  if (!el) return;
  const sel = getSelection();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------- templates ----------------------------------------------------- */

const TEMPLATE_DIR = '_templates';

function listTemplates() {
  if (!folder) return [];
  if (pageIndex.dirty) buildPageIndex();
  return pageIndex.pages.filter(p => /(^|[/\\])_templates[/\\]/i.test(p.rel));
}

async function newFromTemplate(tpl) {
  if (!TAURI || !folder) { toast('Open a folder first'); return; }
  try {
    const src = (await TAURI.core.invoke('read_md_file', { path: tpl.path })).text;
    const stamp = new Date();
    const filled = src
      .replace(/\{\{date\}\}/gi, stamp.toISOString().slice(0, 10))
      .replace(/\{\{time\}\}/gi, stamp.toTimeString().slice(0, 5))
      .replace(/\{\{title\}\}/gi, tpl.title);
    let name = tpl.title + '.md', n = 2;
    const taken = new Set(pageIndex.pages.map(p => p.title.toLowerCase()));
    while (taken.has(name.replace(/\.md$/i, '').toLowerCase())) { name = tpl.title + ' ' + (n++) + '.md'; }
    const path = folder.root.replace(/[/\\]+$/, '') + '/' + name;
    await TAURI.core.invoke('write_file', { path, contents: filled });
    pageIndex.dirty = true;
    await openTauriPath(path);
    toast('Created ' + name);
  } catch (err) {
    console.error(err);
    toast('Could not create the page');
  }
}

/* ---------- turndown: every block returns to its source form -------------- */

function registerBlockRules(td) {
  // <details> — convert children so nested markdown survives the round-trip
  td.addRule('vxtoggle', {
    filter: (n) => n.nodeName === 'DETAILS',
    replacement: (content, node) => {
      const clone = node.cloneNode(true);
      const sum = clone.querySelector('summary');
      const title = sum ? sum.textContent.trim() : 'Toggle';
      if (sum) sum.remove();
      const inner = htmlToMarkdown(clone.innerHTML).trim();
      return '\n\n<details><summary>' + title + '</summary>\n\n' + inner + '\n\n</details>\n\n';
    },
  });
  td.addRule('vxcolumns', {
    filter: (n) => n.nodeType === 1 && n.classList && n.classList.contains('vx-columns'),
    replacement: (content, node) => {
      const cols = [...node.querySelectorAll(':scope > .vx-col')]
        .map(c => htmlToMarkdown(c.innerHTML).trim());
      return '\n\n::: columns\n' + cols.map(c => ':: col\n' + c).join('\n') + '\n:::\n\n';
    },
  });
  td.addRule('vxbid', {
    filter: (n) => n.nodeType === 1 && n.classList && n.classList.contains('vx-bid'),
    replacement: (content, node) => ' ^' + (node.getAttribute('data-bid') || ''),
  });
  td.addRule('vxembed', {
    filter: (n) => n.nodeType === 1 && n.classList && n.classList.contains('vx-embed'),
    replacement: (content, node) => '\n\n![[' + (node.getAttribute('data-embed') || '') + ']]\n\n',
  });
  td.addRule('vxdbview', {
    filter: (n) => n.nodeType === 1 && n.classList && n.classList.contains('vx-dbview'),
    replacement: (content, node) => '\n\n```vedrix-view\n' + (node.dataset.spec || '').trim() + '\n```\n\n',
  });
}

/* ==========================================================================
   N5 — Databases v2: relations, rollups, formulas, calendar + gallery

   Formulas are evaluated by a hand-written tokenizer/parser/interpreter.
   NEVER eval() or new Function(): the expression comes out of a file on
   disk, so running it as JavaScript would be arbitrary code execution from
   untrusted content. The language below is closed — it can only do what
   these functions allow.
   ========================================================================== */

/* ---------- tokenizer ----------------------------------------------------- */

function fxTokenize(src) {
  const out = [];
  const s = String(src || '');
  let i = 0;
  const isDigit = c => c >= '0' && c <= '9';
  const isIdent = c => /[A-Za-z_$À-￿]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
      let j = i;
      while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
      out.push({ t: 'num', v: Number(s.slice(i, j)) });
      i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, buf = '';
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\' && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
        buf += s[j]; j++;
      }
      out.push({ t: 'str', v: buf });
      i = j + 1; continue;
    }
    if (isIdent(c)) {
      let j = i;
      while (j < s.length && (isIdent(s[j]) || isDigit(s[j]) || s[j] === ' ' && false)) j++;
      out.push({ t: 'ident', v: s.slice(i, j) });
      i = j; continue;
    }
    const three = s.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(three)) { out.push({ t: 'op', v: three }); i += 2; continue; }
    if ('+-*/%<>!(),?:'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('Unexpected character “' + c + '”');
  }
  out.push({ t: 'end' });
  return out;
}

/* ---------- parser (precedence climbing) → AST ---------------------------- */

const FX_BINARY = [
  ['||', 'or'], ['&&', 'and'],
  ['==', '!=', '<', '>', '<=', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

function fxParse(src) {
  const toks = fxTokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { if (toks[p].v === v || toks[p].t === v) return toks[p++]; return null; };
  const expect = (v) => { const t = eat(v); if (!t) throw new Error('Expected ' + v); return t; };

  function primary() {
    const t = peek();
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === 'str') { p++; return { k: 'str', v: t.v }; }
    if (t.t === 'op' && (t.v === '-' || t.v === '!')) { p++; return { k: 'unary', op: t.v, a: primary() }; }
    if (t.t === 'ident' && t.v.toLowerCase() === 'not') { p++; return { k: 'unary', op: '!', a: primary() }; }
    if (t.t === 'op' && t.v === '(') { p++; const e = expr(0); expect(')'); return e; }
    if (t.t === 'ident') {
      p++;
      const name = t.v;
      if (peek().t === 'op' && peek().v === '(') {
        p++;
        const args = [];
        if (!(peek().t === 'op' && peek().v === ')')) {
          for (;;) { args.push(expr(0)); if (peek().t === 'op' && peek().v === ',') { p++; continue; } break; }
        }
        expect(')');
        return { k: 'call', name, args };
      }
      const low = name.toLowerCase();
      if (low === 'true') return { k: 'bool', v: true };
      if (low === 'false') return { k: 'bool', v: false };
      return { k: 'ref', name };                 // bare identifier = property name
    }
    throw new Error('Unexpected ' + (t.t === 'end' ? 'end of formula' : '“' + t.v + '”'));
  }

  function expr(level) {
    if (level >= FX_BINARY.length) return primary();
    let left = expr(level + 1);
    for (;;) {
      const t = peek();
      const ops = FX_BINARY[level];
      const match = t.t === 'op' ? ops.includes(t.v)
        : (t.t === 'ident' && ops.includes(String(t.v).toLowerCase()));
      if (!match) break;
      const op = t.t === 'op' ? t.v : String(t.v).toLowerCase();
      p++;
      const right = expr(level + 1);
      left = { k: 'bin', op: op === 'or' ? '||' : op === 'and' ? '&&' : op, a: left, b: right };
    }
    // ternary sits above the binaries
    if (level === 0 && peek().t === 'op' && peek().v === '?') {
      p++;
      const a = expr(0); expect(':'); const b = expr(0);
      return { k: 'cond', c: left, a, b };
    }
    return left;
  }

  const ast = expr(0);
  if (peek().t !== 'end') throw new Error('Unexpected “' + peek().v + '”');
  return ast;
}

/* ---------- evaluator ----------------------------------------------------- */

const fxNum = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v == null ? '' : v).trim());
  return isNaN(n) ? 0 : n;
};
const fxStr = (v) => v == null ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const fxTruthy = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = fxStr(v).trim().toLowerCase();
  return !!s && s !== 'false' && s !== '0' && s !== 'no';
};
const fxDate = (v) => {
  if (v instanceof Date) return v;
  const s = fxStr(v).trim();
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00' : s);
  return isNaN(d.getTime()) ? null : d;
};
const FX_DAY = 86400000;

const FX_FUNCS = {
  if: (c, a, b) => fxTruthy(c) ? a : (b === undefined ? '' : b),
  and: (...a) => a.every(fxTruthy),
  or: (...a) => a.some(fxTruthy),
  not: (a) => !fxTruthy(a),
  empty: (a) => !fxStr(a).trim(),
  concat: (...a) => a.map(fxStr).join(''),
  join: (sep, ...a) => a.map(fxStr).filter(Boolean).join(fxStr(sep)),
  length: (a) => Array.isArray(a) ? a.length : fxStr(a).length,
  upper: (a) => fxStr(a).toUpperCase(),
  lower: (a) => fxStr(a).toLowerCase(),
  trim: (a) => fxStr(a).trim(),
  contains: (a, b) => fxStr(a).toLowerCase().includes(fxStr(b).toLowerCase()),
  startswith: (a, b) => fxStr(a).toLowerCase().startsWith(fxStr(b).toLowerCase()),
  endswith: (a, b) => fxStr(a).toLowerCase().endsWith(fxStr(b).toLowerCase()),
  replace: (a, b, c) => fxStr(a).split(fxStr(b)).join(fxStr(c)),
  slice: (a, s, e) => fxStr(a).slice(fxNum(s), e === undefined ? undefined : fxNum(e)),
  number: fxNum,
  text: fxStr,
  round: (a, n) => { const f = Math.pow(10, n === undefined ? 0 : fxNum(n)); return Math.round(fxNum(a) * f) / f; },
  floor: (a) => Math.floor(fxNum(a)),
  ceil: (a) => Math.ceil(fxNum(a)),
  abs: (a) => Math.abs(fxNum(a)),
  min: (...a) => Math.min(...a.map(fxNum)),
  max: (...a) => Math.max(...a.map(fxNum)),
  sum: (...a) => a.flat().reduce((s, v) => s + fxNum(v), 0),
  today: () => new Date(new Date().toDateString()),
  now: () => new Date(),
  year: (d) => { const x = fxDate(d); return x ? x.getFullYear() : 0; },
  month: (d) => { const x = fxDate(d); return x ? x.getMonth() + 1 : 0; },
  day: (d) => { const x = fxDate(d); return x ? x.getDate() : 0; },
  datediff: (a, b, unit) => {
    const x = fxDate(a), y = fxDate(b);
    if (!x || !y) return 0;
    const days = Math.round((x - y) / FX_DAY);
    const u = fxStr(unit || 'days').toLowerCase();
    return u.startsWith('week') ? Math.round(days / 7) : u.startsWith('month') ? Math.round(days / 30) : u.startsWith('year') ? Math.round(days / 365) : days;
  },
  dateadd: (d, n, unit) => {
    const x = fxDate(d);
    if (!x) return '';
    const u = fxStr(unit || 'days').toLowerCase();
    const mult = u.startsWith('week') ? 7 : 1;
    const out = new Date(x.getTime());
    if (u.startsWith('month')) out.setMonth(out.getMonth() + fxNum(n));
    else if (u.startsWith('year')) out.setFullYear(out.getFullYear() + fxNum(n));
    else out.setDate(out.getDate() + fxNum(n) * mult);
    return out;
  },
  formatdate: (d, fmt) => {
    const x = fxDate(d);
    if (!x) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return fxStr(fmt || 'YYYY-MM-DD')
      .replace(/YYYY/g, x.getFullYear())
      .replace(/MM/g, pad(x.getMonth() + 1))
      .replace(/DD/g, pad(x.getDate()));
  },
};

function fxEval(node, ctx) {
  switch (node.k) {
    case 'num': case 'str': case 'bool': return node.v;
    case 'ref': return ctx.get(node.name);
    case 'unary': {
      const v = fxEval(node.a, ctx);
      return node.op === '-' ? -fxNum(v) : !fxTruthy(v);
    }
    case 'cond': return fxTruthy(fxEval(node.c, ctx)) ? fxEval(node.a, ctx) : fxEval(node.b, ctx);
    case 'bin': {
      const op = node.op;
      if (op === '&&') return fxTruthy(fxEval(node.a, ctx)) ? fxEval(node.b, ctx) : false;
      if (op === '||') { const a = fxEval(node.a, ctx); return fxTruthy(a) ? a : fxEval(node.b, ctx); }
      const a = fxEval(node.a, ctx), b = fxEval(node.b, ctx);
      switch (op) {
        case '+': {
          const da = fxDate(a);
          if (typeof a === 'string' && !/^\s*-?[\d.]+\s*$/.test(a) && !da) return fxStr(a) + fxStr(b);
          if (typeof b === 'string' && !/^\s*-?[\d.]+\s*$/.test(b)) return fxStr(a) + fxStr(b);
          return fxNum(a) + fxNum(b);
        }
        case '-': {
          const da = fxDate(a), dbb = fxDate(b);
          if (da && dbb && typeof a !== 'number' && typeof b !== 'number') return Math.round((da - dbb) / FX_DAY);
          return fxNum(a) - fxNum(b);
        }
        case '*': return fxNum(a) * fxNum(b);
        case '/': return fxNum(b) === 0 ? 0 : fxNum(a) / fxNum(b);
        case '%': return fxNum(b) === 0 ? 0 : fxNum(a) % fxNum(b);
        case '==': return fxStr(a).toLowerCase() === fxStr(b).toLowerCase();
        case '!=': return fxStr(a).toLowerCase() !== fxStr(b).toLowerCase();
        default: {
          const da = fxDate(a), dbb = fxDate(b);
          const na = da && dbb ? da.getTime() : fxNum(a);
          const nb = da && dbb ? dbb.getTime() : fxNum(b);
          return op === '<' ? na < nb : op === '>' ? na > nb : op === '<=' ? na <= nb : na >= nb;
        }
      }
    }
    case 'call': {
      const name = String(node.name).toLowerCase();
      if (name === 'prop') {
        const key = fxEval(node.args[0], ctx);
        return ctx.get(fxStr(key));
      }
      const fn = FX_FUNCS[name];
      if (!fn) throw new Error('Unknown function “' + node.name + '”');
      return fn(...node.args.map(a => fxEval(a, ctx)));
    }
    default: throw new Error('Bad expression');
  }
}

const fxCache = new Map();
function fxCompile(expr) {
  if (fxCache.has(expr)) return fxCache.get(expr);
  let compiled;
  try { compiled = { ast: fxParse(expr) }; }
  catch (err) { compiled = { error: err.message }; }
  fxCache.set(expr, compiled);
  return compiled;
}

/* ---------- computed properties: formulas + rollups ----------------------- */

// Related databases are loaded once per database open and cached here so
// rollups can be computed synchronously while rendering.
async function dbLoadRelations(loaded) {
  loaded.rel = loaded.rel || {};
  const props = loaded.schema.properties || {};
  const wanted = new Set();
  Object.keys(props).forEach(k => {
    const p = props[k];
    if (p && (p.type === 'relation') && p.to) wanted.add(String(p.to));
  });
  for (const name of wanted) {
    if (loaded.rel[name]) continue;
    const root = folder && folder.root;
    const path = /^[/~]|^[A-Za-z]:/.test(name) ? name
      : (root ? root.replace(/[/\\]+$/, '') + '/' + name : dbJoin(loaded.folder.replace(/\/[^/\\]+$/, ''), name));
    try { loaded.rel[name] = await dbLoad(path); } catch (_) { loaded.rel[name] = null; }
  }
  return loaded;
}

const dbWikiNames = (v) => (Array.isArray(v) ? v : [v])
  .map(x => String(x == null ? '' : x).trim())
  .flatMap(s => (s.match(/\[\[([^\]]+)\]\]/g) || (s ? [s] : [])))
  .map(s => s.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim())
  .filter(Boolean);

// rows in the related database that this row points at
function dbRelatedRows(row, relKey) {
  const p = dbProp(relKey);
  const target = p.to && db.rel ? db.rel[String(p.to)] : null;
  if (!target) return [];
  const names = dbWikiNames(row.props[relKey]);
  const lower = names.map(n => n.toLowerCase().replace(/\.md$/i, ''));
  return target.rows.filter(r => lower.includes(r.title.toLowerCase()));
}

function dbRollup(row, key) {
  const p = dbProp(key);
  const rows = dbRelatedRows(row, p.relation);
  const vals = rows.map(r => {
    const v = r.props[p.target];
    return Array.isArray(v) ? v.join(', ') : v;
  }).filter(v => v != null && v !== '');
  const fn = String(p.fn || p.calculate || 'show').toLowerCase();
  switch (fn) {
    case 'count': return rows.length;
    case 'count_values': case 'countvalues': return vals.length;
    case 'sum': return vals.reduce((s, v) => s + fxNum(v), 0);
    case 'avg': case 'average': return vals.length ? Math.round((vals.reduce((s, v) => s + fxNum(v), 0) / vals.length) * 100) / 100 : 0;
    case 'min': return vals.length ? vals.map(fxNum).reduce((a, b) => Math.min(a, b)) : '';
    case 'max': return vals.length ? vals.map(fxNum).reduce((a, b) => Math.max(a, b)) : '';
    case 'earliest': return vals.slice().sort()[0] || '';
    case 'latest': return vals.slice().sort().pop() || '';
    case 'unique': return [...new Set(vals.map(String))].join(', ');
    case 'checked': return vals.filter(v => fxTruthy(v)).length;
    case 'percent_checked': return vals.length ? Math.round(vals.filter(v => fxTruthy(v)).length / vals.length * 100) + '%' : '';
    default: return vals.join(', ');
  }
}

// Value of any property, computing formulas/rollups on demand. `seen` breaks
// formula cycles (a formula that references itself, directly or indirectly).
function dbValue(row, key, seen) {
  const p = dbProp(key);
  if (p.type === 'rollup') return dbRollup(row, key);
  if (p.type === 'formula') {
    const guard = seen || new Set();
    if (guard.has(key)) return '⟲';                     // cycle
    guard.add(key);
    const compiled = fxCompile(String(p.expr || p.formula || ''));
    if (compiled.error) return '⚠ ' + compiled.error;
    try {
      const ctx = {
        get: (name) => {
          if (name === 'Name' || name === 'title') return row.title;
          const prop = dbProp(name);
          if (prop.type === 'formula' || prop.type === 'rollup') return dbValue(row, name, guard);
          const v = Object.prototype.hasOwnProperty.call(row.props, name) ? row.props[name] : '';
          return Array.isArray(v) ? v.join(', ') : (v == null ? '' : v);
        },
      };
      const out = fxEval(compiled.ast, ctx);
      if (out instanceof Date) return out.toISOString().slice(0, 10);
      if (typeof out === 'boolean') return out ? 'Yes' : 'No';
      if (typeof out === 'number') return Number.isInteger(out) ? String(out) : String(Math.round(out * 1000) / 1000);
      return out;
    } catch (err) { return '⚠ ' + err.message; }
  }
  const v = row.props[key];
  return Array.isArray(v) ? v.join(', ') : (v == null ? '' : v);
}

// schema.properties comes from a parsed file, so look keys up safely: an
// inherited Object.prototype member must never masquerade as a property
function dbProp(key) {
  const props = (db && db.schema && db.schema.properties) || {};
  return Object.prototype.hasOwnProperty.call(props, key) ? (props[key] || {}) : {};
}

const dbIsComputed = (key) => {
  const t = dbProp(key).type;
  return t === 'formula' || t === 'rollup';
};

/* ---------- relation cell picker ------------------------------------------ */

function dbEditRelation(td, row, key) {
  const p = dbProp(key);
  const target = p.to && db.rel ? db.rel[String(p.to)] : null;
  if (!target) { toast('Set “to:” on this relation to a database folder'); return; }
  const current = new Set(dbWikiNames(row.props[key]).map(s => s.toLowerCase()));
  const pop = document.createElement('div');
  pop.className = 'db-relpop';
  const search = document.createElement('input');
  search.className = 'db-input';
  search.placeholder = 'Link a page…';
  pop.appendChild(search);
  const list = document.createElement('div');
  list.className = 'db-rellist';
  pop.appendChild(list);
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    target.rows.filter(r => !q || r.title.toLowerCase().includes(q)).slice(0, 40).forEach(r => {
      const b = document.createElement('button');
      b.className = 'db-relitem' + (current.has(r.title.toLowerCase()) ? ' on' : '');
      b.textContent = r.title;
      b.addEventListener('mousedown', async (e) => {
        e.preventDefault();
        const k = r.title.toLowerCase();
        if (current.has(k)) current.delete(k); else current.add(k);
        const names = target.rows.filter(x => current.has(x.title.toLowerCase())).map(x => '[[' + x.title + ']]');
        await dbSetRowProp(row, key, names.length ? (names.length === 1 ? names[0] : names) : null);
        renderDbBody();
      });
      list.appendChild(b);
    });
    if (!list.children.length) list.innerHTML = '<div class="db-relempty">No pages in ' + escHtml(String(p.to)) + '</div>';
  };
  search.addEventListener('input', draw);
  draw();
  td.innerHTML = '';
  td.appendChild(pop);
  search.focus();
  const close = (e) => { if (!pop.contains(e.target)) { document.removeEventListener('mousedown', close); renderDbBody(); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

/* ---------- calendar view -------------------------------------------------- */

function renderDbCalendar(host, rows, view) {
  const key = view.date || dbPropNames().find(p => (db.schema.properties[p] || {}).type === 'date');
  if (!key) { host.innerHTML = '<div class="db-empty"><b>No date property</b><span>Add one to use the calendar.</span></div>'; return; }
  const cursor = view._month ? new Date(view._month) : (() => { const d = new Date(); d.setDate(1); return d; })();
  cursor.setDate(1);
  const wrap = document.createElement('div');
  wrap.className = 'db-cal';

  const head = document.createElement('div');
  head.className = 'db-cal-head';
  const prev = document.createElement('button'); prev.textContent = '‹'; prev.title = 'Previous month';
  const next = document.createElement('button'); next.textContent = '›'; next.title = 'Next month';
  const label = document.createElement('b');
  label.textContent = cursor.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const today = document.createElement('button'); today.textContent = 'Today'; today.className = 'db-cal-today';
  prev.addEventListener('click', () => { const d = new Date(cursor); d.setMonth(d.getMonth() - 1); view._month = d.toISOString(); renderDbBody(); });
  next.addEventListener('click', () => { const d = new Date(cursor); d.setMonth(d.getMonth() + 1); view._month = d.toISOString(); renderDbBody(); });
  today.addEventListener('click', () => { view._month = null; renderDbBody(); });
  head.append(prev, label, next, today);
  wrap.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'db-cal-grid';
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(d => {
    grid.appendChild(Object.assign(document.createElement('div'), { className: 'db-cal-dow', textContent: d }));
  });
  const first = new Date(cursor);
  const offset = (first.getDay() + 6) % 7;                     // Monday-first
  const start = new Date(first); start.setDate(1 - offset);
  const byDay = new Map();
  rows.forEach(r => {
    const d = fxDate(dbValue(r, key));
    if (!d) return;
    const k = d.toISOString().slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  });
  const todayKey = new Date(new Date().toDateString()).toISOString().slice(0, 10);
  for (let i = 0; i < 42; i++) {
    const day = new Date(start); day.setDate(start.getDate() + i);
    const iso = day.toISOString().slice(0, 10);
    const cell = document.createElement('div');
    cell.className = 'db-cal-cell' + (day.getMonth() === cursor.getMonth() ? '' : ' out') + (iso === todayKey ? ' today' : '');
    cell.appendChild(Object.assign(document.createElement('span'), { className: 'db-cal-num', textContent: String(day.getDate()) }));
    (byDay.get(iso) || []).forEach(r => {
      const chip = document.createElement('button');
      chip.className = 'db-cal-chip';
      chip.textContent = r.title;
      chip.title = r.title;
      chip.addEventListener('click', () => dbOpenRow(r));
      cell.appendChild(chip);
    });
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  host.appendChild(wrap);
}

/* ---------- gallery view --------------------------------------------------- */

function renderDbGallery(host, rows) {
  const grid = document.createElement('div');
  grid.className = 'db-gallery';
  const props = dbPropNames().slice(0, 3);
  rows.forEach(r => {
    const card = document.createElement('button');
    card.className = 'db-gcard';
    card.addEventListener('click', () => dbOpenRow(r));
    const cover = r.props.cover || r.props.Cover || '';
    const top = document.createElement('div');
    top.className = 'db-gcover';
    if (cover && TAURI) {
      const img = document.createElement('img');
      const dir = r.path.slice(0, r.path.lastIndexOf('/'));
      const src = String(cover);
      img.src = /^(https?:|data:)/i.test(src) ? src : TAURI.core.convertFileSrc(src.startsWith('/') ? src : dir + '/' + src);
      img.alt = '';
      top.appendChild(img);
    } else {
      top.classList.add('db-gcover-blank');
      top.textContent = (r.title[0] || '?').toUpperCase();
    }
    card.appendChild(top);
    const body = document.createElement('div');
    body.className = 'db-gbody';
    body.appendChild(Object.assign(document.createElement('div'), { className: 'db-gtitle', textContent: r.title }));
    props.forEach(p => {
      const v = dbValue(r, p);
      if (!v) return;
      const type = (db.schema.properties[p] || {}).type;
      const el = document.createElement('span');
      el.className = type === 'select' ? 'db-pill' : 'db-card-prop';
      if (type === 'select') el.style.setProperty('--pill', dbOptColor(p, String(v)));
      el.textContent = String(v);
      body.appendChild(el);
    });
    card.appendChild(body);
    grid.appendChild(card);
  });
  host.appendChild(grid);
}

/* ==========================================================================
   N7 — Publish

   Turn a folder into a shareable site: ONE self-contained .html file.

   Pages are rendered here, with the app's own markdown pipeline, so callouts,
   columns, toggles, math and diagrams come out exactly as they look in Vedrix
   — and the published file needs no markdown library, no server and no network.
   It opens from a file:// URL, an S3 bucket or GitHub Pages identically.

   [[wikilinks]] become internal anchors, ![[embeds]] are inlined at build
   time, andeach database folder is rendered as a table.
   ========================================================================== */

const PUB_SKIP_DIRS = /(^|[/\\])(_templates|\.obsidian|\.git|node_modules)([/\\]|$)/i;

function pubSlug(rel) {
  return String(rel).replace(/\.(md|markdown)$/i, '')
    .toLowerCase().replace(/[^\w\s/-]/g, '').trim()
    .replace(/[\s/]+/g, '-').replace(/-+/g, '-') || 'page';
}

// flatten the native dir tree into the .md files we publish
function pubCollect(tree, out, prefix) {
  (tree || []).forEach(node => {
    const rel = prefix ? prefix + '/' + node.name : node.name;
    if (node.dir) { if (!PUB_SKIP_DIRS.test(rel)) pubCollect(node.children, out, rel); return; }
    if (!/\.(md|markdown)$/i.test(node.name)) return;
    if (node.name.startsWith('_') || node.name.startsWith('.')) return;
    if (PUB_SKIP_DIRS.test(rel)) return;
    out.push({ path: node.path, rel, name: node.name, title: node.name.replace(/\.(md|markdown)$/i, ''), group: prefix || '' });
  });
  return out;
}

async function pubReadFile(path) {
  if (TAURI) { try { return (await TAURI.core.invoke('read_md_file', { path })).text; } catch (_) { return ''; } }
  return (window.__dbMock && window.__dbMock.files[path]) || '';
}

// Render one page to final HTML: markdown → DOM → rewrite links, inline
// embeds, expand database blocks → serialize.
async function pubRenderPage(page, index, opts) {
  const raw = await pubReadFile(page.path);
  const { body } = splitFm(raw);
  const host = document.createElement('div');
  host.innerHTML = DOMPurify.sanitize(md.render(body), {
    ADD_ATTR: ['data-wiki', 'data-bid', 'data-embed', 'data-cols', 'open'],
  });

  // [[wikilinks]] → internal anchors (or plain text when the page isn't published)
  host.querySelectorAll('a.wikilink[data-wiki]').forEach(a => {
    const target = (a.getAttribute('data-wiki') || '').split('#')[0].trim().toLowerCase();
    const hit = index.byTitle.get(target) || index.byRel.get(target);
    if (hit) { a.setAttribute('href', '#' + hit.slug); a.removeAttribute('data-wiki'); }
    else { const s = document.createElement('span'); s.className = 'pub-deadlink'; s.textContent = a.textContent; a.replaceWith(s); }
  });

  // ![[embeds]] resolved at build time — the published file fetches nothing
  for (const el of [...host.querySelectorAll('.vx-embed[data-embed]')]) {
    const rawT = el.getAttribute('data-embed') || '';
    const hash = rawT.indexOf('#');
    const target = (hash > -1 ? rawT.slice(0, hash) : rawT).trim().toLowerCase();
    const frag = hash > -1 ? rawT.slice(hash + 1).trim() : '';
    const hit = index.byTitle.get(target) || index.byRel.get(target);
    const bodyEl = el.querySelector('.vx-embed-body');
    if (!hit || !bodyEl) { el.remove(); continue; }
    const text = await pubReadFile(hit.path);
    const slice = extractFragment(text, frag);
    bodyEl.className = 'vx-embed-body';
    bodyEl.innerHTML = slice ? DOMPurify.sanitize(md.render(slice), { ADD_ATTR: ['data-wiki', 'data-bid'] }) : '';
    bodyEl.querySelectorAll('a.wikilink[data-wiki]').forEach(a => {
      const t2 = (a.getAttribute('data-wiki') || '').split('#')[0].trim().toLowerCase();
      const h2 = index.byTitle.get(t2) || index.byRel.get(t2);
      if (h2) { a.setAttribute('href', '#' + h2.slug); a.removeAttribute('data-wiki'); }
    });
    const head = el.querySelector('.vx-embed-head');
    if (head) {
      head.innerHTML = '<span class="vx-embed-src">' + escHtml(hit.title) + (frag ? ' › ' + escHtml(frag) : '') + '</span>';
      const link = document.createElement('a');
      link.className = 'vx-embed-open';
      link.href = '#' + hit.slug;
      link.textContent = 'Open';
      head.appendChild(link);
    }
    el.removeAttribute('contenteditable');
  }

  // ```vedrix-view fences → a rendered table of that database
  for (const pre of [...host.querySelectorAll('pre > code.language-vedrix-view')].map(c => c.parentElement)) {
    const spec = parseYamlLite(pre.textContent || '') || {};
    const dbEntry = index.dbs.find(d => d.name.toLowerCase() === String(spec.folder || '').toLowerCase()
                                     || d.rel.toLowerCase() === String(spec.folder || '').toLowerCase());
    if (!dbEntry) { pre.replaceWith(pubNote('Database “' + escHtml(String(spec.folder || '')) + '” was not published.')); continue; }
    pre.replaceWith(pubDbTable(dbEntry, index, Number(spec.limit) || 0));
  }

  // strip editor-only affordances
  host.querySelectorAll('.vx-bid').forEach(n => n.remove());
  host.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
  return host.innerHTML;
}

function pubNote(html) {
  const d = document.createElement('div');
  d.className = 'pub-note';
  d.innerHTML = html;
  return d;
}

// A database folder rendered as a static table (computed columns included).
function pubDbTable(dbEntry, index, limit) {
  const loaded = dbEntry.loaded;
  const wrap = document.createElement('div');
  wrap.className = 'pub-db';
  const head = document.createElement('div');
  head.className = 'pub-db-head';
  head.innerHTML = '<b>' + escHtml(loaded.schema.name || dbEntry.name) + '</b>';
  wrap.appendChild(head);
  const props = Object.keys(loaded.schema.properties || {});
  const prev = db;
  db = loaded;
  let rows;
  try { loaded.viewIdx = 0; rows = dbVisibleRows(); } finally { db = prev; }
  if (limit > 0) rows = rows.slice(0, limit);
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(Object.assign(document.createElement('th'), { textContent: 'Name' }));
  props.forEach(p => hr.appendChild(Object.assign(document.createElement('th'), { textContent: p })));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tb = document.createElement('tbody');
  const prev2 = db;
  db = loaded;
  try {
    rows.forEach(r => {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      const hit = index.byPath.get(r.path);
      if (hit) { const a = document.createElement('a'); a.href = '#' + hit.slug; a.textContent = r.title; td.appendChild(a); }
      else td.textContent = r.title;
      tr.appendChild(td);
      props.forEach(p => {
        const cell = document.createElement('td');
        const v = String(dbValue(r, p) ?? '');
        if (v && (loaded.schema.properties[p] || {}).type === 'select') {
          const pill = document.createElement('span');
          pill.className = 'pub-pill';
          pill.textContent = v;
          pill.style.setProperty('--pill', dbOptColor(p, v));
          cell.appendChild(pill);
        } else cell.textContent = v || '—';
        tr.appendChild(cell);
      });
      tb.appendChild(tr);
    });
  } finally { db = prev2; }
  table.appendChild(tb);
  wrap.appendChild(table);
  return wrap;
}

/* ---------- the generated site -------------------------------------------- */

function pubSiteHtml(site) {
  const json = JSON.stringify(site).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(site.title)}</title>
<style>
:root{--bg:#fbfbfd;--panel:#fff;--fg:#16202e;--muted:#5d6879;--faint:#8d96a5;--border:#e5e9f0;--accent:#2f6bff;--code:#f1f4fa;--shadow:0 1px 2px rgba(20,30,60,.05),0 10px 30px -18px rgba(20,30,60,.25)}
@media (prefers-color-scheme:dark){html[data-theme="auto"]{--bg:#0d1220;--panel:#131a2a;--fg:#e3e9f7;--muted:#9aa6bf;--faint:#6c778f;--border:#222b3e;--accent:#6d97ff;--code:#182136;--shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px -18px rgba(0,0,0,.7)}}
html[data-theme="dark"]{--bg:#0d1220;--panel:#131a2a;--fg:#e3e9f7;--muted:#9aa6bf;--faint:#6c778f;--border:#222b3e;--accent:#6d97ff;--code:#182136}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:16px/1.65 'Hanken Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{display:grid;grid-template-columns:274px minmax(0,1fr);min-height:100vh}
.side{background:var(--panel);border-right:1px solid var(--border);position:sticky;top:0;height:100vh;overflow-y:auto;padding:22px 16px 30px}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:16px;padding:0 6px}
.mark{width:34px;height:34px;border-radius:10px;background:var(--accent);display:grid;place-items:center;flex:0 0 auto}
.mark svg{width:20px;height:20px}
.brand b{font-size:15px;font-weight:650;letter-spacing:-.01em;display:block;line-height:1.15}
.brand span{font-size:11.5px;color:var(--muted)}
.q{width:100%;height:32px;padding:0 11px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font:inherit;font-size:13px;margin-bottom:12px}
.q:focus{outline:none;border-color:var(--accent)}
.grp{font-size:10.5px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);padding:12px 8px 5px}
.nav a{display:block;padding:6px 9px;border-radius:8px;font-size:13.5px;color:var(--muted);line-height:1.35}
.nav a:hover{background:color-mix(in srgb,var(--accent) 8%,transparent);color:var(--fg);text-decoration:none}
.nav a.on{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);font-weight:600}
.main{min-width:0}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:12px;padding:12px 30px;background:color-mix(in srgb,var(--bg) 85%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.crumb{font-size:13px;color:var(--muted)}.crumb b{color:var(--fg)}
.sp{flex:1}
.tbtn{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:var(--muted);font:inherit;font-size:12.5px;cursor:pointer}
.tbtn:hover{color:var(--fg);border-color:var(--accent)}
.doc{max-width:790px;margin:0 auto;padding:34px 30px 90px}
.doc h1{font-family:'Newsreader',Georgia,serif;font-weight:600;font-size:34px;line-height:1.15;margin:0 0 20px;letter-spacing:-.01em}
.doc h2{font-size:22px;font-weight:680;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.doc h3{font-size:17px;font-weight:680;margin:24px 0 8px}
.doc p{margin:0 0 14px}.doc ul,.doc ol{margin:0 0 14px;padding-left:24px}.doc li{margin:4px 0}
.doc code{background:var(--code);padding:.13em .4em;border-radius:5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.87em}
.doc pre{background:var(--code);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;margin:0 0 16px}
.doc pre code{background:none;padding:0;font-size:13px}
.doc blockquote{margin:0 0 16px;padding:2px 0 2px 16px;border-left:3px solid var(--accent);color:var(--muted)}
.doc table{border-collapse:collapse;width:100%;font-size:14px;margin:0 0 16px}
.doc th,.doc td{border-bottom:1px solid var(--border);padding:8px 12px;text-align:left}
.doc img{max-width:100%;border-radius:8px}
.doc hr{border:none;border-top:1px solid var(--border);margin:26px 0}
.doc details{border:1px solid var(--border);border-radius:10px;padding:8px 14px;margin:0 0 14px}
.doc summary{cursor:pointer;font-weight:600;list-style:none}
.doc summary::-webkit-details-marker{display:none}
.doc summary::before{content:'▸ ';color:var(--muted)}
.doc details[open] summary::before{content:'▾ '}
.vx-columns{display:grid;gap:20px;grid-template-columns:repeat(2,minmax(0,1fr));margin:0 0 16px}
.vx-columns[data-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
@media(max-width:760px){.vx-columns,.vx-columns[data-cols="3"]{grid-template-columns:1fr}}
.vx-embed{border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;margin:0 0 16px;overflow:hidden;background:var(--panel)}
.vx-embed-head{display:flex;gap:8px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--border);font-size:11.5px;color:var(--muted)}
.vx-embed-open{margin-left:auto;font-size:11.5px}
.vx-embed-body{padding:10px 14px;font-size:.95em}
.vx-embed-body>*:first-child{margin-top:0}.vx-embed-body>*:last-child{margin-bottom:0}
.pub-deadlink{color:var(--faint);border-bottom:1px dashed var(--border)}
.pub-note{color:var(--muted);font-size:13px;font-style:italic;margin:0 0 14px}
.pub-db{border:1px solid var(--border);border-radius:11px;overflow:hidden;margin:0 0 18px;background:var(--panel)}
.pub-db-head{padding:9px 13px;border-bottom:1px solid var(--border);font-size:13.5px}
.pub-db table{margin:0;font-size:13px}
.pub-db th{font-size:11.5px;color:var(--muted);font-weight:600}
.pub-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:550;color:var(--pill,var(--accent));background:color-mix(in srgb,var(--pill,var(--accent)) 15%,transparent)}
.foot{margin-top:40px;padding-top:18px;border-top:1px solid var(--border);font-size:12px;color:var(--faint)}
.menu{display:none}
@media(max-width:880px){.wrap{grid-template-columns:1fr}.side{position:fixed;z-index:20;width:270px;transform:translateX(-102%);transition:transform .2s;box-shadow:var(--shadow)}
.wrap.open .side{transform:none}.menu{display:inline-flex}.doc{padding:24px 20px 70px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap" id="wrap">
  <aside class="side" id="side">
    <div class="brand">
      <span class="mark"><svg viewBox="150 455 930 660"><g fill="#fff" stroke="#fff" stroke-width="24" stroke-linejoin="round" stroke-linecap="round"><path d="M175 482 L388 482 L540 792 L675 843 L675 858 L598 858 L585 1082 L470 1082 Z"/><path d="M802 604 L1042 604 L936 850 L726 850 Z"/></g></svg></span>
      <span><b>${escHtml(site.title)}</b><span>${site.pages.length} page${site.pages.length === 1 ? '' : 's'}</span></span>
    </div>
    <input class="q" id="q" placeholder="Filter pages…">
    <div class="nav" id="nav"></div>
  </aside>
  <div class="main">
    <div class="top">
      <button class="tbtn menu" id="menu">☰</button>
      <span class="crumb"><b id="crumb"></b></span><span class="sp"></span>
      <button class="tbtn" id="theme">Theme</button>
    </div>
    <div class="doc" id="doc"></div>
  </div>
</div>
<script id="site" type="application/json">${json}</script>
<script>
(function(){
  var SITE=JSON.parse(document.getElementById('site').textContent);
  var nav=document.getElementById('nav'),doc=document.getElementById('doc'),crumb=document.getElementById('crumb');
  var groups={},order=[];
  SITE.pages.forEach(function(p){ if(!groups[p.group]){groups[p.group]=[];order.push(p.group);} groups[p.group].push(p); });
  function drawNav(filter){
    nav.innerHTML='';
    order.forEach(function(g){
      var items=groups[g].filter(function(p){return !filter||p.title.toLowerCase().indexOf(filter)>-1;});
      if(!items.length)return;
      if(g){var h=document.createElement('div');h.className='grp';h.textContent=g;nav.appendChild(h);}
      items.forEach(function(p){
        var a=document.createElement('a');a.href='#'+p.slug;a.textContent=p.title;a.dataset.slug=p.slug;nav.appendChild(a);
      });
    });
    mark();
  }
  function mark(){
    var cur=(location.hash||'').replace('#','')||SITE.pages[0].slug;
    [].forEach.call(nav.querySelectorAll('a'),function(a){a.classList.toggle('on',a.dataset.slug===cur);});
  }
  function show(){
    var slug=(location.hash||'').replace('#','')||SITE.pages[0].slug;
    var p=SITE.pages.filter(function(x){return x.slug===slug;})[0]||SITE.pages[0];
    // only add a title when the page doesn't already open with its own H1,
    // otherwise every page renders its name twice
    var hasH1=/^\s*<h1[\s>]/i.test(p.html);
    doc.innerHTML=(hasH1?'':'<h1>'+p.title.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</h1>')+p.html+
      '<div class="foot">Published from '+SITE.title.replace(/&/g,'&amp;').replace(/</g,'&lt;')+' with Vedrix'+(SITE.date?' · '+SITE.date:'')+'</div>';
    crumb.textContent=p.title;document.title=p.title+' — '+SITE.title;
    mark();window.scrollTo(0,0);
    document.getElementById('wrap').classList.remove('open');
  }
  document.getElementById('q').addEventListener('input',function(){drawNav(this.value.trim().toLowerCase());});
  document.getElementById('menu').addEventListener('click',function(){document.getElementById('wrap').classList.toggle('open');});
  document.getElementById('theme').addEventListener('click',function(){
    var el=document.documentElement,cur=el.getAttribute('data-theme');
    var dark=cur==='dark'||(cur==='auto'&&matchMedia('(prefers-color-scheme:dark)').matches);
    el.setAttribute('data-theme',dark?'light':'dark');
  });
  window.addEventListener('hashchange',show);
  drawNav('');show();
})();
</script>
</body>
</html>`;
}

/* ---------- the command ---------------------------------------------------- */

async function publishSite(rootPath) {
  const root = rootPath || (folder && folder.root);
  if (!root) { toast('Open a folder first (⌘⇧O)'); return; }
  toast('Building site…');
  try {
    const tree = TAURI ? await TAURI.core.invoke('list_dir_tree', { path: root })
                       : (window.__dbMock && window.__dbMock.tree) || [];
    const pages = pubCollect(tree, [], '');
    if (!pages.length) { toast('No markdown pages found in this folder'); return; }

    // unique slugs
    const used = new Set();
    pages.forEach(p => {
      let s = pubSlug(p.rel), n = 2;
      while (used.has(s)) s = pubSlug(p.rel) + '-' + (n++);
      used.add(s);
      p.slug = s;
    });

    // databases that live inside this folder, loaded once
    const dbs = [];
    const seen = new Set();
    for (const p of pages) {
      const dir = p.path.slice(0, p.path.lastIndexOf('/'));
      if (seen.has(dir)) continue;
      seen.add(dir);
      const schema = await pubReadFile(dbJoin(dir, DB_SCHEMA_FILE));
      if (!schema) continue;
      try {
        const loaded = await dbLoad(dir);
        await dbLoadRelations(loaded);
        dbs.push({ folder: dir, name: dir.split(/[/\\]/).pop(), rel: p.group || '', loaded });
      } catch (_) {}
    }

    const index = {
      byTitle: new Map(pages.map(p => [p.title.toLowerCase(), p])),
      byRel: new Map(pages.map(p => [p.rel.replace(/\.(md|markdown)$/i, '').toLowerCase(), p])),
      byPath: new Map(pages.map(p => [p.path, p])),
      dbs,
    };

    const out = [];
    for (const p of pages) {
      out.push({ slug: p.slug, title: p.title, group: p.group, html: await pubRenderPage(p, index, {}) });
    }
    const site = {
      title: root.split(/[/\\]/).filter(Boolean).pop() || 'Vault',
      date: new Date().toISOString().slice(0, 10),
      pages: out,
    };
    const html = pubSiteHtml(site);
    const filename = pubSlug(site.title) + '-site.html';

    if (TAURI) {
      try {
        const dest = await TAURI.core.invoke('plugin:dialog|save', { options: { defaultPath: filename } });
        if (!dest) { toast('Publish cancelled'); return; }
        await TAURI.core.invoke('write_file', { path: dest, contents: html });
        toast('Published ' + out.length + ' pages → ' + dest.split(/[/\\]/).pop());
        return dest;
      } catch (err) {
        const dest = await TAURI.core.invoke('save_export', { filename, contents: html });
        toast('Published to ' + dest);
        return dest;
      }
    }
    window.__lastSite = html;      // browser/test path
    toast('Built ' + out.length + ' pages');
    return html;
  } catch (err) {
    console.error('publish failed', err);
    toast('Could not build the site');
  }
}
