import { ZipWriter } from '@zip.js/zip.js/lib/zip-core-custom.js';
import type { Env } from '../env';
import { r2Key } from './store';

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/;
const MAX_DEFLATE_BYTES = 10 * 1024 * 1024;

export interface ZipFile {
  path: string;
  size: number;
  content_type: string;
}

/** Streams one version from R2, using ZIP64 when the archive outgrows classic ZIP offsets. */
export function streamZip(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, artifactId: string, version: number, files: ZipFile[], mtime: Date): ReadableStream<Uint8Array> {
  let output: TransformStreamDefaultController<Uint8Array>;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      output = controller;
    },
  });
  const zip = new ZipWriter(writable, { useWebWorkers: false, useCompressionStream: true });
  const produce = async () => {
    try {
      for (const f of files) {
        const obj = await env.BUCKET.get(r2Key(artifactId, version, f.path));
        if (!obj) throw new Error(`missing object for ${f.path}`);
        const level = COMPRESSIBLE.test(f.content_type) && f.size <= MAX_DEFLATE_BYTES ? 6 : 0;
        await zip.add(f.path, { readable: obj.body, size: obj.size }, { level, lastModDate: mtime });
      }
      await zip.close();
    } catch (e) {
      console.error('zip stream failed', artifactId, version, e);
      output.error(e);
    }
  };
  ctx.waitUntil(produce());
  return readable;
}
