// Sign in, registration, account settings, user administration.
import { can, del, forgotPassword, get, login, patch, post, refreshSession, register, session, setPassword } from '../api.js';
import { block, confirmDialog, fmtDate, h, toast } from '../dom.js';
import { currentPath, navigate } from '../app.js';
import { lang, t } from '../i18n.js';
import { icon } from '../icons.js';

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
    h('p', {}, h('a', { href: '#/forgot-password' }, t('Forgot your password?'))),
    h('p', {}, t('No account yet?'), ' ', h('a', { href: '#/register' }, t('Create account'))));
}

const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+-=?@^_~';

/** 32 random characters, drawn without modulo bias from the browser's cryptographic generator. */
function randomPassword(length = 32) {
  const out = [];
  const limit = 256 - (256 % PW_CHARS.length);
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(64))) {
      if (b < limit && out.length < length) out.push(PW_CHARS[b % PW_CHARS.length]);
    }
  }
  return out.join('');
}

/** New password + confirmation, with a generator and the warning about reuse.
 *  Returns {nodes, value()}; the browser refuses to submit while the two fields differ. */
function newPasswordFields(label = 'Password') {
  const password = h('input', { type: 'password', required: true, minlength: 10, maxlength: 256, autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', required: true, maxlength: 256, autocomplete: 'new-password' });
  const check = () => confirm.setCustomValidity(confirm.value && confirm.value !== password.value ? t('The two passwords are different.') : '');
  password.addEventListener('input', check);
  confirm.addEventListener('input', check);
  const copy = h('button.btn.small', {
    type: 'button',
    hidden: true,
    onclick: async () => {
      await navigator.clipboard.writeText(password.value);
      toast(t('Password copied. Save it in your password manager.'));
    },
  }, t('Copy'));
  const generate = h('button.btn.small', {
    type: 'button',
    onclick: () => {
      password.value = randomPassword();
      confirm.value = password.value;
      password.type = 'text'; // shown, so it can be saved
      check();
      copy.hidden = false;
    },
  }, t('Generate a strong password (32 characters)'));
  return {
    value: () => password.value,
    nodes: [
      h('p.warning', { role: 'note' }, icon('warning'), ' ', t('Use a password you do not use on any other site. If another site leaks it, your account here stays safe. A password manager remembers it for you.')),
      h('label.field', {}, h('span.label', {}, t(label)), password, h('span.help', {}, t('At least 10 characters.'))),
      h('div.row', {}, generate, copy),
      h('label.field', {}, h('span.label', {}, t('Confirm the password')), confirm),
    ],
  };
}

/** Shown after sign-up or a reset request: the next step happens in the mailbox. */
function checkInbox(text) {
  return h('div.box', { role: 'status' },
    h('h2', {}, t('Check your inbox')),
    h('p', {}, text),
    h('p.muted', {}, t('Nothing after a few minutes? Look in your spam folder, or try again.')));
}

/** A form that sends an email, then replaces itself with checkInbox(). */
function emailForm({ title, fields = [], button, sendMail, sent, footer }) {
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', maxlength: 254 });
  // Honeypot against robots: off screen and skipped by keyboard and screen readers.
  const website = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' });
  const trap = h('div.hp', { 'aria-hidden': 'true' }, h('label', {}, 'Website', website));
  const err = h('div');
  const submit = h('button.btn.primary', { type: 'submit' }, button);
  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await sendMail(email.value.trim(), website.value);
        form.replaceWith(checkInbox(t(sent, { email: email.value.trim() })));
      } catch (x) {
        if (x.code === 'mail_quota_reached') showQuotaFull();
        else formError(err, x);
      } finally { submit.disabled = quotaFull; }
    },
  }, ...fields, h('label.field', {}, h('span.label', {}, t('Email')), email), trap, err, submit);
  const notice = h('div.form-notice');
  let quotaFull = false;
  function showQuotaFull() {
    quotaFull = true;
    notice.replaceChildren(h('p.warning', { role: 'alert' }, icon('warning'), ' ',
      t('The site has sent its maximum number of emails for today (accounts and passwords). Please come back tomorrow.')));
    submit.disabled = true;
  }
  // Warn before the form is filled in when today's emails are used up.
  get('/api/v1/auth/mail-status').then((r) => { if (!r.available) showQuotaFull(); }).catch(() => {});
  return h('section.page.narrow', {}, h('h1', {}, title), notice, form, footer);
}

export function viewForgotPassword() {
  return emailForm({
    title: t('Forgot your password?'),
    fields: [h('p', {}, t('Enter the email address of your account: we will send you a link to choose a new password.'))],
    button: t('Send the link'),
    sendMail: (email, website) => forgotPassword(email, lang, website),
    sent: 'If an account uses {email}, we have sent it a link to choose a new password.',
    footer: h('p', {}, h('a', { href: '#/login' }, t('Back to sign in'))),
  });
}

/** Target of the emailed link: #/set-password?token=… */
export async function viewSetPassword() {
  const token = new URLSearchParams(currentPath().split('?')[1] ?? '').get('token') ?? '';
  let info;
  try {
    info = await post('/api/v1/auth/link', { token });
  } catch (x) {
    return h('section.page.narrow', {},
      h('h1', {}, t('Choose a password')),
      h('p.error', { role: 'alert' }, x.message),
      h('p', {}, h('a', { href: '#/forgot-password' }, t('Get a new link')), ' · ', h('a', { href: '#/register' }, t('Create account'))));
  }
  const pw = newPasswordFields();
  const err = h('div');
  const submit = h('button.btn.primary', { type: 'submit' }, t(info.purpose === 'verify' ? 'Create account' : 'Change password'));
  return h('section.page.narrow', {},
    h('h1', {}, t(info.purpose === 'verify' ? 'Choose your password' : 'Choose a new password')),
    h('p', {}, t('Account: {email}', { email: info.email })),
    h('form.stack', {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          const u = await setPassword(token, pw.value());
          toast(t(info.purpose === 'verify' ? 'Welcome, {name}!' : 'Password changed. Your other sessions were signed out.', { name: u.display_name }));
          navigate('#/');
        } catch (x) { formError(err, x); } finally { submit.disabled = false; }
      },
    },
    ...pw.nodes,
    err, submit));
}

export function viewRegister() {
  const name = h('input', { type: 'text', required: true, minlength: 2, maxlength: 60, autocomplete: 'nickname' });
  return emailForm({
    title: t('Create account'),
    fields: [h('label.field', {}, h('span.label', {}, t('Display name')), name)],
    button: t('Create account'),
    sendMail: (email, website) => register(email, name.value, lang, website),
    sent: 'We have sent a link to {email}. Open it to choose your password and finish creating your account.',
    footer: h('p', {}, t('Already registered?'), ' ', h('a', { href: '#/login' }, t('Sign in'))),
  });
}

function deleteAccountBox() {
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('div');
  return h('form.stack.box.danger-zone', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!(await confirmDialog(t('Delete your account for good? This cannot be undone.')))) return;
      try {
        await del('/api/v1/auth/me', { password: password.value });
        await refreshSession().catch(() => null);
        toast(t('Your account has been deleted.'));
        navigate('#/');
      } catch (x) { formError(err, x); }
    },
  }, h('h2', {}, t('Delete my account')),
  h('p', {}, t('Your email address, name and password are erased. Your edits stay in the history of the signs, without your name.')),
  h('label.field', {}, h('span.label', {}, t('Password')), password),
  err, h('button.btn.danger', { type: 'submit' }, t('Delete my account')));
}

export async function viewAccount() {
  if (!session.user) {
    navigate('#/login');
    return h('p', {}, t('You must be signed in.'));
  }
  const u = session.user;
  const name = h('input', { type: 'text', value: u.display_name, minlength: 2, maxlength: 60, required: true });
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = newPasswordFields('New password');
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
          await post('/api/v1/auth/password', { current_password: cur.value, new_password: next.value() });
          e.target.reset();
          err2.replaceChildren();
          toast(t('Password changed. Your other sessions were signed out.'));
        } catch (x) { formError(err2, x); }
      },
    }, h('h2', {}, t('Change password')),
    h('label.field', {}, h('span.label', {}, t('Current password')), cur),
    ...next.nodes,
    err2, h('button.btn.primary', { type: 'submit' }, t('Change password'))),
    deleteAccountBox(),
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
          h('td', {}, t(!u.is_active ? 'disabled' : u.pending ? 'awaiting confirmation' : 'active')),
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
