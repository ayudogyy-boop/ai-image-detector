// 工作台只保留展示所需的有界证据；评分仍由 AIDScoring 执行。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AIDWorkbench = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const text = (value, limit = 240) => typeof value === 'string' ? value.slice(0, limit) : '';
  const list = (value, limit = 12) => Array.isArray(value) ? value.slice(0, limit).map((s) => text(s)).filter(Boolean) : [];
  const STATUSES = Object.freeze({
    trusted: '签名及资产绑定通过，签发方在离线信任列表中', valid: '签名有效，来源未受当前信任列表认可',
    invalid: '来源凭据核验失败，不能依赖该声明判断来源', 'not-present': '未发现可用的本地来源清单',
    unavailable: '来源核验未完成', disabled: '来源核验已关闭',
  });
  const OFFICIAL = Object.freeze([
    Object.freeze({ name: 'OpenAI', url: 'https://openai.com/verify' }),
    Object.freeze({ name: 'Google SynthID', url: 'https://synthid.com/' }),
    Object.freeze({ name: 'Meta', url: 'https://www.meta.ai/identification/' }),
  ]);
  function evidence(result) {
    const p = result?.provenance || {};
    const status = Object.hasOwn(STATUSES, p.status) ? p.status : 'unavailable';
    const color = ['red', 'yellow', 'green', 'gray'].includes(result?.color) ? result.color : 'gray';
    const out = {
      color, score: Number.isFinite(result?.score) ? Math.max(0, Math.min(100, Math.round(result.score))) : null,
      modelScore: Number.isFinite(result?.signals?.onnx?.score) ? result.signals.onnx.score
        : Number.isFinite(result?.modelScore) ? result.modelScore : null,
      title: text(result?.title) || '无法确定', decidedBy: text(result?.decidedBy, 40),
      modelStatus: text(result?.modelStatus, 40), provenance: { status, issuer: text(p.issuer), errors: list(p.errors) },
      declarations: list(result?.reasons || result?.declarations),
      modelIssue: result?.modelIssue ? { code: text(result.modelIssue.code, 60), message: text(result.modelIssue.message),
        detail: text(result.modelIssue.detail), status: Number.isInteger(result.modelIssue.status) ? result.modelIssue.status : null } : null,
    };
    out.explanation = out.decidedBy === 'verified-provenance' ? '发现通过本地信任校验的 AI 来源声明；仍不等同于画面内容真实或虚假。'
      : out.decidedBy === 'declaration' ? '文件包含 AI 生成/编辑自述，尚未证实签发方；字段可能被伪造。'
      : out.modelStatus === 'available' ? '颜色来自本地模型估计。分数不是校准后的真实性概率，模型可能误判和漏判。'
      : '没有取得有效模型结论。未完成、未检出标识与图片真实是不同的状态。';
    return out;
  }
  function safeURL(value) {
    try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
    catch (_) { return ''; }
  }
  function reportRows(items, includeURLs = false) {
    return items.filter((x) => x.state === 'done' && x.result).slice(0, 50).map((x) => ({
      name: text(x.name), source: x.kind === 'file' ? '本地文件' : '网页图片', checkedAt: text(x.checkedAt, 50),
      settings: x.settings ? { onnx: x.settings.signals.onnx, c2pa: x.settings.signals.c2pa,
        exif: x.settings.signals.exif, extensionVersion: text(x.version, 30) } : null,
      ...(includeURLs && x.kind !== 'file' && safeURL(x.url) ? { url: safeURL(x.url) } : {}),
      ...evidence(x.result),
    }));
  }
  function csvCell(value) {
    let out = value === null || value === undefined ? '' : String(value);
    if (/^[\s\u0000-\u001f\u007f\uFEFF]*[=+\-@]/.test(out) || /^[\t\r\n]/.test(out)) out = "'" + out;
    return '"' + out.replace(/"/g, '""') + '"';
  }
  function serialize(items, format, options = {}) {
    const rows = reportRows(items, options.includeURLs === true);
    const note = '仅作来源线索参考。模型可能误判；未检出标识不代表真实；SynthID / Content Seal 未在本地核验。';
    if (format === 'json') return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), note, results: rows }, null, 2);
    if (format !== 'csv') throw new Error('不支持的报告格式');
    const header = ['名称', '来源', '检测时间', '结论', '展示分数', '模型分数', '依据类型', '模型状态', '签名状态', '签发方', '来源自述', '错误', '说明'];
    if (options.includeURLs) header.push('图片 URL');
    const data = rows.map((r) => {
      const cells = [r.name, r.source, r.checkedAt, r.title, r.score, r.modelScore, r.decidedBy, r.modelStatus, r.provenance.status,
        r.provenance.issuer, r.declarations.join('；'), r.modelIssue?.message || '', note];
      if (options.includeURLs) cells.push(r.url || '');
      return cells;
    });
    return '\uFEFF' + [header, ...data].map((cells) => cells.map(csvCell).join(',')).join('\r\n');
  }
  return Object.freeze({ STATUSES, OFFICIAL, evidence, safeURL, reportRows, csvCell, serialize });
});
