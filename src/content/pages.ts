export type Lang = 'zh' | 'en';

/** Picks zh/en from Accept-Language (by q-value); defaults to Chinese. */
export function pickLang(header: string | null): Lang {
  if (!header) return 'zh';
  const prefs = header
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { base: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) || 0 : 1, i };
    })
    .filter((p) => p.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const p of prefs) if (p.base === 'zh' || p.base === 'en') return p.base;
  return 'zh';
}

/** Reserved query/form parameter the viewer uses to pass its UI language to the iframe. */
export const LANG_PARAM = '__lang';

/** `__lang` (from the viewer) wins over Accept-Language. */
export function resolveLang(explicit: string | null | undefined, acceptLanguage: string | null): Lang {
  return explicit === 'zh' || explicit === 'en' ? explicit : pickLang(acceptLanguage);
}

const TEXT = {
  zh: {
    unlockTitle: '需要访问码',
    unlockHeading: '请输入访问码',
    unlockDesc: '此内容受访问码保护，请向分享者索取 6 位访问码。',
    unlockButton: '解锁',
    incorrect: '访问码不正确，还可以再试 {n} 次。',
    locked: '尝试次数过多，请在 {n} 分钟后重试。',
    turnstile: '请先完成人机验证。',
    notFoundTitle: '未找到',
    notFoundDesc: '该内容不存在或无法访问。',
    ownerLogin: '所有者登录',
    errorTitle: '出错了',
    invalidLink: '登录链接无效或已过期。',
    usedLink: '该登录链接已被使用过。',
    internal: '服务出现问题，请稍后再试。',
    blockedTitle: '无法在此处打开',
    blockedDesc: '你的浏览器阻止了嵌入页面使用 Cookie，所以无法在这里解锁或登录。请在新标签页中打开。',
    openNewTab: '在新标签页中打开',
  },
  en: {
    unlockTitle: 'Access code required',
    unlockHeading: 'Enter access code',
    unlockDesc: 'This artifact is protected. Ask the owner for the 6-character code.',
    unlockButton: 'Unlock',
    incorrect: 'Incorrect access code. {n} attempt(s) left.',
    locked: 'Too many attempts. Try again in {n} minute(s).',
    turnstile: 'Complete the verification first.',
    notFoundTitle: 'Not found',
    notFoundDesc: 'This artifact does not exist or is not available.',
    ownerLogin: 'Owner sign-in',
    errorTitle: 'Error',
    invalidLink: 'Invalid or expired sign-in link.',
    usedLink: 'This sign-in link was already used.',
    internal: 'Something went wrong. Please try again later.',
    blockedTitle: "Can't open here",
    blockedDesc: 'Your browser blocks cookies in embedded pages, so this artifact cannot be unlocked or signed in to here. Open it in a new tab instead.',
    openNewTab: 'Open in a new tab',
  },
} as const;

export type MessageKey = keyof (typeof TEXT)['en'];
export const msg = (lang: Lang, key: MessageKey) => TEXT[lang][key];

/** Per-request page context: language and who may frame the page (the main domain's viewer). */
export interface PageCtx {
  lang: Lang;
  /** Value for CSP frame-ancestors, e.g. "'self' https://share.example.com". */
  ancestors: string;
}

const TS_ORIGIN = 'https://challenges.cloudflare.com';
/** Gateway pages run no scripts of their own; only the Turnstile widget (when shown) is allowed in. */
const csp = (ancestors: string, captcha = false) =>
  `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors ${ancestors}; base-uri 'none'` +
  (captcha ? `; script-src ${TS_ORIGIN}; frame-src ${TS_ORIGIN}; connect-src ${TS_ORIGIN}` : '');

/** An unlock-form error; `n` is attempts left (`incorrect`) or minutes to wait (`locked`). */
export interface UnlockError {
  key: 'incorrect' | 'locked' | 'turnstile';
  n?: number;
}
const fill = (s: string, n?: number) => s.replace('{n}', String(n ?? ''));

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root{--bg:#f7f7f5;--fg:#1f1f1c;--muted:#6b6b66;--card:#fff;--line:#e4e4df;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#191917;--fg:#ececea;--muted:#9a9a94;--card:#232320;--line:#34342f;--accent:#fb923c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:15px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:16px}
.card{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:18px;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted)}
input{width:100%;font:600 22px/1 ui-monospace,monospace;letter-spacing:.3em;text-transform:uppercase;text-align:center;
padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
button,.button{display:block;box-sizing:border-box;text-align:center;text-decoration:none;margin-top:12px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--fg);color:var(--bg);font:600 15px system-ui;cursor:pointer}
.err{color:var(--accent);font-size:14px;margin:10px 0 0}.cf-turnstile{margin-top:12px;min-height:65px}a{color:var(--muted)}`;

function page({ lang, ancestors }: PageCtx, title: string, body: string, status: number, opts: { captcha?: boolean } = {}): Response {
  const html = `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'content-security-policy': csp(ancestors, opts.captcha),
      'content-language': lang === 'zh' ? 'zh-CN' : 'en',
      vary: 'Accept-Language',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function unlockPage(ctx: PageCtx, opts: { next: string; error?: UnlockError; status?: number; captchaSiteKey?: string; code?: string }): Response {
  const m = TEXT[ctx.lang];
  // Turnstile (after a few failures): implicit rendering adds `cf-turnstile-response` to this form by itself.
  const captcha = opts.captchaSiteKey
    ? `<div class="cf-turnstile" data-sitekey="${esc(opts.captchaSiteKey)}" data-language="${ctx.lang === 'zh' ? 'zh-cn' : 'en'}" data-theme="auto"></div>
<script src="${TS_ORIGIN}/turnstile/v0/api.js" async defer></script>`
    : '';
  return page(
    ctx,
    m.unlockTitle,
    `<form class="card" method="post" action="/__share/unlock">
<h1>${esc(m.unlockHeading)}</h1><p>${esc(m.unlockDesc)}</p>
<input name="code" maxlength="6" minlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" autofocus required value="${esc(opts.code ?? '')}">
<input type="hidden" name="next" value="${esc(opts.next)}">
<input type="hidden" name="${LANG_PARAM}" value="${ctx.lang}">
${captcha}
<button type="submit">${esc(m.unlockButton)}</button>${opts.error ? `<p class="err">${esc(fill(m[opts.error.key], opts.error.n))}</p>` : ''}</form>`,
    opts.status ?? 401,
    { captcha: !!opts.captchaSiteKey },
  );
}

export function notFoundPage(ctx: PageCtx, ownerLoginUrl?: string): Response {
  const m = TEXT[ctx.lang];
  return page(
    ctx,
    m.notFoundTitle,
    `<div class="card"><h1>${esc(m.notFoundTitle)}</h1><p>${esc(m.notFoundDesc)}</p>${ownerLoginUrl ? `<a href="${esc(ownerLoginUrl)}" target="_top">${esc(m.ownerLogin)}</a>` : ''}</div>`,
    404,
  );
}

export function errorPage(ctx: PageCtx, status: number, key: MessageKey): Response {
  const m = TEXT[ctx.lang];
  return page(ctx, m.errorTitle, `<div class="card"><h1>${esc(m.errorTitle)}</h1><p>${esc(m[key])}</p></div>`, status);
}

/** Shown in the viewer's iframe when the browser dropped the cookie we just set (third-party cookies blocked). */
export function cookiesBlockedPage(ctx: PageCtx, openUrl: string): Response {
  const m = TEXT[ctx.lang];
  return page(
    ctx,
    m.blockedTitle,
    `<div class="card"><h1>${esc(m.blockedTitle)}</h1><p>${esc(m.blockedDesc)}</p>
<a class="button" href="${esc(openUrl)}" target="_blank" rel="noopener">${esc(m.openNewTab)}</a></div>`,
    200,
  );
}

/** Static script served at `/__share/unlocked.js` to notify the parent viewer and replace into the artifact. */
export const UNLOCKED_SCRIPT = `(() => {
  const el = document.currentScript;
  if (!el) return;
  const { origin, next, proof } = el.dataset;
  if (origin && proof && window.parent && window.parent !== window) {
    try { window.parent.postMessage({ type: 'as:unlocked', proof }, origin); } catch {}
  }
  if (next && next.startsWith('/') && !next.startsWith('//')) location.replace(next);
})();
`;

/**
 * Brief iframe-only hop after a visitor unlocks a password artifact: posts a signed proof to the parent
 * viewer (so the top bar can reveal the real title) and immediately navigates to `next`.
 */
export function unlockNotifyPage(ctx: PageCtx, opts: { next: string; origin: string; proof: string }): Response {
  const html = `<!doctype html><html lang="${ctx.lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<noscript><meta http-equiv="refresh" content="0;url=${esc(opts.next)}"></noscript>
<style>html,body{margin:0;background:#f7f7f5}@media (prefers-color-scheme:dark){html,body{background:#191917}}</style>
</head><body><script src="/__share/unlocked.js" data-origin="${esc(opts.origin)}" data-next="${esc(opts.next)}" data-proof="${esc(opts.proof)}"></script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors ${ctx.ancestors}; base-uri 'none'`,
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
    },
  });
}
