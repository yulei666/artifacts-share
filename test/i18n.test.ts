import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { pickLang } from '../src/content/pages';
// @ts-expect-error -- browser ES module without .d.ts
import * as i18nCore from '../web/i18n-core.js';
// @ts-expect-error -- browser ES module without .d.ts
import * as i18nFull from '../web/i18n.js';

type Dict = { zh: Record<string, string>; en: Record<string, string> };

const CORE_DICT = i18nCore.CORE_DICT as Dict;
const ADMIN_DICT = i18nFull.ADMIN_DICT as Dict;
const FULL_DICT = i18nFull.DICT as Dict;

function placeholders(str: string): string[] {
  return [...new Set([...str.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

function assertDictParity(name: string, dict: Dict) {
  const zhKeys = Object.keys(dict.zh).sort();
  const enKeys = Object.keys(dict.en).sort();
  expect(zhKeys, `${name}: zh and en keys must match`).toEqual(enKeys);
  for (const key of zhKeys) {
    expect(dict.zh[key].length, `${name}: zh[${key}] must be non-empty`).toBeGreaterThan(0);
    expect(dict.en[key].length, `${name}: en[${key}] must be non-empty`).toBeGreaterThan(0);
    expect(placeholders(dict.zh[key]), `${name}: placeholders mismatch for ${key}`).toEqual(placeholders(dict.en[key]));
  }
}

/** Extracts literal string keys passed to `t(...)` (including ternary expressions like `t(cond ? 'a' : 'b')`). */
function extractLiteralI18nKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/\bt\(\s*'([a-zA-Z0-9._-]+)'/g)) {
    keys.add(m[1]);
  }
  for (const m of source.matchAll(/\bt\([^)]*\?\s*'([a-zA-Z0-9._-]+)'\s*:\s*'([a-zA-Z0-9._-]+)'\s*\)/g)) {
    keys.add(m[1]);
    keys.add(m[2]);
  }
  return [...keys].sort();
}

async function readAsset(path: string): Promise<string> {
  const res = await env.ASSETS.fetch(new Request(`https://share.example.com${path}`));
  expect(res.status, `asset ${path} should exist`).toBe(200);
  return res.text();
}

describe('pickLang', () => {
  it.each([
    [null, 'zh'],
    ['', 'zh'],
    ['zh-CN,zh;q=0.9', 'zh'],
    ['zh-TW', 'zh'],
    ['en-US,en;q=0.9', 'en'],
    ['fr-FR, en;q=0.8', 'en'], // first supported language wins
    ['en;q=0.5, zh;q=0.9', 'zh'], // q-values respected
    ['de, fr', 'zh'], // nothing supported → Chinese
    ['en;q=0, zh', 'zh'], // q=0 means "not acceptable"
  ])('%s → %s', (header, expected) => {
    expect(pickLang(header)).toBe(expected);
  });
});

describe('browser i18n core/admin split', () => {
  afterEach(() => {
    i18nCore.setLang('zh');
  });

  it('maintains zh/en key and placeholder parity across core, admin, and merged dictionaries', () => {
    assertDictParity('CORE_DICT', CORE_DICT);
    assertDictParity('ADMIN_DICT', ADMIN_DICT);
    assertDictParity('FULL_DICT', FULL_DICT);

    const coreKeys = new Set(Object.keys(CORE_DICT.zh));
    const adminKeys = new Set(Object.keys(ADMIN_DICT.zh));
    const overlap = [...coreKeys].filter((k) => adminKeys.has(k));
    expect(overlap, 'CORE_DICT and ADMIN_DICT must not duplicate keys').toEqual([]);

    const union = [...new Set([...coreKeys, ...adminKeys])].sort();
    expect(Object.keys(FULL_DICT.zh).sort()).toEqual(union);
    expect(Object.keys(FULL_DICT.en).sort()).toEqual(union);
  });

  it('contains every i18n key referenced by web/viewer.js and web/ui.js in i18n-core.js', async () => {
    const [viewerSrc, uiSrc] = await Promise.all([readAsset('/viewer.js'), readAsset('/ui.js')]);
    const referenced = new Set<string>([
      ...extractLiteralI18nKeys(viewerSrc),
      ...extractLiteralI18nKeys(uiSrc),
      // Dynamic visibility keys built via VISIBILITIES in viewer.js: `vis.${v}` and `share.desc.${v}`.
      'vis.private',
      'vis.public',
      'vis.password',
      'share.desc.private',
      'share.desc.public',
      'share.desc.password',
      // Viewer / unlock / download / share-popover API error codes handled by errorText() in ui.js.
      'err.turnstile_required',
      'err.rate_limited',
      'err.rate_limited_wait',
      'err.not_found',
      'err.unauthorized',
      'err.csrf',
      'err.not_password_protected',
      'err.incorrect_code',
      'err.incorrect_code_left',
      'err.download_disabled',
      'err.download_code_required',
    ]);

    expect(referenced.size).toBeGreaterThan(30);
    for (const key of referenced) {
      expect(key in CORE_DICT.zh, `missing ${key} in CORE_DICT.zh`).toBe(true);
      expect(key in CORE_DICT.en, `missing ${key} in CORE_DICT.en`).toBe(true);
    }

    // Ensure viewer.js and ui.js import from i18n-core.js rather than full i18n.js.
    expect(viewerSrc).toContain("from './i18n-core.js'");
    expect(viewerSrc).not.toContain("from './i18n.js'");
    expect(uiSrc).toContain("from './i18n-core.js'");
    expect(uiSrc).not.toContain("from './i18n.js'");
  });

  it('contains every i18n key referenced by web/app.js, web/analytics.js, and web/index.html in full i18n.js', async () => {
    const [appSrc, analyticsSrc, indexHtml] = await Promise.all([
      readAsset('/app.js'),
      readAsset('/analytics.js'),
      readAsset('/index.html'),
    ]);
    const htmlKeys = [...indexHtml.matchAll(/data-i18n="([a-zA-Z0-9._-]+)"/g)].map((m) => m[1]);
    const referenced = new Set<string>([
      ...extractLiteralI18nKeys(appSrc),
      ...extractLiteralI18nKeys(analyticsSrc),
      ...htmlKeys,
    ]);

    expect(referenced.size).toBeGreaterThan(50);
    for (const key of referenced) {
      expect(key in FULL_DICT.zh, `missing ${key} in FULL_DICT.zh`).toBe(true);
      expect(key in FULL_DICT.en, `missing ${key} in FULL_DICT.en`).toBe(true);
    }
  });

  it('keeps i18n-core.js lightweight compared to the full dictionary', async () => {
    const [coreSrc, adminSrc] = await Promise.all([readAsset('/i18n-core.js'), readAsset('/i18n.js')]);
    const coreBytes = new TextEncoder().encode(coreSrc).byteLength;
    const totalBytes = coreBytes + new TextEncoder().encode(adminSrc).byteLength;
    expect(coreBytes).toBeLessThan(10_000);
    expect(coreBytes).toBeLessThan(totalBytes / 3);
  });

  it('keeps runtime exports backward-compatible and live-bound between i18n-core.js and i18n.js', () => {
    expect(i18nFull.t).toBe(i18nCore.t);
    expect(i18nFull.errorText).toBe(i18nCore.errorText);
    expect(i18nFull.setLang).toBe(i18nCore.setLang);
    expect(i18nFull.locale).toBe(i18nCore.locale);

    i18nCore.setLang('en');
    expect(i18nCore.lang).toBe('en');
    expect(i18nFull.lang).toBe('en');
    expect(i18nFull.locale()).toBe('en-US');
    expect(i18nCore.t('share.changed', { v: 'Public' })).toBe('Changed to Public');
    expect(i18nFull.t('detail.madeLive', { v: 3 })).toBe('Version 3 is live');
    expect(i18nCore.errorText('rate_limited', 'Too many', { retry_after: 120 })).toBe('Too many attempts. Try again in 2 minute(s)');
    expect(i18nCore.errorText('incorrect_code', 'Wrong', { remaining: 2 })).toBe('Incorrect access code. 2 attempt(s) left');
    expect(i18nCore.errorText('file_too_large', 'big.html exceeds 10 MB')).toBe('File exceeds the size limit (big.html exceeds 10 MB)');
    expect(i18nCore.errorText('unknown_code', 'Server fallback')).toBe('Server fallback');

    i18nFull.setLang('zh');
    expect(i18nCore.lang).toBe('zh');
    expect(i18nFull.lang).toBe('zh');
    expect(i18nCore.locale()).toBe('zh-CN');
    expect(i18nCore.errorText('file_too_large', 'big.html exceeds 10 MB')).toBe('文件超过大小上限（big.html exceeds 10 MB）');
  });
});
