// FtpStar – two-pane FTP / SFTP / S3 / OneDrive client.
// Every tab is one connection: local files on the left, remote on the right.

import { t, setLang, getLang } from './i18n.js';
import {
  invoke, h, icon, toast, modal, confirmDlg, formDlg, contextMenu, editMenu, fmtDate,
  initUiState, uiGet, uiSet, splitter, debounce,
} from './util.js';

const listen = (ev, cb) => window.__TAURI__.event.listen(ev, cb);

const S = {
  settings: null,
  sites: [],
  local: { home: '/', roots: ['/'], sep: '/' },
  tabs: [],
  active: -1,
  queue: [],
  queueOpen: true,
  watches: [],
  busy: 0,
  info: { version: '' },
  donationVisible: false,
  update: null,
  /** FtpStar's own clipboard: {cut, side, tabId, session, dir, items, names} */
  clip: null,
};

export const PROTOS = {
  ftp: { label: 'FTP', icon: 'server', port: 21 },
  ftps: { label: 'FTPS (explicit TLS)', icon: 'lock', port: 21 },
  'ftps-implicit': { label: 'FTPS (implicit TLS)', icon: 'lock', port: 990 },
  sftp: { label: 'SFTP (SSH)', icon: 'key', port: 22 },
  s3: { label: 'Amazon S3', icon: 'bucket', port: 0 },
  onedrive: { label: 'Microsoft OneDrive', icon: 'cloud', port: 0 },
};
const TAB_COLORS = ['', '#4c8dff', '#3fbf74', '#e3a33a', '#ef5d5d', '#b65cf0', '#22d3ee', '#e05577'];

const cur = () => S.tabs[S.active] || null;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ───────────────────────── formatting ─────────────────────────

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
const fmtSpeed = (bps) => (bps > 0 ? fmtSize(bps) + '/s' : '');
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return Math.ceil(sec) + ' s';
  if (sec < 3600) return Math.floor(sec / 60) + ' min ' + Math.floor(sec % 60) + ' s';
  return Math.floor(sec / 3600) + ' h ' + Math.floor((sec % 3600) / 60) + ' min';
}

/** Readable text for the backend's error codes. */
function friendly(e) {
  const s = String(e);
  if (s === 'AUTH_FAILED') return t('Sikertelen bejelentkezés: hibás felhasználónév, jelszó vagy kulcs.');
  if (s === 'NOT_CONNECTED') return t('Nincs kapcsolat. Kapcsolódj újra.');
  if (s === 'CANCELLED') return t('Megszakítva');
  if (s === 'ONEDRIVE_NO_CLIENT_ID') return t('A OneDrive-hoz add meg az Azure alkalmazás azonosítóját a Beállításokban.');
  if (s.startsWith('ONEDRIVE_SIGN_IN')) return t('Jelentkezz be a OneDrive-ba az Oldalkezelőben.') + (s.includes(':') ? '\n' + s.split(':').slice(1).join(':') : '');
  return s;
}

// ───────────────────────── paths ─────────────────────────

const isWin = () => S.local.sep === '\\';
function localJoin(dir, name) {
  if (!dir) return name; // drive list
  return /[\\/]$/.test(dir) ? dir + name : dir + S.local.sep + name;
}
function localParent(p) {
  if (!p) return null;
  if (isWin()) {
    if (/^[A-Za-z]:\\?$/.test(p)) return ''; // drive root → drive list
    const s = p.replace(/\\+$/, '');
    const i = s.lastIndexOf('\\');
    if (i < 0) return '';
    return i === 2 ? s.slice(0, 3) : s.slice(0, i);
  }
  if (p === '/') return null;
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}
const remoteJoin = (dir, name) => (dir.endsWith('/') ? dir + name : dir + '/' + name);
function remoteParent(p) {
  if (!p || p === '/') return null;
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}
const sideJoin = (side, dir, name) => (side === 'local' ? localJoin(dir, name) : remoteJoin(dir, name));
const sideParent = (side, p) => (side === 'local' ? localParent(p) : remoteParent(p));
/** "a/b/c.txt" under a folder of the given side */
const sideJoinRel = (side, dir, rel) => rel.split('/').reduce((d, part) => sideJoin(side, d, part), dir);

// ───────────────────────── busy indicator ─────────────────────────

let busyTimer;
function setBusy(on) {
  S.busy = Math.max(0, S.busy + (on ? 1 : -1));
  const bar = document.getElementById('busybar');
  clearTimeout(busyTimer);
  if (S.busy > 0) busyTimer = setTimeout(() => bar.classList.add('on'), 150);
  else bar.classList.remove('on');
}
async function busy(fn) {
  setBusy(true);
  try { return await fn(); } finally { setBusy(false); }
}

// ───────────────────────── settings ─────────────────────────

const saveSettings = debounce(() => invoke('save_settings', { settings: S.settings }).catch((e) => toast(e, 'err')), 300);
const saveSites = () => invoke('save_sites', { sites: S.sites }).catch((e) => toast(e, 'err'));

function applyLang() {
  setLang(S.settings.ui_language === 'auto' ? '' : S.settings.ui_language);
  invoke('set_ui_language', { lang: getLang() }).catch(() => {});
}
function applyTheme() {
  let th = S.settings.theme || 'dark';
  if (th === 'system') th = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = th;
  document.documentElement.style.setProperty('--font-size', (S.settings.font_size || 13) + 'px');
}
const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
function applyZoom() { invoke('set_zoom', { scale: S.settings.zoom || 1 }).catch(() => {}); }
function stepZoom(d) {
  const z = S.settings.zoom || 1;
  let i = ZOOMS.findIndex((x) => x >= z - 0.001);
  if (i < 0) i = 2;
  S.settings.zoom = d === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + d))];
  applyZoom(); saveSettings(); renderStatus();
}

function rememberTabs() {
  S.settings.open_sites = S.tabs.filter((tb) => S.sites.some((s) => s.id === tb.site.id)).map((tb) => tb.site.id);
  saveSettings();
}

// ───────────────────────── tabs & connections ─────────────────────────

function newPane(side, path) {
  return { side, path, view: uiGet('fs.view.' + side) || 'details', entries: [], sel: new Set(), anchor: null, cursor: null, sort: { key: 'name', asc: true }, filter: '', back: [], loading: false, error: null };
}

function openTab(site, { connect = true } = {}) {
  const tab = {
    id: uid(), site: { ...site }, session: null, status: 'offline', error: null, compare: false, focus: 'remote',
    local: newPane('local', site.local_dir || S.settings.last_local_dir || S.local.home),
    remote: newPane('remote', site.remote_dir || '/'),
  };
  S.tabs.push(tab);
  S.active = S.tabs.length - 1;
  rememberTabs();
  renderAll();
  listPane(tab, 'local');
  if (connect) connectTab(tab);
  return tab;
}

/** Closing a tab asks first: the × is easy to hit by accident. */
async function closeTab(i) {
  const tab = S.tabs[i];
  if (!tab) return;
  const running = S.queue.filter((j) => j.tabId === tab.id && (j.status === 'running' || j.status === 'queued'));
  const ok = running.length
    ? await confirmDlg(t('Fül bezárása'), t('Bezárod a(z) „{0}” fület?\n{1} átvitel még fut vagy várakozik ezen a kapcsolaton, ezek megszakadnak.', tab.site.name || tab.site.host, running.length), t('Bezárás'), true)
    : await confirmDlg(t('Fül bezárása'), t('Bezárod a(z) „{0}” fület?\nA kapcsolat bontódik, az oldal az Oldalkezelőben megmarad.', tab.site.name || tab.site.host), t('Bezárás'));
  if (!ok) return;
  i = S.tabs.indexOf(tab);
  if (i < 0) return;
  for (const j of running) cancelJob(j);
  S.watches = S.watches.filter((w) => w.tabId !== tab.id);
  if (tab.session) invoke('disconnect', { session: tab.session }).catch(() => {});
  S.tabs.splice(i, 1);
  if (S.active >= S.tabs.length) S.active = S.tabs.length - 1;
  rememberTabs();
  renderAll();
}

function activate(i) {
  S.active = i;
  renderAll();
}

/** Asks for the password when the site has none saved. Returns null on cancel. */
async function askPassword(tab) {
  const p = tab.site.protocol;
  if (p === 'onedrive' || tab.site.password) return '';
  if (p === 'sftp' && !tab.askPass) return ''; // keys are tried first
  const pw = h('input.inp', { type: 'password', spellcheck: 'false' });
  const save = h('input', { type: 'checkbox' });
  const saved = S.sites.some((s) => s.id === tab.site.id);
  const res = await modal({
    title: t('Jelszó – {0}', tab.site.name || tab.site.host),
    body: h('div',
      h('label.field', h('span', p === 's3' ? t('Titkos kulcs (secret access key)') : t('Jelszó ({0}@{1})', tab.site.user || 'anonymous', tab.site.host)), pw),
      saved ? h('label.chk', { style: { marginTop: '10px' } }, save, t('Mentés az oldalhoz')) : null),
    buttons: [{ label: t('Mégse'), value: null }, { label: t('Kapcsolódás'), value: () => ({ pw: pw.value, save: save.checked }), primary: true }],
  });
  if (!res) return null;
  if (res.save) {
    tab.site.password = res.pw;
    const s = S.sites.find((x) => x.id === tab.site.id);
    if (s) { s.password = res.pw; saveSites(); }
  }
  return res.pw;
}

/** What is missing for a connection, or null. */
function siteProblem(s) {
  if (['ftp', 'ftps', 'ftps-implicit', 'sftp'].includes(s.protocol) && !s.host.trim()) return t('Nincs megadva a szerver címe.');
  if (s.protocol === 's3' && !s.s3_bucket.trim()) return t('Nincs megadva a bucket neve.');
  if (s.protocol === 'onedrive' && !s.onedrive_refresh_token) return t('Jelentkezz be a OneDrive-ba az Oldalkezelőben.');
  return null;
}

async function connectTab(tab, accept = null, password = null) {
  if (tab.status === 'connecting') return;
  const problem = siteProblem(tab.site);
  if (problem) {
    tab.error = problem;
    renderAll();
    toast(problem, 'err');
    if (S.sites.some((x) => x.id === tab.site.id)) siteManager(tab.site.id);
    return;
  }
  if (password == null) {
    password = await askPassword(tab);
    if (password == null) { tab.status = 'offline'; renderAll(); return; }
  }
  tab.status = 'connecting';
  tab.error = null;
  renderAll();
  try {
    const r = await busy(() => invoke('connect', { site: tab.site, password, acceptFingerprint: accept }));
    tab.session = r.session;
    tab.status = 'connected';
    tab.askPass = false;
    tab.remote.path = r.home || '/';
    tab.remote.back = [];
    renderAll();
    await listPane(tab, 'remote');
  } catch (e) {
    const s = String(e);
    tab.status = 'offline';
    if (s.startsWith('HOSTKEY_UNKNOWN:')) {
      const fp = s.slice('HOSTKEY_UNKNOWN:'.length);
      const ok = await confirmDlg(t('Ismeretlen szerver'),
        t('Először kapcsolódsz ehhez a szerverhez: {0}\n\nA szerver kulcsának ujjlenyomata:\n{1}\n\nHa ez megegyezik a szerver valódi kulcsával, fogadd el. Az FtpStar megjegyzi, és legközelebb nem kérdez.', `${tab.site.host}:${tab.site.port || 22}`, fp),
        t('Elfogadás és kapcsolódás'));
      if (ok) return connectTab(tab, fp, password);
    } else if (s.startsWith('HOSTKEY_CHANGED:')) {
      await modal({ title: t('FIGYELEM: megváltozott a szerver kulcsa!'), body: h('div.desc',
        t('A(z) {0} szerver kulcsa nem egyezik az elmentettel.\nÚj ujjlenyomat: {1}\n\nEz lehet szándékos (újratelepített szerver), de jelenthet lehallgatási kísérletet is. Az FtpStar nem kapcsolódik. Ha biztos vagy benne, hogy a változás rendben van, töröld a szervert a known_hosts.json-ból a beállítások mappájában.', tab.site.host, s.slice(16))),
        buttons: [{ label: 'OK', value: true, primary: true }] });
    } else if (s === 'AUTH_FAILED' && tab.site.protocol === 'sftp' && !tab.site.password && !tab.askPass) {
      tab.askPass = true; // the keys did not work: try a password
      tab.status = 'offline';
      return connectTab(tab);
    } else {
      tab.error = friendly(e);
      toast(t('Kapcsolódás sikertelen – {0}:\n{1}', tab.site.name || tab.site.host, tab.error), 'err');
    }
    renderAll();
  }
}

async function disconnectTab(tab) {
  if (tab.session) await invoke('disconnect', { session: tab.session }).catch(() => {});
  tab.session = null;
  tab.status = 'offline';
  tab.remote.entries = [];
  renderAll();
}

// ───────────────────────── listing ─────────────────────────

async function listPane(tab, side, { keepSel = true } = {}) {
  const pane = tab[side];
  if (side === 'remote' && !tab.session) { renderPane(tab, side); return; }
  pane.loading = true;
  pane.error = null;
  if (tab === cur()) renderPaneHead(tab, side);
  setBusy(true);
  try {
    let entries;
    if (side === 'local') {
      entries = pane.path === '' ? S.local.roots.map((r) => ({ name: r, dir: true, size: 0, mtime: null, drive: true }))
        : await invoke('local_list', { path: pane.path, showHidden: !!S.settings.show_hidden });
      if (pane.path) { S.settings.last_local_dir = pane.path; saveSettings(); }
    } else {
      entries = await invoke('remote_list', { session: tab.session, path: pane.path });
      if (!S.settings.show_hidden) entries = entries.filter((e) => !e.name.startsWith('.'));
    }
    pane.entries = entries;
    if (keepSel) { const names = new Set(entries.map((e) => e.name)); pane.sel = new Set([...pane.sel].filter((n) => names.has(n))); }
    else pane.sel.clear();
  } catch (e) {
    pane.entries = [];
    pane.error = friendly(e);
    if (side === 'remote' && String(e) === 'NOT_CONNECTED') { tab.session = null; tab.status = 'offline'; }
  } finally {
    pane.loading = false;
    setBusy(false);
  }
  if (tab === cur()) { renderPane(tab, side); renderStatus(); renderToolbar(); }
}

function navigate(tab, side, path, { push = true } = {}) {
  const pane = tab[side];
  if (path == null) return;
  if (push && pane.path !== path) pane.back.push(pane.path);
  const from = pane.path;
  pane.path = path;
  pane.sel.clear();
  pane.filter = '';
  // going up: put the cursor on the folder we came from
  pane.cursor = sideParent(side, from) === path ? lastName(side, from) : null;
  listPane(tab, side, { keepSel: false });
}
const lastName = (side, p) => (side === 'local' && isWin() && /^[A-Za-z]:\\?$/.test(p) ? p.replace(/\\?$/, '\\') : p.replace(/[\\/]+$/, '').split(/[\\/]/).pop());
const goUp = (tab, side) => { const p = sideParent(side, tab[side].path); if (p != null) navigate(tab, side, p); };
function goBack(tab, side) {
  const pane = tab[side];
  const p = pane.back.pop();
  if (p != null) navigate(tab, side, p, { push: false });
}

// ───────────────────────── visible rows ─────────────────────────

function filterRe(f) {
  if (!f) return null;
  const esc = f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(f.includes('*') || f.includes('?') ? `^${esc}$` : esc, 'i');
}

function visibleEntries(pane) {
  const re = filterRe(pane.filter);
  const list = re ? pane.entries.filter((e) => re.test(e.name)) : pane.entries.slice();
  const { key, asc } = pane.sort;
  const dir = asc ? 1 : -1;
  list.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    let c = 0;
    if (key === 'size') c = (a.size || 0) - (b.size || 0);
    else if (key === 'mtime') c = (a.mtime || 0) - (b.mtime || 0);
    else if (key === 'ext') c = ext(a.name).localeCompare(ext(b.name));
    if (!c) c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return c * dir;
  });
  return list;
}
const ext = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };

/** Compare mode: how a row differs from the same name on the other side. */
function compareMark(tab, side, e) {
  if (!tab.compare || !tab.session) return '';
  const other = tab[side === 'local' ? 'remote' : 'local'];
  const o = other.entries.find((x) => x.name === e.name && x.dir === e.dir);
  if (!o) return 'only';
  if (e.dir) return '';
  if (e.size !== o.size) return (e.mtime || 0) > (o.mtime || 0) ? 'newer' : 'diff';
  return (e.mtime || 0) > (o.mtime || 0) + 60 ? 'newer' : 'same';
}

// ───────────────────────── rendering: shell ─────────────────────────

function renderAll() {
  renderTabs();
  renderToolbar();
  renderMain();
  renderQueue();
  renderStatus();
  const tab = cur();
  document.title = tab ? `FtpStar — ${tab.site.name || tab.site.host}` : 'FtpStar';
}

function statusDot(tab) {
  return h('span.cdot.' + tab.status, { title: { connected: t('Kapcsolódva'), connecting: t('Kapcsolódás…'), offline: t('Nincs kapcsolat') }[tab.status] });
}

function renderTabs() {
  const el = document.getElementById('tabs');
  el.replaceChildren(
    ...S.tabs.map((tab, i) => {
      const running = S.queue.filter((j) => j.tabId === tab.id && j.status === 'running').length;
      return h('div.tab' + (i === S.active ? '.active' : ''), {
        style: tab.site.color ? { '--tab-color': tab.site.color } : {},
        title: `${PROTOS[tab.site.protocol]?.label || ''} · ${tab.site.user ? tab.site.user + '@' : ''}${tab.site.host || tab.site.s3_bucket || tab.site.onedrive_account || ''}`,
        on: {
          mousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } },
          click: () => activate(i),
          contextmenu: (e) => contextMenu(e, [
            tab.session ? { label: t('Kapcsolat bontása'), icon: 'unplug', action: () => disconnectTab(tab) } : { label: t('Kapcsolódás'), icon: 'plug', action: () => connectTab(tab) },
            { label: t('Újrakapcsolódás'), icon: 'refresh', action: async () => { await disconnectTab(tab); connectTab(tab); } },
            { label: t('Fül duplikálása'), icon: 'copy', action: () => openTab(tab.site) },
            S.sites.some((s) => s.id === tab.site.id) ? { label: t('Oldal szerkesztése…'), icon: 'edit', action: () => siteManager(tab.site.id) } : null,
            '-',
            { label: t('Bezárás'), icon: 'close', action: () => closeTab(i) },
          ]),
        },
      }, tab.site.color ? h('span.tcolor') : null, statusDot(tab), icon(PROTOS[tab.site.protocol]?.icon || 'server'),
      h('span.name', tab.site.name || tab.site.host || '?'),
      running ? h('span.tab-changes', String(running)) : null,
      h('button.x', { title: t('Bezárás'), on: { click: (e) => { e.stopPropagation(); closeTab(i); } } }, icon('close')));
    }),
    h('button.tab-add', { title: t('Új kapcsolat (Oldalkezelő)'), on: { click: () => siteManager() } }, icon('plus')));
}

function tb(ic, label, action, { disabled = false, title = '', badge = null, cls = '' } = {}) {
  return h('button.tb' + cls, { disabled: disabled || null, title: title || label, on: { click: action } },
    icon(ic), h('span', label), badge ? h('span.badge', String(badge)) : null);
}

function renderToolbar() {
  const tab = cur();
  const on = !!tab?.session;
  const fp = tab ? tab[tab.focus] : null;
  const hasSel = !!fp && fp.sel.size > 0;
  const active = S.queue.filter((j) => j.status === 'running' || j.status === 'queued').length;
  document.getElementById('toolbar').replaceChildren(
    tb('server', t('Oldalak'), () => siteManager(), { title: t('Oldalkezelő (Ctrl+S)') }),
    tb('bolt', t('Gyors'), quickConnect, { title: t('Gyors kapcsolódás (Ctrl+Q)') }),
    h('div.tb-sep'),
    on ? tb('unplug', t('Bontás'), () => disconnectTab(tab))
      : tb('plug', t('Kapcsolódás'), () => tab && connectTab(tab), { disabled: !tab || tab.status === 'connecting' }),
    h('div.tb-sep'),
    tb('upload', t('Feltöltés'), () => transfer(tab, 'local'), { disabled: !on || !tab.local.sel.size, title: t('A kijelölt helyi elemek feltöltése (F5)') }),
    tb('download', t('Letöltés'), () => transfer(tab, 'remote'), { disabled: !on || !tab.remote.sel.size, title: t('A kijelölt távoli elemek letöltése (F5)') }),
    h('div.tb-sep'),
    tb('folderPlus', t('Új mappa'), () => mkdirDlg(tab, tab.focus), { disabled: !tab || (tab.focus === 'remote' && !on), title: t('Új mappa (F7)') }),
    tb('rename', t('Átnevezés'), () => renameDlg(tab, tab.focus), { disabled: !hasSel || fp.sel.size !== 1, title: t('Átnevezés (F2)') }),
    tb('trash', t('Törlés'), () => deleteSel(tab, tab.focus), { disabled: !hasSel, title: t('Törlés (Del)') }),
    tb('refresh', t('Frissítés'), () => { listPane(tab, 'local'); listPane(tab, 'remote'); }, { disabled: !tab, title: t('Frissítés (Ctrl+R)') }),
    h('div.tb-sep'),
    tb('sync', t('Csak újak'), () => syncNewDlg(tab, tab.focus), { disabled: !on, title: t('Csak az új fájlok átmásolása a kijelölt (aktív) oldalról a másikra, az almappákkal együtt; előtte megmutatja, mi kerül át') }),
    tb('compare', t('Összevetés'), () => { tab.compare = !tab.compare; renderAll(); }, { disabled: !on, cls: tab?.compare ? '.on' : '', title: t('A két oldal összevetése: hiányzó, eltérő és újabb fájlok kiemelése') }),
    tb('edit', t('Szerkesztés'), () => editRemote(tab), { disabled: !on || tab.focus !== 'remote' || fp.sel.size !== 1 || [...fp.entries].find((e) => fp.sel.has(e.name))?.dir, title: t('Távoli fájl megnyitása szerkesztésre; mentéskor automatikusan visszatöltődik') }),
    h('div.tb-spacer'),
    ...(S.donationVisible ? [h('span.tb-donate', tb('heart', t('Adomány'), () => openDonate(), { title: t('Az FtpStar ingyenes. Ha hasznos neked, egy kis adománnyal támogathatod a fejlesztést.') }))] : []),
    tb('queue', t('Átvitelek'), () => { S.queueOpen = !S.queueOpen; uiSet('fs.queueOpen', S.queueOpen ? '1' : '0'); renderQueue(); renderXferStatus(); }, { badge: active || null, cls: S.queueOpen ? '.on' : '' }),
    tb(document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun', t('Téma'), toggleTheme),
    tb('settings', t('Beállítások'), settingsDlg),
    tb('info', t('Névjegy'), aboutDlg),
  );
}

function toggleTheme() {
  S.settings.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(); saveSettings(); renderAll();
}

function renderMain() {
  const main = document.getElementById('main');
  const tab = cur();
  if (!tab) { main.replaceChildren(welcome()); return; }
  const left = paneShell(tab, 'local');
  const right = paneShell(tab, 'remote');
  const split = h('div.splitter-v');
  main.replaceChildren(left, split, right);
  splitter(split, left, { min: 260, max: 3000, key: 'fs.leftWidth' });
  renderPane(tab, 'local');
  renderPane(tab, 'remote');
}

function welcome() {
  const recent = S.sites.slice(0, 12);
  return h('div.welcome', h('div.welcome-box',
    h('h1', h('img', { src: 'img/icon.svg', alt: '' }), 'FtpStar'),
    h('div.lead', t('FTP, FTPS, SFTP, Amazon S3 és OneDrive kliens két panellel, átviteli sorral.')),
    h('div.actions',
      h('button.btn.primary', { on: { click: () => siteManager() } }, icon('server'), t('Oldalkezelő')),
      h('button.btn', { on: { click: quickConnect } }, icon('bolt'), t('Gyors kapcsolódás')),
      h('button.btn', { on: { click: () => siteManager(null, 'new') } }, icon('plus'), t('Új oldal'))),
    recent.length ? h('div.recent', ...recent.map((s) => h('div.recent-item', { on: { dblclick: () => openTab(s), click: () => openTab(s) } },
      s.color ? h('span.sdot', { style: { background: s.color } }) : icon(PROTOS[s.protocol]?.icon || 'server'),
      h('div', h('div', s.name || s.host), h('div.p', siteSubtitle(s))),
      h('span.x.p', PROTOS[s.protocol]?.label || '')))) : h('div.empty-sites', t('Még nincs mentett oldal. Hozz létre egyet az Oldalkezelőben.'))));
}

function siteSubtitle(s) {
  if (s.protocol === 's3') return `${s.s3_bucket || '?'} · ${s.s3_endpoint || s.s3_region || 'AWS'}`;
  if (s.protocol === 'onedrive') return s.onedrive_account || t('nincs bejelentkezve');
  return `${s.user ? s.user + '@' : ''}${s.host}${s.port ? ':' + s.port : ''}`;
}

// ───────────────────────── rendering: panes ─────────────────────────

const COLS = [
  { key: 'name', label: () => t('Név') },
  { key: 'size', label: () => t('Méret') },
  { key: 'mtime', label: () => t('Módosítva') },
  { key: 'perms', label: () => t('Jogok') },
];

function paneShell(tab, side) {
  const el = h('section.fpane.' + side + (tab.focus === side ? '.focus' : ''), {
    on: { mousedown: () => setFocus(tab, side) },
  });
  el.dataset.side = side;
  el.append(h('div.fp-head'), h('div.fp-cols'), h('div.fp-body', { tabindex: '0' }), h('div.fp-foot'));
  tab[side].el = el;
  wireBody(tab, side, el.querySelector('.fp-body'));
  return el;
}

function setFocus(tab, side) {
  if (tab.focus === side) return;
  tab.focus = side;
  tab.local.el?.classList.toggle('focus', side === 'local');
  tab.remote.el?.classList.toggle('focus', side === 'remote');
  renderToolbar();
}

const VIEWS = [
  ['details', 'viewList', () => t('Részletek')],
  ['small', 'viewSmall', () => t('Kis ikonok')],
  ['large', 'viewLarge', () => t('Nagy ikonok (képek előnézetével)')],
];
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|ico|svg)$/i;

/** Details, small icons or large icons; remembered for the side. */
function setView(tab, side, view) {
  const pane = tab[side];
  if (pane.view === view) return;
  pane.view = view;
  uiSet('fs.view.' + side, view);
  renderPane(tab, side);
  setFocus(tab, side);
}

// ── thumbnails: made in Rust, cached here, loaded as the tiles scroll into view ──
const thumbCache = new Map();
const thumbQueue = { local: [], remote: [] };
const thumbBusy = { local: 0, remote: 0 };
const THUMB_PARALLEL = { local: 4, remote: 2 };

function thumbKey(tab, side, e, px) {
  return `${side === 'remote' ? tab.site.id : ''}|${sideJoin(side, tab[side].path, e.name)}|${e.size}|${e.mtime}|${px}`;
}

function wantThumb(tab, side, e, px, img) {
  const key = thumbKey(tab, side, e, px);
  if (thumbCache.has(key)) { const v = thumbCache.get(key); if (v) showThumb(img, v); return; }
  const kind = side === 'remote' ? 'remote' : 'local';
  thumbQueue[kind].push({ tab, side, e, px, img, key, path: sideJoin(side, tab[side].path, e.name) });
  pumpThumbs(kind);
}

function showThumb(img, url) {
  img.src = url;
  img.closest('.ti')?.classList.add('has-thumb');
}

async function pumpThumbs(kind) {
  while (thumbBusy[kind] < THUMB_PARALLEL[kind] && thumbQueue[kind].length) {
    const job = thumbQueue[kind].pop(); // the newest first: what is on screen now
    if (!job.img.isConnected) continue;
    if (thumbCache.has(job.key)) { const v = thumbCache.get(job.key); if (v) showThumb(job.img, v); continue; }
    thumbBusy[kind]++;
    (async () => {
      let url = null;
      try {
        url = kind === 'local'
          ? await invoke('local_thumb', { path: job.path, size: job.px })
          : job.tab.session ? await invoke('remote_thumb', { session: job.tab.session, server: job.tab.site.id, path: job.path, fileSize: job.e.size || 0, mtime: job.e.mtime || 0, size: job.px }) : null;
      } catch { url = null; }
      if (job.tab.session || kind === 'local') thumbCache.set(job.key, url);
      if (url && job.img.isConnected) showThumb(job.img, url);
      thumbBusy[kind]--;
      pumpThumbs(kind);
    })();
  }
}

const thumbObserver = new IntersectionObserver((list) => {
  for (const it of list) {
    if (!it.isIntersecting) continue;
    thumbObserver.unobserve(it.target);
    it.target._want?.();
  }
}, { rootMargin: '200px' });

function renderPaneHead(tab, side) {
  const pane = tab[side];
  if (!pane.el) return;
  const head = pane.el.querySelector('.fp-head');
  const remote = side === 'remote';
  const title = remote ? (tab.site.name || tab.site.host) : t('Helyi gép');
  const pathInp = h('input.inp.fp-path', { value: pane.path || (isWin() ? t('Meghajtók') : '/'), spellcheck: 'false',
    on: { keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); let v = e.target.value.trim() || (remote ? '/' : ''); if (remote && !v.startsWith('/')) v = remoteJoin(pane.path, v); navigate(tab, side, v); } if (e.key === 'Escape') e.target.value = pane.path; } } });
  const filter = h('input.inp.fp-filter', { value: pane.filter, placeholder: t('Szűrő (pl. *.jpg)'), spellcheck: 'false',
    on: { input: (e) => { pane.filter = e.target.value; renderRows(tab, side); } } });
  head.replaceChildren(
    h('div.fp-title', icon(remote ? (PROTOS[tab.site.protocol]?.icon || 'server') : 'drive'), h('span.t', title),
      remote ? statusDot(tab) : null, pane.loading ? icon('refresh', 'spin') : null, h('span.grow'),
      remote && !tab.session && tab.status !== 'connecting' ? h('button.btn.sm.primary', { on: { click: () => connectTab(tab) } }, icon('plug'), t('Kapcsolódás')) : null,
      h('div.fp-views', VIEWS.map(([v, ic, label]) => h('button.icon-btn' + (pane.view === v ? '.on' : ''),
        { title: label(), on: { click: () => setView(tab, side, v) } }, icon(ic)))),
      filter),
    h('div.fp-nav',
      h('button.icon-btn', { title: t('Vissza (Alt+←)'), disabled: !pane.back.length || null, on: { click: () => goBack(tab, side) } }, icon('undo')),
      h('button.icon-btn', { title: t('Fel (Backspace)'), on: { click: () => goUp(tab, side) } }, icon('arrowUp')),
      h('button.icon-btn', { title: t('Kezdőmappa'), on: { click: () => navigate(tab, side, remote ? (tab.site.remote_dir || '/') : S.local.home) } }, icon('home')),
      !remote && isWin() ? h('button.icon-btn', { title: t('Meghajtók'), on: { click: () => navigate(tab, side, '') } }, icon('drive')) : null,
      pathInp,
      h('button.icon-btn', { title: t('Frissítés'), on: { click: () => listPane(tab, side) } }, icon('refresh'))));
}

function renderPane(tab, side) {
  const pane = tab[side];
  if (!pane.el) return;
  renderPaneHead(tab, side);
  const cols = pane.el.querySelector('.fp-cols');
  cols.replaceChildren(...COLS.map((c) => h('div.fc.c-' + c.key + (pane.sort.key === c.key ? '.sorted' : ''), {
    on: { click: () => { pane.sort = { key: c.key === 'perms' ? 'name' : c.key, asc: pane.sort.key === c.key ? !pane.sort.asc : true }; renderPane(tab, side); } },
  }, c.label(), pane.sort.key === c.key ? icon(pane.sort.asc ? 'up' : 'down') : null)));
  renderRows(tab, side);
}

function renderRows(tab, side) {
  const pane = tab[side];
  const body = pane.el?.querySelector('.fp-body');
  if (!body) return;
  body.className = 'fp-body';
  pane.el.classList.remove('tiles');
  if (side === 'remote' && !tab.session) {
    body.replaceChildren(h('div.empty', icon(tab.status === 'connecting' ? 'refresh' : 'unplug', tab.status === 'connecting' ? 'spin' : ''),
      tab.status === 'connecting' ? t('Kapcsolódás…') : (tab.error || t('Nincs kapcsolat')),
      tab.status !== 'connecting' ? h('button.btn.primary', { on: { click: () => connectTab(tab) } }, icon('plug'), t('Kapcsolódás')) : null));
    renderFoot(tab, side);
    return;
  }
  if (pane.error) {
    body.replaceChildren(h('div.empty', icon('info'), pane.error, h('button.btn', { on: { click: () => listPane(tab, side) } }, icon('refresh'), t('Újra'))));
    renderFoot(tab, side);
    return;
  }
  const list = visibleEntries(pane);
  const frag = document.createDocumentFragment();
  const parent = sideParent(side, pane.path);
  const tiles = pane.view !== 'details';
  body.className = 'fp-body view-' + pane.view;
  pane.el.classList.toggle('tiles', tiles);
  const px = pane.view === 'large' ? 160 : 64;
  if (parent != null && !pane.filter) {
    frag.append(tiles
      ? h('div.frow.tile.up', { dataset: { name: '..' }, title: t('Fel (Backspace)') }, h('div.ti', icon('arrowUp')), h('div.tn', '..'))
      : h('div.frow.up', { dataset: { name: '..' } }, h('div.fc.c-name', icon('arrowUp'), h('span.n', '..')), h('div.fc.c-size'), h('div.fc.c-mtime'), h('div.fc.c-perms')));
  }
  for (const e of list) {
    const mark = compareMark(tab, side, e);
    const cls = (pane.sel.has(e.name) ? '.sel' : '') + (pane.cursor === e.name ? '.cur' : '') + (e.dir ? '.dir' : '') + (mark ? '.cmp-' + mark : '') + (isCut(tab, side, e) ? '.cut' : '');
    if (tiles) {
      const isImg = !e.dir && IMG_EXT.test(e.name);
      const img = isImg ? h('img', { alt: '', draggable: 'false' }) : null;
      const tile = h('div.frow.tile' + cls, { dataset: { name: e.name },
        title: `${e.name}${e.dir ? '' : '\n' + fmtSize(e.size)}${e.mtime ? '\n' + fmtDate(e.mtime, true) : ''}` },
        h('div.ti', icon(e.drive ? 'drive' : e.dir ? 'folder' : isImg ? 'image' : fileIcon(e.name)), img),
        h('div.tn', e.name, e.link ? h('span.lnk', ' ↪') : null),
        pane.view === 'large' ? h('div.tm', e.dir ? '' : fmtSize(e.size)) : null);
      if (img) { tile._want = () => wantThumb(tab, side, e, px, img); thumbObserver.observe(tile); }
      frag.append(tile);
      continue;
    }
    frag.append(h('div.frow' + cls, { dataset: { name: e.name } },
      h('div.fc.c-name', icon(e.drive ? 'drive' : e.dir ? 'folder' : fileIcon(e.name)), h('span.n', e.name), e.link ? h('span.lnk', '↪') : null),
      h('div.fc.c-size', e.dir ? '' : fmtSize(e.size)),
      h('div.fc.c-mtime', e.mtime ? fmtDate(e.mtime, true) : ''),
      h('div.fc.c-perms', e.perms || '')));
  }
  if (!list.length && parent == null) frag.append(h('div.empty.small', pane.filter ? t('Nincs találat') : t('Üres mappa')));
  else if (!list.length) frag.append(h('div.empty.small', pane.filter ? t('Nincs találat') : t('Üres mappa')));
  body.replaceChildren(frag);
  body.querySelector('.frow.cur')?.scrollIntoView({ block: 'nearest' });
  renderFoot(tab, side);
}

function fileIcon(name) {
  return 'file';
}

function renderFoot(tab, side) {
  const pane = tab[side];
  const foot = pane.el?.querySelector('.fp-foot');
  if (!foot) return;
  const files = pane.entries.filter((e) => !e.dir);
  const sel = pane.entries.filter((e) => pane.sel.has(e.name));
  const selSize = sel.reduce((a, e) => a + (e.dir ? 0 : e.size || 0), 0);
  foot.replaceChildren(
    h('span', sel.length ? t('{0} kijelölve ({1})', sel.length, fmtSize(selSize)) : t('{0} mappa, {1} fájl ({2})', pane.entries.length - files.length, files.length, fmtSize(files.reduce((a, e) => a + (e.size || 0), 0)))),
    tab.compare && side === 'remote' ? h('span.legend', h('i.cmp-only'), t('csak itt'), h('i.cmp-newer'), t('újabb'), h('i.cmp-diff'), t('eltér')) : null);
}

// ───────────────────────── pane interaction ─────────────────────────

function rowsOrder(tab, side) {
  return visibleEntries(tab[side]).map((e) => e.name);
}

function selectRow(tab, side, name, e) {
  const pane = tab[side];
  if (name === '..') { pane.sel.clear(); pane.cursor = null; paintSelection(tab, side); renderToolbar(); return; }
  if (e?.shiftKey && pane.anchor) {
    const order = rowsOrder(tab, side);
    const a = order.indexOf(pane.anchor), b = order.indexOf(name);
    if (!(e.ctrlKey || e.metaKey)) pane.sel.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) pane.sel.add(order[i]);
  } else if (e?.ctrlKey || e?.metaKey) {
    if (pane.sel.has(name)) pane.sel.delete(name); else pane.sel.add(name);
    pane.anchor = name;
  } else {
    pane.sel = new Set([name]);
    pane.anchor = name;
  }
  pane.cursor = name;
  paintSelection(tab, side);
  renderToolbar();
  renderStatus();
}

/** Updates the selected / cursor marks on the existing rows, keeping the
 * row elements (rebuilding them between two clicks breaks double-click). */
function paintSelection(tab, side) {
  const pane = tab[side];
  const body = pane.el?.querySelector('.fp-body');
  if (!body) return;
  for (const r of body.querySelectorAll('.frow')) {
    const n = r.dataset.name;
    r.classList.toggle('sel', pane.sel.has(n));
    r.classList.toggle('cur', pane.cursor === n);
  }
  body.querySelector('.frow.cur')?.scrollIntoView({ block: 'nearest' });
  renderFoot(tab, side);
}

function openEntry(tab, side, name) {
  const pane = tab[side];
  if (name === '..') return goUp(tab, side);
  const e = pane.entries.find((x) => x.name === name);
  if (!e) return;
  if (e.dir) return navigate(tab, side, e.drive ? e.name : sideJoin(side, pane.path, e.name));
  // a file: open it in its default app (a remote one through a temporary
  // copy that is uploaded again when saved); F5 / dragging transfers
  if (side === 'local') invoke('open_path', { path: sideJoin(side, pane.path, name) }).catch((er) => toast(String(er), 'err'));
  else if (tab.session) { pane.sel = new Set([name]); pane.cursor = name; paintSelection(tab, side); editRemote(tab); }
}

let drag = null;
let lastClick = null;

function wireBody(tab, side, body) {
  const rowOf = (ev) => ev.target.closest('.frow');
  body.addEventListener('click', (e) => {
    const r = rowOf(e);
    if (!r) { if (!e.ctrlKey && !e.shiftKey) { tab[side].sel.clear(); renderRows(tab, side); renderToolbar(); } return; }
    if (drag?.moved) return;
    const name = r.dataset.name;
    // our own double-click detection: the same row twice within 450 ms
    const now = performance.now();
    const dbl = lastClick && lastClick.body === body && lastClick.name === name && now - lastClick.time < 450
      && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 6 && !e.shiftKey && !e.ctrlKey && !e.metaKey;
    lastClick = dbl ? null : { body, name, time: now, x: e.clientX, y: e.clientY };
    if (dbl) { openEntry(tab, side, name); return; }
    selectRow(tab, side, name, e);
  });
  body.addEventListener('contextmenu', (e) => {
    const r = rowOf(e);
    const pane = tab[side];
    if (r && r.dataset.name !== '..' && !pane.sel.has(r.dataset.name)) selectRow(tab, side, r.dataset.name);
    setFocus(tab, side);
    paneMenu(e, tab, side);
  });
  body.addEventListener('mousedown', (e) => {
    const r = rowOf(e);
    if (e.button !== 0 || !r || r.dataset.name === '..') return;
    drag = { tab, side, x: e.clientX, y: e.clientY, name: r.dataset.name, moved: false, ghost: null, target: null };
  });
}

addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
  const { tab, side } = drag;
  if (!drag.moved) {
    drag.moved = true;
    const pane = tab[side];
    if (!pane.sel.has(drag.name)) { pane.sel = new Set([drag.name]); pane.anchor = drag.name; renderRows(tab, side); }
    drag.ghost = h('div.drag-ghost', icon(side === 'local' ? 'upload' : 'download'), t('{0} elem', pane.sel.size));
    document.body.append(drag.ghost);
    document.body.classList.add('dragging');
  }
  drag.ghost.style.left = e.clientX + 14 + 'px';
  drag.ghost.style.top = e.clientY + 10 + 'px';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const paneEl = el?.closest('.fpane');
  document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  drag.target = null;
  if (paneEl && paneEl.dataset.side !== side && tab.session) {
    const row = el.closest('.frow.dir');
    const name = row?.dataset.name;
    (row && name !== '..' ? row : paneEl).classList.add('drop-target');
    drag.target = { folder: row && name !== '..' ? name : null };
  }
});

addEventListener('mouseup', () => {
  if (!drag) return;
  const d = drag;
  setTimeout(() => { drag = null; }, 0);
  if (!d.moved) return;
  d.ghost?.remove();
  document.body.classList.remove('dragging');
  document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  if (d.target) {
    const other = d.side === 'local' ? 'remote' : 'local';
    const dst = d.target.folder ? sideJoin(other, d.tab[other].path, d.target.folder) : null;
    transfer(d.tab, d.side, { dstPath: dst });
  }
});

function selectedEntries(tab, side) {
  const pane = tab[side];
  return pane.entries.filter((e) => pane.sel.has(e.name) && !e.drive);
}

function paneMenu(e, tab, side) {
  const pane = tab[side];
  const sel = selectedEntries(tab, side);
  const one = sel.length === 1 ? sel[0] : null;
  const remote = side === 'remote';
  const on = !!tab.session;
  const full = one ? sideJoin(side, pane.path, one.name) : pane.path;
  contextMenu(e, [
    one?.dir ? { label: t('Megnyitás'), icon: 'folder', action: () => openEntry(tab, side, one.name) } : null,
    !remote && one && !one.dir ? { label: t('Megnyitás alapértelmezett programmal'), icon: 'file', action: () => invoke('open_path', { path: full }).catch((er) => toast(er, 'err')) } : null,
    remote && one && !one.dir ? { label: t('Szerkesztés (automatikus visszatöltés)'), icon: 'edit', action: () => editRemote(tab) } : null,
    sel.length ? { label: t('Tulajdonságok…'), icon: 'info', key: 'Alt+Enter', action: () => infoDlg(tab, side) } : null,
    sel.length ? { label: remote ? t('Letöltés ({0})', sel.length) : t('Feltöltés ({0})', sel.length), icon: remote ? 'download' : 'upload', disabled: !on, key: 'F5', action: () => transfer(tab, side) } : null,
    '-',
    { label: remote ? t('Csak az új fájlok letöltése…') : t('Csak az új fájlok feltöltése…'), icon: 'sync', disabled: !on || (!remote && !pane.path), action: () => syncNewDlg(tab, side) },
    '-',
    sel.length ? { label: t('Kivágás'), icon: 'cut', key: 'Ctrl+X', disabled: remote && !on, action: () => clipSel(tab, side, true) } : null,
    sel.length ? { label: t('Másolás'), icon: 'copy', key: 'Ctrl+C', disabled: remote && !on, action: () => clipSel(tab, side, false) } : null,
    { label: t('Beillesztés'), icon: 'paste', key: 'Ctrl+V', disabled: remote ? !on : !pane.path, action: () => pasteTo(tab, side) },
    '-',
    { label: t('Új mappa…'), icon: 'folderPlus', key: 'F7', disabled: remote && !on, action: () => mkdirDlg(tab, side) },
    one ? { label: t('Átnevezés…'), icon: 'rename', key: 'F2', action: () => renameDlg(tab, side) } : null,
    sel.length ? { label: t('Törlés ({0})', sel.length), icon: 'trash', key: 'Del', danger: true, action: () => deleteSel(tab, side) } : null,
    '-',
    tab.compare ? { label: t('Eltérők kijelölése'), icon: 'compare', action: () => selectDifferent(tab, side) } : null,
    { label: t('Összes kijelölése'), key: 'Ctrl+A', action: () => { pane.sel = new Set(visibleEntries(pane).map((x) => x.name)); renderRows(tab, side); renderToolbar(); } },
    { label: t('Útvonal másolása'), icon: 'copy', action: () => navigator.clipboard.writeText(full) },
    remote && one && tab.site.protocol !== 'onedrive' && tab.site.protocol !== 's3' ? { label: t('URL másolása'), icon: 'link', action: () => navigator.clipboard.writeText(siteUrl(tab.site, full)) } : null,
    !remote && pane.path ? { label: t('Megjelenítés a Fájlkezelőben'), icon: 'folder', action: () => invoke('reveal_path', { path: full }).catch((er) => toast(er, 'err')) } : null,
    { label: t('Frissítés'), icon: 'refresh', key: 'Ctrl+R', action: () => listPane(tab, side) },
    '-',
    ...VIEWS.map(([v, ic, label]) => ({ label: label() + (pane.view === v ? '  ✓' : ''), icon: ic, action: () => setView(tab, side, v) })),
  ]);
}

function siteUrl(site, path) {
  const scheme = site.protocol === 'sftp' ? 'sftp' : site.protocol.startsWith('ftps') ? 'ftps' : 'ftp';
  return `${scheme}://${site.user ? encodeURIComponent(site.user) + '@' : ''}${site.host}${site.port ? ':' + site.port : ''}${path.startsWith('/') ? '' : '/'}${path.split('/').map(encodeURIComponent).join('/')}`;
}

function selectDifferent(tab, side) {
  const pane = tab[side];
  pane.sel = new Set(pane.entries.filter((e) => ['only', 'newer', 'diff'].includes(compareMark(tab, side, e))).map((e) => e.name));
  renderRows(tab, side); renderToolbar();
}

/** Tiles per row in the icon views (1 in the details view). */
function gridColumns(tab, side) {
  const pane = tab[side];
  if (pane.view === 'details') return 1;
  const tiles = pane.el?.querySelectorAll('.fp-body .frow.tile:not(.up)') || [];
  if (tiles.length < 2) return 1;
  const top = tiles[0].offsetTop;
  let n = 0;
  for (const el of tiles) { if (el.offsetTop !== top) break; n++; }
  return Math.max(1, n);
}

function moveCursor(tab, side, e, delta) {
  const pane = tab[side];
  const order = rowsOrder(tab, side);
  let i = order.indexOf(pane.cursor);
  i = i < 0 ? 0 : Math.max(0, Math.min(order.length - 1, i + delta));
  const name = order[i];
  if (e.shiftKey) { pane.sel.add(name); pane.cursor = name; paintSelection(tab, side); renderToolbar(); }
  else selectRow(tab, side, name);
}

// keyboard: Total Commander style
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.overlay')) return;
  const tab = cur();
  const inField = e.target.closest('input,textarea,select');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); return stepZoom(1); }
  if (mod && e.key === '-') { e.preventDefault(); return stepZoom(-1); }
  if (mod && e.key === '0') { e.preventDefault(); return stepZoom(0); }
  if (mod && e.key.toLowerCase() === 's' && !inField) { e.preventDefault(); return siteManager(); }
  if (mod && e.key.toLowerCase() === 'q') { e.preventDefault(); return quickConnect(); }
  if (mod && e.key.toLowerCase() === 'w' && tab) { e.preventDefault(); return closeTab(S.active); }
  if (mod && e.key === 'Tab' && S.tabs.length > 1) { e.preventDefault(); return activate((S.active + (e.shiftKey ? S.tabs.length - 1 : 1)) % S.tabs.length); }
  if (!tab || inField) return;
  const side = tab.focus;
  const pane = tab[side];
  const order = rowsOrder(tab, side);
  const hasUp = sideParent(side, pane.path) != null && !pane.filter;
  if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); listPane(tab, 'local'); listPane(tab, 'remote'); return; }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); clipSel(tab, side, false); return; }
  if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); clipSel(tab, side, true); return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteTo(tab, side); return; }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); pane.sel = new Set(order); renderRows(tab, side); renderToolbar(); return; }
  switch (e.key) {
    case 'Tab': e.preventDefault(); setFocus(tab, side === 'local' ? 'remote' : 'local'); return;
    case 'Escape': if (S.clip?.cut) { e.preventDefault(); S.clip = null; repaintRows(); } return;
    case 'Backspace': e.preventDefault(); goUp(tab, side); return;
    case 'ArrowLeft': case 'ArrowRight':
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(tab, side); return; }
      if (pane.view === 'details' || e.altKey || !order.length) return;
      e.preventDefault();
      moveCursor(tab, side, e, e.key === 'ArrowRight' ? 1 : -1);
      return;
    case 'Enter': e.preventDefault(); if (e.altKey) { infoDlg(tab, side); return; } if (pane.cursor) openEntry(tab, side, pane.cursor); else if (hasUp) goUp(tab, side); return;
    case 'Delete': e.preventDefault(); deleteSel(tab, side); return;
    case 'F2': e.preventDefault(); renameDlg(tab, side); return;
    case 'F5': e.preventDefault(); if (tab.session) transfer(tab, side); return;
    case 'F7': e.preventDefault(); mkdirDlg(tab, side); return;
    case ' ': case 'Insert': {
      e.preventDefault();
      if (!pane.cursor) return;
      if (pane.sel.has(pane.cursor)) pane.sel.delete(pane.cursor); else pane.sel.add(pane.cursor);
      const i = order.indexOf(pane.cursor);
      if (i < order.length - 1) pane.cursor = order[i + 1];
      renderRows(tab, side); renderToolbar();
      return;
    }
    case 'ArrowDown': case 'ArrowUp': case 'Home': case 'End': case 'PageDown': case 'PageUp': {
      e.preventDefault();
      if (!order.length) return;
      let i = order.indexOf(pane.cursor);
      const cols = gridColumns(tab, side);
      const step = e.key.startsWith('Page') ? (cols > 1 ? cols * 4 : 15) : cols;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') i = i < 0 ? 0 : Math.min(order.length - 1, i + step);
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') i = Math.max(0, i - step);
      else if (e.key === 'Home') i = 0; else i = order.length - 1;
      const name = order[i];
      if (e.shiftKey) { pane.sel.add(name); pane.cursor = name; renderRows(tab, side); renderToolbar(); }
      else selectRow(tab, side, name);
      return;
    }
    default:
      // typing jumps to the first matching name
      if (e.key.length === 1 && !mod && !e.altKey) {
        const k = e.key.toLowerCase();
        const name = order.find((n) => n.toLowerCase().startsWith(k));
        if (name) selectRow(tab, side, name);
      }
  }
});

addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); stepZoom(e.deltaY < 0 ? 1 : -1); } }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (!e.defaultPrevented && !editMenu(e)) e.preventDefault(); });

// ───────────────────────── file operations ─────────────────────────

async function mkdirDlg(tab, side) {
  if (!tab || (side === 'remote' && !tab.session)) return;
  const pane = tab[side];
  if (side === 'local' && !pane.path) return;
  const v = await formDlg(t('Új mappa'), [{ name: 'name', label: t('Mappa neve'), placeholder: t('új mappa') }], t('Létrehozás'));
  const name = v?.name?.trim();
  if (!name) return;
  const path = sideJoin(side, pane.path, name);
  try {
    await busy(() => (side === 'local' ? invoke('local_mkdir', { path }) : invoke('remote_mkdir', { session: tab.session, path })));
    pane.sel = new Set([name]); pane.cursor = name;
    await listPane(tab, side);
  } catch (e) { toast(friendly(e), 'err'); }
}

async function renameDlg(tab, side) {
  const sel = selectedEntries(tab, side);
  if (sel.length !== 1) return;
  const e = sel[0];
  const pane = tab[side];
  const v = await formDlg(t('Átnevezés'), [{ name: 'name', label: t('Új név'), value: e.name }], t('Átnevezés'));
  const name = v?.name?.trim();
  if (!name || name === e.name) return;
  const from = sideJoin(side, pane.path, e.name), to = sideJoin(side, pane.path, name);
  try {
    await busy(() => (side === 'local' ? invoke('local_rename', { from, to }) : invoke('remote_rename', { session: tab.session, from, to, dir: e.dir })));
    pane.sel = new Set([name]); pane.cursor = name;
    await listPane(tab, side);
  } catch (er) { toast(friendly(er), 'err'); }
}

async function deleteSel(tab, side) {
  const sel = selectedEntries(tab, side);
  if (!sel.length || (side === 'remote' && !tab.session)) return;
  const pane = tab[side];
  if (S.settings.confirm_delete !== false) {
    const names = sel.slice(0, 8).map((e) => (e.dir ? '📁 ' : '') + e.name).join('\n') + (sel.length > 8 ? `\n… (+${sel.length - 8})` : '');
    const where = side === 'local' ? t('a helyi gépről') : t('a szerverről ({0})', tab.site.name || tab.site.host);
    if (!(await confirmDlg(t('Törlés'), t('Biztosan törlöd {0}? A mappák a teljes tartalmukkal törlődnek, és ez nem vonható vissza.\n\n{1}', where, names), t('Törlés'), true))) return;
  }
  setBusy(true);
  let errors = 0;
  for (const e of sel) {
    const path = sideJoin(side, pane.path, e.name);
    try {
      if (side === 'local') await invoke('local_remove', { path });
      else await invoke('remote_remove', { session: tab.session, path, dir: e.dir });
    } catch (er) {
      errors++;
      // NFS "silly rename": a file deleted while open somewhere; the server removes it itself once closed
      toast(/^\.nfs[0-9a-f]+$/i.test(e.name) ? t('{0}: ez egy ideiglenes NFS-fájl. A szerver akkor hozza létre, ha egy fájlt nyitott állapotban töröltek vagy felülírtak, és csak akkor engedi törölni, amikor a fájlt használó folyamat (pl. a webszerver) bezárta. Általában magától eltűnik; ha napok múlva is megvan, a tárhelyszolgáltató tudja törölni.', e.name)
        : `${e.name}: ${friendly(er)}`, 'err', /^\.nfs/i.test(e.name) ? 15000 : undefined);
    }
  }
  setBusy(false);
  if (!errors) toast(t('{0} elem törölve', sel.length), 'ok');
  pane.sel.clear();
  await listPane(tab, side);
}

// ───────────────────────── transfers ─────────────────────────

/**
 * Queues the selected items of `fromSide` for transfer to the other side
 * (or to `dstPath`). Folders are walked; target folders are created first.
 * `items`: optional [{name, dir, size, mtime, path}] instead of the selection.
 */
async function transfer(tab, fromSide, { dstPath = null, items = null } = {}) {
  if (!tab?.session) return;
  const toSide = fromSide === 'local' ? 'remote' : 'local';
  const src = tab[fromSide], dst = tab[toSide];
  const dstDir = dstPath ?? dst.path;
  if (toSide === 'local' && !dstDir) { toast(t('Válassz egy helyi mappát a letöltéshez.'), 'err'); return; }
  const list = items || selectedEntries(tab, fromSide).map((e) => ({ ...e, path: sideJoin(fromSide, src.path, e.name) }));
  if (!list.length) return;
  const up = fromSide === 'local';
  const policy = S.settings.overwrite || 'ask';
  // what exists at the target: the visible listing, or a fresh one for another folder
  let dstEntries = dst.entries;
  if (dstPath) {
    try { dstEntries = await invoke(toSide === 'local' ? 'local_list' : 'remote_list', toSide === 'local' ? { path: dstDir, showHidden: true } : { session: tab.session, path: dstDir }); }
    catch { dstEntries = []; }
  }
  const jobs = [], conflicts = [];
  setBusy(true);
  try {
    for (const it of list) {
      const target = sideJoin(toSide, dstDir, it.name);
      if (!it.dir) {
        const job = mkJob(tab, up, it.path, target, it.name, it.size);
        job.item = it.path;
        const ex = dstEntries.find((x) => x.name === it.name && !x.dir);
        if (ex) conflicts.push({ job, src: it, dst: ex });
        jobs.push(job);
        continue;
      }
      const walked = await invoke(up ? 'local_walk' : 'remote_walk', up ? { path: it.path } : { session: tab.session, path: it.path });
      // existing files under the target folder (for the overwrite question)
      let existing = new Map();
      if (policy !== 'overwrite' && dstEntries.some((x) => x.name === it.name && x.dir)) {
        try {
          const w = await invoke(up ? 'remote_walk' : 'local_walk', up ? { session: tab.session, path: target } : { path: target });
          existing = new Map(w.filter((x) => !x.dir).map((x) => [x.rel, x]));
        } catch { /* unreadable: treat as empty */ }
      }
      // create the folders before the files arrive (errors = already exists)
      for (const d of [{ rel: '' }, ...walked.filter((x) => x.dir)]) {
        const p = d.rel ? sideJoinRel(toSide, target, d.rel) : target;
        await (up ? invoke('remote_mkdir', { session: tab.session, path: p }) : invoke('local_mkdir', { path: p })).catch(() => {});
      }
      for (const f of walked.filter((x) => !x.dir)) {
        const job = mkJob(tab, up, sideJoinRel(fromSide, it.path, f.rel), sideJoinRel(toSide, target, f.rel), `${it.name}/${f.rel}`, f.size);
        job.item = it.path;
        const ex = existing.get(f.rel);
        if (ex) conflicts.push({ job, src: f, dst: ex });
        jobs.push(job);
      }
    }
  } catch (e) {
    toast(friendly(e), 'err');
    return;
  } finally { setBusy(false); }

  let skip = new Set();
  if (conflicts.length && policy !== 'overwrite') {
    let choice = policy;
    if (policy === 'ask') {
      const names = conflicts.slice(0, 6).map((c) => c.job.name).join('\n') + (conflicts.length > 6 ? `\n… (+${conflicts.length - 6})` : '');
      choice = await modal({
        title: t('A fájl már létezik'),
        body: h('div.desc', t('{0} fájl már létezik a célhelyen:\n\n{1}', conflicts.length, names)),
        buttons: [
          { label: t('Mégse'), value: null },
          { label: t('Kihagyás'), value: 'skip' },
          { label: t('Csak az újabbak'), value: 'newer' },
          { label: t('Felülírás'), value: 'overwrite', primary: true },
        ],
      });
      if (!choice) return null;
    }
    if (choice === 'skip') skip = new Set(conflicts.map((c) => c.job));
    if (choice === 'newer') skip = new Set(conflicts.filter((c) => !((c.src.mtime || 0) > (c.dst.mtime || 0) + 1 || (c.src.size !== c.dst.size && !c.dst.mtime))).map((c) => c.job));
  }
  const add = jobs.filter((j) => !skip.has(j));
  const skipped = jobs.filter((j) => skip.has(j));
  if (!add.length) { toast(t('Nincs mit átvinni (minden fájl kihagyva).')); listPane(tab, toSide); return { jobs: add, skipped }; }
  S.queue.push(...add);
  renderQueue();
  renderToolbar();
  pump();
  return { jobs: add, skipped };
}

function mkJob(tab, up, srcPath, dstPath, name, size) {
  const job = {
    id: uid(), tabId: tab.id, dir: up ? 'up' : 'down',
    local: up ? srcPath : dstPath, remote: up ? dstPath : srcPath,
    name, size: size || 0, done: 0, status: 'queued', error: null, speed: 0, started: 0, last: null, el: null,
  };
  // resolved when the job ends (done, failed or stopped)
  job.finished = new Promise((r) => { job.fin = r; });
  return job;
}

function pump() {
  const max = Math.max(1, Math.min(8, S.settings.parallel || 2));
  for (const tab of S.tabs) {
    if (!tab.session) continue;
    let running = S.queue.filter((j) => j.tabId === tab.id && j.status === 'running').length;
    for (const j of S.queue) {
      if (running >= max) break;
      if (j.tabId === tab.id && j.status === 'queued') { running++; runJob(tab, j); }
    }
  }
  renderTabs();
}

const refreshAfter = new Map();
function refreshLater(tab, side) {
  const k = tab.id + side;
  clearTimeout(refreshAfter.get(k));
  refreshAfter.set(k, setTimeout(() => { if (S.tabs.includes(tab)) listPane(tab, side); }, 500));
}

async function runJob(tab, job) {
  job.status = 'running';
  job.started = Date.now();
  job.last = { t: job.started, done: 0 };
  updateJobRow(job);
  setBusy(true); // the bar under the toolbar runs while files are moving
  try {
    await invoke('transfer', { session: tab.session, id: job.id, direction: job.dir, local: job.local, remote: job.remote, size: job.size });
    job.status = 'done';
    job.done = Math.max(job.done, job.size);
  } catch (e) {
    job.status = String(e) === 'CANCELLED' ? 'cancelled' : 'error';
    job.error = friendly(e);
  } finally { setBusy(false); }
  job.speed = job.status === 'done' ? (job.size / Math.max(0.001, (Date.now() - job.started) / 1000)) : 0;
  updateJobRow(job);
  renderQueueHead();
  job.fin();
  refreshLater(tab, job.dir === 'up' ? 'remote' : 'local');
  const left = S.queue.some((j) => j.tabId === tab.id && (j.status === 'queued' || j.status === 'running'));
  if (!left) {
    const batch = S.queue.filter((j) => j.tabId === tab.id && j.finishedShown !== true && (j.status === 'done' || j.status === 'error'));
    batch.forEach((j) => (j.finishedShown = true));
    const errs = batch.filter((j) => j.status === 'error').length;
    if (batch.length > 1 || errs) toast(errs ? t('Átvitel kész, {0} hibával.', errs) : t('{0} fájl átvitele kész.', batch.length), errs ? 'err' : 'ok');
  }
  renderToolbar();
  pump();
}

function cancelJob(job) {
  if (job.status === 'queued') { job.status = 'cancelled'; updateJobRow(job); renderQueueHead(); job.fin(); }
  else if (job.status === 'running') invoke('cancel_transfer', { id: job.id });
}

listen('xfer', (ev) => {
  const { id, done, total } = ev.payload;
  const job = S.queue.find((j) => j.id === id);
  if (!job) return;
  job.done = done;
  if (total) job.size = total;
  const now = Date.now();
  if (job.last && now - job.last.t >= 500) {
    const inst = ((done - job.last.done) * 1000) / (now - job.last.t);
    job.speed = job.speed ? job.speed * 0.6 + inst * 0.4 : inst;
    job.last = { t: now, done };
  }
  updateJobRow(job);
  renderQueueHeadSoon();
});

// OS files dropped on the window: upload when dropped on the remote side
/** Uploads files / folders given by their local paths (drop, paste). */
async function uploadPaths(tab, paths, folder = null) {
  if (!tab.session) { toast(t('Nincs kapcsolat.'), 'err'); return; }
  const items = [];
  for (const p of paths) {
    const st = await invoke('local_stat', { path: p });
    if (st.exists) items.push({ name: p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(), dir: st.dir, size: st.size, mtime: st.mtime, path: p });
  }
  if (items.length) transfer(tab, 'local', { items, dstPath: folder });
}

// ───────────────────────── file info ─────────────────────────

/** Right click → Properties (Alt+Enter): details of the selected files, folder sizes, image preview. */
async function infoDlg(tab, side) {
  const pane = tab[side];
  const sel = selectedEntries(tab, side);
  if (!sel.length) return;
  const remote = side === 'remote';
  const one = sel.length === 1 ? sel[0] : null;
  const full = one ? sideJoin(side, pane.path, one.name) : pane.path;
  const row = (k, v, cls = '') => [h('span.k', k), h('span.v' + cls, { title: String(v ?? '') }, v ?? '–')];
  const sizeOf = (n) => (n == null ? '–' : `${fmtSize(n)}${n >= 1024 ? ` (${n.toLocaleString()} ${t('bájt')})` : ''}`);
  const dirs = sel.filter((e) => e.dir);
  const files = sel.filter((e) => !e.dir);
  // folders: everything in them is counted in the background
  const total = h('span.v', dirs.length ? t('Számolás…') : sizeOf(files.reduce((s, e) => s + (e.size || 0), 0)));
  const contents = h('span.v', '–');
  const where = remote ? `${PROTOS[tab.site.protocol]?.label || ''} · ${tab.site.user ? tab.site.user + '@' : ''}${tab.site.host || tab.site.s3_bucket || tab.site.onedrive_account || ''}` : t('Helyi gép');
  const ext = one && !one.dir && one.name.includes('.') ? one.name.split('.').pop().toUpperCase() : '';
  const kind = one ? (one.drive ? t('Meghajtó') : one.dir ? t('Mappa') : ext ? t('{0} fájl', ext) : t('Fájl')) : t('{0} mappa, {1} fájl', dirs.length, files.length);
  const preview = one && !one.dir && IMG_EXT.test(one.name) ? h('img.info-img', { alt: '' }) : null;
  const info = h('div.about-info.file-info',
    ...(one ? row(t('Név'), one.name) : row(t('Kijelölve'), t('{0} elem', sel.length))),
    ...row(t('Típus'), kind),
    ...row(t('Hely'), one ? sideParent(side, full) ?? pane.path : pane.path),
    ...row(t('Kapcsolat'), where),
    h('span.k', t('Méret')), total,
    ...(dirs.length ? [h('span.k', t('Tartalom')), contents] : []),
    ...(one?.mtime ? row(t('Módosítva'), `${fmtDate(one.mtime, true)}`) : []),
    ...(one?.perms ? row(t('Jogosultságok'), one.perms, '.mono') : []),
    ...(one?.link ? row(t('Hivatkozás'), t('Szimbolikus link')) : []),
    ...(remote && one && tab.site.protocol !== 'onedrive' && tab.site.protocol !== 's3' ? row('URL', siteUrl(tab.site, full)) : []),
  );
  if (dirs.length) {
    (async () => {
      let size = files.reduce((s, e) => s + (e.size || 0), 0), nf = files.length, nd = 0;
      try {
        for (const d of dirs) {
          const p = sideJoin(side, pane.path, d.name);
          const w = await invoke(remote ? 'remote_walk' : 'local_walk', remote ? { session: tab.session, path: p } : { path: p });
          for (const x of w) { if (x.dir) nd++; else { nf++; size += x.size || 0; } }
        }
        total.textContent = sizeOf(size);
        contents.textContent = t('{0} fájl, {1} mappa', nf, nd);
      } catch (er) { total.textContent = friendly(er); }
    })();
  }
  if (preview) {
    const big = 360;
    (async () => {
      try {
        preview.src = remote
          ? await invoke('remote_thumb', { session: tab.session, server: tab.site.id, path: full, fileSize: one.size || 0, mtime: one.mtime || 0, size: big })
          : await invoke('local_thumb', { path: full, size: big });
        preview.onload = () => { if (preview.naturalWidth) preview.title = `${preview.naturalWidth} × ${preview.naturalHeight}`; };
      } catch { preview.remove(); }
    })();
  }
  const head = h('div.info-head', icon(one ? (one.drive ? 'drive' : one.dir ? 'folder' : IMG_EXT.test(one.name) ? 'image' : fileIcon(one.name)) : 'copy'),
    h('b', one ? one.name : t('{0} elem', sel.length)));
  const buttons = [
    { label: t('Útvonal másolása'), value: () => { navigator.clipboard.writeText(full); return null; } },
    !remote && pane.path ? { label: t('Megjelenítés a Fájlkezelőben'), value: () => { invoke('reveal_path', { path: full }).catch((er) => toast(er, 'err')); return null; } } : null,
    { label: t('Bezárás'), value: null, primary: true },
  ].filter(Boolean);
  await modal({ title: t('Tulajdonságok'), body: h('div', head, preview, info), buttons });
}

// ───────────────────────── copy only the new files ─────────────────────────

/**
 * The folder shown on the active side is compared with the folder on the other side
 * (with subfolders); files missing on the target (and, if asked, newer at the source)
 * are listed with a tick box each, and the ticked ones are queued.
 */
async function syncNewDlg(tab, fromSide) {
  if (!tab?.session) { toast(t('Nincs kapcsolat.'), 'err'); return; }
  const toSide = fromSide === 'local' ? 'remote' : 'local';
  const srcDir = tab[fromSide].path, dstDir = tab[toSide].path;
  if (!srcDir || !dstDir) { toast(t('Válassz egy helyi mappát.'), 'err'); return; }
  const walk = (side, path) => invoke(side === 'local' ? 'local_walk' : 'remote_walk', side === 'local' ? { path } : { session: tab.session, path });
  let src, dst;
  setBusy(true);
  try {
    src = await walk(fromSide, srcDir);
    dst = await walk(toSide, dstDir).catch(() => []);
  } catch (e) { toast(friendly(e), 'err'); return; } finally { setBusy(false); }
  if (!S.settings.show_hidden) src = src.filter((x) => !x.rel.split('/').some((p) => p.startsWith('.')));
  const have = new Map(dst.map((x) => [x.rel.toLowerCase(), x]));

  // the two options are kept for next time (subfolders on, newer off at first)
  const subs = h('input', { type: 'checkbox', checked: uiGet('fs.syncSubs') !== '0' });
  const newer = h('input', { type: 'checkbox', checked: uiGet('fs.syncNewer') === '1' });
  const sum = h('div.sync-sum');
  const all = h('input', { type: 'checkbox' });
  const allRow = h('label.chk.sync-all', all, ' ', t('Mind'));
  const list = h('div.sync-list');
  const MAX_ROWS = 2000;
  // found: the listed rows (kind: dir = folder missing on the target, new, upd);
  // plan: what the ticked rows copy — files, and the folders to create
  let found = [], plan = { files: [], dirs: [] };
  const skip = new Set(); // rel paths unticked by the user (kept when the options change)
  const boxes = new Map(); // rel → tick box of the rows shown
  const under = (dir, rel) => rel.startsWith(dir + '/');
  // what is ticked: the summary, the "all" box and the plan
  const recount = () => {
    const ticked = found.filter((p) => !skip.has(p.f.rel));
    const files = ticked.filter((p) => p.kind !== 'dir');
    const dirs = new Set(ticked.filter((p) => p.kind === 'dir').map((p) => p.f.rel));
    // without subfolders a new folder is listed alone, and comes with everything in it
    if (!subs.checked) {
      for (const d of [...dirs]) {
        for (const f of src) if (under(d, f.rel)) { if (f.dir) dirs.add(f.rel); else files.push({ f, kind: 'new' }); }
      }
    }
    for (const p of files) { const parts = p.f.rel.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
    plan = { files, dirs: [...dirs].filter((d) => !have.has(d.toLowerCase())).sort() };
    const bytes = files.reduce((a, p) => a + (p.f.size || 0), 0);
    const nNew = files.filter((p) => p.kind === 'new').length;
    const nDirs = plan.dirs.length;
    sum.textContent = !found.length ? t('Nincs új fájl: a cél naprakész.')
      : files.length || nDirs ? [files.length ? t('{0} fájl ({1}) kerül át: {2} új, {3} újabb.', files.length, fmtSize(bytes), nNew, files.length - nNew) : '',
        nDirs ? t('{0} új mappa.', nDirs) : ''].filter(Boolean).join(' ')
        : t('Nincs kijelölt fájl.');
    all.checked = ticked.length === found.length;
    all.indeterminate = ticked.length > 0 && ticked.length < found.length;
  };
  const tick = (rel, on) => { if (on) skip.delete(rel); else skip.add(rel); };
  const update = () => {
    found = [];
    for (const f of src) {
      if (!subs.checked && f.rel.includes('/')) continue;
      const d = have.get(f.rel.toLowerCase());
      if (f.dir) { if (!d) found.push({ f, kind: 'dir' }); continue; }
      if (!d) found.push({ f, kind: 'new' });
      else if (newer.checked && !d.dir && (f.mtime || 0) > (d.mtime || 0) + 1) found.push({ f, kind: 'upd' });
    }
    boxes.clear();
    list.replaceChildren(...found.slice(0, MAX_ROWS).map((p) => {
      const rel = p.f.rel;
      const cb = h('input', { type: 'checkbox', checked: !skip.has(rel) });
      boxes.set(rel, cb);
      cb.addEventListener('change', () => {
        tick(rel, cb.checked);
        // a folder ticks or clears what is listed inside it
        if (p.kind === 'dir') for (const q of found) if (under(rel, q.f.rel)) { tick(q.f.rel, cb.checked); const b = boxes.get(q.f.rel); if (b) b.checked = cb.checked; }
        recount();
      });
      return h('label.' + (p.kind === 'dir' ? 'new.dir' : p.kind), cb, (p.kind === 'upd' ? ' ↑ ' : ' + ') + rel + (p.kind === 'dir' ? '/' : ''));
    }), ...(found.length > MAX_ROWS ? [h('div', `… (+${found.length - MAX_ROWS})`)] : []));
    list.style.display = allRow.style.display = found.length ? '' : 'none';
    recount();
  };
  all.addEventListener('change', () => {
    for (const p of found) tick(p.f.rel, all.checked);
    for (const cb of boxes.values()) cb.checked = all.checked;
    recount();
  });
  subs.addEventListener('change', () => { uiSet('fs.syncSubs', subs.checked ? '1' : '0'); update(); });
  newer.addEventListener('change', () => { uiSet('fs.syncNewer', newer.checked ? '1' : '0'); update(); });
  update();
  const where = (side, path) => (side === 'local' ? path : `${tab.site.name || tab.site.host}: ${path}`);
  const ok = await modal({
    title: t('Csak az új fájlok másolása'),
    wide: true,
    body: h('div.sync-dlg',
      h('div.sync-route', h('span.k', t('Innen')), h('span.v', { title: srcDir }, where(fromSide, srcDir)),
        h('span.k', t('Ide')), h('span.v', { title: dstDir }, where(toSide, dstDir))),
      h('div.sync-opts',
        h('label.chk', subs, ' ', t('Az almappákkal együtt')),
        h('label.chk', newer, ' ', t('A célnál újabb fájlok is (felülírja a régebbit)'))),
      sum, allRow, list),
    buttons: [{ label: t('Mégse'), value: null }, { label: fromSide === 'local' ? t('Feltöltés') : t('Letöltés'), value: true, primary: true }],
  });
  if (!ok || !(plan.files.length || plan.dirs.length)) return;
  // folders first, then the files into the queue
  const up = fromSide === 'local';
  setBusy(true);
  try {
    for (const d of plan.dirs) {
      const path = sideJoinRel(toSide, dstDir, d);
      await (up ? invoke('remote_mkdir', { session: tab.session, path }) : invoke('local_mkdir', { path })).catch(() => {});
    }
  } finally { setBusy(false); }
  if (!plan.files.length) { toast(t('{0} új mappa.', plan.dirs.length), 'ok'); listPane(tab, toSide); return; }
  const jobs = plan.files.map((p) => mkJob(tab, up, sideJoinRel(fromSide, srcDir, p.f.rel), sideJoinRel(toSide, dstDir, p.f.rel), p.f.rel, p.f.size));
  S.queue.push(...jobs);
  renderQueue();
  renderToolbar();
  pump();
  toast(t('{0} fájl a sorban.', jobs.length), 'ok');
}

// ───────────────────────── cut / copy / paste ─────────────────────────
// Ctrl+C / Ctrl+X keep the selection in S.clip (local files also go on the system
// clipboard, so Explorer / Finder can paste them). Ctrl+V:
//   same side       → copy / move (on the server: rename; copy goes through a temp folder)
//   other side      → upload / download through the queue (cut: the source is removed after)
//   another server  → download to a temp folder, then upload
// Files copied in Explorer / Finder after that win over our own clipboard.

const normPath = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
const parentOf = (p) => String(p).replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
const samePaths = (a, b) => a.length === b.length && a.every((p, i) => normPath(p) === normPath(b[i]));

function isCut(tab, side, e) {
  const c = S.clip;
  return !!c?.cut && c.side === side && (side === 'local' || c.tabId === tab.id) && normPath(c.dir) === normPath(tab[side].path) && c.names.has(e.name);
}

function repaintRows() {
  const tab = cur();
  if (tab) { renderRows(tab, 'local'); renderRows(tab, 'remote'); }
}

/** Panes (in every tab) that show `dir` are listed again. */
function refreshDir(side, dir, tabId = null) {
  for (const tab of S.tabs) if ((side === 'local' || tab.id === tabId) && normPath(tab[side].path) === normPath(dir)) listPane(tab, side);
}

async function clipSel(tab, side, cut) {
  const pane = tab[side];
  const sel = selectedEntries(tab, side);
  if (!sel.length || (side === 'remote' && !tab.session)) return;
  const items = sel.map((e) => ({ name: e.name, dir: e.dir, size: e.size, mtime: e.mtime, path: sideJoin(side, pane.path, e.name) }));
  S.clip = { cut, side, tabId: tab.id, session: tab.session, dir: pane.path, items, names: new Set(items.map((i) => i.name)) };
  try {
    if (side === 'local') await invoke('clipboard_set_files', { paths: items.map((i) => i.path) });
    else await navigator.clipboard.writeText(items.map((i) => i.path).join('\n'));
  } catch { /* our own clipboard still works */ }
  // what the system clipboard holds now: other files there later mean a copy in Explorer / Finder
  try { S.clip.os = await invoke('clipboard_files'); } catch { S.clip.os = []; }
  repaintRows();
  toast(cut ? t('{0} elem kivágva – Ctrl+V a beillesztéshez', items.length) : t('{0} elem másolva – Ctrl+V a beillesztéshez', items.length));
}

async function pasteTo(tab, side) {
  const pane = tab[side];
  if (side === 'remote' && !tab.session) { toast(t('Nincs kapcsolat.'), 'err'); return; }
  if (side === 'local' && !pane.path) { toast(t('Válassz egy helyi mappát.'), 'err'); return; }
  let osFiles = [];
  try { osFiles = await invoke('clipboard_files'); } catch { /* no files */ }
  const c = S.clip;
  // ours, unless other files were copied in Explorer / Finder since
  if (c && (!osFiles.length || samePaths(osFiles, c.os || []))) return pasteClip(tab, side, c);
  if (!osFiles.length) { toast(t('A vágólapon nincsenek fájlok.')); return; }
  const items = await localItems(osFiles);
  if (side === 'remote') transfer(tab, 'local', { items, dstPath: pane.path });
  else localPaste(tab, items, false);
}

async function localItems(paths) {
  const items = [];
  for (const p of paths) {
    const st = await invoke('local_stat', { path: p });
    if (st.exists) items.push({ name: p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(), dir: st.dir, size: st.size, mtime: st.mtime, path: p });
  }
  return items;
}

/** "name - copy.txt", "name - copy (2).txt"… a name not in `taken` (lower-case names). */
function copyName(name, dir, taken) {
  const dot = dir ? -1 : name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const cand = `${base} - ${t('másolat')}${n > 1 ? ` (${n})` : ''}${ext}`;
    if (!taken.has(cand.toLowerCase())) { taken.add(cand.toLowerCase()); return cand; }
  }
}

/** Waits for the queued jobs; returns the items whose every file arrived. */
async function arrived(res, items) {
  if (!res) return [];
  await Promise.all(res.jobs.map((j) => j.finished));
  return items.filter((it) => !res.skipped.some((j) => j.item === it.path) && res.jobs.every((j) => j.item !== it.path || j.status === 'done'));
}

async function pasteClip(tab, side, c) {
  if (c.side === 'local' && side === 'local') return localPaste(tab, c.items, c.cut);
  const srcTab = c.side === 'local' ? tab : S.tabs.find((x) => x.id === c.tabId);
  if (!srcTab?.session) { toast(t('A forrás kapcsolat már nincs meg; jelöld ki és másold újra a fájlokat.'), 'err'); return; }
  if (c.side === 'remote' && side === 'remote') return srcTab === tab && c.cut ? remoteMove(tab, c) : remoteCopy(srcTab, tab, c);
  if (c.cut) { S.clip = null; repaintRows(); }
  // between the two sides: through the queue
  const res = c.side === 'local' ? await transfer(tab, 'local', { items: c.items, dstPath: tab.remote.path })
    : await transfer(srcTab, 'remote', { items: c.items, dstPath: tab.local.path });
  const ok = await arrived(res, c.items);
  listPane(tab, side);
  if (c.cut) await removeSources(c, srcTab, ok);
}

/** After a cut: the sources that arrived are removed. */
async function removeSources(c, srcTab, ok) {
  for (const it of ok) {
    try {
      if (c.side === 'local') await invoke('local_remove', { path: it.path });
      else await invoke('remote_remove', { session: srcTab.session, path: it.path, dir: it.dir });
    } catch (er) { toast(`${it.name}: ${friendly(er)}`, 'err'); }
  }
  if (ok.length < c.items.length) toast(t('{0} elem nem került át, ezek a helyükön maradtak.', c.items.length - ok.length), 'err');
  refreshDir(c.side, c.dir, srcTab.id);
}

async function localPaste(tab, items, cut) {
  const dstDir = tab.local.path;
  const taken = new Set((await invoke('local_list', { path: dstDir, showHidden: true }).catch(() => [])).map((e) => e.name.toLowerCase()));
  const plan = [];
  for (const it of items) {
    const sameDir = normPath(parentOf(it.path)) === normPath(dstDir);
    if (sameDir && cut) continue; // moved onto itself: nothing to do
    if (it.dir && (normPath(dstDir) + '/').replace(/\\/g, '/').startsWith((normPath(it.path) + '/').replace(/\\/g, '/'))) {
      toast(t('Egy mappa nem másolható önmagába'), 'err');
      continue;
    }
    plan.push({ it, name: sameDir ? copyName(it.name, it.dir, taken) : it.name, exists: !sameDir && taken.has(it.name.toLowerCase()) });
  }
  const clash = plan.filter((p) => p.exists);
  if (clash.length) {
    const names = clash.slice(0, 6).map((p) => (p.it.dir ? '📁 ' : '') + p.name).join('\n') + (clash.length > 6 ? `\n… (+${clash.length - 6})` : '');
    const choice = await modal({
      title: t('A fájl már létezik'),
      body: h('div.desc', t('{0} elem már létezik a célmappában:\n\n{1}', clash.length, names)),
      buttons: [{ label: t('Mégse'), value: null }, { label: t('Kihagyás'), value: 'skip' }, { label: t('Felülírás'), value: 'overwrite', primary: true }],
    });
    if (!choice) return;
    if (choice === 'skip') plan.splice(0, plan.length, ...plan.filter((p) => !p.exists));
  }
  if (cut) { S.clip = null; repaintRows(); }
  if (!plan.length) return;
  setBusy(true);
  const done = [];
  for (const p of plan) {
    try {
      await invoke(cut ? 'local_move' : 'local_copy', { from: p.it.path, to: sideJoin('local', dstDir, p.name) });
      done.push(p.name);
    } catch (er) { toast(`${p.it.name}: ${friendly(er)}`, 'err'); }
  }
  setBusy(false);
  if (done.length) toast(cut ? t('{0} elem áthelyezve', done.length) : t('{0} elem beillesztve', done.length), 'ok');
  tab.local.sel = new Set(done);
  if (done.length) tab.local.cursor = done[0];
  refreshDir('local', dstDir);
  if (cut) for (const d of new Set(plan.map((p) => parentOf(p.it.path)))) refreshDir('local', d);
}

/** Cut and paste on the same server: a rename. */
async function remoteMove(tab, c) {
  const dstDir = tab.remote.path;
  S.clip = null;
  if (normPath(c.dir) === normPath(dstDir)) { repaintRows(); return; }
  setBusy(true);
  const done = [];
  for (const it of c.items) {
    if (it.dir && (dstDir + '/').startsWith(it.path.replace(/\/+$/, '') + '/')) { toast(t('Egy mappa nem helyezhető át önmagába.'), 'err'); continue; }
    try {
      await invoke('remote_rename', { session: tab.session, from: it.path, to: sideJoin('remote', dstDir, it.name), dir: it.dir });
      done.push(it.name);
    } catch (er) { toast(`${it.name}: ${friendly(er)}`, 'err'); }
  }
  setBusy(false);
  if (done.length) toast(t('{0} elem áthelyezve', done.length), 'ok');
  tab.remote.sel = new Set(done);
  await listPane(tab, 'remote');
}

/** Copy on a server, or from one server to another: through a temporary local folder. */
async function remoteCopy(srcTab, dstTab, c) {
  if (c.cut) { S.clip = null; repaintRows(); }
  const tmp = await invoke('temp_dir');
  const got = await arrived(await transfer(srcTab, 'remote', { items: c.items, dstPath: tmp }), c.items);
  if (!got.length) { invoke('local_remove', { path: tmp }).catch(() => {}); return; }
  const dstDir = dstTab.remote.path;
  const sameDir = srcTab === dstTab && normPath(c.dir) === normPath(dstDir);
  const taken = new Set(dstTab.remote.entries.map((e) => e.name.toLowerCase()));
  const items = got.map((it) => ({ ...it, src: it, name: sameDir ? copyName(it.name, it.dir, taken) : it.name, path: sideJoin('local', tmp, it.name) }));
  const sent = await arrived(await transfer(dstTab, 'local', { items, dstPath: dstDir }), items);
  invoke('local_remove', { path: tmp }).catch(() => {});
  listPane(dstTab, 'remote');
  if (c.cut) await removeSources(c, srcTab, sent.map((i) => i.src));
}

listen('tauri://drag-drop', async (ev) => {
  const tab = cur();
  const { paths, position } = ev.payload || {};
  if (!tab || !paths?.length) return;
  const el = document.elementFromPoint(position.x / devicePixelRatio, position.y / devicePixelRatio);
  if (!el?.closest('.fpane.remote')) { toast(t('Fájlok feltöltéséhez a jobb oldali (távoli) panelre húzd őket.')); return; }
  const row = el.closest('.frow.dir');
  const folder = row && row.dataset.name !== '..' ? sideJoin('remote', tab.remote.path, row.dataset.name) : null;
  uploadPaths(tab, paths, folder);
});

// ───────────────────────── queue panel ─────────────────────────

function renderQueue() {
  const el = document.getElementById('queue');
  const split = document.getElementById('queue-split');
  el.style.display = split.style.display = S.queueOpen ? '' : 'none';
  if (!S.queueOpen) return;
  const body = h('div.q-body');
  const shown = S.queue.slice(-400);
  for (const j of shown) { j.el = null; body.append(jobRow(j)); }
  if (!shown.length) body.append(h('div.empty.small', t('Nincs átvitel. Húzz fájlokat az egyik panelről a másikra, vagy nyomd meg az F5-öt.')));
  el.replaceChildren(h('div.q-head'), body);
  renderQueueHead();
}

let headTimer = null;
function renderQueueHeadSoon() { if (!headTimer) headTimer = setTimeout(() => { headTimer = null; renderQueueHead(); }, 300); }

/** While the queue panel is hidden, the status bar shows how the transfers are going. */
function renderXferStatus() {
  const el = document.getElementById('xfer-status');
  if (!el) return;
  // the current batch: everything since the queue was last empty
  const batch = S.queue.filter((j) => !j.finishedShown && j.status !== 'cancelled' && j.status !== 'skipped');
  const active = batch.filter((j) => j.status === 'running' || j.status === 'queued');
  if (S.queueOpen || !active.length) { el.replaceChildren(); el.title = ''; return; }
  const total = batch.reduce((a, j) => a + (j.size || 0), 0);
  const done = batch.reduce((a, j) => a + (j.status === 'done' ? j.size || 0 : Math.min(j.done || 0, j.size || 0)), 0);
  const files = batch.filter((j) => j.status === 'done').length;
  const errs = batch.filter((j) => j.status === 'error').length;
  const speed = batch.filter((j) => j.status === 'running').reduce((a, j) => a + (j.speed || 0), 0);
  const pct = total ? Math.min(100, Math.floor((done * 100) / total)) : Math.floor((files * 100) / batch.length);
  const up = active.some((j) => j.dir === 'up'), down = active.some((j) => j.dir === 'down');
  el.replaceChildren(icon(up && !down ? 'upload' : down && !up ? 'download' : 'queue'),
    h('span', t('{0} / {1} fájl', files, batch.length)),
    h('span.xb', h('i', { style: { width: pct + '%' } })),
    h('span', pct + '%'),
    speed ? h('span', fmtSpeed(speed) + (total > done ? ' · ' + t('hátra: {0}', fmtEta((total - done) / speed)) : '')) : null,
    errs ? h('span.xe', t('{0} hiba', errs)) : null);
  el.title = t('Átvitelek – kattints a lista megnyitásához');
}

function renderQueueHead() {
  renderXferStatus();
  const head = document.querySelector('#queue .q-head');
  if (!head) return;
  const by = (s) => S.queue.filter((j) => j.status === s);
  const running = by('running'), queued = by('queued'), errs = by('error');
  const speed = running.reduce((a, j) => a + (j.speed || 0), 0);
  const leftBytes = [...running, ...queued].reduce((a, j) => a + Math.max(0, j.size - j.done), 0);
  head.replaceChildren(
    h('span.q-title', icon('queue'), t('Átvitelek')),
    h('span.q-stat', t('{0} fut, {1} vár, {2} kész', running.length, queued.length, by('done').length)),
    errs.length ? h('span.q-err', t('{0} hiba', errs.length)) : null,
    speed ? h('span.q-speed', fmtSpeed(speed) + (leftBytes ? ' · ' + t('hátra: {0}', fmtEta(leftBytes / speed)) : '')) : null,
    h('span.grow'),
    errs.length ? h('button.btn.sm', { on: { click: () => { errs.forEach((j) => { j.status = 'queued'; j.error = null; j.done = 0; }); renderQueue(); pump(); } } }, icon('refresh'), t('Hibásak újra')) : null,
    running.length || queued.length ? h('button.btn.sm', { on: { click: () => [...queued, ...running].forEach(cancelJob) } }, icon('stop'), t('Összes leállítása')) : null,
    h('button.btn.sm', { disabled: !S.queue.some((j) => ['done', 'cancelled', 'skipped'].includes(j.status)) || null, on: { click: () => { S.queue = S.queue.filter((j) => !['done', 'cancelled', 'skipped'].includes(j.status)); renderQueue(); } } }, t('Befejezettek törlése')),
    h('button.icon-btn', { title: t('Elrejtés'), on: { click: () => { S.queueOpen = false; uiSet('fs.queueOpen', '0'); renderQueue(); renderToolbar(); renderXferStatus(); } } }, icon('down')));
}

function jobRow(j) {
  const tab = S.tabs.find((x) => x.id === j.tabId);
  const bar = h('div.q-bar', h('i'));
  const row = h('div.q-row.' + j.status, { title: `${j.local}\n${j.dir === 'up' ? '→' : '←'} ${j.remote}${j.error ? '\n' + j.error : ''}` },
    icon(j.dir === 'up' ? 'upload' : 'download'),
    h('span.q-name', j.name),
    h('span.q-site', tab ? tab.site.name || tab.site.host : ''),
    bar,
    h('span.q-size'),
    h('span.q-info'),
    h('button.icon-btn.q-x', { title: t('Leállítás'), on: { click: () => cancelJob(j) } }, icon('close')));
  j.el = row;
  updateJobRow(j);
  return row;
}

function updateJobRow(j) {
  const row = j.el;
  if (!row) { if (S.queueOpen && document.querySelector('#queue .q-body') && !S.queue.includes(j)) return; return; }
  row.className = 'q-row ' + j.status;
  const pct = j.size ? Math.min(100, (j.done / j.size) * 100) : j.status === 'done' ? 100 : 0;
  row.querySelector('.q-bar i').style.width = pct + '%';
  row.querySelector('.q-size').textContent = j.size ? `${fmtSize(j.done)} / ${fmtSize(j.size)}` : fmtSize(j.done);
  const info = row.querySelector('.q-info');
  info.textContent = {
    queued: t('vár'),
    running: [fmtSpeed(j.speed), j.speed && j.size ? fmtEta((j.size - j.done) / j.speed) : ''].filter(Boolean).join(' · ') || t('indul…'),
    done: t('kész') + (j.speed ? ' · ' + fmtSpeed(j.speed) : ''),
    error: j.error || t('hiba'),
    cancelled: t('megszakítva'),
    skipped: t('kihagyva'),
  }[j.status] || '';
  row.querySelector('.q-x').style.visibility = j.status === 'queued' || j.status === 'running' ? '' : 'hidden';
  if (j.status === 'running') {
    // the running rows stay in view
    const body = row.parentElement;
    if (body && (row.offsetTop < body.scrollTop || row.offsetTop > body.scrollTop + body.clientHeight - 20) && !body.matches(':hover')) row.scrollIntoView({ block: 'nearest' });
  }
}

// ───────────────────────── edit a remote file ─────────────────────────

async function editRemote(tab) {
  const sel = selectedEntries(tab, 'remote');
  if (sel.length !== 1 || sel[0].dir || !tab.session) return;
  const e = sel[0];
  const remote = sideJoin('remote', tab.remote.path, e.name);
  try {
    const dir = await invoke('temp_dir');
    const local = localJoin(dir, e.name);
    const job = mkJob(tab, false, remote, local, e.name, e.size);
    S.queue.push(job);
    renderQueue();
    await runJobDirect(tab, job);
    if (job.status !== 'done') return;
    const st = await invoke('local_stat', { path: local });
    S.watches.push({ id: uid(), tabId: tab.id, local, remote, name: e.name, mtime: st.mtime, size: st.size });
    await invoke('open_path', { path: local });
    toast(t('{0} megnyitva. Mentéskor az FtpStar automatikusan visszatölti a szerverre.', e.name), 'ok', 6000);
    renderStatus();
  } catch (er) { toast(friendly(er), 'err'); }
}

function runJobDirect(tab, job) {
  return runJob(tab, job);
}

setInterval(async () => {
  for (const w of S.watches) {
    const tab = S.tabs.find((x) => x.id === w.tabId);
    if (!tab?.session || w.busy) continue;
    const st = await invoke('local_stat', { path: w.local }).catch(() => null);
    if (!st?.exists || (st.mtime === w.mtime && st.size === w.size)) continue;
    w.mtime = st.mtime; w.size = st.size; w.busy = true;
    const job = mkJob(tab, true, w.local, w.remote, w.name, st.size);
    S.queue.push(job);
    renderQueue();
    await runJob(tab, job);
    w.busy = false;
    toast(job.status === 'done' ? t('{0} visszatöltve a szerverre.', w.name) : t('{0} visszatöltése sikertelen: {1}', w.name, job.error), job.status === 'done' ? 'ok' : 'err');
  }
}, 2000);

// ───────────────────────── status bar ─────────────────────────

function renderStatus() {
  const tab = cur();
  const sb = document.getElementById('statusbar');
  const watches = S.watches.filter((w) => S.tabs.some((x) => x.id === w.tabId));
  sb.replaceChildren(
    tab ? h('span', statusDot(tab), ' ', tab.status === 'connected' ? t('Kapcsolódva: {0}', siteSubtitle(tab.site)) : tab.status === 'connecting' ? t('Kapcsolódás…') : t('Nincs kapcsolat')) : h('span', t('Nincs megnyitott kapcsolat')),
    tab ? h('span', PROTOS[tab.site.protocol]?.label || '') : null,
    h('span.grow'),
    h('span#xfer-status.xfer-status', { on: { click: () => { S.queueOpen = true; uiSet('fs.queueOpen', '1'); renderQueue(); renderToolbar(); renderXferStatus(); } } }),
    watches.length ? h('a', { title: t('Kattints a figyelés leállításához'), on: { click: (e) => contextMenu(e, watches.map((w) => ({ label: t('Figyelés leállítása: {0}', w.name), icon: 'close', action: () => { S.watches = S.watches.filter((x) => x !== w); renderStatus(); } }))) } }, icon('edit'), ' ', t('{0} fájl szerkesztés alatt', watches.length)) : null,
    S.update?.updateAvailable ? h('span.update-status', { title: t('Kattints a telepítéshez'), on: { click: () => updateShowAvailable() } }, icon('download'), t('Frissítés elérhető: v{0}', S.update.latestVersion)) : null,
    h('span.zoom-status', { title: t('Nagyítás (Ctrl + / Ctrl − / Ctrl 0)'), on: { click: () => stepZoom(0) } }, Math.round((S.settings.zoom || 1) * 100) + '%'),
    h('span', 'v' + S.info.version));
  renderXferStatus();
}

// ───────────────────────── site manager ─────────────────────────

function blankSite(protocol = 'ftp') {
  return { id: uid(), name: '', protocol, host: '', port: 0, user: '', password: '', key_path: '', passphrase: '', active: false,
    remote_dir: '', local_dir: '', color: '', folder: '', notes: '', s3_region: '', s3_endpoint: '', s3_bucket: '', s3_path_style: false,
    onedrive_refresh_token: '', onedrive_account: '' };
}

async function siteManager(selectId = null, mode = null) {
  const sites = S.sites.map((s) => ({ ...s }));
  let selId = selectId || sites[0]?.id || null;
  if (mode === 'new' || !sites.length) { const s = blankSite(); s.name = t('Új oldal'); sites.push(s); selId = s.id; }
  const listEl = h('div.sm-list');
  const formEl = h('div.sm-form');
  const search = h('input.inp', { placeholder: t('Keresés…'), spellcheck: 'false', on: { input: () => drawList() } });
  const get = () => sites.find((s) => s.id === selId);

  function drawList() {
    const q = search.value.trim().toLowerCase();
    const groups = new Map();
    for (const s of sites) {
      if (q && !`${s.name} ${s.host} ${s.user} ${s.s3_bucket} ${s.folder}`.toLowerCase().includes(q)) continue;
      const g = s.folder || '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    const kids = [];
    for (const [g, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (g) kids.push(h('div.sm-group', icon('folder'), g));
      for (const s of list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))) {
        kids.push(h('div.sm-item' + (s.id === selId ? '.sel' : '') + (g ? '.in' : ''), {
          on: { click: () => { selId = s.id; drawList(); drawForm(); }, dblclick: () => { selId = s.id; finish('connect'); } },
        }, s.color ? h('span.sdot', { style: { background: s.color } }) : icon(PROTOS[s.protocol]?.icon || 'server'),
        h('div.sm-txt', h('div', s.name || t('(névtelen)')), h('div.p', siteSubtitle(s)))));
      }
    }
    if (!kids.length) kids.push(h('div.empty.small', t('Nincs oldal')));
    listEl.replaceChildren(...kids);
  }

  function field(label, el, note, cls = '') {
    return h('label.field' + cls, h('span', label), el, note ? h('span.note', note) : null);
  }
  function inp(s, key, attrs = {}) {
    const el = h('input.inp', { value: s[key] ?? '', spellcheck: 'false', ...attrs, on: { input: (e) => { s[key] = attrs.type === 'number' ? (+e.target.value || 0) : e.target.value; if (key === 'name' || key === 'host' || key === 'folder' || key === 'user' || key === 's3_bucket') drawList(); } } });
    return el;
  }
  function chk(s, key, label) {
    return h('label.chk', h('input', { type: 'checkbox', checked: !!s[key], on: { change: (e) => { s[key] = e.target.checked; } } }), label);
  }

  function drawForm() {
    const s = get();
    if (!s) { formEl.replaceChildren(h('div.empty', icon('server'), t('Válassz egy oldalt, vagy hozz létre újat.'))); return; }
    const proto = h('select.inp', { on: { change: (e) => { s.protocol = e.target.value; drawForm(); drawList(); } } },
      ...Object.entries(PROTOS).map(([k, v]) => h('option', { value: k }, v.label)));
    proto.value = s.protocol;
    const colors = h('div.sm-colors', ...TAB_COLORS.map((c) => h('button.sm-color' + (s.color === c ? '.on' : ''), {
      type: 'button', title: c || t('nincs'), style: { background: c || 'transparent' }, on: { click: () => { s.color = c; drawForm(); drawList(); } },
    }, c ? null : icon('close'))));
    const browseKey = async () => {
      try { const p = await invoke('plugin:dialog|open', { options: { multiple: false, title: t('Privát SSH kulcs') } }); if (p) { s.key_path = Array.isArray(p) ? p[0] : p; drawForm(); } } catch (e) { toast(e, 'err'); }
    };
    const browseLocal = async () => {
      try { const p = await invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title: t('Helyi kezdőmappa') } }); if (p) { s.local_dir = Array.isArray(p) ? p[0] : p; drawForm(); } } catch (e) { toast(e, 'err'); }
    };
    const p = s.protocol;
    const isFtp = p.startsWith('ftp');
    const rows = [
      h('div.sm-grid',
        field(t('Név'), inp(s, 'name', { placeholder: t('pl. Saját weboldal') }), null, '.full'),
        field(t('Protokoll'), proto),
        field(t('Mappa (csoport)'), inp(s, 'folder', { placeholder: t('pl. Ügyfelek'), list: 'sm-folders' })),
      ),
    ];
    if (isFtp || p === 'sftp') {
      rows.push(h('div.sm-grid',
        field(t('Szerver'), inp(s, 'host', { placeholder: 'ftp.example.com' }), null, '.wide'),
        field(t('Port'), inp(s, 'port', { type: 'number', min: 0, max: 65535, placeholder: String(PROTOS[p].port), value: s.port || '' })),
        field(t('Felhasználónév'), inp(s, 'user', { placeholder: isFtp ? 'anonymous' : 'root' })),
        field(t('Jelszó'), inp(s, 'password', { type: 'password', placeholder: t('üres = kapcsolódáskor kérdezi') })),
      ));
    }
    if (p === 'sftp') {
      rows.push(h('div.sm-grid',
        field(t('Privát kulcs'), h('div.row', inp(s, 'key_path', { placeholder: t('üres = ~/.ssh alapkulcsai (id_ed25519, id_rsa…)') }), h('button.btn', { type: 'button', on: { click: browseKey } }, t('Tallózás…'))), null, '.full'),
        field(t('Kulcs jelmondata'), inp(s, 'passphrase', { type: 'password', placeholder: t('ha a kulcs védett') })),
      ));
    }
    if (isFtp) rows.push(chk(s, 'active', t('Aktív mód (passzív helyett; tűzfal mögött ritkán működik)')));
    if (p === 's3') {
      rows.push(h('div.sm-grid',
        field(t('Bucket'), inp(s, 's3_bucket', { placeholder: 'my-bucket' })),
        field(t('Régió'), inp(s, 's3_region', { placeholder: 'eu-central-1' })),
        field(t('Hozzáférési kulcs (Access key ID)'), inp(s, 'user', { placeholder: 'AKIA…' })),
        field(t('Titkos kulcs (Secret access key)'), inp(s, 'password', { type: 'password', placeholder: t('üres = kapcsolódáskor kérdezi') })),
        field(t('Egyedi végpont (S3-kompatibilis)'), inp(s, 's3_endpoint', { placeholder: t('üres = AWS; pl. https://<id>.r2.cloudflarestorage.com') }),
          t('Cloudflare R2, MinIO, Wasabi, Backblaze B2, DigitalOcean Spaces…'), '.full'),
      ), chk(s, 's3_path_style', t('Path-style címzés (MinIO és sok saját szerver igényli)')));
    }
    if (p === 'onedrive') {
      const status = h('div.od-status', s.onedrive_refresh_token ? h('span.ok', icon('check'), t('Bejelentkezve: {0}', s.onedrive_account || 'OneDrive')) : h('span', t('Még nincs bejelentkezve.')));
      rows.push(h('div.od-box', status,
        h('div.row',
          h('button.btn.primary', { type: 'button', on: { click: async () => { const r = await oneDriveSignIn(); if (r) { s.onedrive_refresh_token = r.refresh_token; s.onedrive_account = r.account; if (!s.name || s.name === t('Új oldal')) s.name = 'OneDrive – ' + r.account; drawForm(); drawList(); } } } }, icon('user'), s.onedrive_refresh_token ? t('Újra bejelentkezés') : t('Bejelentkezés Microsoft-fiókkal')),
          s.onedrive_refresh_token ? h('button.btn', { type: 'button', on: { click: () => { s.onedrive_refresh_token = ''; s.onedrive_account = ''; drawForm(); drawList(); } } }, t('Kijelentkezés')) : null),
        !S.settings.onedrive_client_id ? h('div.note.err', t('Előbb add meg az Azure alkalmazás azonosítóját: Beállítások → Felhő.')) : null));
    }
    rows.push(h('div.sm-grid',
      field(t('Távoli kezdőmappa'), inp(s, 'remote_dir', { placeholder: p === 's3' || p === 'onedrive' ? '/' : t('üres = a bejelentkezési mappa') })),
      field(t('Helyi kezdőmappa'), h('div.row', inp(s, 'local_dir', { placeholder: t('üres = az utoljára használt') }), h('button.btn', { type: 'button', on: { click: browseLocal } }, t('Tallózás…')))),
      field(t('Fül színe'), colors, null, '.full'),
      field(t('Megjegyzés'), h('textarea.inp', { rows: 2, value: s.notes, on: { input: (e) => { s.notes = e.target.value; } } }), null, '.full'),
    ));
    if (s.password && p !== 'onedrive') rows.push(h('div.note', icon('lock'), t('A jelszó a beállítások mappájában, a sites.json fájlban tárolódik ezen a gépen. Hagyd üresen, ha inkább kapcsolódáskor adnád meg.')));
    formEl.replaceChildren(...rows, h('datalist#sm-folders', ...[...new Set(sites.map((x) => x.folder).filter(Boolean))].map((f) => h('option', { value: f }))));
  }

  const addSite = (proto) => { const s = blankSite(proto); s.name = t('Új oldal'); sites.push(s); selId = s.id; search.value = ''; drawList(); drawForm(); formEl.querySelector('input')?.select(); };
  const tools = h('div.sm-tools',
    h('button.btn.sm', { type: 'button', on: { click: (e) => contextMenu(e, Object.entries(PROTOS).map(([k, v]) => ({ label: v.label, icon: v.icon, action: () => addSite(k) }))) } }, icon('plus'), t('Új')),
    h('button.btn.sm', { type: 'button', on: { click: () => { const s0 = get(); if (!s0) return; const s = { ...s0, id: uid(), name: s0.name + ' ' + t('(másolat)') }; sites.push(s); selId = s.id; drawList(); drawForm(); } } }, icon('copy'), t('Másolat')),
    h('button.btn.sm', { type: 'button', on: { click: async () => { const s0 = get(); if (!s0) return; if (!(await confirmDlg(t('Oldal törlése'), t('Törlöd ezt az oldalt: {0}?', s0.name || s0.host), t('Törlés'), true))) return; sites.splice(sites.indexOf(s0), 1); selId = sites[0]?.id || null; drawList(); drawForm(); } } }, icon('trash')));

  let finish;
  const body = h('div.sitemgr', h('div.sm-left', search, listEl, tools), formEl);
  drawList(); drawForm();
  const res = await new Promise((resolve) => {
    finish = (v) => { document.querySelector('.overlay:last-of-type .modal-x')?.click(); resolve(v); };
    modal({ title: t('Oldalkezelő'), body, wide: true, buttons: [
      { label: t('Mégse'), value: 'cancel' },
      { label: t('Mentés'), value: 'save' },
      { label: t('Kapcsolódás'), value: 'connect', primary: true },
    ] }).then((v) => resolve(v));
  });
  if (!res || res === 'cancel') return;
  for (const s of sites) { s.name = s.name.trim(); s.host = s.host.trim(); }
  S.sites = sites;
  await saveSites();
  // open tabs follow the edited sites
  for (const tab of S.tabs) { const s = sites.find((x) => x.id === tab.site.id); if (s) tab.site = { ...s }; }
  if (res === 'connect' && get()) {
    const problem = siteProblem(get());
    if (problem) { toast(problem, 'err'); renderAll(); return siteManager(get().id); }
    openTab(get());
  }
  else renderAll();
}

async function oneDriveSignIn() {
  const clientId = S.settings.onedrive_client_id;
  let dc;
  try { dc = await busy(() => invoke('onedrive_device_start', { clientId })); }
  catch (e) { toast(friendly(e), 'err'); return null; }
  let stop = false;
  const msg = h('div.od-wait', icon('refresh', 'spin'), t('Várakozás a bejelentkezésre…'));
  const p = modal({
    title: t('Bejelentkezés: Microsoft OneDrive'),
    body: h('div.od-device',
      h('p', t('Nyisd meg a Microsoft bejelentkezési oldalát, és add meg ezt a kódot:')),
      h('div.od-code', dc.user_code),
      h('div.row',
        h('button.btn.primary', { type: 'button', on: { click: () => { navigator.clipboard.writeText(dc.user_code).catch(() => {}); invoke('open_url', { url: dc.verification_uri }); } } }, icon('globe'), t('Kód másolása és az oldal megnyitása')),
        h('span.p', dc.verification_uri)),
      msg),
    buttons: [{ label: t('Mégse'), value: null }],
  }).then(() => { stop = true; return null; });
  const started = Date.now();
  const poll = (async () => {
    while (!stop && Date.now() - started < dc.expires_in * 1000) {
      await new Promise((r) => setTimeout(r, Math.max(2, dc.interval) * 1000));
      if (stop) return null;
      try {
        const r = await invoke('onedrive_device_poll', { clientId, deviceCode: dc.device_code });
        if (r.status === 'ok') { stop = true; return r; }
      } catch (e) { msg.replaceChildren(icon('info'), friendly(e)); return null; }
    }
    return null;
  })();
  const r = await Promise.race([p, poll]);
  if (r) { [...document.querySelectorAll('.overlay')].pop()?.querySelector('.modal-x')?.click(); toast(t('Bejelentkezve: {0}', r.account), 'ok'); }
  return r;
}

async function quickConnect() {
  const v = await formDlg(t('Gyors kapcsolódás'), [
    { name: 'protocol', label: t('Protokoll'), type: 'select', value: uiGet('fs.quickProto') || 'sftp', options: Object.entries(PROTOS).filter(([k]) => k !== 's3' && k !== 'onedrive').map(([k, x]) => ({ value: k, label: x.label })) },
    { name: 'host', label: t('Szerver'), placeholder: 'example.com', value: uiGet('fs.quickHost') || '' },
    { name: 'port', label: t('Port (üres = alapértelmezett)'), type: 'number', value: '' },
    { name: 'user', label: t('Felhasználónév'), value: uiGet('fs.quickUser') || '' },
    { name: 'password', label: t('Jelszó'), type: 'password' },
    { name: 'save', label: t('Mentés az Oldalkezelőbe'), type: 'checkbox', value: false },
  ], t('Kapcsolódás'));
  if (!v || !v.host.trim()) return;
  uiSet('fs.quickProto', v.protocol); uiSet('fs.quickHost', v.host.trim()); uiSet('fs.quickUser', v.user.trim());
  const s = { ...blankSite(v.protocol), name: v.host.trim(), host: v.host.trim(), port: +v.port || 0, user: v.user.trim(), password: v.save ? v.password : '' };
  if (v.save) { S.sites.push(s); await saveSites(); }
  const tab = openTab({ ...s }, { connect: false });
  connectTab(tab, null, v.password);
}

// ───────────────────────── settings ─────────────────────────

async function settingsDlg() {
  const s = S.settings;
  const els = {};
  const fld = (name, label, el, note, full) => { els[name] = el; return h('label.field' + (full ? '.full' : ''), h('span', label), el, note ? h('span.note', note) : null); };
  const sel = (opts, val) => { const e = h('select.inp', opts.map(([v, l]) => h('option', { value: v }, l))); e.value = val; return e; };
  const chk = (name, label, val) => { const e = h('input', { type: 'checkbox', checked: !!val }); els[name] = e; return h('label.chk.full', e, label); };
  const updCheck = h('input', { type: 'checkbox', checked: s.update_check !== false });
  const updServer = h('input.inp', { value: s.update_server || '', placeholder: 'https://www.c64va.pro/', spellcheck: 'false' });
  // checks the address, saves it, then looks for a new version there
  const saveUpdServer = async () => {
    try { await invoke('update_server_check', { url: updServer.value }); }
    catch (e) { toast(String(e), 'err'); return; }
    S.settings.update_server = updServer.value.trim();
    await saveSettings();
    checkForAppUpdate();
  };
  const tabs = [
    ['general', t('Általános'), h('div.settings-grid',
      fld('ui_language', t('Felület nyelve'), sel([['auto', t('Automatikus (rendszer)')], ['hu', 'Magyar'], ['en', 'English']], s.ui_language || 'auto')),
      fld('overwrite', t('Ha a célfájl már létezik'), sel([['ask', t('Kérdezzen')], ['overwrite', t('Felülírás')], ['newer', t('Csak ha újabb')], ['skip', t('Kihagyás')]], s.overwrite || 'ask')),
      fld('parallel', t('Párhuzamos átvitelek kapcsolatonként'), sel([1, 2, 3, 4, 6, 8].map((n) => [String(n), String(n)]), String(s.parallel || 2)), t('FTP-nél mindegyik saját kapcsolatot nyit.')),
      fld('timeout', t('Hálózati időkorlát (másodperc)'), h('input.inp', { type: 'number', min: 5, max: 600, value: s.timeout || 30 }), t('Ennyi ideig vár a kapcsolódásra, illetve egy elakadt átvitelre (5–600). Lassú szervernél növeld.')),
      chk('show_hidden', t('Rejtett fájlok megjelenítése (.pont kezdetű nevek)'), s.show_hidden),
      chk('confirm_delete', t('Megerősítés törlés előtt'), s.confirm_delete !== false))],
    ['look', t('Megjelenés'), h('div.settings-grid',
      fld('theme', t('Téma'), sel([['dark', t('Sötét')], ['light', t('Világos')], ['ai', 'AI (neon)'], ['retro', t('Retró (8 bites)')], ['modern', t('Modern (üveg)')], ['modern-dark', t('Modern sötét (üveg)')], ['system', t('Rendszer szerint')]], s.theme || 'dark')),
      fld('font_size', t('Betűméret'), h('input.inp', { type: 'number', min: 10, max: 20, value: s.font_size || 13 })),
      fld('zoom', t('Nagyítás'), sel(ZOOMS.map((z) => [String(z), Math.round(z * 100) + '%']), String(ZOOMS.includes(s.zoom) ? s.zoom : 1)), t('Gyorsan: Ctrl + / Ctrl − / Ctrl 0, vagy Ctrl + egérgörgő.')))],
    ['cloud', t('Felhő'), h('div.settings-grid',
      fld('onedrive_client_id', t('OneDrive: Azure alkalmazás (client) azonosító'), h('input.inp', { value: s.onedrive_client_id || '', placeholder: '00000000-0000-0000-0000-000000000000', spellcheck: 'false' }),
        t('Egyszer kell beállítani: portal.azure.com → App registrations → New registration (személyes Microsoft-fiókok is), Authentication → „Allow public client flows” = Yes, API permissions: Files.ReadWrite.All, offline_access, User.Read. Az Application (client) ID-t másold ide.'), true),
      h('div.note.full', t('Amazon S3 és S3-kompatibilis szolgáltatók (R2, MinIO, Wasabi…): a kulcsokat oldalanként az Oldalkezelőben add meg.')))],
    ['update', t('Frissítések'), h('div.settings-grid',
      h('label.chk.full', updCheck, t('Új verzió keresése induláskor')),
      h('label.field.full', h('span', t('Frissítési szerver')), h('div', { style: { display: 'flex', gap: '6px' } }, updServer,
        h('button.btn', { type: 'button', on: { click: () => saveUpdServer() } }, t('Keresés most'))),
        h('span.note', t('Elég a szerver címe (pl. https://www.c64va.pro/), az FtpStar a downloads/FtpStar/ mappában keresi a telepítőket. Más mappához add meg a teljes címét. Üres = alapértelmezett.'))))],
  ];
  const tabBtns = tabs.map(([id, label]) => h('button.stab', { type: 'button', 'data-label': label, on: { click: () => show(id) } }, label));
  const panes = h('div.settings-panes', ...tabs.map((x) => x[2]));
  const show = (id) => { tabs.forEach(([tid, , el], i) => { el.classList.toggle('on', tid === id); tabBtns[i].classList.toggle('on', tid === id); }); uiSet('fs.settingsTab', id); };
  show(tabs.some((x) => x[0] === uiGet('fs.settingsTab')) ? uiGet('fs.settingsTab') : 'general');
  const ok = await modal({ title: t('Beállítások'), wide: true, body: h('div.settings', h('div.settings-tabs', ...tabBtns), panes),
    buttons: [{ label: t('Mégse'), value: false }, { label: t('Mentés'), value: true, primary: true }] });
  if (!ok) return;
  Object.assign(S.settings, {
    ui_language: els.ui_language.value,
    overwrite: els.overwrite.value,
    parallel: +els.parallel.value || 2,
    timeout: Math.max(5, Math.min(600, Math.round(+els.timeout.value) || 30)),
    show_hidden: els.show_hidden.checked,
    confirm_delete: els.confirm_delete.checked,
    theme: els.theme.value,
    font_size: Math.max(10, Math.min(20, +els.font_size.value || 13)),
    zoom: +els.zoom.value || 1,
    onedrive_client_id: els.onedrive_client_id.value.trim(),
    update_check: updCheck.checked,
  });
  try { await invoke('update_server_check', { url: updServer.value }); S.settings.update_server = updServer.value.trim(); }
  catch (e) { toast(String(e), 'err'); }
  await saveSettings();
  applyLang(); applyTheme(); applyZoom();
  renderAll();
  for (const tab of S.tabs) { listPane(tab, 'local'); listPane(tab, 'remote'); }
}

async function aboutDlg() {
  await modal({
    title: t('Névjegy'),
    body: h('div.about',
      h('div.about-hero', h('div.about-logo', h('img', { src: 'img/icon.svg', alt: '' })), h('div.about-name', 'FtpStar'), h('div.about-ver', 'v' + S.info.version),
      h('div.about-tag', t('FTP, FTPS, SFTP, Amazon S3 (és kompatibilis) és Microsoft OneDrive kliens két panellel, átviteli sorral, mappa-összevetéssel, távoli szerkesztéssel és képek bélyegképeivel.'))),
    h('div.about-feats', [
      ['server', 'FTP / FTPS'], ['lock', 'SFTP'], ['bucket', 'Amazon S3'], ['drive', 'OneDrive'],
      ['queue', t('Átviteli sor')], ['compare', t('Összevetés')], ['edit', t('Távoli szerkesztés')], ['image', t('Ikonok és bélyegképek')], ['globe', t('Magyar / English')],
    ].map(([ic, l]) => h('span.about-feat', icon(ic), l))),
    h('div.about-info', [
      [t('Verzió'), S.info.version || '?'],
      [t('Rendszer'), S.info.os || '?'],
      [t('Beállítások mappája'), S.info.config_dir || '?'],
    ].map(([k, v]) => [h('span.k', k), h('span.v', { title: v }, v)]),
      h('span.k', t('Weboldal')), h('span.v', h('a.about-link', { title: SITE_URL, on: { click: () => invoke('open_url', { url: SITE_URL }).catch((e) => toast(String(e), 'err')) } }, SITE_URL.replace(/^https:\/\//, '')))),
    h('div.about-foot', t('Rust + Tauri 2. A GitStar testvérprogramja.')),
    h('div.about-free', t('Az FtpStar ingyenes (freeware). Ha hasznos neked, egy kis adománnyal támogathatod a fejlesztést. Köszönöm!')),
    h('div.about-copy', '© 2026 Zsolt Tarczali')),
    buttons: [{ label: t('Adomány'), value: 'donate' }, { label: t('Frissítések keresése'), value: 'update' },
      { label: t('Beállítások mappája'), value: 'folder' }, { label: t('Bezárás'), value: true, primary: true }],
  }).then((v) => {
    if (v === 'donate') openDonate();
    if (v === 'update') checkForAppUpdate();
    if (v === 'folder') invoke('reveal_path', { path: S.info.config_dir + (isWin() ? '\\settings.json' : '/settings.json') }).catch(() => {});
  });
}

// ── donation (same as GitStar: the button appears after 10 minutes of use) ──
const DONATE_URL = 'https://www.c64va.pro/register/donate.php';
const SITE_URL = 'https://www.c64va.pro/ftpstar.html';
function startDonationTimer() {
  let remaining = 10 * 60 * 1000;
  let started = null;
  let timer;
  const update = () => {
    clearTimeout(timer);
    if (started !== null) remaining -= performance.now() - started;
    started = null;
    if (remaining <= 0) {
      S.donationVisible = true;
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
      renderToolbar();
    } else if (!document.hidden && document.hasFocus()) {
      started = performance.now();
      timer = setTimeout(update, remaining);
    }
  };
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  update();
}

function openDonate() {
  invoke('open_url', { url: `${DONATE_URL}?lang=${getLang() === 'hu' ? 'hu' : 'en'}` }).catch((e) => toast(String(e), 'err'));
}

// ── self-update (same flow as GitStar) ──
// The newest installer is looked up in the download folder (Settings → Update);
// "Install now" downloads it with a progress bar, starts it and FtpStar restarts.

let updBusy = false;

function updateDlgEls() {
  let ov = document.getElementById('update-ov');
  if (ov) return ov.els;
  const els = {
    title: h('div.modal-h'), msg: h('div.desc.update-msg'),
    bar: h('div.update-bar-fill'), text: h('div.update-progress-text'),
    skip: h('button.btn', t('Kihagyom ezt a verziót')),
    close: h('button.btn', t('Bezárás')),
    install: h('button.btn.primary', icon('download'), t('Telepítés most')),
  };
  els.prog = h('div.update-progress', h('div.update-bar', els.bar), els.text);
  ov = h('div.overlay#update-ov',
    h('div.modal.update-dlg', els.title, h('div.modal-b', els.msg, els.prog), h('div.modal-f', els.skip, els.close, els.install)));
  ov.els = els;
  const shut = () => { if (!updBusy) { ov.remove(); document.removeEventListener('keydown', onKey, true); } };
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); } }
  els.close.addEventListener('click', shut);
  els.skip.addEventListener('click', () => {
    S.settings.update_skip = S.update?.latestVersion || '';
    saveSettings();
    shut();
  });
  els.install.addEventListener('click', () => installUpdate());
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  return els;
}

/** state: null = hidden, -1 = indeterminate (animated), 0..100 = percent */
function updateProgress(state, label = '') {
  const els = updateDlgEls();
  els.prog.style.display = state === null ? 'none' : '';
  els.bar.classList.toggle('indet', state === -1);
  els.bar.style.width = state >= 0 ? state + '%' : '';
  els.text.textContent = label;
}

function updateShow({ title, msg, install = false, skip = false, closeLabel = t('Bezárás') }) {
  const els = updateDlgEls();
  els.title.textContent = title;
  els.msg.textContent = msg;
  els.install.style.display = install ? '' : 'none';
  els.skip.style.display = skip ? '' : 'none';
  els.close.textContent = closeLabel;
  els.close.disabled = false;
  if (!install) updateProgress(null);
}

function updateShowAvailable() {
  const u = S.update;
  if (!u?.updateAvailable) return;
  updateShow({ title: t('Új verzió érhető el'),
    msg: t('Elérhető az FtpStar {0} (most: {1}). Letöltöm és telepítem? Az FtpStar a telepítés után újraindul.', u.latestVersion, u.currentVersion),
    install: true, skip: true, closeLabel: t('Később') });
  updateProgress(null);
}

async function checkForAppUpdate({ silent = false } = {}) {
  if (updBusy) return;
  if (!silent) { updateShow({ title: t('Frissítések keresése'), msg: t('Új verzió keresése…') }); updateProgress(-1); }
  updBusy = true;
  let info;
  try { info = await invoke('check_for_update'); }
  catch (e) {
    updBusy = false;
    if (!silent) updateShow({ title: t('Frissítések keresése'), msg: t('A frissítés ellenőrzése nem sikerült: {0}', String(e)) });
    return;
  }
  updBusy = false;
  S.update = info;
  renderStatus();
  if (!info?.supported) { if (!silent) updateShow({ title: t('Frissítések keresése'), msg: t('Ezen a platformon nincs automatikus frissítés.') }); return; }
  if (!info.updateAvailable) { if (!silent) updateShow({ title: t('Frissítések keresése'), msg: t('Az FtpStar naprakész (v{0}).', info.currentVersion) }); return; }
  if (silent && (S.settings.update_skip === info.latestVersion || document.querySelector('.overlay'))) return;
  updateShowAvailable();
}

async function installUpdate() {
  const u = S.update;
  if (updBusy || !u?.updateAvailable) return;
  const running = S.queue.filter((j) => j.status === 'running' || j.status === 'queued').length;
  if (running && !(await confirmDlg(t('Telepítés most'), t('{0} átvitel még fut vagy várakozik. Biztosan frissítesz most? Ezek megszakadnak.', running), t('Telepítés most')))) return;
  const els = updateDlgEls();
  updBusy = true;
  els.install.style.display = 'none';
  els.skip.style.display = 'none';
  els.close.disabled = true;
  els.msg.textContent = t('Az FtpStar {0} letöltése…', u.latestVersion);
  updateProgress(-1);
  let unlisten = null;
  try {
    const mb = (n) => (n / 1048576).toFixed(1);
    unlisten = await listen('update-download-progress', ({ payload: { received, total } }) => {
      if (total > 0) updateProgress(Math.min(100, Math.round((received * 100) / total)), `${mb(received)} / ${mb(total)} MB`);
      else updateProgress(-1, `${mb(received)} MB`);
    });
    const res = await invoke('download_and_install_update', { version: u.latestVersion });
    updateProgress(100);
    if (res.restarting) {
      els.msg.textContent = t('A telepítő elindult, az FtpStar most bezárul és újraindul.');
    } else {
      updBusy = false;
      updateShow({ title: t('Új verzió érhető el'), msg: t('A telepítő megnyílt ({0}). Fejezd be a telepítést, majd indítsd újra az FtpStart.', res.path) });
    }
  } catch (e) {
    updBusy = false;
    updateShow({ title: t('Új verzió érhető el'), msg: t('A frissítés nem sikerült: {0}', String(e)), install: true });
    updateProgress(null);
  } finally { unlisten?.(); }
}

// ───────────────────────── start ─────────────────────────

async function init() {
  S.settings = await invoke('get_settings');
  S.sites = await invoke('get_sites');
  S.local = await invoke('local_home');
  S.info = await invoke('app_info');
  initUiState(S.settings.ui || (S.settings.ui = {}), saveSettings);
  S.queueOpen = uiGet('fs.queueOpen') !== '0';
  applyLang(); applyTheme(); applyZoom();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.settings.theme === 'system') { applyTheme(); renderAll(); } });
  splitter(document.getElementById('queue-split'), document.getElementById('queue'), { vertical: false, min: 80, max: 700, invert: true, key: 'fs.queueHeight' });
  for (const id of S.settings.open_sites || []) {
    const site = S.sites.find((s) => s.id === id);
    if (!site) continue;
    // connect right away only when no password has to be asked
    const silent = site.password || site.protocol === 'onedrive' || site.protocol === 'sftp';
    openTab(site, { connect: !!silent });
  }
  if (S.tabs.length) S.active = 0;
  renderAll();
  startDonationTimer();
  invoke('ui_ready').catch(() => {});
  // quiet update check a little after startup (Settings → Update)
  if (S.settings.update_check !== false) setTimeout(() => checkForAppUpdate({ silent: true }), 4000);
}

init().catch((e) => { document.body.textContent = 'FtpStar: ' + e; invoke('ui_ready').catch(() => {}); });
