// 下载候选模型并**从各仓库自己的 config 推导**推理参数（尺寸 / 归一化 / 哪个 logit 是 AI）。
// 参数一律从原始 config 读取，不手写——手写最容易在类别顺序上出错。
//
// 用法：
//   node eval/fetch-model.mjs                 # 下载 models.json 里所有非 current 的模型
//   node eval/fetch-model.mjs smogy deepfake-v2
//   node eval/fetch-model.mjs --list

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(__dirname, 'models');
const HF = 'https://hf-mirror.com';

const AI_RE = /fake|artificial|deepfake|ai[_ -]?generated|synthetic|generated|ai\b/i;
const REAL_RE = /real|human|authentic|camera|natural|realism|photo/i;

async function fetchText(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (r.status === 404) { if (i === tries - 1) return null; throw new Error('HTTP 404'); }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 从 id2label 判断哪个下标代表「AI 生成」。
 * 判定不出来就直接抛错——宁可不跑，也不能拿反了的类别顺序出数字。
 */
function resolveAiClassIndex(id2label) {
  const entries = Object.entries(id2label);
  const ai = entries.filter(([, v]) => AI_RE.test(v));
  const real = entries.filter(([, v]) => REAL_RE.test(v));
  if (ai.length === 1 && real.length === 1) return { index: Number(ai[0][0]), reason: `label "${ai[0][1]}"` };
  if (ai.length === 1) return { index: Number(ai[0][0]), reason: `label "${ai[0][1]}" (唯一命中 AI 关键词)` };
  throw new Error(`无法从 id2label 判断 AI 类别: ${JSON.stringify(id2label)}`);
}

function resolvePreproc(pre) {
  const size = pre.size ?? {};
  const h = size.height ?? size.shortest_edge ?? 224;
  const w = size.width ?? size.shortest_edge ?? h;
  return {
    inputHeight: h,
    inputWidth: w,
    mean: pre.image_mean ?? [0.5, 0.5, 0.5],
    std: pre.image_std ?? [0.5, 0.5, 0.5],
    doCenterCrop: pre.do_center_crop === true,
    resample: pre.resample ?? null,
  };
}

async function resolveOne(key, spec) {
  const dir = path.join(MODELS_DIR, key);
  await mkdir(dir, { recursive: true });

  const cfgText = await fetchText(`${HF}/${spec.repo}/raw/main/config.json`);
  if (!cfgText) throw new Error('取不到 config.json');
  const cfg = JSON.parse(await cfgText.text());
  if (!cfg.id2label) throw new Error('config.json 缺 id2label');

  const preText = await fetchText(`${HF}/${spec.repo}/raw/main/preprocessor_config.json`);
  if (!preText) throw new Error('取不到 preprocessor_config.json');
  const pre = JSON.parse(await preText.text());

  const { index: aiClassIndex, reason } = resolveAiClassIndex(cfg.id2label);
  const pp = resolvePreproc(pre);
  if (pp.doCenterCrop) throw new Error('该模型需要 center crop，本评测台暂不支持——需要先扩展 harness 再跑');

  const onnxPath = path.join(dir, path.basename(spec.onnx));
  if (!existsSync(onnxPath)) {
    console.log(`  下载 ${spec.onnx} …`);
    const r = await fetchText(`${HF}/${spec.repo}/resolve/main/${spec.onnx.split('/').map(encodeURIComponent).join('/')}`);
    if (!r) throw new Error(`取不到 ${spec.onnx}`);
    await writeFile(onnxPath, Buffer.from(await r.arrayBuffer()));
  }
  const { size } = await import('node:fs').then((fs) => fs.promises.stat(onnxPath));

  const resolved = {
    key,
    displayName: spec.displayName,
    source: spec.repo,
    onnxRelPath: path.relative(ROOT, onnxPath),
    onnxBytes: size,
    architectures: cfg.architectures ?? null,
    id2label: cfg.id2label,
    aiClassIndex,
    aiClassReason: reason,
    ...pp,
  };
  await writeFile(path.join(dir, 'resolved.json'), JSON.stringify(resolved, null, 2));

  console.log(
    `  ✓ ${key}: ${(size / 1048576).toFixed(1)}MB | ${pp.inputWidth}×${pp.inputHeight}` +
    ` | mean ${JSON.stringify(pp.mean)} | AI 类 = logit[${aiClassIndex}] (${reason})`
  );
  return resolved;
}

async function main() {
  const registry = JSON.parse(await readFile(path.join(__dirname, 'models.json'), 'utf8'));
  const keys = Object.keys(registry).filter((k) => !k.startsWith('_') && k !== 'current');

  if (process.argv.includes('--list')) {
    for (const k of keys) console.log(k.padEnd(14), registry[k].displayName);
    return;
  }
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const todo = wanted.length ? wanted : keys;

  await mkdir(MODELS_DIR, { recursive: true });
  const failed = [];
  for (const key of todo) {
    const spec = registry[key];
    if (!spec) { console.warn(`未知模型 "${key}"（用 --list 查看）`); failed.push(key); continue; }
    console.log(`[${key}] ${spec.displayName}`);
    try { await resolveOne(key, spec); }
    catch (e) { console.error(`  ✗ ${e.message}`); failed.push(key); }
  }
  if (failed.length) { console.error(`\n失败: ${failed.join(', ')}`); process.exit(1); }
  console.log('\n完成。用 node eval/run-eval.mjs --model <key> 评测。');
}

main().catch((e) => { console.error('失败:', e); process.exit(1); });
