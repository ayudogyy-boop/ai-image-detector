// 故障注入只替换 SDK 导入；验证、计时、释放与恢复均运行生产代码。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const md = require('../src/shared/metadata.js');

function verifier(sdk) {
  const ctx = vm.createContext({ Blob, URL, AbortController,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)), clearTimeout,
    location: { href: 'https://local.test/' },
    fetch: async () => ({ ok: true, text: async () => 'test PEM' }),
    __sdk: async () => sdk, AIDProvenance: require('../src/shared/provenance.js'),
  });
  ctx.self = ctx;
  const source = readFileSync(new URL('../src/offscreen/verify-c2pa.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace("import(localURL('lib/c2pa/index.mjs'))", 'self.__sdk()'), ctx);
  return ctx.AIDC2PA;
}
async function deadline(task) {
  let timer;
  try {
    return await Promise.race([task, new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'still-pending' }), 200);
    })]);
  } finally { clearTimeout(timer); }
}

test('SDK 读图不回应时终止共享 worker，两项请求均降级，下一项重新初始化', async () => {
  let created = 0, disposed = 0;
  const api = verifier({ Context: class {}, createC2pa: async () => ({ id: ++created, dispose() { disposed++; } }),
    Reader: { fromBlob: async (engine) => engine.id === 1 ? new Promise(() => {}) : null } });
  const results = await deadline(Promise.all([api.verify(new Uint8Array(16), 'image/jpeg'), api.verify(new Uint8Array(16), 'image/jpeg')]));
  assert.ok(Array.isArray(results), '验签永远未返回');
  assert.ok(results.every((r) => r.status === 'unavailable'));
  assert.equal(disposed, 1);
  assert.equal((await api.verify(new Uint8Array(16), 'image/jpeg')).status, 'not-present');
  assert.equal(created, 2);
});

test('SDK 清理不回应也不能阻塞分析槽位', async () => {
  let disposed = 0;
  const api = verifier({ Context: class {}, createC2pa: async () => ({ dispose() { disposed++; } }),
    Reader: { fromBlob: async () => ({ manifestStore: async () => null, free: () => new Promise(() => {}) }) } });
  const result = await deadline(api.verify(new Uint8Array(16), 'image/jpeg'));
  assert.equal(result.status, 'unavailable'); assert.equal(disposed, 1);
});

test('16 个超限压缩块共享总预算，第一块耗尽后不能重新获得 1MB', async () => {
  const compressed = deflateSync('x'.repeat(2 * 1024 * 1024));
  const chunks = Array.from({ length: 16 }, (_, i) => {
    const body = Buffer.concat([Buffer.from('key' + i + '\0\0'), compressed]);
    const chunk = Buffer.alloc(body.length + 12);
    chunk.writeUInt32BE(body.length); chunk.write('zTXt', 4); body.copy(chunk, 8);
    return chunk;
  });
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
  const Native = globalThis.DecompressionStream;
  let attempts = 0;
  globalThis.DecompressionStream = class { constructor(format) { attempts++; return new Native(format); } };
  try {
    const result = await md.summarizeBytesAsync(bytes);
    assert.equal(result.verdict, null);
    assert.equal(attempts, 1, '超限块被逐块重新赋予预算');
  } finally { globalThis.DecompressionStream = Native; }
});
