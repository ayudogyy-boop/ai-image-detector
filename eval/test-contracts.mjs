import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const c = require('../src/shared/contracts.js');
const runtime = { id: 'test', getURL: (p) => 'chrome-extension://test/' + p };
const content = { id: 'test', url: 'https://example.test/', tab: { id: 1 } };
const background = { id: 'test', url: runtime.getURL('src/background.js') };
const offscreen = { id: 'test', url: runtime.getURL(c.OFFSCREEN_PATH) };
const ui = { id: 'test', url: runtime.getURL('src/options/options.html'), tab: { id: 2 } };

test('默认设置不可变，返回值不共享可变 signals', () => {
  assert.ok(Object.isFrozen(c.DEFAULTS) && Object.isFrozen(c.DEFAULTS.signals));
  const a = c.normalizeSettings(); a.signals.onnx = false;
  assert.equal(c.normalizeSettings().signals.onnx, true);
});

test('旧版部分设置按字段补全，显式 false 保留', () => {
  const value = c.normalizeSettings({ enabled: false, signals: { onnx: false }, hoverDelay: 500, sensitivity: 'high' });
  assert.deepEqual(value, { ...c.DEFAULTS, enabled: false, hoverDelay: 500, sensitivity: 'high',
    signals: { ...c.DEFAULTS.signals, onnx: false } });
});

test('损坏类型、未知字段、原型继承设置不能污染运行时', () => {
  for (const raw of [null, [], false, 'false', { enabled: 'false', hoverDelay: Infinity,
    mobileDetectDelay: -1, sensitivity: 'extreme', signals: { onnx: 0, exif: null }, unknown: true },
    Object.create({ enabled: false, signals: { onnx: false } })]) {
    assert.deepEqual(c.normalizeSettings(raw), c.DEFAULTS);
  }
  assert.equal(c.normalizeSettings({ mobileDetectDelay: 30000 }).mobileDetectDelay, 30000);
  assert.equal(c.normalizeSettings({ mobileDetectDelay: 30001 }).mobileDetectDelay, 3000);
});

test('storage 删除字段/替换 signals 会恢复缺省值，无关事件不使缓存失效', () => {
  const previous = c.normalizeSettings({ enabled: false, signals: { onnx: false, c2pa: false } });
  const changed = c.applySettingsChanges(previous, {
    enabled: { oldValue: false }, signals: { newValue: { exif: false } }, unknown: { newValue: 1 },
  });
  assert.equal(changed.enabled, true);
  assert.deepEqual(changed.signals, { onnx: true, c2pa: true, fileinfo: true, exif: false });
  assert.equal(previous.enabled, false); assert.equal(previous.signals.c2pa, false);
  assert.equal(c.applySettingsChanges(previous, { unknown: { newValue: 1 } }), null);
  assert.deepEqual(c.applySettingsChanges(previous, { signals: { newValue: null } }).signals, c.DEFAULTS.signals);
});

test('合法分析请求保留 URL 和布尔开关，缺省开关兼容旧发送方', () => {
  for (const url of ['https://example.test/a.jpg?q=1', 'http://127.0.0.1/a', 'file:///tmp/a.png',
    'data:image/png;base64,AAAA', 'data:image/jpg;base64,AAAA', 'blob:https://example.test/uuid']) {
    assert.deepEqual(c.normalizeAnalysisRequest({ type: c.MESSAGE.ANALYZE, url, needOnnx: false, extra: 'discard' }, c.MESSAGE.ANALYZE),
      { type: c.MESSAGE.ANALYZE, url, needOnnx: false, needMeta: true, needC2pa: true });
  }
});

test('错误载荷、危险/无效 URL、隐式布尔值在下载前拒绝', () => {
  for (const url of ['', 'no-url', 'javascript:alert(1)', 'chrome-extension://test/private',
    'data:text/html,hi', 'data:image/svg+xml,<svg/>', 'https://user:password@example.test/a',
    'blob:chrome-extension://test/id', 'blob:https://', 'blob:https://user:password@example.test/id',
    ' https://example.test/a', 'https://example.test/' + 'a'.repeat(65536)]) {
    assert.equal(c.normalizeAnalysisRequest({ type: c.MESSAGE.RUN, url }, c.MESSAGE.RUN), null, url.slice(0, 100));
  }
  for (const msg of [null, [], 'IMAGE_ANALYZE', { type: c.MESSAGE.RUN },
    { type: c.MESSAGE.RUN, url: 'https://example.test/a', needOnnx: 'false' },
    { type: c.MESSAGE.ANALYZE, url: 'https://example.test/a' }]) {
    assert.equal(c.normalizeAnalysisRequest(msg, c.MESSAGE.RUN), null);
  }
  const scoring = require('../src/shared/scoring.js');
  const result = scoring.scoreAnalysis({ ok: false, errorCode: 'image-invalid-request', error: 'invalid analysis request' });
  assert.equal(result.color, 'gray'); assert.equal(result.score, null);
  assert.equal(result.title, '图片地址或分析参数不受支持');
});

test('发送方按本扩展 id、准确页面与 tab 上下文区分', () => {
  assert.equal(c.senderRole(content, runtime), 'content');
  assert.equal(c.senderRole(background, runtime), 'background');
  assert.equal(c.senderRole(offscreen, runtime), 'offscreen');
  assert.equal(c.senderRole(ui, runtime), 'ui');
  for (const sender of [{ ...background, id: 'other' }, { ...offscreen, tab: { id: 1 } },
    { ...background, url: background.url + '?spoof=1' }, {}, null]) {
    assert.equal(c.senderRole(sender, runtime), null);
  }
});

function worker() {
  let listener;
  const routed = [];
  const ctx = vm.createContext({ AIDContracts: c, URL, setTimeout, clearTimeout,
    console: { log() {}, warn() {} }, importScripts() {},
    chrome: { runtime: { ...runtime, onMessage: { addListener: (fn) => { listener = fn; } }, onInstalled: { addListener() {} } },
      storage: { sync: { get: (_, cb) => cb({ signals: { onnx: false } }) } } },
    route: async (request) => { routed.push(request); return { ok: true }; } });
  vm.runInContext(readFileSync(new URL('../src/background.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext('askOffscreen = route', ctx);
  return { ctx, listener, routed };
}

test('后台对空消息/越权内部消息静默忽略，拒绝非法分析且不创建 offscreen', () => {
  const { listener, routed } = worker();
  let reply;
  for (const msg of [null, undefined, 'bad', { type: c.MESSAGE.RUN }, { type: c.MESSAGE.READY }]) {
    assert.doesNotThrow(() => listener(msg, content, (r) => { reply = r; }));
  }
  listener({ type: c.MESSAGE.ANALYZE, url: 'javascript:alert(1)' }, content, (r) => { reply = r; });
  assert.equal(reply.errorCode, 'image-invalid-request');
  assert.equal(routed.length, 0);
  reply = undefined;
  listener({ type: c.MESSAGE.ANALYZE, url: 'https://example.test/a' }, ui, (r) => { reply = r; });
  assert.equal(reply, undefined); assert.equal(routed.length, 0);
});

test('后台实际设置出口补齐 signals，未授权发送方读不到设置', () => {
  const { listener } = worker();
  let reply;
  listener({ type: c.MESSAGE.SETTINGS }, ui, (r) => { reply = r; });
  assert.deepEqual(reply.signals, { onnx: false, c2pa: true, fileinfo: true, exif: true });
  reply = undefined;
  listener({ type: c.MESSAGE.SETTINGS }, { ...ui, id: 'other' }, (r) => { reply = r; });
  assert.equal(reply, undefined);
});

test('后台仅转发已规范化的分析载荷', async () => {
  const { listener, routed } = worker();
  const reply = await new Promise((resolve) => listener({ type: c.MESSAGE.ANALYZE,
    url: 'https://example.test/a', needC2pa: false, injected: true }, content, resolve));
  assert.equal(reply.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(routed[0])), { type: c.MESSAGE.RUN,
    url: 'https://example.test/a', needOnnx: true, needMeta: true, needC2pa: false });
});

test('content 无法伪造就绪回执，只有 offscreen 能更新后台状态', () => {
  const { listener, ctx } = worker();
  listener({ type: c.MESSAGE.READY }, content, () => {});
  assert.equal(vm.runInContext('offscreenReady', ctx), false);
  listener({ type: c.MESSAGE.READY }, offscreen, () => {});
  assert.equal(vm.runInContext('offscreenReady', ctx), true);
});
