// Printable A4 document of the (filtered) database, saved as PDF with the browser's print dialog.
import { get, vocab } from '../api.js';
import { h, signHref } from '../dom.js';
import { fmtDateTime, lang, t } from '../i18n.js';
import { displayName } from './list.js';

const POS = [['top', 'Above'], ['bottom', 'Below'], ['left', 'Left'], ['right', 'Right']];
const pretty = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const DESIGN_PROPS = ['shape', 'background_color', 'border_color', 'symbol_color', 'band', 'band_color', 'prohibition_bar', 'bar_continuity', 'model', 'legacyModel'];
const PROP_LABEL = {
  shape: 'Shape', background_color: 'Background colour', border_color: 'Border colour', symbol_color: 'Symbol colour', band: 'Band',
  band_color: 'Band colour', prohibition_bar: 'Prohibition bar', bar_continuity: 'Bar continuity', model: 'Model', legacyModel: 'Legacy model',
};

function panelsList(add) {
  const parts = [];
  for (const [pos, label] of POS) {
    for (const slot of [...(add?.[pos] ?? [])].sort((a, b) => a.index - b.index)) {
      if (slot.reference.length) parts.push(h('div', {}, h('span.p-k', {}, `${t(label)} ${slot.index}`), ' ', slot.reference.join(', ')));
    }
  }
  return parts;
}

function i18nList(obj) {
  return Object.entries(obj ?? {}).filter(([, v]) => v).map(([k, v]) => h('div.p-i18n', {}, h('span.p-lang', {}, k), h('span', {}, v)));
}

function catKey(category) {
  return category.split('-').at(-1);
}

function categoryDivider(category, count, voc) {
  const key = catKey(category);
  return h('section.p-divider', {},
    h('div.p-divider-letter', {}, key),
    h('div', {},
      h('div.p-divider-kicker', {}, category.startsWith('OTHER') ? t('National signs') : t('Vienna Convention')),
      h('h2', {}, t(voc.categoryNames[key] ?? category)),
      h('p', {}, `${count} ${t('signs')}`)));
}

function designTable(item, design) {
  const jurs = Object.entries(design.jurisdictions ?? {}).sort((a, b) => pretty(a[0]).localeCompare(pretty(b[0])));
  if (!jurs.length) return h('p.p-empty', {}, t('No country uses this design yet.'));
  const rows = jurs.map(([key, j]) => {
    const codes = [...new Set(Object.values(j.languages ?? {}).flatMap((l) => l.codes))];
    return {
      key, j, codes,
      img: codes.map((c) => item.images[c]).find(Boolean),
      texts: Object.entries(j.languages ?? {}).filter(([, l]) => l.text).map(([lk, l]) => h('div.p-i18n', {}, h('span.p-lang', {}, lk), h('span', {}, l.text))),
      panels: panelsList(j.additional),
      params: Object.entries(j.parameters ?? {}).map(([k, p]) => h('div', {}, h('span.p-k', {}, k), ` ${p.values.join(', ')}${p.unit ? ` ${p.unit}` : ''}`)),
      osm: (j.osm?.traffic_sign ?? []).join(', '),
    };
  });
  // Only the columns that say something for this design.
  const cols = [
    ['country', t('Country'), true],
    ['img', '', rows.some((r) => r.img)],
    ['codes', t('National code'), true],
    ['texts', t('Text'), rows.some((r) => r.texts.length)],
    ['panels', t('Additional panels'), rows.some((r) => r.panels.length)],
    ['params', t('Parameters'), rows.some((r) => r.params.length)],
    ['osm', 'OpenStreetMap', rows.some((r) => r.osm)],
  ].filter(([, , show]) => show);
  const cell = (r, col) => {
    switch (col) {
      case 'country': return h('td.p-country', {}, h('strong', {}, pretty(r.key)), h('span.p-cc', {}, r.j.countryCode), r.j.leftHandTrafficVariant ? h('div.p-note', {}, t('left-hand traffic')) : null);
      case 'img': return h('td.p-img', {}, r.img ? h('img', { src: r.img, alt: '' }) : null);
      case 'codes': return h('td.p-mono', {}, r.codes.join(', '));
      case 'texts': return h('td', {}, r.texts);
      case 'panels': return h('td', {}, r.panels);
      case 'params': return h('td', {}, r.params);
      case 'osm': return h('td.p-mono.p-soft', {}, r.osm);
      default: return h('td');
    }
  };
  return h('table.p-table', {},
    h('thead', {}, h('tr', {}, cols.map(([id, label]) => h(`th.c-${id}`, {}, label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, cols.map(([id]) => cell(r, id))))));
}

function signSection(item, voc) {
  const d = item.data;
  const key = catKey(d.category);
  const img = item.vienna_image ?? Object.values(item.images).find(Boolean);
  const others = Object.entries(d.name ?? {}).filter(([k, v]) => v && v !== displayName(d.name));
  const osm = d.osm ? [d.osm.traffic_sign_generic ? `traffic_sign=${d.osm.traffic_sign_generic}` : null, ...Object.entries(d.osm.implied_tags ?? {}).map(([k, v]) => `${k}=${v}`)].filter(Boolean).join('  ·  ') : '';
  const facts = [
    [t('Category'), `${d.category} — ${t(voc.categoryNames[key] ?? '')}`],
    [t('Legacy references'), d.legacyReferences.join(', ')],
    [t('Symbol may be reversed'), d.symbolMayBeReversed === undefined ? '' : t(d.symbolMayBeReversed ? 'yes' : 'no')],
    ['OpenStreetMap', osm],
    [t('Note'), d.note ?? ''],
  ].filter(([, v]) => v);
  const panels = panelsList(d.officialSign.additional);
  const countries = new Set(d.officialSign.designs.flatMap((x) => Object.keys(x.jurisdictions ?? {})));

  return h('section.p-sign', { id: `p-${item.reference}` },
    h('header.p-head', {},
      h('div.p-plate', {}, img ? h('img', { src: img, alt: '' }) : h('span.p-noimg', {}, '—')),
      h('div.p-title', {},
        h('div.p-kicker', {}, h('span.p-ref', {}, item.reference), h('span.p-dot', {}, '·'), t(voc.categoryNames[key] ?? d.category)),
        h('h2', {}, displayName(d.name) || item.reference),
        others.length ? h('div.p-names', {}, others.map(([k, v]) => h('span', {}, h('span.p-lang', {}, k), v))) : null,
        h('div.p-stats', {},
          h('span', {}, h('b', {}, countries.size), ` ${t('countries')}`),
          h('span', {}, h('b', {}, d.officialSign.designs.length), ` ${t('designs')}`)))),
    Object.values(d.description ?? {}).some(Boolean) ? h('div.p-desc', {}, i18nList(d.description)) : null,
    h('dl.p-facts', {}, facts.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
    panels.length ? h('div.p-block', {}, h('h3', {}, t('Additional panels (Convention level)')), h('div.p-panels', {}, panels)) : null,
    d.officialSign.designs.map((design, i) => {
      const chips = DESIGN_PROPS.filter((p) => design[p] !== undefined && design[p] !== null && design[p] !== 'none')
        .map((p) => h('span.p-chip', {}, h('span.p-chip-k', {}, t(PROP_LABEL[p])), design[p]));
      return h('div.p-design', {},
        h('div.p-design-head', {},
          h('h3', {}, t('Design {n}', { n: i + 1 })),
          h('div.p-chips', {}, chips, design.versions.length ? h('span.p-chip.p-ver', {}, design.versions.join(' · ')) : null)),
        designTable(item, design));
    }),
    d.relatedSigns?.length ? h('div.p-block', {}, h('h3', {}, t('Related signs')),
      h('ul.p-related', {}, d.relatedSigns.map((r) => h('li', {}, h('span.p-mono', {}, r.reference), ` — ${displayName(r.name)}`, h('span.p-soft', {}, ` (${Object.keys(r.jurisdictions ?? {}).map(pretty).join(', ') || '—'})`))))) : null);
}

export async function viewPrint() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  if (!params.toString()) params.set('kind', 'vienna');
  const voc = await vocab();
  const toolbarMsg = h('span');
  const printBtn = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => window.print() }, t('Save as PDF'));
  const toolbar = h('div.print-toolbar', {},
    h('a.btn', { href: '#/' }, t('← Back')), toolbarMsg, printBtn,
    h('span.small.muted', {}, t('In the print dialog, choose “Save as PDF” as the destination, A4 paper, default margins.')));

  let data;
  try {
    data = await get(`/api/v1/print?${params}`);
  } catch (err) {
    return h('section.page', {}, toolbar, h('div.errors', {}, h('p', {}, err.message),
      h('p', {}, t('Choose a category or a country on the sign list, then export again.'))));
  }

  const filters = [
    params.get('ref') && params.get('ref'),
    params.get('category') && `${params.get('category')} — ${t(voc.categoryNames[catKey(params.get('category'))] ?? '')}`,
    params.get('country') && pretty(params.get('country')),
    params.get('kind') === 'vienna' ? t('Vienna Convention') : params.get('kind') === 'other' ? t('National only') : null,
    params.get('q') && `« ${params.get('q')} »`,
  ].filter(Boolean);
  const selection = filters.join(' · ') || t('All signs');
  const countries = new Set();
  let designs = 0;
  for (const it of data.items) for (const d of it.data.officialSign.designs) { designs += 1; for (const k of Object.keys(d.jurisdictions ?? {})) countries.add(k); }

  // Group by category for the table of contents and the section dividers.
  const groups = [];
  for (const it of data.items) {
    const last = groups.at(-1);
    if (last && last.category === it.data.category) last.items.push(it);
    else groups.push({ category: it.data.category, items: [it] });
  }
  const single = data.items.length === 1;

  const doc = h('article.print-doc', { lang },
    h('section.p-cover', {},
      h('div.p-cover-band', {},
        h('img', { src: '/logo.svg', alt: '' }),
        h('span', {}, 'Panomatix')),
      h('div.p-cover-body', {},
        h('div.p-cover-kicker', {}, t('Road signs of the world')),
        h('h1', {}, single ? (displayName(data.items[0].data.name) || data.items[0].reference) : selection),
        single ? h('p.p-cover-sub', {}, data.items[0].reference) : null,
        h('div.p-cover-stats', {},
          [[data.items.length, t('signs')], [countries.size, t('countries')], [designs, t('designs')]]
            .map(([n, l]) => h('div', {}, h('strong', {}, n.toLocaleString(lang)), h('span', {}, l))))),
      h('div.p-cover-foot', {},
        h('div', {}, t('Vienna Convention on Road Signs and Signals — national equivalents, designs and OpenStreetMap tags.')),
        h('div', {}, `${t('Generated on')} ${fmtDateTime(data.generated_at)}`))),
    !single ? h('section.p-toc', {},
      h('h2', {}, t('Contents')),
      groups.map((g) => h('div.p-toc-group', {},
        h('h4', {}, `${catKey(g.category)} — ${t(voc.categoryNames[catKey(g.category)] ?? g.category)}`),
        h('ul', {}, g.items.map((it) => h('li', {},
          h('a', { href: `#p-${it.reference}`, onclick: (e) => { e.preventDefault(); document.getElementById(`p-${it.reference}`)?.scrollIntoView(); } },
            h('span.p-mono', {}, it.reference.replace(/^VIENNA2006:|^VIENNA:|^OTHER:/, '')), h('span', {}, displayName(it.data.name))))))))) : null,
    groups.map((g) => [
      !single && groups.length > 1 ? categoryDivider(g.category, g.items.length, voc) : null,
      g.items.map((it) => signSection(it, voc)),
    ]));
  if (data.items.length > 300) doc.classList.add('dense');

  // Enable printing once every picture is loaded, so none is missing from the PDF.
  const imgs = [...doc.querySelectorAll('img')];
  let done = 0;
  const tick = () => {
    done += 1;
    toolbarMsg.textContent = done < imgs.length ? t('Loading images {a} / {b}…', { a: done, b: imgs.length }) : `${data.items.length} ${t('signs')} — ${t('ready')}`;
    if (done >= imgs.length) printBtn.disabled = false;
  };
  toolbarMsg.textContent = t('Loading images {a} / {b}…', { a: 0, b: imgs.length });
  if (!imgs.length) tick();
  for (const im of imgs) {
    im.loading = 'eager';
    if (im.complete) tick();
    else {
      im.addEventListener('load', tick, { once: true });
      im.addEventListener('error', tick, { once: true });
    }
  }
  return h('div.print-view', {}, toolbar, doc);
}

/** Hash of the printable view for the current list filters. */
export function printHref(filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v && k !== 'page') p.set(k, v);
  return `#/print?${p}`;
}

export { signHref };
