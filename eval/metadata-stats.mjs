// 统计评测集里有多少图带着「来源自述（未验签）」——用来判断元数据层的实际价值。
//
// 这些证据是生成器自己写进文件里的（PNG tEXt/iTXt、EXIF Software、XMP CreatorTool、C2PA），
// 与视觉模型无关；命中仅表示文件自述，不证明来源或真实性。
//
// 用法：node eval/metadata-stats.mjs

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const md = require(path.join(ROOT, 'src/shared/metadata.js'));

const manifest = JSON.parse(readFileSync(path.join(DATA_DIR, 'manifest.json'), 'utf8'));

// 这些是「生成器自报家门」的 PNG 文本块键名
const GENERATOR_KEYS = ['parameters', 'prompt', 'workflow', 'software', 'generator', 'model', 'comment', 'description'];
const stats = {
  ai: { total: 0, png: 0, jpeg: 0, other: 0, withTextChunk: 0, withGeneratorKey: 0, withAiSoftware: 0, withCameraExif: 0, withC2PA: 0, withXmp: 0, anyDeterministic: 0, samples: [] },
  real: { total: 0, png: 0, jpeg: 0, other: 0, withTextChunk: 0, withGeneratorKey: 0, withAiSoftware: 0, withCameraExif: 0, withC2PA: 0, withXmp: 0, anyDeterministic: 0, samples: [] },
};

for (const item of manifest.items) {
  const p = path.join(DATA_DIR, item.file);
  if (!existsSync(p)) continue;
  const s = stats[item.label];
  if (!s) continue;
  s.total++;

  let meta;
  try {
    meta = md.extractMetadata(new Uint8Array(readFileSync(p).subarray(0, md.RECOMMENDED_HEADER_BYTES)));
  } catch { continue; }

  if (meta.container === 'png') s.png++;
  else if (meta.container === 'jpeg') s.jpeg++;
  else s.other++;

  const keys = meta.pngTextKeys || [];
  const hasTextChunk = keys.length > 0;
  const genKeys = keys.filter((k) => GENERATOR_KEYS.includes(k.toLowerCase()));
  const soft = md.collectSoftwareStrings(meta).map((x) => x.value).join(' | ');
  const cameraExif = md.hasCameraEvidence(meta);
  const aiSoftware = md.hasAiSoftwareEvidence(meta);
  const verdict = md.judgeMetadata(meta);

  if (hasTextChunk) s.withTextChunk++;
  if (genKeys.length) s.withGeneratorKey++;
  if (aiSoftware) s.withAiSoftware++;
  if (cameraExif) s.withCameraExif++;
  if (meta.c2pa?.hasC2PA) s.withC2PA++;
  if (meta.xmp) s.withXmp++;
  if (verdict) s.anyDeterministic++;

  if (s.samples.length < 4 && (genKeys.length || aiSoftware)) {
    s.samples.push({ file: path.basename(item.file), container: meta.container, keys: genKeys, soft: soft.slice(0, 110) });
  }
}

const line = '─'.repeat(78);
console.log(`\n${line}\n元数据证据覆盖率（n = ${manifest.items.length} 张，来源 ${manifest.repo}）\n${line}`);
const rows = [
  ['图片总数', 'total'],
  ['PNG 容器', 'png'],
  ['JPEG 容器', 'jpeg'],
  ['带 PNG 文本块', 'withTextChunk'],
  ['带生成器特征键名', 'withGeneratorKey'],
  ['软件串命中 AI 工具', 'withAiSoftware'],
  ['带相机 EXIF', 'withCameraExif'],
  ['带 XMP', 'withXmp'],
  ['带 C2PA', 'withC2PA'],
  ['★ 至少一项来源自述（未验签）', 'anyDeterministic'],
];
console.log('指标'.padEnd(26) + 'AI 图'.padStart(14) + '真实图'.padStart(14));
for (const [label, key] of rows) {
  const a = stats.ai[key];
  const r = stats.real[key];
  const fmt = (n, tot) => key === 'total' ? String(n) : `${n} (${tot ? ((100 * n) / tot).toFixed(1) : '0.0'}%)`;
  console.log(label.padEnd(26) + fmt(a, stats.ai.total).padStart(14) + fmt(r, stats.real.total).padStart(14));
}
for (const label of ['ai', 'real']) {
  if (!stats[label].samples.length) continue;
  console.log(`\n${label} 组样例（命中生成器特征）:`);
  for (const x of stats[label].samples) {
    console.log(`  ${x.container.padEnd(5)} ${x.file.slice(0, 42).padEnd(44)} keys=[${x.keys.join(',')}]`);
    if (x.soft) console.log(`        soft: ${x.soft}`);
  }
}
console.log();
