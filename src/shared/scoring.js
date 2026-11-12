/* ============================================================
 * AI Image Detector — 评分与融合（纯函数，零依赖，不碰 chrome API）
 *
 * 为什么要有这个文件：
 *   审查（REVIEW-2026-10-19 P1-5）发现，评分与融合逻辑在 content.js 和
 *   eval/run-eval.mjs 里各有一份**复制品**，而且 eval 那份已经跟不上线上（缺确定性判定层）。
 *   于是"评测跑出来的数字"和"用户看到的行为"是两回事。
 *   这个文件把评分规则收成唯一真源：
 *     - content script：manifest 里作为前一个脚本先加载 → self.AIDScoring
 *     - Node（评测/单测）：require() → module.exports
 *
 * 本文件只负责「已知信号 → 分数/颜色」。怎么提取信号，是 metadata.js 的事。
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.AIDScoring = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 未验证的相机/溯源字段不参与模型分数，避免缺证据或伪造字段推高可信度。
  const WEIGHTS = { onnx: 0.65, camera: 0, c2pa: 0, fileinfo: 0, exif: 0 };

  const SENSITIVITY = {
    // 兼容旧设置键；用户指定固定区间，旧灵敏度不能改变 40/60 边界。
    low: { g: 61, r: 40 },
    medium: { g: 61, r: 40 },
    high: { g: 61, r: 40 },
  };

  const CAMERA_EVIDENCE_SCORE = 80;

  /** 模型原始 AI 输出 → 展示分数（不是经过校准的真实性概率） */
  function onnxScoreFromProbability(p) {
    return Math.round(Math.min(90, Math.max(5, 100 * (1 - p) - 5)));
  }

  // 旧接口保留为中性展示值；验签结果由 scoreAnalysis 单独解释。
  function c2paScoreFromMeta() { return 50; }

  /** 先应用开关再合并未验签 AI 自述；函数名为旧接口兼容，不表示真实性确定。 */
  function deterministicVerdict(meta, signals) {
    if (!meta) return null;
    signals = signals || {};
    const candidates = meta.verdictBySignal
      ? Object.entries(meta.verdictBySignal)
        .filter(([name, verdict]) => signals[name] !== false && verdict)
        .map(([, verdict]) => verdict)
      : (meta.verdict ? [{ verdict: meta.verdict, reasons: (meta.verdictReasons || []).filter((r) =>
        signals[/^(C2PA|IPTC):/.test(r) ? 'c2pa' : 'exif'] !== false) }] : []);
    const kept = candidates.filter((v) => v.reasons.length);
    if (!kept.length || kept.some((v) => v.conflict) || new Set(kept.map((v) => v.verdict)).size > 1) return null;
    return { verdict: kept[0].verdict, reasons: kept.flatMap((v) => v.reasons) };
  }

  /**
   * 加权融合。
   * @param {Object} signals  {onnx:number|{score}, camera:number|{score}, c2pa:number, fileinfo:number, exif:number}
   *                          值为 null/undefined 表示该信号不可用（不计入分母）
   * @param {Object} [settings] 兼容旧调用；所有灵敏度使用相同颜色区间。
   */
  function combineScores(signals, settings) {
    const details = {};
    for (const [name, sig] of Object.entries(signals)) {
      const score = typeof sig === 'object' && sig !== null ? sig.score : sig;
      details[name] = { score: Number.isFinite(score) ? score : null, used: name === 'onnx' && Number.isFinite(score), info: name !== 'onnx' };
    }
    const model = details.onnx;
    if (!model || model.score === null) return { score: null, confidence: 'none', signals: details, color: 'gray' };
    // 按实际展示的整数分数着色，避免显示 40 却仍是红色等边界不一致。
    const raw = Math.round(Math.max(0, Math.min(100, model.score)));
    const confidence = 'medium';
    const sens = (settings && settings.sensitivity) || 'medium';
    const t = SENSITIVITY[sens] || SENSITIVITY.medium;
    const color = raw >= t.g ? 'green' : raw >= t.r ? 'yellow' : 'red';
    return { score: raw, confidence, color, signals: details };
  }

  /** 唯一决策入口：签名验证、未验签声明、模型估计分层呈现。 */
  function scoreAnalysis(remote, settings = {}, fileinfo = null) {
    const sigs = settings.signals || {};
    const meta = remote?.meta;
    const p = sigs.onnx !== false ? remote?.onnx?.aiProbability : null;
    const modelAvailable = typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
    const declarations = deterministicVerdict(meta, sigs);
    const provenance = sigs.c2pa !== false ? meta?.provenance : null;
    const result = combineScores({
      onnx: modelAvailable ? onnxScoreFromProbability(p) : null,
      camera: sigs.exif !== false && meta?.cameraEvidence ? CAMERA_EVIDENCE_SCORE : null,
      fileinfo, c2pa: null,
    }, settings);
    result.decidedBy = modelAvailable ? 'model' : 'unavailable';
    result.title = modelAvailable ? ({ red: '模型疑似 AI', green: '模型偏非 AI', yellow: '无法确定' })[result.color] : '检测未完成';
    result.modelStatus = modelAvailable ? 'available' : sigs.onnx === false ? 'disabled' : 'unavailable';
    if (!modelAvailable) {
      const code = sigs.onnx === false ? 'model-disabled' : remote?.onnxErrorCode || remote?.fetchError?.code
        || (remote?.onnx ? 'model-output-invalid' : remote?.errorCode || 'analysis-unavailable');
      const descriptions = {
        'model-disabled': '模型检测已关闭', 'model-load-failed': '模型文件加载失败',
        'model-load-timeout': '模型文件加载超时', 'model-init-failed': '模型初始化失败',
        'model-inference-failed': '模型推理失败', 'model-output-invalid': '模型返回了无效结果',
        'image-fetch-failed': '图片请求失败', 'image-http-error': '图片服务器返回错误',
        'image-invalid-request': '图片地址或分析参数不受支持',
        'image-fetch-timeout': '图片读取超时', 'image-read-failed': '图片读取中断',
        'image-too-large': '图片超过 40MB 上限', 'image-empty': '图片内容为空',
        'image-decode-failed': '图片无法解码', 'analysis-unavailable': '检测服务暂不可用',
      };
      result.modelIssue = { code, message: descriptions[code] || '检测服务暂不可用',
        detail: String(remote?.onnxError || remote?.error || '').slice(0, 160),
        status: remote?.fetchError?.status || null };
      result.title = result.modelIssue.message;
    }
    result.reasons = declarations?.reasons || [];
    result.provenance = provenance || { status: sigs.c2pa === false ? 'disabled' : 'unavailable' };
    result.watermark = { status: 'not-checked', note: '本地未核验 SynthID / Content Seal；未检出标识不代表真实。' };
    if (provenance?.status === 'trusted' && provenance.aiDisclosure === true) {
      result.score = 10; result.color = 'red'; result.confidence = 'high'; result.decidedBy = 'verified-provenance';
      result.title = provenance.aiKind === 'edited' ? '已验证 AI 编辑声明' : '已验证 AI 生成声明';
    } else if ((declarations || (provenance?.status === 'valid' && provenance.aiDisclosure)) && result.color !== 'red') {
      result.color = 'yellow'; result.score = 50; result.confidence = 'low'; result.decidedBy = 'declaration';
      result.title = provenance?.status === 'valid' ? 'AI 声明签名有效，来源未受信任' : '含 AI 来源声明（未验签）';
    }
    if (remote?.onnxError || remote?.ok === false) result.modelError = String(remote.onnxError || remote.error || 'analysis-failed').slice(0, 160);
    return result;
  }

  return {
    scoreAnalysis,
    WEIGHTS,
    SENSITIVITY,
    CAMERA_EVIDENCE_SCORE,
    onnxScoreFromProbability,
    c2paScoreFromMeta,
    deterministicVerdict,
    combineScores,
  };
});
