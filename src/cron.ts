import type { Env } from './env';
import { now } from './lib/http';
import { purgeRateLimits } from './lib/ratelimit';
import { getSettings } from './lib/settings';
import { abortUpload, purgeArtifact, purgeVersionFiles, retireVersion, type UploadRow } from './lib/store';

/**
 * Deletes manifest rows whose upload session is gone, `batch` rows per statement and at most `maxBatches`
 * statements per run. Returns the number of rows deleted. 5k rows per statement keeps each DELETE short, well
 * inside D1's per-statement time limit; 100 statements a run still clear up to 500k orphan rows a day, and a
 * bigger backlog is worked off over the following days.
 */
export async function sweepOrphanManifests(env: Env, batch = 5_000, maxBatches = 100): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const res = await env.DB.prepare(
      `DELETE FROM upload_expected WHERE rowid IN (
         SELECT e.rowid FROM upload_expected e WHERE NOT EXISTS (SELECT 1 FROM uploads u WHERE u.id = e.upload_id) LIMIT ?
       )`,
    )
      .bind(batch)
      .run();
    deleted += res.meta.changes;
    if (res.meta.changes < batch) break;
  }
  return deleted;
}

const CLEANUP_CONCURRENCY = 4;

/**
 * Runs `fn` over `rows` with bounded concurrency (`limit`). Each row is isolated: one failure is logged
 * and skipped without stopping sibling or remaining rows.
 */
export async function eachRow<T>(
  name: string,
  rows: T[],
  fn: (row: T) => Promise<void>,
  limit = CLEANUP_CONCURRENCY,
): Promise<void> {
  if (!rows.length) return;
  const workers = Math.min(Math.max(1, Math.floor(limit)), rows.length);
  let next = 0;
  const run = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        await fn(row);
      } catch (e) {
        console.error(`cleanup "${name}" failed for`, row, e);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
}

/**
 * Daily cleanup: stale uploads, deleted artifacts, surplus versions, expired auth state.
 * Every step — and every row within a step — is isolated: one failure is logged and skipped, it doesn't
 * stop the rest. Rows are picked in random order so a persistently failing row can't block a step forever.
 */
export async function runCleanup(env: Env): Promise<void> {
  const t = now();

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.error(`cleanup step "${name}" failed`, e);
    }
  };

  await step('expired uploads', async () => {
    const { results } = await env.DB.prepare('SELECT * FROM uploads WHERE expires_at < ? ORDER BY RANDOM() LIMIT 100').bind(t).all<UploadRow>();
    await eachRow('expired upload', results, (u) => abortUpload(env, u));
  });

  // Versions left in 'uploading' without an upload row (e.g. a crashed direct upload). Marked 'aborted'
  // rather than deleted, so the version number is never handed out again.
  await step('orphan versions', async () => {
    const { results } = await env.DB.prepare(
      "SELECT v.artifact_id, v.version FROM artifact_versions v LEFT JOIN uploads u ON u.artifact_id = v.artifact_id AND u.version = v.version WHERE v.status = 'uploading' AND u.id IS NULL AND v.created_at < ? ORDER BY RANDOM() LIMIT 100",
    )
      .bind(t - 3600)
      .all<{ artifact_id: string; version: number }>();
    await eachRow('orphan version', results, async (o) => {
      await env.DB.prepare("UPDATE artifact_versions SET status = 'aborted' WHERE artifact_id = ? AND version = ? AND status = 'uploading'").bind(o.artifact_id, o.version).run();
      await purgeVersionFiles(env, o.artifact_id, o.version);
    });
  });

  // Aborted version rows reserve their number. After a day (no late writer can still be around), remove
  // whatever an abort failed to clean up, then mark the row 'retired' — kept (it's tiny), so MAX(version)+1
  // never hands the number out again. A failed purge leaves it 'aborted' and is retried tomorrow.
  await step('aborted versions', async () => {
    const { results } = await env.DB.prepare("SELECT artifact_id, version FROM artifact_versions WHERE status = 'aborted' AND created_at < ? ORDER BY RANDOM() LIMIT 100")
      .bind(t - 86400)
      .all<{ artifact_id: string; version: number }>();
    await eachRow('aborted version', results, async (v) => {
      await purgeVersionFiles(env, v.artifact_id, v.version);
      // Keep the row only where a number could be reused: an artifact that exists. A first upload that never
      // committed has no artifact row (and a fresh id) — nothing to protect, so drop it instead of hoarding it.
      await env.DB.batch([
        env.DB.prepare("UPDATE artifact_versions SET status = 'retired' WHERE artifact_id = ?1 AND version = ?2 AND status = 'aborted' AND EXISTS (SELECT 1 FROM artifacts WHERE id = ?1)").bind(v.artifact_id, v.version),
        env.DB.prepare("DELETE FROM artifact_versions WHERE artifact_id = ?1 AND version = ?2 AND status = 'aborted' AND NOT EXISTS (SELECT 1 FROM artifacts WHERE id = ?1)").bind(v.artifact_id, v.version),
      ]);
    });
  });

  // Versions whose retirement was interrupted (purge failed): finish the job.
  await step('retiring versions', async () => {
    const { results } = await env.DB.prepare("SELECT artifact_id, version FROM artifact_versions WHERE status = 'retiring' ORDER BY RANDOM() LIMIT 100").all<{ artifact_id: string; version: number }>();
    await eachRow('retiring version', results, async (v) => void (await retireVersion(env, v.artifact_id, v.version)));
  });

  await step('deleted artifacts', async () => {
    const { results } = await env.DB.prepare('SELECT id FROM artifacts WHERE deleted_at IS NOT NULL ORDER BY RANDOM() LIMIT 50').all<{ id: string }>();
    await eachRow('deleted artifact', results, (d) => purgeArtifact(env, d.id));
  });

  await step('surplus versions', async () => {
    const { keep_versions } = await getSettings(env, { fresh: true });
    const { results } = await env.DB.prepare(
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
    )
      .bind(keep_versions)
      .all<{ artifact_id: string; version: number }>();
    // retireVersion re-checks "not live" atomically: a rollback during this loop must not lose its files.
    await eachRow('surplus version', results, async (s) => void (await retireVersion(env, s.artifact_id, s.version)));
  });

  // Manifest rows whose session is gone (committed/aborted/expired, or a cleanup that failed part-way).
  // Deleted in bounded batches, like every other step: a large backlog is worked off over successive
  // batches/days instead of one huge DELETE that could time out (and roll back) every single day.
  await step('orphan upload manifests', async () => void (await sweepOrphanManifests(env)));

  await step('expired auth state', async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(t),
      env.DB.prepare('DELETE FROM used_nonces WHERE expires_at < ?').bind(t),
    ]);
  });
  await step('rate limits', () => purgeRateLimits(env));
}
