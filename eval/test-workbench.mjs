import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const C = require('../src/shared/contracts.js');
const W = require('../src/shared/workbench.js');
const scoring = require('../src/shared/scoring.js');
const md = require('../src/shared/metadata.js');
const runtime = { id: 'test', getURL: (p) => 'chrome-extension://test/' + p };
const workspace = { id: 'test', url: runtime.getURL(C.WORKBENCH_PATH), tab: { id: 2 } };
const content = { id: 'test', url: 'https://example.test/', tab: { id: 1 } };
const localURL = 'blob:chrome-extension://test/12345678-abcd';

test('外观与站点设置使用严格类型，集合不共享可变默认值', () => {
  const s = C.normalizeSettings({ badgeTheme: 'sun', badgeSize: 40, reduceMotion: false,
    excludedHosts: [' EXAMPLE.com ', '*.example.com', 'https://news.example.test/a', 'javascript:x', 123] });
  assert.equal(s.badgeTheme, 'sun'); assert.equal(s.badgeSize, 40); assert.equal(s.reduceMotion, false);
  assert.deepEqual(s.excludedHosts, ['example.com', 'news.example.test']);
  s.excludedHosts.push('local.test'); assert.deepEqual(C.normalizeSettings().excludedHosts, []);
  const bad = C.normalizeSettings({ badgeTheme: '__proto__', badgeSize: '40', reduceMotion: 'false', excludedHosts: 'all' });
  assert.equal(bad.badgeTheme, 'ring'); assert.equal(bad.badgeSize, 26); assert.equal(bad.reduceMotion, true);
});
test('站点暂停只匹配域名及其子域名，不误伤后缀相似域名', () => {
  assert.ok(C.isExcludedHost('media.example.com', ['example.com']));
  assert.ok(C.isExcludedHost('EXAMPLE.com', ['example.com']));
  assert.equal(C.isExcludedHost('notexample.com', ['example.com']), false);
  assert.equal(C.isExcludedHost('example.com.evil.test', ['example.com']), false);
});
test('新旧大小上限一致，本地 blob 仅能属于本扩展', () => {
  assert.equal(C.MAX_FILE_BYTES, md.ONNX_SOURCE_MAX_BYTES);
  assert.equal(C.normalizeLocalRequest({ type: C.MESSAGE.LOCAL_ANALYZE, url: localURL }, C.MESSAGE.LOCAL_ANALYZE, runtime).url, localURL);
  for (const url of ['blob:chrome-extension://other/123', 'blob:https://example.test/id', 'chrome-extension://test/key',
    'file:///secret', localURL + '?x=1', localURL + '/path', localURL + '#hash']) {
    assert.equal(C.normalizeLocalRequest({ type: C.MESSAGE.LOCAL_ANALYZE, url }, C.MESSAGE.LOCAL_ANALYZE, runtime), null);
  }
  assert.equal(C.normalizeAnalysisRequest({ type: C.MESSAGE.ANALYZE, url: localURL }, C.MESSAGE.ANALYZE), null);
  assert.equal(C.normalizeLocalRequest({ type: C.MESSAGE.LOCAL_ANALYZE, url: localURL, needMeta: 1 }, C.MESSAGE.LOCAL_ANALYZE, runtime), null);
});
test('工作台是单独角色，content 不能冒充该页面', () => {
  assert.equal(C.senderRole(workspace, runtime), 'workbench');
  assert.equal(C.senderRole(content, runtime), 'content');
  assert.equal(C.senderRole({ ...workspace, id: 'other' }, runtime), null);
  assert.equal(C.senderRole({ ...workspace, url: workspace.url + '?fake=1' }, runtime), null);
});
test('证据保持声明与模型分数分离，不把可信声明覆盖分数说成模型分数', () => {
  const result = scoring.scoreAnalysis({ onnx: { aiProbability: .05 }, meta: { provenance: { status: 'trusted', aiDisclosure: true } } });
  const out = W.evidence(result);
  assert.equal(out.decidedBy, 'verified-provenance'); assert.equal(out.score, 10);
  assert.equal(out.modelScore, 90); assert.equal(out.provenance.status, 'trusted');
  assert.deepEqual(W.evidence(out), out);
  const declared = W.evidence(scoring.scoreAnalysis({ onnx: { aiProbability: .1 }, meta: { verdict: 'red', verdictReasons: ['ComfyUI 自述'] } }));
  assert.deepEqual(W.evidence(declared).declarations, ['ComfyUI 自述']);
});
test('无效签名不变成 AI 已证实，证据字符串与列表有界', () => {
  const result = scoring.scoreAnalysis({ onnx: { aiProbability: .34 }, meta: { provenance: {
    status: 'invalid', aiDisclosure: true, issuer: '<svg onload=alert(1)>', errors: Array(30).fill('x'.repeat(1000)),
  } } });
  const out = W.evidence(result);
  assert.equal(out.color, 'green'); assert.equal(out.decidedBy, 'model');
  assert.equal(out.provenance.errors.length, 12); assert.equal(out.provenance.errors[0].length, 240);
  assert.match(out.explanation, /误判和漏判/);
});
test('导出默认不含 URL、像素或原始元数据，只包含完成的结果', () => {
  const result = scoring.scoreAnalysis({ onnx: { aiProbability: .5 } });
  const items = [{ name: 'one', kind: 'url', url: 'https://private.test/a?token=private', state: 'done', result,
    raw: 'PRIVATE_PROMPT', bytes: [1, 2], checkedAt: '2026-11-13T00:00:00Z' }, { name: 'pending', state: 'queued' }];
  const report = W.serialize(items, 'json');
  assert.equal(JSON.parse(report).results.length, 1);
  for (const privateValue of ['private.test', 'PRIVATE_PROMPT', 'bytes', 'pending']) assert.ok(!report.includes(privateValue));
  const withURL = W.serialize(items, 'json', { includeURLs: true }); assert.match(withURL, /private.test/);
});
test('即使勾选 URL，也不导出本地路径、blob、data 图片或 URL 凭据', () => {
  const result = scoring.scoreAnalysis(null);
  const items = ['file:///secret/a.jpg', localURL, 'data:image/png;base64,PRIVATE', 'https://user:pass@host/a'].map((url) => ({
    state: 'done', kind: 'url', name: 'a', url, result,
  }));
  const report = W.serialize(items, 'json', { includeURLs: true });
  for (const secret of ['secret', 'base64', 'user:pass', localURL]) assert.ok(!report.includes(secret));
});
test('CSV 对危险公式前缀、空白绕过和双引号换行进行处理', () => {
  for (const value of ['=HYPERLINK("evil")', ' +SUM(1)', '-1+2', '@A1', '\t=1', '\rtest', '\uFEFF=1', '\0=1', '\x1b=1']) {
    assert.ok(W.csvCell(value).startsWith('"\''));
  }
  assert.equal(W.csvCell('a"b\nc'), '"a""b\nc"');
  assert.throws(() => W.serialize([], 'html'), /不支持/);
});
test('官方入口固定且不夹带图片 URL 或用户参数', () => {
  assert.deepEqual(W.OFFICIAL.map((p) => p.url), ['https://openai.com/verify', 'https://synthid.com/', 'https://www.meta.ai/identification/']);
  assert.ok(Object.isFrozen(W.OFFICIAL));
});

function worker() {
  let listener, contextClick;
  const stored = {}, routed = [], tabs = [], opened = [];
  const sync = { value: C.normalizeSettings() };
  const ctx = vm.createContext({ AIDContracts: C, URL, setTimeout, clearTimeout, console: { log() {}, warn() {} }, importScripts() {},
    chrome: { runtime: { ...runtime, sendMessage: async () => {}, onMessage: { addListener: (f) => { listener = f; } }, onInstalled: { addListener() {} } },
      storage: { sync: { get: async () => sync.value }, session: { get: async () => ({ ...stored }), set: async (v) => Object.assign(stored, v) } },
      sidePanel: { open: async (v) => opened.push(v) }, tabs: { create: async (v) => tabs.push(v) },
      contextMenus: { onClicked: { addListener: (f) => { contextClick = f; } } } },
    route: async (r) => { routed.push(r); return { ok: true }; } });
  vm.runInContext(readFileSync(new URL('../src/background.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext('askOffscreen = route', ctx);
  return { ctx, listener, routed, stored, sync, tabs, opened, contextClick };
}
const message = (state, msg, sender = workspace) => new Promise((resolve) => {
  const returned = state.listener(msg, sender, resolve); if (returned !== true) resolve(undefined);
});
test('工作台载荷使用后台当时设置，content 不能走本地/手动专用接口', async () => {
  const state = worker(); state.sync.value.signals.onnx = false;
  const response = await message(state, { type: C.MESSAGE.LOCAL_ANALYZE, url: localURL, needOnnx: true });
  assert.equal(response.settingsUsed.signals.onnx, false);
  assert.equal(state.routed[0].type, C.MESSAGE.RUN_LOCAL); assert.equal(state.routed[0].needOnnx, false);
  assert.equal(await message(state, { type: C.MESSAGE.LOCAL_ANALYZE, url: localURL }, content), undefined);
  assert.equal(await message(state, { type: C.MESSAGE.TOOL_ANALYZE, url: 'https://example.test/a' }, content), undefined);
  assert.equal(state.routed.length, 1);
});
test('非法本地 URL 与全局关闭在创建 offscreen/下载前拒绝', async () => {
  const state = worker();
  assert.equal((await message(state, { type: C.MESSAGE.LOCAL_ANALYZE, url: 'blob:chrome-extension://other/abc' })).errorCode, 'image-invalid-request');
  state.sync.value.enabled = false;
  assert.equal((await message(state, { type: C.MESSAGE.TOOL_ANALYZE, url: 'https://example.test/a' })).errorCode, 'analysis-disabled');
  assert.equal(state.routed.length, 0);
});
test('右键任务并发入队不丢失，去重且消费一次，未授权页面不能读取', async () => {
  const state = worker();
  await vm.runInContext('Promise.all([enqueueTask("https://example.test/a"),enqueueTask("https://example.test/b"),enqueueTask("https://example.test/a")])', state.ctx);
  assert.equal(state.stored.workbenchTasks.length, 2);
  assert.equal(await message(state, { type: C.MESSAGE.TAKE_TASKS }, content), undefined);
  assert.equal((await message(state, { type: C.MESSAGE.TAKE_TASKS })).tasks.length, 2);
  assert.equal((await message(state, { type: C.MESSAGE.TAKE_TASKS })).tasks.length, 0);
});
test('打开侧栏失败时使用独立工作台，网页不能指定别的 tab', async () => {
  const state = worker(); state.ctx.chrome.sidePanel.open = async () => { throw Error('no gesture'); };
  await message(state, { type: C.MESSAGE.OPEN, url: 'https://example.test/a', tabId: 999 }, content);
  assert.equal(state.tabs[0].url, runtime.getURL(C.WORKBENCH_PATH));
  assert.equal(state.stored.workbenchTasks.length, 1);
});
test('多窗口任务分别消费，损坏的会话队列可恢复', async () => {
  const state = worker(); state.stored.workbenchTasks = 'corrupted';
  await vm.runInContext('enqueueTask("https://example.test/one",1)', state.ctx);
  await vm.runInContext('enqueueTask("https://example.test/two",2)', state.ctx);
  assert.equal((await message(state, { type: C.MESSAGE.TAKE_TASKS, windowId: 1 })).tasks[0].url, 'https://example.test/one');
  assert.equal(state.stored.workbenchTasks.length, 1);
  assert.equal((await message(state, { type: C.MESSAGE.TAKE_TASKS, windowId: 2 })).tasks[0].url, 'https://example.test/two');
});
