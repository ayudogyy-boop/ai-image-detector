// Options page script
const DEFAULTS = {
  enabled: true,
  hoverDelay: 3000,
  mobileDetectDelay: 3000,
  showOnHover: true,
  showOnMobile: true,
  signals: {
    onnx: true,
    c2pa: true,
    fileinfo: true,
    exif: true
  }
};

const fields = [
  'enabled', 'hoverDelay', 'showOnHover', 'showOnMobile'
];

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
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
  settings.hoverDelay = [500, 1000, 1500, 2000, 3000].includes(delay) ? delay : DEFAULTS.hoverDelay;

  settings.signals = {};
  for (const key of Object.keys(DEFAULTS.signals)) {
    const el = document.getElementById(`sig-${key}`);
    settings.signals[key] = el ? el.checked : true;
  }

  await chrome.storage.sync.set(settings);

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
