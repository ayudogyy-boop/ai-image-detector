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
    signals: Object.freeze({ onnx: true, c2pa: true, fileinfo: true, exif: true }),
  });
  const HOVER_DELAYS = Object.freeze([500, 1000, 1500, 2000, 3000]);
  const MESSAGE = Object.freeze({
    SETTINGS: 'GET_SETTINGS', SUMMARY: 'GET_SUMMARY', ANALYZE: 'ANALYZE_IMAGE',
    RUN: 'IMAGE_ANALYZE', PING: '__OFFSCREEN_PING__', READY: '__OFFSCREEN_READY__',
  });
  const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
  const BACKGROUND_PATH = 'src/background.js';
  const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const own = (x, key) => Object.prototype.hasOwnProperty.call(x, key);

  function normalizeSettings(raw) {
    const input = record(raw) ? raw : {};
    const out = { ...DEFAULTS, signals: { ...DEFAULTS.signals } };
    for (const key of ['enabled', 'showOnHover', 'showOnMobile']) {
      if (own(input, key) && typeof input[key] === 'boolean') out[key] = input[key];
    }
    if (own(input, 'hoverDelay') && HOVER_DELAYS.includes(input.hoverDelay)) out.hoverDelay = input.hoverDelay;
    if (own(input, 'mobileDetectDelay') && Number.isInteger(input.mobileDetectDelay) &&
        input.mobileDetectDelay >= 500 && input.mobileDetectDelay <= 30000) out.mobileDetectDelay = input.mobileDetectDelay;
    if (own(input, 'sensitivity') && ['low', 'medium', 'high'].includes(input.sensitivity)) out.sensitivity = input.sensitivity;
    if (own(input, 'signals') && record(input.signals)) {
      for (const key of Object.keys(DEFAULTS.signals)) {
        if (own(input.signals, key) && typeof input.signals[key] === 'boolean') out.signals[key] = input.signals[key];
      }
    }
    return out;
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
    if (sender.tab && typeof sender.url === 'string' && !sender.url.startsWith(runtime.getURL(''))) return 'content';
    return null;
  }

  return Object.freeze({ DEFAULTS, HOVER_DELAYS, MESSAGE, OFFSCREEN_PATH,
    normalizeSettings, applySettingsChanges, normalizeAnalysisRequest, senderRole });
});
