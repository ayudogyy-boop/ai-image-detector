// Options page script
const { DEFAULTS, normalizeSettings } = AIDContracts;
document.getElementById('s-hoverDelay').replaceChildren(...AIDContracts.HOVER_DELAYS.map((delay) => {
  const option = document.createElement('option');
  option.value = String(delay);
  option.textContent = `${delay / 1000} 秒`;
  return option;
}));
document.getElementById('s-badgeTheme').replaceChildren(...Object.entries(AIDContracts.BADGE_THEMES).map(([value, label]) => {
  const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
}));
document.getElementById('s-badgeSize').replaceChildren(...AIDContracts.BADGE_SIZES.map((value) => {
  const option = document.createElement('option'); option.value = String(value); option.textContent = value + ' px'; return option;
}));

const fields = [
  'enabled', 'hoverDelay', 'showOnHover', 'showOnMobile', 'badgeTheme', 'badgeSize', 'reduceMotion'
];

async function load() {
  const settings = normalizeSettings(await chrome.storage.sync.get(DEFAULTS));
  for (const key of fields) {
    const el = document.getElementById(`s-${key}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = settings[key];
    else el.value = settings[key];
  }
  // Signal toggles
  for (const [key, val] of Object.entries(settings.signals || {})) {
    const el = document.getElementById(`sig-${key}`);
    if (el) el.checked = val;
  }
  document.getElementById('s-excludedHosts').value = settings.excludedHosts.join('\n');
}

async function save() {
  const settings = {};
  for (const key of fields) {
    const el = document.getElementById(`s-${key}`);
    if (!el) continue;
    settings[key] = el.type === 'checkbox' ? el.checked : el.value;
  }
  // Numeric conversion
  const delay = Number(settings.hoverDelay);
  settings.hoverDelay = delay;
  settings.badgeSize = Number(settings.badgeSize);
  settings.excludedHosts = document.getElementById('s-excludedHosts').value.split(/[\s,，]+/).filter(Boolean);

  settings.signals = {};
  for (const key of Object.keys(DEFAULTS.signals)) {
    const el = document.getElementById(`sig-${key}`);
    settings.signals[key] = el ? el.checked : true;
  }

  // 只写本页编辑的字段，保留旧版敏感度及移动端延时。
  const normalized = normalizeSettings(settings);
  await chrome.storage.sync.set(Object.fromEntries([...fields, 'signals', 'excludedHosts'].map((key) => [key, normalized[key]])));

  const status = document.getElementById('save-status');
  status.textContent = '✓ 已保存';
  setTimeout(() => { status.textContent = ''; }, 2000);
}

async function reset() {
  await chrome.storage.sync.set(DEFAULTS);
  await load();
  const status = document.getElementById('save-status');
  status.textContent = '✓ 已恢复默认';
  setTimeout(() => { status.textContent = ''; }, 2000);
}

document.addEventListener('DOMContentLoaded', load);
document.getElementById('save-btn').addEventListener('click', save);
document.getElementById('reset-btn').addEventListener('click', reset);
