// 实际 Chrome 验证：本地 blob、文件/拖拽、队列、导出、皮肤与菜单处理链路。
// 合成 PNG 仅是工程夹具，不作为识别准确率样本。
import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--ext');
const EXT = path.resolve(index < 0 ? ROOT : process.argv[index + 1]);
const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
const chromePath = candidates.find(existsSync);
if (!chromePath) throw Error('找不到 Chrome');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) { if (ok) { pass++; console.log('  ✓ ' + name); } else { fail++; console.error('  ✗ ' + name, detail ?? ''); } }
function crc32(buf) { let n = 0xffffffff; for (const b of buf) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(name, body) { const type = Buffer.from(name), head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(body.length); tail.writeUInt32BE(crc32(Buffer.concat([type, body]))); return Buffer.concat([head, type, body, tail]); }
function png(label = false) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const i = y * 193 + 1 + x * 3; pixels[i] = x * 4; pixels[i + 1] = y * 4; pixels[i + 2] = 150; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
    ...(label ? [chunk('tEXt', Buffer.from('Software\0ComfyUI'))] : []), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const folder = await mkdtemp(path.join(os.tmpdir(), 'aid-workbench-test-'));
const downloadDir = path.join(folder, 'downloads'); await mkdir(downloadDir);
const names = ['local.png', '=1+1.png', '<svg onload=alert(1)>.png'];
for (const name of names) await writeFile(path.join(folder, name), png(true));
const requests = []; let imageDelay = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><body style="background:#edf3fb;padding:45px"><h1>本地功能测试样本（不是准确率样本）</h1><img id="a" src="a.png" width="300" height="300"><img id="b" src="b.png" width="300" height="300"></body>'); return; }
  if (['/a.png', '/b.png'].includes(url.pathname)) {
    requests.push(url.pathname); if (imageDelay) await sleep(imageDelay);
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(png(url.pathname === '/a.png')); return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
let browser;
const deadline = setTimeout(() => { console.error('工作台测试超出 120 秒，终止浏览器'); void browser?.close(); }, 120000);
try {
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, pipe: true,
    args: ['--no-first-run', '--no-default-browser-check', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])], enableExtensions: [EXT] });
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/src/background.js'), { timeout: 30000 });
  const sw = await swTarget.worker(), extensionBase = `chrome-extension://${new URL(swTarget.url()).host}`;
  await sw.evaluate(async () => chrome.storage.sync.set({ ...AIDContracts.normalizeSettings(), showOnMobile: false, hoverDelay: 500 }));
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  check('工作台入口与菜单/侧栏权限存在，没有语音权限', manifest.permissions.includes('sidePanel') && manifest.permissions.includes('contextMenus') && !manifest.permissions.includes('tts') && manifest.side_panel.default_path === 'src/workbench/index.html');
  const screenshots = path.join(ROOT, 'build/artifacts/workbench-preview'); await mkdir(screenshots, { recursive: true });
  if (await sw.evaluate(() => typeof chrome.action.openPopup === 'function')) {
    const nativeSource = await browser.newPage(); await nativeSource.goto(BASE, { waitUntil: 'networkidle0' }); await nativeSource.bringToFront();
    await sw.evaluate(() => chrome.action.openPopup());
    const popupTarget = await browser.waitForTarget((t) => t.url() === extensionBase + '/src/popup/popup.html').catch(() => { throw Error('原生工具栏弹窗未打开'); });
    const popupCDP = await popupTarget.createCDPSession();
    let button;
    for (let i = 0; i < 50; i++) {
      const r = await popupCDP.send('Runtime.evaluate', { expression: 'document.getElementById("toggle-enabled")?.checked && document.querySelectorAll(".summary-stat").length===5 ? (()=>{const r=document.getElementById("open-workbench").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})() : null', returnByValue: true });
      button = r.result.value; if (button) break; await sleep(100);
    }
    if (!button) throw Error('实际工具栏弹窗未就绪');
    await sleep(150);
    await popupCDP.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...button, button: 'left', clickCount: 1 });
    await popupCDP.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...button, button: 'left', clickCount: 1 });
    const panelTarget = await browser.waitForTarget((t) => t.url() === extensionBase + '/src/workbench/index.html', { timeout: 10000 }).catch(() => { throw Error('原生弹窗点击未打开工作台'); });
    const panelCDP = await panelTarget.createCDPSession();
    const native = await sw.evaluate(async (url) => !(await chrome.tabs.query({})).some((t) => t.url === url), extensionBase + '/src/workbench/index.html');
    check('真实工具栏弹窗鼠标点击打开原生侧栏，不是普通标签页', native);
    let root;
    for (let i = 0; i < 50; i++) {
      const state = await panelCDP.send('Runtime.evaluate', { expression: 'typeof settings!=="undefined" && !!document.getElementById("files")', returnByValue: true });
      if (state.result.value) { root = (await panelCDP.send('DOM.getDocument')).root.nodeId; break; } await sleep(100);
    }
    if (!root) throw Error('原生侧栏界面未就绪');
    const node = await panelCDP.send('DOM.querySelector', { nodeId: root, selector: '#files' });
    await panelCDP.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path.join(folder, names[0])] });
    await panelCDP.send('Runtime.evaluate', { expression: 'document.getElementById("start").click()', userGesture: true });
    let nativeResult;
    for (let i = 0; i < 150; i++) {
      const state = await panelCDP.send('Runtime.evaluate', { expression: '!running && items.length===1 && items[0].state==="done" ? items[0].result : null', returnByValue: true });
      nativeResult = state.result.value; if (nativeResult) break; await sleep(100);
    }
    check('原生侧栏本地文件实际推理并展示证据', nativeResult?.modelStatus === 'available' && nativeResult.declarations.length > 0, nativeResult);
    const layout = await panelCDP.send('Page.getLayoutMetrics');
    const bounds = layout.cssContentSize;
    const screenshot = await panelCDP.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: bounds.width, height: bounds.height, scale: 1 } });
    await writeFile(path.join(screenshots, 'native-sidepanel.png'), Buffer.from(screenshot.data, 'base64'));
    check('原生侧栏可生成实际界面截图', screenshot.data.length > 1000);
    await sw.evaluate(async () => { await chrome.sidePanel.setOptions({ enabled: false }); await chrome.sidePanel.setOptions({ enabled: true }); });
    await nativeSource.close();
  } else console.log('  原生弹窗自动化需 Chrome 127+；当前版本仍继续验证独立工作台');
  const wb = await browser.newPage(); await wb.setViewport({ width: 1100, height: 1000 });
  await wb.goto(extensionBase + '/src/workbench/index.html', { waitUntil: 'networkidle0' });
  await wb.waitForFunction(() => document.getElementById('version').textContent.includes(chrome.runtime.getManifest().version));
  check('实际工作台加载共享契约和空状态', await wb.$eval('#start', (x) => x.disabled) && await wb.$eval('#progress', (x) => x.textContent.includes('0 张')));
  const failedRequests = [];
  wb.on('request', (req) => { if (/^https?:/.test(req.url()) && !req.url().startsWith(BASE)) failedRequests.push(req.url()); });
  if (!await sw.evaluate(() => ensureOffscreen())) throw Error('分析文档未就绪');
  const offscreenTarget = browser.targets().find((t) => t.url().endsWith('/src/offscreen/offscreen.html'));
  if (!offscreenTarget) throw Error('找不到实际分析文档');
  const offscreenNetwork = await offscreenTarget.createCDPSession();
  await offscreenNetwork.send('Network.enable');
  offscreenNetwork.on('Network.requestWillBeSent', ({ request }) => {
    if (/^https?:/.test(request.url) && !request.url.startsWith(BASE)) failedRequests.push(request.url);
  });
  await wb.evaluate(() => {
    const original = URL.createObjectURL; window.__testBlobURLs = [];
    URL.createObjectURL = function (value) { const url = original.call(URL, value); window.__testBlobURLs.push(url); return url; };
  });
  const input = await wb.$('#files'); await input.uploadFile(...names.map((n) => path.join(folder, n)));
  await wb.waitForFunction(() => document.querySelectorAll('.task').length === 3);
  check('多文件加入队列，不提前分析', await wb.evaluate(() => items.every((x) => x.state === 'queued')));
  await wb.click('#start');
  await wb.waitForFunction(() => !running && items.length === 3 && items.every((x) => x.state === 'done'), { timeout: 60000 });
  const local = await wb.evaluate(() => items.map((x) => ({ result: x.result, blobURL: x.blobURL })));
  check('本地原始文件经真实模型完成分析', local.every((x) => x.result.modelStatus === 'available'), local);
  check('本地 PNG 自述被保留为未验签证据', local.every((x) => x.result.declarations.some((s) => /ComfyUI/.test(s))), local);
  check('文件名按文本展示，不执行标签', await wb.evaluate(() => !document.querySelector('#task-list svg') && document.getElementById('task-list').textContent.includes('<svg')));
  check('本地分析没有对检测平台发 HTTP 请求', failedRequests.length === 0, failedRequests);
  check('分析后临时 blob URL 均释放', await wb.evaluate(async () => {
    const urls = window.__testBlobURLs.slice(); return items.every((x) => x.blobURL === null) && (await Promise.all(urls.map((u) => fetch(u).then(() => false, () => true)))).every(Boolean);
  }));
  check('工作台证据保持模型分数与声明说明', await wb.$eval('#evidence', (x) => x.textContent.includes('不是“真实概率”') && x.textContent.includes('文件来源自述')));
  const official = await wb.$$eval('.official a', (links) => links.map((a) => ({ url: a.href, rel: a.rel, policy: a.referrerPolicy })));
  check('官方核验入口固定、不带图片参数并禁止引荐信息', official.length === 3 && official.every((a) => !new URL(a.url).search && a.rel.includes('noreferrer') && a.policy === 'no-referrer'));
  const cdp = await wb.createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  async function downloaded(ext) {
    for (let i = 0; i < 100; i++) { const f = (await readdir(downloadDir)).find((name) => name.endsWith('.' + ext)); if (f) return readFile(path.join(downloadDir, f), 'utf8'); await sleep(50); }
    throw Error('报告未实际下载：' + ext);
  }
  await wb.click('#export-json'); const report = JSON.parse(await downloaded('json'));
  check('JSON 报告实际下载，默认不含 URL/像素/完整元数据', report.results.length === 3 && report.results.every((x) => !('url' in x) && x.declarations.length > 0) && !JSON.stringify(report).includes('pngText'));
  await wb.click('#export-csv'); const csv = await downloaded('csv');
  check('CSV 实际下载且保护公式文件名', csv.includes("'=1+1.png") && csv.includes('模型分数'));
  await wb.click('.task'); const beforeRetry = await wb.evaluate(() => items[0].checkedAt);
  await wb.click('#evidence button');
  await wb.waitForFunction((previous) => !running && items[0].checkedAt !== previous, { timeout: 30000 }, beforeRetry);
  check('本地文件可真正重试，结果列表不重复增长', await wb.evaluate(() => items.length === 3 && items[0].state === 'done'));
  await wb.click('#clear');
  await wb.evaluate(async (bytes) => {
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], 'drop.png', { type: 'image/png' }));
    document.getElementById('drop-zone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [...png(true)]);
  await wb.waitForFunction(() => items.length === 1);
  await wb.click('#start'); await wb.waitForFunction(() => !running && items[0]?.state === 'done', { timeout: 30000 });
  check('真实 DOM 拖拽事件可加入并检测文件', await wb.evaluate(() => items[0].name === 'drop.png' && items[0].result.modelStatus === 'available'));
  await wb.click('#clear');
  const page = await browser.newPage(); await page.setViewport({ width: 1100, height: 900 }); await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#a[data-aid-ready]', { timeout: 10000 });
  await page.bringToFront(); await wb.evaluate(() => collectPage());
  await wb.waitForFunction(() => items.length === 2);
  check('当前页图片列表经过真实 content 消息返回，等待用户开始', await wb.evaluate(() => items.every((x) => x.state === 'queued' && x.kind === 'url')));
  await wb.bringToFront();
  await wb.click('#clear'); await wb.evaluate(() => refreshTabs());
  const sourceTabId = await sw.evaluate(async (base) => (await chrome.tabs.query({})).find((x) => x.url === base + '/').id, BASE);
  await wb.select('#source-tab', String(sourceTabId)); await wb.click('#collect-page');
  await wb.waitForFunction(() => items.length === 2);
  check('独立工作台可明确选择网页后列出图片', true);
  imageDelay = 1200; requests.length = 0;
  await wb.click('#start'); await wb.waitForFunction(() => items[0].state === 'running'); await wb.click('#stop');
  await wb.waitForFunction(() => !running, { timeout: 30000 });
  check('停止后续任务，不继续下载下一张图片', requests.length === 1 && await wb.evaluate(() => items[0].state === 'done' && items[1].state === 'queued'), requests);
  imageDelay = 0; await wb.click('#start'); await wb.waitForFunction(() => !running && items.every((x) => x.state === 'done'), { timeout: 30000 });
  check('停止后可继续完成剩余任务', await wb.evaluate(() => items.length === 2 && items.every((x) => x.state === 'done')));
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: false }));
  await wb.waitForFunction(() => document.getElementById('start').disabled);
  const disabled = await wb.evaluate(() => chrome.runtime.sendMessage({ type: AIDContracts.MESSAGE.TOOL_ANALYZE, url: 'https://example.test/no-fetch' }));
  check('全局关闭时后台阻止手动网络分析', disabled.errorCode === 'analysis-disabled');
  await sw.evaluate(() => chrome.storage.sync.set({ enabled: true }));
  const options = await browser.newPage(); await options.goto(extensionBase + '/src/options/options.html', { waitUntil: 'networkidle0' });
  await options.evaluate(async () => { await load(); document.getElementById('s-badgeTheme').value = 'petals'; document.getElementById('s-badgeSize').value = '40'; await save(); });
  await page.bringToFront();
  const point = await page.$eval('#a', (x) => { const r = x.getBoundingClientRect(); return { x: r.x + 100, y: r.y + 100 }; });
  await page.mouse.move(point.x, point.y); await page.waitForSelector('.aid-badge', { timeout: 30000 });
  const petals = await page.$eval('.aid-badge', (x) => ({ theme: x.dataset.theme, text: x.firstChild.textContent, color: x.className, width: x.getBoundingClientRect().width, parts: x.querySelector('.aid-decoration').children.length }));
  check('设置页保存花瓣与尺寸，真实徽章显示八瓣', petals.theme === 'petals' && petals.width === 40 && petals.parts === 8, petals);
  requests.length = 0;
  await sw.evaluate(() => chrome.storage.sync.set({ badgeTheme: 'sun' }));
  await page.waitForFunction(() => document.querySelector('.aid-badge')?.dataset.theme === 'sun');
  const sun = await page.$eval('.aid-badge', (x) => ({ text: x.firstChild.textContent, color: x.className, parts: x.querySelector('.aid-decoration').children.length }));
  check('太阳十二光芒保留原分数和状态，不重新下载分析', sun.parts === 12 && sun.text === petals.text && sun.color === petals.color && requests.length === 0, sun);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await sw.evaluate(() => chrome.storage.sync.set({ reduceMotion: false }));
  await sleep(100);
  check('系统减少动态效果覆盖动画设置', await page.$eval('.aid-decoration', (x) => getComputedStyle(x).animationName === 'none'));
  await sw.evaluate(() => chrome.storage.sync.set({ excludedHosts: ['127.0.0.1'] })); await sleep(150);
  await page.mouse.move(1000, 800); await page.mouse.move(point.x, point.y); await sleep(900);
  check('暂停域名立即隐藏徽章并阻止自动检测', !await page.$('.aid-badge'));
  await sw.evaluate(() => chrome.storage.sync.set({ excludedHosts: [], reduceMotion: true }));
  await page.mouse.move(1000, 800); await page.mouse.move(point.x, point.y); await page.waitForSelector('.aid-badge', { visible: true, timeout: 30000 });
  check('移除暂停域名后恢复悬停检测', !!await page.$('.aid-badge'));
  await page.screenshot({ path: path.join(screenshots, 'sun-badge.png') });
  await wb.bringToFront(); await wb.screenshot({ path: path.join(screenshots, 'workbench.png'), fullPage: true });
  await wb.setViewport({ width: 1280, height: 800 });
  await wb.screenshot({ path: path.join(screenshots, 'store-workbench-1280x800.png') });
  await wb.close(); await options.close();
  const menu = await sw.evaluate(async (url) => {
    await handleImageContextMenu({ menuItemId: 'aid-inspect-image', srcUrl: url }, { id: -1 });
    return true;
  }, BASE + '/a.png?menu=1');
  check('实际菜单处理函数完成侧栏/独立页打开与入队', menu);
  const menuTarget = await browser.waitForTarget((t) => t.url() === extensionBase + '/src/workbench/index.html', { timeout: 15000 });
  const menuPage = await menuTarget.page();
  if (!menuPage) throw Error('工作台未成为可检查的页面');
  await menuPage.waitForFunction(() => items.length === 1 && items[0].state === 'done', { timeout: 30000 });
  check('右键任务由工作台消费并真实分析一次', await menuPage.evaluate(() => items[0].url.includes('menu=1') && items[0].result.modelStatus === 'available'));
  const pending = await sw.evaluate(async () => (await chrome.storage.session.get('workbenchTasks')).workbenchTasks);
  check('右键任务消费后从会话队列移除', pending.length === 0);
} catch (error) { fail++; console.error('工作台测试中止:', error.stack || error); }
finally { clearTimeout(deadline); await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
console.log(`\n${pass} 通过 / ${fail} 失败\n`); process.exitCode = fail ? 1 : 0;
