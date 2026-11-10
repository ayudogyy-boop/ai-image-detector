// AI Image Detector — 离线评测（支持可插拔模型）
//
// 复刻线上路径：
//   1. 真实浏览器画布做预处理（与 src/offscreen/offscreen.js 的 runInference 同构）
//   2. 同一个 ort 运行时、同样 numThreads=1
//   3. 同样的分数映射  score = clamp(100*(1-p) - 5, 5, 90)
//   4. 同样的 combineScores 融合（含 c2pa 缺失时的中性权重）
// 模型的输入尺寸 / 归一化 / 哪个 logit 是 AI 一律从该模型自己的 config 读取，不写死。
//
// 用法：
//   node eval/run-eval.mjs                      # 评测当前线上模型
//   node eval/run-eval.mjs --model smogy        # 评测单个候选
//   node eval/run-eval.mjs --model all          # 依次评测全部候选并输出对比表
//   node eval/run-eval.mjs --limit 40           # 冒烟测试
//
// 依赖：puppeteer-core（项目已装）+ 系统 Google Chrome。不新增任何依赖。

import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_DIR = path.join(__dirname, 'results');
const MODELS_DIR = path.join(__dirname, 'models');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}
const LIMIT = Number(arg('limit', 0));
const MODEL_ARG = arg('model', 'current');
const OUT_TAG = arg('out', '');

// ───────────── 直接引用生产代码（不要再复制一份）─────────────
// 2026-10 审查 P1-5：这里以前是 content.js 的**复制品**，而且已经落后于线上
// （缺确定性判定层、缺 camera 信号），于是评测数字不能代表用户看到的行为。
// 现在评分与融合统一从 src/shared/scoring.js 引入 —— 与 content script 用的是同一个文件；
// 元数据解析与判定统一从 src/shared/metadata.js 引入 —— 与 offscreen 文档用的是同一个文件。
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const scoring = require(path.join(ROOT, 'src/shared/scoring.js'));

const onnxScoreFromProbability = scoring.onnxScoreFromProbability;

// ───────────── 指标 ─────────────

function auc(pos, neg) {
  const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]);
  let rankSum = 0, i = 0, rank = 1;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const avgRank = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k++) if (all[k][1] === 1) rankSum += avgRank;
    rank += j - i + 1;
    i = j + 1;
  }
  const n1 = pos.length, n0 = neg.length;
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

function bestThreshold(pos, neg) {
  const cands = [...new Set([...pos, ...neg])].sort((a, b) => a - b);
  let best = { t: 0.5, j: -Infinity, acc: 0, tpr: 0, fpr: 0 };
  for (const t of cands) {
    const tpr = pos.filter((v) => v > t).length / pos.length;
    const fpr = neg.filter((v) => v > t).length / neg.length;
    const j = tpr - fpr;
    const acc = (pos.filter((v) => v > t).length + neg.filter((v) => v <= t).length) / (pos.length + neg.length);
    if (j > best.j) best = { t, j, acc, tpr, fpr };
  }
  return best;
}

// ───────────── 模型登记表 ─────────────

async function loadModels() {
  const registry = JSON.parse(await readFile(path.join(__dirname, 'models.json'), 'utf8'));
  const out = {};
  for (const [key, spec] of Object.entries(registry)) {
    if (key.startsWith('_')) continue;
    let resolved;
    if (spec.resolved) {
      resolved = spec.resolved;
      resolved.onnxRelPath = spec.localPath;
    } else {
      const p = path.join(MODELS_DIR, key, 'resolved.json');
      if (!existsSync(p)) continue; // 还没下载
      resolved = JSON.parse(await readFile(p, 'utf8'));
    }
    out[key] = { key, displayName: spec.displayName, source: spec.source, ...resolved };
  }
  return out;
}

// ───────────── 静态服务器 ─────────────

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
      if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const buf = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
      });
      res.end(buf);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ───────────── 单模型评测 ─────────────

async function evalOneModel(page, port, model, items) {
  const modelPath = path.join(ROOT, model.onnxRelPath);
  const modelSha = createHash('sha256').update(await readFile(modelPath)).digest('hex');
  const cfg = {
    modelUrl: `/${model.onnxRelPath.split(path.sep).join('/')}`,
    inputWidth: model.inputWidth,
    inputHeight: model.inputHeight,
    mean: model.mean,
    std: model.std,
    aiClassIndex: model.aiClassIndex,
  };

  console.log(`\n▶ ${model.displayName}`);
  console.log(`  ${(await import('node:fs')).statSync(modelPath).size / 1048576 | 0}MB | ${cfg.inputWidth}×${cfg.inputHeight} | AI=logit[${cfg.aiClassIndex}] | sha ${modelSha.slice(0, 12)}…`);

  // 图优化级别逐级降级重试：fp16 模型在 'all' 下会因 SimplifiedLayerNormFusion
  // 找不到 InsertedPrecisionFreeCast 的输入名而加载失败（ORT-web 1.27 实测）。
  const tLoad = Date.now();
  let usedLevel = null, lastError = null;
  for (const level of ['all', 'basic', 'disabled']) {
    await page.evaluate((c) => window.__setup(c), { ...cfg, graphOptimizationLevel: level });
    await page.waitForFunction('window.__state.ready === true || window.__state.error !== null', { timeout: 180000 });
    const st = await page.evaluate(() => window.__state);
    if (!st.error) { usedLevel = level; lastError = null; break; }
    lastError = st.error;
    console.warn(`  ⚠ graphOptimizationLevel=${level} 加载失败: ${String(st.error).slice(0, 160)}`);
  }
  if (!usedLevel) throw new Error(`三种图优化级别都无法加载模型: ${String(lastError).slice(0, 200)}`);
  const st = await page.evaluate(() => window.__state);
  if (usedLevel !== 'all') console.warn(`  ℹ 该模型需要 graphOptimizationLevel=${usedLevel} 才能加载（性能会受影响）`);
  console.log(`  模型加载 ${((Date.now() - tLoad) / 1000).toFixed(1)}s | 输入 "${st.inputName}" 输出 "${st.outputName}" | 图优化=${usedLevel}`);

  const results = [];
  let n = 0;
  for (const item of items) {
    const url = `/eval/data/${item.file.split(path.sep).join('/')}`;
    try {
      const r = await page.evaluate((u) => window.__infer(u), url);
      const onnxScore = onnxScoreFromProbability(r.aiProbability);

      // 浏览器复用完整元数据/验签路径，最后由生产评分唯一入口决策。
      const meta = r.meta;
      const det = scoring.deterministicVerdict(meta)?.verdict || null;
      const combined = scoring.scoreAnalysis({ onnx: { aiProbability: r.aiProbability }, meta }, { sensitivity: 'medium' });

      results.push({
        file: item.file, label: item.label,
        aiProbability: r.aiProbability, onnxScore,
        extScore: combined.score, extColor: combined.color, decidedBy: combined.decidedBy,
        verdict: det, reasons: meta ? meta.verdictReasons : [],
        cameraEvidence: !!(meta && meta.cameraEvidence),
        container: meta ? meta.container : null,
        ms: r.ms,
      });
    } catch (e) {
      results.push({ file: item.file, label: item.label, error: String(e.message).slice(0, 120) });
    }
    if (++n % 50 === 0) process.stdout.write(`  … ${n}/${items.length}\n`);
  }
  return { model, modelSha, results };
}

function summarize(model, modelSha, results, datasetMeta) {
  const ok = results.filter((r) => !r.error);
  const ai = ok.filter((r) => r.label === 'ai');
  const real = ok.filter((r) => r.label === 'real');
  const pAi = ai.map((r) => r.aiProbability);
  const pReal = real.map((r) => r.aiProbability);

  const aucVal = auc(pAi, pReal);
  const y = bestThreshold(pAi, pReal);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  const colorCount = (arr, c) => arr.filter((r) => r.extColor === c).length;
  const falsePos = colorCount(real, 'red');
  const falseNeg = colorCount(ai, 'green');
  const realUncertain = colorCount(real, 'yellow');
  const aiUncertain = colorCount(ai, 'yellow');
  const decided = ok.filter((r) => r.extColor !== 'yellow');
  const decidedCorrect = decided.filter((r) => (r.label === 'ai') === (r.extColor === 'red')).length;

  return {
    generatedAt: new Date().toISOString(),
    model: {
      key: model.key, displayName: model.displayName, source: model.source,
      sha256: modelSha, inputWidth: model.inputWidth, inputHeight: model.inputHeight,
      mean: model.mean, std: model.std, aiClassIndex: model.aiClassIndex,
      aiClassReason: model.aiClassReason ?? null,
    },
    dataset: datasetMeta,
    rawModel: {
      auc: Number(aucVal.toFixed(4)),
      bestThreshold: {
        threshold: Number(y.t.toFixed(4)), youdenJ: Number(y.j.toFixed(4)),
        accuracy: Number(y.acc.toFixed(4)), tpr: Number(y.tpr.toFixed(4)), fpr: Number(y.fpr.toFixed(4)),
      },
      medianProbability: {
        ai: Number(pAi.slice().sort((a, b) => a - b)[Math.floor(pAi.length / 2)].toFixed(4)),
        real: Number(pReal.slice().sort((a, b) => a - b)[Math.floor(pReal.length / 2)].toFixed(4)),
      },
    },
    extensionEndToEnd: {
      note: 'scoreAnalysis：离线C2PA验签 + 未验签声明分层 + 模型估计；固定区间（红<40 黄40–60 绿>60）',
      falsePositiveRate: falsePos / real.length,
      falseNegativeRate: falseNeg / ai.length,
      uncertainRateReal: realUncertain / real.length,
      uncertainRateAi: aiUncertain / ai.length,
      decidedCount: decided.length,
      decidedAccuracy: decided.length ? decidedCorrect / decided.length : null,
      colors: {
        real: { green: colorCount(real, 'green'), yellow: realUncertain, red: falsePos },
        ai: { green: falseNeg, yellow: aiUncertain, red: colorCount(ai, 'red') },
      },
    },
    latencyMs: {
      median: Math.round(times[Math.floor(times.length / 2)]),
      p95: Math.round(times[Math.floor(times.length * 0.95)]),
    },
    items: ok,
    errors: results.filter((r) => r.error),
  };
}

// ───────────── 主流程 ─────────────

async function main() {
  if (!existsSync(path.join(DATA_DIR, 'manifest.json'))) {
    throw new Error('缺少 eval/data/manifest.json —— 先跑 node eval/fetch-dataset.mjs');
  }
  const manifest = JSON.parse(await readFile(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
  let items = manifest.items;
  if (LIMIT > 0) {
    const per = Math.max(1, Math.floor(LIMIT / 2));
    items = [
      ...items.filter((i) => i.label === 'ai').slice(0, per),
      ...items.filter((i) => i.label === 'real').slice(0, per),
    ];
  }
  const datasetMeta = {
    repo: manifest.repo,
    counts: { ai: items.filter((i) => i.label === 'ai').length, real: items.filter((i) => i.label === 'real').length },
    caveat: manifest.caveat,
  };

  const models = await loadModels();
  const keys = MODEL_ARG === 'all'
    ? Object.keys(models)
    : MODEL_ARG.split(',').map((s) => s.trim()).filter(Boolean);
  for (const k of keys) if (!models[k]) throw new Error(`未知模型 "${k}"。可用: ${Object.keys(models).join(', ')}`);

  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) throw new Error('找不到可用的 Chrome');

  console.log(`样本 ${items.length} 张（ai ${datasetMeta.counts.ai} / real ${datasetMeta.counts.real}）`);
  console.log(`Chrome: ${chrome}`);
  console.log(`待评模型: ${keys.join(', ')}`);

  const server = await startServer();
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  await mkdir(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const summaries = [];
  const failures = [];

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.warn('  [page error]', e.message));
    await page.goto(`http://127.0.0.1:${port}/eval/harness.html`, { waitUntil: 'load' });

    for (const key of keys) {
      try {
        const { model, modelSha, results } = await evalOneModel(page, port, models[key], items);
        const summary = summarize(model, modelSha, results, datasetMeta);
        summaries.push(summary);
        const suffix = OUT_TAG ? `${key}-${OUT_TAG}` : key;
        await writeFile(path.join(RESULTS_DIR, `${suffix}-${stamp}.json`), JSON.stringify(summary, null, 2));
      } catch (err) {
        // 单个模型失败不应中断整批对比（fp16 曾在 ORT 里加载失败，整轮结果全丢）
        failures.push({ key, error: String((err && err.message) || err).slice(0, 200) });
        console.error(`  ✗ ${key} 评测失败: ${String((err && err.message) || err).slice(0, 200)}`);
      }
    }
    await page.close();
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  // ── 汇总 ──
  const line = '─'.repeat(88);
  const n0 = summaries.length ? summaries[0].items.length : (items.length || 0);
  console.log(`\n${line}\n对比结果（n = ${n0}，AI ${datasetMeta.counts.ai} / 真实 ${datasetMeta.counts.real}）\n${line}`);
  console.log('模型'.padEnd(30) + 'AUC'.padStart(7) + '最优阈值'.padStart(10) + '误报'.padStart(8) + '漏报'.padStart(8) + '弃权'.padStart(8) + '中位延迟'.padStart(10));
  for (const s of summaries) {
    const e = s.extensionEndToEnd;
    const abstain = (e.uncertainRateReal + e.uncertainRateAi) / 2;
    console.log(
      s.model.key.padEnd(30) +
      s.rawModel.auc.toFixed(4).padStart(7) +
      (s.rawModel.bestThreshold.accuracy * 100).toFixed(1).padStart(9) + '%' +
      (e.falsePositiveRate * 100).toFixed(1).padStart(7) + '%' +
      (e.falseNegativeRate * 100).toFixed(1).padStart(7) + '%' +
      (abstain * 100).toFixed(1).padStart(7) + '%' +
      String(s.latencyMs.median).padStart(9) + 'ms'
    );
  }
  if (failures.length) {
    console.log(`\n⚠ ${failures.length} 个模型未能评测:`);
    for (const f of failures) console.log(`  - ${f.key}: ${f.error}`);
  }
  if (summaries.length > 1) {
    await writeFile(path.join(RESULTS_DIR, `compare-${stamp}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), summaries, failures }, null, 2));
  }
  console.log(`\n结果已写入 ${RESULTS_DIR}/${stamp}*`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error('评测失败:', e); process.exit(1); });
