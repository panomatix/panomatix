// Client for the Panomatix REST API (same origin, cookie session + CSRF header).

let csrfToken = null;
export const session = { user: null };
const listeners = new Set();

export const onSessionChange = (fn) => listeners.add(fn);
function setSession(user, csrf) {
  session.user = user;
  csrfToken = csrf ?? null;
  listeners.forEach((fn) => fn(user));
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code ?? 'http_error';
    this.details = body?.error?.details ?? null;
    this.body = body;
  }
}

export async function api(method, path, body, { form = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  let payload;
  if (form) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: 'The server cannot be reached. Check your connection.' } });
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && session.user) setSession(null);
    throw new ApiError(res.status, data);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b ?? {});
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p, b) => api('DELETE', p, b ?? {});

export async function refreshSession() {
  const me = await get('/api/v1/auth/me');
  setSession(me.user, me.csrf_token);
  return me.user;
}

export async function login(email, password) {
  const r = await post('/api/v1/auth/login', { email, password });
  setSession(r.user, r.csrf_token);
  return r.user;
}

export async function register(email, display_name, password) {
  const r = await post('/api/v1/auth/register', { email, display_name, password });
  setSession(r.user, r.csrf_token);
  return r.user;
}

export async function logout() {
  try {
    await post('/api/v1/auth/logout');
  } finally {
    setSession(null);
  }
}

export const can = (role) => {
  const rank = { contributor: 1, moderator: 2, admin: 3 };
  return Boolean(session.user) && rank[session.user.role] >= rank[role];
};

export const signPath = (ref) => `/api/v1/signs/${encodeURIComponent(ref)}`;

let vocabPromise = null;
export const vocab = () => (vocabPromise ??= get('/api/v1/meta/vocabularies'));
let countriesPromise = null;
export const countries = () => (countriesPromise ??= get('/api/v1/meta/countries').then((r) => r.items));
