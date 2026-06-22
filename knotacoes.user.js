// ==UserScript==
// @name         KNotaçõesG
// @namespace    https://github.com/Caio-Angelis/knotacoesg
// @version      1.6.0
// @run-at       document-idle
// @description  Anotações globais em qualquer site
// @author       Caio-Angelis
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @updateURL    https://raw.githubusercontent.com/Caio-Angelis/knotacoesg/main/knotacoes.user.js
// @downloadURL  https://raw.githubusercontent.com/Caio-Angelis/knotacoesg/main/knotacoes.user.js
// ==/UserScript==

/*
 * KNotaçõesG — Userscript Tampermonkey
 *
 * Limitações conhecidas (ver plano.md):
 * - data-kng-id não persiste entre reloads; reencontro depende de anchor.selector
 * - Seletores CSS podem quebrar após redesign do site
 * - Timestamp de vídeo só em <video> nativo same-origin (não iframes cross-origin)
 * - SPAs podem falhar destaque se DOM ainda não renderizou (retry previsto na fase 7)
 */

(function () {
  'use strict';

  // ─── CONSTANTS ───────────────────────────────────────────────────────────

  const STORAGE_KEYS = {
    ANNOTATIONS: 'kng_annotations',
    SITE_ENABLED: 'kng_site_enabled',
  };
  const HASH_PREFIX = 'kng=';
  const DEBUG = false;
  const KNG_MARKER_ATTR = 'data-kng-id';

  const UNSTABLE_ID_PATTERNS = [
    /^ember\d+/i,
    /^react-aria-/i,
    /^:r[0-9a-z]+:$/i,
    /^mui-\d+/i,
    /^headlessui-/i,
    /^\d{5,}$/,
    /^[a-f0-9]{8,}$/i,
  ];

  // ─── LOGGING ─────────────────────────────────────────────────────────────

  function log(...args) {
    if (DEBUG) {
      console.log('[KNotaçõesG]', ...args);
    }
  }

  // ─── STORAGE ─────────────────────────────────────────────────────────────

  function loadAnnotations() {
    return GM_getValue(STORAGE_KEYS.ANNOTATIONS, []);
  }

  function saveAnnotations(list) {
    GM_setValue(STORAGE_KEYS.ANNOTATIONS, list);
    return list;
  }

  function generateId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function createAnnotation(payload) {
    const annotation = {
      id: payload.id || generateId(),
      title: payload.title || '',
      description: payload.description || '',
      tag: payload.tag || null,
      url: normalizePageUrl(location.href),
      pageKey: pageIdentity(location.href),
      hostname: location.hostname,
      createdAt: Date.now(),
      videoTimestamp: payload.videoTimestamp ?? null,
      anchor: payload.anchor || { type: 'point', x: 0, y: 0, selector: '', markerId: '' },
    };
    const list = loadAnnotations();
    list.push(annotation);
    saveAnnotations(list);
    log('createAnnotation', annotation);
    return annotation;
  }

  function updateAnnotationAnchor(id, x, y) {
    const list = loadAnnotations();
    const idx = list.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const prev = list[idx].anchor || {};
    list[idx].anchor = {
      ...prev,
      type: 'point',
      x,
      y,
    };
    saveAnnotations(list);
    log('updateAnnotationAnchor', id, x, y);
    return list[idx];
  }

  function deleteAnnotation(id) {
    const list = loadAnnotations().filter((a) => a.id !== id);
    saveAnnotations(list);
    log('deleteAnnotation', id);
    return list;
  }

  function loadSiteEnabledMap() {
    return GM_getValue(STORAGE_KEYS.SITE_ENABLED, {});
  }

  function isSiteEnabled(hostname = location.hostname) {
    const map = loadSiteEnabledMap();
    return map[hostname] !== false;
  }

  function setSiteEnabled(hostname, enabled) {
    const map = loadSiteEnabledMap();
    map[hostname] = enabled;
    GM_setValue(STORAGE_KEYS.SITE_ENABLED, map);
    log('setSiteEnabled', hostname, enabled);
    return map;
  }

  // ─── SELECTOR UTILS ───────────────────────────────────────────────────────

  function validateSelector(sel, targetEl) {
    if (!sel || !targetEl) return false;
    try {
      const nodes = document.querySelectorAll(sel);
      return nodes.length === 1 && nodes[0] === targetEl;
    } catch (_) {
      return false;
    }
  }

  function isStableId(id) {
    if (!id || typeof id !== 'string') return false;
    return !UNSTABLE_ID_PATTERNS.some((pattern) => pattern.test(id));
  }

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  function trySelector(sel, targetEl) {
    return validateSelector(sel, targetEl) ? sel : null;
  }

  function selectorFromId(el, targetEl) {
    let node = el;
    while (node && node !== document.documentElement) {
      if (node.id && isStableId(node.id)) {
        const sel = `#${cssEscape(node.id)}`;
        const found = trySelector(sel, targetEl);
        if (found) return found;
      }
      node = node.parentElement;
    }
    return null;
  }

  function selectorFromDataAttributes(el, targetEl) {
    let node = el;
    while (node && node !== document.documentElement) {
      if (node.attributes) {
        for (const attr of node.attributes) {
          if (!attr.name.startsWith('data-') || attr.name === KNG_MARKER_ATTR) continue;
          const sel = `[${attr.name}="${cssEscape(attr.value)}"]`;
          const found = trySelector(sel, targetEl);
          if (found) return found;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function selectorFromUniqueTagClasses(el, targetEl) {
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).filter((c) => c && !c.startsWith('kng-'));
    if (classes.length === 0) return null;

    const classPart = classes.map((c) => `.${cssEscape(c)}`).join('');
    const full = `${tag}${classPart}`;
    return trySelector(full, targetEl);
  }

  function segmentForNode(node) {
    const tag = node.tagName.toLowerCase();
    if (!node.parentElement) return tag;

    const parent = node.parentElement;
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    const nthOfType = siblings.indexOf(node) + 1;
    if (siblings.length > 1) {
      return `${tag}:nth-of-type(${nthOfType})`;
    }

    const allSiblings = Array.from(parent.children);
    const nthChild = allSiblings.indexOf(node) + 1;
    if (allSiblings.length > 1) {
      return `${tag}:nth-child(${nthChild})`;
    }

    return tag;
  }

  function selectorFromPath(el, targetEl) {
    const segments = [];
    let node = el;

    while (node && node !== document.documentElement) {
      segments.unshift(segmentForNode(node));
      node = node.parentElement;
    }

    const sel = segments.join(' > ');
    return trySelector(sel, targetEl);
  }

  function generateSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      throw new Error('generateSelector: elemento inválido');
    }

    const strategies = [
      () => selectorFromId(el, el),
      () => selectorFromDataAttributes(el, el),
      () => selectorFromUniqueTagClasses(el, el),
      () => selectorFromPath(el, el),
    ];

    for (const strategy of strategies) {
      const sel = strategy();
      if (sel) {
        log('generateSelector', sel, el);
        return sel;
      }
    }

    const fallback = selectorFromPath(el, el) || el.tagName.toLowerCase();
    log('generateSelector fallback', fallback, el);
    return fallback;
  }

  function injectEphemeralMarker(el, id) {
    if (!el || !id) return;
    el.setAttribute(KNG_MARKER_ATTR, id);
    log('injectEphemeralMarker', id, el);
  }

  // ─── VIDEO UTILS ──────────────────────────────────────────────────────────

  function isElementVisible(el) {
    if (!el || el.offsetParent === null) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getNativeVideos() {
    return Array.from(document.querySelectorAll('video')).filter((video) => {
      try {
        return video.ownerDocument === document;
      } catch (_) {
        return false;
      }
    });
  }

  function findNativeVideo() {
    const ytVideo = document.querySelector('video.html5-main-video');
    if (ytVideo && isElementVisible(ytVideo)) return ytVideo;

    const videos = getNativeVideos();
    if (videos.length === 0) return null;

    const active = document.activeElement;
    if (active && active.tagName === 'VIDEO' && videos.includes(active)) {
      return active;
    }

    const playing = videos.find((v) => !v.paused && isElementVisible(v));
    if (playing) return playing;

    const visible = videos.find((v) => isElementVisible(v));
    return visible || videos[0];
  }

  function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');

    if (h > 0) {
      return `${h}:${pad(m)}:${pad(s)}`;
    }
    return `${pad(m)}:${pad(s)}`;
  }

  function seekVideo(video, seconds) {
    if (!video) return;
    video.currentTime = Math.max(0, Number(seconds) || 0);
    video.play().catch(() => {});
    log('seekVideo', seconds, video);
  }

  // ─── UI STATE ─────────────────────────────────────────────────────────────

  const ui = {
    fab: null,
    fabMenu: null,
    overlay: null,
    clickCursor: null,
    clickModeActive: false,
    pending: null,
    createModal: null,
    panel: null,
    escHandler: null,
    clickHandlers: null,
    outsideClickHandler: null,
    markerEntries: null,
    markerScrollHandler: null,
    markerRenderTimer: null,
    domObserver: null,
    spaHooksRegistered: false,
  };

  let kngInitialized = false;
  let toggleMenuId = null;
  let urlWatchersRegistered = false;
  let historyWrapped = false;

  // ─── UI HELPERS ───────────────────────────────────────────────────────────

  const KNG_UI_SELECTOR =
    '#kng-fab, .kng-fab-menu, #kng-overlay, #kng-markers-layer, .kng-modal-backdrop, .kng-pin, .kng-pin-detail, .kng-toast';

  function isKngNode(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.id === 'kng-styles' || el.id === 'kng-fab' || el.id === 'kng-overlay' || el.id === 'kng-markers-layer') return true;
    if (el.closest && el.closest(KNG_UI_SELECTOR)) return true;
    return false;
  }

  function stopKngEvent(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function formatDisplayDate(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function normalizePageUrl(url = location.href) {
    return String(url || '').split('#')[0];
  }

  function pageIdentity(url = location.href) {
    const base = normalizePageUrl(url);
    try {
      const u = new URL(base);
      const host = u.hostname.replace(/^www\./, '');

      if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
        const v = u.searchParams.get('v');
        if (v) return `youtube:watch:${v}`;
        const shorts = u.pathname.match(/^\/shorts\/([^/?#]+)/);
        if (shorts) return `youtube:shorts:${shorts[1]}`;
        const embed = u.pathname.match(/^\/embed\/([^/?#]+)/);
        if (embed) return `youtube:embed:${embed[1]}`;
      }

      if (host === 'youtu.be') {
        const id = u.pathname.replace(/^\//, '').split('/')[0];
        if (id) return `youtube:watch:${id}`;
      }
    } catch (_) {}
    return base;
  }

  function matchesCurrentPage(annotation) {
    const currentKey = pageIdentity();
    const annKey = annotation.pageKey || pageIdentity(annotation.url);
    return annKey === currentKey;
  }

  function getMountRoot() {
    return document.body || document.documentElement;
  }

  function documentSize() {
    const el = document.documentElement;
    return {
      width: Math.max(el.scrollWidth, el.clientWidth, 1),
      height: Math.max(el.scrollHeight, el.clientHeight, 1),
    };
  }

  function pageToNormalized(pageX, pageY) {
    const size = documentSize();
    return {
      x: pageX / size.width,
      y: pageY / size.height,
    };
  }

  function normalizedToViewport(normX, normY) {
    const size = documentSize();
    return {
      left: normX * size.width - window.scrollX,
      top: normY * size.height - window.scrollY,
    };
  }

  function isPointAnchor(anchor) {
    return anchor && anchor.type === 'point' && typeof anchor.x === 'number' && typeof anchor.y === 'number';
  }

  function buildAnnotationUrl(annotation) {
    const base = String(annotation.url || '').split('#')[0];
    return `${base}#${HASH_PREFIX}${annotation.id}`;
  }

  function showToast(message, durationMs = 3500) {
    document.querySelectorAll('.kng-toast').forEach((t) => t.remove());
    const toast = document.createElement('div');
    toast.className = 'kng-toast';
    toast.textContent = message;
    getMountRoot().appendChild(toast);
    setTimeout(() => toast.remove(), durationMs);
  }

  function closeFabMenu() {
    if (ui.fabMenu) {
      ui.fabMenu.hidden = true;
    }
  }

  function closeCreateModal() {
    if (ui.createModal) {
      ui.createModal.remove();
      ui.createModal = null;
    }
    ui.pending = null;
  }

  function closePanel() {
    if (ui.panel) {
      ui.panel.remove();
      ui.panel = null;
    }
  }

  function trapFocus(container) {
    const focusable = container.querySelectorAll(
      'button, input, textarea, select, [href], [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  function navigateToAnnotation(ann) {
    closePanel();
    const target = buildAnnotationUrl(ann);
    const currentBase = location.href.split('#')[0];
    const targetBase = target.split('#')[0];
    if (targetBase === currentBase) {
      location.hash = HASH_PREFIX + ann.id;
      retryWithBackoff(tryHighlightFromHash);
    } else {
      window.location.href = target;
    }
  }

  // ─── STYLES ───────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('kng-styles')) return;

    const style = document.createElement('style');
    style.id = 'kng-styles';
    style.textContent = `
      .kng-fab {
        position: fixed !important;
        right: 20px !important;
        bottom: 20px !important;
        width: 52px !important;
        height: 52px !important;
        border-radius: 50% !important;
        border: none !important;
        background: #1a1a2e !important;
        color: #fff !important;
        font-size: 22px !important;
        cursor: pointer !important;
        z-index: 2147483646 !important;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        line-height: 1 !important;
        padding: 0 !important;
      }
      .kng-fab:hover { background: #16213e !important; }
      .kng-fab-menu {
        position: fixed !important;
        right: 20px !important;
        bottom: 82px !important;
        min-width: 220px !important;
        background: #fff !important;
        color: #111 !important;
        border-radius: 8px !important;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25) !important;
        z-index: 2147483646 !important;
        overflow: hidden !important;
        font: 14px/1.4 system-ui, sans-serif !important;
      }
      .kng-fab-menu button {
        display: block !important;
        width: 100% !important;
        border: none !important;
        background: transparent !important;
        text-align: left !important;
        padding: 12px 16px !important;
        cursor: pointer !important;
        color: inherit !important;
        font: inherit !important;
      }
      .kng-fab-menu button:hover { background: #f0f0f5 !important; }
      .kng-overlay {
        position: fixed !important;
        inset: 0 !important;
        background: rgba(0,0,0,0.12) !important;
        cursor: crosshair !important;
        z-index: 2147483645 !important;
        pointer-events: auto !important;
        touch-action: none !important;
      }
      .kng-click-cursor {
        position: fixed !important;
        width: 20px !important;
        height: 20px !important;
        border: 2px solid #e6a817 !important;
        border-radius: 50% !important;
        pointer-events: none !important;
        transform: translate(-50%, -50%) !important;
        z-index: 2147483646 !important;
        box-shadow: 0 0 0 2px rgba(230,168,23,0.35) !important;
      }
      .kng-point-pulse {
        position: fixed !important;
        width: 24px !important;
        height: 24px !important;
        border-radius: 50% !important;
        pointer-events: none !important;
        transform: translate(-50%, -50%) !important;
        z-index: 2147483647 !important;
        animation: kng-pulse 1s ease-in-out 3 !important;
        outline: none !important;
        background: rgba(230,168,23,0.35) !important;
        border: 3px solid #e6a817 !important;
      }
      .kng-modal-backdrop {
        position: fixed !important;
        inset: 0 !important;
        background: rgba(0,0,0,0.45) !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 16px !important;
      }
      .kng-modal, .kng-panel {
        background: #fff !important;
        color: #111 !important;
        border-radius: 10px !important;
        box-shadow: 0 12px 40px rgba(0,0,0,0.3) !important;
        font: 14px/1.5 system-ui, sans-serif !important;
        max-height: 90vh !important;
        overflow: auto !important;
      }
      .kng-modal {
        width: min(420px, 100%) !important;
        padding: 20px !important;
      }
      .kng-panel {
        width: min(640px, 100%) !important;
        padding: 20px !important;
      }
      .kng-modal h2, .kng-panel h2 {
        margin: 0 0 16px !important;
        font-size: 18px !important;
        font-weight: 600 !important;
      }
      .kng-field { margin-bottom: 12px !important; }
      .kng-field label {
        display: block !important;
        margin-bottom: 4px !important;
        font-weight: 500 !important;
      }
      .kng-field input, .kng-field textarea, .kng-field select {
        width: 100% !important;
        box-sizing: border-box !important;
        padding: 8px 10px !important;
        border: 1px solid #ccc !important;
        border-radius: 6px !important;
        font: inherit !important;
        background: #fff !important;
        color: #111 !important;
      }
      .kng-field textarea { min-height: 72px !important; resize: vertical !important; }
      .kng-video-preview {
        margin-bottom: 12px !important;
        padding: 8px 10px !important;
        background: #f5f5f8 !important;
        border-radius: 6px !important;
        font-size: 13px !important;
      }
      .kng-actions {
        display: flex !important;
        gap: 8px !important;
        justify-content: flex-end !important;
        margin-top: 16px !important;
      }
      .kng-btn {
        border: none !important;
        border-radius: 6px !important;
        padding: 8px 14px !important;
        cursor: pointer !important;
        font: inherit !important;
      }
      .kng-btn-primary { background: #1a1a2e !important; color: #fff !important; }
      .kng-btn-secondary { background: #e8e8ee !important; color: #111 !important; }
      .kng-filters {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 10px !important;
        margin-bottom: 16px !important;
        align-items: flex-end !important;
      }
      .kng-filters label { font-size: 12px !important; font-weight: 500 !important; }
      .kng-list { list-style: none !important; margin: 0 !important; padding: 0 !important; }
      .kng-list-item {
        border: 1px solid #e0e0e8 !important;
        border-radius: 8px !important;
        padding: 12px !important;
        margin-bottom: 8px !important;
        cursor: default !important;
        display: flex !important;
        align-items: stretch !important;
        gap: 10px !important;
      }
      .kng-list-item:hover { background: #f8f8fc !important; border-color: #c8c8d8 !important; }
      .kng-list-item-main {
        flex: 1 !important;
        min-width: 0 !important;
        cursor: pointer !important;
      }
      .kng-list-item strong { display: block !important; margin-bottom: 4px !important; }
      .kng-list-date {
        display: block !important;
        font-size: 12px !important;
        color: #222 !important;
        font-weight: 600 !important;
        margin-bottom: 4px !important;
      }
      .kng-list-meta { font-size: 12px !important; color: #555 !important; display: block !important; }
      .kng-list-delete { flex-shrink: 0 !important; align-self: center !important; }
      .kng-btn-danger {
        background: #c62828 !important;
        color: #fff !important;
        font-size: 12px !important;
        padding: 6px 10px !important;
      }
      .kng-btn-danger:hover { background: #b71c1c !important; }
      .kng-empty { color: #666 !important; text-align: center !important; padding: 24px !important; }
      .kng-pulse {
        animation: kng-pulse 1s ease-in-out 3 !important;
      }
      @keyframes kng-pulse {
        0%, 100% { outline: 2px solid transparent !important; outline-offset: 2px !important; }
        50% { outline: 3px solid #e6a817 !important; outline-offset: 3px !important; }
      }
      .kng-toast {
        position: fixed !important;
        bottom: 90px !important;
        right: 20px !important;
        background: #1a1a2e !important;
        color: #fff !important;
        padding: 10px 16px !important;
        border-radius: 8px !important;
        z-index: 2147483647 !important;
        font: 13px/1.4 system-ui, sans-serif !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3) !important;
        max-width: 320px !important;
      }
      .kng-markers-layer {
        position: fixed !important;
        inset: 0 !important;
        pointer-events: none !important;
        z-index: 2147483645 !important;
        overflow: hidden !important;
      }
      .kng-pin {
        position: fixed !important;
        pointer-events: auto !important;
        max-width: 200px !important;
        padding: 4px 10px !important;
        background: #e6a817 !important;
        color: #1a1a2e !important;
        border: 2px solid #1a1a2e !important;
        border-radius: 999px !important;
        font: 12px/1.3 system-ui, sans-serif !important;
        font-weight: 600 !important;
        cursor: grab !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25) !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        transform: translate(-50%, -50%) !important;
        user-select: none !important;
        touch-action: none !important;
      }
      .kng-pin:hover { background: #f0bc2a !important; }
      .kng-pin.kng-pin-open {
        background: #f0bc2a !important;
        border-color: #1a1a2e !important;
      }
      .kng-pin.kng-pin-dragging {
        cursor: grabbing !important;
        z-index: 2147483647 !important;
        opacity: 0.92 !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.35) !important;
      }
      .kng-pin-detail {
        position: fixed !important;
        width: min(280px, calc(100vw - 32px)) !important;
        background: #fff !important;
        color: #111 !important;
        border: 2px solid #e6a817 !important;
        border-radius: 10px !important;
        padding: 12px 14px !important;
        z-index: 2147483647 !important;
        font: 13px/1.45 system-ui, sans-serif !important;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25) !important;
        pointer-events: auto !important;
      }
      .kng-pin-detail h3 {
        margin: 0 0 6px !important;
        font-size: 14px !important;
        font-weight: 600 !important;
      }
      .kng-pin-detail p { margin: 0 0 6px !important; color: #444 !important; }
      .kng-pin-detail .kng-pin-meta { font-size: 11px !important; color: #666 !important; }
    `;
    document.head.appendChild(style);
  }

  // ─── FAB ──────────────────────────────────────────────────────────────────

  function createFAB() {
    const fab = document.createElement('button');
    fab.id = 'kng-fab';
    fab.className = 'kng-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'KNotaçõesG');
    fab.textContent = '📝';

    const menu = document.createElement('div');
    menu.className = 'kng-fab-menu';
    menu.hidden = true;

    const btnNew = document.createElement('button');
    btnNew.type = 'button';
    btnNew.textContent = 'Nova anotação';
    btnNew.addEventListener('click', (e) => {
      stopKngEvent(e);
      closeFabMenu();
      closePanel();
      enterClickMode();
    });

    const btnPanel = document.createElement('button');
    btnPanel.type = 'button';
    btnPanel.textContent = 'Ver anotações';
    btnPanel.addEventListener('click', (e) => {
      stopKngEvent(e);
      closeFabMenu();
      exitClickMode();
      openPanel();
    });

    menu.appendChild(btnNew);
    menu.appendChild(btnPanel);

    fab.addEventListener('click', (e) => {
      stopKngEvent(e);
      if (ui.createModal || ui.panel) return;
      menu.hidden = !menu.hidden;
    });

    ui.outsideClickHandler = (e) => {
      if (!menu.hidden && !fab.contains(e.target) && !menu.contains(e.target)) {
        closeFabMenu();
      }
    };
    document.addEventListener('click', ui.outsideClickHandler);

    ui.fab = fab;
    ui.fabMenu = menu;
    getMountRoot().appendChild(menu);
    return fab;
  }

  // ─── CLICK MODE (posição livre na página) ─────────────────────────────────

  const CLICK_BLOCK_EVENTS = [
    'mousedown',
    'mouseup',
    'pointerdown',
    'pointerup',
    'dblclick',
    'contextmenu',
    'touchstart',
    'touchend',
  ];

  function updateClickCursor(clientX, clientY) {
    if (!ui.clickCursor) return;
    ui.clickCursor.style.left = `${clientX}px`;
    ui.clickCursor.style.top = `${clientY}px`;
  }

  function removeClickCursor() {
    if (ui.clickCursor) {
      ui.clickCursor.remove();
      ui.clickCursor = null;
    }
  }

  function detachClickModeListeners() {
    if (!ui.clickHandlers) return;
    const { move, click, wheel, blockers, overlay } = ui.clickHandlers;
    if (overlay) {
      overlay.removeEventListener('mousemove', move);
      overlay.removeEventListener('click', click);
      if (wheel) overlay.removeEventListener('wheel', wheel);
    }
    if (blockers) {
      CLICK_BLOCK_EVENTS.forEach((type) => {
        document.removeEventListener(type, blockers, true);
      });
    }
    ui.clickHandlers = null;
  }

  function exitClickMode() {
    ui.clickModeActive = false;
    removeClickCursor();
    detachClickModeListeners();
    if (ui.overlay) {
      ui.overlay.remove();
      ui.overlay = null;
    }
    if (ui.escHandler) {
      document.removeEventListener('keydown', ui.escHandler, true);
      ui.escHandler = null;
    }
    const markersLayer = document.getElementById('kng-markers-layer');
    if (markersLayer) markersLayer.hidden = false;
  }

  function handlePointClick(pageX, pageY) {
    const norm = pageToNormalized(pageX, pageY);
    ui.pending = {
      id: generateId(),
      anchor: {
        type: 'point',
        x: norm.x,
        y: norm.y,
        selector: '',
        markerId: '',
      },
    };
    exitClickMode();
    openCreateModal();
  }

  function enterClickMode() {
    if (ui.clickModeActive) return;
    closeCreateModal();
    ui.clickModeActive = true;

    const markersLayer = document.getElementById('kng-markers-layer');
    if (markersLayer) markersLayer.hidden = true;

    const overlay = document.createElement('div');
    overlay.id = 'kng-overlay';
    overlay.className = 'kng-overlay';
    overlay.setAttribute('aria-label', 'Modo anotação — clique para marcar posição');
    getMountRoot().appendChild(overlay);
    ui.overlay = overlay;

    const cursor = document.createElement('div');
    cursor.className = 'kng-click-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    getMountRoot().appendChild(cursor);
    ui.clickCursor = cursor;

    showToast('Clique para marcar. A página está bloqueada. Scroll com a roda do mouse. Esc cancela.');

    const onMove = (e) => {
      if (!ui.clickModeActive) return;
      updateClickCursor(e.clientX, e.clientY);
    };

    const onClick = (e) => {
      if (!ui.clickModeActive) return;
      stopKngEvent(e);
      const pageX = e.clientX + window.scrollX;
      const pageY = e.clientY + window.scrollY;
      handlePointClick(pageX, pageY);
    };

    const onWheel = (e) => {
      if (!ui.clickModeActive) return;
      window.scrollBy({ left: e.deltaX, top: e.deltaY, behavior: 'auto' });
    };

    const blockPageInteraction = (e) => {
      if (!ui.clickModeActive) return;
      if (isKngNode(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    const onEsc = (e) => {
      if (e.key === 'Escape') {
        exitClickMode();
        showToast('Modo anotação cancelado');
      }
    };

    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('wheel', onWheel, { passive: true });

    CLICK_BLOCK_EVENTS.forEach((type) => {
      document.addEventListener(type, blockPageInteraction, true);
    });

    ui.clickHandlers = {
      move: onMove,
      click: onClick,
      wheel: onWheel,
      blockers: blockPageInteraction,
      overlay,
    };
    ui.escHandler = onEsc;
    document.addEventListener('keydown', onEsc, true);
  }

  // ─── CREATE MODAL ─────────────────────────────────────────────────────────

  function openCreateModal() {
    if (ui.createModal || !ui.pending) return;

    const video = findNativeVideo();
    const backdrop = document.createElement('div');
    backdrop.className = 'kng-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'kng-modal';
    modal.innerHTML = '<h2>Nova anotação</h2>';

    if (video) {
      const preview = document.createElement('div');
      preview.className = 'kng-video-preview';
      preview.textContent = `Timestamp: ${formatTimestamp(video.currentTime)}`;
      modal.appendChild(preview);
    }

    const titleField = document.createElement('div');
    titleField.className = 'kng-field';
    titleField.innerHTML = '<label for="kng-title">Título *</label>';
    const titleInput = document.createElement('input');
    titleInput.id = 'kng-title';
    titleInput.type = 'text';
    titleInput.required = true;
    titleField.appendChild(titleInput);

    const descField = document.createElement('div');
    descField.className = 'kng-field';
    descField.innerHTML = '<label for="kng-desc">Descrição</label>';
    const descInput = document.createElement('textarea');
    descInput.id = 'kng-desc';
    descField.appendChild(descInput);

    const tagField = document.createElement('div');
    tagField.className = 'kng-field';
    tagField.innerHTML = '<label for="kng-tag">Tag</label>';
    const tagInput = document.createElement('input');
    tagInput.id = 'kng-tag';
    tagInput.type = 'text';
    tagField.appendChild(tagInput);

    const actions = document.createElement('div');
    actions.className = 'kng-actions';

    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'kng-btn kng-btn-secondary';
    btnCancel.textContent = 'Cancelar';
    btnCancel.addEventListener('click', (e) => {
      stopKngEvent(e);
      closeCreateModal();
      exitClickMode();
    });

    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'kng-btn kng-btn-primary';
    btnSave.textContent = 'Salvar';
    btnSave.addEventListener('click', (e) => {
      stopKngEvent(e);
      const title = titleInput.value.trim();
      if (!title) {
        showToast('Informe um título');
        titleInput.focus();
        return;
      }
      const tagVal = tagInput.value.trim();
      const ann = createAnnotation({
        id: ui.pending.id,
        title,
        description: descInput.value.trim(),
        tag: tagVal || null,
        videoTimestamp: video ? video.currentTime : null,
        anchor: ui.pending.anchor,
      });
      closeCreateModal();
      exitClickMode();
      addSingleMarker(ann);
      showToast('Anotação salva');
    });

    actions.appendChild(btnCancel);
    actions.appendChild(btnSave);
    modal.appendChild(titleField);
    modal.appendChild(descField);
    modal.appendChild(tagField);
    modal.appendChild(actions);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        stopKngEvent(e);
        closeCreateModal();
        exitClickMode();
      }
    });
    modal.addEventListener('click', stopKngEvent);
    backdrop.appendChild(modal);
    getMountRoot().appendChild(backdrop);
    ui.createModal = backdrop;
    trapFocus(modal);
    titleInput.focus();
  }

  // ─── PANEL ────────────────────────────────────────────────────────────────

  function getFilteredAnnotations(filters) {
    let list = loadAnnotations().slice().sort((a, b) => b.createdAt - a.createdAt);

    if (filters.site) {
      list = list.filter((a) => a.hostname === filters.site);
    }
    if (filters.tag === '__none__') {
      list = list.filter((a) => !a.tag);
    } else if (filters.tag) {
      list = list.filter((a) => a.tag === filters.tag);
    }
    if (filters.videoOnly) {
      list = list.filter((a) => a.videoTimestamp != null);
    }
    return list;
  }

  function renderPanelList(container, filters, onChange) {
    container.innerHTML = '';
    const list = getFilteredAnnotations(filters);

    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'kng-empty';
      empty.textContent = 'Nenhuma anotação encontrada';
      container.appendChild(empty);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'kng-list';

    list.forEach((ann) => {
      const li = document.createElement('li');
      li.className = 'kng-list-item';

      const main = document.createElement('div');
      main.className = 'kng-list-item-main';

      const meta = [
        ann.hostname,
        ann.tag || 'Sem tag',
        ann.videoTimestamp != null ? `Vídeo ${formatTimestamp(ann.videoTimestamp)}` : null,
      ]
        .filter(Boolean)
        .join(' · ');

      main.innerHTML = `<strong>${escapeHtml(ann.title)}</strong><span class="kng-list-date">${escapeHtml(formatDisplayDate(ann.createdAt))}</span><span class="kng-list-meta">${escapeHtml(meta)}</span>`;
      main.addEventListener('click', (e) => {
        stopKngEvent(e);
        navigateToAnnotation(ann);
      });

      const btnDelete = document.createElement('button');
      btnDelete.type = 'button';
      btnDelete.className = 'kng-btn kng-btn-danger kng-list-delete';
      btnDelete.textContent = 'Excluir';
      btnDelete.title = 'Excluir anotação';
      btnDelete.addEventListener('click', (e) => {
        stopKngEvent(e);
        if (!confirm(`Excluir a anotação "${ann.title}"?`)) return;
        deleteAnnotation(ann.id);
        closePinDetailFor(ann.id);
        removeMarkerForAnnotation(ann.id);
        if (onChange) onChange();
        showToast('Anotação excluída');
      });

      li.appendChild(main);
      li.appendChild(btnDelete);
      ul.appendChild(li);
    });

    container.appendChild(ul);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function openPanel() {
    if (ui.panel) return;
    closeCreateModal();
    exitClickMode();

    const all = loadAnnotations();
    const hostnames = [...new Set(all.map((a) => a.hostname))].sort();
    const tags = [...new Set(all.map((a) => a.tag).filter(Boolean))].sort();

    const filters = { site: '', tag: '', videoOnly: false };

    const backdrop = document.createElement('div');
    backdrop.className = 'kng-modal-backdrop';

    const panel = document.createElement('div');
    panel.className = 'kng-panel';
    panel.innerHTML = '<h2>Anotações</h2>';

    const filterBar = document.createElement('div');
    filterBar.className = 'kng-filters';

    const siteWrap = document.createElement('div');
    siteWrap.className = 'kng-field';
    siteWrap.innerHTML = '<label for="kng-filter-site">Site</label>';
    const siteSelect = document.createElement('select');
    siteSelect.id = 'kng-filter-site';
    siteSelect.innerHTML = '<option value="">Todos</option>';
    hostnames.forEach((h) => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      siteSelect.appendChild(opt);
    });
    siteWrap.appendChild(siteSelect);

    const tagWrap = document.createElement('div');
    tagWrap.className = 'kng-field';
    tagWrap.innerHTML = '<label for="kng-filter-tag">Tag</label>';
    const tagSelect = document.createElement('select');
    tagSelect.id = 'kng-filter-tag';
    tagSelect.innerHTML = '<option value="">Todas</option><option value="__none__">Sem tag</option>';
    tags.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      tagSelect.appendChild(opt);
    });
    tagWrap.appendChild(tagSelect);

    const videoWrap = document.createElement('div');
    videoWrap.className = 'kng-field';
    const videoCheck = document.createElement('input');
    videoCheck.type = 'checkbox';
    videoCheck.id = 'kng-filter-video';
    const videoLabel = document.createElement('label');
    videoLabel.htmlFor = 'kng-filter-video';
    videoLabel.textContent = 'Somente com timestamp de vídeo';
    videoWrap.appendChild(videoCheck);
    videoWrap.appendChild(videoLabel);

    const listContainer = document.createElement('div');

    const refresh = () => {
      filters.site = siteSelect.value;
      filters.tag = tagSelect.value;
      filters.videoOnly = videoCheck.checked;
      renderPanelList(listContainer, filters, refresh);
    };

    siteSelect.addEventListener('change', refresh);
    tagSelect.addEventListener('change', refresh);
    videoCheck.addEventListener('change', refresh);

    filterBar.appendChild(siteWrap);
    filterBar.appendChild(tagWrap);
    filterBar.appendChild(videoWrap);

    const btnClose = document.createElement('button');
    btnClose.type = 'button';
    btnClose.className = 'kng-btn kng-btn-secondary';
    btnClose.textContent = 'Fechar';
    btnClose.addEventListener('click', (e) => {
      stopKngEvent(e);
      closePanel();
    });

    panel.appendChild(filterBar);
    panel.appendChild(listContainer);
    panel.appendChild(btnClose);
    panel.addEventListener('click', stopKngEvent);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        stopKngEvent(e);
        closePanel();
      }
    });

    backdrop.appendChild(panel);
    getMountRoot().appendChild(backdrop);
    ui.panel = backdrop;
    trapFocus(panel);
    refresh();
  }

  // ─── PAGE MARKERS (anotações visíveis na tela) ────────────────────────────

  function currentPageUrl() {
    return normalizePageUrl(location.href);
  }

  function getAnnotationsForCurrentPage() {
    return loadAnnotations().filter(matchesCurrentPage);
  }

  function removeMarkerForAnnotation(annotationId) {
    if (!ui.markerEntries) {
      scheduleRenderPageMarkers();
      return;
    }
    const idx = ui.markerEntries.findIndex((e) => e.annotationId === annotationId);
    if (idx === -1) {
      scheduleRenderPageMarkers();
      return;
    }
    ui.markerEntries[idx].pin.remove();
    ui.markerEntries.splice(idx, 1);
    if (ui.markerEntries.length === 0) clearPageMarkers();
  }

  function clearPageMarkers() {
    if (ui.markerRenderTimer) {
      clearTimeout(ui.markerRenderTimer);
      ui.markerRenderTimer = null;
    }
    document.querySelectorAll('.kng-pin-detail').forEach((el) => el.remove());
    const layer = document.getElementById('kng-markers-layer');
    if (layer) layer.remove();
    if (ui.markerScrollHandler) {
      window.removeEventListener('scroll', ui.markerScrollHandler, true);
      window.removeEventListener('resize', ui.markerScrollHandler);
      ui.markerScrollHandler = null;
    }
    ui.markerEntries = null;
  }

  function ensureMarkerScrollHandler() {
    if (ui.markerScrollHandler) return;
    ui.markerScrollHandler = () => updateMarkerPositions();
    window.addEventListener('scroll', ui.markerScrollHandler, true);
    window.addEventListener('resize', ui.markerScrollHandler);
  }

  function setupPinDrag(pin, entry) {
    const DRAG_THRESHOLD = 5;

    pin.addEventListener('pointerdown', (e) => {
      if (ui.clickModeActive) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      e.preventDefault();
      e.stopPropagation();

      let moved = false;
      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;

      try {
        pin.setPointerCapture(pointerId);
      } catch (_) {}

      pin.classList.add('kng-pin-dragging');

      const onPointerMove = (ev) => {
        if (ev.pointerId !== pointerId) return;

        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > DRAG_THRESHOLD) {
          moved = true;
        }

        const pageX = ev.clientX + window.scrollX;
        const pageY = ev.clientY + window.scrollY;
        const norm = pageToNormalized(pageX, pageY);
        entry.anchor.x = norm.x;
        entry.anchor.y = norm.y;

        const pos = normalizedToViewport(norm.x, norm.y);
        pin.style.left = `${pos.left}px`;
        pin.style.top = `${pos.top}px`;
        updatePinDetailPosition(entry.annotationId, entry.anchor);
      };

      const onPointerUp = (ev) => {
        if (ev.pointerId !== pointerId) return;

        pin.classList.remove('kng-pin-dragging');
        try {
          pin.releasePointerCapture(pointerId);
        } catch (_) {}

        pin.removeEventListener('pointermove', onPointerMove);
        pin.removeEventListener('pointerup', onPointerUp);
        pin.removeEventListener('pointercancel', onPointerUp);

        if (moved && entry.annotationId) {
          const updated = updateAnnotationAnchor(entry.annotationId, entry.anchor.x, entry.anchor.y);
          if (updated) entry.annotation = updated;
        } else if (!moved) {
          togglePinDetail(entry.annotation, { type: 'point', anchor: entry.anchor });
        }
      };

      pin.addEventListener('pointermove', onPointerMove);
      pin.addEventListener('pointerup', onPointerUp);
      pin.addEventListener('pointercancel', onPointerUp);
    });
  }

  function createPinElement(ann) {
    const pin = document.createElement('div');
    pin.className = 'kng-pin';
    pin.setAttribute('role', 'button');
    pin.tabIndex = 0;
    pin.dataset.kngPinId = ann.id;
    pin.title = `${ann.title} — arraste para mover`;
    pin.textContent = ann.title;

    const entry = {
      pin,
      type: 'point',
      annotationId: ann.id,
      annotation: ann,
      anchor: {
        type: 'point',
        x: ann.anchor.x,
        y: ann.anchor.y,
      },
    };

    setupPinDrag(pin, entry);
    return { pin, entry };
  }

  function addSingleMarker(ann) {
    if (!ann || !isPointAnchor(ann.anchor)) {
      scheduleRenderPageMarkers();
      return;
    }
    if (!matchesCurrentPage(ann)) return;

    const layer = ensureMarkersLayer();
    if (!ui.markerEntries) ui.markerEntries = [];

    const existing = ui.markerEntries.find((e) => e.annotationId === ann.id);
    if (existing) {
      existing.annotation = ann;
      existing.anchor.x = ann.anchor.x;
      existing.anchor.y = ann.anchor.y;
      updateMarkerPositions();
      return;
    }

    const { pin, entry } = createPinElement(ann);
    layer.appendChild(pin);
    ui.markerEntries.push(entry);
    updateMarkerPositions();
    ensureMarkerScrollHandler();
    if (ui.clickModeActive) layer.hidden = true;
  }

  function ensureMarkersLayer() {
    let layer = document.getElementById('kng-markers-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'kng-markers-layer';
      layer.className = 'kng-markers-layer';
      getMountRoot().appendChild(layer);
    }
    return layer;
  }

  function updateMarkerPositions() {
    if (!ui.markerEntries) return;
    ui.markerEntries.forEach((entry) => {
      const { pin } = entry;
      if (entry.type === 'point') {
        const pos = normalizedToViewport(entry.anchor.x, entry.anchor.y);
        pin.hidden = false;
        pin.style.left = `${pos.left}px`;
        pin.style.top = `${pos.top}px`;
        return;
      }
      const { el } = entry;
      if (!el.isConnected) {
        pin.hidden = true;
        return;
      }
      pin.hidden = false;
      const rect = el.getBoundingClientRect();
      pin.style.left = `${rect.right - 4}px`;
      pin.style.top = `${rect.top - 4}px`;
    });
  }

  function isPinDetailOpen(annotationId) {
    return !!document.querySelector(`.kng-pin-detail[data-kng-for="${annotationId}"]`);
  }

  function updatePinDetailPosition(annotationId, anchor) {
    const detail = document.querySelector(`.kng-pin-detail[data-kng-for="${annotationId}"]`);
    if (!detail || !anchor) return;
    const pos = normalizedToViewport(anchor.x, anchor.y);
    detail.style.left = `${Math.min(pos.left, window.innerWidth - 300)}px`;
    detail.style.top = `${Math.min(pos.top + 16, window.innerHeight - 120)}px`;
  }

  function closePinDetail() {
    document.querySelectorAll('.kng-pin-detail').forEach((el) => el.remove());
    document.querySelectorAll('.kng-pin.kng-pin-open').forEach((el) => el.classList.remove('kng-pin-open'));
  }

  function closePinDetailFor(annotationId) {
    document
      .querySelectorAll(`.kng-pin-detail[data-kng-for="${annotationId}"]`)
      .forEach((el) => el.remove());
    document
      .querySelectorAll(`.kng-pin[data-kng-pin-id="${annotationId}"]`)
      .forEach((el) => el.classList.remove('kng-pin-open'));
  }

  function togglePinDetail(annotation, anchorInfo) {
    if (isPinDetailOpen(annotation.id)) {
      closePinDetailFor(annotation.id);
      return;
    }
    showPinDetail(annotation, anchorInfo);
  }

  function showPinDetail(annotation, anchorInfo) {
    const detail = document.createElement('div');
    detail.className = 'kng-pin-detail';
    detail.dataset.kngFor = annotation.id;

    const parts = [];
    if (annotation.description) parts.push(`<p>${escapeHtml(annotation.description)}</p>`);
    const meta = [
      annotation.tag || null,
      annotation.videoTimestamp != null ? formatTimestamp(annotation.videoTimestamp) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    if (meta) parts.push(`<div class="kng-pin-meta">${escapeHtml(meta)}</div>`);

    detail.innerHTML = `<h3>${escapeHtml(annotation.title)}</h3>${parts.join('')}`;
    detail.addEventListener('click', stopKngEvent);

    let left;
    let top;
    if (anchorInfo.type === 'point') {
      const pos = normalizedToViewport(anchorInfo.anchor.x, anchorInfo.anchor.y);
      left = pos.left;
      top = pos.top + 16;
    } else {
      const rect = anchorInfo.el.getBoundingClientRect();
      left = rect.left;
      top = rect.bottom + 8;
    }
    detail.style.left = `${Math.min(left, window.innerWidth - 300)}px`;
    detail.style.top = `${Math.min(top, window.innerHeight - 120)}px`;
    getMountRoot().appendChild(detail);

    document
      .querySelectorAll(`.kng-pin[data-kng-pin-id="${annotation.id}"]`)
      .forEach((el) => el.classList.add('kng-pin-open'));
  }

  function renderPageMarkers() {
    clearPageMarkers();
    const annotations = getAnnotationsForCurrentPage();
    if (annotations.length === 0) return;

    const layer = ensureMarkersLayer();
    ui.markerEntries = [];

    annotations.forEach((ann) => {
      if (isPointAnchor(ann.anchor)) {
        const { pin, entry } = createPinElement(ann);
        layer.appendChild(pin);
        ui.markerEntries.push(entry);
        return;
      }

      const el = resolveAnnotationElement(ann);
      if (!el || isKngNode(el)) return;

      const pin = document.createElement('div');
      pin.className = 'kng-pin';
      pin.setAttribute('role', 'button');
      pin.tabIndex = 0;
      pin.dataset.kngPinId = ann.id;
      pin.title = ann.title;
      pin.textContent = ann.title;

      pin.addEventListener('click', (e) => {
        stopKngEvent(e);
        togglePinDetail(ann, { type: 'element', el });
      });

      layer.appendChild(pin);
      ui.markerEntries.push({ pin, el, type: 'element', annotationId: ann.id, annotation: ann });
    });

    if (ui.markerEntries.length === 0) {
      clearPageMarkers();
      return;
    }

    updateMarkerPositions();
    ensureMarkerScrollHandler();
    if (ui.clickModeActive) {
      const markersLayer = document.getElementById('kng-markers-layer');
      if (markersLayer) markersLayer.hidden = true;
    }
  }

  function scheduleRenderPageMarkers() {
    if (ui.markerRenderTimer) clearTimeout(ui.markerRenderTimer);
    ui.markerRenderTimer = setTimeout(renderPageMarkers, 150);
  }

  // ─── HIGHLIGHT ────────────────────────────────────────────────────────────

  function parseHashId() {
    const hash = location.hash.replace(/^#/, '');
    if (!hash.startsWith(HASH_PREFIX)) return null;
    const id = hash.slice(HASH_PREFIX.length);
    return id || null;
  }

  function findAnnotationById(id) {
    return loadAnnotations().find((a) => a.id === id) || null;
  }

  function resolveAnnotationElement(annotation) {
    const markerId = annotation.anchor?.markerId || annotation.id;
    if (markerId) {
      const byMarker = document.querySelector(`[${KNG_MARKER_ATTR}="${cssEscape(markerId)}"]`);
      if (byMarker) return byMarker;
    }
    const byId = document.querySelector(`[${KNG_MARKER_ATTR}="${cssEscape(annotation.id)}"]`);
    if (byId) return byId;

    const sel = annotation.anchor?.selector;
    if (sel) {
      try {
        return document.querySelector(sel);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function highlightElement(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('kng-pulse');
    const cleanup = () => el.classList.remove('kng-pulse');
    el.addEventListener('animationend', cleanup, { once: true });
    setTimeout(cleanup, 3100);
  }

  function highlightPoint(anchor) {
    const size = documentSize();
    const pageX = anchor.x * size.width;
    const pageY = anchor.y * size.height;
    window.scrollTo({
      left: Math.max(0, pageX - window.innerWidth / 2),
      top: Math.max(0, pageY - window.innerHeight / 2),
      behavior: 'smooth',
    });

    const pulse = document.createElement('div');
    pulse.className = 'kng-point-pulse';
    const pos = normalizedToViewport(anchor.x, anchor.y);
    pulse.style.left = `${pos.left}px`;
    pulse.style.top = `${pos.top}px`;
    getMountRoot().appendChild(pulse);
    pulse.addEventListener('animationend', () => pulse.remove(), { once: true });
    setTimeout(() => pulse.remove(), 3100);
  }

  function tryHighlightFromHash() {
    const id = parseHashId();
    if (!id) return true;

    const annotation = findAnnotationById(id);
    if (!annotation) {
      showToast('Anotação não encontrada');
      return true;
    }

    if (isPointAnchor(annotation.anchor)) {
      if (annotation.videoTimestamp != null) {
        const video = findNativeVideo();
        if (video) seekVideo(video, annotation.videoTimestamp);
      }
      highlightPoint(annotation.anchor);
      log('highlight point', annotation.id);
      return true;
    }

    const el = resolveAnnotationElement(annotation);
    if (!el) return false;

    if (annotation.videoTimestamp != null) {
      const video = findNativeVideo();
      if (video) seekVideo(video, annotation.videoTimestamp);
    }

    highlightElement(el);
    log('highlight', annotation.id, el);
    return true;
  }

  function retryWithBackoff(fn, delays = [500, 1000, 2000]) {
    if (!parseHashId()) return;
    if (fn()) return;

    let step = 0;
    const attempt = () => {
      if (fn()) return;
      if (step >= delays.length) {
        if (parseHashId()) {
          const ann = findAnnotationById(parseHashId());
          if (ann && isPointAnchor(ann.anchor)) return;
          showToast('Elemento não encontrado — a página pode ter mudado');
        }
        return;
      }
      setTimeout(() => {
        if (fn()) return;
        step += 1;
        attempt();
      }, delays[step]);
    };
    attempt();
  }

  // ─── URL WATCHERS ─────────────────────────────────────────────────────────

  function registerUrlWatchers() {
    if (urlWatchersRegistered) return;
    urlWatchersRegistered = true;

    const onUrlChange = () => {
      ensureBootstrap();
    };

    window.addEventListener('hashchange', onUrlChange);
    window.addEventListener('popstate', onUrlChange);

    if (!historyWrapped) {
      historyWrapped = true;
      const origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);

      history.pushState = function (...args) {
        const ret = origPush(...args);
        onUrlChange();
        return ret;
      };

      history.replaceState = function (...args) {
        const ret = origReplace(...args);
        onUrlChange();
        return ret;
      };
    }
  }

  function registerSPAHooks() {
    if (ui.spaHooksRegistered) return;
    ui.spaHooksRegistered = true;

    const onSpaNav = () => ensureBootstrap();
    document.addEventListener('yt-navigate-finish', onSpaNav);
    document.addEventListener('yt-page-data-updated', onSpaNav);
    window.addEventListener('load', onSpaNav);
  }

  function watchForDOMChanges() {
    const root = document.body;
    if (!root || ui.domObserver) return;

    ui.domObserver = new MutationObserver(() => {
      if (!isSiteEnabled()) return;
      if (!document.getElementById('kng-fab')) {
        setupUI();
      }
    });

    ui.domObserver.observe(root, { childList: true });
  }

  function ensureBootstrap(retry = 0) {
    if (!isSiteEnabled()) return;
    if (!getMountRoot()) {
      if (retry < 60) setTimeout(() => ensureBootstrap(retry + 1), 100);
      return;
    }

    injectStyles();
    setupUI();
    registerUrlWatchers();
    registerSPAHooks();
    watchForDOMChanges();
    scheduleRenderPageMarkers();
    retryWithBackoff(tryHighlightFromHash);
    log('ensureBootstrap');
  }

  // ─── TOGGLE / TEARDOWN ────────────────────────────────────────────────────

  function teardownUI() {
    exitClickMode();
    closeCreateModal();
    closePanel();
    closeFabMenu();
    clearPageMarkers();
    if (ui.domObserver) {
      ui.domObserver.disconnect();
      ui.domObserver = null;
    }
    if (ui.fab) {
      ui.fab.remove();
      ui.fab = null;
    }
    if (ui.fabMenu) {
      ui.fabMenu.remove();
      ui.fabMenu = null;
    }
    if (ui.outsideClickHandler) {
      document.removeEventListener('click', ui.outsideClickHandler);
      ui.outsideClickHandler = null;
    }
  }

  function setupUI() {
    if (document.getElementById('kng-fab')) return;
    const fab = createFAB();
    getMountRoot().appendChild(fab);
  }

  function updateToggleMenuCommand() {
    if (toggleMenuId != null) {
      GM_unregisterMenuCommand(toggleMenuId);
      toggleMenuId = null;
    }
    const label = isSiteEnabled()
      ? 'Desativar Anotações neste site'
      : 'Ativar Anotações neste site';
    toggleMenuId = GM_registerMenuCommand(label, () => {
      const enabling = !isSiteEnabled();
      setSiteEnabled(location.hostname, enabling);
      updateToggleMenuCommand();
      if (enabling) {
        ensureBootstrap();
      } else {
        teardownUI();
      }
    });
  }

  function registerToggleCommand() {
    updateToggleMenuCommand();
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────

  function init() {
    if (kngInitialized) return;
    kngInitialized = true;

    registerToggleCommand();

    if (!isSiteEnabled()) return;

    ensureBootstrap();
    log('KNotaçõesG inicializado');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('load', () => {
    if (isSiteEnabled()) ensureBootstrap();
  });
})();
