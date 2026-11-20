import { isHtmlPath, isMarkdownPath } from './mime';

export const RESERVED_PREFIX = '__share';
const IGNORED = /(^|\/)(__MACOSX(\/|$)|\.DS_Store$|Thumbs\.db$)/;

/**
 * Normalizes a user-supplied relative file path.
 * Returns null when the path is unsafe or empty.
 */
export function normalizePath(input: string): string | null {
  if (typeof input !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(input)) return null;
  // Not well-formed Unicode (a lone surrogate): it can't be stored as UTF-8 faithfully, so two different
  // paths could collapse into one.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(input)) return null;
  // Windows-style separators (some zip tools write `assets\app.js`) become `/`; `..` segments are still
  // rejected below, so `..\x` can't escape either.
  let p = input.replace(/\\/g, '/').trim().replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!p || p.length > 512) return null;
  const segs = p.split('/');
  // allow a trailing slash only for directories; files must not end with '/'
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  p = segs.join('/');
  if (p === RESERVED_PREFIX || p.startsWith(RESERVED_PREFIX + '/')) return null;
  return p;
}

export function isIgnoredPath(p: string): boolean {
  return IGNORED.test(p.replace(/\\/g, '/'));
}

/** If every path shares the same top-level directory, strip it (e.g. "dist/"). */
export function stripCommonRoot(paths: string[]): { strip: string; paths: string[] } {
  if (paths.length === 0) return { strip: '', paths };
  const first = paths[0].split('/');
  if (first.length < 2) return { strip: '', paths };
  const root = first[0] + '/';
  if (!paths.every((p) => p.startsWith(root) && p.length > root.length)) return { strip: '', paths };
  return { strip: root, paths: paths.map((p) => p.slice(root.length)) };
}

/** Prefer existing HTML conventions, then a conventional or unambiguous Markdown entry. */
export function inferEntry(paths: string[]): string | null {
  if (paths.includes('index.html')) return 'index.html';
  const html = paths.filter(isHtmlPath);
  if (html.length === 1) return html[0];
  if (!html.length) {
    const markdown = paths.filter(isMarkdownPath);
    const named = markdown.find((path) => /^index\.(?:md|markdown)$/i.test(path))
      ?? markdown.find((path) => /^readme\.(?:md|markdown)$/i.test(path));
    if (named || markdown.length === 1) return named ?? markdown[0];
  }
  return paths.length === 1 ? paths[0] : null;
}

/** Decodes a request pathname into a storage path (no leading slash). Returns null if unsafe. */
export function requestPathToKey(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(decoded)) return null;
  const segs = decoded.split('/').filter((s) => s !== '');
  if (segs.some((s) => s === '.' || s === '..')) return null;
  return segs.join('/');
}
