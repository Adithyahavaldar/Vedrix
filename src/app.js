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
try { recents = JSON.parse(localStorage.getItem('mv_recents') || '[]'); } catch (_) {}

function recordRecent(name, path) {
  if (!path) return; // browser-mode files can't be reopened later
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
  if (['txt', 'log', 'json', 'js', 'ts', 'py', 'sh', 'yaml', 'yml', 'toml', 'xml', 'rs', 'css', 'html'].includes(ext)) return 'text';
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
  $('live-badge').classList.toggle('on', !!(t && t.live && !t.editing));
  $('reader-btn').hidden = !(t && t.kind === 'pdf');
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
    $('unsupported-name').textContent = t.name;
    $('open-external').hidden = !(TAURI && t.path);
    showPane('unsupported');
    return;
  }

  if (PAGED_KINDS.includes(t.kind)) {
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
  contentEl.innerHTML = t.html || '';
  fixupContent(t);
  renderEnhancements(t).then(() => { if (activeId === t.id && ['md', 'docx', 'sheet'].includes(t.kind)) buildHeadingToc(); });
  if (['md', 'docx', 'sheet'].includes(t.kind)) buildHeadingToc(); else clearToc();
  applyZoom(t);
  showPane('content');
  syncEditorPane(t);
  scrollerEl.scrollTop = t.scrollTop || 0;
}

let mermaidSeq = 0;
async function renderEnhancements(t) {
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
  if (TEXT_KINDS.includes(kind)) {
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
  } else if (kind !== 'unsupported') {
    tab.html = await buildHtml(kind, { text, bytes });
    if (TEXT_KINDS.includes(kind)) tab.text = text;
  }
  return tab;
}

async function openTauriPath(path) {
  const existing = tabs.find(t => t.path === path);
  if (existing) { switchTab(existing.id); return; }
  const name = path.split('/').pop();
  const kind = kindOf(name);
  try {
    const loaded = kind === 'unsupported' ? { mtime: 0 } : await loadTauriContent(kind, path);
    const tab = await makeTab({ name, path, mtime: loaded.mtime }, kind, loaded);
    addTab(tab);
    const pos = savedPosition(path);
    if (pos) { tab.scrollTop = pos; scrollerEl.scrollTop = pos; }
  } catch (err) {
    console.error('Failed to open', path, err);
  }
}

async function openBrowserFile(file, handle) {
  const kind = kindOf(file.name);
  const loaded = TEXT_KINDS.includes(kind)
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
          { name: 'All supported', extensions: ['md', 'markdown', 'mdown', 'pdf', 'docx', 'pptx', 'xlsx', 'xls', 'csv', 'txt', 'log', 'json'] },
          { name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] },
        ],
        multiple: false,
        directory: false,
      },
    });
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
}

function clearFindHighlights() {
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete('mv-find');
    CSS.highlights.delete('mv-find-cur');
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

  // DOM-based kinds (md/docx/sheet/text/pptx): real ranges + highlights
  const root = PAGED_KINDS.includes(t.kind) ? t.pagesEl : contentEl;
  if (!root) { updateFindCount(); return; }
  const lq = q.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.data.toLowerCase();
    let i = 0;
    while ((i = text.indexOf(lq, i)) !== -1) {
      const r = new Range();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      findState.ranges.push(r);
      i += q.length;
    }
  }
  if (window.CSS && CSS.highlights && findState.ranges.length) {
    CSS.highlights.set('mv-find', new Highlight(...findState.ranges));
  }
  if (findState.ranges.length) gotoMatch(1); else updateFindCount();
}

function gotoMatch(dir) {
  const n = findState.ranges.length || findState.pdfMatches.length;
  if (!n) return;
  findState.current = ((findState.current + dir) % n + n) % n;
  if (findState.ranges.length) {
    const r = findState.ranges[findState.current];
    if (window.CSS && CSS.highlights) CSS.highlights.set('mv-find-cur', new Highlight(r));
    const rect = r.getBoundingClientRect();
    const srect = scrollerEl.getBoundingClientRect();
    scrollerEl.scrollTop += rect.top - srect.top - srect.height * 0.35;
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

function toggleEdit() {
  const t = activeTab();
  if (!isEditable(t)) return;
  t.editing = !t.editing;
  renderActive();
}

function syncEditorPane(t) {
  const editing = !!(t && t.editing && TEXT_KINDS.includes(t.kind));
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
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  if (window.turndownPluginGfm) td.use(turndownPluginGfm.gfm);
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
    m.querySelector('[data-act="reader"]').classList.toggle('hide', !(t && t.kind === 'pdf'));
    m.querySelector('[data-act="edit"]').classList.toggle('hide', !isEditable(t));
    m.querySelector('[data-act="find"]').classList.toggle('hide', !t);
  }
  m.hidden = !open;
}

const OVERFLOW_ACTIONS = {
  open: openViaPicker,
  ai: toggleAiPanel,
  map: toggleMap,
  reader: openReadingMode,
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

function wireGlobal() {
  $('open-btn').addEventListener('click', openViaPicker);
  $('new-tab').addEventListener('click', openViaPicker);
  $('toc-toggle').addEventListener('click', toggleSidebar);
  $('edit-btn').addEventListener('click', toggleEdit);
  $('reader-btn').addEventListener('click', openReadingMode);
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
    else if (mod && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
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
