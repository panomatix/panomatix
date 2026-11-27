// One national sign ("unit"): what ONE country shows under ONE design or related sign of a sign.
// Three actions, each in a dialog: Info (read), Move (to another design / related sign / sign), Edit (incl. panels).
import { ApiError, api, get, post, put, del, signPath, vocab } from '../api.js';
import { add as addTo, block, confirmDialog, debounce, fill, flag, h, signHref, toast } from '../dom.js';
import { t } from '../i18n.js';
import { bool, field, listEditor, mapEditor, strList, sub, text, uploadedMessage } from '../widgets.js';
import { languageEditor, parameterEditor, showErrors } from './editor.js';
import { displayName } from './list.js';
import { icon } from '../icons.js';

export const pretty = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const LANG_KEY = '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$';
const POS = [['top', 'Above the sign'], ['bottom', 'Below the sign'], ['left', 'Left of the sign'], ['right', 'Right of the sign']];
const unitPath = (ref, loc, jur) => `${signPath(ref)}/units/${encodeURIComponent(loc)}/${encodeURIComponent(jur)}`;

export const codesOf = (jur) => [...new Set(Object.values(jur.languages ?? {}).flatMap((l) => l.codes ?? []))];
export const mainCode = (jur) => Object.values(jur.languages ?? {}).find((l) => l.code)?.code ?? '';
export const panelCount = (add) => Object.values(add ?? {}).reduce((n, slots) => n + slots.reduce((m, s) => m + s.reference.length, 0), 0);
export const locLabel = (l) => (l.kind === 'design' ? t('Design {n}', { n: Number(l.loc.slice(1)) + 1 }) : `${t('Related sign')} · ${l.label}`);

/** Generic modal; returns {dlg, close}. */
function modal(cls, title, ...content) {
  const dlg = h(`dialog.${cls}`, { 'aria-label': title });
  const close = () => { dlg.close(); dlg.remove(); };
  addTo(dlg, h('header.modal-head', {}, h('h2', {}, title), h('button.btn.close', { type: 'button', 'aria-label': t('Close'), onclick: close }, icon('close'))), ...content);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

// --- panels: chips, read-only stack ---------------------------------------------------------

const imgCache = new Map();
/** A panel reference with its picture (fetched lazily). */
export function panelChip(ref, { check, onRemove } = {}) {
  const isRef = /^(VIENNA|VIENNA2006|OTHER):/.test(ref);
  const chip = h(`span.pchip${check ? `.lvl-${check.level}` : ''}`, { title: check?.message ?? '' },
    isRef ? h('a', { href: signHref(ref) }, ref) : h('code', {}, ref),
    check && check.level !== 'ok' ? h('span.lvl', {}, icon(check.level === 'error' ? 'error' : 'warning')) : check ? h('span.lvl', {}, icon('check')) : null,
    onRemove ? h('button.x', { type: 'button', 'aria-label': `${t('Remove')} ${ref}`, onclick: onRemove }, icon('close')) : null);
  const show = (url) => url && chip.prepend(h('img.mini', { src: url, alt: '', loading: 'lazy' }));
  if (check?.panel?.image) show(check.panel.image);
  else if (imgCache.has(ref)) show(imgCache.get(ref));
  else if (!isRef && /^[a-z]{2}(-[a-z0-9]{1,3})?:/.test(ref)) {
    get(`/api/v1/images?code=${encodeURIComponent(ref)}`).then((r) => { imgCache.set(ref, r.images[0] ?? null); show(r.images[0]); }).catch(() => {});
  }
  return chip;
}

/** Pictures of the panels above and below a national sign ({top, bottom}, top to bottom), from its
 *  `additional` data and the {reference: url} map the server sends with the sign. */
export function panelPicsOf(additional, panelImages = {}) {
  const column = (pos) => [...(additional?.[pos] ?? [])].sort((a, b) => a.index - b.index)
    .map((slot) => slot.reference.map((ref) => panelImages[ref]).find(Boolean)).filter(Boolean);
  const top = column('top').reverse();
  const bottom = column('bottom');
  return top.length || bottom.length ? { top, bottom } : null;
}

/** A sign picture with its panels stacked above and below, as on the road. Without panels: the picture alone. */
export function signWithPanels(signImg, pics) {
  if (!signImg || !pics) return signImg;
  const panel = (url) => h('img.panel', { src: url, alt: '', loading: 'lazy' });
  signImg.classList.add('sign');
  return h('span.with-panels', { title: t('With its additional panels') }, pics.top.map(panel), signImg, pics.bottom.map(panel));
}

/** The sign with its panels drawn around it, slot by slot (index 1 = next to the sign). */
export function panelStack(additional, signImg, checks = []) {
  const find = (pos, si, ref) => checks.find((c) => c.position === pos && c.slot === si && c.reference === ref);
  const col = (pos) => {
    const slots = [...(additional?.[pos] ?? [])].map((s, si) => ({ ...s, si })).sort((a, b) => a.index - b.index);
    const rows = slots.map((s) => h('div.pstack-slot', { title: t('Slot {n}', { n: s.index }) },
      s.reference.length ? s.reference.map((r) => panelChip(r, { check: find(pos, s.si, r) })) : h('span.muted.small', {}, t('empty slot'))));
    return pos === 'top' ? rows.reverse() : rows;
  };
  const any = panelCount(additional) > 0;
  if (!any) return h('p.muted.small', {}, t('No additional panel.'));
  return h('div.pstack', {},
    h('div.pstack-col.top', {}, col('top')),
    h('div.pstack-mid', {}, h('div.pstack-col.left', {}, col('left')), signImg ? h('img.pstack-sign', { src: signImg, alt: '' }) : h('span.pstack-sign.blank'), h('div.pstack-col.right', {}, col('right'))),
    h('div.pstack-col.bottom', {}, col('bottom')));
}

// --- Info -----------------------------------------------------------------------------------

/** Everything stored about one national sign, read-only. */
export function unitDetails(jur, images) {
  const codes = codesOf(jur);
  const urls = [...new Set(codes.flatMap((c) => images[c] ?? []))];
  return h('div.unit-details', {},
    h('div.unit-pics', {}, urls.length ? urls.slice(0, 8).map((u) => h('img', { src: u, alt: '', loading: 'lazy' })) : h('span.muted.small', {}, t('no image'))),
    h('dl.kv-list', {},
      h('dt', {}, t('Country code')), h('dd', {}, flag(jur.countryCode), ' ', h('code', {}, jur.countryCode)),
      h('dt', {}, t('All codes')), h('dd', {}, codes.map((c) => h('code.chip', {}, c))),
      jur.leftHandTrafficVariant ? [h('dt', {}, t('Left-hand traffic')), h('dd', {}, t('yes'))] : null,
      h('dt', {}, t('OpenStreetMap')), h('dd', {}, jur.osm?.traffic_sign?.length ? jur.osm.traffic_sign.map((v) => h('code.chip', {}, `traffic_sign=${v}`)) : '—')),
    h('table.compact', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('Lang')), h('th', {}, t('Code')), h('th', {}, t('Text')), h('th', {}, t('Description')))),
      h('tbody', {}, Object.entries(jur.languages ?? {}).map(([lk, l]) => h('tr', {},
        h('td', {}, lk), h('td', {}, h('code', {}, l.code)), h('td', {}, l.text ?? '—'), h('td', {}, l.description ?? '—'))))),
    jur.parameters && Object.keys(jur.parameters).length ? [h('h5', {}, t('Parameters')), h('ul.plain', {}, Object.entries(jur.parameters).map(([pk, p]) =>
      h('li', {}, h('strong', {}, pk), ` (${p.type}${p.unit ? `, ${p.unit}` : ''}): `, p.values.join(', '), p.description ? h('span.muted', {}, ` — ${p.description}`) : null)))] : null,
    h('h5', {}, t('Additional panels')), panelStack(jur.additional, urls[0]),
    jur.sources?.length ? h('details.sources', {}, h('summary', {}, t('Sources ({n})', { n: jur.sources.length })),
      h('ul.plain.small', {}, jur.sources.map((s) => h('li', {}, s.file, s.url ? [' — ', h('a', { href: s.url, rel: 'noopener noreferrer', target: '_blank' }, t('link'))] : null)))) : null);
}

export function openUnitInfo({ reference, jurKey, jur, images, where, actions }) {
  modal('dialog.wide', `${mainCode(jur) || pretty(jurKey)}`,
    h('p.muted', {}, pretty(jurKey), ' · ', h('a', { href: signHref(reference) }, reference), ' · ', where),
    unitDetails(jur, images),
    actions ? h('div.row.end.modal-foot', {}, actions) : null);
}

// --- Move -----------------------------------------------------------------------------------

function locationCard(l, { current, taken, onPick }) {
  return h('button', {
    type: 'button', class: `loc-card${current ? ' current' : ''}`, disabled: current || taken, onclick: onPick,
    title: current ? t('It is here now') : taken ? t('This country already has a national sign there') : '',
  },
  l.image ? h('img', { src: l.image, alt: '' }) : null,
  h('span.loc-label', {}, locLabel(l)),
  h('span.loc-props', {}, Object.values(l.props).join(' · ')),
  h('span.loc-count', {}, current ? t('current place') : taken ? t('already used by this country') : t('{n} countries', { n: l.countries.length })));
}

export async function openMoveDialog(reference, loc, jurKey, { onMoved } = {}) {
  const view = await get(unitPath(reference, loc, jurKey));
  const code = mainCode(view.data) || pretty(jurKey);
  const comment = h('input', { type: 'text', maxlength: 500, placeholder: t('Summary of your change (optional)') });
  const move = async (targetRef, targetLoc, label) => {
    if (!(await confirmDialog(t('Move {code} to {where}?', { code, where: label })))) return;
    try {
      const r = await post(`${unitPath(reference, loc, jurKey)}/move`, { version: view.version, to: { reference: targetRef, loc: targetLoc }, comment: comment.value });
      toast(t('Moved.'));
      close();
      onMoved?.(r);
    } catch (err) { toast(err.message, 'error'); }
  };
  const grid = (ref, locs, isHere) => h('div.loc-grid', {}, locs.map((l) => locationCard(l, {
    current: isHere && l.loc === loc, taken: !(isHere && l.loc === loc) && l.countries.includes(jurKey),
    onPick: () => move(ref, l.loc, isHere ? locLabel(l) : `${ref} — ${locLabel(l)}`),
  })));
  const other = h('div.other-sign');
  const search = h('input', { type: 'search', list: 'pmx-move-signs', placeholder: t('Reference or name, e.g. VIENNA:C-14.1'), autocomplete: 'off' });
  const dl = h('datalist', { id: 'pmx-move-signs' });
  search.addEventListener('input', debounce(async () => {
    const q = search.value.trim();
    if (q.length < 2) return;
    try {
      const r = await get(`/api/v1/signs?q=${encodeURIComponent(q)}&per_page=15`);
      dl.replaceChildren(...r.items.map((it) => h('option', { value: it.reference }, displayName(it.name))));
    } catch { /* best effort */ }
  }, 250));
  const showOther = async () => {
    const ref = search.value.trim();
    if (!ref || ref === reference) return;
    try {
      const v = await get(unitPath(ref, 'd0', jurKey));
      other.replaceChildren(h('p.small', {}, h('a', { href: signHref(ref) }, ref), ' — ', displayName(v.name)), grid(ref, v.locations, false));
    } catch (err) { other.replaceChildren(h('p.small.error', {}, err.message)); }
  };
  search.addEventListener('change', showOther);
  const { close } = modal('dialog.wide', t('Move {code}', { code }),
    h('p.muted', {}, t('Choose where {country}’s national sign belongs. Its codes, texts and panels move with it.', { country: pretty(jurKey) })),
    h('h4', {}, t('In this sign')), grid(reference, view.locations, true),
    h('h4', {}, t('In another sign')), h('div.row', {}, search, dl, h('button.btn', { type: 'button', onclick: showOther }, t('Show'))), other,
    h('div.modal-foot', {}, comment));
}

// --- Edit -----------------------------------------------------------------------------------

/** Same code(s) in every language? Then the form edits them once for all. */
function sharedCodes(langs) {
  const ls = Object.values(langs);
  if (!ls.length) return true;
  return ls.every((l) => l.code === ls[0].code && JSON.stringify(l.codes) === JSON.stringify(ls[0].codes));
}
const osmFor = (code) => {
  const i = code.indexOf(':');
  return i < 0 ? code : `${code.slice(0, i).toUpperCase()}:${code.slice(i + 1)}`;
};

/** Pick a panel: this country's panels and the Convention's, searchable, with pictures. */
function openPanelPicker({ countryCode, admissible, onPick }) {
  const results = h('div.panel-results');
  const q = h('input', { type: 'search', placeholder: t('Search a panel (code or name)'), autocomplete: 'off' });
  const free = h('input', { type: 'text', class: 'mono', placeholder: `${countryCode || 'fr'}:…` });
  const tile = (p) => h('button.ptile', {
    type: 'button', onclick: () => { onPick(p.value); close(); },
    title: `${p.value} — ${p.name}`,
  },
  p.image ? h('img', { src: p.image, alt: '' }) : h('span.noimg', {}, '?'),
  h('code', {}, p.value),
  h('span.small', {}, p.name),
  admissible.has(p.value) || admissible.has(p.reference) ? h('span.badge.ok', {}, t('Convention')) : null);
  const load = async () => {
    results.replaceChildren(h('p.muted.small', {}, t('Loading…')));
    try {
      const r = await get(`/api/v1/panels?country=${encodeURIComponent(countryCode ?? '')}&q=${encodeURIComponent(q.value.trim())}`);
      const nat = r.items.filter((p) => p.national);
      const vie = r.items.filter((p) => !p.national);
      results.replaceChildren(
        h('h5', {}, t('Panels of this country ({n})', { n: nat.length })),
        nat.length ? h('div.ptiles', {}, nat.map(tile)) : h('p.muted.small', {}, t('No national panel found.')),
        h('h5', {}, t('Vienna Convention panels (H)')),
        vie.length ? h('div.ptiles', {}, vie.map(tile)) : h('p.muted.small', {}, t('None.')));
    } catch (err) { results.replaceChildren(h('p.error', {}, err.message)); }
  };
  q.addEventListener('input', debounce(load, 250));
  const { close } = modal('dialog.wide', t('Add a panel'),
    q, results,
    h('div.row.modal-foot', {}, h('span.small.muted', {}, t('Or type any code:')), free,
      h('button.btn', { type: 'button', onclick: () => { const v = free.value.trim(); if (v) { onPick(v); close(); } } }, t('Add'))));
  load();
  q.focus();
}

/** Panels editor: stacked preview, slots per position, live check against the database and the Convention.
 *  `state.panelErrors` holds the number of panels the server would refuse. */
function panelsEditor(state, view, path, signImg) {
  const add = state.data.additional;
  const admissible = (pos) => new Set((view.convention_panels[pos] ?? []).flatMap((s) => s.reference));
  let checks = view.panel_checks ?? [];
  let checking = false;
  const box = h('div.panels-box');
  const find = (pos, si, ref) => checks.find((c) => c.position === pos && c.slot === si && c.reference === ref);
  const nextIndex = (slots) => Math.max(0, ...slots.map((x) => x.index || 0)) + 1;
  const pick = (pos, then) => openPanelPicker({ countryCode: state.data.countryCode, admissible: admissible(pos), onPick: (v) => { then(v); changed(); } });

  function status() {
    if (checking) return h('span.muted.small', {}, t('Checking the panels…'));
    const errs = checks.filter((c) => c.level === 'error').length;
    const warns = checks.filter((c) => c.level === 'warning').length;
    if (!checks.length) return h('span.muted.small', {}, t('No panel yet: add one with the buttons above.'));
    if (errs) return h('span.pc-err', {}, t('{n} panel(s) cannot be added — fix them before saving.', { n: errs }));
    if (warns) return h('span.pc-warn', {}, t('The panels can be added; {n} warning(s) to review.', { n: warns }));
    return h('span.pc-ok', {}, icon('check'), ' ', t('All panels can be added.'));
  }

  function slotRow(pos, slots, s, si) {
    return h('div.pslot', { dataset: { path: sub(sub(path, pos), si) } },
      h('span.pslot-n', { title: t('Slot {n} (1 = closest to the sign)', { n: s.index }) }, s.index),
      h('div.pslot-refs', {},
        s.reference.map((r, ri) => panelChip(r, { check: find(pos, si, r), onRemove: () => { s.reference.splice(ri, 1); changed(); } })),
        h('button.btn.small', { type: 'button', title: t('Another panel admissible in the same place'), onclick: () => pick(pos, (v) => { if (!s.reference.includes(v)) s.reference.push(v); }) }, `+ ${t('alternative')}`)),
      h('button.btn.small.danger', { type: 'button', 'aria-label': t('Remove the slot'), onclick: () => { slots.splice(si, 1); changed(); } }, icon('close')));
  }

  function draw() {
    const messages = checks.filter((c) => c.level !== 'ok');
    fill(box,
      h('div.panels-edit', {},
        h('div.panels-preview', {}, panelStack(add, signImg, checks)),
        h('div.panels-slots', {},
          POS.filter(([pos]) => pos in add).map(([pos, label]) => {
            const slots = add[pos];
            const conv = [...admissible(pos)];
            return h('div.ppos', { dataset: { path: sub(path, pos) } },
              h('h5', {}, t(label),
                (pos === 'left' || pos === 'right') && !slots.length ? h('button.btn.small', { type: 'button', 'aria-label': t('Remove'), onclick: () => { delete add[pos]; draw(); } }, '×') : null),
              [...slots.entries()].sort((a, b) => a[1].index - b[1].index).map(([si, s]) => slotRow(pos, slots, s, si)),
              h('div.row', {},
                h('button.btn.small.primary', { type: 'button', onclick: () => pick(pos, (v) => slots.push({ index: nextIndex(slots), reference: [v] })) }, `+ ${t('Add a panel')}`),
                conv.length ? h('span.small.muted', {}, `${t('Convention:')} `, conv.map((r) => h('button.linkish', {
                  type: 'button', title: t('Add {ref}', { ref: r }),
                  onclick: () => { slots.push({ index: nextIndex(slots), reference: [r] }); changed(); },
                }, r))) : null));
          }),
          h('div.row', {}, POS.filter(([pos]) => !(pos in add)).map(([pos, label]) => h('button.btn.small', { type: 'button', onclick: () => { add[pos] = []; draw(); } }, `+ ${t(label)}`))))),
      h('div.pcheck-status', { role: 'status' }, status()),
      messages.length ? h('ul.pcheck-list', {}, messages.map((c) => h(`li.lvl-${c.level}`, {}, h('code', {}, c.reference), ' — ', c.message))) : null);
  }

  let seq = 0;
  async function recheck() {
    const mine = ++seq;
    checking = true;
    draw();
    try {
      const r = await post('/api/v1/panels/check', { reference: view.reference, country_code: state.data.countryCode, additional: add });
      if (mine !== seq) return;
      checks = r.checks;
    } catch (err) { toast(err.message, 'error'); }
    checking = false;
    state.panelErrors = checks.filter((c) => c.level === 'error').length;
    draw();
  }
  const changed = () => recheck();
  state.recheckPanels = recheck;
  state.panelErrors = checks.filter((c) => c.level === 'error').length;
  draw();
  return box;
}

/** Remove ONE national sign after confirmation; resolves to true when it was removed. */
export async function removeUnit(reference, loc, jurKey) {
  const view = await get(unitPath(reference, loc, jurKey));
  if (!view.exists) { toast(t('Removed.')); return true; }
  const code = mainCode(view.data) || pretty(jurKey);
  const comment = await confirmDialog(t('Remove {code} ({country}) from this sign?', { code, country: pretty(jurKey) }), { input: true, placeholder: t('Reason (optional)') });
  if (comment === null) return false;
  await del(unitPath(reference, loc, jurKey), { version: view.version, comment });
  toast(t('Removed.'));
  return true;
}

/**
 * Every national sign one country has under one sign (all designs and related signs, every code),
 * with the actions of each. Used by the comparison table when a cell holds several signs.
 */
export async function openCountrySigns(reference, jurKey, { editable = false, onChanged } = {}) {
  const s = await get(signPath(reference));
  const d = s.data;
  const units = [
    ...(d.officialSign?.designs ?? []).map((x, i) => ({ loc: `d${i}`, holder: x, label: t('Design {n}', { n: i + 1 }) })),
    ...(d.relatedSigns ?? []).map((x, i) => ({ loc: `r${i}`, holder: x, label: `${t('Related sign')} · ${displayName(x.name) || x.reference}` })),
  ].filter((u) => u.holder.jurisdictions?.[jurKey]);
  const props = (x) => ['shape', 'background_color', 'border_color', 'symbol_color', 'band', 'prohibition_bar']
    .map((k) => x[k]).filter((v) => v && v !== 'none').join(' · ').replace(/_/g, ' ');
  let close;
  const after = (fn) => (e) => { e.preventDefault(); close(); fn().catch((err) => toast(err.message, 'error')); };
  const section = (u) => {
    const jur = u.holder.jurisdictions[jurKey];
    const texts = Object.fromEntries(Object.values(jur.languages ?? {}).flatMap((l) => (l.text ? [[l.code, l.text]] : [])));
    return h('section.cs-unit', {},
      h('div.cs-head', {},
        h('div', {}, h('h3', {}, u.label), h('p.small.muted', {}, props(u.holder))),
        h('div.cs-actions', {},
          h('button.btn.small', { type: 'button', onclick: () => openUnitInfo({ reference, jurKey, jur, images: s.images, where: u.label }) }, icon('info'), t('Info')),
          editable ? [
            h('button.btn.small', { type: 'button', onclick: after(() => openMoveDialog(reference, u.loc, jurKey, { onMoved: onChanged })) }, icon('move'), t('Move')),
            h('button.btn.small.primary', { type: 'button', onclick: after(() => openUnitEditor(reference, u.loc, jurKey, { onSaved: onChanged })) }, icon('edit'), t('Edit')),
            h('button.btn.small.danger', { type: 'button', onclick: after(async () => { if (await removeUnit(reference, u.loc, jurKey)) onChanged?.(); }) }, icon('trash'), t('Remove')),
          ] : null)),
      h('div.cs-codes', {}, codesOf(jur).map((code) => h('figure.cs-code', {},
        s.images[code]?.[0] ? h('img', { src: s.images[code][0], alt: code, loading: 'lazy' }) : h('span.cs-noimg'),
        h('figcaption', {}, h('code', {}, code), texts[code] ? h('span.small.muted', {}, texts[code]) : null)))));
  };
  const total = units.reduce((n, u) => n + codesOf(u.holder.jurisdictions[jurKey]).length, 0);
  ({ close } = modal('dialog.wide', `${pretty(jurKey)} — ${reference}`,
    h('p.muted', {}, displayName(d.name), ' · ', t('{n} national signs', { n: total }), ' · ',
      h('a', { href: signHref(reference), onclick: () => close() }, t('Open the sign page'))),
    units.length ? units.map(section) : h('p.muted', {}, t('No country uses this yet.'))));
}

// Countries added by hand that have no sign in the database yet: remembered in this browser
// ({key: country code}) until their first national sign is saved.
const CUSTOM_KEY = 'pmx_custom_countries';
export const COUNTRY_KEY_RE = /^[a-z0-9_]{2,60}$/;
export const COUNTRY_CODE_RE = /^[a-z]{2}(-[a-z0-9]{1,3})?$/;
export const countryKey = (name) => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export function customCountries() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '{}') ?? {}; } catch { return {}; }
}
export function addCustomCountry(key, code) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify({ ...customCountries(), [key]: code }));
}
/** Known countries ({jurisdiction, country_code}) plus the custom ones not in the database yet. */
export function withCustomCountries(allCountries) {
  const known = new Set(allCountries.map((c) => c.jurisdiction));
  const extra = Object.entries(customCountries()).filter(([k]) => !known.has(k)).map(([k, cc]) => ({ jurisdiction: k, country_code: cc, signs: 0, custom: true }));
  return [...allCountries, ...extra];
}

/** Ask which country (known or new) for a new national sign; resolves to {key, countryCode} or null. */
export function pickCountry(existing, allCountries) {
  return new Promise((resolve) => {
    const all = withCustomCountries(allCountries);
    const byKey = new Map(all.map((c) => [c.jurisdiction, c]));
    const options = [...byKey.values()].filter((c) => !existing.has(c.jurisdiction))
      .sort((a, b) => pretty(a.jurisdiction).localeCompare(pretty(b.jurisdiction)));
    const input = h('input', { type: 'text', list: 'pmx-jurs', placeholder: t('Find a country…'), autocomplete: 'off', required: true });
    const cc = h('input', { type: 'text', class: 'mono', placeholder: 'mc', maxlength: 6, autocomplete: 'off', 'aria-label': t('ISO country code') });
    const hint = h('p.small.muted', {}, t('Pick a country, or type the name of a country that is not in the database yet and give its ISO code (e.g. Monaco → mc).'));
    const sync = () => {
      const k = countryKey(input.value);
      const known = byKey.get(input.value.trim()) ?? byKey.get(k);
      if (known) { cc.value = known.country_code; cc.readOnly = true; hint.textContent = `${pretty(known.jurisdiction)} · ${known.country_code}`; }
      else { cc.readOnly = false; hint.textContent = k ? t('New country: {name} — give its ISO code.', { name: pretty(k) }) : t('Pick a country, or type the name of a country that is not in the database yet and give its ISO code (e.g. Monaco → mc).'); }
    };
    input.addEventListener('input', sync);
    const dl = h('datalist', { id: 'pmx-jurs' }, options.map((c) => h('option', { value: c.jurisdiction }, `${pretty(c.jurisdiction)} (${c.country_code})`)));
    const dlg = h('dialog.dialog', {},
      h('form', { method: 'dialog' },
        h('p', {}, t('Which country?')),
        h('div.row', {}, input, cc), dl, hint,
        h('div.row.end', {}, h('button.btn', { value: 'cancel', formnovalidate: true }, t('Cancel')), h('button.btn.primary', { value: 'ok' }, t('Continue')))));
    dlg.addEventListener('close', () => {
      dlg.remove();
      if (dlg.returnValue !== 'ok') return resolve(null);
      const known = byKey.get(input.value.trim()) ?? byKey.get(countryKey(input.value));
      const key = known ? known.jurisdiction : countryKey(input.value);
      const code = (known ? known.country_code : cc.value.trim().toLowerCase());
      if (!COUNTRY_KEY_RE.test(key)) { toast(t('Invalid country key.'), 'error'); return resolve(null); }
      if (!COUNTRY_CODE_RE.test(code)) { toast(t('Give the ISO code of the country (2 letters, e.g. mc).'), 'error'); return resolve(null); }
      if (!known) addCustomCountry(key, code);
      resolve({ key, countryCode: code });
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/**
 * Edit ONE national sign (create it when the country is not there yet).
 * `onSaved(view)` is called after a save or a removal.
 */
export async function openUnitEditor(reference, loc, jurKey, { onSaved, countryCode } = {}) {
  const [view, voc] = await Promise.all([get(unitPath(reference, loc, jurKey)), vocab()]);
  void voc;
  // a country that is not in the database yet: take the code given when it was added
  const cc = countryCode ?? customCountries()[jurKey];
  if (!view.exists && !view.data.countryCode && cc) {
    view.data.countryCode = cc;
    view.suggestions.country_code = cc;
  }
  const sugg = view.suggestions;
  const here = view.locations.find((l) => l.loc === loc);
  const state = { data: structuredClone(view.data), panelErrors: 0 };
  const baseline = JSON.stringify(view.data);
  const images = view.images;
  const pendingUploads = new Map(); // code -> File, uploaded once the code exists
  const savedCodes = new Set(view.exists ? codesOf(view.data) : []);
  const path = `${loc.startsWith('d') ? `$.officialSign.designs[${loc.slice(1)}]` : `$.relatedSigns[${loc.slice(1)}]`}.jurisdictions.${jurKey}`;
  const prefix = () => (mainCode(state.data) ? mainCode(state.data).split(':')[0] : (state.data.countryCode || sugg.country_code || '').split('-')[0]);

  const identity = block((redraw) => {
    const d = state.data;
    const langs = d.languages;
    const shared = sharedCodes(langs) && !state.perLanguage;
    const first = Object.values(langs)[0];
    const code = first?.code ?? '';
    const imgUrl = images[code]?.[0];
    const pending = pendingUploads.get(code);
    const fileInput = h('input', { type: 'file', accept: '.svg,.png,.jpg,.jpeg,.gif,.webp,image/*', class: 'visually-hidden' });
    const takeFile = async (file) => {
      if (!file) return;
      if (!code) return toast(t('Enter the code first.'), 'error');
      if (savedCodes.has(code)) {
        const fd = new FormData();
        fd.append('code', code);
        fd.append('file', file);
        try {
          const r = await api('POST', '/api/v1/images', fd, { form: true });
          images[code] = [r.url, ...(images[code] ?? [])];
          toast(uploadedMessage(r));
        } catch (err) { toast(err.message, 'error'); }
      } else {
        pendingUploads.set(code, file);
        toast(t('The image will be uploaded when you save.'));
      }
      redraw();
    };
    fileInput.addEventListener('change', () => takeFile(fileInput.files[0]));
    const drop = h('label.dropzone', {
      title: t('Drop an image here or click to choose one'),
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); takeFile(e.dataTransfer.files[0]); },
    },
    pending ? h('img', { src: URL.createObjectURL(pending), alt: '' }) : imgUrl ? h('img', { src: imgUrl, alt: code }) : h('span.dz-empty', {}, '＋'),
    h('span.dz-hint', {}, pending ? t('Will be uploaded on save') : imgUrl ? t('Replace the image') : t('Add an image')),
    fileInput);

    let codeBlock;
    if (shared) {
      const others = (first?.codes ?? []).filter((c) => c !== code);
      const setCodes = (main, rest) => {
        const oldOsm = osmFor(code);
        for (const l of Object.values(langs)) {
          l.code = main;
          l.codes = [...new Set([main, ...rest].filter(Boolean))];
        }
        const ts = d.osm.traffic_sign;
        if (main && (ts.length === 0 || (ts.length === 1 && ts[0] === oldOsm))) d.osm.traffic_sign = [osmFor(main)];
      };
      const suffix = code.includes(':') ? code.slice(code.indexOf(':') + 1) : code;
      const lk = Object.keys(langs)[0] ?? 'en';
      const codeInput = h('input', {
        type: 'text', value: suffix, class: 'mono', placeholder: 'B14', dataset: { path: sub(sub(sub(path, 'languages'), lk), 'code') },
        onchange: (e) => {
          const raw = e.target.value.trim();
          setCodes(raw === '' ? '' : raw.includes(':') ? raw : `${prefix()}:${raw}`, others);
          redraw();
        },
      });
      const othersList = [...others];
      codeBlock = h('div.code-fields', {},
        field('National code', h('div.prefixed', {}, h('span.prefix', {}, `${prefix()}:`), codeInput), { help: 'As written in the national regulations, e.g. B14.' }),
        field('Other codes (variants)', strList(othersList, {
          path: sub(sub(sub(path, 'languages'), lk), 'codes'), placeholder: `${prefix()}:…`, autocomplete: true,
          onchange: () => setCodes(code, othersList.map((c) => (c.includes(':') ? c : `${prefix()}:${c}`))),
        })));
    } else {
      codeBlock = h('div', {},
        h('p.muted.small', {}, t('Codes differ by language:')),
        mapEditor(langs, {
          path: sub(path, 'languages'), addLabel: 'Add a language', keyPlaceholder: 'Language code', keyPattern: LANG_KEY,
          newValue: () => ({ code, codes: code ? [code] : [], text: null, description: null }),
          renderValue: (o, k, p) => languageEditor(o, k, p),
        }));
    }
    const texts = shared ? h('div.texts', {}, Object.keys(langs).map((lk) => field(t('Text on the sign ({lang})', { lang: lk }),
      text(langs[lk], 'text', { path: sub(sub(path, 'languages'), lk), nullable: true, placeholder: 'Official name or wording' })))) : null;

    const more = h('details.more', {},
      h('summary', {}, t('More options')),
      h('div.stack', {},
        h('div.grid2', {},
          field('Country code', text(d, 'countryCode', { path, mono: true, onchange: () => state.recheckPanels?.() })),
          field('Left-hand traffic variant', bool(d, 'leftHandTrafficVariant', { path, optional: true }))),
        h('label.check', {}, h('input', { type: 'checkbox', checked: !shared, onchange: (e) => { state.perLanguage = e.target.checked; redraw(); } }), t('Different codes for each language')),
        shared ? field('Languages', mapEditor(langs, {
          path: sub(path, 'languages'), inline: true, addLabel: 'Add a language', keyPlaceholder: 'Language code', keyPattern: LANG_KEY,
          suggestions: sugg.languages,
          newValue: () => ({ code, codes: code && first ? [...first.codes] : [], text: null, description: null }),
          onAdd: () => setTimeout(redraw, 0),
          renderValue: (o, k) => text(o[k], 'description', { path: sub(sub(path, 'languages'), k), nullable: true, placeholder: 'Description (optional)' }),
        }), { wide: true }) : null,
        h('h5', {}, t('Parameters')),
        block((r2) => (d.parameters
          ? mapEditor(d.parameters, {
            path: sub(path, 'parameters'), addLabel: 'Add a parameter', keyPlaceholder: 'maxspeed', keyPattern: '^[a-z][a-z0-9_]{0,40}$',
            suggestions: ['maxspeed', 'minspeed', 'speed', 'weight', 'axleload', 'height', 'width', 'length', 'distance'],
            newValue: () => ({ description: null, type: 'number', unit: null, values: [] }),
            renderValue: (o, k, p) => parameterEditor(o, k, p),
          })
          : h('button.btn.small', { type: 'button', onclick: () => { d.parameters = {}; r2(); } }, `+ ${t('Add a parameter')}`))),
        field('OSM traffic_sign values', strList(d.osm.traffic_sign, { path: sub(sub(path, 'osm'), 'traffic_sign') }), { help: 'Filled in automatically from the code.' }),
        h('h5', {}, t('Sources')),
        block((r3) => (d.sources
          ? listEditor(d.sources, {
            path: sub(path, 'sources'), addLabel: 'Add a source', title: (s) => s.file || '—', collapsed: true,
            newItem: () => ({ file: '', url: null }),
            renderItem: (s, i, p) => h('div.grid2', {}, field('File', text(s, 'file', { path: p })), field('URL', text(s, 'url', { path: p, nullable: true }))),
          })
          : h('button.btn.small', { type: 'button', onclick: () => { d.sources = []; r3(); } }, `+ ${t('Add a source')}`)))));
    return [h('div.variant-main', {}, drop, h('div.stack', {}, codeBlock, texts)), more];
  }, 'section', { class: 'variant' });

  const signImg = () => images[mainCode(state.data)]?.[0] ?? here?.image ?? null;
  const errorsBox = h('div.errors-box');
  const comment = h('input', { type: 'text', maxlength: 500, placeholder: t('Summary of your change (optional)'), class: 'comment' });
  const saveBtn = h('button.btn.primary', { type: 'button' }, view.exists ? t('Save') : t('Add'));
  const removeBtn = view.exists ? h('button.btn.danger', {
    type: 'button',
    onclick: async () => {
      if (!(await confirmDialog(t('Remove {code} ({country}) from this sign?', { code: mainCode(view.data), country: pretty(jurKey) })))) return;
      try {
        await del(unitPath(reference, loc, jurKey), { version: view.version, comment: comment.value });
        toast(t('Removed.'));
        await close(true);
        onSaved?.(null);
      } catch (err) { toast(err.message, 'error'); }
    },
  }, t('Remove')) : null;

  const dirty = () => JSON.stringify(state.data) !== baseline || pendingUploads.size > 0;
  const dlg = h('dialog.drawer', { 'aria-label': `${pretty(jurKey)} — ${reference}` },
    h('header.drawer-head', {},
      h('div', {},
        h('p.crumbs', {}, h('a', { href: signHref(reference) }, h('code', {}, reference)), ' · ', here ? locLabel(here) : loc),
        h('h2', {}, view.exists ? mainCode(view.data) : t('New national sign'), ' ', h('span.muted', {}, pretty(jurKey)))),
      h('button.btn.close', { type: 'button', 'aria-label': t('Close'), onclick: () => close() }, icon('close'))),
    !view.exists ? h('p.banner.info', {}, t('{country} has no national sign here yet. Fill in its code and save to add it.', { country: pretty(jurKey) })) : null,
    h('div.drawer-body', {},
      identity,
      h('section.variant', {}, h('h3', {}, t('Additional panels')),
        h('p.small.muted', {}, t('Each slot is one place around the sign (1 = closest); a slot may list several alternative panels. Every panel is checked: it must exist, belong to this country or the Convention, and the Convention’s list for this sign is shown.')),
        panelsEditor(state, view, sub(path, 'additional'), signImg()))),
    h('footer.drawer-foot', {},
      errorsBox,
      h('div.row', {}, comment, removeBtn, h('button.btn', { type: 'button', onclick: () => close() }, t('Cancel')), saveBtn),
      h('p.small.muted', {}, t('Ctrl+Enter to save'), ' · ', h('a', { href: signHref(reference, '/edit') }, t('Open the full editor')))));

  async function close(force = false) {
    if (!force && dirty() && !(await confirmDialog(t('You have unsaved changes. Leave anyway?')))) return;
    dlg.close();
    dlg.remove();
  }

  async function save() {
    errorsBox.replaceChildren();
    if (state.panelErrors) {
      errorsBox.replaceChildren(h('div.errors', { role: 'alert' }, t('{n} panel(s) cannot be added — fix them before saving.', { n: state.panelErrors })));
      return;
    }
    saveBtn.disabled = true;
    try {
      const r = await put(unitPath(reference, loc, jurKey), { version: view.version, data: state.data, comment: comment.value });
      for (const [code, file] of pendingUploads) {
        const fd = new FormData();
        fd.append('code', code);
        fd.append('file', file);
        try { await api('POST', '/api/v1/images', fd, { form: true }); } catch (err) { toast(`${code}: ${err.message}`, 'error'); }
      }
      pendingUploads.clear();
      toast(t('Saved.'));
      await close(true);
      onSaved?.(r);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'edit_conflict') {
        errorsBox.replaceChildren(h('div.errors', { role: 'alert' }, h('p', {}, err.message),
          h('button.btn', { type: 'button', onclick: async () => { await close(true); openUnitEditor(reference, loc, jurKey, { onSaved }); } }, t('Reload'))));
      } else if (err instanceof ApiError && err.details) {
        showErrors(errorsBox, err.details, dlg);
      } else toast(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', save);
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      document.activeElement?.dispatchEvent(new Event('change', { bubbles: true }));
      save();
    }
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  dlg.querySelector('.prefixed input, input')?.focus();
  return dlg;
}

/** Create a national sign: ask the country, then open the editor. */
export async function addUnit(reference, loc, existing, allCountries, opts) {
  const picked = await pickCountry(existing, allCountries);
  if (picked) await openUnitEditor(reference, loc, picked.key, { ...opts, countryCode: picked.countryCode });
}
