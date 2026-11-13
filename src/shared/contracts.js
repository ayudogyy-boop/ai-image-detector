// 跨 MV3 上下文的纯契约：不访问 storage、DOM、网络或模型。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIDContracts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULTS = Object.freeze({
    sensitivity: 'medium', // 兼容旧存储；不改变固定 40/60 颜色规则。
    hoverDelay: 3000, mobileDetectDelay: 3000,
    showOnHover: true, showOnMobile: true, enabled: true,
    badgeTheme: 'ring', badgeSize: 26, reduceMotion: true, excludedHosts: Object.freeze([]),
    signals: Object.freeze({ onnx: true, c2pa: true, fileinfo: true, exif: true }),
  });
  const HOVER_DELAYS = Object.freeze([500, 1000, 1500, 2000, 3000]);
  const BADGE_THEMES = Object.freeze({ ring: '简洁圆环', petals: '花瓣', sun: '太阳' });
  const BADGE_SIZES = Object.freeze([26, 32, 40]);
  const MAX_FILE_BYTES = 40 * 1024 * 1024;
  const MAX_BATCH_ITEMS = 50;
  const WORKBENCH_PATH = 'src/workbench/index.html';
  const MESSAGE = Object.freeze({
    SETTINGS: 'GET_SETTINGS', SUMMARY: 'GET_SUMMARY', ANALYZE: 'ANALYZE_IMAGE',
    RUN: 'IMAGE_ANALYZE', PING: '__OFFSCREEN_PING__', READY: '__OFFSCREEN_READY__',
    TOOL_ANALYZE: 'WORKBENCH_ANALYZE', LOCAL_ANALYZE: 'LOCAL_IMAGE_ANALYZE', RUN_LOCAL: 'LOCAL_IMAGE_RUN',
    OPEN: 'OPEN_WORKBENCH', TAKE_TASKS: 'TAKE_WORKBENCH_TASKS', TASKS_CHANGED: 'WORKBENCH_TASKS_CHANGED',
    LIST_IMAGES: 'LIST_PAGE_IMAGES',
  });
  const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
  const BACKGROUND_PATH = 'src/background.js';
  const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const own = (x, key) => Object.prototype.hasOwnProperty.call(x, key);

  function normalizeSettings(raw) {
    const input = record(raw) ? raw : {};
    const out = { ...DEFAULTS, signals: { ...DEFAULTS.signals }, excludedHosts: [] };
    for (const key of ['enabled', 'showOnHover', 'showOnMobile']) {
      if (own(input, key) && typeof input[key] === 'boolean') out[key] = input[key];
    }
    if (own(input, 'hoverDelay') && HOVER_DELAYS.includes(input.hoverDelay)) out.hoverDelay = input.hoverDelay;
    if (own(input, 'mobileDetectDelay') && Number.isInteger(input.mobileDetectDelay) &&
        input.mobileDetectDelay >= 500 && input.mobileDetectDelay <= 30000) out.mobileDetectDelay = input.mobileDetectDelay;
    if (own(input, 'sensitivity') && ['low', 'medium', 'high'].includes(input.sensitivity)) out.sensitivity = input.sensitivity;
    if (own(input, 'badgeTheme') && own(BADGE_THEMES, input.badgeTheme)) out.badgeTheme = input.badgeTheme;
    if (own(input, 'badgeSize') && BADGE_SIZES.includes(input.badgeSize)) out.badgeSize = input.badgeSize;
    if (own(input, 'reduceMotion') && typeof input.reduceMotion === 'boolean') out.reduceMotion = input.reduceMotion;
    if (own(input, 'excludedHosts') && Array.isArray(input.excludedHosts)) {
      out.excludedHosts = [...new Set(input.excludedHosts.slice(0, 50).map(normalizeHost).filter(Boolean))];
    }
    if (own(input, 'signals') && record(input.signals)) {
      for (const key of Object.keys(DEFAULTS.signals)) {
        if (own(input.signals, key) && typeof input.signals[key] === 'boolean') out.signals[key] = input.signals[key];
      }
    }
    return out;
  }

  function normalizeHost(value) {
    if (typeof value !== 'string' || value.length > 255) return null;
    try {
      const text = value.trim().toLowerCase().replace(/^\*\./, '');
      if (!text) return null;
      const url = new URL(text.includes('://') ? text : 'https://' + text);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      const host = url.hostname.replace(/\.$/, '');
      return host && !host.includes('..') && /^[a-z0-9.\-\[\]:]+$/.test(host) ? host : null;
    } catch (_) { return null; }
  }

  function isExcludedHost(host, excluded) {
    const normalized = normalizeHost(host);
    return !!normalized && (excluded || []).some((entry) => normalized === entry || normalized.endsWith('.' + entry));
  }

  // Chrome storage 的 newValue 为整个字段值；删除字段也必须回退默认值。
  function applySettingsChanges(current, changes) {
    const next = normalizeSettings(current);
    let touched = false;
    for (const key of Object.keys(DEFAULTS)) {
      if (!record(changes) || !own(changes, key)) continue;
      next[key] = changes[key]?.newValue;
      touched = true;
    }
    return touched ? normalizeSettings(next) : null;
  }

  function normalizeAnalysisRequest(msg, type) {
    if (!record(msg) || msg.type !== type || typeof msg.url !== 'string' ||
        !msg.url || msg.url.length > 65536 || msg.url !== msg.url.trim()) return null;
    let url;
    try { url = new URL(msg.url); } catch (_) { return null; }
    const isRemote = (value) => ['http:', 'https:'].includes(value.protocol) && !value.username && !value.password;
    const remote = isRemote(url);
    const inline = url.protocol === 'data:' && /^data:image\/(?:png|apng|jpe?g|webp|gif|bmp|avif|x-icon|vnd\.microsoft\.icon)(?:;|,)/i.test(msg.url);
    let blob = false;
    if (url.protocol === 'blob:') {
      try { blob = isRemote(new URL(url.pathname)); } catch (_) {}
    }
    if (!remote && !inline && !blob && url.protocol !== 'file:') return null;
    const out = { type, url: msg.url };
    for (const key of ['needOnnx', 'needMeta', 'needC2pa']) {
      if (own(msg, key) && typeof msg[key] !== 'boolean') return null;
      out[key] = own(msg, key) ? msg[key] : true;
    }
    return out;
  }

  function senderRole(sender, runtime) {
    if (!sender || sender.id !== runtime.id) return null;
    if (!sender.tab) {
      if (sender.url === runtime.getURL(BACKGROUND_PATH)) return 'background';
      if (sender.url === runtime.getURL(OFFSCREEN_PATH)) return 'offscreen';
    }
    if (['src/popup/popup.html', 'src/options/options.html'].some((p) => sender.url === runtime.getURL(p))) return 'ui';
    if (sender.url === runtime.getURL(WORKBENCH_PATH)) return 'workbench';
    if (sender.tab && typeof sender.url === 'string' && !sender.url.startsWith(runtime.getURL(''))) return 'content';
    return null;
  }

  function normalizeLocalRequest(msg, type, runtime) {
    if (!record(msg) || msg.type !== type || typeof msg.url !== 'string' || msg.url.length > 512 || msg.url !== msg.url.trim()) return null;
    try {
      const url = new URL(msg.url);
      const inner = new URL(url.pathname);
      if (url.protocol !== 'blob:' || url.search || url.hash || inner.protocol !== 'chrome-extension:' || inner.hostname !== runtime.id ||
          inner.search || inner.hash || !/^\/[a-z0-9-]+$/i.test(inner.pathname)) return null;
    } catch (_) { return null; }
    const out = { type, url: msg.url };
    for (const key of ['needOnnx', 'needMeta', 'needC2pa']) {
      if (own(msg, key) && typeof msg[key] !== 'boolean') return null;
      out[key] = own(msg, key) ? msg[key] : true;
    }
    return out;
  }

  return Object.freeze({ DEFAULTS, HOVER_DELAYS, BADGE_THEMES, BADGE_SIZES, MAX_FILE_BYTES, MAX_BATCH_ITEMS,
    MESSAGE, OFFSCREEN_PATH, WORKBENCH_PATH, normalizeHost, isExcludedHost,
    normalizeSettings, applySettingsChanges, normalizeAnalysisRequest, normalizeLocalRequest, senderRole });
});
