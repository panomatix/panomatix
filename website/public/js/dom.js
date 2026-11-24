// Tiny DOM helpers. Content is always inserted as text nodes, never as HTML, so user data cannot inject markup.
import { t } from './i18n.js';

export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.classList.add(...classes);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** A self-redrawing block: `render(redraw)` returns the children; call redraw() after structural changes. */
export function block(render, tag = 'div', attrs = {}) {
  const box = h(tag, attrs);
  const redraw = () => {
    const kids = render(redraw);
    box.replaceChildren();
    append(box, [kids]);
  };
  redraw();
  return box;
}

export { fmtDateTime as fmtDate } from './i18n.js';

export function toast(message, kind = 'info') {
  const zone = document.getElementById('toasts');
  const el = h(`div.toast.toast-${kind}`, { role: kind === 'error' ? 'alert' : 'status' }, message);
  zone.append(el);
  setTimeout(() => el.classList.add('hide'), 4500);
  setTimeout(() => el.remove(), 5000);
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const signHref = (ref, suffix = '') => `#/sign/${encodeURIComponent(ref)}${suffix}`;

export function confirmDialog(message, { input = false, placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const field = input ? h('input', { type: 'text', placeholder, maxlength: 500 }) : null;
    const dlg = h('dialog.dialog', {},
      h('form', { method: 'dialog' },
        h('p', {}, message),
        field,
        h('div.row.end', {},
          h('button.btn', { value: 'cancel', type: 'submit' }, t('Cancel')),
          h('button.btn.primary', { value: 'ok', type: 'submit' }, t('Confirm')))));
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' ? (input ? field.value : true) : null);
      dlg.remove();
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}
