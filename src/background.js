// Service Worker — Offscreen Document 生命周期管理 + 消息路由
//
// 注意：元数据解析**不在这里**。图片的字节抓取、元数据解析与确定性判定都在 offscreen 文档里
// （src/offscreen/offscreen.js + src/shared/metadata.js）——因为推理本来就要下载整张图，
// 让同一份字节顺带产出元数据事实，可以省掉一次重复下载（2026-10 审查 P2-1）。

// ── Offscreen 生命周期 ───────────────────────────────────────────
// 旧实现有两个坑（2026-10 审查发现）：
//   ① offscreenReady 是 SW 内存变量，offscreen 只在 init() 时发一次 __OFFSCREEN_READY__；
//      SW 被 Chrome 回收后重启，ensureOffscreenDoc() 看到 hasDocument() 为 true 就直接返回，
//      于是永远等不到就绪信号 —— 每个请求排队 30s 后返回 null，ONNX 实际上永久失效。
//   ② 用 20s 的 chrome.storage 调用做 keepalive 去"防止"SW 被回收：既费电，又掩盖 ①，
//      而且 SW 一旦真的重启，keepalive 自己也不会再启动。
// 现在改成**按需自愈**：不依赖任何常驻信号，每次请求先问 offscreen "你还活着吗"，
// 不响应就关掉重建。keepalive 已彻底删除。
importScripts('shared/contracts.js');
const { DEFAULTS, MESSAGE, normalizeSettings, normalizeAnalysisRequest, senderRole } = AIDContracts;
const OFFSCREEN_URL = AIDContracts.OFFSCREEN_PATH;
const READY_TIMEOUT_MS = 20000;   // 模型加载 + WASM 编译的兜底上限（实测冷启动 ~1.5s）
const PING_TIMEOUT_MS = 2000;

let offscreenReady = false;
let initPromise = null;
let readyResolve = null;
let readyTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settleReady(ok) {
  offscreenReady = ok;
  if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  if (readyResolve) { const r = readyResolve; readyResolve = null; r(ok); }
}

async function hasOffscreen() {
  try { return await chrome.offscreen.hasDocument(); } catch (_) { return false; }
}

/** 主动询问 offscreen 是否已就绪——这是唯一可信的就绪判据 */
async function pingOffscreen(timeoutMs) {
  try {
    const r = await Promise.race([
      chrome.runtime.sendMessage({ type: MESSAGE.PING }),
      sleep(timeoutMs || PING_TIMEOUT_MS).then(() => null),
    ]);
    return !!(r && r.ready);
  } catch (_) {
    return false;
  }
}

/**
 * 保证有一个"就绪的"offscreen 文档。
 * 返回 true 表示可以发推理请求。并发调用共享同一个 Promise。
 */
async function ensureOffscreen() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (await hasOffscreen()) {
      for (let i = 0; i < 3; i++) {
        if (await pingOffscreen()) { settleReady(true); return true; }
        await sleep(300);
      }
      // 文档存在但无响应（半死状态）：关掉重建，而不是无限等下去
      console.warn('[AID BG] offscreen 无响应，关闭后重建');
      try { await chrome.offscreen.closeDocument(); } catch (_) {}
      settleReady(false);
    }

    const wait = new Promise((resolve) => { readyResolve = resolve; });
    readyTimer = setTimeout(() => settleReady(false), READY_TIMEOUT_MS);
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: '在本地运行 ONNX 模型完成图像真实性分析（不外传任何数据）',
      });
      console.log('[AID BG] offscreen 已创建');
    } catch (err) {
      console.warn('[AID BG] offscreen 创建失败:', err);
      settleReady(false);
      return false;
    }
    // READY 可能早于 createDocument() 的 Promise 完成；计时器必须提前安装。
    return await wait;
  })().finally(() => { initPromise = null; });
  return initPromise;
}

/** 转给 offscreen；保留失败信息，不能把所有故障压成无来源的 null。 */
async function askOffscreen(payload) {
  const ok = await ensureOffscreen();
  if (!ok) {
    console.warn('[AID BG] offscreen 未就绪，放弃请求:', payload.type);
    return { ok: false, errorCode: 'analysis-unavailable', error: 'offscreen initialization failed' };
  }
  try {
    const r = await chrome.runtime.sendMessage(payload);
    if (!r || r.error) {
      if (r && r.error) console.warn('[AID BG] offscreen 报错:', r.error);
      return { ok: false, errorCode: r?.errorCode || 'analysis-unavailable', error: String(r?.error || 'empty response').slice(0, 160) };
    }
    return r;
  } catch (err) {
    console.warn('[AID BG] 消息路由失败:', err);
    return { ok: false, errorCode: 'analysis-unavailable', error: String(err?.message || err).slice(0, 160) };
  }
}

// ── 消息路由 ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const role = senderRole(sender, chrome.runtime);
  if (!role || !msg || typeof msg !== 'object') return;
  if (msg.type === MESSAGE.SETTINGS && (role === 'content' || role === 'ui')) {
    chrome.storage.sync.get(DEFAULTS, (settings) => { sendResponse(normalizeSettings(settings)); });
    return true;
  }

  if (msg.type === MESSAGE.READY) {
    if (role === 'offscreen') settleReady(true);
    return;
  }

  // 一次性拿回「视觉模型结论 + 元数据事实 + 确定性判定」。
  // 模型与 C2PA 均关闭时才只抓文件头。
  if (msg.type === MESSAGE.ANALYZE && role === 'content') {
    const request = normalizeAnalysisRequest(msg, MESSAGE.ANALYZE);
    if (!request) {
      sendResponse({ ok: false, errorCode: 'image-invalid-request', error: 'invalid analysis request' });
      return;
    }
    askOffscreen({ ...request, type: MESSAGE.RUN }).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.sync.set(DEFAULTS);
  }
  // 预创建 offscreen 文档，让第一次悬停就能拿到结果；失败也无所谓，请求时会自愈
  ensureOffscreen().catch(() => {});
});
