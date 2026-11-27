// Sign list: search, filters, pagination.
import { countries, get, vocab } from '../api.js';
import { debounce, h, signHref, fill } from '../dom.js';
import { lang, t, tn } from '../i18n.js';
import { readOnlyBanner } from '../widgets.js';
import { signWithPanels } from './unit.js';
import { icon } from '../icons.js';

const KIND_LABEL = { vienna: 'Vienna Convention', other: 'National only', all: 'All signs' }; // translated at render; Vienna is the default

function readQuery() {
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
  return {
    q: q.get('q') ?? '',
    category: q.get('category') ?? '',
    country: q.get('country') ?? '',
    kind: KIND_LABEL[q.get('kind')] ? q.get('kind') : 'vienna',
    page: Math.max(1, Number(q.get('page')) || 1),
  };
}

function writeQuery(state) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) if (v && !(k === 'page' && v === 1) && !(k === 'kind' && v === 'vienna')) q.set(k, v);
  const s = q.toString();
  history.replaceState(null, '', `#/signs${s ? `?${s}` : ''}`);
}

export const displayName = (name = {}) => name[lang] || name.en || name.fr || name.de || Object.values(name)[0] || '';

export async function viewList() {
  const [voc, ctry] = await Promise.all([vocab(), countries()]);
  const state = readQuery();
  const results = h('div.results', { 'aria-live': 'polite' });
  const countLine = h('p.muted');

  const catNames = voc.categoryNames;
  const catLabel = (c) => {
    const key = c.split('-').at(-1);
    const prefix = t(c.startsWith('OTHER') ? 'National' : 'Vienna');
    return `${prefix} · ${key} — ${t(catNames[key] ?? c)}`;
  };

  const q = h('input', { type: 'search', placeholder: t('Search a reference, a name or a national code (e.g. fr:B14, stop, C-14)…'), value: state.q, 'aria-label': t('Search') });
  const category = h('select', { 'aria-label': t('Category') },
    h('option', { value: '' }, t('All categories')),
    voc.categories.map((c) => h('option', { value: c.value, selected: c.value === state.category }, `${catLabel(c.value)} (${c.count})`)));
  const countryMap = new Map();
  for (const c of ctry) {
    const key = c.jurisdiction;
    const cur = countryMap.get(key) ?? { label: key.replace(/_/g, ' '), codes: new Set(), signs: 0 };
    cur.codes.add(c.country_code);
    cur.signs += c.signs;
    countryMap.set(key, cur);
  }
  const country = h('select', { 'aria-label': t('Country') },
    h('option', { value: '' }, t('All countries')),
    [...countryMap.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label)).map(([key, c]) =>
      h('option', { value: key, selected: key === state.country }, `${c.label} (${[...c.codes].join(', ')})`)));
  const kind = h('select', { 'aria-label': t('Kind') },
    Object.entries(KIND_LABEL).map(([v, l]) => h('option', { value: v, selected: v === state.kind }, t(l))));

  let reqId = 0;
  async function load() {
    writeQuery(state);
    const id = ++reqId;
    const params = new URLSearchParams({ page: state.page, per_page: 48 });
    for (const k of ['q', 'category', 'country']) if (state[k]) params.set(k, state[k]);
    if (state.kind !== 'all') params.set('kind', state.kind);
    results.classList.add('loading');
    try {
      const r = await get(`/api/v1/signs?${params}`);
      if (id !== reqId) return;
      countLine.textContent = tn(r.total, '{n} sign', '{n} signs');
      fill(results,
        r.items.length
          ? h('ul.cards', {}, r.items.map((s) => card(s, catLabel)))
          : h('p.empty', {}, t('No sign matches these filters.')),
        pager(r.total, r.per_page),
      );
    } catch (err) {
      results.replaceChildren(h('p.error', {}, err.message));
    } finally {
      results.classList.remove('loading');
    }
  }

  function pager(total, perPage) {
    const pages = Math.max(1, Math.ceil(total / perPage));
    if (pages === 1) return null;
    const go = (p) => () => {
      state.page = p;
      load();
      window.scrollTo(0, 0);
    };
    return h('nav.pager', { 'aria-label': 'Pages' },
      h('button.btn', { type: 'button', disabled: state.page <= 1, onclick: go(state.page - 1) }, icon('chevron-left'), t('Previous')),
      h('span', {}, t('Page {p} / {n}', { p: state.page, n: pages })),
      h('button.btn', { type: 'button', disabled: state.page >= pages, onclick: go(state.page + 1) }, t('Next'), icon('chevron-right')));
  }

  const onFilter = () => {
    Object.assign(state, { q: q.value.trim(), category: category.value, country: country.value, kind: kind.value, page: 1 });
    load();
  };
  q.addEventListener('input', debounce(onFilter, 300));
  [category, country, kind].forEach((s) => s.addEventListener('change', onFilter));

  load();
  return h('section.page', {},
    h('div.hero', {},
      h('h1', {}, t('Road signs of the world')),
      h('p', {}, t('Every sign of the Vienna Convention mapped to its national equivalents, designs and OpenStreetMap tags — edited by the community.'))),
    readOnlyBanner(),
    h('form.filters', { role: 'search', onsubmit: (e) => { e.preventDefault(); onFilter(); } }, q, category, country, kind),
    h('div.row.between', {}, countLine),
    results);
}

function card(s, catLabel) {
  return h('li.card', { dataset: { cat: s.category.split('-').at(-1) } },
    h('a', { href: signHref(s.reference) },
      h('div.thumb', {}, s.thumbnail ? signWithPanels(h('img', { src: s.thumbnail.url, alt: s.thumbnail.code, loading: 'lazy' }), s.thumbnail.panels) : h('span.noimg', {}, t('no image'))),
      h('div.card-body', {},
        h('code.ref', {}, s.reference),
        h('strong', {}, displayName(s.name) || '—'),
        h('span.muted.small', {}, catLabel(s.category)),
        h('span.muted.small', {}, `${tn(s.countries, '{n} country', '{n} countries')} · ${tn(s.designs, '{n} design', '{n} designs')}`),
        s.codes?.length ? h('span.small', {}, s.codes.slice(0, 4).join(', ')) : null)));
}
