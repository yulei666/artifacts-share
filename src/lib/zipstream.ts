import { Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js/lib/zip-core-custom.js';
import type { Env } from '../env';
import { r2Key } from './store';

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/;
const MAX_DEFLATE_BYTES = 10 * 1024 * 1024;
export const PREFETCH_MAX_FILE_BYTES = 1024 * 1024;
export const PREFETCH_MAX_BYTES = 4 * 1024 * 1024;
export const PREFETCH_CONCURRENCY = 3;
const PREFETCH_MAX_QUEUED = 32;

export interface ZipFile {
  path: string;
  size: number;
  content_type: string;
}

type PrefetchResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: unknown };

/** Streams one version from R2, using ZIP64 when the archive outgrows classic ZIP offsets. */
export function streamZip(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  artifactId: string,
  version: number,
  files: ZipFile[],
  mtime: Date,
): ReadableStream<Uint8Array> {
  let output: TransformStreamDefaultController<Uint8Array>;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      output = controller;
    },
  });
  const zip = new ZipWriter(writable, { useWebWorkers: false, useCompressionStream: true });
  const produce = async () => {
    const prefetched = new Map<number, { reserved: number; promise: Promise<PrefetchResult> }>();
    const active = new Set<Promise<void>>();
    let nextPrefetch = 0;
    let inFlight = 0;
    let reservedBytes = 0;
    let stopPrefetch = false;
    let aborted = false;

    const pump = () => {
      while (!aborted && !stopPrefetch && inFlight < PREFETCH_CONCURRENCY && prefetched.size < PREFETCH_MAX_QUEUED && nextPrefetch < files.length) {
        const f = files[nextPrefetch];
        if (f.size > PREFETCH_MAX_FILE_BYTES) break;
        const est = Math.max(0, f.size);
        if (reservedBytes + est > PREFETCH_MAX_BYTES) break;
        const idx = nextPrefetch++;
        inFlight++;
        reservedBytes += est;
        const entry = { reserved: est, promise: null as unknown as Promise<PrefetchResult> };
        const run = (async (): Promise<PrefetchResult> => {
          try {
            const obj = await env.BUCKET.get(r2Key(artifactId, version, f.path));
            if (!obj) throw new Error(`missing object for ${f.path}`);
            if (aborted) {
              await obj.body?.cancel().catch(() => {});
              return { ok: false, error: new Error('aborted') };
            }
            const bytes = new Uint8Array(await obj.arrayBuffer());
            if (!aborted) {
              reservedBytes += bytes.byteLength - entry.reserved;
              entry.reserved = bytes.byteLength;
            }
            return { ok: true, bytes };
          } catch (error) {
            stopPrefetch = true;
            return { ok: false, error };
          } finally {
            inFlight--;
            if (!aborted && !stopPrefetch) pump();
          }
        })();
        entry.promise = run;
        prefetched.set(idx, entry);
        const tracked = run.then(() => {
          active.delete(tracked);
        });
        active.add(tracked);
      }
    };

    try {
      pump();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const level = COMPRESSIBLE.test(f.content_type) && f.size <= MAX_DEFLATE_BYTES ? 6 : 0;
        if (f.size <= PREFETCH_MAX_FILE_BYTES) {
          if (!prefetched.has(i)) {
            if (nextPrefetch < i) nextPrefetch = i;
            pump();
          }
          const entry = prefetched.get(i);
          if (entry) {
            const res = await entry.promise;
            try {
              if (!res.ok) throw res.error;
              await zip.add(f.path, new Uint8ArrayReader(res.bytes), { level, lastModDate: mtime });
            } finally {
              prefetched.delete(i);
              reservedBytes = Math.max(0, reservedBytes - entry.reserved);
              if (!aborted) pump();
            }
            continue;
          }
        } else if (nextPrefetch <= i) {
          nextPrefetch = i + 1;
          pump();
        }
        const obj = await env.BUCKET.get(r2Key(artifactId, version, f.path));
        if (!obj) throw new Error(`missing object for ${f.path}`);
        await zip.add(f.path, { readable: obj.body, size: obj.size }, { level, lastModDate: mtime });
      }
      await zip.close();
    } catch (e) {
      aborted = true;
      console.error('zip stream failed', artifactId, version, e);
      output.error(e);
    } finally {
      aborted = true;
      prefetched.clear();
      if (active.size) await Promise.allSettled(active);
    }
  };
  ctx.waitUntil(produce());
  return readable;
}
