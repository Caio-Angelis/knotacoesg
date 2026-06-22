// ==UserScript==
// @name         KNotaçõesG
// @namespace    https://github.com/Caio-Angelis/knotacoesg
// @version      1.0.0
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
      url: location.href,
      hostname: location.hostname,
      createdAt: Date.now(),
      videoTimestamp: payload.videoTimestamp ?? null,
      anchor: payload.anchor || { selector: '', markerId: '' },
    };
    const list = loadAnnotations();
    list.push(annotation);
    saveAnnotations(list);
    log('createAnnotation', annotation);
    return annotation;
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
    hoverTarget: null,
    clickModeActive: false,
    pending: null,
    createModal: null,
    panel: null,
    escHandler: null,
    clickHandlers: null,
    outsideClickHandler: null,
  };

  let kngInitialized = false;
  let toggleMenuId = null;
  let urlWatchersRegistered = false;
  let historyWrapped = false;

  // ─── UI HELPERS ───────────────────────────────────────────────────────────

  function isKngNode(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.id === 'kng-styles' || el.id === 'kng-fab' || el.id === 'kng-overlay') return true;
    if (el.classList && Array.from(el.classList).some((c) => c.startsWith('kng-'))) return true;
    return el.closest ? !!el.closest('[class*="kng-"], #kng-fab, #kng-overlay') : false;
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

  function buildAnnotationUrl(annotation) {
    const base = String(annotation.url || '').split('#')[0];
    return `${base}#${HASH_PREFIX}${annotation.id}`;
  }

  function showToast(message, durationMs = 3500) {
    document.querySelectorAll('.kng-toast').forEach((t) => t.remove());
    const toast = document.createElement('div');
    toast.className = 'kng-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
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
        pointer-events: none !important;
      }
      .kng-hover-target {
        outline: 2px solid #e6a817 !important;
        outline-offset: 2px !important;
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
        cursor: pointer !important;
      }
      .kng-list-item:hover { background: #f8f8fc !important; border-color: #c8c8d8 !important; }
      .kng-list-item strong { display: block !important; margin-bottom: 4px !important; }
      .kng-list-meta { font-size: 12px !important; color: #555 !important; }
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
    btnNew.textContent = 'Nova anotação (clique)';
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
    document.body.appendChild(menu);
    return fab;
  }

  // ─── CLICK MODE ───────────────────────────────────────────────────────────

  function clearHoverTarget() {
    if (ui.hoverTarget) {
      ui.hoverTarget.classList.remove('kng-hover-target');
      ui.hoverTarget = null;
    }
  }

  function setHoverTarget(el) {
    if (ui.hoverTarget === el) return;
    clearHoverTarget();
    if (el && !isKngNode(el)) {
      ui.hoverTarget = el;
      el.classList.add('kng-hover-target');
    }
  }

  function resolveClickTarget(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      if (isKngNode(node)) return null;
      const tag = node.tagName;
      if (tag === 'HTML' || tag === 'BODY') return null;
      return node;
    }
    return null;
  }

  function exitClickMode() {
    ui.clickModeActive = false;
    clearHoverTarget();
    if (ui.overlay) {
      ui.overlay.remove();
      ui.overlay = null;
    }
    if (ui.clickHandlers) {
      document.removeEventListener('mousemove', ui.clickHandlers.move, true);
      document.removeEventListener('click', ui.clickHandlers.click, true);
      ui.clickHandlers = null;
    }
    if (ui.escHandler) {
      document.removeEventListener('keydown', ui.escHandler, true);
      ui.escHandler = null;
    }
  }

  function enterClickMode() {
    if (ui.clickModeActive) return;
    closeCreateModal();
    ui.clickModeActive = true;

    const overlay = document.createElement('div');
    overlay.id = 'kng-overlay';
    overlay.className = 'kng-overlay';
    document.body.appendChild(overlay);
    ui.overlay = overlay;

    const onMove = (e) => {
      if (!ui.clickModeActive) return;
      const raw = document.elementFromPoint(e.clientX, e.clientY);
      setHoverTarget(resolveClickTarget(raw));
    };

    const onClick = (e) => {
      if (!ui.clickModeActive) return;
      if (isKngNode(e.target)) return;
      stopKngEvent(e);
      const target = resolveClickTarget(e.target);
      if (!target) {
        showToast('Selecione um elemento da página');
        return;
      }
      handleElementClick(target);
    };

    const onEsc = (e) => {
      if (e.key === 'Escape') {
        exitClickMode();
        showToast('Modo clique cancelado');
      }
    };

    ui.clickHandlers = { move: onMove, click: onClick };
    ui.escHandler = onEsc;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onEsc, true);
  }

  function handleElementClick(el) {
    const id = generateId();
    const selector = generateSelector(el);
    injectEphemeralMarker(el, id);
    ui.pending = { el, selector, markerId: id, id };
    openCreateModal();
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
      createAnnotation({
        id: ui.pending.id,
        title,
        description: descInput.value.trim(),
        tag: tagVal || null,
        videoTimestamp: video ? video.currentTime : null,
        anchor: {
          selector: ui.pending.selector,
          markerId: ui.pending.markerId,
        },
      });
      closeCreateModal();
      exitClickMode();
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
    document.body.appendChild(backdrop);
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

  function renderPanelList(container, filters) {
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
      const meta = [
        ann.hostname,
        ann.tag || 'Sem tag',
        formatDisplayDate(ann.createdAt),
        ann.videoTimestamp != null ? formatTimestamp(ann.videoTimestamp) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      li.innerHTML = `<strong>${escapeHtml(ann.title)}</strong><span class="kng-list-meta">${escapeHtml(meta)}</span>`;
      li.addEventListener('click', (e) => {
        stopKngEvent(e);
        navigateToAnnotation(ann);
      });
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
      renderPanelList(listContainer, filters);
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
    document.body.appendChild(backdrop);
    ui.panel = backdrop;
    trapFocus(panel);
    refresh();
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

  function tryHighlightFromHash() {
    const id = parseHashId();
    if (!id) return true;

    const annotation = findAnnotationById(id);
    if (!annotation) {
      showToast('Anotação não encontrada');
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

    window.addEventListener('hashchange', () => retryWithBackoff(tryHighlightFromHash));
    window.addEventListener('popstate', () => retryWithBackoff(tryHighlightFromHash));

    if (!historyWrapped) {
      historyWrapped = true;
      const origPush = history.pushState.bind(history);
      const origReplace = history.replaceState.bind(history);

      history.pushState = function (...args) {
        const ret = origPush(...args);
        retryWithBackoff(tryHighlightFromHash);
        return ret;
      };

      history.replaceState = function (...args) {
        const ret = origReplace(...args);
        retryWithBackoff(tryHighlightFromHash);
        return ret;
      };
    }
  }

  // ─── TOGGLE / TEARDOWN ────────────────────────────────────────────────────

  function teardownUI() {
    exitClickMode();
    closeCreateModal();
    closePanel();
    closeFabMenu();
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
    injectStyles();
    document.body.appendChild(createFAB());
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
        setupUI();
        registerUrlWatchers();
        retryWithBackoff(tryHighlightFromHash);
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

    setupUI();
    registerUrlWatchers();
    retryWithBackoff(tryHighlightFromHash);
    log('KNotaçõesG inicializado');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
