// AI token counter: the status bar label and the details dialog.
// The backend (usage.rs) adds up the `usage` of every AI answer and sends `ai-usage` events.
// The same file is used by GitStar, DiffStar, NoteStar and SkillStar.

import { invoke, h, icon, modal, confirmDlg, toast } from './util.js';
import { getLang } from './i18n.js';

// own texts: the file is shared, the apps' dictionaries are not
const L = (hu, en, ...a) => (getLang() === 'en' ? en : hu).replace(/\{(\d+)\}/g, (m, i) => a[i] ?? '');

let report = null;
const listeners = [];

/** Loads the counts and listens for new answers; `onChange` redraws the status bar. */
export function aiUsageInit(onChange) {
  if (onChange) listeners.push(onChange);
  const set = (r) => { report = r; listeners.forEach((f) => f(r)); };
  invoke('ai_usage').then(set).catch(() => {});
  window.__TAURI__?.event?.listen('ai-usage', (e) => set(e.payload)).catch?.(() => {});
}

const sum = (c) => (c ? c.input + c.output + c.cache_write + c.cache_read : 0);

/** 1234 → "1,2k", 1234567 → "1,23M" (in the UI language). */
export function fmtTokens(n) {
  const loc = getLang() === 'en' ? 'en-US' : 'hu-HU';
  const f = (x, d) => x.toLocaleString(loc, { maximumFractionDigits: d });
  if (n < 1000) return f(n, 0);
  if (n < 1e6) return f(n / 1e3, n < 1e4 ? 1 : 0) + 'k';
  return f(n / 1e6, n < 1e7 ? 2 : 1) + 'M';
}
const full = (n) => n.toLocaleString(getLang() === 'en' ? 'en-US' : 'hu-HU');
const usd = (x) => '$' + x.toFixed(x < 1 ? 4 : 2);

/**
 * The status bar item: "AI: <model> · 12,3k token". `modelLabel` is what the app showed before
 * (model name or "no key").
 */
export function aiUsageItem(modelLabel) {
  const total = sum(report?.all?.total);
  const ses = report?.session;
  const tip = [
    L('Elhasznált AI tokenek – kattints a részletekért', 'AI tokens used – click for details'),
    L('Összesen: {0} token ({1} kérés)', 'Total: {0} tokens ({1} requests)', full(total), report?.all?.total?.requests || 0),
    L('Ebben a munkamenetben: {0} token', 'This session: {0} tokens', full(sum(ses))),
    report?.last ? L('Utolsó válasz: {0} be + {1} ki', 'Last answer: {0} in + {1} out', full(report.last.input + report.last.cache_read + report.last.cache_write), full(report.last.output)) : null,
  ].filter(Boolean).join('\n');
  return h('a.ai-usage', { title: tip, on: { click: () => aiUsageDlg() } },
    icon('sparkle'), L('AI: {0}', 'AI: {0}', modelLabel), total ? h('span.ai-tok', ` · ${fmtTokens(total)} ${L('token', 'tokens')}`) : null);
}

/** Details per provider / model, with a reset button. */
export async function aiUsageDlg() {
  try { report = await invoke('ai_usage'); } catch (e) { toast(String(e), 'err'); return; }
  const r = report;
  const head = h('tr', ['', L('Kérés', 'Requests'), L('Bemenet', 'Input'), L('Kimenet', 'Output'), L('Cache írás', 'Cache write'), L('Cache olvasás', 'Cache read'), L('Összesen', 'Total')].map((x) => h('th', x)));
  const row = (name, c, cls = '') => h('tr' + cls, h('td', name), ...[c.requests, c.input, c.output, c.cache_write, c.cache_read, sum(c)].map((x) => h('td.num', full(x))));
  const models = Object.entries(r.all.models || {}).sort((a, b) => sum(b[1]) - sum(a[1]));
  const cost = r.all.total.cost_usd;
  const since = new Date(r.all.since).toLocaleString(getLang() === 'en' ? 'en-US' : 'hu-HU');
  const body = h('div.ai-usage-dlg',
    h('div.desc', L('A számláló az AI válaszokban kapott token-felhasználást adja össze (Claude API, DeepSeek, Claude Code CLI). Számolás kezdete: {0}.',
      'The counter adds up the token usage reported with every AI answer (Claude API, DeepSeek, Claude Code CLI). Counting since {0}.', since)),
    h('table.ai-usage-tbl', h('thead', head), h('tbody',
      models.length ? models.map(([k, c]) => row(k, c)) : h('tr', h('td.dim', { colSpan: 7 }, L('Még nem volt AI kérés.', 'No AI request yet.'))),
      row(L('Összesen', 'Total'), r.all.total, '.tot'),
      row(L('Ez a munkamenet', 'This session'), r.session, '.ses'))),
    cost ? h('div.desc', L('A Claude Code CLI által jelentett költség: {0}', 'Cost reported by the Claude Code CLI: {0}', usd(cost))) : null,
    h('div.desc.dim', L('A cache-olvasás jóval olcsóbb a normál bemenetnél; a pontos díjat a szolgáltató felülete mutatja.',
      'Cache reads cost much less than normal input; the exact charges are on the provider\'s console.')));
  const res = await modal({ title: L('AI token-felhasználás', 'AI token usage'), body, wide: true, buttons: [
    { label: L('Nullázás…', 'Reset…'), value: 'reset', danger: true },
    { label: L('Bezárás', 'Close'), value: null, primary: true },
  ] });
  if (res === 'reset' && await confirmDlg(L('Számláló nullázása', 'Reset the counter'), L('Minden eddigi token-adat törlődik. Folytatod?', 'Every counted token is cleared. Continue?'), L('Nullázás', 'Reset'), true)) {
    try { report = await invoke('ai_usage_reset'); listeners.forEach((f) => f(report)); } catch (e) { toast(String(e), 'err'); }
  }
}
