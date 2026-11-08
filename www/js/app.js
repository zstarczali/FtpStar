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
  return { side, path, entries: [], sel: new Set(), anchor: null, cursor: null, sort: { key: 'name', asc: true }, filter: '', back: [], loading: false, error: null };
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

async function closeTab(i) {
  const tab = S.tabs[i];
  if (!tab) return;
  const running = S.queue.filter((j) => j.tabId === tab.id && (j.status === 'running' || j.status === 'queued'));
  if (running.length && !(await confirmDlg(t('Fül bezárása'), t('{0} átvitel még fut vagy várakozik ezen a kapcsolaton. Megszakítod őket?', running.length), t('Bezárás'), true))) return;
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
    tb('compare', t('Összevetés'), () => { tab.compare = !tab.compare; renderAll(); }, { disabled: !on, cls: tab?.compare ? '.on' : '', title: t('A két oldal összevetése: hiányzó, eltérő és újabb fájlok kiemelése') }),
    tb('edit', t('Szerkesztés'), () => editRemote(tab), { disabled: !on || tab.focus !== 'remote' || fp.sel.size !== 1 || [...fp.entries].find((e) => fp.sel.has(e.name))?.dir, title: t('Távoli fájl megnyitása szerkesztésre; mentéskor automatikusan visszatöltődik') }),
    h('div.tb-spacer'),
    tb('queue', t('Átvitelek'), () => { S.queueOpen = !S.queueOpen; uiSet('fs.queueOpen', S.queueOpen ? '1' : '0'); renderQueue(); }, { badge: active || null, cls: S.queueOpen ? '.on' : '' }),
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

function renderPaneHead(tab, side) {
  const pane = tab[side];
  if (!pane.el) return;
  const head = pane.el.querySelector('.fp-head');
  const remote = side === 'remote';
  const title = remote ? (tab.site.name || tab.site.host) : t('Helyi gép');
  const pathInp = h('input.inp.fp-path', { value: pane.path || (isWin() ? t('Meghajtók') : '/'), spellcheck: 'false',
    on: { keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); navigate(tab, side, e.target.value.trim() || (remote ? '/' : '')); } if (e.key === 'Escape') e.target.value = pane.path; } } });
  const filter = h('input.inp.fp-filter', { value: pane.filter, placeholder: t('Szűrő (pl. *.jpg)'), spellcheck: 'false',
    on: { input: (e) => { pane.filter = e.target.value; renderRows(tab, side); } } });
  head.replaceChildren(
    h('div.fp-title', icon(remote ? (PROTOS[tab.site.protocol]?.icon || 'server') : 'drive'), h('span.t', title),
      remote ? statusDot(tab) : null, pane.loading ? icon('refresh', 'spin') : null, h('span.grow'),
      remote && !tab.session && tab.status !== 'connecting' ? h('button.btn.sm.primary', { on: { click: () => connectTab(tab) } }, icon('plug'), t('Kapcsolódás')) : null,
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
  if (parent != null && !pane.filter) {
    frag.append(h('div.frow.up', { dataset: { name: '..' } }, h('div.fc.c-name', icon('arrowUp'), h('span.n', '..')), h('div.fc.c-size'), h('div.fc.c-mtime'), h('div.fc.c-perms')));
  }
  for (const e of list) {
    const mark = compareMark(tab, side, e);
    const cls = (pane.sel.has(e.name) ? '.sel' : '') + (pane.cursor === e.name ? '.cur' : '') + (e.dir ? '.dir' : '') + (mark ? '.cmp-' + mark : '');
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
  if (name === '..') { pane.sel.clear(); pane.cursor = null; renderRows(tab, side); renderToolbar(); return; }
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
  renderRows(tab, side);
  renderToolbar();
  renderStatus();
}

function openEntry(tab, side, name) {
  const pane = tab[side];
  if (name === '..') return goUp(tab, side);
  const e = pane.entries.find((x) => x.name === name);
  if (!e) return;
  if (e.dir) return navigate(tab, side, e.drive ? e.name : sideJoin(side, pane.path, e.name));
  // a file: send it to the other side
  if (tab.session) { pane.sel = new Set([name]); transfer(tab, side); }
  else if (side === 'local') invoke('open_path', { path: sideJoin(side, pane.path, name) }).catch((er) => toast(er, 'err'));
}

let drag = null;

function wireBody(tab, side, body) {
  const rowOf = (ev) => ev.target.closest('.frow');
  body.addEventListener('click', (e) => {
    const r = rowOf(e);
    if (!r) { if (!e.ctrlKey && !e.shiftKey) { tab[side].sel.clear(); renderRows(tab, side); renderToolbar(); } return; }
    if (drag?.moved) return;
    selectRow(tab, side, r.dataset.name, e);
  });
  body.addEventListener('dblclick', (e) => { const r = rowOf(e); if (r) openEntry(tab, side, r.dataset.name); });
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
    sel.length ? { label: remote ? t('Letöltés ({0})', sel.length) : t('Feltöltés ({0})', sel.length), icon: remote ? 'download' : 'upload', disabled: !on, key: 'F5', action: () => transfer(tab, side) } : null,
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
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); pane.sel = new Set(order); renderRows(tab, side); renderToolbar(); return; }
  switch (e.key) {
    case 'Tab': e.preventDefault(); setFocus(tab, side === 'local' ? 'remote' : 'local'); return;
    case 'Backspace': e.preventDefault(); goUp(tab, side); return;
    case 'ArrowLeft': if (e.altKey) { e.preventDefault(); goBack(tab, side); } return;
    case 'Enter': e.preventDefault(); if (pane.cursor) openEntry(tab, side, pane.cursor); else if (hasUp) goUp(tab, side); return;
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
      const step = e.key.startsWith('Page') ? 15 : 1;
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
    } catch (er) { errors++; toast(`${e.name}: ${friendly(er)}`, 'err'); }
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
      if (!choice) return;
    }
    if (choice === 'skip') skip = new Set(conflicts.map((c) => c.job));
    if (choice === 'newer') skip = new Set(conflicts.filter((c) => !((c.src.mtime || 0) > (c.dst.mtime || 0) + 1 || (c.src.size !== c.dst.size && !c.dst.mtime))).map((c) => c.job));
  }
  const add = jobs.filter((j) => !skip.has(j));
  if (!add.length) { toast(t('Nincs mit átvinni (minden fájl kihagyva).')); listPane(tab, toSide); return; }
  S.queue.push(...add);
  if (!S.queueOpen && add.length > 1) { S.queueOpen = true; }
  renderQueue();
  renderToolbar();
  pump();
}

function mkJob(tab, up, srcPath, dstPath, name, size) {
  return {
    id: uid(), tabId: tab.id, dir: up ? 'up' : 'down',
    local: up ? srcPath : dstPath, remote: up ? dstPath : srcPath,
    name, size: size || 0, done: 0, status: 'queued', error: null, speed: 0, started: 0, last: null, el: null,
  };
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
  try {
    await invoke('transfer', { session: tab.session, id: job.id, direction: job.dir, local: job.local, remote: job.remote, size: job.size });
    job.status = 'done';
    job.done = Math.max(job.done, job.size);
  } catch (e) {
    job.status = String(e) === 'CANCELLED' ? 'cancelled' : 'error';
    job.error = friendly(e);
  }
  job.speed = job.status === 'done' ? (job.size / Math.max(0.001, (Date.now() - job.started) / 1000)) : 0;
  updateJobRow(job);
  renderQueueHead();
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
  if (job.status === 'queued') { job.status = 'cancelled'; updateJobRow(job); renderQueueHead(); }
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
listen('tauri://drag-drop', async (ev) => {
  const tab = cur();
  const { paths, position } = ev.payload || {};
  if (!tab || !paths?.length) return;
  const el = document.elementFromPoint(position.x / devicePixelRatio, position.y / devicePixelRatio);
  if (!el?.closest('.fpane.remote')) { toast(t('Fájlok feltöltéséhez a jobb oldali (távoli) panelre húzd őket.')); return; }
  if (!tab.session) { toast(t('Nincs kapcsolat.'), 'err'); return; }
  const items = [];
  for (const p of paths) {
    const st = await invoke('local_stat', { path: p });
    if (st.exists) items.push({ name: p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(), dir: st.dir, size: st.size, mtime: st.mtime, path: p });
  }
  const row = el.closest('.frow.dir');
  const folder = row && row.dataset.name !== '..' ? sideJoin('remote', tab.remote.path, row.dataset.name) : null;
  transfer(tab, 'local', { items, dstPath: folder });
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

function renderQueueHead() {
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
    h('button.icon-btn', { title: t('Elrejtés'), on: { click: () => { S.queueOpen = false; uiSet('fs.queueOpen', '0'); renderQueue(); renderToolbar(); } } }, icon('down')));
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
    watches.length ? h('a', { title: t('Kattints a figyelés leállításához'), on: { click: (e) => contextMenu(e, watches.map((w) => ({ label: t('Figyelés leállítása: {0}', w.name), icon: 'close', action: () => { S.watches = S.watches.filter((x) => x !== w); renderStatus(); } }))) } }, icon('edit'), ' ', t('{0} fájl szerkesztés alatt', watches.length)) : null,
    h('span.zoom-status', { title: t('Nagyítás (Ctrl + / Ctrl − / Ctrl 0)'), on: { click: () => stepZoom(0) } }, Math.round((S.settings.zoom || 1) * 100) + '%'),
    h('span', 'v' + S.info.version));
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
  const tabs = [
    ['general', t('Általános'), h('div.settings-grid',
      fld('ui_language', t('Felület nyelve'), sel([['auto', t('Automatikus (rendszer)')], ['hu', 'Magyar'], ['en', 'English']], s.ui_language || 'auto')),
      fld('overwrite', t('Ha a célfájl már létezik'), sel([['ask', t('Kérdezzen')], ['overwrite', t('Felülírás')], ['newer', t('Csak ha újabb')], ['skip', t('Kihagyás')]], s.overwrite || 'ask')),
      fld('parallel', t('Párhuzamos átvitelek kapcsolatonként'), sel([1, 2, 3, 4, 6, 8].map((n) => [String(n), String(n)]), String(s.parallel || 2)), t('FTP-nél mindegyik saját kapcsolatot nyit.')),
      h('div'),
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
    show_hidden: els.show_hidden.checked,
    confirm_delete: els.confirm_delete.checked,
    theme: els.theme.value,
    font_size: Math.max(10, Math.min(20, +els.font_size.value || 13)),
    zoom: +els.zoom.value || 1,
    onedrive_client_id: els.onedrive_client_id.value.trim(),
  });
  saveSettings();
  applyLang(); applyTheme(); applyZoom();
  renderAll();
  for (const tab of S.tabs) { listPane(tab, 'local'); listPane(tab, 'remote'); }
}

async function aboutDlg() {
  await modal({
    title: t('Névjegy'),
    body: h('div.about',
      h('div.about-hero', h('div.about-logo', h('img', { src: 'img/icon.svg', alt: '' })), h('div.about-name', 'FtpStar'), h('div.about-ver', 'v' + S.info.version)),
      h('p.about-tag', t('FTP, FTPS, SFTP, Amazon S3 (és kompatibilis) és Microsoft OneDrive kliens két panellel, átviteli sorral, mappa-összevetéssel és távoli szerkesztéssel.')),
      h('p.note', t('A GitStar testvérprogramja.')),
      h('p.note', '© 2026 Zsolt Tarczali'),
      h('p.note', t('Beállítások mappája: {0}', S.info.config_dir))),
    buttons: [{ label: t('Beállítások mappája'), value: 'folder' }, { label: t('Bezárás'), value: true, primary: true }],
  }).then((v) => { if (v === 'folder') invoke('reveal_path', { path: S.info.config_dir + (isWin() ? '\\settings.json' : '/settings.json') }).catch(() => {}); });
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
  invoke('ui_ready').catch(() => {});
}

init().catch((e) => { document.body.textContent = 'FtpStar: ' + e; invoke('ui_ready').catch(() => {}); });
