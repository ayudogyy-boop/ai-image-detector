// 延迟加载本地 SDK。无远端清单、OCSP、遥测或图片上传。
(function () {
  let runtime = null;
  const localURL = (p) => typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(p) : new URL('/' + p, location.href).href;
  function stop(state, error) {
    if (state.stopped) return;
    state.stopped = true;
    state.controller.abort();
    state.engine?.dispose();
    for (const reject of state.waiters) reject(error);
    state.waiters.clear();
    // 旧请求的迟到结果不能撤销已经重建的运行时。
    if (runtime === state) runtime = null;
  }
  function loadRuntime() {
    const state = { stopped: false, engine: null, controller: new AbortController(), waiters: new Set() };
    state.ready = (async () => {
      const sdk = await import(localURL('lib/c2pa/index.mjs'));
      const base = localURL('lib/c2pa/');
      const [anchors, tsa] = await Promise.all(['C2PA-TRUST-LIST.pem', 'C2PA-TSA-TRUST-LIST.pem'].map(async (name) => {
        const r = await fetch(base + name, { signal: state.controller.signal });
        if (!r.ok) throw new Error('trust snapshot unavailable');
        return r.text();
      }));
      const context = new sdk.Context({ trust: { trustAnchors: anchors + '\n' + tsa }, verify: {
        verifyAfterReading: true, verifyTrust: true, verifyTimestampTrust: true,
        ocspFetch: false, remoteManifestFetch: false,
      } });
      const engine = await sdk.createC2pa({ wasmSrc: base + 'c2pa_bg.wasm', workerSrc: new URL(base + 'c2pa_worker.js') });
      if (state.stopped) { engine.dispose(); throw new Error('c2pa-runtime-stopped'); }
      state.engine = engine;
      return { sdk, engine, context };
    })();
    return state;
  }
  async function verify(bytes, mime) {
    // loadRuntime 只构造状态，不等待 SDK。并发调用共用一个失败通知。
    if (!runtime) runtime = loadRuntime();
    const state = runtime;
    let rejectTask;
    const failed = new Promise((_, reject) => { rejectTask = reject; });
    state.waiters.add(rejectTask);
    let timer;
    try {
      timer = setTimeout(() => stop(state, new Error('c2pa-timeout')), 15000);
      return await Promise.race([failed, (async () => {
        const { sdk, engine, context } = await state.ready;
        if (state.stopped) throw new Error('c2pa-runtime-stopped');
        let reader = null;
        try {
          reader = await sdk.Reader.fromBlob(engine, mime || undefined, new Blob([bytes], { type: mime || '' }), context);
          if (state.stopped) throw new Error('c2pa-runtime-stopped');
          return reader ? AIDProvenance.summarizeStore(await reader.manifestStore()) : { status: 'not-present', aiDisclosure: false };
        } finally {
          if (reader && !state.stopped) await reader.free().catch(() => {});
        }
      })()]);
    } catch (err) {
      if (!state.engine) stop(state, err);
      return { status: 'unavailable', aiDisclosure: false, error: String(err?.message || err).slice(0, 160) };
    } finally {
      clearTimeout(timer);
      state.waiters.delete(rejectTask);
    }
  }
  self.AIDC2PA = { verify };
})();
