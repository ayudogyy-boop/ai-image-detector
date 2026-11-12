// Popup script
(async function() {
  const toggleEnabled = document.getElementById('toggle-enabled');
  const summaryArea = document.getElementById('summary-area');

  document.querySelector('.version').textContent = 'v' + chrome.runtime.getManifest().version;

  // Load settings
  const settings = AIDContracts.normalizeSettings(await chrome.runtime.sendMessage({ type: AIDContracts.MESSAGE.SETTINGS }));
  toggleEnabled.checked = settings.enabled !== false;

  // Toggle handler
  toggleEnabled.addEventListener('change', async () => {
    const enabled = toggleEnabled.checked;
    await chrome.storage.sync.set({ enabled });
  });

  // Try to get page analysis summary from content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, { type: AIDContracts.MESSAGE.SUMMARY });
    if (response && response.summary) {
      const s = response.summary;
      summaryArea.innerHTML = `
        <div class="summary-stat"><span class="label">已检查图片</span><span class="value">${s.total}</span></div>
        <div class="summary-stat"><span class="label green">🟢 模型偏非 AI</span><span class="value green">${s.green}</span></div>
        <div class="summary-stat"><span class="label yellow">🟡 不确定</span><span class="value yellow">${s.yellow}</span></div>
        <div class="summary-stat"><span class="label red">🔴 AI 线索 / 已验证声明</span><span class="value red">${s.red}</span></div>
        <div class="summary-stat"><span class="label">⚪ 未完成 / 已关闭</span><span class="value">${s.unavailable || 0}</span></div>
      `;
    }
  } catch(_) {
    // Content script not loaded or no data — show default
  }

  // Open options page
  document.getElementById('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
