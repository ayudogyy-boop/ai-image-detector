// Offscreen Document — ONNX 模型运行时 + 元数据字节抓取
//
// 为什么元数据也放在这里（2026-10 审查后合并）：
//   旧路径是「SW 用 Range 抓 512KB 解析元数据」+「offscreen 再抓一次整图做推理」，
//   同一张图要下载两次（实测一次分析最多 3 次图片请求）。
//   现在由 offscreen 抓一次：整图给推理用，前 512KB 给元数据解析用。
//   只开元数据且关闭 C2PA 时只抓 512KB；开启 C2PA 仍需完整文件校验资产绑定。
//
// 加载顺序：offscreen.html 先加载 /src/shared/metadata.js（提供 self.AIDMetadata）。
let session = null;
let loadError = null;
let initialized = false;
let inferenceQueue = Promise.resolve();
let modelInitPromise = null;
let lastModelAttempt = 0;
let loadErrorCode = null;
const MODEL_RETRY_INTERVAL_MS = 3000;

function failure(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function init() {
  if (session) return Promise.resolve(true);
  if (modelInitPromise) return modelInitPromise;
  modelInitPromise = (async () => {
    lastModelAttempt = Date.now();
    loadError = null;
    loadErrorCode = 'model-load-failed';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      ort.env.wasm.numThreads = 1;

      const modelResp = await fetch(chrome.runtime.getURL('models/detector.onnx'), { signal: ac.signal });
      if (!modelResp.ok) throw new Error('model fetch failed: ' + modelResp.status);
      const modelBuffer = await modelResp.arrayBuffer();
      clearTimeout(timer);

      loadErrorCode = 'model-init-failed';
      session = await ort.InferenceSession.create(
        new Uint8Array(modelBuffer),
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
      );

      loadErrorCode = null;
      console.log('[AID Offscreen] ONNX ready');
    } catch (err) {
      loadError = err && err.message ? err.message : String(err);
      if (ac.signal.aborted) loadErrorCode = 'model-load-timeout';
      console.error('[AID Offscreen] init error:', err);
    } finally {
      clearTimeout(timer);
      initialized = true;
      // 模型失败也能处理元数据；不要让 SW 在创建文档阶段丢弃整次请求。
      chrome.runtime.sendMessage({ type: AIDContracts.MESSAGE.READY }).catch(() => {});
    }
    return !!session;
  })().finally(() => { modelInitPromise = null; });
  return modelInitPromise;
}

async function ensureModel() {
  if (session) return;
  if (modelInitPromise) await modelInitPromise;
  if (session) return;
  const delay = MODEL_RETRY_INTERVAL_MS - (Date.now() - lastModelAttempt);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  await init();
  if (!session) throw failure(loadErrorCode || 'model-init-failed', loadError || 'model not loaded');
}

/** 视觉模型的预处理：224×224 + (pixel/255-0.5)/0.5，与模型仓库的 preprocessor_config 一致 */
function runInferenceOnBytes(bytes, dimensions) {
  const pending = inferenceQueue.then(async () => { await ensureModel(); return inferBytes(bytes, dimensions); });
  inferenceQueue = pending.catch(() => {});
  return pending;
}

async function inferBytes(bytes, dimensions) {
  if (!session) throw failure(loadErrorCode || 'model-init-failed', loadError || 'model not loaded');

  const info = dimensions || AIDMetadata.extractMetadata(bytes);
  if (Number.isFinite(info?.width) && Number.isFinite(info?.height) && info.width * info.height > 32000000) {
    throw failure('image-pixel-limit', 'image dimensions exceed 32 million pixel decode budget');
  }

  const blob = new Blob([bytes]);
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch (err) { throw failure('image-decode-failed', err?.message || String(err)); }

  const W = 224, H = 224;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  try { ctx.drawImage(bmp, 0, 0, W, H); }
  finally { bmp.close(); }
  const imageData = ctx.getImageData(0, 0, W, H);

  const data = imageData.data;
  const floatData = new Float32Array(3 * W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      floatData[0 * W * H + y * W + x] = (data[si] / 255 - 0.5) / 0.5;
      floatData[1 * W * H + y * W + x] = (data[si + 1] / 255 - 0.5) / 0.5;
      floatData[2 * W * H + y * W + x] = (data[si + 2] / 255 - 0.5) / 0.5;
    }
  }

  const tensor = new ort.Tensor('float32', floatData, [1, 3, W, H]);
  let results;
  try { results = await session.run({ pixel_values: tensor }); }
  catch (err) {
    const failedSession = session;
    session = null;
    // 损坏的推理运行时不能永久污染后续图片；解码失败不走这条路径。
    try { await failedSession.release?.(); } catch (_) {}
    throw failure('model-inference-failed', err?.message || String(err));
  }
  const logits = results.logits.data;

  // Binary classifier: class 0 = fake (AI), class 1 = real（已用模型仓库 config.json 的 id2label 核实）
  const maxL = Math.max(logits[0], logits[1]);
  const e0 = Math.exp(logits[0] - maxL);
  const e1 = Math.exp(logits[1] - maxL);
  const sum = e0 + e1;

  return { aiProbability: e0 / sum, realProbability: e1 / sum };
}

/**
 * 一次请求同时回传「元数据事实」与「模型结论」。
 * 元数据失败不影响推理结论，推理失败也不影响元数据结论——各自独立降级。
 */
let activeAnalyses = 0;
const analysisQueue = [];
function analyzeImage(url, needOnnx, needMeta, needC2pa = needMeta) {
  if (analysisQueue.length >= 32) return Promise.resolve({ ok: false, error: 'queue-full' });
  return new Promise((resolve, reject) => {
    analysisQueue.push({ url, needOnnx, needMeta, needC2pa, resolve, reject });
    drainAnalyses();
  });
}
function drainAnalyses() {
  while (activeAnalyses < 2 && analysisQueue.length) {
    const task = analysisQueue.shift();
    activeAnalyses++;
    analyzeAsset(task.url, task.needOnnx, task.needMeta, task.needC2pa)
      .then(task.resolve, task.reject).finally(() => { activeAnalyses--; drainAnalyses(); });
  }
}

async function analyzeAsset(url, needOnnx, needMeta, needC2pa) {
  const out = { ok: true };
  const HEADER = AIDMetadata.RECOMMENDED_HEADER_BYTES;
  let bytes = null;
  let fetchError = null;
  const onFetchError = (detail) => { out.fetchError = detail; };

  if (needOnnx || (needMeta && needC2pa)) {
    // 整图（有上限，见 ONNX_SOURCE_MAX_BYTES）。服务器若无视 Range 也无所谓：这里根本不发 Range。
    bytes = await AIDMetadata.fetchBytesCapped(
      url, AIDMetadata.ONNX_SOURCE_MAX_BYTES, 15000, null, { range: false, onError: onFetchError }
    );
    if (!bytes) fetchError = 'fetch-failed';
  } else if (needMeta) {
    bytes = await AIDMetadata.fetchBytesCapped(url, HEADER, 6000, null, { range: true, onError: onFetchError });
    if (!bytes) fetchError = 'fetch-failed';
  }

  if (needMeta) {
    try {
      out.meta = bytes && bytes.length >= 16
        ? await AIDMetadata.summarizeBytesAsync(bytes)
        : AIDMetadata.summarizeBytes(null);
    } catch (_) {
      out.meta = AIDMetadata.summarizeBytes(null);
      out.meta.reason = 'metadata-parse-failed';
    }
    if (needC2pa) {
      out.meta.provenance = !bytes ? { status: 'unavailable', aiDisclosure: false }
        : !AIDMetadata.hasJumb(bytes) ? { status: 'not-present', aiDisclosure: false }
        : await AIDC2PA.verify(bytes, AIDMetadata.sniffContainer(bytes).mime);
    }
  }

  if (needOnnx) {
    if (!bytes) {
      out.onnxError = fetchError || 'no-bytes';
      out.onnxErrorCode = out.fetchError?.code || 'image-fetch-failed';
    } else {
      try {
        out.onnx = await runInferenceOnBytes(bytes, out.meta);
      } catch (err) {
        out.onnxError = err && err.message ? err.message : String(err);
        out.onnxErrorCode = err?.code || 'model-inference-failed';
        console.warn('[AID Offscreen] 推理失败:', out.onnxError);
      }
    }
  }

  if (!out.meta && !out.onnx) {
    return { ok: false, error: fetchError || 'no-result' };
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (AIDContracts.senderRole(sender, chrome.runtime) !== 'background' || !msg || typeof msg !== 'object') return;
  // SW 的就绪探针：这是唯一可信的"能不能干活"判据。
  // 旧实现只在 init() 时发一次 __OFFSCREEN_READY__，SW 一重启就永久错失该信号。
  if (msg.type === AIDContracts.MESSAGE.PING) {
    sendResponse({ ready: initialized, modelReady: !!session, error: loadError, errorCode: loadErrorCode });
    return;
  }

  if (msg.type === AIDContracts.MESSAGE.RUN || msg.type === AIDContracts.MESSAGE.RUN_LOCAL) {
    const request = msg.type === AIDContracts.MESSAGE.RUN_LOCAL
      ? AIDContracts.normalizeLocalRequest(msg, msg.type, chrome.runtime)
      : AIDContracts.normalizeAnalysisRequest(msg, msg.type);
    if (!request) {
      sendResponse({ ok: false, errorCode: 'image-invalid-request', error: 'invalid analysis request' });
      return;
    }
    analyzeImage(request.url, request.needOnnx, request.needMeta, request.needC2pa)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err && err.message ? err.message : String(err) }));
    return true;
  }

});

// Expose for direct testing (offscreen page context)
window.__runInference = async (url) => {
  const bytes = await AIDMetadata.fetchBytesCapped(url, AIDMetadata.ONNX_SOURCE_MAX_BYTES, 15000, null, { range: false });
  if (!bytes) throw new Error('fetch failed');
  return runInferenceOnBytes(bytes);
};
window.__analyzeImage = analyzeImage;

init();
