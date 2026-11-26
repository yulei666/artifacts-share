// Same-origin module worker for client-side ZIP extraction (strict CSP `script-src 'self'` compatible).
import { unzipSync } from '/vendor/fflate.js';

self.onmessage = (event) => {
  try {
    const buffer = event.data?.buffer;
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Invalid zip payload');
    const data = unzipSync(new Uint8Array(buffer));
    const files = [];
    const seen = new Set();
    const transfer = [];
    for (const [path, bytes] of Object.entries(data)) {
      if (path.endsWith('/')) continue;
      files.push({
        path,
        buffer: bytes.buffer,
        byteOffset: bytes.byteOffset,
        byteLength: bytes.byteLength,
      });
      if (bytes.buffer instanceof ArrayBuffer && !seen.has(bytes.buffer)) {
        seen.add(bytes.buffer);
        transfer.push(bytes.buffer);
      }
    }
    self.postMessage({ ok: true, files }, transfer);
  } catch (err) {
    self.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
