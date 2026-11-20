// DOM and API helpers shared by the admin SPA (app.js) and the share viewer (viewer.js).
import { errorText, lang, setLang, t } from './i18n.js';

/** Artifact access modes, in display order (labels: `vis.<mode>`). */
export const VISIBILITIES = ['private', 'public', 'password'];

/** zh ⇄ en toggle button; `onSwitch` re-renders the caller's UI in the new language. */
export function langToggle(className, onSwitch) {
  return h(
    'button',
    {
      type: 'button',
      class: `link lang ${className}`,
      title: t('lang.switchTitle'),
      onclick: () => {
        setLang(lang === 'zh' ? 'en' : 'zh');
        onSwitch();
      },
    },
    t('lang.switch'),
  );
}

/** Hyperscript: h('div', {class: 'x', onclick}, child, ...). Strings become text nodes (no innerHTML). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM is allowed under style-src 'self'
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function toast(msg, type = 'ok') {
  const el = h('div', { class: `toast ${type === 'error' ? 'error' : ''}` }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 2800);
}

export async function copy(text, label = t('common.copied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast(t('common.copyFailed'), 'error');
  }
}

export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    /** Structured fields from the error body, e.g. `remaining`, `retry_after`, `turnstile_site_key`. */
    this.details = details;
  }
}

/** JSON API call; throws ApiError with a translated message. */
export async function request(method, path, body) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { code, message, ...details } = data?.error ?? {};
    throw new ApiError(res.status, code, errorText(code, message || `HTTP ${res.status}`, details), details);
  }
  return data;
}

/** Runs an async action with a busy button and a toast on error. */
export async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Human-readable byte size. */
export const fmtBytes = (n) => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};

// ---------------- Cloudflare Turnstile ----------------

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let turnstileLoaded = null;

function loadTurnstile() {
  turnstileLoaded ??= new Promise((resolve, reject) => {
    const s = h('script', {
      src: TURNSTILE_SRC,
      async: true,
      onload: resolve,
      onerror: () => {
        turnstileLoaded = null;
        reject(new Error('Turnstile failed to load'));
      },
    });
    document.head.append(s);
  });
  return turnstileLoaded;
}

/** Renders a Turnstile widget into `el`. Tokens are single-use: call reset() after each submission. */
export async function mountTurnstile(el, siteKey, language) {
  await loadTurnstile();
  let token = null;
  const id = window.turnstile.render(el, {
    sitekey: siteKey,
    language: language === 'zh' ? 'zh-cn' : 'en',
    theme: 'auto',
    callback: (v) => (token = v),
    'expired-callback': () => (token = null),
    'error-callback': () => (token = null),
  });
  return {
    token: () => token,
    reset: () => {
      token = null;
      window.turnstile.reset(id);
    },
    remove: () => window.turnstile.remove(id),
  };
}
