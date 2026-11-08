// Small DOM / UI helpers shared by the views.

import { t, getLang } from './i18n.js';

export const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

// replaceChildren that skips null / false (conditional children)
const nativeReplace = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) {
  return nativeReplace.apply(this, kids.flat().filter((k) => k != null && k !== false));
};

/** h('div.cls#id', {attrs, on:{click}}, ...children) */
export function h(tag, attrs, ...children) {
  const m = tag.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const p of m[2].match(/[.#][\w-]+/g)) {
      if (p[0] === '.') el.classList.add(p.slice(1)); else el.id = p.slice(1);
    }
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [e, f] of Object.entries(v)) el.addEventListener(e, f);
      else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── icons (stroke icons, 24x24 grid) ──
const P = {
  viewList: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h1M4 12h1M4 18h1"/>',
  viewSmall: '<rect x="3" y="4" width="4" height="4" rx="1"/><path d="M10 6h11"/><rect x="3" y="10" width="4" height="4" rx="1"/><path d="M10 12h11"/><rect x="3" y="16" width="4" height="4" rx="1"/><path d="M10 18h11"/>',
  viewLarge: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5.5-5.5L6 20"/>',
  fetch: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  pull: '<path d="M12 3v13"/><path d="m6 10 6 6 6-6"/><circle cx="12" cy="20" r="1.5"/>',
  push: '<path d="M12 21V8"/><path d="m6 14 6-6 6 6"/><path d="M5 4h14"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 5-12 3-12 8"/>',
  merge: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10"/><path d="M6 7c0 4 6 5 10 5"/>',
  stash: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/>',
  pop: '<path d="M12 15V4"/><path d="m8 8 4-4 4 4"/><path d="M4 14v6h16v-6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  changes: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  compare: '<path d="M8 3v18"/><path d="M16 3v18"/><path d="m4 8 4-4 4 4"/><path d="m12 16 4 4 4-4"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  commit: '<circle cx="12" cy="12" r="4"/><path d="M3 12h5M16 12h5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  unified: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/>',
  wrap: '<path d="M4 6h16"/><path d="M4 12h13a3 3 0 0 1 0 6h-4"/><path d="m14 16-2 2 2 2"/><path d="M4 18h5"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  blame: '<path d="M4 6h16M4 12h10M4 18h13"/><circle cx="19" cy="15" r="2"/>',
  console: '<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  heart: '<path d="M12 20.5S3 15.2 3 9.2a4.6 4.6 0 0 1 9-1.5 4.6 4.6 0 0 1 9 1.5c0 6-9 11.3-9 11.3z"/>',
  pr: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10"/><path d="M18 17V9a3 3 0 0 0-3-3h-4"/><path d="m13 3-3 3 3 3"/>',
};


// FtpStar icons
Object.assign(P, {
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  unplug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/><path d="M3 3l18 18"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m14 6 4 4"/>',
  rename: '<path d="M4 7h10M4 12h7M4 17h5"/><path d="M14 20h2l6-6-2-2-6 6z"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  arrowUp: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  queue: '<path d="M4 6h11M4 12h11M4 18h7"/><path d="m17 15 3 3-3 3"/><path d="M20 18h-6"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5 13 7.5 5h9L19 13"/><path d="M16 16.5h.01"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  bucket: '<path d="M4 6h16l-2 14H6z"/><ellipse cx="12" cy="6" rx="8" ry="2.5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 21v-5h-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
});


// AI theme: alternative icons (neural nets, chips, sparkles, data streams)
const SPARK = (x, y, s = 1) => `<path d="M${x} ${y - 2 * s}l${0.5 * s} ${1.4 * s} ${1.5 * s} ${0.6 * s}-${1.5 * s} ${0.6 * s}-${0.5 * s} ${1.4 * s}-${0.5 * s}-${1.4 * s}-${1.5 * s}-${0.6 * s} ${1.5 * s}-${0.6 * s}z"/>`;
const AI_P = {
  fetch: '<circle cx="12" cy="4" r="1.6"/><circle cx="6" cy="8" r="1.4"/><circle cx="18" cy="8" r="1.4"/><path d="M7.2 8.8 11 12M16.8 8.8 13 12M12 5.6V12"/><path d="M12 12v6"/><path d="m8.5 15.5 3.5 3.5 3.5-3.5"/><path d="M5 21.5h14" stroke-dasharray="2 2"/>',
  pull: '<rect x="7" y="2.5" width="10" height="7" rx="2"/><path d="M10 6h.01M14 6h.01"/><path d="M12 9.5V19"/><path d="m7.5 14.5 4.5 4.5 4.5-4.5"/><path d="M4 21.5h16" stroke-dasharray="1.5 2.5"/>',
  push: '<path d="M12 20V8"/><path d="m7 12 5-5 5 5"/>' + SPARK(12, 3.5) + '<circle cx="5" cy="19" r="1.3"/><circle cx="19" cy="19" r="1.3"/><path d="M6.3 19h3M14.7 19h3" stroke-dasharray="1 1.5"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><circle cx="18" cy="17" r="1.4"/><path d="M6 7v10"/><path d="M16.2 9.8C11 11 6 12 6 17"/><path d="M16.8 16.2 8 12" stroke-dasharray="1.5 1.5"/>',
  merge: '<circle cx="5" cy="5" r="1.8"/><circle cx="5" cy="19" r="1.8"/><circle cx="19" cy="12" r="2.6"/><path d="M6.6 6 16.6 11M6.6 18l10-5"/><path d="M5 6.8v10.4" stroke-dasharray="1.5 1.5"/><path d="M19 9.4V8M19 16v-1.4M21.6 12H23"/>',
  stash: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 1.5v2.5M15 1.5v2.5M9 20v2.5M15 20v2.5M1.5 9H4M1.5 15H4M20 9h2.5M20 15h2.5"/><rect x="8.5" y="8.5" width="7" height="7" rx="1.2"/><path d="M10.5 12h3"/>',
  pop: '<rect x="4" y="11" width="16" height="10" rx="3"/><path d="M8 21v1.5M16 21v1.5"/><path d="M12 15V4"/><path d="m8 8 4-4 4 4"/>' + SPARK(19, 5),
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m6.5 9 3 3-3 3"/><path d="M12 15h5"/>' + SPARK(17.5, 8.5, 0.8),
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="9" cy="13" r="1.2"/><circle cx="15" cy="11" r="1.2"/><circle cx="15" cy="15.5" r="1.2"/><path d="m10.1 12.5 3.8-1M10.1 13.6l3.8 1.5"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="2" r=".8"/><circle cx="12" cy="22" r=".8"/><circle cx="2" cy="12" r=".8"/><circle cx="22" cy="12" r=".8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>' ,
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>' + SPARK(17, 5),
  sparkle: SPARK(12, 10, 3.2) + SPARK(19, 17, 1.2) + SPARK(5, 4, 0.9),
  changes: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/>' + SPARK(19, 15) + SPARK(5, 5, 0.9),
  history: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 2"/><path d="M12 7v5l3.5 2.5"/><circle cx="12" cy="12" r="1.2"/>',
  compare: '<rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="16" rx="2"/><path d="M10 9h4M10 15h4" stroke-dasharray="1 1.5"/><path d="M5.5 8h2M5.5 12h2M16.5 12h2M16.5 16h2"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.5"/>' + SPARK(12.5, 13, 0.8),
  cloud: '<path d="M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/><circle cx="9.5" cy="13" r="1"/><circle cx="14.5" cy="13" r="1"/><path d="M10.5 13h3"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/><circle cx="12" cy="12" r="1.3"/>',
  console: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m6.5 10 3 2-3 2"/><path d="M12 14h3.5"/><circle cx="18" cy="8" r="1"/><circle cx="15" cy="8" r="1"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M2 12h6.5M15.5 12H22"/>' + SPARK(12, 4.5, 0.9),
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/><circle cx="12" cy="12" r="1.4"/>',
  file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/><path d="M8.5 13h2M12.5 13h3M8.5 16.5h5" stroke-dasharray="1.5 1"/>',
  check: '<path d="m4 12 5 5 9-10"/>' + SPARK(19.5, 16, 0.7),
};
const isAi = () => document.documentElement.dataset.theme === 'ai';

// one gradient for every AI theme icon (CSS: stroke: url(#ai-grad))
document.addEventListener('DOMContentLoaded', () => {
  const d = document.createElement('div');
  d.innerHTML = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="ai-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#a855f7"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs></svg>';
  document.body.prepend(d.firstChild);
});

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="i ${cls}" viewBox="0 0 24 24">${(isAi() && AI_P[name]) || P[name] || ''}</svg>`;
  return span.firstChild;
}

// ── toast ──
export function toast(msg, kind = 'info', ms) {
  const box = document.getElementById('toasts');
  // the same message again (e.g. a failing pull clicked several times): show it once
  for (const old of box.children) if (old.textContent === String(msg)) old.remove();
  const t = h('div.toast' + (kind === 'err' ? '.err' : kind === 'ok' ? '.ok' : ''), String(msg));
  box.append(t);
  const life = ms ?? (kind === 'err' ? 9000 : 3500);
  const kill = () => t.remove();
  let timer = setTimeout(kill, life);
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => (timer = setTimeout(kill, 2000)));
  t.addEventListener('click', kill);
}

// ── modal ──
export function modal({ title, body, buttons, wide, onOpen }) {
  return new Promise((resolve) => {
    const ov = h('div.overlay');
    const close = (v) => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const foot = h('div.modal-f');
    for (const b of buttons || [{ label: 'OK', value: true, primary: true }]) {
      foot.append(h('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), {
        on: { click: () => close(typeof b.value === 'function' ? b.value() : b.value) },
      }, b.label));
    }
    const m = h('div.modal' + (wide ? '.wide' : ''), h('div.modal-h', title), h('div.modal-b', body), foot,
      h('button.modal-x', { type: 'button', title: t('Bezárás'), on: { click: () => close(null) } }, icon('close')));
    ov.append(m);
    // a dialog closes only with its own buttons: no Escape, no click beside it
    function onKey(e) {
      // dialogs can be stacked (e.g. a question over Settings): only the top one listens
      if ([...document.querySelectorAll('.overlay')].pop() !== ov) return;
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); }
      if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        const prim = (buttons || []).find((b) => b.primary);
        if (prim) { e.preventDefault(); e.stopPropagation(); if (foot.querySelector('.primary')?.disabled) return; close(typeof prim.value === 'function' ? prim.value() : prim.value); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.append(ov);
    const first = m.querySelector('input:not([type=checkbox]),textarea,select');
    if (first) { first.focus(); if (first.select) first.select(); }
    if (onOpen) onOpen(m);
  });
}

export async function confirmDlg(title, text, okLabel = 'OK', danger = false) {
  return !!(await modal({
    title,
    body: h('div.desc', text),
    buttons: [{ label: t('Mégse'), value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  }));
}

/**
 * Form dialog. fields: [{name, label, type: text|textarea|checkbox|select|password, value, options, note, placeholder}]
 * Resolves to an object of values or null.
 */
export async function formDlg(title, fields, okLabel = 'OK', desc) {
  const els = {};
  const body = [];
  if (desc) body.push(h('div.desc', desc));
  for (const f of fields) {
    let el;
    if (f.type === 'checkbox') {
      el = h('input', { type: 'checkbox', checked: f.value });
      body.push(h('label.chk', el, f.label));
    } else {
      if (f.type === 'textarea') el = h('textarea.inp', { rows: f.rows || 4, placeholder: f.placeholder || '' });
      else if (f.type === 'select') {
        el = h('select.inp', f.options.map((o) => h('option', { value: o.value ?? o }, o.label ?? o)));
      } else if (f.type === 'combo') {
        const c = combo({ value: f.value ?? '', options: f.options || [], placeholder: f.placeholder || '' });
        els[f.name] = c.input;
        body.push(h('label.field', h('span', f.label), c, f.note ? h('span.note', f.note) : null));
        continue;
      } else el = h('input.inp', { type: f.type || 'text', placeholder: f.placeholder || '', spellcheck: 'false' });
      el.value = f.value ?? '';
      body.push(h('label.field', h('span', f.label), el, f.note ? h('span.note', f.note) : null));
    }
    els[f.name] = el;
  }
  const collect = () => {
    const o = {};
    for (const f of fields) o[f.name] = f.type === 'checkbox' ? els[f.name].checked : els[f.name].value;
    return o;
  };
  return modal({ title, body, buttons: [{ label: t('Mégse'), value: null }, { label: okLabel, value: collect, primary: true }] });
}

// ── combo box: a text input that also offers a list (branches, tags…) ──
// options: strings or { value, label?, group? }. Typing filters the list; the
// ▾ button or a click shows everything. Returns the wrapper; `.input` is the <input>.
export function combo({ value = '', options = [], placeholder = '', onInput, onEnter } = {}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o } : o));
  const input = h('input.inp', { value, placeholder, spellcheck: 'false', autocomplete: 'off' });
  const btn = h('button.combo-btn', { type: 'button', tabindex: '-1', title: '▾' }, '▾');
  const wrap = h('div.combo', input, btn);
  wrap.input = input;
  let list = null, items = [], active = -1;

  const close = () => {
    if (!list) return;
    list.remove(); list = null; active = -1;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    document.removeEventListener('scroll', onScroll, true);
  };
  const onScroll = (e) => { if (list && !list.contains(e.target)) close(); };
  const pick = (v) => {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    input.focus();
  };
  const mark = (i) => {
    items.forEach((el, k) => el.classList.toggle('on', k === i));
    active = i;
    if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
  };
  const open = (all) => {
    const q = all ? '' : input.value.trim().toLowerCase();
    const shown = opts.filter((o) => !q || o.value.toLowerCase().includes(q) || (o.label || '').toLowerCase().includes(q));
    if (!list) {
      list = h('div.combo-list');
      document.body.append(list);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', close);
      document.addEventListener('scroll', onScroll, true);
    }
    const kids = [];
    items = [];
    let group;
    for (const o of shown) {
      if (o.group && o.group !== group) { group = o.group; kids.push(h('div.combo-g', group)); }
      const el = h('div.combo-i', { dataset: { v: o.value }, on: { mousedown: (e) => { e.preventDefault(); pick(o.value); } } }, o.label || o.value);
      if (o.value === input.value) el.classList.add('cur');
      items.push(el); kids.push(el);
    }
    if (!kids.length) kids.push(h('div.combo-none', t('Nincs találat')));
    list.replaceChildren(...kids);
    const r = input.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 8;
    const up = below < 160 && r.top > below;
    Object.assign(list.style, { left: r.left + 'px', width: Math.max(r.width + btn.offsetWidth, 180) + 'px',
      maxHeight: Math.min(280, (up ? r.top : below) - 8) + 'px',
      top: up ? '' : r.bottom + 2 + 'px', bottom: up ? window.innerHeight - r.top + 2 + 'px' : '' });
    mark(all ? items.findIndex((el) => el.classList.contains('cur')) : -1);
  };
  // window capture runs before the dialog's own Enter/Escape handling
  function onKey(e) {
    if (document.activeElement !== input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!items.length) return;
      mark(e.key === 'ArrowDown' ? (active + 1) % items.length : (active <= 0 ? items.length : active) - 1);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault(); e.stopImmediatePropagation();
      pick(items[active].dataset.v);
    } else if (e.key === 'Enter') {
      close();
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      close();
    } else if (e.key === 'Tab') close();
  }
  input.addEventListener('input', (e) => { onInput?.(input.value); if (e.isTrusted) open(false); });
  input.addEventListener('keydown', (e) => {
    if (!list && e.key === 'ArrowDown' && e.altKey === false) { e.preventDefault(); open(true); }
    else if (!list && e.key === 'Enter') onEnter?.(e);
  });
  input.addEventListener('mousedown', () => { if (!list) setTimeout(() => open(true)); });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 0));
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); if (list) close(); else { input.focus(); open(true); } });
  return wrap;
}

// ── context menu ──
let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);

/** items: [{label, icon, action, disabled, danger, key} | '-' | {header}] */
export function contextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  closeMenu();
  const m = h('div.menu');
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('div.ms')); continue; }
    if (it.header) { m.append(h('div.mh', it.header)); continue; }
    m.append(h('div.mi' + (it.disabled ? '.dis' : '') + (it.danger ? '.danger' : ''), {
      on: { click: () => { if (it.disabled) return; closeMenu(); it.action(); } },
    }, it.icon ? icon(it.icon) : h('span', { style: { width: '16px' } }), it.label, it.key ? h('span.k', it.key) : null));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + r.width > innerWidth - 4) x = innerWidth - r.width - 4;
  if (y + r.height > innerHeight - 4) y = Math.max(4, innerHeight - r.height - 4);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  openMenu = m;
}

/**
 * Our own Cut/Copy/Paste menu instead of the browser's (Back, Reload,
 * Inspect…), for text fields and selected text. Returns false when there is
 * nothing to offer.
 */
export function editMenu(e) {
  const el = e.target.closest('input,textarea');
  const field = el && !el.readOnly && !el.disabled && (el.tagName === 'TEXTAREA' || /^(text|search|password|url|email|number|)$/.test(el.type || '')) ? el : null;
  const selText = field ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0) : String(getSelection() || '');
  if (!field && !selText) return false;
  const pw = field?.type === 'password';
  const paste = async () => {
    field.focus();
    try {
      // read in Rust: navigator.clipboard.readText() makes WebView2 ask for permission
      const txt = await invoke('clipboard_text');
      if (!txt) return;
      field.focus();
      if (!document.execCommand('insertText', false, txt)) field.setRangeText(txt, field.selectionStart, field.selectionEnd, 'end');
    } catch { /* nothing to paste */ }
  };
  contextMenu(e, [
    field ? { label: t('Kivágás'), disabled: !selText || pw, action: () => { field.focus(); document.execCommand('cut'); } } : null,
    { label: t('Másolás'), icon: 'copy', disabled: !selText || pw, action: () => navigator.clipboard.writeText(selText).catch(() => document.execCommand('copy')) },
    field ? { label: t('Beillesztés'), action: paste } : null,
    '-',
    { label: t('Összes kijelölése'), action: () => { if (field) { field.focus(); field.select(); } else getSelection().selectAllChildren(e.target.closest('.diff-scroll,.ai-body,.cmeta,.console-out') || e.target); } },
  ]);
  return true;
}

// ── time / people ──
export function relTime(ts) {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return t('épp most');
  if (d < 3600) return t('{0} perce', Math.floor(d / 60));
  if (d < 86400) return t('{0} órája', Math.floor(d / 3600));
  if (d < 86400 * 7) return t('{0} napja', Math.floor(d / 86400));
  return fmtDate(ts);
}
export function fmtDate(ts, withTime = false) {
  const dt = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const s = getLang() === 'en'
    ? `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
    : `${dt.getFullYear()}.${p(dt.getMonth() + 1)}.${p(dt.getDate())}.`;
  return withTime ? `${s} ${p(dt.getHours())}:${p(dt.getMinutes())}` : s;
}
export function hashColor(str) {
  let x = 0;
  for (const c of str) x = (x * 31 + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(x) % 360} 55% 48%)`;
}
export function avatar(name, email) {
  const ini = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  return h('span.avatar', { style: { background: hashColor(email || name) } }, ini);
}

export const short = (hash) => (hash || '').slice(0, 8);
export const basename = (p) => p.replace(/\\/g, '/').split('/').pop();
export const dirname = (p) => { const s = p.replace(/\\/g, '/'); const i = s.lastIndexOf('/'); return i < 0 ? '' : s.slice(0, i + 1); };

// ── UI state (panel sizes, last folders) ──
// Kept in settings.json by the backend: the WebView's localStorage is not
// always written to disk when the app quits, so sizes were sometimes lost.
let uiState = {};
let uiSave = () => {};
export function initUiState(obj, save) {
  uiState = obj;
  uiSave = save;
  // one-time move of the values the earlier versions kept in localStorage
  let moved = false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('fs.') && !(k in uiState)) { uiState[k] = localStorage.getItem(k); moved = true; }
    }
  } catch { /* no localStorage */ }
  if (moved) uiSave();
}
export const uiGet = (k) => uiState[k] ?? null;
export function uiSet(k, v) {
  if (uiState[k] === String(v)) return;
  uiState[k] = String(v);
  uiSave();
}

// ── splitters ──
export function splitter(el, target, { vertical = true, min = 100, max = 2000, invert = false, key } = {}) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = vertical ? e.clientX : e.clientY;
    const startSize = vertical ? target.offsetWidth : target.offsetHeight;
    el.classList.add('drag');
    const move = (ev) => {
      const d = (vertical ? ev.clientX : ev.clientY) - start;
      const size = Math.max(min, Math.min(max, startSize + (invert ? -d : d)));
      target.style[vertical ? 'width' : 'height'] = size + 'px';
      target.style.flex = 'none';
    };
    const up = () => {
      el.classList.remove('drag');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      if (key) uiSet(key, vertical ? target.style.width : target.style.height);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
  if (key && uiGet(key)) { target.style[vertical ? 'width' : 'height'] = uiGet(key); target.style.flex = 'none'; }
}

// ── markdown (small, safe subset) ──
export function markdown(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  let out = '';
  let inCode = false, code = '';
  let list = null;
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:])/g, '$1<i>$2</i>');
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) { out += `<pre><code>${esc(code)}</code></pre>`; code = ''; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { code += line + '\n'; continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeList(); const n = Math.min(3, m[1].length); out += `<h${n}>${inline(m[2])}</h${n}>`; }
    else if ((m = line.match(/^\s*[-*+]\s+(.*)/))) { if (list !== 'ul') { closeList(); out += '<ul>'; list = 'ul'; } out += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { closeList(); out += '<ol>'; list = 'ol'; } out += `<li>${inline(m[1])}</li>`; }
    else if (!line.trim()) { closeList(); }
    else { closeList(); out += `<p>${inline(line)}</p>`; }
  }
  if (inCode) out += `<pre><code>${esc(code)}</code></pre>`;
  closeList();
  return out;
}

/** Splits a command line into arguments (supports "quotes" and 'quotes'). */
export function shellSplit(s) {
  const out = [];
  let cur = '', q = null, has = false;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
