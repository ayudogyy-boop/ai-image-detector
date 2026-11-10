// 下载带标签的 AI / 真实 图片，落盘到 eval/data/{ai,real}/
// 数据源：HuggingFace 数据集 Hemg/AI-Generated-vs-Real-Images-Datasets
//   AiArtData/AiArtData/  → AI 生成（539 张）
//   RealArt/RealArt/      → 真实照片（436 张）
// 走 hf-mirror.com（本机 huggingface.co 不通，github.com 也不通）
//
// 用法：node eval/fetch-dataset.mjs [--per-class 120] [--force]

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'Hemg/AI-Generated-vs-Real-Images-Datasets';
const HF = 'https://hf-mirror.com';
const MIRROR = `${HF}/datasets/${REPO}`;
const TREE_URL = `${HF}/api/datasets/${REPO}/tree/main?recursive=true`;
const DATA_DIR = path.join(__dirname, 'data');

const CLASSES = [
  { label: 'ai', dir: 'AiArtData/AiArtData/' },
  { label: 'real', dir: 'RealArt/RealArt/' },
];

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}
const PER_CLASS = Number(arg('per-class', 120));
const FORCE = process.argv.includes('--force');

/** 均匀抽样：按路径排序后等距取，避免只拿到字母序靠前的文件 */
function sampleEvenly(items, n) {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

function safeName(p) {
  // 源文件名可能以 '.' 或 '-' 开头（例如抓站时留下的 .amazonaws.com2F...），
  // 去掉前导符号以免产出隐藏文件或让 CLI 误当日志
  return path.basename(p).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.\-]+/, '').slice(-80) || 'image';
}

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      // hf-mirror 偶尔会对正常请求返回瞬时 404，所以 404 也重试，只有最后一次才认作真缺失
      if (r.status === 404) {
        if (i === tries - 1) return null;
        throw new Error('HTTP 404 (retrying)');
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  console.log(`数据源: ${REPO}`);
  console.log(`目标:   ${DATA_DIR}  (每类 ${PER_CLASS} 张)`);

  const treeBuf = await fetchWithRetry(TREE_URL, 5);
  if (!treeBuf) throw new Error('无法获取数据集文件列表：hf-mirror 持续返回 404');
  const tree = JSON.parse(treeBuf.toString());
  const files = tree.filter((f) => f.type === 'file');

  const manifest = [];
  for (const { label, dir } of CLASSES) {
    const pool = files
      .filter((f) => f.path.startsWith(dir) && /\.(jpe?g|png|webp)$/i.test(f.path))
      .map((f) => f.path)
      .sort();
    const picked = sampleEvenly(pool, PER_CLASS);
    const outDir = path.join(DATA_DIR, label);
    await mkdir(outDir, { recursive: true });
    console.log(`\n[${label}] 候选 ${pool.length} → 抽 ${picked.length}`);

    let done = 0;
    const CONCURRENCY = 6;
    let cursor = 0;
    async function worker() {
      while (cursor < picked.length) {
        const p = picked[cursor++];
        const name = safeName(p);
        const dest = path.join(outDir, name);
        try {
          let buf;
          if (!FORCE && existsSync(dest)) {
            buf = await readFile(dest);
          } else {
            const url = `${MIRROR}/resolve/main/${p.split('/').map(encodeURIComponent).join('/')}`;
            buf = await fetchWithRetry(url);
            if (!buf) { console.warn(`  ✗ 404 ${p.slice(0, 60)}`); continue; }
            await writeFile(dest, buf);
          }
          manifest.push({
            file: path.relative(DATA_DIR, dest),
            label,
            bytes: buf.length,
            sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
            sourcePath: p,
          });
          if (++done % 20 === 0) console.log(`  … ${done}/${picked.length}`);
        } catch (e) {
          console.warn(`  ✗ ${name}: ${e.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`  ✓ ${label}: ${done} 张`);
  }

  // 只保留真正落盘的条目
  const kept = [];
  for (const m of manifest) if (existsSync(path.join(DATA_DIR, m.file))) kept.push(m);
  kept.sort((a, b) => a.file.localeCompare(b.file));

  const byLabel = kept.reduce((acc, m) => ((acc[m.label] = (acc[m.label] || 0) + 1), acc), {});
  await writeFile(
    path.join(DATA_DIR, 'manifest.json'),
    JSON.stringify(
      {
        repo: REPO,
        mirror: MIRROR,
        fetchedAt: new Date().toISOString(),
        counts: byLabel,
        totalBytes: kept.reduce((a, m) => a + m.bytes, 0),
        // 重要的局限：这批图是 2022–2023 年代的生成器（Midjourney v4 / SD 1.x），
        // 与模型训练集同源，因此结果偏乐观，不能代表 2025+ 的生成器。
        caveat: 'generators are 2022-2023 era (Midjourney v4 / SD1.x), same vintage as the model training set',
        items: kept,
      },
      null,
      2
    )
  );

  console.log(`\n完成：${JSON.stringify(byLabel)}  共 ${(kept.reduce((a, m) => a + m.bytes, 0) / 1048576).toFixed(1)} MB`);
  console.log(`清单：${path.join(DATA_DIR, 'manifest.json')}`);
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
