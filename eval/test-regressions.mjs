// 覆盖整项目审查发现的边界与跨模块问题；不需要网络、数据集或 Chrome。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const md = require('../src/shared/metadata.js');
const scoring = require('../src/shared/scoring.js');
const contracts = require('../src/shared/contracts.js');
const source = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };

test('PNG 工具名不区分键名大小写，prompt 普通品牌词不判 AI', () => {
  assert.equal(md.judgeMetadata({ pngText: { Software: 'Adobe Firefly' } }).verdict, 'red');
  for (const key of ['prompt', 'parameters', 'workflow']) {
    assert.equal(md.judgeMetadata({ pngText: { [key]: 'a flux capacitor in an imagen del paisaje' } }), null);
  }
  assert.equal(md.judgeMetadata({ pngText: { prompt: 'Midjourney v6' } }), null);
});

test('开关先过滤，伪造相机声明不掩盖未验签生成参数', () => {
  const raw = { c2pa: { hasC2PA: true, isAI: false }, pngText: { parameters: 'Steps: 30, Sampler: Euler, CFG scale: 7' } };
  const meta = { ...raw, verdict: null, verdictBySignal: {
    c2pa: md.judgeMetadata(raw, { exif: false }), exif: md.judgeMetadata(raw, { c2pa: false }),
  } };
  assert.equal(scoring.deterministicVerdict(meta).verdict, 'red');
  assert.equal(scoring.deterministicVerdict(meta, { exif: false }), null);
  assert.equal(scoring.deterministicVerdict(meta, { c2pa: false }).verdict, 'red');
  assert.equal(scoring.deterministicVerdict(meta, { c2pa: false, exif: false }), null);
  const fused = scoring.combineScores({ onnx: 5, c2pa: scoring.c2paScoreFromMeta(meta) });
  assert.equal(fused.color, 'red'); // 不能被冲突的相机声明强行覆盖成绿色。
});

function textPNG(entries) {
  const chunks = entries.map(([key, value]) => {
    const data = Buffer.from(key + '\0' + value);
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length); chunk.write('tEXt', 4); data.copy(chunk, 8);
    return chunk;
  });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

test('伪造 C2PA 字串不直接判定，工具字段只产生未验签声明', () => {
  const meta = md.summarizeBytes(textPNG([
    ['Description', 'jumb Nikon'], ['Software', 'ComfyUI'],
    ['XML:com.adobe.xmp', '<Iptc4xmpExt:DigitalSourceType>trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>'],
  ]));
  assert.equal(meta.verdictBySignal.c2pa, null);
  assert.equal(scoring.deterministicVerdict(meta).verdict, 'red');
  assert.equal(scoring.deterministicVerdict(meta, { c2pa: false }).verdict, 'red');
  assert.equal(scoring.c2paScoreFromMeta(meta), 50);
});

test('iTXt 缺失语言/翻译分隔符时不能从后续块借字节', () => {
  const data = Buffer.from('Software\0\0\0bad');
  const malformed = Buffer.alloc(12 + data.length);
  malformed.writeUInt32BE(data.length); malformed.write('iTXt', 4); data.copy(malformed, 8);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), malformed,
    textPNG([['Software', 'Adobe Photoshop']]).subarray(8)]);
  assert.equal(md.parsePNG(png).text.Software, 'Adobe Photoshop');
  // 只有损坏块时同样不能把残余语言字段当作工具名。
  assert.equal(md.parsePNG(png.subarray(0, 8 + malformed.length)).text.Software, undefined);
});

test('EXIF 偏移不能越过其所属段读取后续块的软件串', () => {
  const bytes = Buffer.alloc(100);
  bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4);
  bytes.writeUInt16LE(1, 8); bytes.writeUInt16LE(0x0131, 10);
  bytes.writeUInt16LE(2, 12); bytes.writeUInt32LE(14, 14); bytes.writeUInt32LE(40, 18);
  bytes.write('Adobe Firefly\0', 40);
  assert.equal(md.parseExifTIFF(bytes, 0, 26), null);
  assert.equal(md.parseExifTIFF(bytes, 0, bytes.length).software, 'Adobe Firefly');
});

test('WebP 截断块不能伪造 VP8X 尺寸', () => {
  const bytes = Buffer.alloc(25);
  bytes.write('RIFF'); bytes.write('WEBP', 8); bytes.write('VP8X', 12); bytes.writeUInt32LE(10, 16);
  const meta = md.extractMetadata(bytes);
  assert.equal(meta.width, null); assert.equal(meta.height, null);
});

function contentContext(sendMessage) {
  const context = vm.createContext({ console: quiet, Date, AIDScoring: scoring, AIDContracts: contracts,
    chrome: { runtime: { sendMessage } } });
  vm.runInContext(source('src/content/content.js').split('// ---- Content Script Entry ----')[0], context);
  return context;
}

const img = { src: 'https://example.test/image', naturalWidth: 100, naturalHeight: 100 };
test('过期缓存重新分析，不能 has=true 后 get=null 就永久退出', async () => {
  let downloads = 0;
  const ctx = contentContext(async () => { downloads++; return { onnx: { aiProbability: 0.7 } }; });
  ctx.img = img;
  vm.runInContext('__AID_cache.ttl = -1; __AID_cache.set(img.src, {color:"green"})', ctx);
  assert.ok(await vm.runInContext('analyzeImage(img, {})', ctx));
  assert.equal(downloads, 1);
});

test('修改设置后重新请求，旧异步结果不能污染新缓存', async () => {
  const pending = [];
  const ctx = contentContext(() => new Promise((resolve) => pending.push(resolve)));
  ctx.img = img;
  const old = vm.runInContext('analyzeImage(img, {})', ctx);
  vm.runInContext('__AID_generation++; __AID_cache.clear()', ctx);
  const fresh = vm.runInContext('analyzeImage(img, {})', ctx);
  assert.equal(pending.length, 2);
  pending[1]({ onnx: { aiProbability: 0.99 } }); await fresh;
  pending[0]({ onnx: { aiProbability: 0.01 } }); await old;
  assert.equal(vm.runInContext('__AID_cache.get(img.src).color', ctx), 'red');
});

test('暂时下载失败不缓存十分钟，下一次悬停可以重试', async () => {
  let calls = 0;
  const ctx = contentContext(async () => ++calls === 1 ? null : { onnx: { aiProbability: 0.99 } });
  ctx.img = img;
  await vm.runInContext('analyzeImage(img, {})', ctx);
  assert.equal(vm.runInContext('__AID_cache.get(img.src)', ctx), null);
  const result = await vm.runInContext('analyzeImage(img, {})', ctx);
  assert.equal(calls, 2); assert.equal(result.color, 'red');
});

test('元数据成功也不能缓存失败模型，重新悬停会取得新模型结果', async () => {
  let calls = 0;
  const ctx = contentContext(async () => ++calls === 1
    ? { ok: true, meta: { ok: true, container: 'jpeg' }, onnxError: 'temporary error', onnxErrorCode: 'model-inference-failed' }
    : { ok: true, meta: { ok: true }, onnx: { aiProbability: .99 } });
  ctx.img = img;
  const failed = await vm.runInContext('analyzeImage(img, {})', ctx);
  assert.equal(failed.color, 'gray'); assert.equal(failed.score, null);
  assert.equal(vm.runInContext('__AID_cache.get(img.src)', ctx), null);
  assert.equal((await vm.runInContext('analyzeImage(img, {})', ctx)).color, 'red');
  assert.equal(calls, 2);
});

function offscreenContext() {
  const listeners = [], sent = [];
  const ctx = vm.createContext({ console: quiet, Blob, Uint8Array, Float32Array, AbortController,
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
    AIDMetadata: { ...md, fetchBytesCapped: async () => new Uint8Array(32) }, AIDContracts: contracts, URL, window: {},
    fetch: async () => ({ ok: false, status: 404 }),
    ort: { env: { wasm: {} }, Tensor: class {} },
    chrome: { runtime: { id: 'test', getURL: (u) => 'chrome-extension://test/' + u, sendMessage: async (m) => { sent.push(m); },
      onMessage: { addListener: (f) => listeners.push(f) } } } });
  vm.runInContext(source('src/offscreen/offscreen.js'), ctx);
  return { ctx, listeners, sent };
}

test('模型加载失败，文档仍就绪，元数据仍可返回', async () => {
  const { ctx, listeners, sent } = offscreenContext();
  await new Promise((r) => setImmediate(r));
  let ping;
  listeners[0]({ type: '__OFFSCREEN_PING__' }, { id: 'test', url: 'chrome-extension://test/src/background.js' }, (r) => { ping = r; });
  assert.equal(ping.ready, true); assert.equal(ping.modelReady, false);
  assert.equal(sent[0].type, '__OFFSCREEN_READY__');
  const result = await vm.runInContext('analyzeImage("test", true, true)', ctx);
  assert.ok(result.meta); assert.match(result.onnxError, /404/);
});

test('offscreen 拒绝 content/UI 直接发任务，后台非法载荷也不触发下载', async () => {
  const { ctx, listeners } = offscreenContext();
  let downloads = 0, reply;
  ctx.AIDMetadata.fetchBytesCapped = async () => { downloads++; return new Uint8Array(32); };
  const message = { type: 'IMAGE_ANALYZE', url: 'https://example.test/a', needOnnx: false, needC2pa: false };
  for (const sender of [{ id: 'test', url: 'https://example.test/', tab: { id: 1 } },
    { id: 'test', url: 'chrome-extension://test/src/options/options.html' },
    { id: 'other', url: 'chrome-extension://test/src/background.js' }]) {
    listeners[0](message, sender, (r) => { reply = r; });
  }
  const background = { id: 'test', url: 'chrome-extension://test/src/background.js' };
  listeners[0]({ ...message, needMeta: 'false' }, background, (r) => { reply = r; });
  assert.equal(reply.errorCode, 'image-invalid-request'); assert.equal(downloads, 0);
  await new Promise((resolve) => listeners[0](message, background, resolve));
  assert.equal(downloads, 1);
});

test('首次加载失败后并发推理共享一次重载，恢复成功不再重载', async () => {
  const { ctx } = offscreenContext();
  await new Promise((r) => setImmediate(r));
  let loads = 0;
  ctx.fetch = async () => ({ ok: true, arrayBuffer: async () => { loads++; return new ArrayBuffer(0); } });
  ctx.ort.InferenceSession = { create: async () => ({ run: async () => ({ logits: { data: [1, 2] } }) }) };
  ctx.createImageBitmap = async () => ({ close() {} });
  ctx.OffscreenCanvas = class { getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8Array(224 * 224 * 4) }) }; } };
  const values = await vm.runInContext('Promise.all([runInferenceOnBytes(new Uint8Array()),runInferenceOnBytes(new Uint8Array()),runInferenceOnBytes(new Uint8Array())])', ctx);
  assert.equal(loads, 1); assert.equal(values.length, 3);
  assert.ok(values.every((v) => Number.isFinite(v.aiProbability)));
});

test('图片解码失败保留健康模型，故障代码明确', async () => {
  const { ctx } = offscreenContext();
  await new Promise((r) => setImmediate(r));
  ctx.mockSession = {};
  vm.runInContext('session = mockSession', ctx);
  ctx.createImageBitmap = async () => { throw Error('invalid image'); };
  await assert.rejects(vm.runInContext('runInferenceOnBytes(new Uint8Array())', ctx), (err) => err.code === 'image-decode-failed');
  assert.equal(vm.runInContext('session === mockSession', ctx), true);
});

test('图片 HTTP、大小、超时和中断分别报告，仍保持 null 兼容接口', async () => {
  for (const [fetchImpl, max, expected] of [
    [async () => new Response('', { status: 403 }), 10, 'image-http-error'],
    [async () => new Response(new Uint8Array(11)), 10, 'image-too-large'],
    [async () => { throw Error('network'); }, 10, 'image-fetch-failed'],
    [async () => new Response(new ReadableStream({ pull(c) { c.error(Error('broken')); } })), 10, 'image-read-failed'],
  ]) {
    let detail;
    assert.equal(await md.fetchBytesCapped('test', max, 1000, fetchImpl, { range: false, onError: (e) => { detail = e; } }), null);
    assert.equal(detail.code, expected);
    if (expected === 'image-http-error') assert.equal(detail.status, 403);
  }
  let timedOut;
  const pending = (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted'))));
  await md.fetchBytesCapped('test', 10, 10, pending, { range: false, onError: (e) => { timedOut = e; } });
  assert.equal(timedOut.code, 'image-fetch-timeout');
});

test('异步元数据解析失败不能中断模型及其他独立降级', async () => {
  const { ctx } = offscreenContext();
  await new Promise((r) => setImmediate(r));
  ctx.AIDMetadata.summarizeBytesAsync = async () => { throw new Error('malformed metadata'); };
  const result = await vm.runInContext('analyzeImage("test", true, true, false)', ctx);
  assert.equal(result.meta.reason, 'metadata-parse-failed');
  assert.match(result.onnxError, /404/);
});

test('跨图片下载/分析最多两个并发，完成后继续处理队列', async () => {
  const { ctx } = offscreenContext();
  await new Promise((r) => setImmediate(r));
  let active = 0, maxActive = 0, calls = 0;
  ctx.AIDMetadata.fetchBytesCapped = async () => {
    active++; calls++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setImmediate(r)); active--;
    return new Uint8Array(32);
  };
  const results = await vm.runInContext('Promise.all(Array.from({length:7}, (_,i) => analyzeImage("test"+i, true, true, false)))', ctx);
  assert.equal(maxActive, 2); assert.equal(calls, 7); assert.equal(results.length, 7);
});

test('同一 ONNX session 不并发 run；一项失败不阻塞后续请求', async () => {
  const { ctx } = offscreenContext();
  await new Promise((r) => setImmediate(r));
  let active = 0, maxActive = 0, calls = 0;
  const run = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setImmediate(r)); active--;
    if (++calls === 1) throw new Error('first inference failed');
    return { logits: { data: [1, 2] } };
  };
  ctx.mockSession = { run };
  ctx.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
  ctx.ort.InferenceSession = { create: async () => ({ run }) };
  ctx.createImageBitmap = async () => ({ close() {} });
  ctx.OffscreenCanvas = class { getContext() { return { drawImage() {}, getImageData: () => ({ data: new Uint8Array(224 * 224 * 4) }) }; } };
  vm.runInContext('session = mockSession', ctx);
  const results = await vm.runInContext('Promise.allSettled([runInferenceOnBytes(new Uint8Array()), runInferenceOnBytes(new Uint8Array())])', ctx);
  assert.equal(maxActive, 1); assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
});

test('offscreen READY 早于 createDocument 完成时不遗留超时器', async () => {
  let listener;
  const ctx = vm.createContext({ console: quiet, setTimeout, clearTimeout, AIDContracts: contracts, importScripts() {},
    chrome: { runtime: { id: 'test', getURL: (u) => 'chrome-extension://test/' + u,
      onMessage: { addListener: (f) => { listener = f; } } },
      offscreen: { hasDocument: async () => false, createDocument: async () => {
        listener({ type: '__OFFSCREEN_READY__' }, { id: 'test', url: 'chrome-extension://test/src/offscreen/offscreen.html' }, () => {});
      } }, onInstalled: { addListener() {} } } });
  // onInstalled 实际位于 runtime。
  ctx.chrome.runtime.onInstalled = { addListener() {} };
  vm.runInContext(source('src/background.js'), ctx);
  assert.equal(await vm.runInContext('ensureOffscreen()', ctx), true);
  assert.equal(vm.runInContext('readyTimer', ctx), null);
});
