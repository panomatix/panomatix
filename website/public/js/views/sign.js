// Sign page: the sign and its ID; everything else behind "More information".
// Below, the designs and the related signs as tabs; in each tab, one tile per national sign
// with three actions: Info, Move, Edit.
import { can, countries, del, get, post, put, session, signPath, vocab } from '../api.js';
import { add, confirmDialog, flag, fmtDate, h, signHref, toast } from '../dom.js';
import { currentPath, navigate } from '../app.js';
import { displayName } from './list.js';
import { addUnit, codesOf, mainCode, openMoveDialog, openUnitEditor, openUnitInfo, panelChip, panelCount, panelPicsOf, panelStack, pretty, removeUnit, signWithPanels } from './unit.js';
import { lang, t } from '../i18n.js';
import { readOnlyBanner } from '../widgets.js';
import { EMPTY_WIKIDATA, wikidataField } from './wikidata.js';
import { icon } from '../icons.js';

const POS_LABEL = { top: 'Above the sign', bottom: 'Below the sign', left: 'Left of the sign', right: 'Right of the sign' };
const DESIGN_PROPS = ['shape', 'background_color', 'border_color', 'symbol_color', 'band', 'band_color', 'prohibition_bar', 'bar_continuity', 'model', 'legacyModel'];
const isRef = (r) => /^(VIENNA|VIENNA2006|OTHER):/.test(r);

/** A reference to another sign or a national code, with its image when one exists (used by other views too). */
export function refChip(ref) {
  return panelChip(ref);
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
  return h('div.kv', {}, h('span.k', {}, t(label)), h('span.v', {}, value === null ? h('span.muted', {}, '—') : value instanceof Node ? value : typeof value === 'boolean' ? t(value ? 'yes' : 'no') : String(value)));
}

function i18n(obj) {
  const entries = Object.entries(obj ?? {});
  if (!entries.length) return h('span.muted', {}, '—');
  return h('dl.i18n', {}, entries.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? h('span.muted', {}, '—'))]));
}

/** Short text of the labels an official image carries: "triangle · white · border red · symbol black". */
function labelsText(l) {
  return [l.shape, l.background_color, l.border_color && t('border {c}', { c: l.border_color }), l.symbol_color && t('symbol {c}', { c: l.symbol_color }),
    l.band && l.band !== 'none' ? `${l.band}${l.band_color ? ` (${l.band_color})` : ''}` : null,
    l.prohibition_bar ? `${l.prohibition_bar}${l.bar_continuity ? ` (${l.bar_continuity})` : ''}` : null]
    .filter(Boolean).map((x) => x.replace(/_/g, ' ')).join(' · ');
}

/** Picture of the first country (in the order of the tiles) that has one: its main code first, then its variants. */
const firstImage = (jurs, imgs) => {
  const sorted = Object.entries(jurs ?? {}).sort((a, b) => pretty(a[0]).localeCompare(pretty(b[0])));
  for (const [, j] of sorted) for (const c of [mainCode(j), ...codesOf(j)]) if (imgs[c]?.length) return imgs[c][0];
  return null;
};

// --- "More information" --------------------------------------------------------------------

function openSignInfo(s, voc, { selectTab }) {
  const d = s.data;
  const ref = s.data.reference;
  const cat = d.category.split('-').at(-1);
  const dlg = h('dialog.dialog.wide', { 'aria-label': ref });
  const close = () => { dlg.close(); dlg.remove(); };
  const actions = h('div.actions', {},
    h('a.btn', { href: signHref(ref, '/history'), onclick: close }, t('History')),
    h('button.btn', {
      type: 'button',
      onclick: () => {
        const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `${ref.replace(/[^\w.-]+/g, '_')}.json` });
        a.click();
        URL.revokeObjectURL(a.href);
      },
    }, t('Download JSON')),
    session.user && !s.deleted ? h('a.btn', { href: signHref(ref, '/edit'), onclick: close }, t('Full editor (JSON)')) : null,
    can('moderator') && !s.deleted ? h('button.btn.danger', {
      type: 'button',
      onclick: async () => {
        const comment = await confirmDialog(t('Delete {ref}? It can be restored from its history.', { ref }), { input: true, placeholder: t('Reason') });
        if (comment === null) return;
        try {
          await del(signPath(ref), { version: s.version, comment });
          toast(t('Sign deleted.'));
          close();
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
          close();
          navigate(signHref(ref));
        } catch (err) { toast(err.message, 'error'); }
      },
    }, t('Restore')) : null);

  add(dlg,
    h('header.modal-head', {},
      h('div', {},
        h('p.crumbs', {}, `${d.category} — ${t(voc.categoryNames[cat] ?? '')}`),
        h('h2', {}, displayName(d.name) || ref, ' ', h('code.ref', {}, ref)),
        h('p.muted.small', {}, t('version {v} · updated {d}', { v: s.version, d: fmtDate(s.updated_at) }) + (s.updated_by ? t(' by {name}', { name: s.updated_by.display_name }) : ''))),
      h('button.btn.close', { type: 'button', 'aria-label': t('Close'), onclick: close }, icon('close'))),
    actions,
    h('section.box', {},
      h('h3', {}, t('General')),
      h('div.grid2', {},
        h('div', {}, h('h5', {}, t('Name')), i18n(d.name)),
        h('div', {}, h('h5', {}, t('Description')), i18n(d.description))),
      h('div.kvs', {},
        kv('Category', d.category), kv('Category name', d.categoryName),
        kv('Legacy references', d.legacyReferences.join(', ') || '—'),
        kv('Symbol may be reversed', d.symbolMayBeReversed), kv('Wikidata', /^Q[1-9]/.test(d.wikidata ?? '') ? h('a', { href: `https://www.wikidata.org/wiki/${d.wikidata}`, target: '_blank', rel: 'noopener noreferrer' }, d.wikidata) : '—'), kv('Note', d.note))),
    d.osm ? h('section.box', {},
      h('h3', {}, t('OpenStreetMap')),
      h('div.kvs', {}, kv('Generic traffic_sign', d.osm.traffic_sign_generic)),
      d.osm.implied_tags ? h('p', {}, Object.entries(d.osm.implied_tags).map(([k, v]) => h('code.chip', {}, `${k}=${v}`))) : h('p.muted.small', {}, t('No implied tags.'))) : null,
    h('section.box', {}, h('h3', {}, t('Additional panels (Convention level)')), panelStack(d.officialSign.additional, s.vienna_images?.[0]?.url)),
    s.vienna_images?.length ? h('section.box', {},
      h('h3', {}, t('Official models (Vienna Convention, 2026 amendment)')),
      h('div.official', {}, s.vienna_images.map((im) => h('figure', {},
        h('img', { src: im.url, alt: im.name, loading: 'lazy' }),
        h('figcaption', {},
          h('span.small', {}, labelsText(im.labels)),
          im.designs.length
            ? h('span.small', {}, im.designs.map((n, k) => [k ? ', ' : '', h('button.linkish', { type: 'button', onclick: () => { close(); selectTab(`d${n}`, true); } }, t('Design {n}', { n: n + 1 }))]))
            : h('span.badge.warn', { title: t('No design of this sign carries these labels in the database.') }, t('no matching design')),
          im.commons ? h('a.small', { href: `https://commons.wikimedia.org/wiki/${encodeURIComponent(im.commons.replace(/ /g, '_'))}`, target: '_blank', rel: 'noopener noreferrer' }, 'Commons') : null,
          im.license ? h('span.muted.small', {}, im.license) : null))))) : null);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
}

// --- national sign tiles -------------------------------------------------------------------

/** The values a national sign shows (speed, width, weight…) with their unit: "50 · 60 · 80 km/h",
 *  "4–10 t" for a long list. Parameters without a known value are left out. */
function parameterLine(parameters) {
  const fmt = (v) => (typeof v === 'number' ? v.toLocaleString(lang) : v);
  const parts = Object.entries(parameters ?? {}).filter(([, p]) => p.values?.length).map(([key, p]) => {
    const nums = p.values.every((v) => typeof v === 'number');
    const shown = nums && p.values.length > 3 ? `${fmt(Math.min(...p.values))}–${fmt(Math.max(...p.values))}` : p.values.map(fmt).join(' · ');
    return h('span.param', { title: `${p.description ?? key}` }, shown, p.unit ? ` ${p.unit}` : '');
  });
  return parts.length ? h('span.tile-params', {}, parts) : null;
}

function unitTile(ctx, loc, where, jurKey, jur, fallbackProps) {
  const code = mainCode(jur);
  const img = codesOf(jur).map((c) => ctx.images[c]?.[0]).find(Boolean);
  const others = codesOf(jur).length - 1;
  const panels = panelCount(jur.additional);
  const editable = ctx.editable;
  const reload = () => navigate(`#${currentPath()}`);
  return h('article.tile', { dataset: { search: `${jurKey} ${jur.countryCode} ${codesOf(jur).join(' ')} ${Object.values(jur.languages ?? {}).map((l) => l.text ?? '').join(' ')}`.toLowerCase() } },
    h('div.tile-img', {}, img ? signWithPanels(h('img', { src: img, alt: code, loading: 'lazy' }), panelPicsOf(jur.additional, ctx.panelImages)) : null),
    h('div.tile-id', {},
      h('code', { title: code }, code || '—'),
      h('span.tile-country', {}, flag(jur.countryCode, { title: jur.countryCode.toUpperCase() }), ' ', pretty(jurKey)),
      h('span.tile-badges', {},
        others > 0 ? h('span.badge', { title: codesOf(jur).join(', ') }, `+${others}`) : null,
        panels ? h('span.badge', { title: t('{n} additional panel(s)', { n: panels }) }, `▭ ${panels}`) : null,
        jur.leftHandTrafficVariant ? h('span.badge', { title: t('left-hand traffic') }, 'LHT') : null),
      parameterLine(jur.parameters)),
    h('div.tile-actions', {},
      h('button.btn.small', {
        type: 'button', title: t('Info'),
        onclick: () => openUnitInfo({
          reference: ctx.ref, jurKey, jur, images: ctx.images, where,
          actions: editable ? [
            h('button.btn', { type: 'button', onclick: (e) => { e.target.closest('dialog').close(); e.target.closest('dialog').remove(); openMoveDialog(ctx.ref, loc, jurKey, { onMoved: reload }).catch((err) => toast(err.message, 'error')); } }, t('Move')),
            h('button.btn.primary', { type: 'button', onclick: (e) => { e.target.closest('dialog').close(); e.target.closest('dialog').remove(); openUnitEditor(ctx.ref, loc, jurKey, { onSaved: reload }).catch((err) => toast(err.message, 'error')); } }, t('Edit')),
          ] : null,
        }),
      }, icon('info'), t('Info')),
      // Visitors only read: the editing buttons are left out.
      editable ? [
        h('button.btn.small', {
          type: 'button', title: t('Move to another design, related sign or sign'),
          onclick: () => openMoveDialog(ctx.ref, loc, jurKey, { onMoved: reload }).catch((err) => toast(err.message, 'error')),
        }, icon('move'), t('Move')),
        h('button.btn.small.primary', {
          type: 'button', title: t('Edit this national sign and its panels'),
          onclick: () => openUnitEditor(ctx.ref, loc, jurKey, { onSaved: reload }).catch((err) => toast(err.message, 'error')),
        }, icon('edit'), t('Edit')),
        h('button.btn.small.danger', {
          type: 'button', title: t('Remove this national sign from this sign'),
          onclick: async () => {
            try { if (await removeUnit(ctx.ref, loc, jurKey)) reload(); } catch (err) { toast(err.message, 'error'); }
          },
        }, icon('trash'), t('Remove')),
      ] : null));
}

function tilesGrid(ctx, loc, where, jurs, props) {
  const entries = Object.entries(jurs ?? {}).sort((a, b) => pretty(a[0]).localeCompare(pretty(b[0])));
  const filter = entries.length > 12 ? h('input.tile-filter', { type: 'search', placeholder: t('Filter: country or code…') }) : null;
  const grid = h('div.tiles', {},
    entries.map(([k, j]) => unitTile(ctx, loc, where, k, j, props)),
    ctx.editable ? h('button.tile.tile-add', {
      type: 'button',
      onclick: async () => addUnit(ctx.ref, loc, new Set(Object.keys(jurs ?? {})), await countries(), { onSaved: () => navigate(`#${currentPath()}`) }).catch((err) => toast(err.message, 'error')),
    }, h('span.plus', {}, icon('plus')), t('Add a national sign')) : null);
  filter?.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    grid.querySelectorAll('article.tile').forEach((el) => { el.hidden = Boolean(q) && !el.dataset.search.includes(q); });
  });
  return [
    h('div.row.between.tiles-head', {}, h('h4', {}, t('National signs ({n})', { n: entries.length })), filter),
    entries.length || ctx.editable ? grid : h('p.muted.small', {}, t('No country uses this yet.')),
  ];
}

// --- official models ---------------------------------------------------------------------------

/** Every official picture of the Convention for this sign, under the big one: a click shows it in
 *  place of the big picture; the designs it belongs to are named (or flagged when none matches). */
function officialStrip(ctx, heroImg) {
  // The pictures matching a design already show in the "Designs" tabs below: only those matching no
  // design of the database are listed here, so they are not lost (their colours differ from every design).
  const unmatched = ctx.official.filter((im) => !im.designs.length);
  if (!unmatched.length) return null;
  const note = h('span.badge.warn', { title: t('No design of this sign carries these labels in the database.') }, t('no matching design'));
  // The big picture is the only one: a note under it is enough.
  if (unmatched.length === 1 && ctx.official[0] === unmatched[0]) return h('p.small', {}, note);
  const strip = h('div.official-strip', { role: 'group', 'aria-label': t('Official models (Vienna Convention, 2026 amendment)') },
    unmatched.map((im) => {
      const btn = h('button.official-thumb', {
        type: 'button',
        'aria-pressed': String(ctx.official[0] === im),
        title: labelsText(im.labels),
        onclick: () => {
          heroImg.src = im.url;
          heroImg.title = labelsText(im.labels);
          strip.querySelectorAll('.official-thumb').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        },
      }, h('img', { src: im.url, alt: im.name, loading: 'lazy' }));
      return h('figure', {}, btn, h('figcaption.small', {}, note.cloneNode(true)));
    }));
  return strip;
}

// --- Wikidata --------------------------------------------------------------------------------

/** Wikidata field of the sign (where = null), of design i ('d', i) or of related sign i ('r', i).
 *  Saving sends the whole entry with the version that was read, so a concurrent edit is detected. */
function wikidataOf(ctx, where = null, i = 0) {
  const target = (data) => (where === 'd' ? data.officialSign.designs[i] : where === 'r' ? data.relatedSigns[i] : data);
  const what = where === 'd' ? `design ${i + 1}` : where === 'r' ? `related sign ${i + 1}` : 'sign'; // history comments stay in English
  return wikidataField({
    value: target(ctx.sign.data).wikidata,
    editable: ctx.editable,
    onSave: async (id) => {
      const data = structuredClone(ctx.sign.data);
      const obj = target(data);
      if (id) obj.wikidata = id;
      else if (where === 'r') delete obj.wikidata; // optional on related signs
      else obj.wikidata = EMPTY_WIKIDATA;
      const comment = id ? `Wikidata (${what}): ${id}` : `Wikidata (${what}) removed`;
      try {
        await put(signPath(ctx.ref), { data, version: ctx.sign.version, comment });
      } catch (err) {
        if (err.status === 409) throw new Error(t('Someone else changed this sign meanwhile: reload the page and try again.'));
        throw err;
      }
      toast(t('Saved'));
      navigate(`#${currentPath()}`);
    },
  });
}

// --- tabs ------------------------------------------------------------------------------------

function designPanel(ctx, d, i) {
  const official = ctx.official.filter((im) => im.designs.includes(i));
  const national = official.length ? null : firstImage(d.jurisdictions, ctx.images);
  return [
    h('div.tabpanel-head', {},
      official.length || national ? h('div.tab-models', {}, official.length
        ? official.map((im) => h('img', { src: im.url, alt: im.name, title: t('Official model (Vienna Convention)') }))
        : h('img', { src: national, alt: '', title: t('No official model: picture of the first country using this design') })) : null,
      h('div', {},
        h('h3', {}, t('Design {n}', { n: i + 1 })),
        h('div.chips', {}, DESIGN_PROPS.filter((p) => d[p] !== undefined && d[p] !== null && d[p] !== 'none').map((p) => h('span.chip', { title: p }, `${p.replace(/_/g, ' ')}: ${d[p]}`))),
        h('p.small.muted', {},
          t('Versions'), ': ', d.versions.join(', ') || '—', ' · ', t('Legacy references'), ': ', d.legacyReferences.join(', ') || '—',
          d.mirrored ? ` · ${t('mirrored')}` : ''),
        wikidataOf(ctx, 'd', i),
        d.notes?.length ? h('ul.notes', {}, d.notes.map((n) => h('li', {}, n))) : null)),
    tilesGrid(ctx, `d${i}`, t('Design {n}', { n: i + 1 }), d.jurisdictions, d),
  ];
}

function relatedPanel(ctx, r, i) {
  const props = { shape: r.shape, background_color: r.background_color ?? r.background, border_color: r.border_color ?? r.border };
  return [
    h('div.tabpanel-head', {},
      firstImage(r.jurisdictions, ctx.images) ? h('div.tab-models', {}, h('img', { src: firstImage(r.jurisdictions, ctx.images), alt: '' })) : null,
      h('div', {},
        h('h3', {}, displayName(r.name) || r.reference, ' ', isRef(r.reference) ? h('a', { href: signHref(r.reference) }, h('code.ref', {}, r.reference)) : h('code.ref', {}, r.reference)),
        h('div.chips', {}, ['shape', 'background_color', 'border_color', 'symbol_color', 'background', 'border'].filter((p) => r[p] !== undefined && r[p] !== null).map((p) => h('span.chip', { title: p }, `${p.replace(/_/g, ' ')}: ${r[p]}`))),
        r.description ? h('p.small', {}, Object.values(r.description)[0] ?? '') : null,
        wikidataOf(ctx, 'r', i))),
    tilesGrid(ctx, `r${i}`, `${t('Related sign')} · ${displayName(r.name) || r.reference}`, r.jurisdictions, props),
  ];
}

/** Tabs: a strip of thumbnails; arrow keys move between them; the choice is kept in the URL (?tab=d2). */
function tabs(ctx, items, { label, empty }) {
  if (!items.length) return h('p.muted.small', {}, empty);
  const panel = h('div.tabpanel', { role: 'tabpanel' });
  const strip = h('div.tabstrip', { role: 'tablist', 'aria-label': label });
  const buttons = items.map((it) => h('button.tabthumb', {
    type: 'button', role: 'tab', id: `tab-${it.key}`, 'aria-selected': 'false', tabindex: '-1',
    title: Object.entries(it.props ?? {}).filter(([k, v]) => v && v !== 'none' && !['jurisdictions', 'versions', 'legacyReferences', 'notes', 'wikidata', 'toBeAdded', 'mirrored', 'legacyModel'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('\n'),
    onclick: () => select(it.key, false),
    onkeydown: (e) => {
      const i = items.indexOf(it);
      const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
      if (j === null) return;
      e.preventDefault();
      const next = items[(j + items.length) % items.length];
      select(next.key, false);
      strip.querySelector(`#tab-${next.key}`)?.focus();
    },
  },
  h('span.tt-img', {}, it.image ? h('img', { src: it.image, alt: '' }) : null),
  h('span.tt-label', {}, it.label),
  h('span.tt-count', {}, t('{n} countries', { n: it.count }))));
  strip.append(...buttons);
  function select(key, scroll, initial = false) {
    const it = items.find((x) => x.key === key) ?? items[0];
    buttons.forEach((b, i) => {
      const on = items[i] === it;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `tab-${it.key}`);
    panel.replaceChildren(...[it.render()].flat(Infinity).filter((x) => x && typeof x === "object"));
    if (!initial) history.replaceState(null, '', `${signHref(ctx.ref)}?tab=${it.key}`);
    if (scroll) strip.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  ctx.selectors.push({ keys: new Set(items.map((x) => x.key)), select });
  select(items.some((x) => x.key === ctx.wanted) ? ctx.wanted : items[0].key, false, true);
  return h('div.tabs-box', {}, strip, panel);
}

export async function viewSign(ref) {
  const [s, voc] = await Promise.all([get(signPath(ref)), vocab()]);
  const d = s.data;
  const wanted = new URLSearchParams(currentPath().split('?')[1] ?? '').get('tab');
  const ctx = { ref, sign: s, images: s.images, panelImages: s.panel_images ?? {}, official: s.vienna_images ?? [], editable: Boolean(session.user) && !s.deleted, wanted, selectors: [] };
  const selectTab = (key, scroll) => ctx.selectors.find((x) => x.keys.has(key))?.select(key, scroll);
  const designs = d.officialSign.designs;
  const hero = ctx.official[0]?.url ?? firstImage(designs[0]?.jurisdictions, s.images) ?? Object.values(s.images)[0]?.[0];
  const heroImg = h('img.hero-img', { src: hero, alt: displayName(d.name) || ref, title: displayName(d.name) });

  const designItems = designs.map((x, i) => ({
    key: `d${i}`, label: t('Design {n}', { n: i + 1 }), props: x, count: Object.keys(x.jurisdictions ?? {}).length,
    image: ctx.official.find((im) => im.designs.includes(i))?.url ?? firstImage(x.jurisdictions, s.images),
    render: () => designPanel(ctx, x, i),
  }));
  const relatedItems = (d.relatedSigns ?? []).map((r, i) => ({
    key: `r${i}`, label: displayName(r.name) || r.reference, props: { shape: r.shape, background_color: r.background_color ?? r.background, border_color: r.border_color ?? r.border },
    count: Object.keys(r.jurisdictions ?? {}).length, image: firstImage(r.jurisdictions, s.images),
    render: () => relatedPanel(ctx, r, i),
  }));

  return h('article.page.sign', { dataset: { cat: d.category.split('-').at(-1) } },
    s.deleted ? h('div.banner.warn', {}, t('This sign has been deleted. Moderators can restore it.')) : null,
    readOnlyBanner(),
    h('header.sign-hero', {},
      hero ? heroImg : null,
      h('div.hero-id', {},
        h('code.ref.big', {}, ref),
        wikidataOf(ctx),
        officialStrip(ctx, heroImg),
        h('button.btn.primary', { type: 'button', onclick: () => openSignInfo(s, voc, { selectTab }) }, icon('info'), t('More information')))),
    h('section.sign-section', {},
      h('h2', {}, t('Designs ({n})', { n: designs.length })),
      tabs(ctx, designItems, { label: t('Designs'), empty: t('No design.') })),
    h('section.sign-section', {},
      h('h2', {}, t('Related signs ({n})', { n: relatedItems.length })),
      h('p.small.muted', {}, t('National signs attached to this sign without being one of its designs (another symbol, a local variant…).')),
      tabs(ctx, relatedItems, { label: t('Related signs'), empty: t('No related sign.') })));
}
