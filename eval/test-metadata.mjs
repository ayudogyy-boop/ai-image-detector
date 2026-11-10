// src/shared/metadata.js 的单元测试
//
// 用法：node eval/test-metadata.mjs
//
// 关键用例是「合成 PNG」：Stable Diffusion WebUI 会把整段生成参数写进 PNG 的 tEXt["parameters"]，
// 而旧实现只解析 JPEG，这条路径是完全漏掉的。合成一个来证明新实现真的读得到。

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const md = require(path.join(ROOT, 'src/shared/metadata.js'));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? '  → 实际: ' + JSON.stringify(extra) : ''}`); }
}

// ── 构造合法 PNG 的工具 ──────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function buildPNG({ width = 8, height = 8, chunks = [] }) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 一行 RGB + filter byte，循环几行
  const raw = Buffer.alloc(height * (1 + width * 3));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), ...chunks, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const tEXt = (k, v) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')]));
const zTXt = (k, v) => chunk('zTXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0, 0]), zlib.deflateSync(Buffer.from(v, 'latin1'))]));
const iTXt = (k, v, compressed = false) => chunk('iTXt', Buffer.concat([
  Buffer.from(k, 'latin1'), Buffer.from([0, compressed ? 1 : 0, 0]),
  Buffer.from([0]), Buffer.from([0]), // langTag \0 translatedKeyword \0
  compressed ? zlib.deflateSync(Buffer.from(v, 'utf8')) : Buffer.from(v, 'utf8'),
]));

console.log('\n=== 1. 容器嗅探（不依赖文件扩展名）===');
{
  const png = buildPNG({});
  check('PNG 魔数识别', md.sniffContainer(png).container === 'png');
  check('JPEG 魔数识别', md.sniffContainer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])).container === 'jpeg');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  check('WebP 识别（需要 RIFF....WEBP 两段）', md.sniffContainer(webp).container === 'webp');
  check('非图片字节 → unknown', md.sniffContainer(Buffer.from('404: Not Found....')).container === 'unknown');
}

console.log('\n=== 2. PNG 文本块（旧实现完全漏掉的部分）===');
{
  // 真实 SD WebUI 会写这种 tEXt
  const sdParams = 'a photo of a blonde swede\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 12345, Model hash: a1b2c3d4, Model: sd_xl_base_1.0';
  const png = buildPNG({ width: 1024, height: 1024, chunks: [tEXt('parameters', sdParams)] });
  const m = md.extractMetadata(png);
  check('提取到 tEXt["parameters"]', m.pngText && m.pngText.parameters === sdParams);
  check('记录文本块键名', m.pngTextKeys.includes('parameters'));
  check('从 IHDR 读出尺寸 1024×1024', m.width === 1024 && m.height === 1024);

  const comfy = buildPNG({ chunks: [tEXt('prompt', '{"3":{"class_type":"KSampler","inputs":{"seed":1}}}'), tEXt('workflow', '{"nodes":[]}')] });
  const mc = md.extractMetadata(comfy);
  check('ComfyUI: 读到 prompt 与 workflow', !!mc.pngText.prompt && !!mc.pngText.workflow);

  const itxt = buildPNG({ chunks: [iTXt('Software', 'Adobe Firefly')] });
  check('未压缩 iTXt 可读', md.extractMetadata(itxt).pngText.Software === 'Adobe Firefly');

  const itxtc = buildPNG({ chunks: [iTXt('Software', 'Compressed Tool', true)] });
  const mcc = md.extractMetadata(itxtc);
  check('压缩 iTXt → 只记录键名，不硬猜内容', mcc.compressedKeys.includes('Software') && !mcc.pngText);

  const zt = buildPNG({ chunks: [zTXt('parameters', sdParams)] });
  check('压缩 zTXt → 记入 compressedKeys', md.extractMetadata(zt).compressedKeys.includes('parameters'));

  const xmp = buildPNG({ chunks: [iTXt('XML:com.adobe.xmp', '<x:xmpmeta><xmp:CreatorTool>Adobe Firefly</xmp:CreatorTool></x:xmpmeta>')] });
  check('PNG 内嵌 XMP 的 CreatorTool', md.extractMetadata(xmp).xmp?.creatorTool === 'Adobe Firefly');
}

console.log('\n=== 3. 真实 JPEG（项目自带的 test-c2pa）===');
{
  const nikon = new Uint8Array(readFileSync(path.join(ROOT, 'test-c2pa/camera-nikon.jpg')));
  const m = md.extractMetadata(nikon.subarray(0, md.RECOMMENDED_HEADER_BYTES));
  check('识别为 jpeg', m.container === 'jpeg');
  check('EXIF Make = NIKON CORPORATION', m.exif?.make === 'NIKON CORPORATION', m.exif?.make);
  check('EXIF Model = NIKON Z 9', m.exif?.model === 'NIKON Z 9', m.exif?.model);
  check('检测到 C2PA (JUMBF)', m.c2pa.hasC2PA === true);
  check('读出 JPEG 尺寸', m.width > 0 && m.height > 0, [m.width, m.height]);
  check('段映射包含 APP11(JUMBF) 段', (m.segments || []).some((s) => s.marker === 'APP11'));
  check('段映射包含 SOF0', (m.segments || []).some((s) => s.marker === 'SOF0'));

  // 这条是审计结论的回归保护：旧实现用 64KB 窗口，在这张图上元数据基本全丢
  const legacy = md.extractMetadata(nikon.subarray(0, 65536));
  check('64KB 窗口下读不到尺寸（旧实现的问题）', legacy.width === null);
  check('64KB 窗口下读不到 XMP（旧实现的问题）', legacy.xmp === null);
  const xmpSeg = (m.segments || []).find((s) => s.marker === 'APP1' && s.offset > 300000);
  check('XMP 段确实落在 300KB 之后', !!xmpSeg, xmpSeg);
  check('XMP CreatorTool 可读', !!m.xmp, m.xmp);

  const adobe = new Uint8Array(readFileSync(path.join(ROOT, 'test-c2pa/adobe-test.jpg')));
  const ma = md.extractMetadata(adobe);
  check('adobe-test: EXIF Make = Canon', /canon/i.test(ma.exif?.make || ''), ma.exif?.make);
  check('adobe-test: EXIF Software 含 Lightroom', /lightroom/i.test(ma.exif?.software || ''), ma.exif?.software);

  const truepic = new Uint8Array(readFileSync(path.join(ROOT, 'test-c2pa/camera-truepic.jpg')));
  check('camera-truepic: 检测到 C2PA', md.extractMetadata(truepic.subarray(0, md.RECOMMENDED_HEADER_BYTES)).c2pa.hasC2PA === true);
}

console.log('\n=== 4. 坏输入不能抛异常（真实世界里到处是 404 页和半截文件）===');
{
  const junk = [Buffer.from('404: Not Found'), Buffer.alloc(0), Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(4096, 0x41)];
  let threw = null;
  for (const b of junk) {
    try { md.extractMetadata(new Uint8Array(b)); } catch (e) { threw = e.message + ' len=' + b.length; }
  }
  check('垃圾输入不抛异常', threw === null, threw);
}

console.log('\n=== 5. collectSoftwareStrings 汇总 ===');
{
  const png = buildPNG({ chunks: [tEXt('parameters', 'x'.repeat(500)), tEXt('Software', 'ComfyUI')] });
  const list = md.collectSoftwareStrings(md.extractMetadata(png));
  const sw = list.find((s) => s.source === 'png.Software');
  const par = list.find((s) => s.source === 'png.parameters');
  check('带出 Software', sw?.value === 'ComfyUI');
  check('长值被截断但保留原长', par?.value.length < 500 && par?.fullLength === 500);
}

console.log('\n=== 6. judgeMetadata：提取来源自述，不冒充签名验证 ===');
{
  const v = (m) => md.judgeMetadata(m);

  // 真实合成：SD WebUI 的 PNG 应该被判 red
  const sdPng = buildPNG({ chunks: [tEXt('parameters', 'a cat\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7')] });
  const sdMeta = md.extractMetadata(sdPng);
  check('SD parameters → red', v(sdMeta)?.verdict === 'red', v(sdMeta));

  const comfyPng = buildPNG({ chunks: [tEXt('prompt', '{"3":{"class_type":"KSampler","inputs":{"seed":1}}}')] });
  check('ComfyUI prompt → red', v(md.extractMetadata(comfyPng))?.verdict === 'red');

  // C2PA 方向
  check('未验签 C2PA AI 品牌不直接判定', v({ c2pa: { hasC2PA: true, isAI: true, generator: 'OpenAI' } }) === null);
  check('未验签 C2PA 相机品牌不直接判定', v({ c2pa: { hasC2PA: true, isAI: false, generator: 'Truepic' } }) === null);

  // 相机 EXIF —— 2026-10 审查后**不再单独下结论**：
  // EXIF 完全由发布方控制（一行命令可伪造），且 AI 二次编辑常保留原相机 EXIF，
  // 旧实现给这种情况发「可信 90」属于虚假安全感。现在它降级为 scoring 里的加权信号。
  check('相机 Make+Model → 不下结论（仅展示）', v({ exif: { make: 'NIKON CORPORATION', model: 'NIKON Z 9' } }) === null);
  check('相机 Make+Model → cameraEvidence=true', md.hasCameraEvidence({ exif: { make: 'NIKON CORPORATION', model: 'NIKON Z 9' } }) === true);
  check('只有 Make 没有 Model → 无相机证据', md.hasCameraEvidence({ exif: { make: 'Canon' } }) === false);
  check('非相机厂牌 → 无相机证据', md.hasCameraEvidence({ exif: { make: 'SomeCompany', model: 'X1' } }) === false);

  // XMP 软件串
  check('XMP CreatorTool 是 AI 工具 → red', v({ xmp: { creatorTool: 'Adobe Firefly' } })?.verdict === 'red');

  // IPTC DigitalSourceType（2026-10 新增）
  check('IPTC trainedAlgorithmicMedia → red',
    v({ xmp: { digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia' } })?.verdict === 'red');
  check('IPTC digitalCapture 不能证明真实',
    v({ xmp: { digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture' } }) === null);
  check('IPTC 其他值 → 不下结论',
    v({ xmp: { digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/composite' } }) === null);

  // JPEG 注释段（2026-10 修复：旧实现解析了 comment 却从不判定）
  const jpegComment = (text) => {
    const payload = Buffer.from(text, 'latin1');
    const seg = Buffer.alloc(4 + payload.length);
    seg[0] = 0xff; seg[1] = 0xfe; seg.writeUInt16BE(payload.length + 2, 2);
    payload.copy(seg, 4);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), seg, Buffer.from([0xff, 0xd9])]);
  };
  check('JPEG COM 仅提工具名不下结论',
    v(md.extractMetadata(new Uint8Array(jpegComment('Stable Diffusion XL 1.0')))) === null);

  // 关键词误报回归 —— 2026-10 审查实测到旧版会把下面这些普通文本判成 AI
  const pngText = (key, val) => md.extractMetadata(buildPNG({ chunks: [tEXt(key, val)] }));
  check('西语 "imagen del paisaje" 不误报', v(pngText('description', 'imagen del paisaje al atardecer')) === null);
  check('英语 "flux capacitor" 不误报', v(pngText('comment', 'flux capacitor, 1985')) === null);
  check('"Krea is a Swedish name" 不误报', v(pngText('description', 'Krea is a Swedish name')) === null);
  check('"niji means rainbow" 不误报', v(pngText('comment', 'niji means rainbow in Japanese')) === null);
  // 但真正的生成器自述仍然要抓到
  check('description 里提到 Midjourney 不下结论', v(pngText('description', 'a cat generated with Midjourney v6')) === null);
  check('software=ComfyUI → red', v(pngText('software', 'ComfyUI'))?.verdict === 'red');
  check('software=Adobe Photoshop → 不下结论', v(pngText('software', 'Adobe Photoshop 25.0')) === null);

  // 冲突与空
  // 冲突语义（刻意如此，不是 bug）：
  //   文件里同时写着「Canon EOS R5」和「Stable Diffusion」→ AI 证据优先，判 red。
  //   理由是这张图确实经过 SD 处理（img2img），或者 EXIF 被伪造；相机字段可被继承或伪造，
  //   而「Software: Stable Diffusion」是主动写入的强证据。所以相机证据不能推翻它。
  check('相机厂牌 + AI 软件串 → AI 证据优先判 red', v({ exif: { make: 'Canon', model: 'EOS R5', software: 'Stable Diffusion' } })?.verdict === 'red');

  // 真正的冲突：C2PA 说相机拍的，PNG 里却写着 SD 生成参数 → 证据对撞，不下结论
  const conflictPng = buildPNG({ chunks: [tEXt('parameters', 'x\nSteps: 30, Sampler: Euler, CFG scale: 7')] });
  const conflictMeta = md.extractMetadata(conflictPng);
  conflictMeta.c2pa = { hasC2PA: true, isAI: false, generator: 'Truepic' };
  check('未验签相机品牌不掩盖 SD 来源声明', v(conflictMeta)?.verdict === 'red' && v(conflictMeta)?.verified === false, v(conflictMeta));
  check('什么都没有 → null', v({ container: 'jpeg' }) === null);
  check('null 输入 → null', v(null) === null);

  // 关键回归：弱信号绝不能触发结论（这正是旧实现的误报来源）
  check('只有分辨率可疑 → 不下结论', v({ width: 1024, height: 1024 }) === null);
  check('只有 GPS → 不下结论', v({ exif: { hasGps: true } }) === null);
  check('PNG 有普通文本块 → 不下结论', v(md.extractMetadata(buildPNG({ chunks: [tEXt('Author', 'someone')] }))) === null);

  // 真实文件
  const nikon = md.extractMetadata(new Uint8Array(readFileSync(path.join(ROOT, 'test-c2pa/camera-nikon.jpg'))).subarray(0, md.RECOMMENDED_HEADER_BYTES));
  check('camera-nikon.jpg 文件头不冒充完整验签', v(nikon) === null, v(nikon));
}

console.log(`\n${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
