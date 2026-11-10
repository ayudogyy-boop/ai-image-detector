// 仅解释 SDK 已验证的 active manifest；不从品牌词猜测来源。
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.AIDProvenance = api;
})(function () {
  'use strict';
  const AI_TYPES = new Set(['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia', 'trainedAlgorithmicData']);
  function sourceType(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^https?:\/\/(?:cv\.iptc\.org\/newscodes|c2pa\.org)\/digitalsourcetype\/([^/?#]+)$/);
    return match ? match[1] : null;
  }
  function summarizeStore(store) {
    if (!store || !store.active_manifest) return { status: 'not-present', aiDisclosure: false };
    const active = store.manifests && Object.hasOwn(store.manifests, store.active_manifest) ? store.manifests[store.active_manifest] : null;
    if (!active) return { status: 'invalid', aiDisclosure: false, errors: ['active-manifest-missing'] };
    const rawState = String(store.validation_state || '').toLowerCase();
    const status = ['trusted', 'valid', 'invalid'].includes(rawState) ? rawState : 'unavailable';
    const types = new Set(), actions = [];
    for (const assertion of active.assertions || []) {
      if (!/^c2pa\.actions(?:\.v\d+)?$/.test(assertion.label)) continue;
      for (const action of assertion.data?.actions || []) {
        if (typeof action.action === 'string') actions.push(action.action);
        const type = sourceType(action.digitalSourceType);
        if (type) types.add(type);
      }
    }
    const valid = status === 'trusted' || status === 'valid';
    const aiDisclosure = valid && [...types].some((t) => AI_TYPES.has(t));
    const signature = active.signature_info || {};
    const clip = (v) => typeof v === 'string' ? v.slice(0, 160) : null;
    return {
      status, aiDisclosure,
      aiKind: aiDisclosure ? (types.has('compositeWithTrainedAlgorithmicMedia') ? 'edited' : 'generated') : null,
      issuer: clip(signature.common_name || signature.issuer),
      generator: clip(active.claim_generator_info?.[0]?.name || active.claim_generator),
      signedAt: clip(signature.time),
      digitalSourceTypes: [...types].slice(0, 20), actions: actions.slice(0, 30),
      errors: (store.validation_results?.activeManifest?.failure || []).map((s) => clip(s.code)).filter(Boolean).slice(0, 12),
      // 仅代表完整资产绑定和签名；不代表画面真实，不包含在线吊销查询。
      offline: true,
    };
  }
  return { sourceType, summarizeStore };
});
