// ============================================================
// Image Authenticity Detector — Content Script
//
// 评分与融合规则不在这里：见 src/shared/scoring.js（manifest 里先于本文件加载）。
// 元数据解析与判定不在这里：见 src/shared/metadata.js（由 offscreen 加载）。
// 本文件只做：发现图片、请求分析、画徽章。
// ============================================================

// ---- LRU Cache with TTL ----
class AnalysisCache {
  constructor(maxEntries = 500, ttl = 600000) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.ttl = ttl;
  }
  get(url) {
    const entry = this.cache.get(url);
    if (!entry) return null;
    if (Date.now() - entry.created > this.ttl) { this.cache.delete(url); return null; }
    entry.lastAccessed = Date.now();
    return entry.result;
  }
  set(url, result) {
    const existing = this.cache.get(url);
    if (existing) {
      existing.lastAccessed = Date.now();
      existing.created = Date.now();
      existing.result = result;
      return;
    }
    if (this.cache.size >= this.maxEntries) {
      let oldest = null, oldestKey = null;
      for (const [key, val] of this.cache) {
        if (!oldest || val.lastAccessed < oldest) { oldest = val.lastAccessed; oldestKey = key; }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(url, { result, lastAccessed: Date.now(), created: Date.now() });
  }
  evict(url) { this.cache.delete(url); }
  has(url) { return this.cache.has(url); }
  clear() { this.cache.clear(); }
}
const __AID_cache = new AnalysisCache();

// ---- Signal 1: 视觉模型 + 元数据（一次请求，off screen 只下载一次） ----
async function __AID_analyzeRemote(src, needOnnx, needMeta, needC2pa) {
  try {
    const r = await chrome.runtime.sendMessage({ type: AIDContracts.MESSAGE.ANALYZE, url: src, needOnnx, needMeta, needC2pa });
    if (!r) return { ok: false, error: 'analysis-unavailable' };
    return r;
  } catch (err) { return { ok: false, errorCode: 'analysis-unavailable', error: String(err?.message || err).slice(0, 160) }; }
}

// ---- Signal 2: File Info (display only) ----
function __AID_sig_fileinfo(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const src = img.currentSrc || img.src || '';
  if (w < 50 || h < 50) return null;
  const ratio = w / h;
  if (ratio > 15 || ratio < 0.07) return null;
  let score = 50;
  // 只保留「生成器原生出图尺寸」。原先的表里混进了 1920x1080 / 1280x720 / 1440x900 等
  // —— 这些恰恰是最常见的真实照片与视频尺寸，一旦参与判定就是稳定的误报源。
  const aiSizes = new Set(['1024x1024','1024x1792','1792x1024','512x512','512x768','768x512','768x768','768x1024','1024x768','1344x768','1536x1024','1024x1536','576x1024','1024x576','1152x896','896x1152','1216x832','832x1216','1536x640','640x1536','1344x756','756x1344','1472x832','832x1472']);
  if (aiSizes.has(`${w}x${h}`)) score -= 20;
  if (Math.abs(ratio - 1) < 0.01) score -= 10;
  const mp = (w * h) / 1000000;
  if (mp > 20) score += 10; else if (mp > 12) score += 5;
  if ((ratio > 1.45 && ratio < 1.55) || (ratio > 1.32 && ratio < 1.36) || (ratio > 1.76 && ratio < 1.78)) score += 5;
  if (/\.(heic|cr2|cr3|nef|arw|dng|orf|raf|rw2)$/i.test(src)) score += 20;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ---- 判定结果整形 ----
const deterministicVerdict = AIDScoring.deterministicVerdict;

/** 把元数据里的软件串来源折算成展示用的细节（不参与打分） */
function __AID_metaInfo(meta) {
  if (!meta) return null;
  const bits = [];
  if (meta.exif && (meta.exif.make || meta.exif.model)) bits.push([meta.exif.make, meta.exif.model].filter(Boolean).join(' '));
  if (meta.exif && meta.exif.software) bits.push(meta.exif.software);
  if (meta.xmp && meta.xmp.creatorTool) bits.push(meta.xmp.creatorTool);
  if (meta.xmp && meta.xmp.digitalSourceType) bits.push(meta.xmp.digitalSourceType.split('/').pop());
  if (meta.container) bits.push(meta.container.toUpperCase());
  return bits.length ? bits.join(' · ') : null;
}

// ---- Analysis ----
const _analysisLocks = new Map();
let __AID_generation = 0;

async function analyzeImage(img, settings) {
  const src = img.currentSrc || img.src || '';
  if (!src) return null;
  const key = `${__AID_generation}:${src}`;
  if (_analysisLocks.has(key)) return _analysisLocks.get(key);
  const cached = __AID_cache.get(src);
  if (cached) return cached;

  console.log('[AID] analyze:', src.slice(0, 80));

  const promise = _doAnalyze(img, src, settings, __AID_generation);
  _analysisLocks.set(key, promise);
  try { return await promise; }
  finally { _analysisLocks.delete(key); }
}

async function _doAnalyze(img, src, settings, generation = __AID_generation) {
  const sigs = (settings && settings.signals) || {};
  const needOnnx = sigs.onnx !== false;
  const needMeta = sigs.c2pa !== false || sigs.exif !== false;

  // 本地信号（同步）+ 远端一次请求（off screen 自己决定要不要下载整图）
  const sigFileinfo = sigs.fileinfo === false ? null : __AID_sig_fileinfo(img);
  const remote = (needOnnx || needMeta) ? await __AID_analyzeRemote(src, needOnnx, needMeta, sigs.c2pa !== false) : null;

  const result = AIDScoring.scoreAnalysis(remote, settings, sigFileinfo);
  result.metaInfo = __AID_metaInfo(remote?.meta);
  console.log('[AID] result:', result.color, result.score, result.decidedBy);

  const hasResult = remote && (remote.onnx || (remote.meta && remote.meta.ok));
  const modelComplete = !needOnnx || result.modelStatus === 'available';
  if (generation === __AID_generation && modelComplete && (hasResult || (!needOnnx && !needMeta))) {
    __AID_cache.set(src, result);
  }
  return result;
}

// ---- Badge ----
// 元数据里的软件串来自图片文件本身（页面可控），塞进 innerHTML 前必须转义，否则是 XSS
function __AID_escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const __AID_badge = {
  _el: null, _img: null, _last: null, _appearance: AIDContracts.normalizeSettings(),
  setAppearance(settings) {
    this._appearance = AIDContracts.normalizeSettings(settings);
    const previous = this._last;
    if (previous) this.show(...previous);
  },
  show(img, result, mx, my) {
    this.hide();
    const appearance = this._appearance;
    const size = appearance.badgeSize;
    const colors = { green: '#22c55e', yellow: '#eab308', red: '#ef4444', gray: '#64748b' };
    const labelMap = { green: '模型偏非 AI', yellow: '不确定', red: '模型疑似 AI' };
    const label = result.title || labelMap[result.color] || '无法判断';
    const color = colors[result.color] || '#6b7280';
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;z-index:2147483647;left:${mx+12}px;top:${my+12}px;pointer-events:auto;cursor:pointer;opacity:0;transition:opacity .2s ease;`;
    const circle = document.createElement('div');
    circle.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font:bold ${Math.round(size*.42)}px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;background:${color};box-shadow:0 2px 8px rgba(0,0,0,.35);position:relative;isolation:isolate;`;
    circle.className = `aid-badge aid-badge-${result.color}`;
    circle.dataset.theme = appearance.badgeTheme;
    circle.textContent = result.decidedBy === 'verified-provenance' ? 'AI' : result.decidedBy === 'declaration' ? '!' : result.confidence === 'none' ? '—' : result.score;
    circle.tabIndex = 0; circle.setAttribute('role', 'button'); circle.setAttribute('aria-label', label + '，查看证据');
    circle.title = label;
    const ring = document.createElement('div');
    ring.className = 'aid-decoration'; ring.setAttribute('aria-hidden', 'true');
    ring.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:-1;';
    if (appearance.badgeTheme === 'ring') {
      ring.style.cssText += `inset:-4px;border-radius:50%;border:2px solid ${color};opacity:.5;`;
    } else {
      const petals = appearance.badgeTheme === 'petals', count = petals ? 8 : 12;
      for (let i = 0; i < count; i++) {
        const part = document.createElement('span');
        part.style.cssText = `position:absolute;left:50%;top:50%;width:${petals ? size*.35 : 2}px;height:${petals ? size*.55 : size*.26}px;border-radius:${petals ? '50%' : '2px'};background:${color};opacity:.6;transform:translate(-50%,-50%) rotate(${i*360/count}deg) translateY(-${size*.7}px);`;
        ring.appendChild(part);
      }
    }
    if (!appearance.reduceMotion) ring.style.animation = appearance.badgeTheme === 'ring' ? 'aid-pulse .7s ease-out' : 'aid-turn .7s ease-out';
    circle.appendChild(ring);
    const tip = document.createElement('div');
    tip.style.cssText = `display:none;position:absolute;top:calc(100% + 6px);left:0;background:rgba(24,24,36,.96);color:#fff;font:11px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:8px 10px;border-radius:8px;min-width:220px;white-space:nowrap;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.5);`;
    const sl = { onnx: '模型分析', camera: '相机元数据', fileinfo: '文件信息', exif: 'EXIF 元数据', c2pa: 'C2PA 溯源' };
    let html = `<div style="font-weight:600;margin-bottom:4px;color:${color}">${__AID_escapeHtml(label)}</div>`;
    if (result.confidence === 'low') html += '<div style="color:#9ca3af;margin-bottom:4px;">⚠ 部分信号受限，仅供参考</div>';
    if ( Array.isArray(result.reasons) && result.reasons.length) {
      const why = result.reasons.map(__AID_escapeHtml).join('、');
      html += `<div style="color:#9ca3af;margin-bottom:4px;white-space:normal;max-width:260px;">文件来源声明（未验签）：${why}</div>`;
    }
    if (result.metaInfo) {
      html += `<div style="color:#6b7280;margin-bottom:4px;white-space:normal;max-width:260px;font-size:10px;">${__AID_escapeHtml(result.metaInfo)}</div>`;
    }
    const statusText = { trusted: '签名及资产绑定通过，签发方在离线信任列表中', valid: '签名有效，签发方未受信任', invalid: '签名或资产完整性校验失败', 'not-present': '未发现本地 C2PA 清单', unavailable: 'C2PA 核验未完成', disabled: 'C2PA 核验已关闭' };
    const provenance = result.provenance || {};
    let provenanceNote = statusText[provenance.status] || '未核验';
    if (provenance.errors?.includes('assertion.dataHash.mismatch')) provenanceNote = '图片内容与签名绑定不一致';
    else if (provenance.errors?.includes('signingCredential.expired')) provenanceNote = '签名证书已过期，无法验证来源';
    html += `<div style="white-space:normal;max-width:280px;margin:6px 0;color:#cbd5e1">C2PA：${provenanceNote}${provenance.issuer ? '<br>签发方：' + __AID_escapeHtml(provenance.issuer) : ''}</div>`;
    html += '<div style="white-space:normal;max-width:280px;color:#94a3b8">模型分数仅供参考；未发现标识不代表真实。签名有效也不证明画面内容属实。SynthID / Content Seal 未在本地核验。</div>';
    if (result.modelIssue) {
      const issue = result.modelIssue;
      const action = issue.code === 'model-disabled' ? '可在扩展设置中开启 AI 模型分析。'
        : /^model-(?:load|init|inference)/.test(issue.code) ? '再次悬停会重试；若持续失败，请重新加载扩展。'
        : /^image-/.test(issue.code) ? '可稍后重试或换一张图片；这不代表图片是否由 AI 生成。'
        : '请重新加载扩展并刷新当前页面后重试。';
      html += `<div style="color:#cbd5e1;white-space:normal;max-width:280px;margin-top:4px">${__AID_escapeHtml(issue.message)}${issue.status ? '（HTTP ' + __AID_escapeHtml(issue.status) + '）' : ''}<br>${__AID_escapeHtml(action)}${issue.detail ? '<br>详情：' + __AID_escapeHtml(issue.detail) : ''}</div>`;
    }
    try {
      const version = chrome.runtime.getManifest?.().version;
      if (version) html += `<div style="color:#94a3b8;margin-top:4px">扩展版本 ${__AID_escapeHtml(version)}</div>`;
    } catch (_) {}
    for (const [name, det] of Object.entries(result.signals || {})) {
      if (!det || det.score === null) continue;
      if (name === 'c2pa' && det.note) {
        const noteText = det.note === 'ai-detected' ? '包含 AI 来源声明（未验签）' : det.note === 'camera-detected' ? '包含相机来源声明（未验签）' : det.note === 'no-data' ? '未取得可用的 C2PA 声明' : '存在 C2PA 数据（未知来源）';
        html += `<div style="display:flex;align-items:center;gap:4px;margin:2px 0;padding:2px 0"><span style="width:70px;flex-shrink:0;color:#d1d5db">C2PA 溯源</span><span style="font-size:11px;color:${color}">${noteText}</span></div>`;
        continue;
      }
      if (det.info) {
        const extra = name === 'camera' ? '（EXIF 可伪造，仅作参考）' : '仅供参考';
        html += `<div style="display:flex;align-items:center;gap:4px;margin:2px 0"><span style="width:70px;flex-shrink:0;color:#9ca3af">${sl[name]||name}</span><span style="font-size:10px;color:#6b7280">${det.score}/100 ${extra}</span></div>`;
        continue;
      }
      html += `<div style="display:flex;align-items:center;gap:4px;margin:2px 0"><span style="width:70px;flex-shrink:0;color:#d1d5db">${sl[name]||name}</span><span style="flex:1;height:6px;background:#374151;border-radius:3px;overflow:hidden"><span style="display:block;height:100%;width:${det.score}%;background:${color};border-radius:3px"></span></span><span style="width:24px;text-align:right;color:#9ca3af;font-size:10px">${det.score}</span></div>`;
    }
    html += '<div style="margin-top:8px;white-space:normal;max-width:280px">手动核验（需自行上传）：<br><a href="https://openai.com/verify" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" style="color:#93c5fd">OpenAI</a> · <a href="https://synthid.com/" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" style="color:#93c5fd">Google SynthID</a> · <a href="https://www.meta.ai/identification/" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" style="color:#93c5fd">Meta</a></div>';
    html += '<button type="button" class="aid-evidence-open" style="margin-top:8px;background:#2563eb;color:#fff;border:0;border-radius:4px;padding:5px 8px;cursor:pointer;font:inherit">在工作台查看证据</button>';
    tip.innerHTML = html;
    tip.querySelector('.aid-evidence-open').addEventListener('click', (event) => {
      event.stopPropagation();
      const src = img.currentSrc || img.src;
      chrome.runtime.sendMessage({ type: AIDContracts.MESSAGE.OPEN, url: src }).catch(() => {});
    });
    let tipVis = false;
    circle.addEventListener('click', (e) => { e.stopPropagation(); if (e.target.closest('a')) return; tipVis = !tipVis; tip.style.display = tipVis ? 'block' : 'none'; });
    circle.addEventListener('keydown', (e) => { if (e.target !== circle) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); circle.click(); } if (e.key === 'Escape') this.hide(); });
    circle.appendChild(tip); el.appendChild(circle); document.body.appendChild(el);
    el.style.left = Math.max(12, Math.min(mx + 12, window.innerWidth - size - 22)) + 'px';
    el.style.top = Math.max(12, Math.min(my + 12, window.innerHeight - size - 22)) + 'px';
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    this._el = el; this._img = img; this._last = [img, result, mx, my];
  },
  hide() { if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el); this._el = null; this._img = null; this._last = null; },
  isActive(img) { return this._img === img; }
};

// ---- Content Script Entry ----
(function() {
  'use strict';
  let settings = {}, hoverTimer = null, hoveredImg = null, hx = 0, hy = 0;
  let configuredSettings = AIDContracts.normalizeSettings();
  const effectiveSettings = (s) => ({ ...s, enabled: s.enabled && !AIDContracts.isExcludedHost(location.hostname, s.excludedHosts) });
  let scanTimer = null, scanIdle = 0, scanning = false, mobileTimer = null;
  let hoverRequest = 0;
  const imageSources = new WeakMap();
  const imageResults = new WeakMap();
  const boundImages = new WeakSet();

  function cancelHover() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    hoveredImg = null;
    hoverRequest++;
    __AID_badge.hide();
  }

  function markResult(img, src, result) {
    imageResults.set(img, { src, result });
    img.setAttribute('data-aid-processed', 'true');
  }

  async function loadSettings() {
    try {
      const s = await chrome.runtime.sendMessage({ type: AIDContracts.MESSAGE.SETTINGS });
      return AIDContracts.normalizeSettings(s);
    } catch (_) {
      return AIDContracts.normalizeSettings();
    }
  }

  function shouldAnalyze(img) {
    try {
      if (!img) return false;
      if (!img.src && !img.dataset.src) return false;
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) return false;
      if (img.getAttribute('role')==='presentation') return false;
      if (img.src.endsWith('.svg')||img.src.startsWith('data:image/svg')) return false;
      if (img.src.startsWith('data:')&&img.src.length>50000) return false;
      const w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
      if (w<20||h<20) return false;
      const r=w/h; return !(r>15||r<0.07);
    } catch(_){return false;}
  }

  function setupImage(img) {
    if (boundImages.has(img)) return;
    boundImages.add(img);
    img.setAttribute('data-aid-ready', '1');
    // cloneNode 会复制标记，但不会复制隔离上下文里的监听器或结果。
    img.removeAttribute('data-aid-processed');

    imageSources.set(img, img.currentSrc || img.src);

    img.addEventListener('mouseenter',(e)=>{
      if (!settings.enabled) return;
      // 悬停检测可以被关闭（旧实现保存了这个开关却从不读取）
      if (settings.showOnHover === false) return;
      if(!shouldAnalyze(img))return;
      cancelHover();
      hx=e.clientX;hy=e.clientY;hoveredImg=img;
      const request = hoverRequest;
      const generation = __AID_generation;
      const src = img.currentSrc || img.src;
      hoverTimer=setTimeout(async()=>{
        if(!img.isConnected)return;
        try {
          const r = await analyzeImage(img, settings);
          if (r && img.isConnected && hoveredImg === img && request === hoverRequest
              && generation === __AID_generation && settings.enabled && settings.showOnHover !== false
              && (img.currentSrc || img.src) === src) {
            __AID_badge.show(img, r, hx, hy);
            markResult(img, src, r);
          }
        } catch(e) { console.warn('[AID]',e); }
      },settings.hoverDelay||3000);
    });
    img.addEventListener('mouseleave',(e)=>{
      // 徽章属于图片的交互区，允许移过去点击证据详情。
      if (__AID_badge._el && __AID_badge._el.contains(e.relatedTarget)) return;
      if(hoveredImg===img) cancelHover();
    });
  }

  document.addEventListener('mousemove',(e)=>{
    if (!hoveredImg) return;
    const overBadge = __AID_badge._el && __AID_badge._el.contains(e.target);
    if (e.target !== hoveredImg && !overBadge) { cancelHover(); return; }
    if (!overBadge) { hx=e.clientX; hy=e.clientY; }
  },true);

  document.addEventListener('mouseenter', (e) => {
    const t = e.target;
    const img = t && t.closest ? t.closest('img') : null;
    if (!img || boundImages.has(img)) return;
    if (!img.src && !img.dataset.src) return;
    if (img.src && img.src.endsWith('.svg')) return;
    if ((img.naturalWidth || img.width) > 20 && (img.naturalHeight || img.height) > 20) {
      setupImage(img);
    }
  }, true);

  // ── 扫描器 ──────────────────────────────────────────────────
  // 旧实现有两个问题（2026-10 审查）：
  //   ① 选择器写成 `img:not([_aidReady])`，但代码设置的是 JS 属性 img._aidReady ——
  //      属性选择器看不到 JS 属性，过滤器等于失效，n 恒 >0，于是永远 500ms 扫一次、
  //      每次全文档 querySelectorAll，还每轮打一条 console.log。现在以 WeakSet 去重，
  //      不信任页面可以复制或预填的 data-aid-ready 属性。
  //   ② 扫描循环永不停止。现在连续若干轮无新图后自动停机，由 MutationObserver /
  //      load 事件重新唤醒。
  const QUIET_ROUNDS_BEFORE_STOP = 12;

  function attachNewImages() {
    const nodes = document.querySelectorAll('img');
    let n = 0;
    for (const img of nodes) {
      if (boundImages.has(img)) continue;
      if (!img.src && !img.dataset.src) continue;
      if (img.src && img.src.endsWith('.svg')) continue;
      if (img.getAttribute('role') === 'presentation') continue;
      if ((img.naturalWidth || img.width) > 20 && (img.naturalHeight || img.height) > 20) { setupImage(img); n++; }
    }
    return n;
  }

  function scheduleScan(delay) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  function scan() {
    scanTimer = null;
    if (!settings.enabled || document.hidden) { scanning = false; return; }
    const n = attachNewImages();
    if (n > 0) console.log('[AID] scan: attached', n);
    scanIdle = n > 0 ? 0 : scanIdle + 1;
    if (scanIdle >= QUIET_ROUNDS_BEFORE_STOP) { scanning = false; return; }   // 停机，等事件唤醒
    const delay = n > 0 ? 500 : (scanIdle < 4 ? 1000 : 3000);
    scheduleScan(delay);
  }

  function ensureScanning() {
    if (scanning || !settings.enabled || document.hidden) return;
    scanning = true;
    scanIdle = 0;
    scheduleScan(0);
  }

  function startScanner() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
        scanning = false;
        cancelHover();
      } else {
        ensureScanning();
      }
    });
    ensureScanning();
  }

  function setupMobile() {
    clearTimeout(mobileTimer);
    if(settings.showOnMobile===false)return;
    if(!('ontouchstart' in window)&&window.innerWidth>768)return;
    mobileTimer = setTimeout(()=>{
      if(!settings.enabled || settings.showOnMobile === false)return;
      const generation = __AID_generation;
      const visible=[];
      for(const img of document.querySelectorAll('img')){
        if(!boundImages.has(img))setupImage(img);
        if(img.hasAttribute('data-aid-processed'))continue;
        const r=img.getBoundingClientRect();
        if(r.bottom>=0&&r.top<=window.innerHeight&&r.right>=0&&r.left<=window.innerWidth) visible.push(img);
      }
      for(const img of visible.slice(0,10)){
        if(img.hasAttribute('data-aid-processed') || !shouldAnalyze(img))continue;
        const src = img.currentSrc || img.src;
        (async()=>{
          try{const r=await analyzeImage(img,settings);if(r&&img.isConnected&&settings.enabled&&settings.showOnMobile!==false&&generation===__AID_generation&&(img.currentSrc||img.src)===src){const rect=img.getBoundingClientRect();__AID_badge.show(img,r,rect.left+rect.width/2,rect.top+5);markResult(img,src,r);}}catch(_){}
        })();
      }
    },settings.mobileDetectDelay||3000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const role = AIDContracts.senderRole(sender, chrome.runtime);
    if (msg?.type === AIDContracts.MESSAGE.LIST_IMAGES && role === 'workbench') {
      const unique = new Set(), images = [];
      for (const img of document.images) {
        const url = img.currentSrc || img.src;
        if (!shouldAnalyze(img) || unique.has(url)) continue;
        if (!AIDContracts.normalizeAnalysisRequest({ type: AIDContracts.MESSAGE.ANALYZE, url }, AIDContracts.MESSAGE.ANALYZE)) continue;
        unique.add(url); images.push({ url });
        if (images.length >= AIDContracts.MAX_BATCH_ITEMS) break;
      }
      sendResponse({ images }); return;
    }
    if (msg?.type === AIDContracts.MESSAGE.SUMMARY && (role === 'ui' || role === 'background')) {
      // 汇总只统计"已分析过的图片"和它们的结果——徽章 DOM 会在鼠标移开时被移除，
      // 所以颜色统计不能从徽章节点里数（旧实现因此永远显示 0/0/0）。
      let g = 0, y = 0, r = 0, u = 0;
      for (const img of document.querySelectorAll('img[data-aid-processed]')) {
        const entry = imageResults.get(img);
        if (!entry || entry.src !== (img.currentSrc || img.src)) continue;
        const c = entry.result.color;
        if (c === 'green') g++; else if (c === 'yellow') y++; else if (c === 'red') r++; else u++;
      }
      sendResponse({ summary: { total: g + y + r + u, green: g, yellow: y, red: r, unavailable: u } });
      return true;
    }
  });

  async function init() {
    try {
      configuredSettings = await loadSettings();
      settings = effectiveSettings(configuredSettings);
      __AID_badge.setAppearance(settings);

      // 设置变更即时生效（旧实现只在初始化时读一次，改完必须刷新页面）
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        const next = AIDContracts.applySettingsChanges(configuredSettings, changes);
        if (next) {
          configuredSettings = next;
          settings = effectiveSettings(next);
          const onlyAppearance = Object.keys(changes).every((key) => ['badgeTheme', 'badgeSize', 'reduceMotion'].includes(key));
          if (onlyAppearance) { __AID_badge.setAppearance(settings); return; }
          __AID_badge._appearance = settings;
          __AID_generation++;
          cancelHover();
          if (scanTimer) clearTimeout(scanTimer);
          scanTimer = null;
          scanning = false;
          __AID_cache.clear();               // 灵敏度/开关变了，旧结论作废
          document.querySelectorAll('img[data-aid-processed]').forEach((i) => i.removeAttribute('data-aid-processed'));
          if (settings.enabled) ensureScanning();
          setupMobile();
        }
      });

      startScanner();

      const mo = new MutationObserver((mutations) => {
        if (hoveredImg && !hoveredImg.isConnected) cancelHover();
        const hasNewImage = mutations.some((m) => [...m.addedNodes].some((node) =>
          node.tagName === 'IMG' || (node.querySelector && node.querySelector('img'))));
        if (hasNewImage) ensureScanning();
      });
      mo.observe(document.body, { childList: true, subtree: true });

      document.addEventListener('load', (e) => {
        const img = e.target;
        if (!img || img.tagName !== 'IMG') return;
        const src = img.currentSrc || img.src;
        if (imageSources.has(img) && imageSources.get(img) !== src) {
          img.removeAttribute('data-aid-processed');
          imageResults.delete(img);
          if (hoveredImg === img || __AID_badge.isActive(img)) cancelHover();
        }
        imageSources.set(img, src);
        ensureScanning();
        if (!boundImages.has(img) && shouldAnalyze(img)) setupImage(img);
      }, true);
      setupMobile();
      console.log('[AID] active on', document.location.hostname);
    } catch(e){console.warn('[AID] init error:', e);}
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
