/* global AIDContracts, AIDScoring, AIDWorkbench */
'use strict';
const C = AIDContracts, W = AIDWorkbench;
const $ = (id) => document.getElementById(id);
let settings = C.normalizeSettings(), items = [], selected = null, running = false, stopRequested = false;
let generation = 0, nextId = 1, claiming = false, claimAgain = false;
let workspaceWindowId = null;
const blobURLs = new Set();
const version = chrome.runtime.getManifest().version;
$('version').textContent = '版本 ' + version;
function status(message) { $('status').textContent = message; }
function el(tag, value, cls) { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (cls) node.className = cls; return node; }
function revoke(item) { if (item.blobURL) { URL.revokeObjectURL(item.blobURL); blobURLs.delete(item.blobURL); item.blobURL = null; } }
function add(item) {
  if (items.length >= C.MAX_BATCH_ITEMS) return false;
  if (item.kind === 'url' && items.some((x) => x.kind === 'url' && x.url === item.url)) return false;
  if (item.kind === 'file' && items.some((x) => x.kind === 'file' && x.fileKey === item.fileKey)) return false;
  items.push({ ...item, id: nextId++, state: 'queued' });
  return true;
}
function nameForURL(value) {
  try { const url = new URL(value); return decodeURIComponent(url.pathname.split('/').pop() || url.hostname).slice(0, 240); }
  catch (_) { return '网页图片'; }
}
function addURLs(entries) {
  let count = 0;
  for (const entry of entries.slice(0, C.MAX_BATCH_ITEMS)) {
    if (!C.normalizeAnalysisRequest({ type: C.MESSAGE.TOOL_ANALYZE, url: entry.url }, C.MESSAGE.TOOL_ANALYZE)) continue;
    if (add({ kind: 'url', url: entry.url, name: nameForURL(entry.url) })) count++;
  }
  render(); return count;
}
function addFiles(files) {
  let count = 0, invalid = 0;
  for (const file of Array.from(files).slice(0, C.MAX_BATCH_ITEMS)) {
    const allowed = /^image\/(png|jpeg|webp|gif|avif|bmp)$/i.test(file.type) ||
      (!file.type && /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name));
    if (!allowed || !file.size || file.size > C.MAX_FILE_BYTES) { invalid++; continue; }
    if (add({ kind: 'file', name: file.name.slice(0, 240), size: file.size, file,
      fileKey: file.name + ':' + file.size + ':' + file.lastModified })) count++;
  }
  status(`已加入 ${count} 张本地图片。${invalid ? invalid + ' 张格式或大小不受支持。' : ''}本次最多 50 张。`);
  render();
}
function render() {
  const list = $('task-list'); list.replaceChildren();
  for (const item of items) {
    const li = el('li'), button = el('button', undefined, 'task' + (item.id === selected ? ' selected' : ''));
    button.type = 'button'; button.dataset.id = item.id;
    button.setAttribute('aria-pressed', String(item.id === selected));
    const title = el('span', item.name, 'name');
    title.append(el('small', item.state === 'running' ? '检测中' : item.state === 'queued' ? '等待检测'
      : (item.result?.title || '检测未完成')));
    const label = item.state !== 'done' ? '—' : item.result.decidedBy === 'verified-provenance' ? 'AI'
      : item.result.decidedBy === 'declaration' ? '!' : item.result.score ?? '—';
    button.append(title, el('span', String(label), 'score ' + (item.result?.color || 'gray')));
    button.addEventListener('click', () => { selected = item.id; render(); });
    li.append(button); list.append(li);
  }
  const done = items.filter((x) => x.state === 'done').length;
  $('progress').textContent = `${items.length} 张图片，已完成 ${done} 张${running ? '，正在本地分析' : ''}`;
  $('start').disabled = running || !settings.enabled || !items.some((x) => x.state === 'queued');
  $('stop').disabled = !running || stopRequested;
  $('export-json').disabled = $('export-csv').disabled = done === 0;
  renderEvidence();
}
function renderEvidence() {
  const root = $('evidence'), item = items.find((x) => x.id === selected);
  root.replaceChildren();
  if (!item) { root.append(el('h2', '先选择一张图片'), el('p', '检测结果会分别解释模型、文件来源自述与签名核验。', 'muted')); return; }
  root.append(el('h2', item.name));
  if (!item.result) { root.append(el('p', item.state === 'running' ? '正在本地分析，请稍候。' : '等待开始检测。', 'muted')); return; }
  const r = item.result;
  root.append(el('div', r.decidedBy === 'verified-provenance' ? 'AI' : r.decidedBy === 'declaration' ? '!' : String(r.score ?? '—'), 'result-value ' + r.color));
  root.append(el('p', r.title, r.color), el('p', r.explanation, 'detail-note'));
  root.append(el('h3', '本地模型'), el('p', r.modelStatus === 'available'
    ? `模型分数 ${r.modelScore}，不是“真实概率”。低于 40 红色，40–60 黄色，高于 60 绿色；独立来源声明可能优先决定整体提示。`
    : r.modelIssue?.message || '本次没有可用的模型结果。'));
  if (r.modelIssue?.detail) root.append(el('p', r.modelIssue.detail, 'detail-note'));
  root.append(el('h3', '来源签名'), el('p', W.STATUSES[r.provenance.status]));
  if (r.provenance.issuer) root.append(el('p', '声明中的签发方：' + r.provenance.issuer));
  if (r.provenance.errors.length) root.append(el('p', '核验记录：' + r.provenance.errors.join('、'), 'detail-note'));
  root.append(el('h3', '文件来源自述'));
  if (r.declarations.length) { const list = el('ul'); for (const reason of r.declarations) list.append(el('li', reason)); root.append(list, el('p', '以上为文件自述，字段可被修改，不等同于已验证来源。', 'detail-note')); }
  else root.append(el('p', '未取得可展示的 AI 生成参数或来源自述。', 'muted'));
  root.append(el('h3', '官方手动核验'), el('p', '本地未核验 SynthID / Content Seal。打开入口不会自动附带图片或 URL；由你自己选择上传。', 'detail-note'));
  const links = el('div', undefined, 'official');
  for (const provider of W.OFFICIAL) { const link = el('a', provider.name); link.href = provider.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; links.append(link); }
  root.append(links, el('p', '未检出标识不代表真实；签名有效也不证明画面内容属实。', 'detail-note'));
  root.append(el('p', '检测时间：' + new Date(item.checkedAt).toLocaleString() + '；依据检测当时的设置。', 'hint'));
  const retry = el('button', '重新检测', 'secondary'); retry.disabled = running || !settings.enabled;
  retry.addEventListener('click', () => {
    if (item.kind === 'file' && !item.file) { status('原始文件已释放，请重新选择文件。'); return; }
    item.state = 'queued'; item.result = null; render(); run();
  }); root.append(retry);
}
async function run() {
  if (running || !settings.enabled) { if (!settings.enabled) status('扩展已暂停，请先在设置中启用。'); return; }
  running = true; stopRequested = false;
  const epoch = generation;
  try {
    while (!stopRequested && settings.enabled && epoch === generation) {
      const item = items.find((x) => x.state === 'queued'); if (!item) break;
      item.state = 'running'; selected = item.id; render();
      let remote;
      try {
        if (item.kind === 'file') { item.blobURL = URL.createObjectURL(item.file); blobURLs.add(item.blobURL); }
        remote = await chrome.runtime.sendMessage({ type: item.kind === 'file' ? C.MESSAGE.LOCAL_ANALYZE : C.MESSAGE.TOOL_ANALYZE,
          url: item.kind === 'file' ? item.blobURL : item.url });
      } catch (error) { remote = { ok: false, errorCode: 'analysis-unavailable', error: String(error.message || error).slice(0, 160) }; }
      finally { revoke(item); }
      if (epoch !== generation || !items.includes(item)) break;
      const used = C.normalizeSettings(remote?.settingsUsed || settings);
      item.result = W.evidence(AIDScoring.scoreAnalysis(remote, used));
      item.checkedAt = new Date().toISOString(); item.settings = used; item.version = version; item.state = 'done';
      render();
    }
  } finally {
    running = false;
    if (epoch === generation) status(stopRequested ? '已停止后续任务；已完成的结果仍可导出。' : '本次本地检测已完成。模型结果仅供参考。');
    render();
  }
}
async function claimTasks() {
  if (document.hidden) return;
  if (claiming) { claimAgain = true; return; }
  claiming = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: C.MESSAGE.TAKE_TASKS, windowId: workspaceWindowId });
    if (response?.error) status(response.error);
    if (response?.tasks?.length) { addURLs(response.tasks); void run(); }
  } catch (_) { status('右键任务读取失败，可在原图上重试或手动选择文件。'); }
  finally { claiming = false; if (claimAgain) { claimAgain = false; void claimTasks(); } }
}
async function collectPage() {
  try {
    const chosen = $('source-tab').value;
    const tab = chosen ? await chrome.tabs.get(Number(chosen)) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab || tab.url?.startsWith('chrome-extension:')) { await refreshTabs(); throw new Error('请从网页列表选择一个页面，再列出图片。'); }
    const response = await chrome.tabs.sendMessage(tab.id, { type: C.MESSAGE.LIST_IMAGES });
    if (!response?.images) throw new Error('该页面暂不支持读取，请刷新普通网页后重试。');
    const count = addURLs(response.images); status(`加入 ${count} 张网页图片，点击“开始检测”进行本地分析。`);
  } catch (error) { status(error.message || '无法列出图片。可右键检测单图或选择本地文件。'); }
}
async function refreshTabs() {
  try {
    const selectedTab = $('source-tab').value;
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const options = [el('option', '当前活动网页')]; options[0].value = '';
    for (const tab of tabs.filter((x) => /^(https?|file):/.test(x.url || ''))) {
      const option = el('option', (tab.title || new URL(tab.url).hostname || '本地网页').slice(0, 100));
      option.value = String(tab.id); options.push(option);
    }
    $('source-tab').replaceChildren(...options);
    if (options.some((x) => x.value === selectedTab)) $('source-tab').value = selectedTab;
  } catch (_) { /* 仍可使用活动网页或本地文件。 */ }
}
function download(format) {
  const content = W.serialize(items, format, { includeURLs: $('include-urls').checked });
  const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'ai-image-report-' + new Date().toISOString().slice(0, 10) + '.' + format;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  status('报告已生成，不含图片像素；请留意浏览器的下载提示。');
}
$('files').addEventListener('change', (event) => { addFiles(event.target.files); event.target.value = ''; });
const drop = $('drop-zone');
for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('dragging'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); drop.classList.remove('dragging'); addFiles(event.dataTransfer.files); });
drop.addEventListener('keydown', (event) => { if (event.target === drop && ['Enter', ' '].includes(event.key)) { event.preventDefault(); $('files').click(); } });
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
$('start').addEventListener('click', run);
$('stop').addEventListener('click', () => { stopRequested = true; status('当前图片完成后停止，不再启动后续任务。'); render(); });
$('clear').addEventListener('click', () => { generation++; stopRequested = true; items.forEach(revoke); items = []; selected = null; status('结果已清空。'); render(); });
$('collect-page').addEventListener('click', collectPage);
$('source-tab').addEventListener('focus', refreshTabs);
$('export-json').addEventListener('click', () => download('json'));
$('export-csv').addEventListener('click', () => download('csv'));
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === C.MESSAGE.TASKS_CHANGED && C.senderRole(sender, chrome.runtime) === 'background' &&
      (!Number.isInteger(message.windowId) || message.windowId === workspaceWindowId)) claimTasks();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void claimTasks(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const next = C.applySettingsChanges(settings, changes); if (next) { settings = next; if (!settings.enabled) stopRequested = true; render(); }
});
window.addEventListener('pagehide', () => { generation++; stopRequested = true; for (const url of blobURLs) URL.revokeObjectURL(url); blobURLs.clear(); });
(async () => {
  try { workspaceWindowId = (await chrome.windows.getCurrent()).id; } catch (_) {}
  try { settings = C.normalizeSettings(await chrome.runtime.sendMessage({ type: C.MESSAGE.SETTINGS })); }
  catch (_) { status('设置暂时不可用，可重新打开工作台重试。'); }
  render(); await refreshTabs(); await claimTasks();
})();
