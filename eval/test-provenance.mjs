import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const md = require('../src/shared/metadata.js');
const scoring = require('../src/shared/scoring.js');
const provenance = require('../src/shared/provenance.js');
const dst = (name) => 'http://cv.iptc.org/newscodes/digitalsourcetype/' + name;
function store(state, type = 'trainedAlgorithmicMedia') {
  return { validation_state: state, active_manifest: 'current', manifests: { current: {
    signature_info: { common_name: 'Test issuer' }, assertions: [{ label: 'c2pa.actions.v2', data: { actions: [{ action: 'c2pa.created', digitalSourceType: dst(type) }] } }],
  } } };
}
function pngChunk(type, body) {
  const c = Buffer.alloc(body.length + 12); c.writeUInt32BE(body.length); c.write(type, 4); body.copy(c, 8); return c;
}
function png(chunks) { return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]); }
const model = (p, meta) => ({ onnx: { aiProbability: p }, meta });

test('仅 active manifest 的受控 AI 动作能成为验证证据，品牌词无效', () => {
  const s = store('Trusted', 'digitalCapture');
  s.manifests.old = store('Trusted').manifests.current;
  s.manifests.current.claim_generator = 'OpenAI';
  assert.equal(provenance.summarizeStore(s).aiDisclosure, false);
  assert.equal(provenance.sourceType('https://example.com/trainedAlgorithmicMedia'), null);
});
test('trusted AI 生成与 AI 编辑分开，invalid 清单不提供 AI 证据', () => {
  assert.equal(provenance.summarizeStore(store('Trusted')).aiKind, 'generated');
  assert.equal(provenance.summarizeStore(store('Trusted', 'compositeWithTrainedAlgorithmicMedia')).aiKind, 'edited');
  assert.equal(provenance.summarizeStore(store('Invalid')).aiDisclosure, false);
});
test('缺少 active manifest 或未知 SDK 状态不默认为通过', () => {
  assert.equal(provenance.summarizeStore({ active_manifest: 'missing', manifests: {} }).status, 'invalid');
  assert.equal(provenance.summarizeStore(store('Unknown')).status, 'unavailable');
});
test('普通程序绘图/算法处理不是机器学习 AI 生成证据', () => {
  assert.equal(provenance.summarizeStore(store('Trusted', 'algorithmicMedia')).aiDisclosure, false);
  assert.equal(md.judgeMetadata({ xmp: { digitalSourceType: dst('algorithmicMedia') } }), null);
});
test('可信签名的 AI 声明优先，原模型倾向真人也不覆盖', () => {
  const r = scoring.scoreAnalysis(model(.01, { provenance: provenance.summarizeStore(store('Trusted')) }));
  assert.equal(r.color, 'red'); assert.equal(r.decidedBy, 'verified-provenance');
});
test('不受信任签发方的有效签名不会冒充已验证 AI 来源', () => {
  const r = scoring.scoreAnalysis(model(.01, { provenance: provenance.summarizeStore(store('Valid')) }));
  assert.equal(r.color, 'yellow'); assert.equal(r.decidedBy, 'declaration');
});
test('禁用溯源后完全忽略签名结果', () => {
  const r = scoring.scoreAnalysis(model(.01, { provenance: provenance.summarizeStore(store('Trusted')) }), { signals: { c2pa: false } });
  assert.equal(r.color, 'green'); assert.equal(r.decidedBy, 'model');
});
test('相机 EXIF、IPTC 相机自述或无水印不能独自给绿标', () => {
  for (const meta of [{ cameraEvidence: true }, { c2pa: { hasC2PA: true, isAI: false } }, { provenance: provenance.summarizeStore(store('Trusted', 'digitalCapture')) }]) {
    assert.equal(scoring.scoreAnalysis({ meta }).color, 'gray');
  }
  assert.equal(scoring.combineScores({ c2pa: 95, camera: 80 }).color, 'gray');
});
test('未验签生成声明只标明自述，不能伪造高置信结论', () => {
  const meta = { verdict: 'red', verdictReasons: ['PNG parameters(SD)'] };
  const r = scoring.scoreAnalysis(model(.01, meta));
  assert.equal(r.color, 'yellow'); assert.equal(r.confidence, 'low');
  assert.equal(scoring.scoreAnalysis(model(.99, meta)).decidedBy, 'model');
});
test('非有限或范围外模型输出必须弃权', () => {
  for (const p of [NaN, Infinity, -1, 2, null]) assert.equal(scoring.scoreAnalysis(model(p)).color, 'gray');
});
test('失败与关闭显示灰色空分数，具体阶段与 HTTP 状态可追溯', () => {
  for (const code of ['model-load-failed', 'model-init-failed', 'model-inference-failed', 'image-decode-failed', 'image-http-error']) {
    const r = scoring.scoreAnalysis({ ok: true, onnxErrorCode: code, onnxError: 'detail', fetchError: { code, status: 403 } });
    assert.equal(r.color, 'gray'); assert.equal(r.score, null);
    assert.equal(r.modelIssue.code, code); assert.equal(r.modelIssue.detail, 'detail');
    assert.equal(r.modelIssue.status, 403);
  }
  const disabled = scoring.scoreAnalysis({}, { signals: { onnx: false } });
  assert.equal(disabled.modelIssue.code, 'model-disabled'); assert.equal(disabled.color, 'gray');
  assert.equal(scoring.scoreAnalysis(model(.50)).color, 'yellow');
});
test('固定 40/60 颜色边界，旧灵敏度设置不能改变区间', () => {
  for (const sensitivity of [undefined, 'low', 'medium', 'high', 'unknown']) {
    for (let score = 0; score <= 100; score++) {
      const expected = score < 40 ? 'red' : score <= 60 ? 'yellow' : 'green';
      assert.equal(scoring.combineScores({ onnx: score }, { sensitivity }).color, expected, `${sensitivity}/${score}`);
    }
  }
  for (const [score, displayed, color] of [[39.6, 40, 'yellow'], [60.4, 60, 'yellow'], [60.6, 61, 'green']]) {
    const r = scoring.combineScores({ onnx: score });
    assert.equal(r.score, displayed); assert.equal(r.color, color);
  }
});
test('模型低于 40 的红标不被未验签声明覆盖，40/60 仍是黄色', () => {
  const declarations = [{ verdict: 'red', verdictReasons: ['PNG parameters(SD)'] },
    { provenance: provenance.summarizeStore(store('Valid')) }];
  for (const meta of [undefined, ...declarations]) {
    for (const [score, color] of [[29, 'red'], [35, 'red'], [39, 'red'], [40, 'yellow'], [60, 'yellow']]) {
      const r = scoring.scoreAnalysis(model((95 - score) / 100, meta));
      assert.equal(r.score, meta && color === 'yellow' ? 50 : score);
      assert.equal(r.color, color, String(score));
      if (color === 'red') assert.equal(r.decidedBy, 'model');
    }
  }
});
test('普通品牌提及和通用节点图不能生成 AI 声明', () => {
  assert.equal(md.judgeMetadata({ pngText: { description: 'an article about Midjourney', workflow: '{"nodes":[{"type":"ColorCorrection"}]}' } }), null);
  assert.equal(md.isComfyGraph('{"x":{"class_type":"KSampler","inputs":{}}}', false), true);
  assert.equal(md.isComfyGraph('{"nodes":[{"type":"KSampler"}]}', true), true);
  assert.equal(md.isComfyGraph('KSampler is discussed here', false), false);
});
test('SD 参数需要组合字段，单个提示词或参数名不算', () => {
  assert.equal(md.isSDParameters('Negative prompt: blurry'), false);
  assert.equal(md.isSDParameters('Steps: 30, Sampler: Euler, Seed: 123'), true);
});
test('AIGC Label 1/2/3 保持区别，不接受普通 JSON 或伪造拼接字符串', () => {
  assert.deepEqual(md.parseAIGC('AIGC:{"Label":"1","ContentProducer":"test"}'), { label: '1', producer: 'test' });
  assert.equal(md.parseAIGC('{"Label":"1"}'), null);
  for (const label of ['2', '3']) assert.equal(md.judgeMetadata({ aigc: { label, producer: 'test' } }), null);
});
test('JPEG APP11 的国内 AIGC 声明可解析，但仍未验签', () => {
  const payload = Buffer.from('AIGC:{"Label":"1","ContentProducer":"test"}');
  const segment = Buffer.alloc(payload.length + 4); segment[0] = 255; segment[1] = 235; segment.writeUInt16BE(payload.length + 2, 2); payload.copy(segment, 4);
  const bytes = Buffer.concat([Buffer.from([255, 216]), segment, Buffer.from([255, 217])]);
  assert.equal(md.summarizeBytes(bytes).aigc.producer, 'test');
  assert.equal(scoring.scoreAnalysis({ meta: md.summarizeBytes(bytes) }).decidedBy, 'declaration');
});
test('PNG 压缩参数与压缩 XMP 使用生产异步路径读取', async () => {
  const params = 'Steps: 30, Sampler: Euler, CFG scale: 7';
  const bytes = png([pngChunk('zTXt', Buffer.concat([Buffer.from('parameters\0\0'), deflateSync(params)]))]);
  const meta = await md.summarizeBytesAsync(bytes);
  assert.equal(meta.pngText.parameters, params); assert.equal(meta.compressedKeys.length, 0);
  assert.ok(meta.verdictReasons.some((r) => r.includes('SD')));
  const xml = `<Iptc4xmpExt:DigitalSourceType>${dst('trainedAlgorithmicMedia')}</Iptc4xmpExt:DigitalSourceType>`;
  const itxt = png([pngChunk('iTXt', Buffer.concat([Buffer.concat([Buffer.from('XML:com.adobe.xmp\0'), Buffer.from([1, 0, 0, 0])]), deflateSync(xml)]))]);
  assert.equal((await md.summarizeBytesAsync(itxt)).xmp.digitalSourceType, dst('trainedAlgorithmicMedia'));
});
test('压缩炸弹不能越过文本输出预算', async () => {
  const bytes = png([pngChunk('zTXt', Buffer.concat([Buffer.from('parameters\0\0'), deflateSync('x'.repeat(2 * 1024 * 1024))]))]);
  const meta = await md.summarizeBytesAsync(bytes);
  assert.equal(meta.verdict, null); assert.ok(meta.compressedKeys.includes('parameters'));
});
test('完整图片超限/中途断流不得拿截断字节推理或验签', async () => {
  const response = () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(11)); c.close(); } }));
  await assert.rejects(md.readCapped(response(), 10, true), /too-large/);
  assert.equal((await md.readCapped(response(), 10)).length, 10);
  const broken = new Response(new ReadableStream({ pull(c) { c.error(new Error('broken')); } }));
  await assert.rejects(md.readCapped(broken, 10, true), /broken/);
  assert.equal((await md.readCapped(new Response(new Uint8Array(10)), 10, true)).length, 10);
});
