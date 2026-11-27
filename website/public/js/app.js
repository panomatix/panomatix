// Front-end entry: hash router and account menu.
import { can, logout, onSessionChange, refreshSession, session } from './api.js';
import { h, toast } from './dom.js';
import { LANGUAGES, lang, setLang, t } from './i18n.js';
import { viewAccount, viewForgotPassword, viewLogin, viewRegister, viewSetPassword, viewUsers } from './views/auth.js';
import { viewApiDocs } from './views/apidocs.js';
import { viewChanges, viewHistory } from './views/history.js';
import { viewCompare } from './views/compare.js';
import { viewEditor } from './views/editor.js';
import { viewList } from './views/list.js';
import { viewSign } from './views/sign.js';
import { icon } from './icons.js';

const main = document.getElementById('main');
let leaveGuard = null; // set by the editor when there are unsaved changes

export function setLeaveGuard(fn) {
  leaveGuard = fn;
}

const routes = [
  [/^\/?$/, () => viewList(), 'signs'],
  [/^\/signs$/, () => viewList(), 'signs'],
  [/^\/new$/, () => viewEditor(null), 'signs'],
  [/^\/sign\/([^/]+)$/, (m) => viewSign(decodeURIComponent(m[1])), 'signs'],
  [/^\/sign\/([^/]+)\/edit$/, (m) => viewEditor(decodeURIComponent(m[1])), 'signs'],
  [/^\/sign\/([^/]+)\/history$/, (m) => viewHistory(decodeURIComponent(m[1])), 'signs'],
  [/^\/compare$/, () => viewCompare(), 'compare'],
  [/^\/changes$/, () => viewChanges(), 'changes'],
  [/^\/login$/, () => viewLogin(), ''],
  [/^\/register$/, () => viewRegister(), ''],
  [/^\/forgot-password$/, () => viewForgotPassword(), ''],
  [/^\/set-password$/, () => viewSetPassword(), ''],
  [/^\/account$/, () => viewAccount(), ''],
  [/^\/admin\/users$/, () => viewUsers(), ''],
  [/^\/api$/, () => viewApiDocs(), 'api'],
];

export function currentPath() {
  return location.hash.replace(/^#/, '') || '/';
}

let renderId = 0;
async function render() {
  const path = currentPath();
  const pathOnly = path.split('?')[0];
  const id = ++renderId;
  for (const [rx, view, nav] of routes) {
    const m = rx.exec(pathOnly);
    if (!m) continue;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    try {
      const node = await view(m);
      if (id !== renderId) return; // a newer navigation won
      main.replaceChildren(node);
    } catch (err) {
      if (id !== renderId) return;
      main.replaceChildren(h('div.pad', {}, h('h1', {}, t('Something went wrong')), h('p.error', {}, err.message)));
    }
    main.focus({ preventScroll: true });
    if (!path.includes('?')) window.scrollTo(0, 0);
    return;
  }
  main.replaceChildren(h('div.pad', {}, h('h1', {}, t('Page not found')), h('p', {}, h('a', { href: '#/' }, t('Back to the signs')))));
}

let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  if (leaveGuard && !leaveGuard()) {
    history.replaceState(null, '', lastHash || '#/');
    return;
  }
  leaveGuard = null;
  lastHash = location.hash;
  render();
});
window.addEventListener('beforeunload', (e) => {
  if (leaveGuard && !leaveGuard(true)) e.preventDefault();
});

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/** Light/dark toggle. The stored choice wins over the system setting (see js/theme.js). */
const isDark = () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';

function themeButton() {
  const dark = isDark();
  return h('button.btn.theme-toggle', {
    type: 'button',
    title: t(dark ? 'Switch to light mode' : 'Switch to dark mode'),
    'aria-label': t(dark ? 'Switch to light mode' : 'Switch to dark mode'),
    onclick: () => {
      const next = isDark() ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('pmx_theme', next); } catch { /* not remembered, still applied */ }
      drawAccount();
    },
  }, icon(dark ? 'sun' : 'moon'));
}

function langPicker() {
  return h('select.lang', {
    'aria-label': t('Language'),
    onchange: (e) => {
      setLang(e.target.value);
      translateChrome();
      drawAccount();
      render();
    },
  }, Object.entries(LANGUAGES).map(([code, label]) => h('option', { value: code, selected: code === lang }, label)));
}

/** Static parts of index.html carry data-i18n with their English text. */
function translateChrome() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
}

function drawAccount() {
  const box = document.getElementById('account');
  const u = session.user;
  if (!u) {
    box.replaceChildren(h('a.btn', { href: '#/login' }, t('Sign in')), h('a.btn.primary', { href: '#/register' }, t('Create account')), themeButton(), langPicker());
    return;
  }
  box.replaceChildren(...[
    h('a.btn.primary', { href: '#/new' }, t('+ New sign')),
    can('moderator') ? h('a.btn', { href: '#/admin/users' }, t('Users')) : null,
    h('a.btn.user', { href: '#/account', title: u.email }, u.display_name, h('span.role', {}, t(u.role))),
    h('button.btn', {
      type: 'button',
      onclick: async () => {
        await logout();
        toast(t('Signed out.'));
        navigate('#/');
      },
    }, t('Sign out')),
    themeButton(),
    langPicker(),
  ].filter(Boolean));
}

translateChrome();
onSessionChange(drawAccount);
refreshSession()
  .catch(() => null)
  .finally(() => {
    drawAccount();
    render();
  });
