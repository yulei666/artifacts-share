import { describe, expect, it } from 'vitest';
import { pickLang } from '../src/content/pages';

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
