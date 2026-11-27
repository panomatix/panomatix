// Wikidata ID of a sign, a design or a related sign: shown as a link, edited in place by signed-in users.
import { get } from '../api.js';
import { debounce, h, toast } from '../dom.js';
import { lang, t } from '../i18n.js';
import { icon } from '../icons.js';

export const EMPTY_WIKIDATA = 'QXXXXXXX'; // placeholder of the database for "not known yet"
const isSet = (v) => typeof v === 'string' && /^Q[1-9][0-9]*$/.test(v);

/** "Q42", "q42", "https://www.wikidata.org/wiki/Q42", "…/entity/Q42" -> "Q42"; '' if empty; null if not an ID. */
export function parseWikidata(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  const m = /(?:^|[/:#=])?(Q[1-9][0-9]{0,11})(?:$|[^0-9])/i.exec(s);
  return m ? m[1].toUpperCase() : null;
}

const link = (id) => h('a.wd-link', { href: `https://www.wikidata.org/wiki/${id}`, target: '_blank', rel: 'noopener noreferrer' }, h('code', {}, id), icon('external'));

/** {value, editable, onSave(id | null)} -> element. onSave(null) removes the ID. */
export function wikidataField({ value, editable, onSave }) {
  const box = h('span.wd');
  const show = () => {
    box.replaceChildren(...[
      h('span.wd-label', {}, 'Wikidata'),
      isSet(value) ? link(value) : h('span.muted', {}, t('not set')),
      editable ? h('button.btn.small.wd-edit', { type: 'button', title: t('Edit the Wikidata ID'), onclick: edit }, ...(isSet(value) ? [icon('edit')] : [icon('plus'), t('Add')])) : null,
    ].filter(Boolean)); // replaceChildren() would print a null as text
  };
  function edit() {
    const input = h('input.mono.wd-input', { type: 'text', value: isSet(value) ? value : '', placeholder: 'Q12345 / https://www.wikidata.org/wiki/Q…', 'aria-label': 'Wikidata', size: 22 });
    const status = h('span.wd-status.small', { 'aria-live': 'polite' });
    const save = h('button.btn.small.primary', { type: 'submit' }, t('Save'));
    let seq = 0;
    const check = debounce(async () => {
      const id = parseWikidata(input.value);
      const mine = ++seq;
      if (id === '') return status.replaceChildren();
      if (id === null) return status.replaceChildren(h('span.error', {}, t('A Wikidata ID looks like Q12345.')));
      status.replaceChildren(h('span.muted', {}, t('Checking…')));
      try {
        const r = await get(`/api/v1/wikidata/${id}?lang=${lang}`);
        if (mine !== seq) return;
        status.replaceChildren(...[icon('check'), ' ', h('strong', {}, r.label ?? id), r.description ? h('span.muted', {}, ` — ${r.description}`) : null].filter(Boolean));
      } catch (err) {
        if (mine !== seq) return;
        status.replaceChildren(h(err.code === 'wikidata_unreachable' ? 'span.muted' : 'span.error', {}, err.message));
      }
    }, 350);
    input.addEventListener('input', check);
    const form = h('form.wd-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const id = parseWikidata(input.value);
        if (id === null) return status.replaceChildren(h('span.error', {}, t('A Wikidata ID looks like Q12345.')));
        save.disabled = true;
        try {
          await onSave(id || null);
        } catch (err) {
          toast(err.message, 'error');
          save.disabled = false;
        }
      },
    },
    h('span.wd-label', {}, 'Wikidata'), input, save,
    isSet(value) ? h('button.btn.small.danger', { type: 'button', onclick: () => { input.value = ''; form.requestSubmit(); } }, t('Remove')) : null,
    h('button.btn.small', { type: 'button', onclick: show }, t('Cancel')),
    status);
    box.replaceChildren(form);
    input.focus();
    if (input.value) check();
  }
  show();
  return box;
}
