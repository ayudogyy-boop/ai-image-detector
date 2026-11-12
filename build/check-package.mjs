// 校验暂存包中的 manifest、HTML 相对引用和固定运行时资源。
import { readFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const rootURL = pathToFileURL(root + path.sep);
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (manifest.version !== pkg.version) throw new Error('manifest/package 版本不一致');

async function check(ref, base = rootURL) {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(ref)) return;
  const url = ref.startsWith('/') ? new URL(ref.slice(1), rootURL) : new URL(ref, base);
  url.search = ''; url.hash = '';
  const target = fileURLToPath(url);
  if (!target.startsWith(root + path.sep)) throw new Error(`引用超出包目录: ${ref}`);
  try { await access(target); }
  catch { throw new Error(`缺失包内引用: ${path.relative(root, target)}`); }
}

const entries = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page,
  ...Object.values(manifest.icons || {}), ...Object.values(manifest.action.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  'models/detector.onnx', 'lib/ort.wasm.min.js', 'lib/ort-wasm-simd-threaded.wasm',
  'lib/ort-wasm-simd-threaded.mjs', 'LICENSE', 'NOTICE', 'lib/ONNXRUNTIME-LICENSE.txt',
  'lib/ONNXRUNTIME-ThirdPartyNotices.txt', 'lib/ONNXRUNTIME-SOURCES.md', 'models/SOURCES.md', 'docs/LICENSING.md',
  'lib/c2pa/index.mjs', 'lib/c2pa/c2pa_worker.js', 'lib/c2pa/c2pa_bg.wasm',
  'lib/c2pa/C2PA-TRUST-LIST.pem', 'lib/c2pa/C2PA-TSA-TRUST-LIST.pem', 'lib/c2pa/trust-snapshot.json',
  'lib/c2pa/THIRD-PARTY-LICENSES.txt', 'lib/c2pa/TRUST-LIST-LICENSE.txt', 'lib/c2pa/SOURCES.md'];
for (const ref of entries.filter(Boolean)) await check(ref);
for (const entry of await readdir(root)) {
  if (['eval', 'test-c2pa', 'node_modules', '.git'].includes(entry) || /^\.env(?:\.|$)/.test(entry)) {
    throw new Error(`验证包不应包含开发/测试或私有文件: ${entry}`);
  }
}

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(file); continue; }
    if (file.endsWith('.html')) {
      const html = await readFile(file, 'utf8');
      const baseRef = html.match(/<base\b[^>]*href=["']([^"']+)["']/i)?.[1];
      const pageURL = pathToFileURL(file);
      const base = baseRef ? (baseRef.startsWith('/') ? new URL(baseRef.slice(1), rootURL) : new URL(baseRef, pageURL)) : pageURL;
      for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
        const ref = tag[0].match(/(?:src|href)=["']([^"']+)["']/i)?.[1];
        if (ref) await check(ref, base);
      }
    } else if (file.endsWith('.js') && !file.startsWith(path.join(root, 'lib') + path.sep)) {
      const js = await readFile(file, 'utf8');
      for (const call of js.matchAll(/importScripts\(([^)]*)\)/g)) {
        for (const ref of call[1].matchAll(/["']([^"']+)["']/g)) await check(ref[1], pathToFileURL(file));
      }
    }
  }
}
await walk(path.join(root, 'src'));
console.log('  self-check: OK（含 HTML 相对引用）');
