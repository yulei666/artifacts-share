import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { classifyHost, contentOrigin } from '../src/lib/hosts';

const ID = '0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
const env = (suffix?: string) => ({ MAIN_HOST: 'share.example.com', CONTENT_ZONE: 'example-content.com', CONTENT_HOST_SUFFIX: suffix }) as Env;

describe('host classification', () => {
  it('defaults to the -share suffix', () => {
    expect(classifyHost(env(), `${ID}-share.example-content.com`)).toEqual({ kind: 'content', id: ID });
    expect(contentOrigin(env(), ID, new URL('https://share.example.com/'))).toBe(`https://${ID}-share.example-content.com`);
  });

  it('honours a custom suffix and rejects the old one', () => {
    expect(classifyHost(env('-s'), `${ID}-s.example-content.com`)).toEqual({ kind: 'content', id: ID });
    expect(classifyHost(env('-s'), `${ID}-share.example-content.com`).kind).toBe('unknown');
    expect(contentOrigin(env('-view'), ID, new URL('http://share.localhost:8787/'))).toBe(`http://${ID}-view.example-content.com:8787`);
  });

  it('supports an empty suffix', () => {
    expect(classifyHost(env(''), `${ID}.example-content.com`)).toEqual({ kind: 'content', id: ID });
  });

  it('rejects suffixes that cannot form a DNS label', () => {
    for (const bad of ['-share.', 'sh_are', '-', 'x'.repeat(28)]) {
      expect(() => classifyHost(env(bad), `${ID}${bad}.example-content.com`), bad).toThrow(/CONTENT_HOST_SUFFIX/);
    }
  });

  it('matches the main host and ignores everything else', () => {
    expect(classifyHost(env(), 'SHARE.example.com')).toEqual({ kind: 'main' });
    expect(classifyHost(env(), 'evil.example-content.com').kind).toBe('unknown');
    expect(classifyHost(env(), `${ID}-share.example-content.com.evil.com`).kind).toBe('unknown');
    expect(classifyHost(env(), `x${ID}-share.example-content.com`).kind).toBe('unknown');
  });
});

import { safeRelativePath } from '../src/lib/http';

describe('safeRelativePath', () => {
  it.each([
    ['/ok?x=1#h', '/ok?x=1#h'],
    ['/a/b', '/a/b'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['/\t/evil.com', '/'],
    ['/\n/evil.com', '/'],
    ['/.//evil.com', '/'],
    ['/%2e//evil.com', '/'],
    ['/a/..//evil.com', '/'],
    ['https://evil.com', '/'],
    ['evil.com', '/'],
    ['', '/'],
    [null, '/'],
  ])('%j → %s', (input, expected) => {
    expect(safeRelativePath(input)).toBe(expected);
  });
});

import { mainOrigin } from '../src/lib/hosts';

describe('origins are lowercase', () => {
  it('matches what browsers send in Origin', () => {
    const env = { MAIN_HOST: 'Share.Example.com', CONTENT_ZONE: 'Example-Content.com' } as Env;
    expect(mainOrigin(env, new URL('https://share.example.com/'))).toBe('https://share.example.com');
    expect(contentOrigin(env, ID, new URL('https://share.example.com/'))).toBe(`https://${ID}-share.example-content.com`);
  });
});
