// Side panel to edit what ONE country says about ONE sign: code(s), image, design, panels, texts…
// Opened from the comparison table and from the sign page.
import { ApiError, api, get, put, signPath, vocab } from '../api.js';
import { block, confirmDialog, h, signHref, toast } from '../dom.js';
import { t } from '../i18n.js';
import { bool, field, listEditor, mapEditor, select, strList, sub, text } from '../widgets.js';
import { languageEditor, panelsEditor, parameterEditor, showErrors } from './editor.js';
import { displayName } from './list.js';

const pretty = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const LANG_KEY = '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$';
const CSS_COLOR = {
  white: '#fff', black: '#111', red: '#d52b1e', blue: '#1f5fbf', 'dark blue': '#123a7a', yellow: '#f6c400', orange: '#f28c00',
  green: '#1f8a4c', brown: '#7a4a26', grey: '#8a8d8f', 'light grey': '#c8cbcd', 'dark grey': '#4b4f52', purple: '#6a3d9a', dark: '#222',
};

function designText(p) {
  return [p.shape, p.background_color, p.border_color && `${p.border_color} ${t('border')}`].filter(Boolean).join(' · ') || t('unspecified design');
}

/** A tiny drawing of the design when no picture exists. */
function swatch(p) {
  const shape = p.shape ?? 'square';
  const el = h('span', { class: `swatch shape-${shape}` });
  // set through CSSOM: inline style attributes are blocked by the Content-Security-Policy
  el.style.setProperty('--sw-bg', CSS_COLOR[p.background_color] ?? '#eee');
  el.style.setProperty('--sw-bd', CSS_COLOR[p.border_color] ?? '#bbb');
  return el;
}

function newJurisdiction(sugg) {
  const lang = sugg.languages[0] ?? 'en';
  return {
    countryCode: sugg.country_code ?? '',
    languages: { [lang]: { code: '', codes: [], text: null, description: null } },
    additional: { top: [], bottom: [] },
    osm: { traffic_sign: [] },
  };
}

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

/**
 * Open the panel. `onSaved(view)` is called after a successful save.
 */
export async function openCountryEditor(reference, jur, { onSaved } = {}) {
  const [view, voc] = await Promise.all([get(`${signPath(reference)}/countries/${encodeURIComponent(jur)}`), vocab()]);
  const sugg = view.suggestions;
  let version = view.version;
  const designs = view.designs;
  // Working state: [{design: index | {new: props}, data}]
  const variants = structuredClone(view.variants);
  const isNew = variants.length === 0;
  if (isNew) {
    const busiest = [...designs].sort((a, b) => b.countries - a.countries)[0];
    variants.push({ design: busiest ? busiest.index : { new: { shape: null, background_color: null, border_color: null, symbol_color: null } }, data: newJurisdiction(sugg) });
  }
  const baseline = JSON.stringify(view.variants);
  const savedCodes = new Set(view.variants.flatMap((v) => Object.values(v.data.languages).flatMap((l) => l.codes)));
  const images = view.images;
  const pendingUploads = new Map(); // code -> File (uploaded after the first save)
  const prefixOf = (v) => {
    const any = Object.values(v.data.languages).find((l) => l.code)?.code;
    return any ? any.split(':')[0] : (v.data.countryCode || sugg.country_code || '').split('-')[0];
  };

  // Error paths from the server use the design index in the whole entry; new designs are appended in order.
  const pathOf = (vi) => {
    let idx = variants[vi].design;
    if (typeof idx === 'object') {
      const nth = variants.slice(0, vi + 1).filter((v) => typeof v.design === 'object').length;
      idx = designs.length + nth - 1;
    }
    return `$.officialSign.designs[${idx}].jurisdictions.${jur}`;
  };

  // --- one variant -----------------------------------------------------------------------
  function variantCard(v, vi, redrawAll) {
    const path = pathOf(vi);
    return block((redraw) => {
      const langs = v.data.languages;
      const shared = sharedCodes(langs) && !v.perLanguage;
      const first = Object.values(langs)[0];
      const mainCode = first?.code ?? '';
      const prefix = prefixOf(v);

      // Image: shows the picture of the main code; drop or pick a file to replace / add one.
      const imgUrl = images[mainCode]?.[0];
      const pending = pendingUploads.get(mainCode);
      const fileInput = h('input', { type: 'file', accept: '.svg,.png,.jpg,.jpeg,.gif,.webp,image/*', class: 'visually-hidden' });
      const takeFile = async (file) => {
        if (!file) return;
        if (!mainCode) return toast(t('Enter the code first.'), 'error');
        if (savedCodes.has(mainCode)) {
          const fd = new FormData();
          fd.append('code', mainCode);
          fd.append('file', file);
          try {
            const r = await api('POST', '/api/v1/images', fd, { form: true });
            images[mainCode] = [r.url, ...(images[mainCode] ?? [])];
            toast(t('Image uploaded.'));
          } catch (err) { toast(err.message, 'error'); }
        } else {
          pendingUploads.set(mainCode, file);
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
      pending ? h('img', { src: URL.createObjectURL(pending), alt: '' }) : imgUrl ? h('img', { src: imgUrl, alt: mainCode }) : h('span.dz-empty', {}, '＋'),
      h('span.dz-hint', {}, pending ? t('Will be uploaded on save') : imgUrl ? t('Replace the image') : t('Add an image')),
      fileInput);

      // Code(s): one input when every language shares them.
      let codeBlock;
      if (shared) {
        const others = (first?.codes ?? []).filter((c) => c !== mainCode);
        const setCodes = (main, rest) => {
          const oldOsm = osmFor(mainCode);
          for (const l of Object.values(langs)) {
            l.code = main;
            l.codes = [...new Set([main, ...rest].filter(Boolean))];
          }
          const ts = v.data.osm.traffic_sign;
          if (main && (ts.length === 0 || (ts.length === 1 && ts[0] === oldOsm))) v.data.osm.traffic_sign = [osmFor(main)];
        };
        const suffix = mainCode.includes(':') ? mainCode.slice(mainCode.indexOf(':') + 1) : mainCode;
        const codeInput = h('input', {
          type: 'text', value: suffix, class: 'mono', placeholder: 'B14', dataset: { path: sub(sub(sub(path, 'languages'), Object.keys(langs)[0] ?? 'en'), 'code') },
          onchange: (e) => {
            const raw = e.target.value.trim();
            const full = raw === '' ? '' : raw.includes(':') ? raw : `${prefix}:${raw}`;
            setCodes(full, others);
            redraw();
          },
        });
        const othersList = [...others];
        codeBlock = h('div.code-fields', {},
          field('National code', h('div.prefixed', {}, h('span.prefix', {}, `${prefix}:`), codeInput),
            { help: 'As written in the national regulations, e.g. B14.' }),
          field('Other codes (variants)', strList(othersList, {
            path: sub(sub(sub(path, 'languages'), Object.keys(langs)[0] ?? 'en'), 'codes'), placeholder: `${prefix}:…`, autocomplete: true,
            onchange: () => setCodes(mainCode, othersList.map((c) => (c.includes(':') ? c : `${prefix}:${c}`))),
          })));
      } else {
        codeBlock = h('div', {},
          h('p.muted.small', {}, t('Codes differ by language:')),
          mapEditor(langs, {
            path: sub(path, 'languages'), addLabel: 'Add a language', keyPlaceholder: 'Language code', keyPattern: LANG_KEY,
            newValue: () => ({ code: mainCode, codes: mainCode ? [mainCode] : [], text: null, description: null }),
            renderValue: (o, k, p) => languageEditor(o, k, p),
          }));
      }

      // Official text, per language.
      const texts = shared ? h('div.texts', {}, Object.keys(langs).map((lk) => field(t('Text on the sign ({lang})', { lang: lk }), text(langs[lk], 'text', { path: sub(sub(path, 'languages'), lk), nullable: true, placeholder: 'Official name or wording' })))) : null;

      // Design picker.
      const usedByOthers = new Set(variants.filter((x, i) => i !== vi && typeof x.design === 'number').map((x) => x.design));
      const isNewDesign = typeof v.design === 'object';
      const picker = h('div.design-picker', { role: 'radiogroup', 'aria-label': t('Design used') },
        designs.map((d) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(v.design === d.index), class: `dchoice${v.design === d.index ? ' on' : ''}`,
          disabled: usedByOthers.has(d.index), title: `${designText(d.props)} — ${t('{n} countries', { n: d.countries })}`,
          onclick: () => { v.design = d.index; redrawAll(); },
        },
        d.sample ? h('img', { src: d.sample, alt: '' }) : swatch(d.props),
        h('span.dlabel', {}, designText(d.props)),
        h('span.dcount', {}, t('{n} countries', { n: d.countries })))),
        h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(isNewDesign), class: `dchoice new${isNewDesign ? ' on' : ''}`,
          onclick: () => { if (!isNewDesign) v.design = { new: { shape: null, background_color: null, border_color: null, symbol_color: null } }; redrawAll(); },
        }, h('span.dz-empty', {}, '＋'), h('span.dlabel', {}, t('New design'))));
      const newDesignForm = isNewDesign ? h('div.grid4.newdesign', {},
        field('Shape', select(v.design.new, 'shape', voc.shape, { path: '$' })),
        field('Background colour', select(v.design.new, 'background_color', voc.color, { path: '$' })),
        field('Border colour', select(v.design.new, 'border_color', voc.color, { path: '$' })),
        field('Symbol colour', select(v.design.new, 'symbol_color', voc.color, { path: '$' }))) : null;

      // Everything else, folded.
      const more = h('details.more', {},
        h('summary', {}, t('More options')),
        h('div.stack', {},
          h('div.grid2', {},
            field('Country code', text(v.data, 'countryCode', { path, mono: true })),
            field('Left-hand traffic variant', bool(v.data, 'leftHandTrafficVariant', { path, optional: true }))),
          h('label.check', {}, h('input', { type: 'checkbox', checked: !shared, onchange: (e) => { v.perLanguage = e.target.checked; redraw(); } }), t('Different codes for each language')),
          shared ? field('Languages', mapEditor(langs, {
            path: sub(path, 'languages'), inline: true, addLabel: 'Add a language', keyPlaceholder: 'Language code', keyPattern: LANG_KEY,
            suggestions: sugg.languages,
            newValue: () => ({ code: mainCode, codes: mainCode && first ? [...first.codes] : [], text: null, description: null }),
            onAdd: () => setTimeout(redraw, 0),
            renderValue: (o, k) => text(o[k], 'description', { path: sub(sub(path, 'languages'), k), nullable: true, placeholder: 'Description (optional)' }),
          }), { wide: true }) : null,
          h('h5', {}, t('Parameters')),
          block((r2) => (v.data.parameters
            ? mapEditor(v.data.parameters, {
              path: sub(path, 'parameters'), addLabel: 'Add a parameter', keyPlaceholder: 'maxspeed', keyPattern: '^[a-z][a-z0-9_]{0,40}$',
              suggestions: ['maxspeed', 'minspeed', 'speed', 'weight', 'axleload', 'height', 'width', 'length', 'distance'],
              newValue: () => ({ description: null, type: 'number', unit: null, values: [] }),
              renderValue: (o, k, p) => parameterEditor(o, k, p),
            })
            : h('button.btn.small', { type: 'button', onclick: () => { v.data.parameters = {}; r2(); } }, `+ ${t('Add a parameter')}`))),
          field('OSM traffic_sign values', strList(v.data.osm.traffic_sign, { path: sub(sub(path, 'osm'), 'traffic_sign') }), { help: 'Filled in automatically from the code.' }),
          h('h5', {}, t('Sources')),
          block((r3) => (v.data.sources
            ? listEditor(v.data.sources, {
              path: sub(path, 'sources'), addLabel: 'Add a source', title: (s) => s.file || '—', collapsed: true,
              newItem: () => ({ file: '', url: null }),
              renderItem: (s, i, p) => h('div.grid2', {}, field('File', text(s, 'file', { path: p })), field('URL', text(s, 'url', { path: p, nullable: true }))),
            })
            : h('button.btn.small', { type: 'button', onclick: () => { v.data.sources = []; r3(); } }, `+ ${t('Add a source')}`)))));

      return [
        variants.length > 1 || !isNew ? h('div.variant-head', {},
          h('h3', {}, variants.length > 1 ? t('Variant {n}', { n: vi + 1 }) : t('This country’s sign')),
          h('button.btn.small.danger', {
            type: 'button',
            onclick: async () => {
              const msg = variants.length > 1 ? t('Remove this variant?') : t('Remove {country} from this sign?', { country: pretty(jur) });
              if (await confirmDialog(msg)) { variants.splice(vi, 1); redrawAll(); }
            },
          }, variants.length > 1 ? t('Remove this variant') : t('This country does not use this sign'))) : null,
        h('div.variant-main', {}, drop, h('div.stack', {}, codeBlock, texts)),
        h('h5', {}, t('Design used')),
        picker,
        newDesignForm,
        h('h5', {}, t('Additional panels')),
        panelsEditor(v.data.additional, sub(path, 'additional')),
        more,
      ];
    }, 'section', { class: 'variant' });
  }

  // --- panel shell -------------------------------------------------------------------------
  const errorsBox = h('div.errors-box');
  const comment = h('input', { type: 'text', maxlength: 500, placeholder: t('Summary of your change (optional)'), class: 'comment' });
  const saveBtn = h('button.btn.primary', { type: 'button' }, t('Save'));
  const body = block((redrawAll) => [
    variants.length === 0 ? h('div.removed', {},
      h('p', {}, t('{country} will be removed from this sign when you save.', { country: pretty(jur) })),
      h('button.btn', { type: 'button', onclick: () => { variants.push({ design: designs[0]?.index ?? 0, data: newJurisdiction(sugg) }); redrawAll(); } }, t('Undo'))) : null,
    variants.map((v, vi) => variantCard(v, vi, redrawAll)),
    variants.length && variants.length < designs.length + 1 ? h('button.btn.add', {
      type: 'button',
      onclick: () => {
        const used = new Set(variants.map((x) => x.design));
        const free = designs.find((d) => !used.has(d.index));
        const copy = structuredClone(variants[0].data);
        variants.push({ design: free ? free.index : { new: { shape: null, background_color: null, border_color: null, symbol_color: null } }, data: copy });
        redrawAll();
      },
    }, `+ ${t('Add a variant (this country also uses another design)')}`) : null,
  ], 'div', { class: 'drawer-body' });

  const dirty = () => JSON.stringify(variants.map((v) => ({ design: v.design, data: v.data }))) !== baseline || pendingUploads.size > 0;
  const dlg = h('dialog.drawer', { 'aria-label': `${pretty(jur)} — ${reference}` },
    h('header.drawer-head', {},
      h('div', {},
        h('p.crumbs', {}, h('a', { href: signHref(reference) }, h('code', {}, reference)), ' · ', displayName(view.name)),
        h('h2', {}, pretty(jur), ' ', h('code.cc', {}, variants[0]?.data.countryCode || sugg.country_code || ''))),
      h('button.btn.close', { type: 'button', 'aria-label': t('Close'), onclick: () => close() }, '×')),
    isNew ? h('p.banner.info', {}, t('{country} has no entry for this sign yet. Fill in its code and save to add it.', { country: pretty(jur) })) : null,
    body,
    h('footer.drawer-foot', {},
      errorsBox,
      h('div.row', {}, comment, h('button.btn', { type: 'button', onclick: () => close() }, t('Cancel')), saveBtn),
      h('p.small.muted', {}, t('Ctrl+Enter to save'), ' · ', h('a', { href: signHref(reference, '/edit') }, t('Open the full editor')))));

  async function close(force = false) {
    if (!force && dirty() && !(await confirmDialog(t('You have unsaved changes. Leave anyway?')))) return;
    dlg.close();
    dlg.remove();
  }

  async function save() {
    saveBtn.disabled = true;
    errorsBox.replaceChildren();
    try {
      const r = await put(`${signPath(reference)}/countries/${encodeURIComponent(jur)}`, {
        version, comment: comment.value, variants: variants.map((v) => ({ design: v.design, data: v.data })),
      });
      version = r.version;
      // Upload the images that were waiting for their code to exist.
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
          h('button.btn', { type: 'button', onclick: async () => { await close(true); openCountryEditor(reference, jur, { onSaved }); } }, t('Reload'))));
      } else if (err instanceof ApiError && err.details) {
        showErrors(errorsBox, err.details.map((d) => ({ ...d, path: d.path })), dlg);
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

/** Ask which country to add, then open the panel. */
export async function pickCountryThenEdit(reference, existing, allCountries, opts) {
  const options = [...new Map(allCountries.map((c) => [c.jurisdiction, c])).values()]
    .filter((c) => !existing.has(c.jurisdiction))
    .sort((a, b) => pretty(a.jurisdiction).localeCompare(pretty(b.jurisdiction)));
  const input = h('input', { type: 'text', list: 'pmx-jurs', placeholder: t('Find a country…'), autocomplete: 'off' });
  const dl = h('datalist', { id: 'pmx-jurs' }, options.map((c) => h('option', { value: c.jurisdiction }, `${pretty(c.jurisdiction)} (${c.country_code})`)));
  const dlg = h('dialog.dialog', {},
    h('form', { method: 'dialog' },
      h('p', {}, t('Which country?')),
      input, dl,
      h('p.small.muted', {}, t('A new country key (lowercase, e.g. new_zealand) is accepted too.')),
      h('div.row.end', {}, h('button.btn', { value: 'cancel' }, t('Cancel')), h('button.btn.primary', { value: 'ok' }, t('Continue')))));
  dlg.addEventListener('close', () => {
    const key = input.value.trim().toLowerCase().replace(/\s+/g, '_');
    dlg.remove();
    if (dlg.returnValue !== 'ok' || !key) return;
    if (!/^[a-z0-9_]{2,60}$/.test(key)) return toast(t('Invalid country key.'), 'error');
    openCountryEditor(reference, key, opts).catch((err) => toast(err.message, 'error'));
  });
  document.body.append(dlg);
  dlg.showModal();
}
