// Share viewer: top bar + sandboxed iframe of the artifact's own subdomain (like Claude artifacts).
import { lang, setLang, t } from './i18n-core.js';
import { act, brandLogo, copy, fmtBytes, githubProjectLink, h, mountTurnstile, request, toast, VISIBILITIES } from './ui.js';

const $bar = document.getElementById('vbar');
const $main = document.getElementById('vmain');
const publicId = location.pathname.split('/')[2] || '';
/** Reserved parameters passed from the viewer to the content gateway (never handed to the artifact). */
const LANG_PARAM = '__lang';
const PROOF_PARAM = '__proof';

// An access code in the share link is verified once for the viewer bar, passed to the iframe, and removed from the address bar.
const rawPwd = new URLSearchParams(location.search).get('pwd');
if (rawPwd) history.replaceState(null, '', location.pathname);
let linkCode = rawPwd || null;

// ---------------- helpers ----------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  private: ['M6 11h12v10H6z', 'M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11'],
  public: ['M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0', 'M3.5 9h17M3.5 15h17', 'M12 3c-2.5 2.6-3.5 5.6-3.5 9s1 6.4 3.5 9c2.5-2.6 3.5-5.6 3.5-9s-1-6.4-3.5-9'],
  password: ['M12.5 15a4.5 4.5 0 1 1-9 0a4.5 4.5 0 1 1 9 0', 'M11.2 11.8L20 3', 'M16.5 6.5l3 3', 'M14 9l2 2'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  refresh: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  chevron: ['M7 10l5 5 5-5'],
  download: ['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M5 20h14'],
  external: ['M7 17L17 7', 'M9 7h8v8'],
  manage: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  ],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  close: ['M6 6l12 12', 'M18 6l-12 12'],
};
function icon(name, cls = 'ico') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

const api = request;

// ---------------- state ----------------

let info = null; // response of /api/public/artifacts/:id
let frame = null;
let pop = null; // open popover: { el, kind: 'share' | 'download' }
let shareBtn = null;
let menuOpen = false;
let menuWrap = null;
let menuBtn = null;
let menuPanel = null;
let triedLinkCode = false; // a ?pwd= code is tried once for downloads before asking

let linkCodeSent = false; // the ?pwd= code goes to the iframe once; reloads (e.g. a language switch) don't resend it

function frameSrc() {
  // Owners go through a one-time sign-in on the subdomain so private / code-protected content shows directly.
  const u = new URL(info.owner ? info.frame_url : info.content_url);
  // Only gateway pages (unlock, sign-in errors) need the language; public content never sees the parameter.
  if (info.owner || info.visibility === 'password') u.searchParams.set(LANG_PARAM, lang);
  if (!info.owner && info.visibility === 'password') {
    if (linkCode && !linkCodeSent) {
      u.searchParams.set('pwd', linkCode); // each submission counts against the attempt limit
      linkCodeSent = true;
    } else if (info.title === null) {
      // Self-heal: if this browser already unlocked on the content host, ask it for a signed proof.
      u.searchParams.set(PROOF_PARAM, '1');
    }
  }
  return u.toString();
}

/** Raw subdomain link for "open in new tab" (owners hop through sign-in, visitors go straight there). */
function rawUrl() {
  if (info.owner) return `/handoff?id=${info.public_id}&next=/`;
  return linkCode && info.visibility === 'password' ? `${info.content_url}?pwd=${encodeURIComponent(linkCode)}` : info.content_url;
}

// ---------------- popovers & menu (share: owner; download: access-code visitors; menu: unified) ----------------

const anchorOf = (kind) => (kind === 'share' ? shareBtn : menuBtn);
const syncOverlay = () => document.body.classList.toggle('overlay-open', !!(menuOpen || pop));

function setMenuOpen(open, { restoreFocus = false } = {}) {
  if (open) closePopover();
  const wasOpen = menuOpen;
  const hadFocus = menuWrap?.contains(document.activeElement) || document.activeElement === document.body;
  menuOpen = !!open;
  menuWrap?.classList.toggle('open', menuOpen);
  menuBtn?.setAttribute('aria-expanded', String(menuOpen));
  syncOverlay();
  if (!menuOpen && wasOpen && restoreFocus && hadFocus) menuBtn?.focus();
}

function closePopover() {
  if (!pop) return;
  dropDownloadWidget();
  pop.el.remove();
  if (pop.kind === 'share') shareBtn?.setAttribute('aria-expanded', 'false');
  pop = null;
  syncOverlay();
}

function positionPopover() {
  const anchor = pop && anchorOf(pop.kind);
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  pop.el.style.top = `${Math.round(r.bottom + 8)}px`;
  if (window.innerWidth <= 640) {
    pop.el.style.left = '8px';
    pop.el.style.right = '8px';
  } else {
    pop.el.style.left = 'auto';
    pop.el.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }
}

function shareContent() {
  const a = info.artifact;
  const shareUrl = info.share_url;

  const options = VISIBILITIES.map((v) => {
    const on = v === a.visibility;
    const opt = h(
      'button',
      { type: 'button', class: `pop-opt${on ? ' on' : ''}`, role: 'radio', 'aria-checked': on ? 'true' : 'false' },
      h('span', { class: 'pop-ico' }, icon(v)),
      h('span', { class: 'pop-text' }, h('strong', {}, t(`vis.${v}`)), h('small', {}, t(`share.desc.${v}`))),
      on ? icon('check', 'ico pop-check') : null,
    );
    opt.onclick = () =>
      !on &&
      act(opt, async () => {
        await api('PATCH', `/api/v1/artifacts/${a.id}`, { visibility: v });
        await refresh();
        toast(t('share.changed', { v: t(`vis.${v}`) }));
      });
    return opt;
  });

  let codeBox = null;
  if (a.visibility === 'password') {
    const regen = h('button', { type: 'button', class: 'icon-btn', title: t('detail.regenerate'), 'aria-label': t('detail.regenerate') }, icon('refresh'));
    regen.onclick = () =>
      confirm(t('detail.regenerateConfirm')) &&
      act(regen, async () => {
        await api('POST', `/api/v1/artifacts/${a.id}/password/reset`);
        await refresh();
        toast(t('detail.regenerated'));
      });
    codeBox = h(
      'div',
      { class: 'pop-section' },
      h('div', { class: 'pop-label' }, t('share.code')),
      h(
        'div',
        { class: 'pop-code' },
        h('code', {}, a.password),
        h(
          'button',
          { type: 'button', class: 'icon-btn', title: t('detail.copyCode'), 'aria-label': t('detail.copyCode'), onclick: () => copy(a.password, t('detail.codeCopied')) },
          icon('copy'),
        ),
        regen,
      ),
    );
  }

  const linkInput = h('input', { type: 'text', readonly: true, value: shareUrl, 'aria-label': t('share.link'), onfocus: (e) => e.target.select() });
  const linkRow = h(
    'div',
    { class: 'pop-section' },
    h('div', { class: 'pop-label' }, t('share.link')),
    h(
      'div',
      { class: 'pop-link' },
      linkInput,
      a.visibility === 'password'
        ? h('button', { type: 'button', class: 'sm primary', onclick: () => copy(`${shareUrl}?pwd=${a.password}`, t('detail.linkCodeCopied')) }, t('viewer.copyLinkCode'))
        : h('button', { type: 'button', class: 'sm primary', onclick: () => copy(shareUrl, t('detail.linkCopied')) }, t('viewer.copyLink')),
    ),
    a.visibility === 'password'
      ? h('button', { type: 'button', class: 'link small pop-alt', onclick: () => copy(shareUrl, t('detail.linkCopied')) }, t('share.copyLinkOnly'))
      : null,
    a.visibility === 'private' ? h('p', { class: 'pop-hint' }, t('share.privateHint')) : null,
  );

  return [
    h('div', { class: 'pop-head' }, t('share.title')),
    h('div', { class: 'pop-options', role: 'radiogroup', 'aria-label': t('detail.access') }, options),
    codeBox,
    linkRow,
  ];
}

/** Access-code visitors: enter the code to download (it is exchanged for a short-lived download token). */
let typedCode = null; // keeps what the visitor typed across re-renders
let dlCaptchaKey = null; // Turnstile site key once this IP has failed a few times on this artifact
let dlWidget = null;
let dlCaptchaFailed = false; // script failed to load: don't retry on every re-render
let popRenderSeq = 0; // bumps on every popover render; a late Turnstile mount for an old render removes itself

function dropDownloadWidget() {
  dlWidget?.remove();
  dlWidget = null;
}

function downloadContent(error) {
  const input = h('input', {
    type: 'text',
    maxlength: 6,
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    'aria-label': t('share.code'),
    placeholder: t('share.code'),
    class: 'code-input',
    value: typedCode ?? linkCode ?? '',
    oninput: (e) => (typedCode = e.target.value),
  });
  const submit = h('button', { type: 'submit', class: 'sm primary' }, t('dl.submit'));
  const captchaBox = dlCaptchaKey ? h('div', { class: 'captcha' }) : null;
  const form = h(
    'form',
    {
      class: 'pop-section pop-first',
      onsubmit: async (e) => {
        e.preventDefault();
        const token = dlWidget?.token() ?? null;
        if (dlCaptchaKey && !token) return renderPopover(t('err.turnstile_required'));
        submit.disabled = true;
        try {
          await downloadWithCode(input.value, token);
          typedCode = null;
          closePopover();
        } catch (err) {
          // Show the error inside the popover (a toast is easy to miss here) and keep the typed code.
          typedCode = input.value;
          if (err.details?.turnstile_site_key) dlCaptchaKey = err.details.turnstile_site_key;
          renderPopover(err.message);
          pop?.el.querySelector('input')?.select();
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('p', { class: 'pop-hint' }, t('dl.codeDesc')),
    h('div', { class: 'pop-link' }, input, submit),
    captchaBox,
    error ? h('p', { class: 'pop-error' }, error) : null,
  );
  return [h('div', { class: 'pop-head' }, t(info.download.kind === 'zip' ? 'dl.zip' : 'dl.source')), form];
}

function renderPopover(error) {
  if (!pop) return;
  dropDownloadWidget();
  pop.el.replaceChildren(...(pop.kind === 'share' ? shareContent() : downloadContent(error)));
  positionPopover();
  const box = pop.kind === 'download' && pop.el.querySelector('.captcha');
  const seq = ++popRenderSeq;
  if (box && !dlCaptchaFailed) {
    mountTurnstile(box, dlCaptchaKey, lang)
      .then((w) => {
        if (seq !== popRenderSeq || !box.isConnected) return w.remove(); // superseded while loading
        dlWidget = w;
      })
      .catch(() => {
        dlCaptchaFailed = true;
        renderPopover(t('login.captchaLoadFailed'));
      });
  }
}

function openPopover(kind, error) {
  setMenuOpen(false);
  closePopover();
  pop = { kind, el: h('div', { class: 'popover', role: 'dialog', 'aria-label': kind === 'share' ? t('share.title') : t('viewer.download') }) };
  document.body.append(pop.el);
  if (kind === 'share') shareBtn?.setAttribute('aria-expanded', 'true');
  syncOverlay();
  renderPopover(error);
  pop.el.querySelector(kind === 'share' ? '.pop-opt.on' : 'input')?.focus();
}

const togglePopover = (kind) => (pop?.kind === kind ? closePopover() : openPopover(kind));

// Close on outside click, Escape, or focus moving into the iframe (its clicks never reach this document).
document.addEventListener('pointerdown', (e) => {
  if (pop && !pop.el.contains(e.target) && !anchorOf(pop.kind)?.contains(e.target)) closePopover();
  if (menuOpen && !menuWrap?.contains(e.target)) setMenuOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  if (pop) {
    const anchor = anchorOf(pop.kind);
    closePopover();
    anchor?.focus();
    return;
  }
  if (menuOpen) setMenuOpen(false, { restoreFocus: true });
});

// ---------------- download ----------------

/**
 * Starts the browser download (an attachment response; the page stays put). The same URL with `check=1`
 * is asked first, so a refusal (token expired, downloads just turned off) surfaces as an error here.
 */
async function startDownload(token, { skipCheck = false } = {}) {
  const u = new URL(`/s/${encodeURIComponent(publicId)}/download`, location.origin);
  if (token) u.searchParams.set('token', token);
  if (!skipCheck) {
    const check = new URL(u);
    check.searchParams.set('check', '1');
    await api('GET', check.pathname + check.search);
  }
  const a = h('a', { href: u.toString(), download: '' });
  document.body.append(a);
  a.click();
  a.remove();
  toast(t('dl.started'));
}

async function downloadWithCode(code, turnstileToken = null) {
  const r = await api('POST', `/api/public/artifacts/${encodeURIComponent(publicId)}/download-token`, { code, turnstile_token: turnstileToken ?? undefined });
  await startDownload(r.token, { skipCheck: true });
}

function onDownload(btn) {
  const d = info.download;
  if (!d.needs_code) {
    return act(btn, async () => {
      await startDownload();
      setMenuOpen(false, { restoreFocus: true });
    });
  }
  if (linkCode && !triedLinkCode) {
    // The share link carried the code: use it directly, fall back to asking if it no longer works.
    triedLinkCode = true;
    return act(btn, async () => {
      try {
        await downloadWithCode(linkCode);
        setMenuOpen(false, { restoreFocus: true });
      } catch (e) {
        if (e.details?.turnstile_site_key) dlCaptchaKey = e.details.turnstile_site_key;
        openPopover('download', e.message);
      }
    });
  }
  openPopover('download');
}

function downloadMenuItem() {
  const d = info.download;
  const label = t(d.kind === 'zip' ? 'dl.zip' : 'dl.source');
  const detail = d.needs_code
    ? label
    : d.kind !== 'zip'
      ? t('dl.sourceTitle', { name: d.name, size: fmtBytes(d.size) })
      : t('dl.zipTitle', { name: d.name, n: d.file_count, size: fmtBytes(d.size) });
  const meta = !d.needs_code && typeof d.size === 'number' ? h('span', { class: 'vmenu-meta' }, fmtBytes(d.size)) : null;
  const item = h(
    'button',
    { type: 'button', class: 'vmenu-item', title: detail, 'aria-haspopup': d.needs_code ? 'dialog' : null },
    icon('download'),
    h('span', {}, label),
    meta,
  );
  item.onclick = () => onDownload(item);
  return item;
}
window.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement === frame) {
      closePopover();
      setMenuOpen(false);
    }
  }, 0);
});
window.addEventListener('resize', positionPopover);

async function tradeUnlockProof(proof) {
  const path = `/api/public/artifacts/${encodeURIComponent(publicId)}/unlock`;
  try {
    return await api('POST', path, { proof });
  } catch (err) {
    if (err?.status >= 400 && err.status < 500) throw err;
    return api('POST', path, { proof });
  }
}

// Manual unlock inside the content iframe posts a short-lived signed proof; trade it for the real title.
let unlockingProof = false;
window.addEventListener('message', async (e) => {
  if (!info || info.owner || info.visibility !== 'password' || info.title !== null) return;
  if (!frame || e.source !== frame.contentWindow) return;
  if (e.origin !== new URL(info.content_url).origin) return;
  if (!e.data || e.data.type !== 'as:unlocked' || typeof e.data.proof !== 'string' || !e.data.proof) return;
  if (unlockingProof) return;
  unlockingProof = true;
  try {
    const r = await tradeUnlockProof(e.data.proof);
    if (info && info.title === null) {
      info.title = r.title;
      renderBar();
      if (frame) frame.title = info.title || 'Artifact';
    }
  } catch {
    // Keep the protected placeholder if the proof is stale or the network hiccups.
  } finally {
    unlockingProof = false;
  }
});

// ---------------- bar ----------------

const logo = () => h('a', { class: 'brand', href: '/', title: 'Artifacts', 'aria-label': 'Artifacts' }, brandLogo());
const signInHref = () => `/#/login?next=${encodeURIComponent(location.pathname)}`;
const menuSep = () => h('div', { class: 'vmenu-sep', 'aria-hidden': 'true' });

function langMenuItem() {
  return h(
    'button',
    {
      type: 'button',
      class: 'vmenu-item muted',
      title: t('lang.switchTitle'),
      onclick: () => {
        setLang(lang === 'zh' ? 'en' : 'zh');
        setMenuOpen(false);
        // The iframe is not reloaded: that would throw an unlocked visitor back to the start page.
        // Gateway pages pick up the new language on their next load.
        if (!info) renderNotFound();
        else renderBar();
        menuBtn?.focus();
      },
    },
    icon('public'),
    h('span', { lang: lang === 'zh' ? 'en' : 'zh-CN' }, t('lang.switchFull')),
  );
}

function menuControl(entries) {
  menuBtn = h(
    'button',
    {
      type: 'button',
      class: 'vmenu-toggle',
      'aria-expanded': 'false',
      'aria-controls': 'vmenu-panel',
      'aria-label': t('nav.menu'),
      title: t('nav.menu'),
      onclick: () => setMenuOpen(!menuOpen),
    },
    icon('menu', 'ico ico-menu'),
    icon('close', 'ico ico-close'),
  );
  menuPanel = h('div', { class: 'vmenu', id: 'vmenu-panel' }, entries);
  menuPanel.addEventListener('click', (e) => {
    if (e.target.closest('a')) setMenuOpen(false, { restoreFocus: true });
  });
  menuWrap = h('div', { class: 'vmenu-wrap' }, menuBtn, menuPanel);
  menuWrap.addEventListener('focusout', (e) => {
    if (menuOpen && e.relatedTarget && !menuWrap.contains(e.relatedTarget)) setMenuOpen(false);
  });
  menuOpen = false;
  syncOverlay();
  return menuWrap;
}

function renderBar() {
  const title = info.title === null ? t('viewer.protected') : info.title || t('common.untitled');
  document.title = `${title} · Artifacts`;
  const items = [logo(), h('div', { class: 'vtitle', title }, title)];
  const menuEntries = [];
  if (info.download) menuEntries.push(downloadMenuItem());
  menuEntries.push(
    h('a', { class: 'vmenu-item', href: rawUrl(), target: '_blank', rel: 'noopener' }, icon('external'), h('span', {}, t('viewer.openRaw'))),
  );

  if (info.owner) {
    shareBtn = h(
      'button',
      { type: 'button', class: 'sm primary share-btn', 'aria-haspopup': 'dialog', 'aria-expanded': pop?.kind === 'share' ? 'true' : 'false' },
      icon(info.visibility),
      t('viewer.share'),
      icon('chevron', 'ico chev'),
    );
    shareBtn.onclick = () => togglePopover('share');
    items.push(shareBtn);
    menuEntries.push(
      h('a', { class: 'vmenu-item', href: `/#/a/${info.artifact.id}` }, icon('manage'), h('span', {}, t('viewer.manage'))),
      menuSep(),
      langMenuItem(),
      githubProjectLink({ className: 'vmenu-item muted' }),
      menuSep(),
    );
    const out = h('button', { type: 'button', class: 'vmenu-item muted' }, h('span', {}, t('nav.signOut')));
    out.onclick = () => act(out, signOut);
    menuEntries.push(out);
  } else {
    shareBtn = null;
    items.push(h('button', { type: 'button', class: 'sm primary', onclick: () => copy(info.share_url, t('detail.linkCopied')) }, t('viewer.copyLink')));
    menuEntries.push(
      menuSep(),
      langMenuItem(),
      githubProjectLink({ className: 'vmenu-item muted' }),
      menuSep(),
      h('a', { class: 'vmenu-item muted', href: signInHref() }, h('span', {}, t('viewer.signIn'))),
    );
  }

  items.push(menuControl(menuEntries));
  $bar.replaceChildren(...items);
}

/**
 * Sign out: first drop the owner cookie the iframe holds on the artifact's subdomain (otherwise a private
 * artifact would stay visible in this page for the cookie's lifetime), then end the admin session.
 */
async function signOut() {
  setMenuOpen(false);
  closePopover();
  if (frame) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      frame.addEventListener('load', () => (clearTimeout(timer), resolve()), { once: true });
      frame.src = `${info.content_url}__share/logout`;
    });
  }
  await api('POST', '/api/auth/logout');
  location.reload();
}

function renderFrame() {
  frame = h('iframe', {
    class: 'vframe',
    src: frameSrc(),
    title: info.title || 'Artifact',
    // Scripts run on the artifact's own origin; no top navigation without a user click, so an
    // artifact can't silently redirect the viewer.
    sandbox:
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation allow-top-navigation-by-user-activation',
    allow: 'clipboard-write; fullscreen',
    allowfullscreen: true,
    referrerpolicy: 'strict-origin-when-cross-origin',
  });
  $main.replaceChildren(frame);
}

function renderNotFound() {
  document.title = `${t('viewer.notFoundTitle')} · Artifacts`;
  shareBtn = null;
  const menu = menuControl([
    langMenuItem(),
    githubProjectLink({ className: 'vmenu-item muted' }),
    menuSep(),
    h('a', { class: 'vmenu-item muted', href: signInHref() }, h('span', {}, t('viewer.signIn'))),
  ]);
  $bar.replaceChildren(logo(), h('div', { class: 'vtitle' }, 'Artifacts'), menu);
  $main.replaceChildren(
    h(
      'div',
      { class: 'card center stack' },
      h('h1', {}, t('viewer.notFoundTitle')),
      h('p', { class: 'muted' }, t('viewer.notFoundDesc')),
      h('a', { href: `/#/login?next=${encodeURIComponent(location.pathname)}` }, t('viewer.ownerSignIn')),
    ),
  );
}

function consumeInitInfo() {
  const el = document.getElementById('viewer-init');
  if (!el) return null;
  el.remove();
  try {
    const data = JSON.parse(el.textContent || '');
    return data && data.public_id === publicId ? data : null;
  } catch {
    return null;
  }
}

async function loadInfo({ useInit = false } = {}) {
  info = (useInit && consumeInitInfo()) || (await api('GET', `/api/public/artifacts/${encodeURIComponent(publicId)}`));
  dlCaptchaKey = info.download?.turnstile_site_key ?? dlCaptchaKey;
}

async function refresh() {
  await loadInfo();
  renderBar();
  if (pop?.kind === 'download' && !info.download?.needs_code) closePopover();
  renderPopover();
}

async function unlockWithLinkCode() {
  if (!info || info.owner || info.visibility !== 'password' || info.title !== null || !linkCode) return;
  try {
    const r = await api('POST', `/api/public/artifacts/${encodeURIComponent(publicId)}/unlock`, { code: linkCode });
    info.title = r.title;
  } catch (e) {
    if (e.status === 404) throw e;
    if (e.details?.turnstile_site_key) dlCaptchaKey = e.details.turnstile_site_key;
    if (e.code === 'incorrect_code' || e.code === 'rate_limited') {
      // Already counted against the shared attempt limit; don't resend the bad code to the iframe.
      linkCode = null;
      toast(e.message, 'error');
    }
  }
}

async function main() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  try {
    await loadInfo({ useInit: true });
    await unlockWithLinkCode();
  } catch (e) {
    if (e.status === 404) return renderNotFound();
    toast(e.message, 'error');
    return;
  }
  renderBar();
  renderFrame();
}

main();
