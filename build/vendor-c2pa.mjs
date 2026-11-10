// 从锁定的 npm 依赖复建离线 C2PA 运行时；仅 --update-trust 时联网更新公有信任列表。
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'lib/c2pa');
await mkdir(out, { recursive: true });
if (process.argv.includes('--update-trust')) {
  const files = ['C2PA-TRUST-LIST.pem', 'C2PA-TSA-TRUST-LIST.pem'];
  const sources = [];
  for (const name of files) {
    const url = `https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/${name}`;
    const body = execFileSync('curl', ['-fsSL', '--connect-timeout', '10', '--max-time', '30', url], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (!body.includes('-----BEGIN CERTIFICATE-----') || body.length > 1024 * 1024) throw new Error('invalid trust bundle');
    await writeFile(path.join(out, name), body);
    sources.push({ name, url, sha256: createHash('sha256').update(body).digest('hex') });
  }
  await writeFile(path.join(out, 'trust-snapshot.json'), JSON.stringify({ retrievedAt: new Date().toISOString(), sources }, null, 2) + '\n');
}
await build({ stdin: { contents: "export { createC2pa, Reader, Context } from '@contentauth/c2pa-web';", resolveDir: root },
  outfile: path.join(out, 'index.mjs'), bundle: true, format: 'esm', platform: 'browser', minify: true, legalComments: 'eof',
  plugins: [{ name: 'same-origin-extension-worker', setup(b) {
    b.onLoad({ filter: /c2pa-[^/]+\.js$/ }, async (args) => {
      const original = await readFile(args.path, 'utf8');
      const guard = 'if (n.protocol !== "https:")';
      if (original.split(guard).length !== 2) throw new Error('SDK worker URL guard changed; review compatibility patch');
      // 0.16.0 只接受 HTTPS。允许同源扩展和本地测试，不允许任意远端 HTTP worker。
      const replacement = 'if (n.protocol !== "https:" && !(n.protocol === "chrome-extension:" && n.origin === self.location.origin) && !(n.protocol === "http:" && ["127.0.0.1", "localhost"].includes(n.hostname) && n.origin === self.location.origin))';
      // SDK 初始化尚未返回 engine 时，调用方拿不到 dispose；在 worker 所属作用域兜底。
      const init = 'return await s.initWorker(e), {';
      if (original.split(init).length !== 2) throw new Error('SDK worker initialization changed; review timeout patch');
      const boundedInit = `return await (async () => {
        let timer;
        try {
          await Promise.race([s.initWorker(e), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('c2pa-worker-init-timeout')), 12000);
          })]);
        } catch (error) { o.terminate(); throw error; }
        finally { clearTimeout(timer); }
      })(), {`;
      return { contents: original.replace(guard, replacement).replace(init, boundedInit), loader: 'js', resolveDir: path.dirname(args.path) };
    });
  } }] });
await copyFile(path.join(root, 'node_modules/@contentauth/c2pa-web/dist/c2pa_worker.js'), path.join(out, 'c2pa_worker.js'));
await copyFile(path.join(root, 'node_modules/@contentauth/c2pa-web/dist/resources/c2pa_bg.wasm'), path.join(out, 'c2pa_bg.wasm'));
const names = ['c2pa-web', 'c2pa-wasm', 'c2pa-utilities', 'c2pa-types'];
let licenses = '';
for (const name of names) licenses += `\n=== @contentauth/${name} ===\n` + await readFile(path.join(root, `node_modules/@contentauth/${name}/LICENSE`), 'utf8');
for (const name of ['highgain', 'ts-deepmerge']) {
  const pkg = JSON.parse(await readFile(path.join(root, `node_modules/${name}/package.json`), 'utf8'));
  licenses += `\n=== ${name}@${pkg.version} ===\nLicense: ${pkg.license}\nAuthor: ${JSON.stringify(pkg.author)}\nSource: ${JSON.stringify(pkg.repository)}\n`;
  licenses += '\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\nTHE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n';
}
await writeFile(path.join(out, 'THIRD-PARTY-LICENSES.txt'), licenses);
console.log('Offline C2PA runtime generated.');

// 初次由手动 curl 取回快照时也记录来源和哈希；常规复建不改已有日期。
try { await readFile(path.join(out, 'trust-snapshot.json')); } catch {
  const sources = [];
  for (const name of ['C2PA-TRUST-LIST.pem', 'C2PA-TSA-TRUST-LIST.pem']) {
    const body = await readFile(path.join(out, name));
    sources.push({ name, url: `https://raw.githubusercontent.com/c2pa-org/conformance-public/main/trust-list/${name}`, sha256: createHash('sha256').update(body).digest('hex') });
  }
  await writeFile(path.join(out, 'trust-snapshot.json'), JSON.stringify({ retrievedAt: new Date().toISOString(), sources }, null, 2) + '\n');
}
