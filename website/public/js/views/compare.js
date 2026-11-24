// Country comparison table: one row per sign, one column per country, filterable by category and countries.
import { countries, get, session, vocab } from '../api.js';
import { openCountryEditor } from './country.js';
import { debounce, h, signHref, toast } from '../dom.js';
import { t, tn } from '../i18n.js';
import { displayName } from './list.js';

const pretty = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function readState() {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  return {
    category: q.has('category') ? q.get('category') : 'A',
    kind: q.get('kind') || 'vienna',
    q: q.get('q') ?? '',
    countries: (q.get('countries') ?? '').split(',').filter(Boolean),
    filled: q.get('filled') === '1',
    page: Math.max(1, Number(q.get('page')) || 1),
  };
}

function writeState(s) {
  const q = new URLSearchParams();
  q.set('category', s.category);
  if (s.kind !== 'vienna') q.set('kind', s.kind);
  if (s.q) q.set('q', s.q);
  if (s.countries.length) q.set('countries', s.countries.join(','));
  if (s.filled) q.set('filled', '1');
  if (s.page > 1) q.set('page', s.page);
  history.replaceState(null, '', `#/compare?${q}`);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function viewCompare() {
  const [voc, ctry] = await Promise.all([vocab(), countries()]);
  const state = readState();

  // Jurisdictions (one column each), with their country codes.
  const jurs = new Map();
  for (const c of ctry) {
    const j = jurs.get(c.jurisdiction) ?? { key: c.jurisdiction, codes: new Set(), signs: 0 };
    j.codes.add(c.country_code);
    j.signs += c.signs;
    jurs.set(c.jurisdiction, j);
  }
  const allJurs = [...jurs.values()].sort((a, b) => pretty(a.key).localeCompare(pretty(b.key)));

  const catLabel = (c) => {
    const key = c.split('-').at(-1);
    return `${c.startsWith('OTHER') ? `${t('National')} · ` : ''}${key} — ${t(voc.categoryNames[key] ?? c)}`;
  };

  // --- filters --------------------------------------------------------------------------
  const category = h('select', { 'aria-label': t('Category') },
    h('option', { value: '' }, t('All categories')),
    voc.categories.map((c) => h('option', { value: c.value, selected: c.value === state.category }, catLabel(c.value))));
  const kind = h('select', { 'aria-label': t('Kind') },
    [['vienna', 'Vienna Convention'], ['other', 'National only'], ['all', 'All signs']].map(([v, l]) => h('option', { value: v, selected: v === state.kind }, t(l))));
  const search = h('input', { type: 'search', value: state.q, placeholder: t('Filter signs…'), 'aria-label': t('Search') });
  const filled = h('label.check', {}, h('input', { type: 'checkbox', checked: state.filled }), t('Hide signs no selected country uses'));

  // Country picker
  const selected = new Set(state.countries);
  const pickerSummary = h('span');
  const countryFilter = h('input', { type: 'search', placeholder: t('Find a country…'), 'aria-label': t('Find a country…') });
  const list = h('div.country-list');
  function drawCountryList() {
    const f = countryFilter.value.trim().toLowerCase();
    list.replaceChildren(...allJurs
      .filter((j) => !f || j.key.includes(f.replace(/\s+/g, '_')) || [...j.codes].some((c) => c.startsWith(f)))
      .map((j) => h('label.check', {},
        h('input', {
          type: 'checkbox', checked: selected.has(j.key),
          onchange: (e) => { if (e.target.checked) selected.add(j.key); else selected.delete(j.key); updateSummary(); reload(); },
        }),
        pretty(j.key), ' ', h('code.cc', {}, [...j.codes].join(' ')))));
  }
  function updateSummary() {
    pickerSummary.textContent = selected.size ? tn(selected.size, '{n} country selected', '{n} countries selected') : t('All countries');
  }
  countryFilter.addEventListener('input', drawCountryList);
  const picker = h('details.picker', {},
    h('summary.btn', {}, pickerSummary),
    h('div.picker-panel', {},
      countryFilter,
      h('div.row', {},
        h('button.btn.small', { type: 'button', onclick: () => { selected.clear(); drawCountryList(); updateSummary(); reload(); } }, t('All countries')),
        h('button.btn.small', {
          type: 'button',
          onclick: () => {
            const f = countryFilter.value.trim();
            if (!f) return;
            list.querySelectorAll('input').forEach((i) => { if (!i.checked) i.click(); });
          },
        }, t('Select the matches'))),
      list));
  const closePicker = (e) => {
    if (!picker.isConnected) return document.removeEventListener('click', closePicker);
    if (!picker.contains(e.target)) picker.open = false;
  };
  document.addEventListener('click', closePicker);
  updateSummary();
  drawCountryList();

  // --- table ------------------------------------------------------------------------------
  const info = h('p.muted.small');
  const tableBox = h('div.matrix-wrap');
  const pagerBox = h('div');
  let lastData = null;
  let reqId = 0;

  async function load({ keepScroll = false } = {}) {
    const scroll = keepScroll ? [tableBox.scrollLeft, tableBox.scrollTop, window.scrollY] : null;
    Object.assign(state, {
      category: category.value, kind: kind.value, q: search.value.trim(),
      countries: [...selected], filled: filled.querySelector('input').checked,
    });
    writeState(state);
    const params = new URLSearchParams({ category: state.category, kind: state.kind, page: state.page, per_page: 300 });
    if (state.q) params.set('q', state.q);
    if (state.countries.length) params.set('countries', state.countries.join(','));
    if (state.filled) params.set('only_filled', '1');
    const id = ++reqId;
    tableBox.classList.add('loading');
    try {
      const data = await get(`/api/v1/compare?${params}`);
      if (id !== reqId) return;
      lastData = data;
      draw(data);
      if (scroll) {
        [tableBox.scrollLeft, tableBox.scrollTop] = scroll;
        window.scrollTo(0, scroll[2]);
      }
    } catch (err) {
      tableBox.replaceChildren(h('p.error', {}, err.message));
    } finally {
      tableBox.classList.remove('loading');
    }
  }
  const reload = debounce(() => { state.page = 1; load(); }, 250);

  function draw(data) {
    const cols = data.columns;
    const rows = data.items;
    info.textContent = `${tn(data.total, '{n} sign', '{n} signs')} · ${tn(cols.length, '{n} country', '{n} countries')}`;
    if (!rows.length || !cols.length) {
      tableBox.replaceChildren(h('p.empty', {}, t('No sign matches these filters.')));
      pagerBox.replaceChildren();
      return;
    }
    const head = h('thead', {}, h('tr', {},
      h('th.corner', {}, t('Sign')),
      cols.map((c) => h('th.colhead', { scope: 'col', title: `${pretty(c.key)} (${c.country_code})` },
        h('span.cname', {}, pretty(c.key)),
        h('code.cc', {}, c.country_code),
        h('span.coverage', {}, `${c.count}/${rows.length}`)))));
    const body = h('tbody', {}, rows.map((r) => h('tr', {},
      h('th.rowhead', { scope: 'row' },
        h('a', { href: signHref(r.reference) },
          r.vienna_image ? h('img.official-mini', { src: r.vienna_image, alt: '', loading: 'lazy' }) : null,
          h('span.rtext', {}, h('code.ref', {}, r.reference), h('span.rname', {}, displayName(r.name))))),
      cols.map((c) => {
        const cell = r.cells[c.key];
        const edit = (e) => {
          if (!session.user) return; // visitors follow the link to the sign page
          e.preventDefault();
          openCountryEditor(r.reference, c.key, { onSaved: () => load({ keepScroll: true }) }).catch((err) => toast(err.message, 'error'));
        };
        if (!cell) {
          return session.user
            ? h('td.none.addable', { title: `${pretty(c.key)} — ${t('not used')} · ${t('click to add')}` }, h('button.addcell', { type: 'button', 'aria-label': `${t('Add')} ${pretty(c.key)} — ${r.reference}`, onclick: edit }, '+'))
            : h('td.none', { title: `${pretty(c.key)} — ${t('not used')}` }, '—');
        }
        const title = [`${pretty(c.key)}: ${cell.codes.join(', ')}`, r.designs > 1 ? `${t('Design {n}', { n: cell.design })} — ${cell.design_label}` : cell.design_label, cell.panels ? t('Additional panels') : ''].filter(Boolean).join('\n');
        return h('td', { title: session.user ? `${title}\n${t('Click to edit')}` : title },
          h('a', { href: signHref(r.reference), onclick: edit },
            cell.image ? h('img', { src: cell.image, alt: cell.codes[0], loading: 'lazy' }) : h('span.noimg-dot', {}, '○'),
            h('span.code', {}, cell.codes[0]?.split(':').slice(1).join(':')),
            cell.codes.length > 1 ? h('span.more', {}, `+${cell.codes.length - 1}`) : null,
            r.designs > 1 ? h('span.dnum', {}, `#${cell.design}`) : null));
      }))));
    tableBox.replaceChildren(h('table.matrix', {}, head, body));
    const pages = Math.ceil(data.total / data.per_page);
    pagerBox.replaceChildren(pages > 1 ? h('nav.pager', {},
      h('button.btn', { type: 'button', disabled: state.page <= 1, onclick: () => { state.page -= 1; load(); } }, t('← Previous')),
      h('span', {}, t('Page {p} / {n}', { p: state.page, n: pages })),
      h('button.btn', { type: 'button', disabled: state.page >= pages, onclick: () => { state.page += 1; load(); } }, t('Next →'))) : '');
  }

  function downloadCsv() {
    if (!lastData) return;
    const cols = lastData.columns;
    const lines = [['reference', 'name', ...cols.map((c) => `${c.key} (${c.country_code})`)].map(csvCell).join(',')];
    for (const r of lastData.items) {
      lines.push([r.reference, displayName(r.name), ...cols.map((c) => r.cells[c.key]?.codes.join(' ') ?? '')].map(csvCell).join(','));
    }
    const blob = new Blob([`﻿${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `panomatix-${state.category || 'all'}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  [category, kind].forEach((el) => el.addEventListener('change', reload));
  search.addEventListener('input', reload);
  filled.querySelector('input').addEventListener('change', reload);
  load();

  return h('section.page.compare', {},
    h('h1', {}, t('Compare countries')),
    h('p.muted', {}, t('Which national sign each country uses for every sign of the Convention. Hover a cell for the design; click it to open the sign.'),
      session.user ? h('strong', {}, ` ${t('Signed in: click a cell to edit that country, or + to add it.')}`) : ''),
    h('div.compare-filters', {}, category, kind, search, picker,
      h('button.btn', { type: 'button', onclick: downloadCsv }, t('Download CSV'))),
    h('div.row.between', {}, filled, info),
    tableBox,
    pagerBox);
}
