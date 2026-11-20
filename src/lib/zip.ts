import { unzipSync } from 'fflate';
import { HttpError } from './http';
import { isIgnoredPath } from './paths';
import type { IncomingFile } from './store';
import type { Settings } from './settings';

/** Extracts a zip archive in memory, enforcing entry-count and size limits (zip-bomb guard). */
export function extractZip(data: Uint8Array, settings: Settings): IncomingFile[] {
  let entries = 0;
  let declared = 0;
  let out: Record<string, Uint8Array>;
  try {
    out = unzipSync(data, {
      filter(file) {
        if (file.name.endsWith('/') || isIgnoredPath(file.name)) return false;
        entries++;
        declared += file.originalSize;
        if (entries > settings.unzip_max_files) throw new HttpError(413, 'zip_too_many_files', `Zip has more than ${settings.unzip_max_files} files`);
        if (declared > settings.unzip_max_bytes) throw new HttpError(413, 'zip_too_large', `Zip expands beyond ${settings.unzip_max_bytes} bytes`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'invalid_zip', `Could not read zip: ${(e as Error).message}`);
  }
  let actual = 0;
  const files: IncomingFile[] = [];
  for (const [path, bytes] of Object.entries(out)) {
    actual += bytes.byteLength;
    if (actual > settings.unzip_max_bytes) throw new HttpError(413, 'zip_too_large', `Zip expands beyond ${settings.unzip_max_bytes} bytes`);
    files.push({ path, body: bytes, size: bytes.byteLength });
  }
  return files;
}
