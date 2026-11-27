// Sign editor: a structured form covering every field of the schema, plus a raw JSON mode.
import { ApiError, api, countries, get, post, put, session, signPath, vocab } from '../api.js';
import { block, h, signHref, toast } from '../dom.js';
import { navigate, setLeaveGuard } from '../app.js';
import { t } from '../i18n.js';
import { bool, field, listEditor, mapEditor, onAnyChange, select, strList, sub, text, uploadedMessage } from '../widgets.js';

const LANG_KEY = '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$';
const POSITIONS = [['top', 'Panels above'], ['bottom', 'Panels below'], ['left', 'Panels on the left'], ['right', 'Panels on the right']];

const newAdditional = () => ({ top: [], bottom: [] });
const newDesign = () => ({
  shape: null, background_color: null, border_color: null, symbol_color: null,
  versions: [], legacyReferences: [], mirrored: false, wikidata: 'QXXXXXXX', toBeAdded: true, jurisdictions: {},
});
const newJurisdiction = (cc) => ({ countryCode: cc, languages: {}, additional: newAdditional(), osm: { traffic_sign: [] } });
const newLanguage = () => ({ code: '', codes: [], text: null, description: null });
const newSign = () => ({
  reference: 'OTHER:', category: 'OTHER-SD', name: { en: '' }, description: { en: null }, legacyReferences: [], wikidata: 'QXXXXXXX',
  note: 'National sign without a Vienna 2023 equivalent.',
  officialSign: { designs: [newDesign()], additional: newAdditional() }, relatedSigns: [],
});

// --- panels (panonceaux) -----------------------------------------------------------------

export function panelsEditor(additional, path) {
  return h('div.panels', {}, POSITIONS.map(([pos, label]) => {
    const present = pos in additional;
    return block((redraw) => {
      if (!(pos in additional)) {
        return h('button.btn.small', { type: 'button', onclick: () => { additional[pos] = []; redraw(); } }, `+ ${t(label)}`);
      }
      const slots = additional[pos];
      return [
        h('h5', {}, t(label), pos === 'left' || pos === 'right'
          ? h('button.btn.small.danger', { type: 'button', title: t('Remove'), disabled: slots.length > 0, onclick: () => { delete additional[pos]; redraw(); } }, '×') : null),
        block((redrawSlots) => [
          slots.map((slot, i) => h('div.slot', { dataset: { path: sub(sub(path, pos), i) } },
            h('div.slot-head', {},
              field('Index', h('input', {
                type: 'number', min: 1, max: 20, value: slot.index, class: 'narrow', dataset: { path: sub(sub(sub(path, pos), i), 'index') },
                oninput: (e) => { slot.index = Number(e.target.value); },
              }), { help: '1 = closest to the sign' }),
              h('button.btn.small.danger', { type: 'button', title: t('Remove'), onclick: () => { slots.splice(i, 1); redrawSlots(); } }, '×')),
            field('Admissible panels', strList(slot.reference, { path: sub(sub(sub(path, pos), i), 'reference'), placeholder: 'Add a panel', autocomplete: true }), { wide: true }))),
          h('button.btn.small', {
            type: 'button',
            onclick: () => { slots.push({ index: Math.max(0, ...slots.map((s) => s.index || 0)) + 1, reference: [] }); redrawSlots(); },
          }, `+ ${t('Add a slot')}`),
        ]),
      ];
    }, 'div', { class: `panel-pos${present ? '' : ' absent'}`, dataset: { path: sub(path, pos) } });
  }));
}

// --- jurisdictions ------------------------------------------------------------------------

export function languageEditor(langs, k, path) {
  const l = langs[k];
  let codesBox = strList(l.codes, { path: sub(path, 'codes'), placeholder: 'Add', autocomplete: true });
  return h('div.grid2', {},
    field('Main code', text(l, 'code', {
      path, mono: true, placeholder: 'fr:B14',
      onchange: (v) => {
        // keep `code` inside `codes`
        if (v && !l.codes.includes(v)) {
          l.codes.unshift(v);
          codesBox.replaceWith(codesBox = strList(l.codes, { path: sub(path, 'codes'), autocomplete: true }));
        }
      },
    })),
    field('Codes', codesBox),
    field('Text', text(l, 'text', { path, nullable: true })),
    field('Description', text(l, 'description', { path, nullable: true, multiline: true })));
}

export function parameterEditor(params, k, path) {
  const p = params[k];
  return h('div.grid4', {},
    field('Description', text(p, 'description', { path, nullable: true })),
    field('Type', select(p, 'type', ['number', 'string'], { path })),
    field('Unit', text(p, 'unit', { path, nullable: true, placeholder: 'km/h' })),
    field('Values', strList(p.values, { path: sub(path, 'values'), numeric: p.type === 'number' }), { wide: true }));
}

function imagesFor(jur, images, onUploaded) {
  const codes = [...new Set(Object.values(jur.languages ?? {}).flatMap((l) => l.codes))];
  if (!codes.length) return null;
  return h('div.images-edit', {}, codes.map((code) => {
    const urls = images[code] ?? [];
    const file = h('input', { type: 'file', accept: '.svg,.png,.jpg,.jpeg,.gif,.webp,image/*', class: 'visually-hidden' });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      const fd = new FormData();
      fd.append('code', code);
      fd.append('file', file.files[0]);
      try {
        const r = await api('POST', '/api/v1/images', fd, { form: true });
        (images[code] ??= []).push(r.url);
        toast(uploadedMessage(r));
        onUploaded();
      } catch (err) {
        toast(err.code === 'unknown_code' ? t('Save the sign first: the image is filed under an existing code.') : err.message, 'error');
      }
    });
    return h('figure.imgcell', {},
      urls.length ? h('img', { src: urls[0], alt: code, loading: 'lazy' }) : h('span.noimg', {}, t('no image')),
      h('figcaption', {}, h('code', {}, code)),
      h('label.btn.small', { title: t('Upload an image for {code}', { code }) }, '⬆', file));
  }));
}

function jurisdictionEditor(jurs, key, path, ctx) {
  const j = jurs[key];
  return h('div', {},
    h('div.grid3', {},
      field('Country code', text(j, 'countryCode', { path, mono: true, placeholder: 'fr' })),
      field('Left-hand traffic variant', bool(j, 'leftHandTrafficVariant', { path, optional: true }))),
    block((redraw) => imagesFor(j, ctx.images, redraw)),
    h('h5', {}, t('Languages')),
    mapEditor(j.languages, {
      path: sub(path, 'languages'), addLabel: 'Add a language', keyPlaceholder: 'Language code', keyPattern: LANG_KEY,
      newValue: () => newLanguage(), renderValue: (o, k, p) => languageEditor(o, k, p),
    }),
    h('h5', {}, t('Parameters')),
    block((redraw) => (j.parameters
      ? mapEditor(j.parameters, {
        path: sub(path, 'parameters'), addLabel: 'Add a parameter', keyPlaceholder: 'maxspeed', keyPattern: '^[a-z][a-z0-9_]{0,40}$',
        suggestions: ['maxspeed', 'minspeed', 'speed', 'weight', 'axleload', 'height', 'width', 'length', 'distance'],
        newValue: () => ({ description: null, type: 'number', unit: null, values: [] }),
        renderValue: (o, k, p) => parameterEditor(o, k, p),
      })
      : h('button.btn.small', { type: 'button', onclick: () => { j.parameters = {}; redraw(); } }, `+ ${t('Add a parameter')}`))),
    h('h5', {}, t('Additional panels')),
    panelsEditor(j.additional, sub(path, 'additional')),
    h('h5', {}, t('OSM traffic_sign values')),
    strList(j.osm.traffic_sign, { path: sub(sub(path, 'osm'), 'traffic_sign'), placeholder: 'FR:B14' }),
    h('h5', {}, t('Sources')),
    block((redraw) => (j.sources
      ? listEditor(j.sources, {
        path: sub(path, 'sources'), addLabel: 'Add a source', title: (s) => s.file || '—', collapsed: true,
        newItem: () => ({ file: '', url: null }),
        renderItem: (s, i, p) => h('div.grid2', {}, field('File', text(s, 'file', { path: p })), field('URL', text(s, 'url', { path: p, nullable: true }))),
      })
      : h('button.btn.small', { type: 'button', onclick: () => { j.sources = []; redraw(); } }, `+ ${t('Add a source')}`))));
}

function jurisdictionsEditor(jurs, path, ctx) {
  const suggestions = ctx.countries.map((c) => ({ value: c.jurisdiction, label: c.country_code }));
  return mapEditor(jurs, {
    path, addLabel: 'Add a country', keyPlaceholder: 'Country key', keyPattern: '^[a-z0-9_]{2,60}$', collapsed: true, suggestions,
    newValue: (k) => newJurisdiction(ctx.countries.find((c) => c.jurisdiction === k)?.country_code ?? ''),
    renderValue: (o, k, p) => jurisdictionEditor(o, k, p, ctx),
  });
}

// --- designs --------------------------------------------------------------------------------

function designEditor(d, path, ctx) {
  const v = ctx.voc;
  return h('div', {},
    h('div.grid4', {},
      field('Shape', select(d, 'shape', v.shape, { path })),
      field('Background colour', select(d, 'background_color', v.color, { path })),
      field('Border colour', select(d, 'border_color', v.color, { path })),
      field('Symbol colour', select(d, 'symbol_color', v.color, { path })),
      field('Band', select(d, 'band', v.band, { path, optional: true })),
      field('Band colour', select(d, 'band_color', v.color, { path, optional: true })),
      field('Prohibition bar', select(d, 'prohibition_bar', v.prohibition_bar, { path, optional: true })),
      field('Bar continuity', select(d, 'bar_continuity', v.bar_continuity, { path, optional: true })),
      field('Model', select(d, 'model', v.model, { path, optional: true })),
      field('Legacy model', select(d, 'legacyModel', v.legacyModel, { path, optional: true })),
      field('Mirrored', bool(d, 'mirrored', { path })),
      field('To be added', bool(d, 'toBeAdded', { path })),
      field('Wikidata', text(d, 'wikidata', { path, mono: true }))),
    h('div.grid2', {},
      field('Versions', h('div.checks', { dataset: { path: sub(path, 'versions') } }, v.versions.map((ver) => h('label.check', {},
        h('input', {
          type: 'checkbox', checked: d.versions.includes(ver),
          onchange: (e) => {
            d.versions = e.target.checked ? [...d.versions, ver].sort() : d.versions.filter((x) => x !== ver);
          },
        }), ver)))),
      field('Legacy references', strList(d.legacyReferences, { path: sub(path, 'legacyReferences'), placeholder: 'VIENNA:A,1a' }))),
    block((redraw) => (d.notes
      ? field('Notes', strList(d.notes, { path: sub(path, 'notes'), placeholder: 'Add a note', mono: false }), { wide: true })
      : h('button.btn.small', { type: 'button', onclick: () => { d.notes = []; redraw(); } }, `+ ${t('Add a note')}`))),
    h('h4', {}, t('Countries using this design')),
    jurisdictionsEditor(d.jurisdictions, sub(path, 'jurisdictions'), ctx));
}

function designTitle(d, i) {
  const n = Object.keys(d.jurisdictions).length;
  const bits = [d.shape, d.background_color, d.border_color && `${d.border_color} border`, d.band && d.band !== 'none' && d.band].filter(Boolean);
  return `${t('Design {n}', { n: i + 1 })} — ${bits.join(' · ') || '—'} (${n})`;
}

// --- related signs -------------------------------------------------------------------------

function relatedEditor(r, path, ctx) {
  const v = ctx.voc;
  return h('div', {},
    h('div.grid3', {},
      field('Reference', text(r, 'reference', { path, mono: true })),
      field('Wikidata', text(r, 'wikidata', { path, mono: true, optional: true })),
      field('Shape', select(r, 'shape', v.shape, { path, optional: true })),
      field('Background colour', select(r, 'background_color', v.color, { path, optional: true })),
      field('Border colour', select(r, 'border_color', v.color, { path, optional: true })),
      field('Symbol colour', select(r, 'symbol_color', v.color, { path, optional: true })),
      'background' in r ? field('Background colour (legacy key)', select(r, 'background', v.color, { path, optional: true })) : null,
      'border' in r ? field('Border colour (legacy key)', select(r, 'border', v.color, { path, optional: true })) : null,
      field('Mirrored', bool(r, 'mirrored', { path, optional: true })),
      field('To be added', bool(r, 'toBeAdded', { path, optional: true }))),
    h('div.grid2', {},
      field('Name', i18nEditor(r.name, sub(path, 'name'), ctx, false)),
      field('Description', i18nEditor(r.description, sub(path, 'description'), ctx, true))),
    h('h4', {}, t('Countries using this design')),
    jurisdictionsEditor(r.jurisdictions, sub(path, 'jurisdictions'), ctx));
}

// --- generic i18n map ---------------------------------------------------------------------

function i18nEditor(obj, path, ctx, nullable) {
  return mapEditor(obj, {
    path, inline: true, addLabel: 'Add a language', keyPlaceholder: 'Language code', keyPattern: LANG_KEY,
    suggestions: ctx.voc.nameLanguages, newValue: () => (nullable ? null : ''),
    renderValue: (o, k) => text(o, k, { path, nullable, multiline: nullable }),
  });
}

// --- the form -------------------------------------------------------------------------------

function form(entry, ctx) {
  const v = ctx.voc;
  const catOptions = [...new Set([...v.categories.map((c) => c.value), entry.category])];
  return h('div.form', {},
    h('section.box', {},
      h('h2', {}, t('General')),
      h('div.grid3', {},
        field('Reference', h('input', {
          type: 'text', value: entry.reference, class: 'mono', disabled: !ctx.isNew, dataset: { path: '$.reference' },
          oninput: (e) => { entry.reference = e.target.value.trim(); },
        }), { help: ctx.isNew ? 'VIENNA:… / VIENNA2006:… / OTHER:…' : undefined }),
        field('Category', select(entry, 'category', catOptions, { path: '$' })),
        field('Category name', text(entry, 'categoryName', { path: '$', optional: true })),
        field('Wikidata', text(entry, 'wikidata', { path: '$', mono: true })),
        field('Symbol may be reversed', bool(entry, 'symbolMayBeReversed', { path: '$', optional: true }))),
      field('Note', text(entry, 'note', { path: '$', optional: true, multiline: true }), { wide: true }),
      field('Legacy references', strList(entry.legacyReferences, { path: '$.legacyReferences', placeholder: 'VIENNA:A,1a' }), { wide: true }),
      h('div.grid2', {},
        field('Name', i18nEditor(entry.name, '$.name', ctx, false)),
        field('Description', i18nEditor(entry.description, '$.description', ctx, true)))),

    h('section.box', {},
      h('h2', {}, t('OpenStreetMap')),
      block((redraw) => {
        if (!entry.osm) return h('button.btn.small', { type: 'button', onclick: () => { entry.osm = { traffic_sign_generic: null, implied_tags: null }; redraw(); } }, `+ ${t('Include OSM block')}`);
        return [
          h('div.grid3', {},
            field('Generic traffic_sign', text(entry.osm, 'traffic_sign_generic', { path: '$.osm', nullable: true, mono: true, placeholder: 'hazard' })),
            h('div.field.endalign', {}, h('button.btn.small.danger', { type: 'button', onclick: () => { delete entry.osm; redraw(); } }, t('Remove')))),
          h('h5', {}, t('Implied tags')),
          block((redrawTags) => (entry.osm.implied_tags
            ? mapEditor(entry.osm.implied_tags, {
              path: '$.osm.implied_tags', inline: true, addLabel: 'Add a tag', keyPlaceholder: 'highway', keyPattern: '^[A-Za-z0-9_:*.-]{1,100}$',
              newValue: () => '', renderValue: (o, k, p) => text(o, k, { path: '$.osm.implied_tags', mono: true, placeholder: 'value' }),
            })
            : h('button.btn.small', { type: 'button', onclick: () => { entry.osm.implied_tags = {}; redrawTags(); } }, `+ ${t('Add a tag')}`))),
        ];
      })),

    h('section.box', {},
      h('h2', {}, t('Additional panels (Convention level)')),
      panelsEditor(entry.officialSign.additional, '$.officialSign.additional')),

    h('section', {},
      h('h2', {}, t('Designs ({n})', { n: entry.officialSign.designs.length })),
      listEditor(entry.officialSign.designs, {
        path: '$.officialSign.designs', addLabel: 'Add a design', newItem: newDesign, title: designTitle,
        collapsed: entry.officialSign.designs.length > 2,
        renderItem: (d, i, p) => designEditor(d, p, ctx),
      })),

    h('section', {},
      h('h2', {}, t('Related signs')),
      listEditor(entry.relatedSigns ??= [], {
        path: '$.relatedSigns', addLabel: 'Add a related sign', collapsed: true,
        title: (r) => `${r.reference} — ${r.name?.en ?? ''}`,
        newItem: () => ({ reference: '', name: { en: '' }, description: { en: null }, mirrored: false, toBeAdded: false, wikidata: 'QXXXXXXX', jurisdictions: {} }),
        renderItem: (r, i, p) => relatedEditor(r, p, ctx),
      })));
}

// --- page -----------------------------------------------------------------------------------

export function showErrors(box, errors, root) {
  root.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  if (!errors) {
    box.replaceChildren();
    return;
  }
  if (!errors.length) {
    box.replaceChildren(h('p.ok', {}, t('The entry is valid.')));
    return;
  }
  const locate = (path) => {
    let p = path;
    while (p) {
      const el = root.querySelector(`[data-path="${CSS.escape(p)}"]`);
      if (el) return el;
      p = p.replace(/(\.[^.[\]]+|\[\d+\])$/, '');
      if (p === '$') return null;
    }
    return null;
  };
  box.replaceChildren(h('div.errors', { role: 'alert' },
    h('p', {}, t('{n} problem(s) to fix:', { n: errors.length })),
    h('ul', {}, errors.map((e) => {
      const el = locate(e.path);
      el?.classList.add('invalid');
      return h('li', {}, h('button.linklike', {
        type: 'button',
        onclick: () => {
          if (!el) return;
          for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          (el.matches('input,select,textarea') ? el : el.querySelector('input,select,textarea'))?.focus({ preventScroll: true });
        },
      }, h('code', {}, e.path)), ' ', e.message);
    }))));
}

export async function viewEditor(ref) {
  if (!session.user) {
    navigate('#/login');
    return h('p', {}, t('You must be signed in.'));
  }
  const isNew = ref === null;
  const [voc, ctry, sign] = await Promise.all([vocab(), countries(), isNew ? null : get(signPath(ref))]);
  const original = isNew ? newSign() : sign.data;
  let entry = structuredClone(original);
  let baseline = JSON.stringify(entry);
  let version = sign?.version ?? null;
  const ctx = { voc, countries: ctry, images: sign?.images ?? {}, isNew };

  let mode = 'form';
  const errorsBox = h('div.errors-box');
  const body = h('div.editor-body');
  const jsonArea = h('textarea.json', { spellcheck: 'false', 'aria-label': 'JSON' });
  const comment = h('input', { type: 'text', maxlength: 500, placeholder: t('Summary of your change (optional)'), class: 'comment' });

  const dirty = () => JSON.stringify(entry) !== baseline;
  setLeaveGuard((silent) => !dirty() || (!silent && window.confirm(t('You have unsaved changes. Leave anyway?'))));
  onAnyChange(() => {});

  function drawForm() {
    body.replaceChildren(form(entry, ctx));
  }

  function syncFromJson() {
    try {
      entry = JSON.parse(jsonArea.value);
      return true;
    } catch (err) {
      toast(t('The JSON is not valid: {msg}', { msg: err.message }), 'error');
      return false;
    }
  }

  function setMode(m) {
    if (m === mode) return;
    if (mode === 'json' && !syncFromJson()) return;
    mode = m;
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    if (m === 'json') {
      jsonArea.value = JSON.stringify(entry, null, 2);
      body.replaceChildren(jsonArea);
    } else drawForm();
  }

  async function check() {
    if (mode === 'json' && !syncFromJson()) return null;
    const r = await post('/api/v1/validate', { data: entry });
    showErrors(errorsBox, r.errors, body);
    return r;
  }

  async function save() {
    const r = await check();
    if (!r?.valid) return;
    saveBtn.disabled = true;
    try {
      if (isNew) {
        const created = await post('/api/v1/signs', { data: entry, comment: comment.value });
        baseline = JSON.stringify(entry);
        toast(t('Created.'));
        setLeaveGuard(null);
        navigate(signHref(created.reference));
      } else {
        const updated = await put(signPath(ref), { data: entry, version, comment: comment.value });
        version = updated.version;
        entry = structuredClone(updated.data);
        baseline = JSON.stringify(entry);
        toast(updated.unchanged ? t('Nothing changed.') : t('Saved.'));
        setLeaveGuard(null);
        navigate(signHref(ref));
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'edit_conflict') {
        errorsBox.replaceChildren(h('div.errors', { role: 'alert' },
          h('p', {}, t('Someone else changed this sign since you opened it. Reload it and apply your changes again.')),
          h('a.btn', { href: signHref(ref, '/history'), target: '_blank' }, t('History')), ' ',
          h('button.btn', { type: 'button', onclick: () => { setLeaveGuard(null); navigate(signHref(ref, '/edit')); } }, t('Reload'))));
      } else if (err instanceof ApiError && err.details) {
        showErrors(errorsBox, err.details, body);
      } else toast(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  }

  const tabs = h('div.tabs', { role: 'tablist' },
    h('button', { type: 'button', role: 'tab', 'aria-selected': 'true', dataset: { mode: 'form' }, onclick: () => setMode('form') }, t('Form')),
    h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', dataset: { mode: 'json' }, onclick: () => setMode('json') }, t('JSON')));
  const saveBtn = h('button.btn.primary', { type: 'button', onclick: save }, isNew ? t('Create') : t('Save'));

  drawForm();
  return h('section.page.editor', { dataset: { cat: original.category.split('-').at(-1) } },
    h('p.crumbs', {}, h('a', { href: '#/' }, t('Signs')), ' / ', isNew ? t('New sign') : h('a', { href: signHref(ref) }, ref)),
    h('h1', {}, isNew ? t('New sign') : t('Edit {ref}', { ref })),
    h('div.toolbar', {}, tabs, comment, h('button.btn', { type: 'button', onclick: () => check().catch((e) => toast(e.message, 'error')) }, t('Check')), saveBtn),
    errorsBox,
    body);
}
