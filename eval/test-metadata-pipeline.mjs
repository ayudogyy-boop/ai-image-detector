// 流水线测试：验证「抓字节 → 解析 → 判定」这条**生产代码路径**。
//
// 关键设计：整条流水线放在 src/shared/metadata.js 的 analyzeUrl 里，
// 所以这里测的就是 Service Worker 实际调用的那个函数，不是我另写一遍的复刻。
//
// 两段：
//   A. Node 端直接调用 analyzeUrl（真实 HTTP + Range + 超时 + 降级）
//   B. 真实浏览器里以 classic script 加载同一个文件再跑一遍
//      —— 这等价于 Service Worker 的 importScripts 语义（把文件在全局作用域求值）
//
// 用法：node eval/test-metadata-pipeline.mjs

import http from 'node:http';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, 'data', '_pipeline');
const md = require(path.join(ROOT, 'src/shared/metadata.js'));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`); }
};

// ── 造一个带 SD 生成参数的 PNG（旧实现完全不解析 PNG，这条路径是新增的）──
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function sdPng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1024, 0); ihdr.writeUInt32BE(1024, 4); ihdr[8] = 8; ihdr[9] = 2;
  const params = 'a photo of a cat\nNegative prompt: blurry, low quality\nSteps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Model hash: a1b2c3d4';
  const text = chunk('tEXt', Buffer.concat([Buffer.from('parameters', 'latin1'), Buffer.from([0]), Buffer.from(params, 'latin1')]));
  const raw = zlib.deflateSync(Buffer.alloc(512 * (1 + 512 * 3)));
  return Buffer.concat([sig, chunk('IHDR', ihdr), text, chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0))]);
}

function barePng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = zlib.deflateSync(Buffer.alloc(64 * (1 + 64 * 3)));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', raw), chunk('IEND', Buffer.alloc(0))]);
}

// ── 支持 Range 的测试服务器：这样才能验证「只抓 512KB」确实生效 ──
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };
function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const buf = await readFile(p);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : buf.length - 1;
          const slice = buf.subarray(start, Math.min(end + 1, buf.length));
          res.writeHead(206, {
            'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
            'Content-Range': `bytes ${start}-${start + slice.length - 1}/${buf.length}`,
            'Content-Length': slice.length,
          });
          res.end(slice);
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Length': buf.length });
      res.end(buf);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function main() {
  await mkdir(TMP, { recursive: true });
  await writeFile(path.join(TMP, 'sd-params.png'), sdPng());

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('\n════ A. Node 端调用同一份生产代码 analyzeUrl ════');

    console.log('\n--- 相机签名照片（C2PA + EXIF）---');
    const nikon = await md.analyzeUrl(`${base}/test-c2pa/camera-nikon.jpg`);
    check('ok = true', nikon.ok === true, nikon.reason);
    check('容器 = jpeg', nikon.container === 'jpeg', nikon.container);
    check('读到尺寸（旧实现 64KB 窗口读不到）', nikon.width > 0 && nikon.height > 0, [nikon.width, nikon.height]);
    check('EXIF Make = NIKON CORPORATION', nikon.exif?.make === 'NIKON CORPORATION', nikon.exif?.make);
    check('C2PA 存在', nikon.c2pa?.hasC2PA === true);
    check('仅解析文件头不判 green', nikon.verdict === null, nikon.verdict);
    check('相机信息仅展示，不伪造判定依据', nikon.verdictReasons.length === 0 && nikon.cameraEvidence, nikon.verdictReasons);
    check('抓取被限制在 512KB 内', nikon.bytesInspected <= 524288, nikon.bytesInspected);
    console.log(`      依据 ${JSON.stringify(nikon.verdictReasons)} | 读取 ${(nikon.bytesInspected / 1024).toFixed(0)}KB`);

    console.log('\n--- SD 生成的 PNG ---');
    const sd = await md.analyzeUrl(`${base}/eval/data/_pipeline/sd-params.png`);
    check('容器 = png', sd.container === 'png', sd.container);
    check('读到 PNG 文本块 parameters', sd.pngTextKeys.includes('parameters'), sd.pngTextKeys);
    check('判定 red', sd.verdict === 'red', sd.verdict);
    check('依据指出命中 SD 参数', sd.verdictReasons.some((r) => r.includes('SD')), sd.verdictReasons);

    console.log('\n--- 真相机照片：相机 EXIF 只作为加权信号，不再单独下结论 ---');
    const adobe = await md.analyzeUrl(`${base}/test-c2pa/adobe-test.jpg`);
    check('相机 EXIF 不再单独判 green（改为 cameraEvidence）', adobe.verdict === null, adobe.verdict);
    check('cameraEvidence = true', adobe.cameraEvidence === true);
    check('仍带出 EXIF 供展示', !!adobe.exif, adobe.exif);
    console.log(`      依据 ${JSON.stringify(adobe.verdictReasons)} | cameraEvidence=${adobe.cameraEvidence}`);

    console.log('\n--- 无任何确定性证据时应不下结论 ---');
    await writeFile(path.join(TMP, 'bare.png'), barePng());
    const bare = await md.analyzeUrl(`${base}/eval/data/_pipeline/bare.png`);
    check('verdict = null（交回原有融合逻辑）', bare.verdict === null, bare.verdict);
    check('ok 仍为 true', bare.ok === true);

    console.log('\n--- 降级：抓不到字节不能抛异常 ---');
    const missing = await md.analyzeUrl(`${base}/nope.jpg`);
    check('返回 ok=false', missing.ok === false, missing);
    check('c2pa 仍有默认值', missing.c2pa?.hasC2PA === false);

    console.log('\n--- 降级：超时 ---');
    const t0 = Date.now();
    const timedOut = await md.analyzeUrl(`${base}/test-c2pa/camera-nikon.jpg`, {
      timeoutMs: 1,
      fetchImpl: (u, o) => new Promise((_, rej) => { o.signal?.addEventListener('abort', () => rej(new Error('aborted'))); }),
    });
    check('超时后返回 ok=false', timedOut.ok === false, timedOut);
    check('超时确实生效（<2s）', Date.now() - t0 < 2000, Date.now() - t0);

    console.log('\n════ B. 真实浏览器里以 classic script 加载同一个文件 ════');
    console.log('     （等价于 Service Worker 的 importScripts 语义）');
    const html = '<!doctype html><meta charset="utf-8"><script src="/src/shared/metadata.js"><\/script>';
    await writeFile(path.join(TMP, 'harness.html'), html);

    const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
    if (!chrome) throw new Error('找不到 Chrome');
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
      const page = await browser.newPage();
      page.on('pageerror', (e) => console.log('     [page error]', e.message));
      await page.goto(`${base}/eval/data/_pipeline/harness.html`, { waitUntil: 'load' });

      const shape = await page.evaluate(() => ({
        isObject: typeof self.AIDMetadata === 'object' && self.AIDMetadata !== null,
        hasAnalyzeUrl: typeof self.AIDMetadata?.analyzeUrl === 'function',
        hasJudge: typeof self.AIDMetadata?.judgeMetadata === 'function',
        headerBytes: self.AIDMetadata?.RECOMMENDED_HEADER_BYTES,
      }));
      check('AIDMetadata 挂在全局（浏览器里同样成立）', shape.isObject, shape);
      check('analyzeUrl 可用', shape.hasAnalyzeUrl);
      check('judgeMetadata 可用', shape.hasJudge);
      check('RECOMMENDED_HEADER_BYTES = 512KB', shape.headerBytes === 524288, shape.headerBytes);

      const bNikon = await page.evaluate((u) => self.AIDMetadata.analyzeUrl(u), `${base}/test-c2pa/camera-nikon.jpg`);
      check('浏览器内：相机声明不能证明真实', bNikon?.verdict === null, bNikon?.verdict);
      check('浏览器内：读到尺寸', bNikon?.width > 0 && bNikon?.height > 0, [bNikon?.width, bNikon?.height]);
      check('浏览器内：C2PA 检测到', bNikon?.c2pa?.hasC2PA === true);

      const bSd = await page.evaluate((u) => self.AIDMetadata.analyzeUrl(u), `${base}/eval/data/_pipeline/sd-params.png`);
      check('浏览器内：SD PNG → red', bSd?.verdict === 'red', bSd?.verdict);

      await page.close();
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    server.close();
    await rm(TMP, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('流水线测试失败:', e); process.exit(1); });
