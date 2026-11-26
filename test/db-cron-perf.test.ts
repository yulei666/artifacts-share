import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eachRow, runCleanup } from '../src/cron';
import type { Env } from '../src/env';
import worker from '../src/index';
import { invalidateSettingsCache } from '../src/lib/settings';
import { r2Key } from '../src/lib/store';

const MAIN = 'https://share.example.com';
const ORIGIN = { origin: MAIN };

function makeCtx() {
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      waits.push(Promise.resolve(p));
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    flush: async () => {
      while (waits.length) {
        const batch = waits.splice(0);
        await Promise.allSettled(batch);
      }
    },
  };
}

async function callWorker(testEnv: Env, url: string, init: RequestInit = {}) {
  const { ctx, flush } = makeCtx();
  const req = new Request(url, { redirect: 'manual', ...init }) as Request<unknown, IncomingRequestCfProperties<unknown>>;
  const res = await worker.fetch(req, testEnv, ctx);
  return { res, flush };
}

function cookieFrom(res: Response, name: string): string {
  const all = res.headers.getSetCookie();
  const c = all.find((s) => s.startsWith(`__Host-${name}=`));
  if (!c) throw new Error(`cookie ${name} not set; got ${JSON.stringify(all)}`);
  return c.split(';')[0];
}

async function json<T = any>(res: Response, status?: number): Promise<T> {
  const text = await res.text();
  if (status !== undefined && res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${text}`);
  return text ? JSON.parse(text) : (null as T);
}

let token = '';

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const { res, flush } = await callWorker(env as unknown as Env, `${MAIN}${path}`, { ...init, headers });
  await flush();
  return res;
}

async function createHtml(html: string, query = ''): Promise<any> {
  return json(await api(`/api/v1/artifacts${query}`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: html }), 201);
}

async function explainDetails(sql: string, binds: unknown[] = []): Promise<string[]> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
  return results.map((r) => r.detail);
}

beforeAll(async () => {
  const baseEnv = env as unknown as Env;
  let { res, flush } = await callWorker(baseEnv, `${MAIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ username: 'admin', password: 'bootstrap-pass' }),
  });
  await flush();
  if (res.status === 200) {
    const body = await json<any>(res, 200);
    if (body.needs_password_setup) {
      const boot = cookieFrom(res, 'as_session');
      ({ res, flush } = await callWorker(baseEnv, `${MAIN}/api/settings/password`, {
        method: 'PUT',
        headers: { cookie: boot, 'content-type': 'application/json', ...ORIGIN },
        body: JSON.stringify({ new_password: 'correct horse battery' }),
      }));
      await flush();
      await json(res, 200);
    }
  }
  ({ res, flush } = await callWorker(baseEnv, `${MAIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
  }));
  await flush();
  await json(res, 200);
  const session = cookieFrom(res, 'as_session');

  ({ res, flush } = await callWorker(baseEnv, `${MAIN}/api/v1/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: session, ...ORIGIN },
    body: JSON.stringify({ name: 'db-cron-perf-test' }),
  }));
  await flush();
  token = (await json<{ token: string }>(res, 201)).token;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('D1 partial/composite indexes (0005_perf_indexes.sql)', () => {
  it('registers all expected performance indexes via migrations', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
    ).all<{ name: string }>();
    const names = new Set(results.map((r) => r.name));
    expect(names.has('idx_artifacts_active_updated')).toBe(true);
    expect(names.has('idx_artifacts_active_vis_updated')).toBe(true);
    expect(names.has('idx_artifacts_deleted')).toBe(true);
    expect(names.has('idx_uploads_artifact_version')).toBe(true);
    expect(names.has('idx_uploads_expires')).toBe(true);
    expect(names.has('idx_artifact_versions_pending')).toBe(true);
    expect(names.has('idx_artifact_versions_ready')).toBe(true);
  });

  it('uses partial composite indexes without temp B-tree sort for active list and row-value cursor pagination', async () => {
    const listPlan = await explainDetails(
      `SELECT a.*, v.file_count, v.total_size FROM artifacts a
       LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.current_version
       WHERE a.deleted_at IS NULL ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`,
      [51],
    );
    expect(listPlan.some((d) => d.includes('idx_artifacts_active_updated'))).toBe(true);
    expect(listPlan.some((d) => d.includes('USE TEMP B-TREE FOR ORDER BY'))).toBe(false);

    const cursorPlan = await explainDetails(
      `SELECT a.*, v.file_count, v.total_size FROM artifacts a
       LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.current_version
       WHERE a.deleted_at IS NULL AND (a.updated_at, a.id) < (?, ?) ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`,
      [1_700_000_000, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 51],
    );
    expect(cursorPlan.some((d) => d.includes('idx_artifacts_active_updated'))).toBe(true);
    expect(cursorPlan.some((d) => d.includes('USE TEMP B-TREE FOR ORDER BY'))).toBe(false);

    const visCursorPlan = await explainDetails(
      `SELECT a.*, v.file_count, v.total_size FROM artifacts a
       LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.current_version
       WHERE a.deleted_at IS NULL AND a.visibility = ? AND (a.updated_at, a.id) < (?, ?) ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`,
      ['public', 1_700_000_000, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 51],
    );
    expect(visCursorPlan.some((d) => d.includes('idx_artifacts_active_vis_updated'))).toBe(true);
    expect(visCursorPlan.some((d) => d.includes('USE TEMP B-TREE FOR ORDER BY'))).toBe(false);
  });

  it('uses dedicated indexes for cron pending, expired, deleted, and ready-version queries', async () => {
    const expiredUploadsPlan = (
      await explainDetails('SELECT * FROM uploads WHERE expires_at < ? ORDER BY RANDOM() LIMIT 100', [1_700_000_000])
    ).join('\n');
    expect(expiredUploadsPlan).toContain('idx_uploads_expires');

    const orphanVersionsPlan = (
      await explainDetails(
        `SELECT v.artifact_id, v.version FROM artifact_versions v
         LEFT JOIN uploads u ON u.artifact_id = v.artifact_id AND u.version = v.version
         WHERE v.status = 'uploading' AND u.id IS NULL AND v.created_at < ? ORDER BY RANDOM() LIMIT 100`,
        [1_700_000_000],
      )
    ).join('\n');
    const abortedVersionsPlan = (
      await explainDetails(
        "SELECT artifact_id, version FROM artifact_versions WHERE status = 'aborted' AND created_at < ? ORDER BY RANDOM() LIMIT 100",
        [1_700_000_000],
      )
    ).join('\n');
    const retiringVersionsPlan = (
      await explainDetails("SELECT artifact_id, version FROM artifact_versions WHERE status = 'retiring' ORDER BY RANDOM() LIMIT 100")
    ).join('\n');
    const deletedArtifactsPlan = (
      await explainDetails('SELECT id FROM artifacts WHERE deleted_at IS NOT NULL ORDER BY RANDOM() LIMIT 50')
    ).join('\n');
    const readyVersionsPlan = (
      await explainDetails(
        "SELECT version, file_count, total_size, created_at, created_by FROM artifact_versions WHERE artifact_id = ? AND status = 'ready' ORDER BY version DESC",
        ['00000000-0000-4000-8000-000000000001'],
      )
    ).join('\n');
    const surplusVersionsPlan = (
      await explainDetails(
        `WITH ranked AS (
           SELECT v.artifact_id, v.version, a.current_version,
                  ROW_NUMBER() OVER (PARTITION BY v.artifact_id ORDER BY v.version DESC) AS rn
           FROM artifact_versions v
           JOIN artifacts a ON a.id = v.artifact_id
           WHERE v.status = 'ready'
         )
         SELECT artifact_id, version FROM ranked
         WHERE rn > ? AND version != current_version
         ORDER BY RANDOM() LIMIT 200`,
        [5],
      )
    ).join('\n');

    expect(orphanVersionsPlan).toContain('idx_artifact_versions_pending');
    expect(orphanVersionsPlan).toContain('idx_uploads_artifact_version');
    expect(abortedVersionsPlan).toContain('idx_artifact_versions_pending');
    expect(retiringVersionsPlan).toContain('idx_artifact_versions_pending');
    expect(deletedArtifactsPlan).toContain('idx_artifacts_deleted');
    expect(readyVersionsPlan).toContain('idx_artifact_versions_ready');
    expect(readyVersionsPlan).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    expect(surplusVersionsPlan).toContain('idx_artifact_versions_ready');
  });
});

describe('row-value cursor pagination tie-breaking', () => {
  it('paginates cleanly across identical updated_at values with strict (updated_at DESC, id DESC) ordering', async () => {
    const created: { id: string; visibility: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const visibility = i % 2 === 0 ? 'public' : 'private';
      const a = await createHtml(`<h1>tie-${i}</h1>`, `?title=tie-${i}&visibility=${visibility}`);
      created.push({ id: a.id, visibility });
    }
    const deleted = await createHtml('<h1>deleted</h1>', '?title=deleted&visibility=public');

    // Give 5 artifacts the exact same updated_at timestamp and 1 an older timestamp.
    const sameTs = 2_000_000_100;
    const olderTs = 2_000_000_050;
    const stmts = created.map((a, idx) =>
      env.DB.prepare('UPDATE artifacts SET updated_at = ? WHERE id = ?').bind(idx < 5 ? sameTs : olderTs, a.id),
    );
    stmts.push(env.DB.prepare('UPDATE artifacts SET updated_at = ?, deleted_at = ? WHERE id = ?').bind(sameTs, sameTs, deleted.id));
    await env.DB.batch(stmts);

    try {
      const collectAll = async (extraQuery = '') => {
        const seen: { id: string; updated_at: number; visibility: string }[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const qs: string = `?limit=2${extraQuery}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
          const page: { items: { id: string; updated_at: number; visibility: string }[]; next_cursor: string | null } = await json(
            await api(`/api/v1/artifacts${qs}`),
            200,
          );
          seen.push(...page.items);
          cursor = page.next_cursor;
          pages++;
          expect(pages).toBeLessThan(20);
        } while (cursor);
        return { seen, pages };
      };

      const { seen, pages } = await collectAll();
      expect(pages).toBeGreaterThanOrEqual(3);

      const expectedOrder = [...created]
        .map((a, idx) => ({ ...a, updated_at: idx < 5 ? sameTs : olderTs }))
        .sort((x, y) => (y.updated_at !== x.updated_at ? y.updated_at - x.updated_at : y.id < x.id ? -1 : y.id > x.id ? 1 : 0));

      const ourIds = new Set(created.map((c) => c.id));
      const matched = seen.filter((item) => ourIds.has(item.id));
      expect(matched.map((item) => item.id)).toEqual(expectedOrder.map((item) => item.id));
      expect(seen.some((item) => item.id === deleted.id)).toBe(false);
      // No duplicates across pages.
      expect(new Set(seen.map((item) => item.id)).size).toBe(seen.length);

      // Visibility-filtered cursor pagination with identical updated_at values.
      const { seen: pubSeen } = await collectAll('&visibility=public');
      const expectedPub = expectedOrder.filter((item) => item.visibility === 'public');
      const matchedPub = pubSeen.filter((item) => ourIds.has(item.id));
      expect(matchedPub.map((item) => item.id)).toEqual(expectedPub.map((item) => item.id));
      expect(pubSeen.every((item) => item.visibility === 'public')).toBe(true);
    } finally {
      const allIds = [...created.map((c) => c.id), deleted.id];
      await env.DB.batch([
        ...allIds.map((id) => env.DB.prepare('DELETE FROM artifact_files WHERE artifact_id = ?').bind(id)),
        ...allIds.map((id) => env.DB.prepare('DELETE FROM artifact_versions WHERE artifact_id = ?').bind(id)),
        ...allIds.map((id) => env.DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id)),
      ]);
    }
  });
});

describe('cron surplus versions window function & bounded concurrency', () => {
  it('retires only older non-live surplus versions while preserving keep_versions newest and rolled-back current_version', async () => {
    const baseEnv = env as unknown as Env;
    const prevKeep = await env.DB.prepare("SELECT value FROM settings WHERE key = 'keep_versions'").first<{ value: string }>();
    const nowSec = Math.floor(Date.now() / 1000);

    const artLatest = crypto.randomUUID();
    const artRolledBack = crypto.randomUUID();
    const artNullCurrent = crypto.randomUUID();

    const seedArtifact = async (id: string, currentVersion: number | null, versions: { v: number; status: string }[]) => {
      await env.DB.prepare(
        `INSERT INTO artifacts (id, public_id, title, kind, visibility, entry, current_version, created_at, updated_at)
         VALUES (?, ?, ?, 'html', 'private', 'index.html', ?, ?, ?)`,
      )
        .bind(id, crypto.randomUUID(), `surplus-${id}`, currentVersion, nowSec, nowSec)
        .run();
      for (const { v, status } of versions) {
        await env.DB.prepare(
          `INSERT INTO artifact_versions (artifact_id, version, status, entry, kind, file_count, total_size, created_at)
           VALUES (?, ?, ?, 'index.html', 'html', 1, 10, ?)`,
        )
          .bind(id, v, status, nowSec)
          .run();
        await env.DB.prepare(
          `INSERT INTO artifact_files (artifact_id, version, path, size, content_type)
           VALUES (?, ?, 'index.html', 10, 'text/html')`,
        )
          .bind(id, v)
          .run();
        await env.BUCKET.put(r2Key(id, v, 'index.html'), `v${v}`);
      }
    };

    try {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('keep_versions', '2', ?)").bind(nowSec).run();
      invalidateSettingsCache();

      // Latest live (v5) + non-ready v6 (recent aborted, must not count toward keep_versions=2)
      await seedArtifact(artLatest, 5, [
        { v: 1, status: 'ready' },
        { v: 2, status: 'ready' },
        { v: 3, status: 'ready' },
        { v: 4, status: 'ready' },
        { v: 5, status: 'ready' },
        { v: 6, status: 'aborted' },
      ]);

      // Rolled back to oldest version (v1); v5 & v4 kept as newest 2, v1 kept as current_version, v2 & v3 purged.
      await seedArtifact(artRolledBack, 1, [
        { v: 1, status: 'ready' },
        { v: 2, status: 'ready' },
        { v: 3, status: 'ready' },
        { v: 4, status: 'ready' },
        { v: 5, status: 'ready' },
      ]);

      // current_version IS NULL: matches original `v.version != a.current_version` (NULL comparison excludes all).
      await seedArtifact(artNullCurrent, null, [
        { v: 1, status: 'ready' },
        { v: 2, status: 'ready' },
        { v: 3, status: 'ready' },
        { v: 4, status: 'ready' },
      ]);

      await runCleanup(baseEnv);

      const statuses = async (id: string) => {
        const { results } = await env.DB.prepare('SELECT version, status FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC')
          .bind(id)
          .all<{ version: number; status: string }>();
        return Object.fromEntries(results.map((r) => [r.version, r.status]));
      };

      expect(await statuses(artLatest)).toEqual({
        1: 'purged',
        2: 'purged',
        3: 'purged',
        4: 'ready',
        5: 'ready',
        6: 'aborted',
      });
      expect(await env.BUCKET.get(r2Key(artLatest, 3, 'index.html'))).toBeNull();
      expect(await env.BUCKET.get(r2Key(artLatest, 4, 'index.html'))).not.toBeNull();
      expect(await env.BUCKET.get(r2Key(artLatest, 5, 'index.html'))).not.toBeNull();

      expect(await statuses(artRolledBack)).toEqual({
        1: 'ready',
        2: 'purged',
        3: 'purged',
        4: 'ready',
        5: 'ready',
      });
      expect(await env.BUCKET.get(r2Key(artRolledBack, 1, 'index.html'))).not.toBeNull();
      expect(await env.BUCKET.get(r2Key(artRolledBack, 2, 'index.html'))).toBeNull();
      expect(await env.BUCKET.get(r2Key(artRolledBack, 3, 'index.html'))).toBeNull();
      expect(await env.BUCKET.get(r2Key(artRolledBack, 4, 'index.html'))).not.toBeNull();
      expect(await env.BUCKET.get(r2Key(artRolledBack, 5, 'index.html'))).not.toBeNull();

      expect(await statuses(artNullCurrent)).toEqual({
        1: 'ready',
        2: 'ready',
        3: 'ready',
        4: 'ready',
      });
    } finally {
      if (prevKeep) {
        await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('keep_versions', ?, ?)").bind(prevKeep.value, nowSec).run();
      } else {
        await env.DB.prepare("DELETE FROM settings WHERE key = 'keep_versions'").run();
      }
      invalidateSettingsCache();
      for (const id of [artLatest, artRolledBack, artNullCurrent]) {
        for (let v = 1; v <= 6; v++) {
          await env.BUCKET.delete(r2Key(id, v, 'index.html')).catch(() => {});
        }
        await env.DB.batch([
          env.DB.prepare('DELETE FROM artifact_files WHERE artifact_id = ?').bind(id),
          env.DB.prepare('DELETE FROM artifact_versions WHERE artifact_id = ?').bind(id),
          env.DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id),
        ]);
      }
    }
  });

  it('eachRow bounds concurrency and isolates per-row failures without aborting sibling rows', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const items = Array.from({ length: 12 }, (_, i) => i);
    const failing = new Set([1, 5, 9]);
    const succeeded: number[] = [];
    let active = 0;
    let maxActive = 0;

    await eachRow(
      'test-step',
      items,
      async (n) => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          if (n === 5) throw new Error(`sync boom ${n}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (failing.has(n)) throw new Error(`async boom ${n}`);
          succeeded.push(n);
        } finally {
          active--;
        }
      },
      4,
    );

    expect(active).toBe(0);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(succeeded.sort((a, b) => a - b)).toEqual(items.filter((n) => !failing.has(n)));
    expect(errSpy).toHaveBeenCalledTimes(failing.size);

    // Edge cases: empty list and fewer rows than concurrency limit.
    await expect(eachRow('empty', [], async () => {})).resolves.toBeUndefined();
    const tiny: number[] = [];
    await eachRow(
      'tiny',
      [10, 20],
      async (n) => {
        tiny.push(n);
      },
      4,
    );
    expect(tiny.sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it('runCleanup isolates a failing deleted-artifact purge without aborting sibling artifacts', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const baseEnv = env as unknown as Env;
    const nowSec = Math.floor(Date.now() / 1000);
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const failId = ids[1];

    try {
      for (const id of ids) {
        await env.DB.prepare(
          `INSERT INTO artifacts (id, public_id, title, kind, visibility, entry, current_version, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, 'html', 'private', 'index.html', 1, ?, ?, ?)`,
        )
          .bind(id, crypto.randomUUID(), `del-${id}`, nowSec, nowSec, nowSec - 60)
          .run();
        await env.BUCKET.put(r2Key(id, 1, 'index.html'), 'gone');
      }

      const flakyBucket = new Proxy(baseEnv.BUCKET, {
        get(target, prop, receiver) {
          if (prop === 'list') {
            return (opts?: R2ListOptions) => {
              if (opts?.prefix?.includes(failId)) {
                return Promise.reject(new Error('simulated r2 failure'));
              }
              return target.list(opts);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      await runCleanup({ ...baseEnv, BUCKET: flakyBucket });

      const remaining = await env.DB.prepare(
        `SELECT id FROM artifacts WHERE id IN (?, ?, ?)`,
      )
        .bind(ids[0], ids[1], ids[2])
        .all<{ id: string }>();

      expect(remaining.results.map((r) => r.id)).toEqual([failId]);
      expect(await env.BUCKET.get(r2Key(ids[0], 1, 'index.html'))).toBeNull();
      expect(await env.BUCKET.get(r2Key(ids[2], 1, 'index.html'))).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      for (const id of ids) {
        await env.BUCKET.delete(r2Key(id, 1, 'index.html')).catch(() => {});
        await env.DB.batch([
          env.DB.prepare('DELETE FROM artifact_files WHERE artifact_id = ?').bind(id),
          env.DB.prepare('DELETE FROM artifact_versions WHERE artifact_id = ?').bind(id),
          env.DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id),
        ]);
      }
    }
  });
});
