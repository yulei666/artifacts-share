// Lightweight UI strings (zh / en) shared by ui.js and the share viewer.
// Language: saved choice → browser languages → Chinese.

export const CORE_DICT = {
  zh: {
    'nav.signOut': '退出登录',
    'nav.menu': '菜单',
    'lang.switch': 'EN',
    'lang.switchFull': 'English',
    'lang.switchTitle': 'Switch to English',

    'common.copied': '已复制',
    'common.copyFailed': '复制失败',
    'common.untitled': '未命名',
    'common.githubProject': 'GitHub 项目',

    'vis.private': '私有',
    'vis.public': '公开',
    'vis.password': '访问码',

    'login.captchaLoadFailed': '人机验证加载失败，请刷新页面重试',

    'viewer.copyLink': '复制链接',
    'viewer.copyLinkCode': '复制链接 + 访问码',
    'viewer.openRaw': '在新标签页中打开',
    'viewer.manage': '管理',
    'viewer.protected': '受访问码保护的内容',
    'viewer.notFoundTitle': '未找到',
    'viewer.notFoundDesc': '该内容不存在或无法访问。',
    'viewer.ownerSignIn': '所有者登录',
    'viewer.signIn': '登录',
    'viewer.share': '分享',
    'share.title': '分享',
    'share.desc.private': '只有你可以查看',
    'share.desc.public': '拿到链接的任何人都可以查看',
    'share.desc.password': '拿到链接和访问码的人可以查看',
    'share.code': '访问码',
    'share.link': '链接',
    'share.copyLinkOnly': '仅复制链接（不含访问码）',
    'share.privateHint': '目前只有你能打开这个链接。',
    'share.changed': '已改为「{v}」',
    'viewer.download': '下载',
    'dl.source': '下载源文件',
    'dl.zip': '下载 ZIP',
    'dl.sourceTitle': '下载源文件：{name}（{size}）',
    'dl.zipTitle': '下载 ZIP：{name}（{n} 个文件，{size}）',
    'dl.codeDesc': '输入访问码后即可下载。',
    'dl.submit': '下载',
    'dl.started': '开始下载',

    'detail.linkCopied': '链接已复制',
    'detail.access': '访问权限',
    'detail.copyCode': '复制访问码',
    'detail.codeCopied': '访问码已复制',
    'detail.linkCodeCopied': '带访问码的链接已复制',
    'detail.regenerate': '重新生成',
    'detail.regenerateConfirm': '确定生成新的访问码吗？之前的访问码会立即失效。',
    'detail.regenerated': '已生成新的访问码',

    'err.turnstile_required': '请先完成人机验证',
    'err.rate_limited': '尝试次数过多，请稍后再试',
    'err.not_found': '内容不存在',
    'err.unauthorized': '请先登录',
    'err.csrf': '请求来源不合法',
    'err.not_password_protected': '该 artifact 不是访问码模式',
    'err.incorrect_code': '访问码不正确',
    'err.incorrect_code_left': '访问码不正确，还可以再试 {n} 次',
    'err.rate_limited_wait': '尝试次数过多，请在 {n} 分钟后重试',
    'err.download_disabled': '此内容未开放下载',
    'err.download_code_required': '请输入访问码后下载',
  },

  en: {
    'nav.signOut': 'Sign out',
    'nav.menu': 'Menu',
    'lang.switch': '中文',
    'lang.switchFull': '中文',
    'lang.switchTitle': '切换到中文',

    'common.copied': 'Copied',
    'common.copyFailed': 'Copy failed',
    'common.untitled': 'Untitled',
    'common.githubProject': 'GitHub project',

    'vis.private': 'Private',
    'vis.public': 'Public',
    'vis.password': 'Access code',

    'login.captchaLoadFailed': 'The verification failed to load. Refresh the page and try again.',

    'viewer.copyLink': 'Copy link',
    'viewer.copyLinkCode': 'Copy link + code',
    'viewer.openRaw': 'Open in a new tab',
    'viewer.manage': 'Manage',
    'viewer.protected': 'Protected artifact',
    'viewer.notFoundTitle': 'Not found',
    'viewer.notFoundDesc': 'This artifact does not exist or is not available.',
    'viewer.ownerSignIn': 'Owner sign-in',
    'viewer.signIn': 'Sign in',
    'viewer.share': 'Share',
    'share.title': 'Share',
    'share.desc.private': 'Only you can view',
    'share.desc.public': 'Anyone with the link can view',
    'share.desc.password': 'Anyone with the link and access code can view',
    'share.code': 'Access code',
    'share.link': 'Link',
    'share.copyLinkOnly': 'Copy link without the code',
    'share.privateHint': 'Only you can open this link right now.',
    'share.changed': 'Changed to {v}',
    'viewer.download': 'Download',
    'dl.source': 'Download source file',
    'dl.zip': 'Download ZIP',
    'dl.sourceTitle': 'Download source file: {name} ({size})',
    'dl.zipTitle': 'Download ZIP: {name} ({n} files, {size})',
    'dl.codeDesc': 'Enter the access code to download.',
    'dl.submit': 'Download',
    'dl.started': 'Download started',

    'detail.linkCopied': 'Link copied',
    'detail.access': 'Access',
    'detail.copyCode': 'Copy code',
    'detail.codeCopied': 'Code copied',
    'detail.linkCodeCopied': 'Link with code copied',
    'detail.regenerate': 'Regenerate',
    'detail.regenerateConfirm': 'Generate a new code? The current code stops working immediately.',
    'detail.regenerated': 'New code generated',

    'err.turnstile_required': 'Complete the verification first',
    'err.rate_limited': 'Too many attempts, try again later',
    'err.not_found': 'Not found',
    'err.unauthorized': 'Please sign in',
    'err.csrf': 'Request origin rejected',
    'err.not_password_protected': 'This artifact is not in access-code mode',
    'err.incorrect_code': 'Incorrect access code',
    'err.incorrect_code_left': 'Incorrect access code. {n} attempt(s) left',
    'err.rate_limited_wait': 'Too many attempts. Try again in {n} minute(s)',
    'err.download_disabled': 'Downloads are not available for this artifact',
    'err.download_code_required': 'Enter the access code to download',
  },
};

export const DICT = {
  zh: { ...CORE_DICT.zh },
  en: { ...CORE_DICT.en },
};

// Errors whose server message carries useful specifics (file names, limits).
const DETAILED = new Set();

export function registerStrings(strings, detailed) {
  if (strings?.zh) Object.assign(DICT.zh, strings.zh);
  if (strings?.en) Object.assign(DICT.en, strings.en);
  if (detailed) {
    for (const code of detailed) DETAILED.add(code);
  }
}

const STORAGE_KEY = 'artifacts-share.lang';

function detect() {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* storage unavailable */
  }
  const langs = typeof navigator !== 'undefined' ? navigator.languages || (navigator.language ? [navigator.language] : []) : [];
  for (const l of langs) {
    const base = String(l).toLowerCase().split('-')[0];
    if (base === 'zh' || base === 'en') return base;
  }
  return 'zh';
}

export let lang = detect();
if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

export function setLang(l) {
  lang = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* ignore */
  }
}

export function t(key, params) {
  let s = DICT[lang][key] ?? DICT.en[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return s;
}

/** Translates an API error code (using structured details when present); falls back to the server message. */
export function errorText(code, message, details) {
  if (code === 'rate_limited' && typeof details?.retry_after === 'number') return t('err.rate_limited_wait', { n: Math.max(1, Math.ceil(details.retry_after / 60)) });
  if (code === 'incorrect_code' && typeof details?.remaining === 'number') return t('err.incorrect_code_left', { n: details.remaining });
  const key = `err.${code}`;
  if (!code || !(key in DICT[lang])) return message || code || 'Error';
  if (DETAILED.has(code) && message) return lang === 'zh' ? `${t(key)}（${message}）` : `${t(key)} (${message})`;
  return t(key);
}

export const locale = () => (lang === 'zh' ? 'zh-CN' : 'en-US');
