// Sutra ⇄ Excalidraw bridge.
// This is the ONLY React in Sutra. It is bundled (with React + Excalidraw) into
// a single IIFE at src/vendor/excalidraw.bundle.js and driven from vanilla
// app.js exclusively through the imperative `window.SutraCanvas` API below.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

// Fonts + assets are vendored locally so the canvas works fully offline.
// (Set before Excalidraw first renders.)
if (typeof window !== 'undefined' && !window.EXCALIDRAW_ASSET_PATH) {
  window.EXCALIDRAW_ASSET_PATH = './vendor/excalidraw-assets/';
}

let api = null;         // Excalidraw imperative API handle
let root = null;        // React root
let onChangeCb = null;  // debounced change notifier from app.js
let setThemeExt = null; // lets app.js flip theme without touching the scene

function Host({ initialData, theme }) {
  const [th, setTh] = React.useState(theme || 'light');
  setThemeExt = setTh;
  return React.createElement(Excalidraw, {
    initialData: initialData || null,
    theme: th,
    excalidrawAPI: (a) => { api = a; },
    onChange: (elements, appState, files) => {
      if (onChangeCb) onChangeCb();
    },
    UIOptions: { canvasActions: { loadScene: false } },
  });
}

function serialize() {
  if (!api) return null;
  return {
    type: 'excalidraw',
    version: 2,
    source: 'sutra',
    elements: api.getSceneElements(),
    appState: {
      viewBackgroundColor: api.getAppState().viewBackgroundColor,
      gridSize: api.getAppState().gridSize,
    },
    files: api.getFiles(),
  };
}

window.SutraCanvas = {
  // Mount the React root once into `el`. `data` is a parsed .excalidraw scene.
  mount(el, data, opts = {}) {
    onChangeCb = opts.onChange || null;
    const initialData = data && data.elements
      ? { elements: data.elements, appState: data.appState || {}, files: data.files || {} }
      : null;
    root = createRoot(el);
    root.render(React.createElement(Host, { initialData, theme: opts.theme || 'light' }));
  },
  // Replace the scene in-place (used when switching canvas tabs without unmount).
  load(data) {
    if (!api) return;
    api.updateScene({ elements: (data && data.elements) || [], appState: (data && data.appState) || {} });
    if (data && data.files) api.addFiles(Object.values(data.files));
    api.scrollToContent(undefined, { fitToContent: true });
  },
  getScene() { return serialize(); },
  isEmpty() { return !api || api.getSceneElements().length === 0; },
  setTheme(theme) { if (setThemeExt) setThemeExt(theme); },
  async exportPNG(scale = 2) {
    if (!api) return null;
    return exportToBlob({
      elements: api.getSceneElements(),
      appState: { ...api.getAppState(), exportBackground: true },
      files: api.getFiles(),
      mimeType: 'image/png',
      getDimensions: (w, h) => ({ width: w * scale, height: h * scale, scale }),
    });
  },
  async exportSVG() {
    if (!api) return null;
    const svg = await exportToSvg({
      elements: api.getSceneElements(),
      appState: { ...api.getAppState(), exportBackground: true },
      files: api.getFiles(),
    });
    return new XMLSerializer().serializeToString(svg);
  },
  destroy() { if (root) { root.unmount(); root = null; } api = null; onChangeCb = null; },
};
