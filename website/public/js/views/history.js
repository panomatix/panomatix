// Revision history of a sign (with diff and revert) and the site-wide recent-changes feed.
import { can, get, post, signPath } from '../api.js';
import { block, confirmDialog, fmtDate, h, signHref, toast } from '../dom.js';
import { navigate } from '../app.js';
import { t } from '../i18n.js';

/** Flatten a JSON value into {path: scalar} for a readable diff. */
function flatten(v, path = '$', out = new Map()) {
  if (v !== null && typeof v === 'object') {
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    if (!keys.length) out.set(path, Array.isArray(v) ? '[]' : '{}');
    for (const k of keys) flatten(v[k], typeof k === 'number' ? `${path}[${k}]` : `${path}.${k}`, out);
  } else out.set(path, JSON.stringify(v));
  return out;
}

export function diffView(a, b) {
  const fa = flatten(a ?? {});
  const fb = flatten(b ?? {});
  const rows = [];
  for (const [p, v] of fa) {
    if (!fb.has(p)) rows.push(['removed', p, v, '']);
    else if (fb.get(p) !== v) rows.push(['changed', p, v, fb.get(p)]);
  }
  for (const [p, v] of fb) if (!fa.has(p)) rows.push(['added', p, '', v]);
  rows.sort((x, y) => x[1].localeCompare(y[1], 'en', { numeric: true }));
  if (!rows.length) return h('p.muted', {}, t('No difference.'));
  return h('table.diff', {}, h('tbody', {}, rows.slice(0, 2000).map(([kind, p, before, after]) => h(`tr.${kind}`, {},
    h('td', {}, h('span.badge', {}, t(kind))), h('td', {}, h('code', {}, p)), h('td.before', {}, before), h('td.after', {}, after)))));
}

export async function viewHistory(ref) {
  const [sign, hist] = await Promise.all([get(signPath(ref)), get(`${signPath(ref)}/revisions`)]);
  const selected = new Set(hist.revisions.slice(0, 2).map((r) => r.version));
  const diffBox = h('div.diffbox');

  async function compare() {
    const [a, b] = [...selected].sort((x, y) => x - y);
    if (a === undefined || b === undefined) {
      diffBox.replaceChildren(h('p.muted', {}, t('Select two versions to compare them.')));
      return;
    }
    const [ra, rb] = await Promise.all([get(`${signPath(ref)}/revisions/${a}`), get(`${signPath(ref)}/revisions/${b}`)]);
    diffBox.replaceChildren(h('h2', {}, t('Changes between version {a} and {b}', { a, b })), diffView(ra.data, rb.data));
  }

  const table = block((redraw) => h('table.list', {},
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, t('Version')), h('th', {}, t('Action')), h('th', {}, t('Author')), h('th', {}, t('Date')), h('th', {}, t('Comment')), h('th', {}, ''))),
    h('tbody', {}, hist.revisions.map((r) => h('tr', {},
      h('td', {}, h('input', {
        type: 'checkbox', checked: selected.has(r.version), 'aria-label': `${t('Compare')} ${r.version}`,
        onchange: (e) => {
          if (e.target.checked) {
            selected.add(r.version);
            if (selected.size > 2) selected.delete([...selected][0]);
          } else selected.delete(r.version);
          redraw();
          compare();
        },
      })),
      h('td.num', {}, r.version),
      h('td', {}, h(`span.badge.action-${r.action}`, {}, t(r.action))),
      h('td', {}, r.user?.display_name ?? h('span.muted', {}, t('system'))),
      h('td', {}, fmtDate(r.created_at)),
      h('td', {}, r.comment),
      h('td', {}, can('moderator') && r.version !== sign.version && r.action !== 'delete' ? h('button.btn.small', {
        type: 'button',
        onclick: async () => {
          const comment = await confirmDialog(t('Revert {ref} to version {v}?', { ref, v: r.version }), { input: true, placeholder: t('Comment') });
          if (comment === null) return;
          try {
            await post(`${signPath(ref)}/revert`, { version: sign.version, to_version: r.version, comment });
            toast(t('Reverted.'));
            navigate(signHref(ref, '/history'));
          } catch (err) { toast(err.message, 'error'); }
        },
      }, t('Revert to this version')) : null))))));

  compare();
  return h('section.page', {},
    h('p.crumbs', {}, h('a', { href: '#/' }, t('Signs')), ' / ', h('a', { href: signHref(ref) }, ref)),
    h('h1', {}, t('History of {ref}', { ref })),
    table,
    diffBox);
}

export async function viewChanges() {
  let page = 1;
  const list = h('tbody');
  const more = h('button.btn', { type: 'button' }, t('More'));
  async function load() {
    const r = await get(`/api/v1/changes?page=${page}&per_page=50`);
    list.append(...r.items.map((c) => h('tr', {},
      h('td', {}, fmtDate(c.created_at)),
      h('td', {}, h('a', { href: signHref(c.reference) }, h('code', {}, c.reference))),
      h('td', {}, h(`span.badge.action-${c.action}`, {}, t(c.action)), ` v${c.version}`),
      h('td', {}, c.user?.display_name ?? '—'),
      h('td', {}, c.comment))));
    more.hidden = r.items.length < r.per_page;
    if (page === 1 && !r.items.length) list.append(h('tr', {}, h('td', { colspan: 5 }, h('span.muted', {}, t('No change yet.')))));
  }
  more.addEventListener('click', () => { page += 1; load().catch((e) => toast(e.message, 'error')); });
  await load();
  return h('section.page', {},
    h('h1', {}, t('Recent changes')),
    h('table.list', {},
      h('thead', {}, h('tr', {}, h('th', {}, t('Date')), h('th', {}, t('Reference')), h('th', {}, t('Action')), h('th', {}, t('Author')), h('th', {}, t('Comment')))),
      list),
    more);
}
