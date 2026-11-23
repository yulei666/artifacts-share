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

const SVG_NS = 'http://www.w3.org/2000/svg';
const GITHUB_MARK =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.64 7.64 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.14.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z';

const SSO_ICONS = {
  google: {
    viewBox: '0 0 24 24',
    paths: [
      { fill: '#4285F4', d: 'M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z' },
      { fill: '#34A853', d: 'M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z' },
      { fill: '#FBBC05', d: 'M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84Z' },
      { fill: '#EA4335', d: 'M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z' },
    ],
  },
  github: {
    viewBox: '0 0 16 16',
    paths: [{ fill: 'currentColor', d: GITHUB_MARK }],
  },
  cloudflare: {
    viewBox: '0 0 24 24',
    paths: [
      { fill: '#F38020', d: 'M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856a2.596 2.596 0 0 0 .0635.915C1.5688 13.1929 0 14.8032 0 16.7749c0 .1758.0142.3516.0352.5273.0141.084.0844.1475.1689.1475h15.9814c.0914 0 .1758-.0635.2037-.1553l.1196-.4497Z' },
      { fill: '#FAAE40', d: 'M19.2378 11.249c-.0771 0-.1616 0-.2388.0073-.0561 0-.1054.042-.1264.0987l-.3374 1.1743c-.1475.5068-.0914.9707.1547 1.3164.2256.3164.605.498 1.062.5195l1.8433.1133c.0557 0 .1055.0283.1338.0703.0283.043.0352.1055.021.1553-.0283.084-.1128.1484-.2036.1553l-1.9136.1123c-1.041.0498-2.1596.8867-2.5532 1.914l-.1406.3584c-.0283.0713.021.1416.0986.1416h6.5977c.0771 0 .1474-.0498.1689-.1269.1123-.4082.1758-.8369.1758-1.2803 0-2.5957-2.1245-4.7295-4.7363-4.7295Z' },
    ],
  },
};

function svgIcon(viewBox, paths, className) {
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', viewBox);
  icon.setAttribute('aria-hidden', 'true');
  if (className) icon.setAttribute('class', className);
  for (const { d, fill } of paths) {
    const mark = document.createElementNS(SVG_NS, 'path');
    mark.setAttribute('d', d);
    if (fill) mark.setAttribute('fill', fill);
    icon.append(mark);
  }
  return icon;
}

export function ssoIcon(provider) {
  const spec = SSO_ICONS[provider];
  return spec ? svgIcon(spec.viewBox, spec.paths, `sso-ico sso-ico-${provider}`) : null;
}

export function githubProjectLink({ iconOnly = false } = {}) {
  const label = t('common.githubProject');
  const icon = svgIcon('0 0 16 16', [{ d: GITHUB_MARK }]);
  return h('a', {
    class: iconOnly ? 'github-link btn sm github-link-icon' : 'github-link',
    href: 'https://github.com/yulei666/artifacts-share',
    target: '_blank',
    rel: 'noopener noreferrer',
    'aria-label': label,
    title: label,
  }, icon, iconOnly ? null : 'GitHub');
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
