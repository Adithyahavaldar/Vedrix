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
}).use(window.markdownitTaskLists);

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
  profileName: '',
  restoreSession: true,
};

let settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('mv_settings') || '{}')); } catch (_) {}

function saveSettings() { localStorage.setItem('mv_settings', JSON.stringify(settings)); }

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
  renderSettingsUI();
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
  localStorage.setItem('mv_recents', JSON.stringify(recents));
  renderRecents();
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
      localStorage.setItem('mv_recents', JSON.stringify(recents));
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
    list.innerHTML = '<div class="none">No files opened yet</div>';
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
  if (['txt', 'log', 'json', 'js', 'ts', 'py', 'sh', 'yaml', 'yml', 'toml', 'xml', 'rs', 'css'].includes(ext)) return 'text';
  return 'unsupported';
}

const TEXT_KINDS = ['md', 'text'];
const BYTE_KINDS = ['pdf', 'docx', 'pptx', 'sheet'];
const PAGED_KINDS = ['pdf', 'pptx'];

function activeTab() { return tabs.find(t => t.id === activeId) || null; }

function renderTabStrip() {
  const strip = $('tabs');
  strip.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.live && t.id === activeId ? ' live' : '');
    el.title = t.path || t.name;
    el.dataset.id = t.id;
    el.innerHTML = `<span class="tab-dot"></span><span class="tab-name"></span><span class="tab-dirty" title="Unsaved changes"></span><button class="tab-close" title="Close (⌘W)">×</button>`;
    if (t.dirty) el.classList.add('dirty');
    el.querySelector('.tab-name').textContent = t.name;
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('.tab-close')) return;
      switchTab(t.id);
      startTabDrag(e, t.id);
    });
    el.querySelector('.tab-close').addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
    strip.appendChild(el);
  }
  document.title = activeTab() ? activeTab().name + ' — Sutra' : 'Sutra';
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
  localStorage.setItem('mv_session', JSON.stringify({ paths, activePath: active && active.path }));
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

function updateSidebar() {
  const hasToc = !tocEl.classList.contains('hidden');
  const hasFiles = !!folder;
  $('side-tabs').hidden = !hasFiles;
  const mode = (sideMode === 'files' && hasFiles) ? 'files' : 'toc';
  tocEl.hidden = mode !== 'toc';
  $('filetree').hidden = mode !== 'files';
  document.querySelectorAll('#side-tabs button').forEach(b => b.classList.toggle('sel', b.dataset.m === mode));
  $('sidebar').classList.toggle('hidden', sidebarCollapsed || (!hasToc && !hasFiles));
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
  const title = document.createElement('div');
  title.className = 'toc-title';
  title.textContent = 'Contents';
  tocEl.appendChild(title);
  tocEl.classList.remove('hidden');
  updateSidebar();
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
    tocEl.appendChild(a);
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
    tocEl.appendChild(a);
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

/* ---------- Rendering ---------- */

function renderActive() {
  const t = activeTab();
  // clear the interactive-HTML pane flags unless we're about to render live
  // HTML — otherwise a stuck .html-live disables #scroller overflow (no scroll)
  if (!(t && t.kind === 'html')) contentEl.classList.remove('html-host', 'html-live');
  $('live-badge').classList.toggle('on', !!(t && t.live && !t.editing));
  const rb = $('reader-btn');
  rb.hidden = !(t && (t.kind === 'pdf' || t.kind === 'html'));
  if (t && t.kind === 'html') {
    const live = effectiveHtmlMode(t) === 'live';
    rb.textContent = live ? 'Aa' : '⚡';
    rb.title = live ? 'Reader mode — read, search, and export this page'
                    : 'Interactive mode — run the page with scripts';
  } else if (t && t.kind === 'pdf') {
    rb.textContent = 'Aa';
    rb.title = 'Reading mode — convert this PDF to Markdown';
  }
  $('edit-btn').hidden = !isEditable(t);
  $('map-btn').hidden = !(t && t.kind !== 'unsupported');
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
    tocEl.appendChild(a);
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
  if (kind === 'md') return DOMPurify.sanitize(md.render(text));
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
    } catch (_) { /* text layer is progressive enhancement */ }
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    console.error('pdf page', num, err);
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
  if (TEXT_KINDS.includes(kind) || kind === 'html') {
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
  } else if (kind === 'html') {
    tab.rawHtml = text;                       // rendered in a sandboxed frame
    tab.html = DOMPurify.sanitize(text);      // for TOC / mind map / export
  } else if (kind !== 'unsupported') {
    tab.html = await buildHtml(kind, { text, bytes });
    if (TEXT_KINDS.includes(kind)) tab.text = text;
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
    if (pos) { tab.scrollTop = pos; scrollerEl.scrollTop = pos; }
  } catch (err) {
    console.error('Failed to open', path, err);
    diag('openTauriPath error: ' + (err && err.message || err));
  } finally {
    _opening.delete(path);
  }
}

async function openBrowserFile(file, handle) {
  const kind = kindOf(file.name);
  const loaded = (TEXT_KINDS.includes(kind) || kind === 'html')
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
          { name: 'All supported', extensions: ['md', 'markdown', 'mdown', 'pdf', 'docx', 'pptx', 'xlsx', 'xls', 'csv', 'txt', 'log', 'json', 'html', 'htm'] },
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
  return !!(t && TEXT_KINDS.includes(t.kind) && (t.path || (t.handle && t.handle.createWritable)));
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
  $('edit-toolbar').hidden = !rich;
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
  return htmlToMarkdown(clone.innerHTML);
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
  if ($('edit-toolbar').hidden) return;
  const el = selElement();
  const q = (cmd) => { try { return document.queryCommandState(cmd); } catch (_) { return false; } };
  const mark = (name, on) => {
    const b = document.querySelector(`#edit-toolbar [data-cmd="${name}"]`);
    if (b) b.classList.toggle('on', !!on);
  };
  mark('bold', q('bold'));
  mark('italic', q('italic'));
  mark('strike', q('strikeThrough'));
  mark('code', el && el.closest('code') && !el.closest('pre'));
  mark('link', el && el.closest('a'));
  const blk = currentBlock();
  const tag = blk ? blk.tagName.toLowerCase() : 'p';
  $('tb-block').value = ['h1', 'h2', 'h3', 'h4', 'blockquote', 'pre'].includes(tag) ? tag
    : (blk && blk.querySelector && (tag === 'ul' || tag === 'ol')) ? 'p' : 'p';
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
}

function onEditorChange() {
  if (cmSilent) return;
  const t = activeTab();
  if (!t || !t.editing) return;
  t.text = cm.getValue();
  setDirty(t, true);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    t.html = await buildHtml(t.kind, { text: t.text });
    if (activeId === t.id && t.editing) {
      contentEl.innerHTML = t.html;
      fixupContent(t);
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

/* ---------- Export / convert ---------- */

const stem = (name) => name.replace(/\.[^.]+$/, '');

function htmlToMarkdown(html) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  if (window.turndownPluginGfm) td.use(turndownPluginGfm.gfm);
  // keep <mark> highlights as inline HTML (valid markdown, renders in Sutra)
  td.keep(['mark']);
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

async function saveTextAs(text, suggested) {
  if (TAURI) {
    const path = await TAURI.core.invoke('plugin:dialog|save', { options: { defaultPath: suggested } });
    if (path) await TAURI.core.invoke('write_file', { path, contents: text });
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = suggested;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

async function buildStandaloneHtml(t) {
  const theme = THEMES.find(th => th.key === settings.theme) || THEMES[0];
  const dark = theme.base === 'dark' || (theme.base === 'system' && sysDark.matches);
  const cssMd = await (await fetch(dark ? 'vendor/github-markdown-dark.css' : 'vendor/github-markdown-light.css')).text();
  const cssHl = await (await fetch(dark ? 'vendor/hljs-github-dark.css' : 'vendor/hljs-github-light.css')).text();
  const body = t.html || contentEl.innerHTML;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.name}</title>
<style>${cssMd}
${cssHl}
body{margin:0;background:${dark ? '#0d1117' : '#ffffff'};}
.markdown-body{max-width:860px;margin:0 auto;padding:48px 32px;}</style>
</head><body><article class="markdown-body">${body}</article></body></html>`;
}

async function exportActive(fmt) {
  const t = activeTab();
  if (!t) return;
  if (fmt === 'md') {
    const text = TEXT_KINDS.includes(t.kind) ? (t.text || '')
      : t.mdText ? t.mdText
      : t.kind === 'pdf' ? await pdfToMarkdown(t)
      : htmlToMarkdown(t.html || contentEl.innerHTML);
    await saveTextAs(text, stem(t.name) + '.md');
  } else if (fmt === 'html') {
    if (PAGED_KINDS.includes(t.kind) && t.kind !== 'pdf') return;
    const source = t.kind === 'pdf'
      ? { ...t, html: DOMPurify.sanitize(md.render(await pdfToMarkdown(t))) }
      : t;
    await saveTextAs(await buildStandaloneHtml(source), stem(t.name) + '.html');
  } else if (fmt === 'csv') {
    if (t.kind !== 'sheet' || !t.bytes) return;
    const wb = XLSX.read(t.bytes, { type: 'array' });
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]);
    await saveTextAs(csv, stem(t.name) + '.csv');
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
  if (!folder) return;
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
  if (!cfg.model) throw new Error('No model set — choose a provider and model in Settings (⌘,)');
  if (!cfg.key && !cfg.local) throw new Error('No API key — add one in Settings (⌘,)');
  if (!cfg.base) throw new Error('No API base URL — set one in Settings (⌘,)');

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
    const inner = document.createElement('div');
    inner.className = 'markdown-body';
    inner.innerHTML = DOMPurify.sanitize(md.render(content));
    div.appendChild(inner);
  } else {
    div.textContent = content;
  }
  $('ai-messages').appendChild(div);
  $('ai-messages').scrollTop = $('ai-messages').scrollHeight;
  return div;
}

function renderAiChat() {
  const t = activeTab();
  $('ai-messages').innerHTML = '';
  for (const m of (t && t.aiChat) || []) aiMsgEl(m.role, m.content);
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
    aiMsgEl('info', '⚠ ' + err.message);
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
    aiMsgEl('info', '⚠ ' + err.message);
  } finally { aiBusy = false; }
}

async function aiTranslate() {
  const t = activeTab();
  if (!t || aiBusy) return;
  const lang = (window.prompt('Translate this document to which language?', settings.aiLastLang || 'English') || '').trim();
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
    aiMsgEl('info', '⚠ ' + err.message);
  } finally { aiBusy = false; }
}

function toggleAiPanel() {
  const panel = $('ai-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) { renderAiChat(); $('ai-input').focus(); }
}

function wireAi() {
  $('ai-btn').addEventListener('click', toggleAiPanel);
  $('ai-close').addEventListener('click', toggleAiPanel);
  $('ai-summarize').addEventListener('click', () =>
    aiAsk('Summarize this document: key points, structure, and anything actionable. Use short sections.'));
  $('ai-translate').addEventListener('click', aiTranslate);
  $('ai-conceptmap').addEventListener('click', aiConceptMap);
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
  if (!t || t.kind === 'unsupported') return;
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
  $('empty-title').textContent = settings.profileName ? `Welcome back, ${settings.profileName}` : 'Sutra';
}

function renderAiSettings() {
  const provider = settings.aiProvider || 'anthropic';
  const preset = AI_PRESETS[provider] || AI_PRESETS.anthropic;
  $('ai-preset').value = provider;
  $('ai-base').value = settings.aiBase || preset.base;
  $('ai-model').value = settings.aiModel || preset.model;
  $('ai-key').value = settings.aiKey || '';
  $('ai-key').placeholder = preset.keyHint;
  $('ai-note').textContent = 'Stored only on this Mac. ' + preset.note;
}

function wireSettings() {
  $('settings-btn').addEventListener('click', () => { $('settings-overlay').hidden = false; });
  $('settings-close').addEventListener('click', () => { $('settings-overlay').hidden = true; });
  $('settings-overlay').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) $('settings-overlay').hidden = true; });
  document.querySelectorAll('#seg-width button').forEach(b =>
    b.addEventListener('click', () => { settings.width = b.dataset.v; saveSettings(); applySettings(); }));
  document.querySelectorAll('#seg-font button').forEach(b =>
    b.addEventListener('click', () => { settings.font = b.dataset.v; saveSettings(); applySettings(); }));
  $('fs-minus').addEventListener('click', () => { settings.fontSize = Math.max(12, settings.fontSize - 1); saveSettings(); applySettings(); });
  $('fs-plus').addEventListener('click', () => { settings.fontSize = Math.min(24, settings.fontSize + 1); saveSettings(); applySettings(); });
  $('profile-name').addEventListener('change', (e) => { settings.profileName = e.target.value.trim(); saveSettings(); renderSettingsUI(); });
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
  $('ai-base').addEventListener('change', (e) => { settings.aiBase = e.target.value.trim(); saveSettings(); });
  $('ai-model').addEventListener('change', (e) => { settings.aiModel = e.target.value.trim(); saveSettings(); });
  $('ai-key').addEventListener('change', (e) => { settings.aiKey = e.target.value.trim(); saveSettings(); });
  $('restore-session').addEventListener('change', (e) => { settings.restoreSession = e.target.checked; saveSettings(); });
  $('clear-history').addEventListener('click', () => {
    recents = [];
    localStorage.removeItem('mv_recents');
    renderRecents();
  });
}

/* ---------- History panel ---------- */

function wireHistory() {
  $('history-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('history-panel').hidden = !$('history-panel').hidden;
  });
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
    if (t && t.kind === 'html') toggleHtmlMode(); else openReadingMode();
  },
  edit: toggleEdit,
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
  $('toc-toggle').addEventListener('click', toggleSidebar);
  $('edit-btn').addEventListener('click', toggleEdit);
  $('reader-btn').addEventListener('click', () => {
    const t = activeTab();
    if (t && t.kind === 'html') toggleHtmlMode(); else openReadingMode();
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
    else if (mod && e.key === 'p') { e.preventDefault(); window.print(); }
    else if (mod && e.key === 'b') {
      e.preventDefault();
      if (isRichEditing()) EDITOR_CMDS.bold(); else toggleSidebar();
    }
    else if (mod && e.key === 'i' && isRichEditing()) { e.preventDefault(); EDITOR_CMDS.italic(); }
    else if (mod && e.key === 'k' && isRichEditing()) { e.preventDefault(); openLinkPop(); }
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
  wireEditorToolbar();
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
        const t = activeTab();
        if (t && PAGED_KINDS.includes(t.kind)) { highlightPagedToc(t); renderVisiblePages(t); }
      }
    }, { passive: true });
  }

  // sidebar resize handle
  const handle = $('toc-resize');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const mainLeft = $('main').getBoundingClientRect().left;
    const move = (ev) => {
      const w = Math.min(460, Math.max(160, ev.clientX - mainLeft));
      $('sidebar').style.width = w + 'px';
      settings.tocWidth = w;
    };
    const up = () => {
      handle.classList.remove('dragging');
      saveSettings();
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  if (settings.tocWidth) $('sidebar').style.width = settings.tocWidth + 'px';

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
    else if (id === 'print' || id === 'print-doc') window.print();
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
  wireSettings();
  wireHistory();
  wireGlobal();
  wireMobile();
  wireTauri();
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
    // first-run shortcuts sheet is desktop-only (⌘ keys don't exist on touch)
    if (!localStorage.getItem('mv_seen')) {
      localStorage.setItem('mv_seen', '1');
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
