// Sutra ⇄ Excalidraw bridge.
// This is the ONLY React in Sutra. It is bundled (with React + Excalidraw) into
// a single IIFE at src/vendor/excalidraw.bundle.js and driven from vanilla
// app.js exclusively through the imperative `window.SutraCanvas` API below.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, exportToBlob, exportToSvg, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

if (typeof window !== 'undefined' && !window.EXCALIDRAW_ASSET_PATH) {
  window.EXCALIDRAW_ASSET_PATH = './vendor/excalidraw-assets/';
}

let api = null;         // Excalidraw imperative API handle
let root = null;        // React root
let onChangeCb = null;  // debounced change notifier from app.js
let setThemeExt = null; // lets app.js flip theme without touching the scene
let bgEl = null;        // the Sutra background-pattern layer (behind Excalidraw)

// Keep the pattern layer aligned with Excalidraw's pan/zoom.
function syncBg(appState) {
  if (!bgEl || !appState) return;
  const zoom = (appState.zoom && appState.zoom.value) || 1;
  const size = (appState.gridSize || 20) * zoom;
  const x = (appState.scrollX || 0) * zoom;
  const y = (appState.scrollY || 0) * zoom;
  bgEl.style.backgroundSize = size + 'px ' + size + 'px';
  bgEl.style.backgroundPosition = x + 'px ' + y + 'px';
}

function Host({ initialData, theme }) {
  const [th, setTh] = React.useState(theme || 'light');
  setThemeExt = setTh;
  const bgRef = React.useCallback((n) => { bgEl = n; }, []);
  // transparent Excalidraw bg so the Sutra pattern layer shows through
  const init = initialData
    ? { ...initialData, appState: { ...(initialData.appState || {}), viewBackgroundColor: 'transparent' } }
    : { appState: { viewBackgroundColor: 'transparent' } };
  return React.createElement(
    'div',
    { style: { position: 'absolute', inset: 0 } },
    React.createElement('div', { ref: bgRef, className: 'sutra-cbg', 'data-bg': 'dots' }),
    React.createElement(Excalidraw, {
      initialData: init,
      theme: th,
      excalidrawAPI: (a) => { api = a; setTimeout(() => syncBg(a.getAppState()), 0); },
      onChange: (elements, appState) => { syncBg(appState); if (onChangeCb) onChangeCb(); },
      // sutra:// links (doc cards) are handled by the app, not the browser
      onLinkOpen: (element, event) => {
        const href = element && element.link;
        if (href && window.SutraCanvasOnLink && window.SutraCanvasOnLink(href)) {
          event.preventDefault();
        }
      },
      UIOptions: { canvasActions: { loadScene: false } },
    })
  );
}

function serialize() {
  if (!api) return null;
  const a = api.getAppState();
  return {
    type: 'excalidraw',
    version: 2,
    source: 'sutra',
    elements: api.getSceneElements(),
    // remember the Sutra background choice inside the file
    appState: { gridSize: a.gridSize, sutraBackground: bgEl ? bgEl.dataset.bg : 'dots' },
    files: api.getFiles(),
  };
}

// Solid background for exports (transparent-on-screen would export blank).
function exportAppState(extra) {
  const a = api.getAppState();
  const dark = a.theme === 'dark';
  return { ...a, exportBackground: true, viewBackgroundColor: dark ? '#1e1e1e' : '#ffffff', ...extra };
}

window.SutraCanvas = {
  mount(el, data, opts = {}) {
    onChangeCb = opts.onChange || null;
    const initialData = data && data.elements
      ? { elements: data.elements, appState: data.appState || {}, files: data.files || {} }
      : null;
    root = createRoot(el);
    root.render(React.createElement(Host, { initialData, theme: opts.theme || 'light' }));
    // restore the saved background pattern once mounted
    const bg = (data && data.appState && data.appState.sutraBackground) || 'dots';
    setTimeout(() => this.setBackground(bg), 60);
  },
  load(data) {
    if (!api) return;
    api.updateScene({ elements: (data && data.elements) || [], appState: (data && data.appState) || {} });
    if (data && data.files) api.addFiles(Object.values(data.files));
    api.scrollToContent(undefined, { fitToContent: true });
    this.setBackground((data && data.appState && data.appState.sutraBackground) || 'dots');
  },
  getScene() { return serialize(); },
  isEmpty() { return !api || api.getSceneElements().length === 0; },
  setTheme(theme) { if (setThemeExt) setThemeExt(theme); },

  // --- Sutra background pattern: 'none' | 'grid' | 'dots' ---
  setBackground(mode) {
    if (bgEl) bgEl.dataset.bg = mode;
    if (api) syncBg(api.getAppState());
  },
  getBackground() { return bgEl ? bgEl.dataset.bg : 'dots'; },

  // --- color: apply to selection if any, and to the next-drawn element ---
  setStrokeColor(hex) {
    if (!api) return;
    const sel = api.getAppState().selectedElementIds || {};
    const ids = Object.keys(sel).filter((k) => sel[k]);
    if (ids.length) {
      const els = api.getSceneElements().map((e) =>
        ids.includes(e.id) ? { ...e, strokeColor: hex, version: (e.version || 1) + 1 } : e);
      api.updateScene({ elements: els });
    }
    api.updateScene({ appState: { currentItemStrokeColor: hex } });
  },
  setFillColor(hex) {
    if (!api) return;
    const sel = api.getAppState().selectedElementIds || {};
    const ids = Object.keys(sel).filter((k) => sel[k]);
    if (ids.length) {
      const els = api.getSceneElements().map((e) =>
        ids.includes(e.id) ? { ...e, backgroundColor: hex, version: (e.version || 1) + 1 } : e);
      api.updateScene({ elements: els });
    }
    api.updateScene({ appState: { currentItemBackgroundColor: hex } });
  },

  // --- doc card: a linked card representing a Sutra document ---
  // opts: { name, link, color } → rounded rect + label, placed at the
  // viewport centre (staggered so repeated sends don't stack exactly).
  addDocCard(opts) {
    if (!api) return false;
    const a = api.getAppState();
    const zoom = (a.zoom && a.zoom.value) || 1;
    const cx = (a.width / 2) / zoom - a.scrollX;
    const cy = (a.height / 2) / zoom - a.scrollY;
    const n = api.getSceneElements().length;
    const skeleton = {
      type: 'rectangle',
      x: cx - 110 + (n % 5) * 24,
      y: cy - 40 + (n % 5) * 20,
      width: 220,
      height: 80,
      strokeColor: opts.color || '#b5623a',
      backgroundColor: 'transparent',
      roundness: { type: 3 },
      link: opts.link || null,
      label: { text: opts.name || 'Document', fontSize: 16 },
    };
    const els = convertToExcalidrawElements([skeleton]);
    // the label inherits the link too, so clicking anywhere on the card works
    const linked = els.map((e) => ({ ...e, link: opts.link || null }));
    api.updateScene({ elements: [...api.getSceneElements(), ...linked] });
    return true;
  },

  // --- AI board: cards (nodes) + arrows (edges), bound so arrows follow cards ---
  // nodes: [{id,label,x,y,w,h,stroke,bg,text,fontSize}], edges: [{from,to,x,y,w,h}]
  buildBoard(nodes, edges) {
    if (!api) return false;
    const skeleton = [];
    for (const n of nodes) {
      skeleton.push({
        type: 'rectangle', id: n.id, x: n.x, y: n.y, width: n.w, height: n.h,
        strokeColor: n.stroke || '#1e1e1e', backgroundColor: n.bg || 'transparent',
        strokeWidth: 2, roundness: { type: 3 },
        label: { text: n.label || '', fontSize: n.fontSize || 16, strokeColor: n.text || n.stroke || '#1e1e1e' },
      });
    }
    for (const e of edges) {
      skeleton.push({
        type: 'arrow', x: e.x, y: e.y, width: e.w, height: e.h,
        points: [[0, 0], [e.w, e.h]],
        start: { id: e.from }, end: { id: e.to },
        strokeColor: '#868e96', strokeWidth: 1.6, endArrowhead: 'arrow',
      });
    }
    const els = convertToExcalidrawElements(skeleton);
    api.updateScene({ elements: [...api.getSceneElements(), ...els] });
    // fit AFTER the scene commits — scrolling in the same tick sees stale bounds
    requestAnimationFrame(() => { try { api.scrollToContent(els, { fitToContent: true, viewportZoomFactor: 0.82, animate: false }); } catch (_) {} });
    return true;
  },

  async exportPNG(scale = 2) {
    if (!api) return null;
    return exportToBlob({
      elements: api.getSceneElements(),
      appState: exportAppState(),
      files: api.getFiles(),
      mimeType: 'image/png',
      getDimensions: (w, h) => ({ width: w * scale, height: h * scale, scale }),
    });
  },
  async exportSVG() {
    if (!api) return null;
    const svg = await exportToSvg({
      elements: api.getSceneElements(),
      appState: exportAppState(),
      files: api.getFiles(),
    });
    return new XMLSerializer().serializeToString(svg);
  },
  destroy() { if (root) { root.unmount(); root = null; } api = null; onChangeCb = null; bgEl = null; },
};
