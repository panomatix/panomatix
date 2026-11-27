// Form widgets bound directly to a JSON object: each widget mutates obj[key] in place.
// Every control carries data-path (same notation as server validation errors) so errors can be pointed at.
import { get, session } from './api.js';
import { block, confirmDialog, debounce, h, toast } from './dom.js';
import { t } from './i18n.js';

/** Shown to visitors without an account: the site is read-only for them. */
export function readOnlyBanner() {
  if (session.user) return null;
  return h('p.banner.readonly', { role: 'note' },
    '👁 ', t('Read-only mode: you are browsing without an account.'), ' ', t('To correct or add signs,'), ' ',
    h('a', { href: '#/login' }, t('sign in')), ` ${t('or')} `, h('a', { href: '#/register' }, t('create an account')), '.');
}

const kb = (n) => `${Math.max(1, Math.round(n / 1024)).toLocaleString()} KB`;

/** Toast text after an upload, with the size saved by the server's compression. */
export const uploadedMessage = (r) => (r.bytes != null && r.bytes < r.original_bytes
  ? t('Image uploaded and compressed: {from} → {to}.', { from: kb(r.original_bytes), to: kb(r.bytes) })
  : t('Image uploaded.'));

export const sub = (path, key) => (typeof key === 'number' ? `${path}[${key}]` : `${path}.${key}`);

let changeHook = () => {};
export const onAnyChange = (fn) => { changeHook = fn; };
const changed = () => changeHook();

export function field(label, control, { help, wide = false } = {}) {
  return h(`label.field${wide ? '.wide' : ''}`, {}, h('span.label', {}, t(label)), control, help ? h('span.help', {}, t(help)) : null);
}

/** Text input. optional: empty -> key removed; nullable: empty -> null. */
export function text(obj, key, { path, optional = false, nullable = false, multiline = false, placeholder = '', list, mono = false, onchange } = {}) {
  const v = obj[key];
  const attrs = {
    value: v ?? '', placeholder: placeholder ? t(placeholder) : '', dataset: { path: sub(path, key) }, class: mono ? 'mono' : undefined, list,
    oninput: (e) => {
      const val = e.target.value;
      if (val === '' && optional) delete obj[key];
      else if (val === '' && nullable) obj[key] = null;
      else obj[key] = val;
      changed();
      onchange?.(obj[key]);
    },
  };
  return multiline ? h('textarea', { ...attrs, rows: 3 }) : h('input', { type: 'text', ...attrs });
}

/** Select from a closed vocabulary. null shows as "null"; optional adds "(absent)" (key removed). */
export function select(obj, key, options, { path, optional = false, onchange } = {}) {
  const enc = (v) => (v === null ? '\u0000null' : String(v));
  const absent = '\u0000absent';
  const current = key in obj ? enc(obj[key]) : absent;
  const opts = [];
  if (optional) opts.push(h('option', { value: absent, selected: current === absent }, t('(absent)')));
  const all = [...options];
  if (key in obj && !all.some((o) => enc(o) === current)) all.push(obj[key]); // keep unknown current value visible
  for (const o of all) opts.push(h('option', { value: enc(o), selected: enc(o) === current }, o === null ? '—' : String(o)));
  return h('select', {
    dataset: { path: sub(path, key) },
    onchange: (e) => {
      const val = e.target.value;
      if (val === absent) delete obj[key];
      else obj[key] = all.find((o) => enc(o) === val);
      changed();
      onchange?.(obj[key]);
    },
  }, opts);
}

/** Boolean. optional -> tri-state select (absent / yes / no). */
export function bool(obj, key, { path, optional = false } = {}) {
  if (optional) {
    const val = key in obj ? String(obj[key]) : '';
    return h('select', {
      dataset: { path: sub(path, key) },
      onchange: (e) => {
        if (e.target.value === '') delete obj[key];
        else obj[key] = e.target.value === 'true';
        changed();
      },
    },
    h('option', { value: '', selected: val === '' }, t('(absent)')),
    h('option', { value: 'true', selected: val === 'true' }, t('yes')),
    h('option', { value: 'false', selected: val === 'false' }, t('no')));
  }
  return h('input', {
    type: 'checkbox', checked: obj[key] === true, dataset: { path: sub(path, key) },
    onchange: (e) => { obj[key] = e.target.checked; changed(); },
  });
}

// --- autocomplete of national codes / references (shared datalist) ----------------------
const DATALIST_ID = 'pmx-codes';
function ensureDatalist() {
  let dl = document.getElementById(DATALIST_ID);
  if (!dl) {
    dl = h('datalist', { id: DATALIST_ID });
    document.body.append(dl);
  }
  return dl;
}
const fillCodes = debounce(async (q) => {
  if (q.length < 2) return;
  try {
    const r = await get(`/api/v1/codes?q=${encodeURIComponent(q)}`);
    ensureDatalist().replaceChildren(...r.items.map((i) => h('option', { value: i.value }, `${i.name} (${i.reference})`)));
  } catch { /* autocomplete is best effort */ }
}, 200);

/** Editable list of strings (or numbers when numeric). */
export function strList(arr, { path, placeholder = 'Add', numeric = false, autocomplete = false, onchange, mono = true } = {}) {
  return block((redraw) => {
    const input = h('input', {
      type: 'text', placeholder: t(placeholder), list: autocomplete ? DATALIST_ID : undefined,
      oninput: autocomplete ? (e) => fillCodes(e.target.value.trim()) : undefined,
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          add();
        }
      },
    });
    if (autocomplete) ensureDatalist();
    function add() {
      const raw = input.value.trim();
      if (!raw) return;
      let v = raw;
      if (numeric) {
        v = Number(raw.replace(',', '.'));
        if (!Number.isFinite(v)) return toast(t('Values'), 'error');
      }
      if (!arr.some((x) => x === v)) arr.push(v);
      changed();
      onchange?.();
      redraw();
      setTimeout(() => document.querySelector(`[data-path="${CSS.escape(path)}"] input`)?.focus(), 0);
    }
    return [
      h('ul.tags', {}, arr.map((v, i) => h('li.tag', { dataset: { path: sub(path, i) } },
        h(mono ? 'code' : 'span', {}, String(v)),
        h('button.x', { type: 'button', title: t('Remove'), 'aria-label': `${t('Remove')} ${v}`, onclick: () => { arr.splice(i, 1); changed(); onchange?.(); redraw(); } }, '×')))),
      h('div.addrow', {}, input, h('button.btn.small', { type: 'button', onclick: add }, t('Add'))),
    ];
  }, 'div', { class: 'strlist', dataset: { path } });
}

/** Ordered list of objects with add / duplicate / move / remove. */
export function listEditor(arr, { path, renderItem, newItem, addLabel, title, collapsed = false }) {
  const opened = new WeakSet(); // items added in this session start expanded
  return block((redraw) => [
    arr.map((item, i) => h('details.item', { open: !collapsed || opened.has(item), dataset: { path: sub(path, i) } },
      h('summary', {},
        h('span.item-title', {}, title(item, i)),
        h('span.tools', {},
          h('button.btn.small', { type: 'button', title: t('Move up'), disabled: i === 0, onclick: (e) => { e.preventDefault(); [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; changed(); redraw(); } }, '↑'),
          h('button.btn.small', { type: 'button', title: t('Move down'), disabled: i === arr.length - 1, onclick: (e) => { e.preventDefault(); [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; changed(); redraw(); } }, '↓'),
          h('button.btn.small', { type: 'button', title: t('Duplicate'), onclick: (e) => { e.preventDefault(); arr.splice(i + 1, 0, structuredClone(item)); changed(); redraw(); } }, '⧉'),
          h('button.btn.small.danger', { type: 'button', title: t('Remove'), onclick: async (e) => { e.preventDefault(); if (await confirmDialog(`${t('Remove')} — ${title(item, i)} ?`)) { arr.splice(i, 1); changed(); redraw(); } } }, '×'))),
      h('div.item-body', {}, renderItem(item, i, sub(path, i), redraw)))),
    h('button.btn.add', { type: 'button', onclick: () => { const it = newItem(); opened.add(it); arr.push(it); changed(); redraw(); } }, `+ ${t(addLabel)}`),
  ], 'div', { class: 'listed', dataset: { path } });
}

/** Object used as a dictionary (languages, jurisdictions, parameters, tags…). */
export function mapEditor(obj, { path, renderValue, newValue, addLabel, keyPattern, keyPlaceholder = 'key', suggestions = [], collapsed = false, inline = false, onAdd }) {
  const dlId = suggestions.length ? `dl-${Math.random().toString(36).slice(2)}` : null;
  const opened = new Set(); // keys added in this session start expanded
  return block((redraw) => {
    const keyInput = h('input', { type: 'text', placeholder: t(keyPlaceholder), list: dlId ?? undefined, class: 'mono' });
    const add = () => {
      const k = keyInput.value.trim();
      if (!k) return;
      if (keyPattern && !new RegExp(keyPattern).test(k)) return toast(`${t('key')}: ${keyPattern}`, 'error');
      if (k in obj) return toast(t('This key already exists.'), 'error');
      obj[k] = newValue(k);
      opened.add(k);
      onAdd?.(k, obj[k]);
      changed();
      redraw();
    };
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    const rows = Object.keys(obj).map((k) => {
      const p = sub(path, k);
      const tools = h('span.tools', {},
        h('button.btn.small', {
          type: 'button', title: t('Name of the new key'),
          onclick: async (e) => {
            e.preventDefault();
            const nk = (await confirmDialog(t('Name of the new key'), { input: true, placeholder: k }))?.trim();
            if (!nk || nk === k) return;
            if (keyPattern && !new RegExp(keyPattern).test(nk)) return toast(`${t('key')}: ${keyPattern}`, 'error');
            if (nk in obj) return toast(t('This key already exists.'), 'error');
            const entries = Object.entries(obj).map(([kk, vv]) => [kk === k ? nk : kk, vv]);
            for (const kk of Object.keys(obj)) delete obj[kk];
            Object.assign(obj, Object.fromEntries(entries));
            changed();
            redraw();
          },
        }, '✎'),
        h('button.btn.small.danger', { type: 'button', title: t('Remove'), onclick: (e) => { e.preventDefault(); delete obj[k]; changed(); redraw(); } }, '×'));
      if (inline) return h('div.maprow', { dataset: { path: p } }, h('code.mapkey', {}, k), renderValue(obj, k, p, redraw), tools);
      return h('details.item', { open: !collapsed || opened.has(k), dataset: { path: p } },
        h('summary', {}, h('code.mapkey', {}, k), tools),
        h('div.item-body', {}, renderValue(obj, k, p, redraw)));
    });
    return [
      rows,
      dlId ? h('datalist', { id: dlId }, suggestions.map((s) => h('option', { value: s.value ?? s }, s.label ?? ''))) : null,
      h('div.addrow', {}, keyInput, h('button.btn.small', { type: 'button', onclick: add }, `+ ${t(addLabel)}`)),
    ];
  }, 'div', { class: 'mapped', dataset: { path } });
}
