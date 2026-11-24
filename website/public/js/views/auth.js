// Sign in, registration, account settings, user administration.
import { can, get, login, patch, post, refreshSession, register, session } from '../api.js';
import { block, confirmDialog, fmtDate, h, toast } from '../dom.js';
import { navigate } from '../app.js';
import { t } from '../i18n.js';

function formError(box, err) {
  box.replaceChildren(h('p.error', { role: 'alert' }, err.message));
}

export function viewLogin() {
  const email = h('input', { type: 'email', required: true, autocomplete: 'username', maxlength: 254 });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password', maxlength: 256 });
  const err = h('div');
  const submit = h('button.btn.primary', { type: 'submit' }, t('Sign in'));
  return h('section.page.narrow', {},
    h('h1', {}, t('Sign in')),
    h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          const u = await login(email.value, password.value);
          toast(t('Welcome, {name}!', { name: u.display_name }));
          navigate('#/');
        } catch (x) { formError(err, x); } finally { submit.disabled = false; }
      },
    },
    h('label.field', {}, h('span.label', {}, t('Email')), email),
    h('label.field', {}, h('span.label', {}, t('Password')), password),
    err, submit),
    h('p', {}, t('No account yet?'), ' ', h('a', { href: '#/register' }, t('Create account'))));
}

export function viewRegister() {
  const name = h('input', { type: 'text', required: true, minlength: 2, maxlength: 60, autocomplete: 'nickname' });
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', maxlength: 254 });
  const password = h('input', { type: 'password', required: true, minlength: 10, maxlength: 256, autocomplete: 'new-password' });
  const err = h('div');
  const submit = h('button.btn.primary', { type: 'submit' }, t('Create account'));
  return h('section.page.narrow', {},
    h('h1', {}, t('Create account')),
    h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          const u = await register(email.value, name.value, password.value);
          toast(t('Welcome, {name}!', { name: u.display_name }));
          navigate('#/');
        } catch (x) { formError(err, x); } finally { submit.disabled = false; }
      },
    },
    h('label.field', {}, h('span.label', {}, t('Display name')), name),
    h('label.field', {}, h('span.label', {}, t('Email')), email),
    h('label.field', {}, h('span.label', {}, t('Password')), password, h('span.help', {}, t('At least 10 characters.'))),
    err, submit),
    h('p', {}, t('Already registered?'), ' ', h('a', { href: '#/login' }, t('Sign in'))));
}

export async function viewAccount() {
  if (!session.user) {
    navigate('#/login');
    return h('p', {}, t('You must be signed in.'));
  }
  const u = session.user;
  const name = h('input', { type: 'text', value: u.display_name, minlength: 2, maxlength: 60, required: true });
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
  const err1 = h('div');
  const err2 = h('div');
  const mine = await get(`/api/v1/changes?user=${u.id}&per_page=30`);
  return h('section.page.narrow', {},
    h('h1', {}, t('Your account')),
    h('div.kvs.box', {},
      h('div.kv', {}, h('span.k', {}, t('Email')), h('span.v', {}, u.email)),
      h('div.kv', {}, h('span.k', {}, t('Role')), h('span.v', {}, t(u.role))),
      h('div.kv', {}, h('span.k', {}, t('Member since')), h('span.v', {}, fmtDate(u.created_at)))),
    h('form.stack.box', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await patch('/api/v1/auth/me', { display_name: name.value });
          await refreshSession();
          toast(t('Display name updated.'));
          err1.replaceChildren();
        } catch (x) { formError(err1, x); }
      },
    }, h('h2', {}, t('Change display name')), h('label.field', {}, h('span.label', {}, t('Display name')), name), err1, h('button.btn.primary', { type: 'submit' }, t('Save'))),
    h('form.stack.box', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await post('/api/v1/auth/password', { current_password: cur.value, new_password: next.value });
          cur.value = '';
          next.value = '';
          err2.replaceChildren();
          toast(t('Password changed. Your other sessions were signed out.'));
        } catch (x) { formError(err2, x); }
      },
    }, h('h2', {}, t('Change password')),
    h('label.field', {}, h('span.label', {}, t('Current password')), cur),
    h('label.field', {}, h('span.label', {}, t('New password')), next, h('span.help', {}, t('At least 10 characters.'))),
    err2, h('button.btn.primary', { type: 'submit' }, t('Change password'))),
    h('section.box', {}, h('h2', {}, t('Your contributions')),
      mine.items.length
        ? h('ul.plain', {}, mine.items.map((c) => h('li', {}, fmtDate(c.created_at), ' — ', h('a', { href: `#/sign/${encodeURIComponent(c.reference)}` }, c.reference), ` (${t(c.action)}) `, h('span.muted', {}, c.comment))))
        : h('p.muted', {}, t('No change yet.'))));
}

export async function viewUsers() {
  if (!can('moderator')) {
    navigate('#/');
    return h('p', {}, t('You must be signed in.'));
  }
  const data = await get('/api/v1/users');
  const isAdmin = can('admin');
  return h('section.page', {},
    h('h1', {}, t('Users')),
    block((redraw) => h('table.list', {},
      h('thead', {}, h('tr', {}, ['Display name', 'Email', 'Role', 'Status', 'Edits', 'Member since', 'Last sign-in', ''].map((c) => h('th', {}, c ? t(c) : '')))),
      h('tbody', {}, data.items.map((u) => {
        const self = u.id === session.user.id;
        const update = async (body) => {
          try {
            const r = await patch(`/api/v1/users/${u.id}`, body);
            Object.assign(u, r.user);
            toast(t('Saved'));
            redraw();
          } catch (x) { toast(x.message, 'error'); }
        };
        return h('tr', { class: u.is_active ? '' : 'inactive' },
          h('td', {}, u.display_name), h('td', {}, u.email),
          h('td', {}, isAdmin && !self
            ? h('select', { onchange: (e) => update({ role: e.target.value }) }, ['contributor', 'moderator', 'admin'].map((r) => h('option', { value: r, selected: r === u.role }, t(r))))
            : t(u.role)),
          h('td', {}, t(u.is_active ? 'active' : 'disabled')),
          h('td.num', {}, u.edits),
          h('td', {}, fmtDate(u.created_at)), h('td', {}, fmtDate(u.last_login_at)),
          h('td', {}, self ? null : [
            h('button.btn.small', { type: 'button', onclick: () => update({ is_active: !u.is_active }) }, t(u.is_active ? 'Disable' : 'Enable')),
            isAdmin ? h('button.btn.small', {
              type: 'button',
              onclick: async () => {
                const pw = await confirmDialog(t('New password for {email}', { email: u.email }), { input: true });
                if (!pw) return;
                try {
                  await post(`/api/v1/users/${u.id}/password`, { new_password: pw });
                  toast(t('Saved'));
                } catch (x) { toast(x.message, 'error'); }
              },
            }, t('Set password')) : null,
          ]));
      })))));
}
