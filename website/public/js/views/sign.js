// Read-only sign page: everything stored in the entry, with images.
import { can, countries, del, get, post, session, signPath, vocab } from '../api.js';
import { confirmDialog, fmtDate, h, signHref, toast } from '../dom.js';
import { navigate } from '../app.js';
import { displayName } from './list.js';
import { openCountryEditor, pickCountryThenEdit } from './country.js';
import { t } from '../i18n.js';

const POS_LABEL = { top: 'Above the sign', bottom: 'Below the sign', left: 'Left of the sign', right: 'Right of the sign' };

const isVienna = (r) => /^(VIENNA|VIENNA2006|OTHER):/.test(r);

/** A reference to another sign or a national code, with its image when one exists. */
export function refChip(ref) {
  const chip = h('span.chip', {}, isVienna(ref) ? h('a', { href: signHref(ref) }, ref) : h('code', {}, ref));
  if (/^[a-z]{2}(-[a-z0-9]{1,3})?:/.test(ref)) {
    get(`/api/v1/images?code=${encodeURIComponent(ref)}`)
      .then((r) => r.images[0] && chip.prepend(h('img.mini', { src: r.images[0], alt: '', loading: 'lazy' })))
      .catch(() => {});
  }
  return chip;
}

export function panelsView(additional) {
  const rows = [];
  for (const pos of ['top', 'bottom', 'left', 'right']) {
    for (const slot of [...(additional?.[pos] ?? [])].sort((a, b) => a.index - b.index)) {
      rows.push(h('tr', {},
        h('td', {}, t(POS_LABEL[pos])),
        h('td.num', {}, slot.index),
        h('td', {}, slot.reference.length ? slot.reference.map(refChip) : h('span.muted', {}, t('empty slot')))));
    }
  }
  if (!rows.length) return h('p.muted.small', {}, t('No additional panel.'));
  return h('table.compact', {}, h('thead', {}, h('tr', {}, h('th', {}, t('Position')), h('th', {}, t('Slot')), h('th', {}, t('Admissible panels')))), h('tbody', {}, rows));
}

function kv(label, value) {
  if (value === undefined) return null;
  return h('div.kv', {}, h('span.k', {}, t(label)), h('span.v', {}, value === null ? h('span.muted', {}, 'null') : typeof value === 'boolean' ? t(value ? 'yes' : 'no') : String(value)));
}

function i18n(obj) {
  const entries = Object.entries(obj ?? {});
  if (!entries.length) return h('span.muted', {}, '—');
  return h('dl.i18n', {}, entries.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? h('span.muted', {}, 'null'))]));
}

function images(codes, imgs) {
  const urls = [...new Set(codes.flatMap((c) => imgs[c] ?? []))];
  if (!urls.length) return null;
  return h('div.imgs', {}, urls.slice(0, 6).map((u) => h('img', { src: u, alt: '', loading: 'lazy' })));
}

export function jurisdictionsView(jurs, imgs, onEdit = null) {
  const entries = Object.entries(jurs ?? {});
  if (!entries.length) return h('p.muted.small', {}, t('No country uses this design yet.'));
  return h('div.jurs', {}, entries.map(([key, j]) => {
    const codes = [...new Set(Object.values(j.languages ?? {}).flatMap((l) => l.codes))];
    return h('details.jur', { open: entries.length <= 4 },
      h('summary', {},
        h('strong', {}, key.replace(/_/g, ' ')), ' ', h('code.cc', {}, j.countryCode), ' ',
        h('span.muted', {}, codes.slice(0, 6).join(', '), codes.length > 6 ? ` +${codes.length - 6}` : ''),
        j.leftHandTrafficVariant ? h('span.badge', {}, t('left-hand traffic')) : null,
        onEdit ? h('button.btn.small.edit-country', { type: 'button', onclick: (e) => { e.preventDefault(); onEdit(key); } }, `✎ ${t('Edit')}`) : null),
      h('div.jur-body', {},
        images(codes, imgs),
        h('table.compact', {},
          h('thead', {}, h('tr', {}, h('th', {}, t('Lang')), h('th', {}, t('Code')), h('th', {}, t('All codes')), h('th', {}, t('Text')), h('th', {}, t('Description')))),
          h('tbody', {}, Object.entries(j.languages ?? {}).map(([lk, l]) => h('tr', {},
            h('td', {}, lk), h('td', {}, h('code', {}, l.code)), h('td', {}, l.codes.join(', ')),
            h('td', {}, l.text ?? '—'), h('td', {}, l.description ?? '—'))))),
        j.parameters && Object.keys(j.parameters).length
          ? h('div', {}, h('h5', {}, t('Parameters')), h('ul.plain', {}, Object.entries(j.parameters).map(([pk, p]) =>
            h('li', {}, h('strong', {}, pk), ` (${p.type}${p.unit ? `, ${p.unit}` : ''}): `, p.values.join(', '), p.description ? h('span.muted', {}, ` — ${p.description}`) : null))))
          : null,
        h('h5', {}, t('Additional panels')), panelsView(j.additional),
        h('h5', {}, t('OpenStreetMap')), h('p', {}, j.osm?.traffic_sign?.length ? j.osm.traffic_sign.map((t) => h('code.chip', {}, `traffic_sign=${t}`)) : h('span.muted', {}, '—')),
        j.sources?.length ? h('details.sources', {}, h('summary', {}, t('Sources ({n})', { n: j.sources.length })),
          h('ul.plain.small', {}, j.sources.map((s) => h('li', {}, s.file, s.url ? [' — ', h('a', { href: s.url, rel: 'noopener noreferrer', target: '_blank' }, t('link'))] : null)))) : null));
  }));
}

export function designCard(d, i, imgs, onEdit = null) {
  const props = ['shape', 'background_color', 'border_color', 'symbol_color', 'band', 'band_color', 'prohibition_bar', 'bar_continuity', 'model', 'legacyModel'];
  return h('article.design', {},
    h('header', {}, h('h4', {}, t('Design {n}', { n: i + 1 })),
      h('div.chips', {}, props.filter((p) => d[p] !== undefined && d[p] !== null && d[p] !== 'none').map((p) => h('span.chip', { title: p }, `${p.replace(/_/g, ' ')}: ${d[p]}`)))),
    h('div.kvs', {},
      kv('Versions', d.versions.join(', ') || '—'),
      kv('Legacy references', d.legacyReferences.join(', ') || '—'),
      kv('Mirrored', d.mirrored), kv('To be added', d.toBeAdded), kv('Wikidata', d.wikidata)),
    d.notes?.length ? h('ul.notes', {}, d.notes.map((n) => h('li', {}, n))) : null,
    jurisdictionsView(d.jurisdictions, imgs, onEdit));
}

export async function viewSign(ref) {
  const [s, voc] = await Promise.all([get(signPath(ref)), vocab()]);
  const d = s.data;
  const cat = d.category.split('-').at(-1);

  const actions = h('div.actions', {},
    h('a.btn', { href: signHref(ref, '/history') }, t('History')),
    h('a.btn', { href: `#/print?ref=${encodeURIComponent(ref)}` }, 'PDF'),
    session.user && !s.deleted ? h('a.btn.primary', { href: signHref(ref, '/edit') }, t('Edit')) : null,
    !session.user ? h('a.btn', { href: '#/login' }, t('Sign in to edit')) : null,
    can('moderator') && !s.deleted ? h('button.btn.danger', {
      type: 'button',
      onclick: async () => {
        const comment = await confirmDialog(t('Delete {ref}? It can be restored from its history.', { ref }), { input: true, placeholder: t('Reason') });
        if (comment === null) return;
        try {
          await del(signPath(ref), { version: s.version, comment });
          toast(t('Sign deleted.'));
          navigate(signHref(ref));
        } catch (err) { toast(err.message, 'error'); }
      },
    }, t('Delete')) : null,
    can('moderator') && s.deleted ? h('button.btn.primary', {
      type: 'button',
      onclick: async () => {
        try {
          await post(`${signPath(ref)}/restore`, { version: s.version });
          toast(t('Sign restored.'));
          navigate(signHref(ref));
        } catch (err) { toast(err.message, 'error'); }
      },
    }, t('Restore')) : null,
    h('button.btn', {
      type: 'button',
      onclick: () => {
        const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `${ref.replace(/[^\w.-]+/g, '_')}.json` });
        a.click();
        URL.revokeObjectURL(a.href);
      },
    }, t('Download JSON')));

  const firstImg = s.vienna_images?.[0]?.url ?? Object.values(s.images)[0]?.[0];
  const reopen = () => navigate(signHref(ref));
  const onEdit = session.user && !s.deleted ? (key) => openCountryEditor(ref, key, { onSaved: reopen }).catch((err) => toast(err.message, 'error')) : null;
  const usedCountries = new Set(d.officialSign.designs.flatMap((x) => Object.keys(x.jurisdictions)));
  return h('article.page.sign', { dataset: { cat } },
    s.deleted ? h('div.banner.warn', {}, t('This sign has been deleted. Moderators can restore it.')) : null,
    h('div.sign-head', {},
      firstImg ? h('img.hero-img', { src: firstImg, alt: '' }) : null,
      h('div', {},
        h('p.crumbs', {}, h('a', { href: '#/' }, t('Signs')), ' / ', h('a', { href: `#/signs?category=${encodeURIComponent(d.category)}` }, `${d.category} — ${t(voc.categoryNames[cat] ?? '')}`)),
        h('h1', {}, displayName(d.name) || ref),
        h('p', {}, h('code.ref.big', {}, ref), ' ', h('span.muted.small', {}, t('version {v} · updated {d}', { v: s.version, d: fmtDate(s.updated_at) }) + (s.updated_by ? t(' by {name}', { name: s.updated_by.display_name }) : ''))),
        actions)),
    s.vienna_images?.length ? h('section.box', {},
      h('h2', {}, t('Official models (Vienna Convention, 2026 amendment)')),
      h('div.official', {}, s.vienna_images.map((im) => h('figure', {},
        h('img', { src: im.url, alt: im.name, loading: 'lazy' }),
        h('figcaption', {},
          h('strong', {}, im.variant ? im.variant : t('Main model')),
          im.commons ? h('a.small', { href: `https://commons.wikimedia.org/wiki/${encodeURIComponent(im.commons.replace(/ /g, '_'))}`, target: '_blank', rel: 'noopener noreferrer' }, 'Commons') : null,
          im.license ? h('span.muted.small', {}, im.license) : null)))),
      h('p.small.muted', {}, t('Variants: V1, V2… = other permitted colours; -1, -2, -a… = other permitted models or symbols.'))) : null,
    h('section.box', {},
      h('h2', {}, t('General')),
      h('div.grid2', {},
        h('div', {}, h('h5', {}, t('Name')), i18n(d.name)),
        h('div', {}, h('h5', {}, t('Description')), i18n(d.description))),
      h('div.kvs', {},
        kv('Category', d.category), kv('Category name', d.categoryName),
        kv('Legacy references', d.legacyReferences.join(', ') || '—'),
        kv('Symbol may be reversed', d.symbolMayBeReversed), kv('Wikidata', d.wikidata), kv('Note', d.note))),
    d.osm ? h('section.box', {},
      h('h2', {}, t('OpenStreetMap')),
      h('div.kvs', {}, kv('Generic traffic_sign', d.osm.traffic_sign_generic)),
      d.osm.implied_tags ? h('p', {}, Object.entries(d.osm.implied_tags).map(([k, v]) => h('code.chip', {}, `${k}=${v}`))) : h('p.muted.small', {}, t('No implied tags.'))) : null,
    h('section.box', {}, h('h2', {}, t('Additional panels (Convention level)')), panelsView(d.officialSign.additional)),
    h('section', {},
      h('div.row.between', {},
        h('h2', {}, t('Designs ({n})', { n: d.officialSign.designs.length })),
        onEdit ? h('button.btn.primary', {
          type: 'button',
          onclick: async () => pickCountryThenEdit(ref, usedCountries, await countries(), { onSaved: reopen }),
        }, `+ ${t('Add a country')}`) : null),
      d.officialSign.designs.map((x, i) => designCard(x, i, s.images, onEdit))),
    d.relatedSigns?.length ? h('section', {},
      h('h2', {}, t('Related signs ({n})', { n: d.relatedSigns.length })),
      d.relatedSigns.map((r) => h('article.design', {},
        h('header', {}, h('h4', {}, displayName(r.name)), h('code', {}, r.reference)),
        h('div.grid2', {}, h('div', {}, h('h5', {}, t('Description')), i18n(r.description)),
          h('div.kvs', {}, ['shape', 'background_color', 'border_color', 'symbol_color', 'background', 'border', 'mirrored', 'toBeAdded', 'wikidata'].map((k) => kv(k, r[k])))),
        jurisdictionsView(r.jurisdictions, s.images)))) : null);
}
