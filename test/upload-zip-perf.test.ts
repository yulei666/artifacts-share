import { env } from 'cloudflare:workers';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import worker from '../src/index';
import { HttpError } from '../src/lib/http';
import { getSettings } from '../src/lib/settings';
import {
  beginUpload,
  commitUpload,
  type IncomingFile,
  purgeArtifact,
  putUploadFile,
  r2Key,
  r2Prefix,
  uploadFiles,
} from '../src/lib/store';
import { PREFETCH_CONCURRENCY, PREFETCH_MAX_FILE_BYTES, streamZip, type ZipFile } from '../src/lib/zipstream';

const MAIN = 'https://share.example.com';

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
        await Promise.all(batch);
      }
    },
  };
}

function spyDb(base: D1Database): { db: D1Database; queries: string[] } {
  const queries: string[] = [];
  const db = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          queries.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, queries };
}

async function listR2Keys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const o of res.objects) keys.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return keys;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('direct uploadFiles batched D1 insert (Plan 2.3.1)', () => {
  it('batch-inserts artifact_files in far fewer than 2N D1 statements while storing all R2 objects', async () => {
    const baseEnv = env as unknown as Env;
    const settings = await getSettings(baseEnv, { fresh: true });
    const { db, queries } = spyDb(baseEnv.DB);
    const testEnv: Env = { ...baseEnv, DB: db };

    const fileCount = 24;
    const files: IncomingFile[] = [
      { path: 'site/index.html', body: '<!doctype html><h1>Batch</h1>' },
      ...Array.from({ length: fileCount - 1 }, (_, i) => ({
        path: `site/assets/file-${String(i).padStart(2, '0')}.js`,
        body: `export const id = ${i};\n`,
      })),
    ];

    const artifact = await uploadFiles(testEnv, files, {
      meta: { title: 'Batched Site', visibility: 'public' },
      createdBy: 'test',
      settings,
    });

    expect(artifact.current_version).toBe(1);
    expect(artifact.kind).toBe('folder');
    expect(artifact.entry).toBe('index.html');

    // Verify D1 statement reduction: single json_each INSERT instead of 2N per-file statements.
    const fileInserts = queries.filter((sql) => /INSERT INTO artifact_files/i.test(sql));
    const uploadWriteTouches = queries.filter((sql) => /upload_writes/i.test(sql) && /INSERT|DELETE/i.test(sql));
    expect(fileInserts).toHaveLength(1);
    expect(fileInserts[0]).toMatch(/json_each/i);
    expect(fileInserts[0]).toMatch(/WHERE EXISTS\s*\(\s*SELECT 1 FROM uploads/i);
    expect(uploadWriteTouches).toHaveLength(0);
    expect(queries.length).toBeLessThan(fileCount);

    // Verify all artifact_files rows and R2 objects match.
    const { results: dbFiles } = await baseEnv.DB.prepare(
      'SELECT path, size, content_type FROM artifact_files WHERE artifact_id = ? AND version = ? ORDER BY path',
    )
      .bind(artifact.id, 1)
      .all<{ path: string; size: number; content_type: string }>();
    expect(dbFiles).toHaveLength(fileCount);

    const r2Keys = await listR2Keys(baseEnv.BUCKET, r2Prefix(artifact.id, 1));
    expect(r2Keys).toHaveLength(fileCount);

    const indexObj = await baseEnv.BUCKET.get(r2Key(artifact.id, 1, 'index.html'));
    expect(await indexObj?.text()).toBe('<!doctype html><h1>Batch</h1>');
    const jsObj = await baseEnv.BUCKET.get(r2Key(artifact.id, 1, 'assets/file-05.js'));
    expect(await jsObj?.text()).toBe('export const id = 5;\n');

    // Validate oversized file is rejected before writing any R2 objects.
    const tightSettings = { ...settings, max_file_bytes: 10 };
    await expect(
      uploadFiles(
        baseEnv,
        [
          { path: 'index.html', body: '<h1>ok</h1>' }, // 11 bytes > 10
        ],
        { meta: { title: 'Too Big' }, createdBy: 'test', settings: tightSettings },
      ),
    ).rejects.toMatchObject({ status: 413, code: 'file_too_large' });

    // Resumable putUploadFile still works intact.
    const session = await beginUpload(baseEnv, { meta: { title: 'Resumable' }, createdBy: 'test' });
    await putUploadFile(baseEnv, session, 'index.html', '<h1>Session</h1>', settings);
    const committed = await commitUpload(baseEnv, session, settings);
    expect(committed.id).toBe(session.artifact_id);
    expect(committed.current_version).toBe(1);
  });

  it('leaves zero R2 orphan objects when purgeArtifact deletes the upload concurrently during uploadFiles', async () => {
    const baseEnv = env as unknown as Env;
    const settings = await getSettings(baseEnv, { fresh: true });

    // Create an initial artifact (v1).
    const initial = await uploadFiles(
      baseEnv,
      [{ path: 'index.html', body: '<h1>v1</h1>' }],
      { meta: { title: 'Race Victim', visibility: 'private' }, createdBy: 'test', settings },
    );

    // Intercept R2 puts during v2 upload: let the first put finish, run purgeArtifact (which deletes
    // the upload row and wipes R2 so far), and THEN let late puts write new objects to R2.
    let putCalls = 0;
    let purgeStarted = false;
    let releaseLatePuts!: () => void;
    const lateGate = new Promise<void>((r) => {
      releaseLatePuts = r;
    });

    const raceBucket = new Proxy(baseEnv.BUCKET, {
      get(target, prop, receiver) {
        if (prop === 'put') {
          return async (key: string, value: Parameters<R2Bucket['put']>[1], options?: R2PutOptions) => {
            const callIdx = ++putCalls;
            if (callIdx === 1 && !purgeStarted) {
              purgeStarted = true;
              const firstRes = await target.put(key, value, options);
              await purgeArtifact(baseEnv, initial.id);
              releaseLatePuts();
              return firstRes;
            }
            // Delay remaining concurrent puts until AFTER purgeArtifact's deletePrefix has already finished,
            // guaranteeing late R2 objects are written after purgeArtifact!
            await lateGate;
            return target.put(key, value, options);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const raceEnv: Env = { ...baseEnv, BUCKET: raceBucket };
    const v2Files: IncomingFile[] = Array.from({ length: 8 }, (_, idx) => ({
      path: idx === 0 ? 'index.html' : `part-${idx}.txt`,
      body: `payload-${idx}`,
    }));

    await expect(
      uploadFiles(raceEnv, v2Files, {
        artifactId: initial.id,
        meta: { title: 'Race v2' },
        createdBy: 'test',
        settings,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof HttpError && err.status === 404 && err.code === 'upload_not_found');

    // Critical guardrail: ZERO R2 orphan objects under either the artifact or v2 prefix, and ZERO DB rows.
    expect(await listR2Keys(baseEnv.BUCKET, r2Prefix(initial.id, 2))).toEqual([]);
    expect(await listR2Keys(baseEnv.BUCKET, r2Prefix(initial.id))).toEqual([]);
    const fileRowCount = await baseEnv.DB.prepare('SELECT COUNT(*) AS n FROM artifact_files WHERE artifact_id = ?')
      .bind(initial.id)
      .first<{ n: number }>();
    expect(fileRowCount?.n).toBe(0);
  });

  it('cleans up all R2 objects and marks version aborted when an R2 put fails mid-upload', async () => {
    const baseEnv = env as unknown as Env;
    const settings = await getSettings(baseEnv, { fresh: true });
    let capturedArtifactId = '';
    let putCalls = 0;

    const flakyBucket = new Proxy(baseEnv.BUCKET, {
      get(target, prop, receiver) {
        if (prop === 'put') {
          return async (key: string, value: Parameters<R2Bucket['put']>[1], options?: R2PutOptions) => {
            const match = /^a\/([^/]+)\/v(\d+)\//.exec(key);
            if (match) capturedArtifactId = match[1];
            putCalls++;
            if (putCalls === 3) throw new Error('injected R2 failure');
            return target.put(key, value, options);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const flakyEnv: Env = { ...baseEnv, BUCKET: flakyBucket };
    const files: IncomingFile[] = Array.from({ length: 6 }, (_, idx) => ({
      path: idx === 0 ? 'index.html' : `f${idx}.txt`,
      body: `data-${idx}`,
    }));

    await expect(
      uploadFiles(flakyEnv, files, { meta: { title: 'Flaky' }, createdBy: 'test', settings }),
    ).rejects.toThrow('injected R2 failure');

    expect(capturedArtifactId).toBeTruthy();
    expect(await listR2Keys(baseEnv.BUCKET, r2Prefix(capturedArtifactId, 1))).toEqual([]);
    const ver = await baseEnv.DB.prepare('SELECT status FROM artifact_versions WHERE artifact_id = ? AND version = 1')
      .bind(capturedArtifactId)
      .first<{ status: string }>();
    expect(ver?.status).toBe('aborted');
  });
});

describe('streamZip bounded small-file prefetch (Plan 2.3.3)', () => {
  it('streams mixed small (<= 1 MiB) and large (> 1 MiB) files with bounded concurrency and exact contents', async () => {
    const baseEnv = env as unknown as Env;
    const artifactId = crypto.randomUUID();
    const version = 1;

    const smallText = (label: string, repeat: number) => new TextEncoder().encode(`${label}:`.repeat(repeat));
    const largeBytes = new Uint8Array(PREFETCH_MAX_FILE_BYTES + 128 * 1024); // 1.125 MiB (> 1 MiB)
    for (let i = 0; i < largeBytes.length; i++) largeBytes[i] = (i * 31) & 0xff;

    const fixtures: { path: string; contentType: string; bytes: Uint8Array }[] = [
      { path: '01-index.html', contentType: 'text/html; charset=utf-8', bytes: smallText('html', 200) },
      { path: '02-app.js', contentType: 'application/javascript; charset=utf-8', bytes: smallText('js', 400) },
      { path: '03-empty.txt', contentType: 'text/plain; charset=utf-8', bytes: new Uint8Array(0) },
      { path: '04-style.css', contentType: 'text/css; charset=utf-8', bytes: smallText('css', 300) },
      { path: '05-large.bin', contentType: 'application/octet-stream', bytes: largeBytes },
      { path: '06-after-a.json', contentType: 'application/json', bytes: smallText('jsonA', 250) },
      { path: '07-after-b.txt', contentType: 'text/plain', bytes: smallText('txtB', 250) },
      { path: '08-after-c.bin', contentType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
    ];

    for (const f of fixtures) {
      await baseEnv.BUCKET.put(r2Key(artifactId, version, f.path), f.bytes, {
        httpMetadata: { contentType: f.contentType },
      });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    let largeArrayBufferCalled = false;
    const largeKey = r2Key(artifactId, version, '05-large.bin');

    const trackedBucket = new Proxy(baseEnv.BUCKET, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return async (key: string, options?: R2GetOptions) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
              const obj = await target.get(key, options);
              if (obj && key === largeKey) {
                return new Proxy(obj, {
                  get(oTarget, oProp, oReceiver) {
                    if (oProp === 'arrayBuffer') {
                      return () => {
                        largeArrayBufferCalled = true;
                        return oTarget.arrayBuffer();
                      };
                    }
                    const v = Reflect.get(oTarget, oProp, oTarget);
                    return typeof v === 'function' ? v.bind(oTarget) : v;
                  },
                });
              }
              return obj;
            } finally {
              inFlight--;
            }
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const zipFiles: ZipFile[] = fixtures.map((f) => ({
      path: f.path,
      size: f.bytes.byteLength,
      content_type: f.contentType,
    }));

    const { ctx, flush } = makeCtx();
    const stream = streamZip({ ...baseEnv, BUCKET: trackedBucket }, ctx, artifactId, version, zipFiles, new Date(1700000000 * 1000));
    const archiveBytes = await readStream(stream);
    await flush();

    // Small files prefetched concurrently (<= PREFETCH_CONCURRENCY) and large file was streamed, never arrayBuffer()'d.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(PREFETCH_CONCURRENCY + 1); // up to PREFETCH_CONCURRENCY small + 1 streaming large
    expect(largeArrayBufferCalled).toBe(false);

    const extracted = unzipSync(archiveBytes);
    expect(Object.keys(extracted).sort()).toEqual(fixtures.map((f) => f.path).sort());
    for (const f of fixtures) {
      expect(extracted[f.path].byteLength).toBe(f.bytes.byteLength);
      if (f.path === '05-large.bin') {
        expect(extracted[f.path][0]).toBe(f.bytes[0]);
        expect(extracted[f.path][f.bytes.length - 1]).toBe(f.bytes[f.bytes.length - 1]);
        expect(Buffer.compare(Buffer.from(extracted[f.path]), Buffer.from(f.bytes))).toBe(0);
      } else {
        expect(strFromU8(extracted[f.path])).toBe(strFromU8(f.bytes));
      }
    }
  });

  it('propagates missing R2 object errors cleanly without unhandled rejections', async () => {
    const baseEnv = env as unknown as Env;
    const artifactId = crypto.randomUUID();
    const version = 1;

    await baseEnv.BUCKET.put(r2Key(artifactId, version, 'a.txt'), 'alpha');
    // 'b.txt' intentionally missing from R2 (will fail inside prefetch).
    await baseEnv.BUCKET.put(r2Key(artifactId, version, 'c.txt'), 'charlie');

    const files: ZipFile[] = [
      { path: 'a.txt', size: 5, content_type: 'text/plain' },
      { path: 'b.txt', size: 5, content_type: 'text/plain' },
      { path: 'c.txt', size: 7, content_type: 'text/plain' },
    ];

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, flush } = makeCtx();
    const stream = streamZip(baseEnv, ctx, artifactId, version, files, new Date());

    await expect(readStream(stream)).rejects.toThrow(/missing object for b\.txt/);
    await expect(flush()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it('preserves the real missing-object error when a later prefetch fails before an earlier valid get resolves', async () => {
    const baseEnv = env as unknown as Env;
    const artifactId = crypto.randomUUID();
    const version = 1;

    await baseEnv.BUCKET.put(r2Key(artifactId, version, 'a.txt'), 'alpha');
    // 'b.txt' intentionally missing from R2.
    await baseEnv.BUCKET.put(r2Key(artifactId, version, 'c.txt'), 'charlie');

    const aKey = r2Key(artifactId, version, 'a.txt');
    const bKey = r2Key(artifactId, version, 'b.txt');
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });

    const orderedBucket = new Proxy(baseEnv.BUCKET, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return async (key: string, options?: R2GetOptions) => {
            if (key === aKey) {
              // Hold a.txt until AFTER b.txt has already returned null and failed its prefetch.
              await aGate;
              return target.get(key, options);
            }
            const res = await target.get(key, options);
            if (key === bKey) {
              queueMicrotask(() => releaseA());
            }
            return res;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const files: ZipFile[] = [
      { path: 'a.txt', size: 5, content_type: 'text/plain' },
      { path: 'b.txt', size: 5, content_type: 'text/plain' },
      { path: 'c.txt', size: 7, content_type: 'text/plain' },
    ];

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, flush } = makeCtx();
    const stream = streamZip({ ...baseEnv, BUCKET: orderedBucket }, ctx, artifactId, version, files, new Date());

    await expect(readStream(stream)).rejects.toThrow(/missing object for b\.txt/);
    await expect(flush()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith('zip stream failed', artifactId, version, expect.objectContaining({ message: 'missing object for b.txt' }));
  });

  it('enforces the 4 MiB prefetch byte budget and concurrency <= 3 cap across many 1 MiB small files', async () => {
    const baseEnv = env as unknown as Env;
    const artifactId = crypto.randomUUID();
    const version = 1;

    const files: ZipFile[] = [];
    const expectedFirstByte: number[] = [];
    for (let i = 0; i < 6; i++) {
      const buf = new Uint8Array(PREFETCH_MAX_FILE_BYTES);
      buf.fill(i + 1);
      const path = `chunk-${i}.bin`;
      await baseEnv.BUCKET.put(r2Key(artifactId, version, path), buf, {
        httpMetadata: { contentType: 'application/octet-stream' },
      });
      files.push({ path, size: buf.byteLength, content_type: 'application/octet-stream' });
      expectedFirstByte.push(i + 1);
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchedKeys: string[] = [];
    const trackedBucket = new Proxy(baseEnv.BUCKET, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return async (key: string, options?: R2GetOptions) => {
            fetchedKeys.push(key);
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
              return await target.get(key, options);
            } finally {
              inFlight--;
            }
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const { ctx, flush } = makeCtx();
    const stream = streamZip({ ...baseEnv, BUCKET: trackedBucket }, ctx, artifactId, version, files, new Date(1700000000 * 1000));

    // Pause before consuming: backpressure holds file 0 in zip.add while prefetch fills up to 4 MiB (at most 4 x 1 MiB).
    await new Promise((r) => setTimeout(r, 40));
    expect(fetchedKeys.length).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeLessThanOrEqual(PREFETCH_CONCURRENCY);

    // Drain the stream and verify all 6 files decompress accurately.
    const archiveBytes = await readStream(stream);
    await flush();

    expect(fetchedKeys).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(PREFETCH_CONCURRENCY);

    const extracted = unzipSync(archiveBytes);
    for (let i = 0; i < 6; i++) {
      const entry = extracted[`chunk-${i}.bin`];
      expect(entry.byteLength).toBe(PREFETCH_MAX_FILE_BYTES);
      expect(entry[0]).toBe(expectedFirstByte[i]);
      expect(entry[entry.length - 1]).toBe(expectedFirstByte[i]);
    }
  });
});

describe('same-origin zip-worker asset (Plan 2.3.2)', () => {
  it('serves /zip-worker.js from the main origin under strict CSP without fflate.unzip', async () => {
    const { ctx, flush } = makeCtx();
    const req = new Request(`${MAIN}/zip-worker.js`) as Request<unknown, IncomingRequestCfProperties<unknown>>;
    const res = await worker.fetch(req, env as unknown as Env, ctx);
    await flush();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    const body = await res.text();
    expect(body).toContain("import { unzipSync } from '/vendor/fflate.js'");
    expect(body).not.toMatch(/\bunzip\s*\(/);
  });
});
