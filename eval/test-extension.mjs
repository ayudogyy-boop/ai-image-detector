// AI Image Detector — 真机端到端测试（把扩展真的装进 Chrome 跑一遍）
//
// 为什么要有这个文件：
//   项目原来的 CLAUDE.md 写着"本机没有 Chrome for Testing，所以无法自动验证扩展加载"，
//   于是 background.js / content.js 这两个最容易出问题的文件**完全没有自动化覆盖**。
//   实测发现：puppeteer-core 25 的 `enableExtensions` + `pipe: true` 可以直接加载未打包扩展，
//   不需要 Chrome for Testing（本机 Chrome 155 验证通过）。这个文件就是那条路径。
//
// 覆盖的都是"装起来才会暴露"的问题：
//   ① 扩展能否加载、Service Worker 能否注册（2026-10 审查发现 build.sh 漏拷文件导致整包报废）
//   ② offscreen 文档能否创建、模型能否推理
//   ③ SW 内存态丢失后能否自愈（旧实现在这里会永久卡死 30s 并返回 null）
//   ④ 一张图到底被下载了几次
//   ⑤ showOnHover=false 时不得自动分析
//   ⑥ 扫描器是否会收敛（旧实现每 500ms 全文档扫一次，永不停止）
//   ⑦ 悬停是否真的出徽章
//
// 用法：node eval/test-extension.mjs [--ext /path/to/unpacked] [--headed]
// 依赖：puppeteer-core（已装）+ 系统 Google Chrome。不新增依赖。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const EXT_DIR = path.resolve(arg('ext', ROOT));

// 跨平台查找 Chrome：本地 macOS / Linux CI（GitHub Actions 自带 Chrome）/ 自定义路径
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

// Linux 容器/CI 里 Chrome 的沙箱常不可用，需要显式关掉（仅 Linux 生效）
const LAUNCH_ARGS = ['--no-first-run', '--no-default-browser-check',
  ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])];

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 本地站点：只放两张真实可解码的图，并记录每一次请求 ──────────────
const requests = [];
let responseDelay = 0;
const SITE_FILES = {
  '/': { ct: 'text/html', body: Buffer.from('<!doctype html><meta charset="utf-8"><body style="margin:0"><img id="a" src="real.jpg" width="600"><img id="b" src="ai.jpg" width="600"></body>') },
  '/sdk-valid.jpg': { ct: 'image/jpeg', file: 'test-c2pa/sdk-c.jpg' },
  '/signed.jpg': { ct: 'image/jpeg', file: 'test-c2pa/camera-nikon.jpg' },
  '/tampered.jpg': { ct: 'image/jpeg', file: 'test-c2pa/camera-nikon.jpg', tamper: true },
  '/forged.jpg': { ct: 'image/jpeg', file: 'test-c2pa/adobe-test.jpg', forge: true },
  '/real.jpg': { ct: 'image/jpeg', file: 'test-c2pa/adobe-test.jpg' },
  // 名称沿用旧测试路由；仅验证可解码与交互，不以它判断检测准确率。
  '/ai.jpg': { ct: 'image/jpeg', file: 'test-c2pa/camera-truepic.jpg' },
};
const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  const entry = SITE_FILES[u];
  requests.push({ url: u, range: req.headers.range || null });
  if (u === '/denied.jpg') { res.writeHead(403).end('denied'); return; }
  if (!entry) { res.writeHead(404).end('nf'); return; }
  try {
    let buf = entry.file ? await readFile(path.join(ROOT, entry.file)) : entry.body;
    if (entry.tamper) { const sos = buf.indexOf(Buffer.from([0xff, 0xda])); if (sos >= 0) buf[sos + 30] ^= 1; }
    if (entry.forge) { const payload = Buffer.from('jumb Adobe Firefly'); const seg = Buffer.alloc(payload.length + 4); seg[0] = 255; seg[1] = 226; seg.writeUInt16BE(payload.length + 2, 2); payload.copy(seg, 4); buf = Buffer.concat([buf.subarray(0, 2), seg, buf.subarray(2)]); }
    if (responseDelay) await sleep(responseDelay);
    res.writeHead(200, { 'Content-Type': entry.ct, 'Content-Length': buf.length });
    res.end(buf);
  } catch { res.writeHead(500).end('fixture unavailable'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) { console.error('找不到 Chrome，无法运行端到端测试'); process.exit(2); }

console.log(`扩展目录: ${EXT_DIR}`);
console.log(`Chrome:   ${chromePath}\n`);

let browser;
try {
browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: !process.argv.includes('--headed'),
  pipe: true,
  args: LAUNCH_ARGS,
  enableExtensions: [EXT_DIR],
});

  // ── ① 加载与 SW 注册 ────────────────────────────────────────────
  console.log('① 扩展加载 & Service Worker');
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 })
    .catch(() => null);
  check('Service Worker 已注册', !!swTarget, browser.targets().map((t) => t.type() + ' ' + t.url().slice(0, 60)));
  if (!swTarget) throw new Error('SW 未注册，后续测试无法进行');
  const sw = await swTarget.worker();
  const swEnv = await sw.evaluate(async () => {
    // 用 DEFAULTS 做 get()：这是 content script 真正依赖的契约——缺键时返回默认值。
    // （不要直接 get(null) 断言"存储已写入"：onInstalled 的写盘是异步的，会偶发抢跑。）
    const s = await chrome.storage.sync.get(DEFAULTS);
    return {
      sensitivity: s && s.sensitivity,
      hasSignals: !!(s && s.signals && typeof s.signals.onnx === 'boolean'),
      hasAskOffscreen: typeof askOffscreen === 'function',
      hasEnsureOffscreen: typeof ensureOffscreen === 'function',
    };
  });
  check('SW 缺键时能返回完整默认设置（content script 依赖的契约）',
    swEnv.sensitivity === 'medium' && swEnv.hasSignals, swEnv);
  check('SW 的路由函数已定义', swEnv.hasAskOffscreen && swEnv.hasEnsureOffscreen, swEnv);

  // 真正的 options 页面必须与后台读到相同的部分设置，而非沿用 HTML 默认勾选。
  const options = await browser.newPage();
  const extensionBase = `chrome-extension://${new URL(swTarget.url()).host}`;
  await sw.evaluate(async () => chrome.storage.sync.set({ signals: { onnx: false }, enabled: 'false', hoverDelay: -1 }));
  await options.goto(`${extensionBase}/src/options/options.html`, { waitUntil: 'load' });
  const optionState = await options.evaluate(async () => {
    await load();
    const settings = await chrome.runtime.sendMessage({ type: AIDContracts.MESSAGE.SETTINGS });
    return { settings, enabled: document.getElementById('s-enabled').checked,
      onnx: document.getElementById('sig-onnx').checked, c2pa: document.getElementById('sig-c2pa').checked,
      delay: document.getElementById('s-hoverDelay').value };
  });
  check('实际设置页与后台统一修复旧版/损坏设置', optionState.enabled && !optionState.onnx && optionState.c2pa &&
    optionState.delay === '3000' && optionState.settings.signals.exif === true && optionState.settings.enabled === true, optionState);
  await options.evaluate(async () => {
    document.getElementById('s-hoverDelay').value = '500';
    document.getElementById('sig-exif').checked = false;
    await save();
  });
  const saved = await sw.evaluate(async () => chrome.storage.sync.get(DEFAULTS));
  check('实际设置页保存规范布尔值与延时，不丢失其他 signals', saved.enabled === true && saved.hoverDelay === 500 &&
    saved.signals.onnx === false && saved.signals.exif === false && saved.signals.c2pa === true, saved);
  await options.evaluate(async () => reset());
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: true }));
  await options.goto(`${extensionBase}/src/popup/popup.html`, { waitUntil: 'load' });
  await options.waitForFunction(() => document.getElementById('toggle-enabled').checked);
  check('真实 popup 使用同一设置契约并显示运行版本', await options.$eval('.version',
    (el) => el.textContent === 'v' + chrome.runtime.getManifest().version));
  await options.click('label.toggle');
  await options.waitForFunction(async () => (await chrome.storage.sync.get('enabled')).enabled === false);
  check('真实 popup 开关可写回共享设置', true);
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: true }));
  await options.close();

  // ── ② offscreen + 推理 ─────────────────────────────────────────
  console.log('\n② offscreen 文档 & 冷启动推理');
  const cold = await sw.evaluate(async (u) => {
    const t0 = Date.now();
    const r = await new Promise((resolve) => {
      askOffscreen({ type: 'IMAGE_ANALYZE', url: u, needOnnx: true, needMeta: true })
        .then(resolve);
      setTimeout(() => resolve({ __timeout: true }), 60000);
    });
    return { ms: Date.now() - t0, r };
  }, `${BASE}/real.jpg`);
  check('冷启动能出结果', !!(cold.r && cold.r.onnx && cold.r.onnx.aiProbability !== undefined), cold.r);
  check('冷启动在 20s 内完成', cold.ms < 20000, cold.ms);
  check('同一次请求同时拿到元数据结论', !!(cold.r && cold.r.meta), cold.r && cold.r.meta);
  console.log(`      冷启动 ${cold.ms}ms | p(AI)=${cold.r?.onnx?.aiProbability?.toFixed(3)} | 容器=${cold.r?.meta?.container}`);

  const offTarget = browser.targets().find((t) => t.url().includes('offscreen.html'));
  check('offscreen 文档存在', !!offTarget);

  // ── ③ SW 内存态丢失后的自愈 ─────────────────────────────────────
  console.log('\n③ SW 内存态丢失后自愈（旧实现在这里会永久卡死）');
  const recover = await sw.evaluate(async (u) => {
    offscreenReady = false;   // 模拟 Chrome 回收 SW 后重启的世界线
    initPromise = null;
    const t0 = Date.now();
    const r = await new Promise((resolve) => {
      askOffscreen({ type: 'IMAGE_ANALYZE', url: u, needOnnx: true, needMeta: false }).then(resolve);
      setTimeout(() => resolve({ __timeout: true }), 20000);
    });
    return { ms: Date.now() - t0, ok: !!(r && r.onnx), ready: offscreenReady };
  }, `${BASE}/real.jpg`);
  check('模型就绪状态丢失后仍能拿到结果', recover.ok, recover);
  // 旧实现在这里固定等 30s 然后返回 null；阈值取 10s 足以区分"自愈"与"卡死"
  check('自愈耗时 < 10s（旧实现固定 30s 后返回 null）', recover.ms < 10000, recover.ms);
  console.log(`      自愈耗时 ${recover.ms}ms`);

  const ping = await sw.evaluate(async () => {
    const ok = await pingOffscreen(2000);
    return { ok, ready: offscreenReady };
  });
  check('主动 ping 探针生效', ping.ok === true, ping);

  // ── 离线签名校验：真实文件、篡改文件和伪造关键词 ──────────────
  console.log('\n③b 本地 C2PA 验签');
  const credentials = {};
  for (const name of ['sdk-valid', 'signed', 'tampered', 'forged']) {
    credentials[name] = await sw.evaluate((url) => askOffscreen({ type: 'IMAGE_ANALYZE', url, needOnnx: false, needMeta: true, needC2pa: true }), `${BASE}/${name}.jpg`);
    console.log(`      ${name}: ${JSON.stringify(credentials[name]?.meta?.provenance)}`);
  }
  check('官方 SDK 正向样本签名有效，但测试签发方未受信任', credentials['sdk-valid']?.meta?.provenance?.status === 'valid', credentials['sdk-valid']);
  check('algorithmicMedia 普通程序生成不等同 AI 生成', credentials['sdk-valid']?.meta?.provenance?.aiDisclosure === false);
  check('真实 C2PA 由本地 SDK 返回验证状态', ['trusted', 'valid', 'invalid'].includes(credentials.signed?.meta?.provenance?.status), credentials.signed);
  check('篡改像素使签名校验失败', credentials.tampered?.meta?.provenance?.status === 'invalid', credentials.tampered);
  check('篡改引入资产哈希错误，原图没有该错误', credentials.tampered?.meta?.provenance?.errors?.includes('assertion.dataHash.mismatch') && !credentials.signed?.meta?.provenance?.errors?.includes('assertion.dataHash.mismatch'));
  check('伪造品牌关键词不能获得有效签名', !['trusted', 'valid'].includes(credentials.forged?.meta?.provenance?.status), credentials.forged);
  check('伪造品牌关键词不能直接给出 AI 结论', !credentials.forged?.meta?.verdict, credentials.forged?.meta);

  // ── 强制 worker 故障：真实 SDK 初始化与运行时均不能卡死队列 ───
  console.log('\n③c C2PA worker 故障注入与恢复');
  await sw.evaluate(async () => {
    await chrome.offscreen.closeDocument(); offscreenReady = false;
    if (!await ensureOffscreen()) throw new Error('offscreen restart failed');
  });
  const freshOff = browser.targets().find((t) => t.url().includes('offscreen.html') && t !== offTarget);
  const offCDP = await freshOff.createCDPSession();
  await offCDP.send('Runtime.evaluate', { expression: `
    self.__nativeWorker = self.Worker;
    self.__c2paWorkers = [];
    self.__failC2paStartup = true;
    self.Worker = class extends self.__nativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes('/c2pa_worker.js')) {
          self.__c2paWorkers.push(this);
          if (self.__failC2paStartup) this.terminate();
        }
      }
    };
  ` });
  const analyzeSigned = () => sw.evaluate((url) => askOffscreen({ type: 'IMAGE_ANALYZE', url,
    needOnnx: true, needMeta: true, needC2pa: true }), `${BASE}/sdk-valid.jpg`);
  const failedInit = await analyzeSigned();
  check('worker 初始化无回应时超时降级，模型仍返回', failedInit?.meta?.provenance?.status === 'unavailable'
    && /timeout/.test(failedInit.meta.provenance.error) && !!failedInit.onnx, failedInit?.meta?.provenance);
  await offCDP.send('Runtime.evaluate', { expression: 'self.__failC2paStartup = false' });
  check('初始化失败后下一次验签能恢复', (await analyzeSigned())?.meta?.provenance?.status === 'valid');
  await offCDP.send('Runtime.evaluate', { expression: 'self.__c2paWorkers.at(-1).terminate()' });
  const stalled = await Promise.all([analyzeSigned(), analyzeSigned(),
    sw.evaluate((url) => askOffscreen({ type: 'IMAGE_ANALYZE', url, needOnnx: true, needMeta: false }), `${BASE}/real.jpg`)]);
  check('已初始化 worker 突然终止，两项验签都能超时降级', stalled.slice(0, 2).every((r) =>
    r?.meta?.provenance?.status === 'unavailable' && /timeout/.test(r.meta.provenance.error)), stalled.slice(0, 2).map((r) => r?.meta?.provenance));
  check('验签故障不丢失模型结论，排队的普通图片继续处理', stalled.every((r) => !!r?.onnx));
  check('运行时被终止后可重建 worker 并再次验签', (await analyzeSigned())?.meta?.provenance?.status === 'valid');
  await offCDP.send('Runtime.evaluate', { expression: 'self.Worker = self.__nativeWorker' });

  console.log('\n③d ONNX 首次加载失败后的真实恢复');
  const modelFailure = await offCDP.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    await session.release(); session = null;
    self.__originalFetch = self.fetch; self.__modelFetches = 0;
    self.fetch = (...args) => {
      if (String(args[0]).endsWith('/models/detector.onnx') && ++self.__modelFetches === 1) {
        return Promise.reject(new TypeError('injected transient model fetch failure'));
      }
      return self.__originalFetch(...args);
    };
    await init();
    return { ready: initialized, modelReady: !!session, errorCode: loadErrorCode };
  })()` });
  check('确实复现了文档就绪但模型首次加载失败', modelFailure.result.value?.ready === true
    && modelFailure.result.value?.modelReady === false && modelFailure.result.value?.errorCode === 'model-load-failed', modelFailure);
  const recoveredModel = await sw.evaluate((url) => askOffscreen({ type: 'IMAGE_ANALYZE', url, needOnnx: true, needMeta: true, needC2pa: false }), `${BASE}/real.jpg`);
  check('同一文档收到图片请求后自动重载模型并返回真实推理', Number.isFinite(recoveredModel?.onnx?.aiProbability), recoveredModel);
  const modelReload = await offCDP.send('Runtime.evaluate', { returnByValue: true, expression: '({ fetches: self.__modelFetches, ready: !!session })' });
  check('首次失败与恢复只加载两次，没有无限重建', modelReload.result.value?.fetches === 2 && modelReload.result.value?.ready === true, modelReload);
  await offCDP.send('Runtime.evaluate', { expression: 'self.fetch = self.__originalFetch' });
  const denied = await sw.evaluate((url) => askOffscreen({ type: 'IMAGE_ANALYZE', url, needOnnx: true, needMeta: true, needC2pa: false }), `${BASE}/denied.jpg`);
  check('真实 HTTP 403 保留图片读取阶段和状态码', denied?.onnxErrorCode === 'image-http-error' && denied.fetchError?.status === 403, denied);
  await offCDP.detach();

  // ── ④ 下载次数 ─────────────────────────────────────────────────
  console.log('\n④ 每张图下载次数');
  requests.length = 0;
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await sleep(3000);
  const pageLoadReq = requests.filter((r) => r.url === '/real.jpg').length;
  check('仅页面自身加载时只请求一次', pageLoadReq === 1, requests.map((r) => r.url + (r.range ? ' [range]' : '')));

  // ── ⑤ showOnHover=false 不得自动分析 ────────────────────────────
  console.log('\n⑤ 关闭悬停检测后不得自动分析');
  await sw.evaluate(async () => { await chrome.storage.sync.set({ showOnHover: false, showOnMobile: false }); });
  requests.length = 0;
  const page2 = await browser.newPage();
  const logs2 = [];                       // [{ txt, t }]
  page2.on('console', (m) => logs2.push({ txt: m.text(), t: Date.now() }));
  const page2Start = Date.now();
  await page2.goto(`${BASE}/`, { waitUntil: 'load' });
  await sleep(10000);                     // 观察窗口：10s
  const txt2 = logs2.map((x) => x.txt);
  check('没有发起任何分析', txt2.filter((l) => l.includes('[AID] analyze')).length === 0, txt2.filter((l) => l.includes('[AID]')));
  check('没有产生额外图片下载', requests.filter((r) => r.url.endsWith('.jpg')).length === 2, requests);
  check('没有出现"已分析"标记', (await page2.evaluate(() => document.querySelectorAll('img[data-aid-processed]').length)) === 0);

  // ── ⑥ 扫描器收敛 ───────────────────────────────────────────────
  // 旧实现的症状是"每 500ms 一条日志、永不停止"（实测 10s 内 20 条）。
  // 只看总量会被页面加载初期的正常突发干扰，所以再加一条**尾部静默**判据：
  // 最后 4 秒必须一条都没有 —— 这才是"收敛了"。
  console.log('\n⑥ 扫描器是否会停下来');
  const scanLogs = logs2.filter((x) => x.txt.includes('scan: attached'));
  const tailStart = page2Start + 10000 - 4000;
  const tailScan = scanLogs.filter((x) => x.t > tailStart);
  check('10s 内扫描日志 ≤ 6 条（旧实现固定每 500ms 一条，实测 20 条）', scanLogs.length <= 6, scanLogs.length);
  check('最后 4s 内没有任何扫描日志（已收敛）', tailScan.length === 0, tailScan.map((x) => x.txt));

  // ── ⑦ 悬停出徽章 ───────────────────────────────────────────────
  console.log('\n⑦ 悬停出徽章');
  await sw.evaluate(async () => { await chrome.storage.sync.set({ showOnHover: true, hoverDelay: 500 }); });
  const page3 = await browser.newPage();
  await page3.setViewport({ width: 1200, height: 900 });
  const logs3 = [];
  page3.on('console', (m) => logs3.push(m.text()));
  await page3.goto(`${BASE}/`, { waitUntil: 'load' });
  for (let i = 0; i < 40 && !logs3.some((l) => l.includes('[AID] active on')); i++) await sleep(250);
  requests.length = 0;                                  // 只统计"悬停之后"新增的下载
  const box = await page3.$eval('#a', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  // 轮询而不是固定等待：机器被 build/其他任务占满时，固定 sleep 会偶发失败。
  // 到 5s 还没出来就重新悬停一次（真实用户也会这么做）。
  let badges = [];
  for (let i = 0; i < 30; i++) {
    await page3.mouse.move(box.x - 80, box.y - 80);
    await page3.mouse.move(box.x, box.y);
    await sleep(500);
    badges = await page3.evaluate(() => [...document.querySelectorAll('.aid-badge')].map((b) => ({ cls: b.className, txt: b.textContent.slice(0, 40) })));
    if (badges.length) break;
  }
  check('悬停后出现徽章', badges.length === 1, badges);
  check('徽章带颜色类名', badges[0] && /aid-badge-(green|yellow|red)/.test(badges[0].cls), badges[0]);
  // 旧实现：SW 抓 512KB（Range）+ offscreen 再抓整图 = 一张图被下载两次
  const hoverDownloads = requests.filter((r) => r.url === '/real.jpg');
  check('一次分析只额外下载 1 次（不是 2 次）', hoverDownloads.length === 1, hoverDownloads);
  console.log(`      悬停后该图请求：${JSON.stringify(hoverDownloads)}`);

  // ── ⑧ 重复悬停、徽章点击、换源与真正的 popup 接口 ────────────
  console.log('\n⑧ 交互回归与汇总');
  async function leave(page) { await page.mouse.move(1100, 850); await sleep(100); }
  async function hover(page, id = '#a') {
    await leave(page);
    const point = await page.$eval(id, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(point.x, point.y);
    await page.waitForSelector('.aid-badge', { timeout: 15000 });
  }
  await leave(page3);
  check('离开图片后隐藏徽章', await page3.$('.aid-badge') === null);
  await hover(page3);
  check('同一图片再次悬停可查看缓存徽章', await page3.$('.aid-badge') !== null);
  check('重复查看不重复下载', requests.filter((r) => r.url === '/real.jpg').length === 1);
  await page3.click('.aid-badge');
  check('移动到徽章并点击可打开证据详情', await page3.$eval('.aid-badge', (b) => b.lastElementChild.style.display === 'block'));

  // 多个测试页面的 URL 相同，汇总消息必须发给 page3 对应的 tab。
  await page3.evaluate(() => { document.title = 'AID summary target'; });
  const summaryForPage3 = async () => sw.evaluate(async () => {
    const tab = (await chrome.tabs.query({})).find((t) => t.title === 'AID summary target');
    return (await chrome.tabs.sendMessage(tab.id, { type: 'GET_SUMMARY' })).summary;
  });
  let summary = await summaryForPage3();
  check('真实汇总接口的总数等于各颜色之和', summary.total === 1 && summary.total === summary.green + summary.yellow + summary.red, summary);

  await leave(page3);
  await page3.evaluate(() => {
    const duplicate = document.querySelector('#a').cloneNode();
    // 页面正常 cloneNode 会复制扩展属性，却不会复制扩展的事件监听器。
    duplicate.id = 'duplicate';
    duplicate.style.cssText = 'position:absolute;left:650px;top:0;width:300px'; document.body.append(duplicate);
  });
  await hover(page3, '#duplicate');
  summary = await summaryForPage3();
  check('保留所有扩展标记的克隆图片仍可悬停并独立统计', summary.total === 2 && summary.total === summary.green + summary.yellow + summary.red, summary);
  await page3.evaluate(() => document.querySelector('#duplicate').remove());
  summary = await summaryForPage3();
  check('移除图片后汇总不保留幽灵记录', summary.total === 1, summary);

  await leave(page3);
  await page3.evaluate(() => new Promise((resolve) => {
    const img = document.querySelector('#a'); img.addEventListener('load', resolve, { once: true }); img.src = 'ai.jpg';
  }));
  check('图片换源清除旧结果标记', !await page3.$eval('#a', (el) => el.hasAttribute('data-aid-processed')));
  requests.length = 0;
  await hover(page3);
  check('换源后可分析新图片', requests.filter((r) => r.url === '/ai.jpg').length === 1, requests);

  // ── ⑨ 初始禁用后开启、设置变更和可见性恢复 ──────────────────
  console.log('\n⑨ 设置与扫描恢复');
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: false }));
  const page4 = await browser.newPage();
  await page4.setViewport({ width: 1200, height: 900 });
  await page4.goto(BASE + '/');
  await sleep(500);
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: true }));
  await hover(page4);
  check('初始关闭后开启，无需刷新即可检测', await page4.$('.aid-badge') !== null);
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: false }));
  await sleep(100);
  check('关闭扩展立即隐藏现有徽章', await page4.$('.aid-badge') === null);
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: true }));
  await page4.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const img = new Image(); img.id = 'after-visible'; img.src = 'real.jpg'; img.width = 100; document.body.append(img);
  });
  await sleep(300);
  await page4.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page4.waitForSelector('#after-visible[data-aid-ready]', { timeout: 3000 });
  check('页面从隐藏恢复可见后继续扫描', true);

  // 延迟本地图片响应，用真实消息链路检查异步结果过期。
  responseDelay = 1000;
  await sw.evaluate(() => chrome.storage.sync.set({ sensitivity: 'low' }));
  await leave(page4);
  const point = await page4.$eval('#a', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + 100, y: r.y + 100 }; });
  requests.length = 0;
  await page4.mouse.move(point.x, point.y);
  for (let i = 0; i < 30 && !requests.some((r) => r.url === '/real.jpg'); i++) await sleep(100);
  check('异步回归检查确实发起图片请求', requests.some((r) => r.url === '/real.jpg'));
  await leave(page4);
  await sleep(1800);
  check('分析期间移开鼠标，完成后不冒出过期徽章', await page4.$('.aid-badge') === null);
  await hover(page4);
  await sw.evaluate(() => chrome.storage.sync.set({ sensitivity: 'high' }));
  await sleep(100);
  check('修改设置立即隐藏旧徽章', await page4.$('.aid-badge') === null);

  // 通过真实 content → SW → 评分 → 徽章链路检查指定颜色边界。
  console.log('\n⑩ 固定 40/60 颜色区间');
  responseDelay = 0;
  await sw.evaluate(() => {
    self.__aidOriginalAsk = askOffscreen;
    askOffscreen = (payload) => {
      const value = new URL(payload.url).searchParams.get('scorecase');
      if (value === null) return self.__aidOriginalAsk(payload);
      const score = Number(value);
      return Promise.resolve({ ok: true, onnx: { aiProbability: (95 - score) / 100 },
        meta: score < 40 ? { verdict: 'red', verdictReasons: ['PNG parameters(SD)'] } : {} });
    };
  });
  try {
    for (const [score, color] of [[35, 'red'], [39, 'red'], [40, 'yellow'], [60, 'yellow'], [61, 'green']]) {
      await leave(page4);
      await page4.evaluate((score) => new Promise((resolve) => {
        const img = document.querySelector('#a');
        img.addEventListener('load', resolve, { once: true });
        img.src = `real.jpg?scorecase=${score}`;
      }), score);
      await hover(page4);
      const badge = await page4.$eval('.aid-badge', (el) => ({ color: el.className, score: el.firstChild.textContent }));
      check(`${score} 分显示 ${color}，低分不被来源声明改黄`, badge.color.includes(`aid-badge-${color}`) && badge.score === String(score), badge);
    }
    console.log('\n⑪ 失败徽章、失败缓存与再次悬停恢复');
    await sw.evaluate(() => {
      self.__failureCalls = 0;
      const colorTestAsk = askOffscreen;
      askOffscreen = (payload) => {
        if (!new URL(payload.url).searchParams.has('retrycase')) return colorTestAsk(payload);
        if (++self.__failureCalls === 1) return Promise.resolve({ ok: true, meta: { ok: true, container: 'jpeg' },
          onnxErrorCode: 'model-inference-failed', onnxError: 'injected runtime failure <img src=x>' });
        return Promise.resolve({ ok: true, meta: { ok: true }, onnx: { aiProbability: .99 } });
      };
    });
    await leave(page4);
    await page4.evaluate(() => new Promise((resolve) => {
      const img = document.querySelector('#a'); img.addEventListener('load', resolve, { once: true });
      img.src = 'real.jpg?retrycase=1'; document.title = 'AID failure target';
    }));
    await hover(page4);
    const unavailable = await page4.$eval('.aid-badge', (el) => ({ cls: el.className, label: el.firstChild.textContent, detail: el.lastElementChild.textContent, injectedImages: el.querySelectorAll('img').length }));
    check('模型失败显示灰色空结果，不再显示黄色问号', unavailable.cls.includes('aid-badge-gray') && unavailable.label === '—', unavailable);
    check('具体错误和版本可见，来自错误的 HTML 被转义', unavailable.detail.includes('模型推理失败') && unavailable.detail.includes('injected runtime failure <img src=x>')
      && unavailable.detail.includes('扩展版本') && unavailable.injectedImages === 0, unavailable);
    const failedSummary = await sw.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find((t) => t.title === 'AID failure target');
      return (await chrome.tabs.sendMessage(tab.id, { type: 'GET_SUMMARY' })).summary;
    });
    check('未完成图片独立统计，不计入黄色', failedSummary.unavailable === 1 && failedSummary.yellow === 0, failedSummary);
    await hover(page4);
    const retried = await page4.$eval('.aid-badge', (el) => ({ cls: el.className, label: el.firstChild.textContent }));
    check('再次悬停真实发起重试，恢复红色分数而非命中失败缓存', retried.cls.includes('aid-badge-red') && retried.label === '5'
      && await sw.evaluate(() => self.__failureCalls) === 2, retried);
  } finally {
    await sw.evaluate(() => { askOffscreen = self.__aidOriginalAsk; });
  }
} catch (err) {
  fail++;
  console.error('\n测试异常中止:', err && err.message ? err.message : err);
} finally {
  await browser?.close().catch(() => {});
  server.close();
}

console.log(`\n${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
