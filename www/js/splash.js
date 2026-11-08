// Splash window: version and tagline in the UI language.
const invoke = window.__TAURI__?.core?.invoke;

const TEXT = {
  hu: { tag: 'FTP, SFTP, S3 és OneDrive kliens', status: 'Betöltés…' },
  en: { tag: 'FTP, SFTP, S3 and OneDrive client', status: 'Loading…' },
};

async function init() {
  if (!invoke) return;
  try {
    const s = await invoke('get_settings');
    const want = s.ui_language || 'auto';
    const lang = want === 'auto' ? (navigator.language.toLowerCase().startsWith('hu') ? 'hu' : 'en') : want === 'en' ? 'en' : 'hu';
    document.documentElement.lang = lang;
    document.getElementById('tag').textContent = TEXT[lang].tag;
    document.getElementById('status').textContent = TEXT[lang].status;
  } catch { /* keep the Hungarian defaults */ }
  try { document.getElementById('ver').textContent = 'v' + (await invoke('app_info')).version; } catch { /* no version */ }
}

init();
