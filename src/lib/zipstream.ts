import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { Env } from '../env';
import { r2Key } from './store';

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/;
const MAX_DEFLATE_BYTES = 10 * 1024 * 1024;

export interface ZipFile {
  path: string;
  size: number;
  content_type: string;
}

/**
 * Streams a ZIP of one artifact version straight from R2: files are read one at a time and fed through
 * fflate's streaming Zip, so memory stays flat regardless of the archive size. Text is deflated; already
 * compressed media is stored as-is. Backpressure: we wait for the client before pulling more from R2.
 */
export function streamZip(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, artifactId: string, version: number, files: ZipFile[], mtime: Date): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  writer.closed.catch(() => {}); // rejects when we abort on failure; that's handled below, not an unhandled error
  let failed = false;

  const zip = new Zip((err, chunk, final) => {
    if (failed) return;
    if (err) {
      failed = true;
      writer.abort(err).catch(() => {});
      return;
    }
    writer.write(chunk).catch(() => {});
    if (final) writer.close().catch(() => {});
  });

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const produce = async () => {
    try {
      for (const f of files) {
        if (failed) return;
        // A listed file with no object means the version is damaged: fail the download rather than
        // silently shipping an empty file inside an otherwise "complete" ZIP.
        const obj = await env.BUCKET.get(r2Key(artifactId, version, f.path));
        if (!obj) throw new Error(`missing object for ${f.path}`);
        const entry = COMPRESSIBLE.test(f.content_type) && f.size <= MAX_DEFLATE_BYTES ? new ZipDeflate(f.path, { level: 6 }) : new ZipPassThrough(f.path);
        entry.mtime = mtime;
        zip.add(entry);
        reader = obj.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.ready; // backpressure from the client (rejects if the client went away)
          entry.push(value);
        }
        reader = null;
        entry.push(new Uint8Array(0), true);
      }
      zip.end();
    } catch (e) {
      failed = true;
      console.error('zip stream failed', artifactId, version, e);
      await reader?.cancel().catch(() => {}); // release the R2 stream (e.g. client disconnected)
      writer.abort(e).catch(() => {});
    }
  };
  ctx.waitUntil(produce());
  return readable;
}
