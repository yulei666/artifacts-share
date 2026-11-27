// Artifacts Share — admin SPA (no build step; strict CSP compatible).
import { errorText, lang, locale, t } from './i18n.js';
import { act, ApiError, brandLogo, copy, fmtBytes, githubProjectLink, h, langToggle, mountTurnstile, request, ssoIcon, toast, VISIBILITIES } from './ui.js';
import { pickMarkdownIndex } from './markdown-index.js';

// ---------------- helpers ----------------

const $app = document.getElementById('app');
const $footer = h('footer', { class: 'admin-footer', hidden: true });
$app.after($footer);

/** API call that also routes to sign-in / password setup when the server asks for it. */
async function api(method, path, body) {
  try {
    return await request(method, path, body);
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 401 && !path.startsWith('/api/auth/')) {
        me = null;
        if (parseHash().path !== '/login') go('/login');
      }
      if (e.code === 'password_setup_required') {
        me = null;
        if (parseHash().path !== '/setup') go('/setup');
      }
    }
    throw e;
  }
}

const fmtDate = (s) => (s ? new Date(s * 1000).toLocaleString(locale()) : '—');
const fmtAgo = (s) => {
  if (!s) return t('common.never');
  const d = Date.now() / 1000 - s;
  if (d < 60) return t('time.justNow');
  if (d < 3600) return t('time.minutes', { n: Math.floor(d / 60) });
  if (d < 86400) return t('time.hours', { n: Math.floor(d / 3600) });
  if (d < 86400 * 30) return t('time.days', { n: Math.floor(d / 86400) });
  return new Date(s * 1000).toLocaleDateString(locale());
};
const visLabel = (v) => t(`vis.${v}`);
const badge = (v) => h('span', { class: `badge ${v}` }, visLabel(v));
const infoTip = (text) => h('span', { class: 'info-tip', tabindex: '0', role: 'img', 'aria-label': text, 'data-tip': text }, 'i');
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const SVG_NS = 'http://www.w3.org/2000/svg';
function externalIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M7 17L17 7', 'M9 7h8v8']) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

const langButton = (extraClass = '') =>
  langToggle(extraClass, () => {
    applyChrome();
    render();
  });

const $topbar = document.getElementById('topbar');
const $topbarActions = document.getElementById('topbar-actions');
const $topbarNav = document.getElementById('topbar-nav');
const $navToggle = document.getElementById('nav-toggle');

function setMenuOpen(open) {
  $topbar.classList.toggle('menu-open', open);
  $navToggle?.setAttribute('aria-expanded', String(open));
}

/** Refresh the header and footer when the UI language changes. */
function applyChrome() {
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const slot of document.querySelectorAll('.lang-slot')) slot.replaceChildren(langButton());
  $navToggle?.setAttribute('aria-label', t('nav.menu'));
  $footer.replaceChildren(githubProjectLink());
}

// ---------------- router ----------------

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: new URLSearchParams(qs || '') };
}

function go(path) {
  if (location.hash !== `#${path}`) location.hash = path;
  else render();
}

let me = null;
let routeSeq = 0;

async function render() {
  const seq = ++routeSeq;
  setMenuOpen(false);
  const { path, query } = parseHash();
  const top = $topbar;

  if (path === '/login') {
    top.hidden = $footer.hidden = true;
    return viewLogin(query);
  }
  if (!me) {
    try {
      me = await api('GET', '/api/auth/me');
    } catch {
      if (seq !== routeSeq) return;
      return go(`/login?next=${encodeURIComponent('/#' + path)}`);
    }
    if (seq !== routeSeq) return;
  }
  if (path === '/setup' && !me.needs_password_setup) return go('/');
  if (me.needs_password_setup) {
    top.hidden = $footer.hidden = true;
    return viewSetup();
  }
  top.hidden = $footer.hidden = false;
  const navAnalytics = top.querySelector('[data-nav="analytics"]');
  if (navAnalytics) navAnalytics.hidden = !me.analytics_enabled;
  const section = path.startsWith('/analytics') ? 'analytics' : path.startsWith('/tokens') ? 'tokens' : path.startsWith('/settings') ? 'settings' : 'list';
  for (const a of top.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === section);

  let m;
  if (path === '/' || path === '') return viewList();
  if (path === '/analytics') return me.analytics_enabled ? viewAnalytics() : go('/');
  if (path === '/new') return viewNew();
  if ((m = /^\/a\/([0-9a-f-]{36})$/.exec(path))) return viewDetail(m[1]);
  if (path === '/tokens') return viewTokens();
  if (path === '/settings') return viewSettings(query);
  return go('/');
}

function mount(...nodes) {
  $app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
$navToggle?.addEventListener('click', () => setMenuOpen(!$topbar.classList.contains('menu-open')));
$topbarNav?.addEventListener('click', (e) => {
  if (e.target.closest('a, button')) setMenuOpen(false);
});
$topbarActions?.addEventListener('focusout', (e) => {
  if ($topbar.classList.contains('menu-open') && e.relatedTarget && !$topbarActions.contains(e.relatedTarget)) {
    setMenuOpen(false);
  }
});
document.addEventListener('pointerdown', (e) => {
  if ($topbar.classList.contains('menu-open') && !$topbarNav?.contains(e.target) && !$navToggle?.contains(e.target)) {
    setMenuOpen(false);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented && $topbar.classList.contains('menu-open')) {
    const returnFocus = $topbarActions?.contains(document.activeElement);
    setMenuOpen(false);
    if (returnFocus) $navToggle?.focus();
  }
});
window.matchMedia?.('(max-width: 640px)').addEventListener?.('change', () => setMenuOpen(false));
document.getElementById('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  me = null;
  go('/login');
});

// ---------------- login & setup ----------------

/** Same-origin relative path or null (rejects "//x", "/\\x", control chars and anything resolving off-origin). */
function safeNext(next) {
  if (!next || !next.startsWith('/') || /[\x00-\x20\x7f\\]/.test(next)) return null;
  try {
    const u = new URL(next, location.origin);
    // '/.//evil.com' normalizes to the pathname '//evil.com' (another host): check the result too.
    if (u.origin !== location.origin || u.pathname.startsWith('//')) return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

async function viewLogin(query) {
  const next = query.get('next');
  const error = query.get('error');
  let methods = await api('GET', '/api/auth/methods').catch(() => ({ password: true, sso: [], turnstile: null }));
  const done = () => {
    me = null;
    const target = safeNext(next);
    if (target) location.href = target;
    else go('/');
  };

  const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, autofocus: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'primary', type: 'submit' }, t('login.submit'));

  // Turnstile appears after a few failed attempts from this IP (the server decides; see /api/auth/methods).
  const captchaBox = h('div', { class: 'captcha' });
  let widget = null;
  async function syncCaptcha() {
    const ts = methods.turnstile;
    if (!ts?.required) return;
    if (widget) return widget.reset(); // tokens are single-use
    widget = await mountTurnstile(captchaBox, ts.site_key, lang);
  }

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        const token = widget?.token() ?? null;
        if (methods.turnstile?.required && !token) return toast(t('err.turnstile_required'), 'error');
        act(btn, async () => {
          let res;
          try {
            res = await api('POST', '/api/auth/login', { username: user.value, password: pw.value, turnstile_token: token ?? undefined });
          } catch (err) {
            // A failure may have crossed the threshold: ask the server whether Turnstile is now required.
            methods = await api('GET', '/api/auth/methods').catch(() => methods);
            await syncCaptcha().catch(() => {});
            throw err;
          }
          // First sign-in with the bootstrap password: set a real one before going anywhere else
          // (a `next` like /handoff would only bounce back here).
          if (res?.needs_password_setup) {
            me = null;
            return go('/setup');
          }
          done();
        });
      },
    },
    h('label', { class: 'field' }, t('login.username'), user),
    h('label', { class: 'field' }, t('login.password'), pw),
    captchaBox,
    btn,
  );

  const redirectTo = safeNext(next) || '/';
  const sso = methods.sso.map((s) =>
    h(
      'a',
      { class: 'btn sso-btn', href: `/api/auth/oauth/${s.provider}/start?purpose=login&redirect_to=${encodeURIComponent(redirectTo)}` },
      ssoIcon(s.provider),
      t('login.continueWith', { name: s.name }),
    ),
  );

  mount(
    h(
      'div',
      { class: 'card center stack' },
      h('div', { class: 'row' }, brandLogo(), h('h1', { class: 'grow' }, t('login.title')), langButton('sm')),
      error ? h('p', { class: 'err' }, errorText(error, query.get('detail') || error)) : null,
      methods.password ? form : null,
      methods.password && sso.length ? h('div', { class: 'divider' }) : null,
      sso.length ? h('div', { class: 'stack' }, sso) : null,
      !methods.password && !sso.length ? h('p', { class: 'muted' }, t('login.noMethods')) : null,
    ),
    h('div', { class: 'login-project' }, githubProjectLink()),
  );
  user.focus();
  syncCaptcha().catch(() => toast(t('login.captchaLoadFailed'), 'error'));
}

function viewSetup() {
  const user = h('input', { type: 'text', value: me?.username || 'admin', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 64 });
  const p1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: true });
  const btn = h('button', { class: 'primary', type: 'submit' }, t('setup.submit'));
  mount(
    h(
      'form',
      {
        class: 'card center stack',
        onsubmit: (e) => {
          e.preventDefault();
          if (p1.value !== p2.value) return toast(t('setup.mismatch'), 'error');
          act(btn, async () => {
            await api('PUT', '/api/settings/password', { new_password: p1.value, username: user.value });
            me = null;
            toast(t('setup.saved'));
            go('/');
          });
        },
      },
      h('div', { class: 'row' }, h('h1', { class: 'grow' }, t('setup.title')), langButton('sm')),
      h('p', { class: 'muted' }, t('setup.desc')),
      h('label', { class: 'field' }, t('login.username'), user),
      h('label', { class: 'field' }, t('setup.new'), p1),
      h('label', { class: 'field' }, t('setup.confirm'), p2),
      btn,
    ),
  );
}

// ---------------- list ----------------

async function viewList() {
  const useWae = !!me?.analytics_enabled;
  const search = h('input', { type: 'search', placeholder: t('list.search') });
  const vis = h('select', {}, h('option', { value: '' }, t('list.all')), ...VISIBILITIES.map((v) => h('option', { value: v }, visLabel(v))));
  vis.style.width = 'auto';
  const tbody = h('tbody');
  const more = h('button', { class: 'sm', hidden: true }, t('common.loadMore'));
  const viewsTh = useWae
    ? h('th', { class: 'hide-sm' }, h('span', { class: 'th-with-tip' }, t('list.colViews'), infoTip(t('list.colViews90dHint'))))
    : h('th', { class: 'hide-sm' }, t('list.colViews'));
  const wrap = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', {}, t('list.colTitle')),
          h('th', {}, t('list.colAccess')),
          h('th', { class: 'hide-sm' }, t('list.colSize')),
          viewsTh,
          h('th', {}, t('list.colUpdated')),
          h('th', { class: 'col-action', 'aria-label': t('list.openShare') }),
        ),
      ),
      tbody,
    ),
  );
  const empty = h('div', { class: 'card empty', hidden: true }, h('p', {}, t('list.empty')), h('p', {}, h('a', { href: '#/new' }, t('list.emptyCta'))));
  let cursor = null;
  let seq = 0; // only the latest request may touch the table

  async function loadViews(cells) {
    const ids = [...cells.keys()];
    if (!ids.length) return;
    try {
      const res = await api('GET', `/api/v1/analytics/views?ids=${encodeURIComponent(ids.join(','))}`);
      for (const [id, cell] of cells) {
        if (!cell.isConnected) continue;
        cell.textContent = res?.enabled ? Number(res.views?.[id] ?? 0).toLocaleString(locale()) : '—';
      }
    } catch {
      for (const cell of cells.values()) {
        if (!cell.isConnected) continue;
        cell.textContent = '—';
        cell.title = t('analytics.loadFailed');
      }
    }
  }

  async function load(reset) {
    const mine = ++seq;
    const qs = new URLSearchParams({ limit: '50' });
    if (search.value.trim()) qs.set('q', search.value.trim());
    if (vis.value) qs.set('visibility', vis.value);
    if (!reset && cursor) qs.set('cursor', cursor);
    let data;
    try {
      data = await api('GET', `/api/v1/artifacts?${qs}`);
    } catch (e) {
      if (mine === seq && tbody.isConnected) toast(e.message, 'error');
      return;
    }
    if (mine !== seq || !tbody.isConnected) return;
    if (reset) tbody.replaceChildren();
    const pageCells = new Map();
    const openLabel = t('list.openShare');
    for (const a of data.items) {
      const viewCell = useWae
        ? h('td', { class: 'hide-sm muted', title: t('list.colViews90dHint') }, '…')
        : h('td', { class: 'hide-sm muted' }, a.view_count);
      if (useWae) pageCells.set(a.id, viewCell);
      const rowTitle = a.title || t('common.untitled');
      const openLink = h(
        'a',
        {
          class: 'row-open',
          href: a.url,
          target: '_blank',
          rel: 'noopener',
          title: openLabel,
          'aria-label': `${openLabel}: ${rowTitle}`,
          onclick: (e) => e.stopPropagation(),
        },
        externalIcon(),
      );
      tbody.append(
        h(
          'tr',
          {
            class: 'click',
            onclick: (e) => {
              if (e.target?.closest?.('a, button')) return;
              go(`/a/${a.id}`);
            },
          },
          h(
            'td',
            { class: 'title-cell' },
            a.title || h('span', { class: 'muted' }, t('common.untitled')),
            h('div', { class: 'muted small mono' }, a.kind === 'folder' ? t('list.kindFolder', { n: a.file_count }) : t(a.kind === 'markdown' ? 'list.kindMarkdown' : 'list.kindHtml')),
          ),
          h('td', {}, badge(a.visibility)),
          h('td', { class: 'hide-sm muted' }, fmtBytes(a.total_size)),
          viewCell,
          h('td', { class: 'muted' }, fmtAgo(a.updated_at)),
          h('td', { class: 'col-action' }, openLink),
        ),
      );
    }
    cursor = data.next_cursor;
    more.hidden = !cursor;
    const none = tbody.children.length === 0;
    wrap.hidden = none;
    empty.hidden = !none || !!search.value.trim() || !!vis.value;
    if (useWae && pageCells.size) loadViews(pageCells);
  }

  let timer;
  let composing = false;
  const scheduleSearch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (tbody.isConnected) load(true);
    }, 250);
  };
  search.addEventListener('compositionstart', () => {
    composing = true;
    clearTimeout(timer);
  });
  search.addEventListener('compositionend', () => {
    composing = false;
    scheduleSearch();
  });
  search.addEventListener('input', (e) => {
    if (!composing && !e.isComposing) scheduleSearch();
  });
  vis.addEventListener('change', () => load(true));
  more.addEventListener('click', () => act(more, () => load(false)));

  mount(
    h('div', { class: 'page-head' }, h('h1', {}, t('list.title')), h('a', { class: 'btn primary', href: '#/new' }, t('list.new'))),
    h('div', { class: 'stack' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, search), vis), wrap, empty, h('div', { class: 'row' }, more)),
  );
  await load(true);
}

// ---------------- analytics ----------------

async function viewAnalytics() {
  const seq = ++routeSeq;
  const head = h('div', { class: 'page-head' }, h('h1', {}, t('analytics.title')));
  const body = h('div', {}, h('p', { class: 'muted small an-loading' }, t('analytics.loading')));
  mount(head, body);
  try {
    const { createAnalyticsPanel } = await import('./analytics.js');
    if (seq !== routeSeq || !body.isConnected) return;
    const panel = createAnalyticsPanel({
      api,
      onNavigateArtifact: (id) => go(`/a/${id}`),
    });
    head.append(panel.controls);
    body.replaceWith(panel.root);
    panel.load();
  } catch {
    if (seq !== routeSeq || !body.isConnected) return;
    const retry = h('button', { type: 'button', class: 'sm', onclick: () => viewAnalytics() }, t('analytics.retry'));
    body.replaceChildren(h('div', { class: 'card an-error' }, h('p', { class: 'err' }, t('analytics.loadFailed')), retry));
  }
}

// ---------------- upload ----------------

const IGNORED = /(^|\/)(__MACOSX(\/|$)|\.DS_Store$|Thumbs\.db$)/;

async function readDropped(dataTransfer) {
  const items = [...(dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!items.length) return { files: [...dataTransfer.files].map((f) => ({ path: f.name, blob: f })), folder: false };
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ path: prefix + file.name, blob: file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  }
  for (const e of items) await walk(e, '');
  return { files: out, folder: items.some((entry) => entry.isDirectory) };
}

async function expandZip(file) {
  const buffer = await file.arrayBuffer();
  if (typeof Worker === 'undefined') {
    const { unzipSync } = await import('/vendor/fflate.js');
    const data = unzipSync(new Uint8Array(buffer));
    return Object.entries(data)
      .filter(([name]) => !name.endsWith('/'))
      .map(([path, bytes]) => ({ path, blob: new Blob([bytes]) }));
  }
  const worker = new Worker('/zip-worker.js', { type: 'module' });
  try {
    const files = await new Promise((resolve, reject) => {
      worker.onmessage = (event) => {
        const res = event.data;
        if (res?.ok) resolve(res.files);
        else reject(new Error(res?.message || 'Failed to extract zip'));
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        reject(new Error(event?.message || 'Failed to extract zip'));
      };
      worker.onmessageerror = () => {
        reject(new Error('Failed to extract zip'));
      };
      worker.postMessage({ buffer }, [buffer]);
    });
    return files.map((f) => ({ path: f.path, blob: new Blob([new Uint8Array(f.buffer, f.byteOffset, f.byteLength)]) }));
  } finally {
    worker.terminate();
  }
}

function normalizeFiles(files) {
  // Backslash separators (zips made on Windows) become `/`, like the server does.
  let list = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\.?\/+/, '') })).filter((f) => f.path && !IGNORED.test(f.path));
  const first = list[0]?.path.split('/');
  if (first && first.length > 1) {
    const root = first[0] + '/';
    if (list.every((f) => f.path.startsWith(root))) list = list.map((f) => ({ ...f, path: f.path.slice(root.length) }));
  }
  return list.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Upload panel. `artifactId` set → new version of an existing artifact.
 * Calls onDone(artifact) after commit.
 */
function uploadPanel({ artifactId, currentEntry, onDone }) {
  let files = [];
  let folderUpload = false;
  let selection = 0;
  let choosingFiles = false;
  let publishing = false;
  const title = h('input', { placeholder: t('common.untitled') });
  let suggestedTitle = '';
  let visibility = null;
  const segBtns = {};
  const seg = h(
    'div',
    { class: 'seg' },
    ...VISIBILITIES.map((v) => {
      const b = h(
        'button',
        {
          type: 'button',
          onclick: () => {
            visibility = v;
            for (const [k, el] of Object.entries(segBtns)) el.classList.toggle('on', k === v);
          },
        },
        visLabel(v),
      );
      segBtns[v] = b;
      return b;
    }),
  );
  if (!artifactId) {
    api('GET', '/api/settings')
      .then((s) => { if (visibility === null) segBtns[s.default_visibility]?.click(); })
      .catch(() => { if (visibility === null) segBtns.private.click(); });
  }

  const paste = h('textarea', { placeholder: t('upload.paste') });
  const list = h('div', { class: 'filelist', hidden: true });
  const entrySel = h('select', {});
  const entryRow = h('label', { class: 'field', hidden: true }, t('upload.entry'), entrySel);
  const bar = h('div');
  const progress = h('div', { class: 'progress', hidden: true }, bar);
  const status = h('p', { class: 'muted small' });
  const submit = h('button', { class: 'primary', type: 'button' }, artifactId ? t('upload.newVersion') : t('upload.create'));

  const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
  const dirInput = h('input', { type: 'file', webkitdirectory: true, hidden: true });

  async function chooseFiles(readSelection) {
    if (publishing) return;
    const request = ++selection;
    choosingFiles = true;
    submit.disabled = true;
    try {
      const { files: raw, folder } = await readSelection();
      if (request !== selection) return;
      const firstPath = raw[0]?.path ?? '';
      const isZip = !folder && raw.length === 1 && /\.zip$/i.test(firstPath);
      const title = isZip ? firstPath.replace(/\.zip$/i, '')
        : folder || raw.length > 1 ? (firstPath.includes('/') ? firstPath.split('/')[0] : '')
        : firstPath.replace(/\.(?:html?|md|markdown)$/i, '');
      if (isZip) status.textContent = t('upload.extracting');
      const selected = isZip ? await expandZip(raw[0].blob) : raw;
      if (request === selection) setFiles(selected, folder || isZip, title);
    } catch (error) {
      if (request !== selection) return;
      setFiles([], false, '');
      throw error;
    } finally {
      if (request === selection) {
        choosingFiles = false;
        submit.disabled = false;
      }
    }
  }

  function setFiles(raw, folder, titleSuggestion) {
    files = normalizeFiles(raw);
    folderUpload = folder;
    suggestedTitle = titleSuggestion;
    paste.value = '';
    paste.hidden = files.length > 0;
    const total = files.reduce((s, f) => s + f.blob.size, 0);
    list.hidden = !files.length;
    list.replaceChildren(...files.slice(0, 300).map((f) => h('div', {}, f.path)), files.length > 300 ? h('div', {}, t('upload.more', { n: files.length - 300 })) : null);
    status.textContent = files.length ? t('upload.summary', { n: files.length, size: fmtBytes(total) }) : '';
    const paths = files.map((f) => f.path);
    const html = paths.filter((p) => /\.html?$/i.test(p));
    const markdown = paths.filter((p) => /\.(?:md|markdown)$/i.test(p));
    const curEntry = typeof currentEntry === 'function' ? currentEntry() : currentEntry;
    const current = paths.includes(curEntry) ? curEntry : null;
    const preferredMarkdown = pickMarkdownIndex(markdown) ?? (markdown.length === 1 ? markdown[0] : null);
    const preferred = current ?? (paths.includes('index.html') ? 'index.html' : null)
      ?? (html.length === 1 ? html[0] : null) ?? (!html.length ? preferredMarkdown : null)
      ?? (paths.length === 1 ? paths[0] : null);
    const documents = [...new Set([...html, ...markdown, ...(current ? [current] : [])])];
    const options = documents.length ? documents : paths;
    entryRow.hidden = !paths.length || (options.length === 1 && !!preferred);
    entrySel.replaceChildren(...options.map((p) => h('option', { value: p, selected: p === preferred }, p)));
    title.placeholder = suggestedTitle || t('common.untitled');
  }

  fileInput.addEventListener('change', () => act(null, () => chooseFiles(() => ({
    files: [...fileInput.files].map((f) => ({ path: f.name, blob: f })),
    folder: false,
  }))));
  dirInput.addEventListener('change', () => act(null, () => chooseFiles(() => ({
    files: [...dirInput.files].map((f) => ({ path: f.webkitRelativePath || f.name, blob: f })),
    folder: true,
  }))));

  const drop = h(
    'div',
    {
      class: 'drop',
      ondragover: (e) => {
        e.preventDefault();
        drop.classList.add('over');
      },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: async (e) => {
        e.preventDefault();
        drop.classList.remove('over');
        await act(null, () => chooseFiles(() => readDropped(e.dataTransfer)));
      },
    },
    h('p', {}, h('strong', {}, t('upload.dropTitle'))),
    h('p', { class: 'muted small' }, t('upload.dropHint')),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'sm', onclick: () => fileInput.click() }, t('upload.chooseFiles')),
      h('button', { type: 'button', class: 'sm', onclick: () => dirInput.click() }, t('upload.chooseFolder')),
    ),
    fileInput,
    dirInput,
  );

  submit.addEventListener('click', async () => {
    if (choosingFiles || publishing) return;
    publishing = true;
    await act(submit, async () => {
      let toSend = files;
      if (!toSend.length && paste.value.trim()) toSend = [{ path: 'index.html', blob: new Blob([paste.value], { type: 'text/html' }) }];
      if (!toSend.length) throw new Error(t('upload.nothing'));
      const meta = { files: toSend.map((f) => f.path) };
      if (files.length && folderUpload) meta.source_kind = 'folder';
      if (!entryRow.hidden && entrySel.value) meta.entry = entrySel.value;
      if (artifactId) meta.artifact_id = artifactId;
      else {
        meta.title = title.value.trim() || suggestedTitle;
        meta.visibility = visibility || 'private';
      }
      const up = await api('POST', '/api/v1/uploads', meta);
      progress.hidden = false;
      let done = 0;
      let next = 0;
      let failed = false;
      const worker = async () => {
        while (!failed && next < toSend.length) {
          const f = toSend[next++];
          const res = await fetch(`/api/v1/uploads/${up.upload_id}/files/${encodePath(f.path)}`, { method: 'PUT', body: f.blob, credentials: 'same-origin' });
          if (!res.ok) {
            failed = true;
            const d = await res.json().catch(() => ({}));
            throw new Error(`${f.path}: ${errorText(d?.error?.code, d?.error?.message || String(res.status))}`);
          }
          done++;
          bar.style.width = `${(done / toSend.length) * 100}%`;
          status.textContent = t('upload.progress', { done, total: toSend.length });
        }
      };
      try {
        const results = await Promise.allSettled(
          Array.from({ length: Math.min(6, toSend.length) }, () =>
            worker().catch((e) => {
              failed = true;
              throw e;
            }),
          ),
        );
        const err = results.find((r) => r.status === 'rejected');
        if (err) throw err.reason;
        status.textContent = t('upload.publishing');
        const a = await api('POST', `/api/v1/uploads/${up.upload_id}/commit`);
        toast(artifactId ? t('upload.published') : t('upload.created'));
        onDone(a);
      } catch (e) {
        // All workers have settled here, so no PUT can land after the delete.
        fetch(`/api/v1/uploads/${up.upload_id}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
        progress.hidden = true;
        bar.style.width = '0';
        status.textContent = '';
        throw e;
      }
    });
    publishing = false;
  });

  return h(
    'div',
    { class: 'stack' },
    artifactId ? null : h('div', { class: 'grid2' }, h('label', { class: 'field' }, t('upload.title'), title), h('div', { class: 'field' }, h('label', { class: 'field' }, t('upload.access')), seg)),
    drop,
    list,
    entryRow,
    paste,
    progress,
    h('div', { class: 'row' }, submit, status),
  );
}

function viewNew() {
  mount(
    h('div', { class: 'page-head' }, h('h1', {}, t('new.title')), h('a', { class: 'btn', href: '#/' }, t('common.cancel'))),
    h('div', { class: 'card' }, uploadPanel({ onDone: (a) => go(`/a/${a.id}`) })),
  );
}

// ---------------- detail ----------------

async function viewDetail(id) {
  const seq = ++routeSeq;
  const useWae = !!me?.analytics_enabled;
  const artifactReq = api('GET', `/api/v1/artifacts/${id}`);
  const versionsReq = api('GET', `/api/v1/artifacts/${id}/versions`);
  const filesReq = api('GET', `/api/v1/artifacts/${id}/files`);
  const viewsReq = useWae
    ? api('GET', `/api/v1/analytics/views?ids=${encodeURIComponent(id)}`).then(
        (res) => ({ ok: true, res }),
        () => ({ ok: false }),
      )
    : null;

  let a;
  let versions;
  let files;
  try {
    [a, versions, files] = await Promise.all([artifactReq, versionsReq, filesReq]);
  } catch (e) {
    if (seq !== routeSeq) return;
    toast(e.message, 'error');
    if (e instanceof ApiError && (e.status === 401 || e.code === 'password_setup_required')) return;
    return go('/');
  }
  if (seq !== routeSeq) return;

  const openBtn = h('a', { class: 'btn primary', href: a.url, target: '_blank', rel: 'noopener' }, t('detail.open'));
  const linkCodeEl = h('code', {}, a.url);
  const updatedVal = h('div', { class: 'v' }, fmtAgo(a.updated_at));
  const title = h('input', { value: a.title, placeholder: t('common.untitled') });
  const visHelp = h('p', { class: 'muted' }, t(`detail.help.${a.visibility}`));

  const passwordBox = h('div', { class: 'row', hidden: a.visibility !== 'password' });
  let passwordCodeEl = null;
  function renderPasswordBox() {
    if (a.visibility !== 'password') {
      passwordBox.hidden = true;
      passwordBox.replaceChildren();
      passwordCodeEl = null;
      return;
    }
    if (!passwordCodeEl) {
      passwordCodeEl = h('span', { class: 'code' }, a.password ?? '');
      const reset = h(
        'button',
        {
          class: 'sm',
          type: 'button',
          onclick: () =>
            confirm(t('detail.regenerateConfirm')) &&
            act(reset, () =>
              api('POST', `/api/v1/artifacts/${id}/password/reset`).then((r) => {
                syncArtifact(r);
                toast(t('detail.regenerated'));
              }),
            ),
        },
        t('detail.regenerate'),
      );
      passwordBox.replaceChildren(
        passwordCodeEl,
        h('div', { class: 'grow' }),
        h('button', { class: 'sm', type: 'button', onclick: () => copy(a.password, t('detail.codeCopied')) }, t('detail.copyCode')),
        h('button', { class: 'sm', type: 'button', onclick: () => copy(`${a.url}?pwd=${a.password}`, t('detail.linkCodeCopied')) }, t('detail.copyLinkCode')),
        reset,
      );
    } else {
      passwordCodeEl.textContent = a.password ?? '';
    }
    passwordBox.hidden = false;
  }

  const segBtns = {};
  const seg = h(
    'div',
    { class: 'seg' },
    ...VISIBILITIES.map((v) => {
      const b = h(
        'button',
        {
          type: 'button',
          class: v === a.visibility ? 'on' : '',
          onclick: () => v !== a.visibility && act(b, () => patch({ visibility: v })),
        },
        visLabel(v),
      );
      segBtns[v] = b;
      return b;
    }),
  );

  const indexable = h('input', {
    type: 'checkbox',
    checked: a.indexable,
    disabled: a.visibility !== 'public',
    onchange: () =>
      act(null, () =>
        patch({ indexable: indexable.checked }).catch((e) => {
          indexable.checked = a.indexable;
          throw e;
        }),
      ),
  });
  const spa = h('input', {
    type: 'checkbox',
    checked: a.spa_fallback,
    onchange: () =>
      act(null, () =>
        patch({ spa_fallback: spa.checked }).catch((e) => {
          spa.checked = a.spa_fallback;
          throw e;
        }),
      ),
  });
  const entryFiles = files.items.filter((f) => f.path === a.entry || /\.(?:html?|md|markdown)$/i.test(f.path)).map((f) => f.path);
  const entry = h(
    'select',
    {
      onchange: () =>
        act(null, () =>
          patch({ entry: entry.value }).catch((e) => {
            entry.value = a.entry;
            throw e;
          }),
        ),
    },
    ...entryFiles.map((p) => h('option', { value: p, selected: p === a.entry }, p)),
  );

  function syncArtifact(r) {
    a = { ...a, ...r };
    title.value = a.title;
    linkCodeEl.textContent = a.url;
    openBtn.href = a.url;
    for (const [v, b] of Object.entries(segBtns)) b.classList.toggle('on', v === a.visibility);
    visHelp.textContent = t(`detail.help.${a.visibility}`);
    renderPasswordBox();
    indexable.checked = a.indexable;
    indexable.disabled = a.visibility !== 'public';
    spa.checked = a.spa_fallback;
    if (entryFiles.includes(a.entry)) entry.value = a.entry;
    updatedVal.textContent = fmtAgo(a.updated_at);
  }

  renderPasswordBox();

  const patch = (body) =>
    api('PATCH', `/api/v1/artifacts/${id}`, body).then((r) => {
      syncArtifact(r);
      toast(t('common.saved'));
      return r;
    });

  const regenLink = h('button', { class: 'sm', type: 'button' }, t('detail.regenLink'));
  regenLink.onclick = () => {
    if (!confirm(t('detail.regenLinkConfirm'))) return;
    const resetPassword = a.visibility === 'password' && confirm(t('detail.regenLinkAlsoCode'));
    act(regenLink, () =>
      api('POST', `/api/v1/artifacts/${id}/regenerate-link`, { reset_password: resetPassword }).then((r) => {
        syncArtifact(r);
        toast(t('detail.linkRegenerated'));
      }),
    );
  };
  const saveTitle = h('button', { class: 'sm', onclick: () => act(saveTitle, () => patch({ title: title.value })) }, t('common.save'));

  const del = h(
    'button',
    {
      class: 'danger',
      onclick: () =>
        confirm(t('detail.deleteConfirm', { title: a.title || t('common.untitled') })) &&
        act(del, async () => {
          await api('DELETE', `/api/v1/artifacts/${id}`);
          toast(t('detail.deleted'));
          go('/');
        }),
    },
    t('detail.delete'),
  );

  const versionRows = versions.items.map((v) => {
    const btn = h(
      'button',
      { class: 'sm', onclick: () => act(btn, () => api('POST', `/api/v1/artifacts/${id}/versions/${v.version}/activate`).then(() => (toast(t('detail.madeLive', { v: v.version })), viewDetail(id)))) },
      t('detail.makeLive'),
    );
    return h(
      'tr',
      {},
      h('td', { class: 'mono' }, `v${v.version}`),
      h('td', { class: 'muted' }, t('detail.versionFiles', { n: v.file_count, size: fmtBytes(v.total_size) })),
      h('td', { class: 'muted hide-sm' }, fmtDate(v.created_at)),
      h('td', { class: 'muted hide-sm small' }, v.created_by?.startsWith('token') ? t('detail.viaApi') : t('detail.viaWeb')),
      h('td', {}, v.version === versions.current_version ? h('span', { class: 'badge public' }, t('detail.live')) : btn),
    );
  });

  const fileListBody = h('tbody');
  let filesRendered = false;
  const fileListDetails = h(
    'details',
    { class: 'card' },
    h('summary', {}, h('strong', {}, t('detail.fileList', { n: files.items.length }))),
    h('div', { class: 'table-wrap', style: 'margin-top:12px' }, h('table', { class: 'table' }, fileListBody)),
  );
  fileListDetails.addEventListener('toggle', () => {
    if (!fileListDetails.open || filesRendered) return;
    filesRendered = true;
    const frag = document.createDocumentFragment();
    for (const f of files.items) {
      frag.append(
        h(
          'tr',
          {},
          h('td', { class: 'mono small' }, f.path),
          h('td', { class: 'muted small' }, fmtBytes(f.size)),
          h('td', {}, h('a', { class: 'small', href: `/api/v1/artifacts/${id}/files/${encodePath(f.path)}` }, t('detail.download'))),
        ),
      );
    }
    fileListBody.append(frag);
  });

  let analyticsCard = null;
  if (useWae) {
    let analyticsState = 'idle'; // 'idle' | 'loading' | 'loaded'
    const hint = h('span', { class: 'muted small an-summary-hint' }, t('analytics.detailHint'));
    const body = h('div', { class: 'an-detail-body' });
    analyticsCard = h(
      'details',
      { class: 'card an-details' },
      h('summary', {}, h('span', { class: 'an-summary-left' }, h('strong', {}, t('analytics.title'))), hint),
      body,
    );
    const loadDetailAnalytics = async () => {
      if (analyticsState !== 'idle') return;
      analyticsState = 'loading';
      body.replaceChildren(h('p', { class: 'muted small an-loading' }, t('analytics.loading')));
      try {
        const { createAnalyticsPanel } = await import('./analytics.js');
        if (seq !== routeSeq || !analyticsCard.isConnected) return;
        analyticsState = 'loaded';
        const panel = createAnalyticsPanel({
          api,
          artifactId: id,
          kind: a.kind,
          onRangeChange: (r) => {
            hint.textContent = t(`analytics.range.${r}`);
          },
        });
        body.replaceChildren(h('div', { class: 'an-detail-head' }, panel.controls), panel.root);
        hint.textContent = t(`analytics.range.${panel.getRange()}`);
        panel.load();
      } catch {
        if (seq !== routeSeq || !analyticsCard.isConnected) return;
        analyticsState = 'idle';
        const retry = h('button', { type: 'button', class: 'sm', onclick: () => loadDetailAnalytics() }, t('analytics.retry'));
        body.replaceChildren(h('div', { class: 'card an-error' }, h('p', { class: 'err' }, t('analytics.loadFailed')), retry));
      }
    };
    analyticsCard.addEventListener('toggle', () => {
      if (analyticsCard.open) loadDetailAnalytics();
    });
  }

  const viewsLabel = useWae ? [t('detail.views'), infoTip(t('list.colViews90dHint'))] : t('detail.views');
  const viewsVal = useWae ? h('div', { class: 'v muted' }, '…') : h('div', { class: 'v' }, a.view_count);

  mount(
    h('div', { class: 'page-head' }, h('div', { class: 'row' }, h('a', { href: '#/', class: 'muted' }, t('detail.back'))), openBtn),
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, title), saveTitle),
        h('div', { class: 'linkbox' }, linkCodeEl, h('button', { class: 'sm', onclick: () => copy(a.url, t('detail.linkCopied')) }, t('common.copy')), regenLink),
        h(
          'div',
          { class: 'stats' },
          ...[
            [t('detail.type'), a.kind === 'folder' ? t('detail.kindFolder') : t(a.kind === 'markdown' ? 'detail.kindMarkdown' : 'detail.kindHtml')],
            [t('detail.version'), `v${a.current_version}`],
            [t('detail.files'), a.file_count],
            [t('detail.size'), fmtBytes(a.total_size)],
            [viewsLabel, viewsVal],
            [t('detail.updated'), updatedVal],
          ].map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), v instanceof Node ? v : h('div', { class: 'v' }, v))),
        ),
      ),
      h('div', { class: 'card stack' }, h('h2', {}, t('detail.access')), seg, visHelp, passwordBox),
      h(
        'div',
        { class: 'card stack' },
        h('h2', {}, t('detail.options')),
        h('label', { class: 'check' }, indexable, t('detail.indexable'), h('span', { class: 'muted small' }, t('detail.indexableHint'))),
        h('label', { class: 'check' }, spa, t('detail.spa'), h('span', { class: 'muted small' }, t('detail.spaHint'))),
        entryFiles.length > 1 ? h('label', { class: 'field' }, t('detail.entry'), entry) : null,
      ),
      analyticsCard,
      h('div', { class: 'card stack' }, h('h2', {}, t('detail.uploadNew')), uploadPanel({ artifactId: id, currentEntry: () => a.entry, onDone: () => viewDetail(id) })),
      h('div', { class: 'card stack' }, h('h2', {}, t('detail.versions')), h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', {}, versionRows)))),
      fileListDetails,
      h('div', { class: 'row' }, del),
    ),
  );

  if (viewsReq) {
    viewsReq.then((out) => {
      if (seq !== routeSeq || !viewsVal.isConnected) return;
      if (out.ok) {
        viewsVal.classList.remove('muted');
        viewsVal.textContent = out.res?.enabled ? Number(out.res.views?.[id] ?? 0).toLocaleString(locale()) : '—';
      } else {
        viewsVal.textContent = '—';
        viewsVal.title = t('analytics.loadFailed');
      }
    });
  }
}

// ---------------- tokens ----------------

async function viewTokens(justCreated) {
  const data = await api('GET', '/api/v1/tokens');
  const name = h('input', { placeholder: t('tokens.namePlaceholder'), required: true, maxlength: 100 });
  const create = h('button', { class: 'primary', type: 'submit' }, t('tokens.create'));

  const rows = data.items.map((tk) => {
    const revoke = h(
      'button',
      {
        class: 'sm danger',
        onclick: () => confirm(t('tokens.revokeConfirm', { name: tk.name })) && act(revoke, () => api('DELETE', `/api/v1/tokens/${tk.id}`).then(() => (toast(t('tokens.revoked')), viewTokens()))),
      },
      t('tokens.revoke'),
    );
    return h(
      'tr',
      {},
      h('td', {}, h('strong', {}, tk.name)),
      h('td', { class: 'mono muted' }, `${tk.prefix}…`),
      h('td', { class: 'muted hide-sm' }, fmtDate(tk.created_at)),
      h('td', { class: 'muted' }, fmtAgo(tk.last_used_at)),
      h('td', {}, revoke),
    );
  });

  const createdBox = justCreated
    ? h(
        'div',
        { class: 'stack' },
        h('p', {}, h('strong', {}, t('tokens.created', { name: justCreated.name })), ' ', t('tokens.copyNow')),
        h('div', { class: 'row' }, h('div', { class: 'secret grow' }, justCreated.token), h('button', { type: 'button', onclick: () => copy(justCreated.token, t('tokens.tokenCopied')) }, t('common.copy'))),
      )
    : null;

  const base = location.origin;
  const snippet = `TOKEN=as_xxx

${t('tokens.snipHtml')}
curl -X POST "${base}/api/v1/artifacts?title=Demo&visibility=public" \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/html" \\
  --data-binary @demo.html

${t('tokens.snipFolder')}
curl -X POST "${base}/api/v1/artifacts?visibility=password" \\
  -H "Authorization: Bearer $TOKEN" \\
  -F "file=@dist/index.html;filename=index.html" \\
  -F "file=@dist/app.js;filename=app.js"

${t('tokens.snipUpdate')}
curl -X PUT "${base}/api/v1/artifacts/$ID/content" \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/html" \\
  --data-binary @demo.html`;

  mount(
    h('div', { class: 'page-head' }, h('h1', {}, t('tokens.title'))),
    h(
      'div',
      { class: 'stack' },
      h(
        'form',
        {
          class: 'card stack',
          onsubmit: (e) => {
            e.preventDefault();
            act(create, async () => viewTokens(await api('POST', '/api/v1/tokens', { name: name.value })));
          },
        },
        h('h2', {}, t('tokens.createTitle')),
        h('p', { class: 'muted' }, t('tokens.desc')),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, name), create),
        createdBox,
      ),
      rows.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'table' },
              h(
                'thead',
                {},
                h('tr', {}, h('th', {}, t('tokens.colName')), h('th', {}, t('tokens.colToken')), h('th', { class: 'hide-sm' }, t('tokens.colCreated')), h('th', {}, t('tokens.colLastUsed')), h('th', {})),
              ),
              h('tbody', {}, rows),
            ),
          )
        : h('div', { class: 'card empty' }, t('tokens.empty')),
      h('details', { class: 'card' }, h('summary', {}, h('strong', {}, t('tokens.examples'))), h('pre', { class: 'snippet', style: 'margin-top:12px' }, snippet)),
    ),
  );
}

// ---------------- settings ----------------

async function viewSettings(query) {
  if (query.get('sso_bound')) toast(t('sso.bound'));
  if (query.get('sso_error')) toast(errorText(query.get('sso_error'), query.get('detail') || query.get('sso_error')), 'error');
  if (query.get('sso_bound') || query.get('sso_error')) history.replaceState(null, '', '#/settings');

  const [s, sso] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/settings/sso')]);
  const MB = 1024 * 1024;
  const reload = () => viewSettings(new URLSearchParams());
  // On failure, re-render from the server so controls (e.g. a toggled checkbox) don't show an unsaved state.
  const save = (patch, btn) =>
    act(btn, () =>
      api('PATCH', '/api/settings', patch).then(
        () => (toast(t('settings.saved')), reload()),
        (e) => {
          reload();
          throw e;
        },
      ),
    );

  // defaults
  const defVis = h('select', {}, ...VISIBILITIES.map((v) => h('option', { value: v, selected: v === s.default_visibility }, visLabel(v))));
  const defIdx = h('input', { type: 'checkbox', checked: s.default_indexable });
  const visitorDl = h('input', { type: 'checkbox', checked: s.visitor_download_enabled });
  const keep = h('input', { type: 'number', min: 1, max: 100, value: s.keep_versions });
  const maxFile = h('input', { type: 'number', min: 1, max: 100, value: Math.round(s.max_file_bytes / MB) });
  const maxFiles = h('input', { type: 'number', min: 1, max: 10000, value: s.max_version_files });
  const saveGeneral = h('button', { class: 'primary', type: 'button' }, t('common.save'));
  saveGeneral.onclick = () =>
    save(
      {
        default_visibility: defVis.value,
        default_indexable: defIdx.checked,
        visitor_download_enabled: visitorDl.checked,
        keep_versions: Number(keep.value),
        max_file_bytes: Number(maxFile.value) * MB,
        max_version_files: Number(maxFiles.value),
      },
      saveGeneral,
    );

  // zip
  const unzip = h('input', { type: 'checkbox', checked: s.server_unzip_enabled });
  const unzipFiles = h('input', { type: 'number', min: 1, max: 950, value: s.unzip_max_files });
  const unzipBytes = h('input', { type: 'number', min: 1, max: 48, value: Math.round(s.unzip_max_bytes / MB) });
  const saveZip = h('button', { class: 'primary', type: 'button' }, t('common.save'));
  saveZip.onclick = () => save({ server_unzip_enabled: unzip.checked, unzip_max_files: Number(unzipFiles.value), unzip_max_bytes: Number(unzipBytes.value) * MB }, saveZip);

  // security
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const npw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const savePw = h('button', { type: 'button' }, t('settings.changePw'));
  savePw.onclick = () =>
    act(savePw, () =>
      api('PUT', '/api/settings/password', { current_password: cur.value, new_password: npw.value }).then(() => {
        cur.value = npw.value = '';
        toast(t('settings.pwChanged'));
      }),
    );
  const uname = h('input', { type: 'text', value: me?.username || '', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 64 });
  const saveUser = h('button', { type: 'button' }, t('settings.changeUsername'));
  saveUser.onclick = () =>
    act(saveUser, () =>
      api('PUT', '/api/settings/username', { username: uname.value, current_password: cur.value }).then((r) => {
        if (me) me.username = r.username;
        cur.value = '';
        toast(t('settings.usernameChanged'));
      }),
    );
  const pwLogin = h('input', { type: 'checkbox', checked: s.password_login_enabled, onchange: () => save({ password_login_enabled: pwLogin.checked }) });
  const logoutAll = h('button', { class: 'danger', type: 'button' }, t('settings.logoutAll'));
  logoutAll.onclick = () =>
    confirm(t('settings.logoutAllConfirm')) &&
    act(logoutAll, () =>
      api('POST', '/api/auth/logout-all').then(() => {
        me = null;
        go('/login');
      }),
    );

  // sso
  const ssoCards = sso.items.map((p) => {
    const cid = h('input', { value: p.client_id || '', autocomplete: 'off', spellcheck: 'false' });
    const secret = h('input', { type: 'password', placeholder: p.has_secret ? t('sso.secretSaved') : '', autocomplete: 'new-password' });
    const issuer = p.provider === 'cloudflare' ? h('input', { value: p.issuer || '', placeholder: 'https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>', spellcheck: 'false' }) : null;
    const enabled = h('input', { type: 'checkbox', checked: p.enabled });
    const saveBtn = h('button', { type: 'button', class: 'primary sm' }, t('common.save'));
    saveBtn.onclick = () =>
      act(saveBtn, async () => {
        const body = { client_id: cid.value, enabled: enabled.checked };
        if (secret.value) body.client_secret = secret.value;
        if (issuer) body.issuer = issuer.value;
        await api('PUT', `/api/settings/sso/${p.provider}`, body);
        toast(t('sso.saved', { name: p.name }));
        reload();
      });
    const unbind = h('button', { type: 'button', class: 'sm danger' }, t('sso.unbind'));
    unbind.onclick = () =>
      confirm(t('sso.unbindConfirm', { name: p.bound?.display })) && act(unbind, () => api('DELETE', `/api/settings/sso/${p.provider}/binding`).then(() => (toast(t('sso.unbound')), reload())));
    const bindLink = h('a', { class: 'btn sm', href: `/api/auth/oauth/${p.provider}/start?purpose=bind` }, p.bound ? t('sso.rebind') : t('sso.bind'));
    const configured = p.client_id && p.has_secret;
    const state = p.enabled && p.bound ? h('span', { class: 'badge public' }, t('sso.active')) : h('span', { class: 'badge' }, p.enabled ? t('sso.notBound') : t('sso.off'));

    return h(
      'div',
      { class: 'card stack' },
      h('div', { class: 'sso-head' }, h('h2', { style: 'margin:0' }, p.name), state),
      h('p', { class: 'muted small' }, t(`sso.help.${p.provider}`)),
      h('label', { class: 'field' }, t('sso.callback'), h('div', { class: 'linkbox' }, h('code', {}, p.callback_url), h('button', { type: 'button', class: 'sm', onclick: () => copy(p.callback_url) }, t('common.copy')))),
      issuer ? h('label', { class: 'field' }, t('sso.issuer'), issuer) : null,
      h('label', { class: 'field' }, t('sso.clientId'), cid),
      h('label', { class: 'field' }, t('sso.clientSecret'), secret),
      h('label', { class: 'check' }, enabled, t('sso.enable')),
      h('div', { class: 'row' }, saveBtn),
      h('div', { class: 'divider' }),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }, p.bound ? h('span', {}, t('sso.boundTo'), h('strong', {}, p.bound.display)) : h('span', { class: 'muted' }, t('sso.noAccount'))),
        configured ? bindLink : null,
        p.bound ? unbind : null,
      ),
    );
  });

  mount(
    h('div', { class: 'page-head' }, h('h1', {}, t('settings.title'))),
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'grid2' },
        h(
          'div',
          { class: 'card stack' },
          h('h2', {}, t('settings.defaults')),
          h('label', { class: 'field' }, t('settings.defaultVis'), defVis),
          h('label', { class: 'check' }, defIdx, t('settings.defaultIdx')),
          h('label', { class: 'check' }, visitorDl, t('settings.visitorDownload')),
          h('p', { class: 'muted small' }, t('settings.visitorDownloadHint')),
          h('label', { class: 'field' }, t('settings.keep'), keep),
          h('label', { class: 'field' }, t('settings.maxFile'), maxFile),
          h('label', { class: 'field' }, t('settings.maxFiles'), maxFiles),
          h('div', { class: 'row' }, saveGeneral),
        ),
        h(
          'div',
          { class: 'stack' },
          h(
            'div',
            { class: 'card stack' },
            h('h2', {}, t('settings.zip')),
            h('p', { class: 'muted small' }, t('settings.zipDesc')),
            h('label', { class: 'check' }, unzip, t('settings.enable')),
            h('label', { class: 'field' }, t('settings.zipFiles'), unzipFiles),
            h('label', { class: 'field' }, t('settings.zipBytes'), unzipBytes),
            h('div', { class: 'row' }, saveZip),
          ),
          h(
            'div',
            { class: 'card stack' },
            h('h2', {}, t('settings.security')),
            h('label', { class: 'field' }, t('settings.currentPw'), h('span', { class: 'hint' }, t('settings.currentPwHint')), cur),
            h('label', { class: 'field' }, t('login.username'), uname),
            h('div', { class: 'row' }, saveUser),
            h('label', { class: 'field' }, t('settings.newPw'), npw),
            h('div', { class: 'row' }, savePw),
            h('div', { class: 'divider' }),
            h('label', { class: 'check' }, pwLogin, t('settings.allowPw')),
            h('p', { class: 'muted small' }, t('settings.allowPwHint')),
            h('div', { class: 'row' }, logoutAll),
          ),
        ),
      ),
      h('h2', { style: 'margin-top:12px' }, t('settings.sso')),
      h('p', { class: 'muted', style: 'margin-top:-8px' }, t('settings.ssoDesc')),
      h('div', { class: 'grid2' }, ssoCards),
    ),
  );
}

applyChrome();
render();
