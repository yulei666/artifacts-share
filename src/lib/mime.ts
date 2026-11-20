const TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  cjs: 'text/javascript', json: 'application/json', map: 'application/json', webmanifest: 'application/manifest+json',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject', mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg',
  wav: 'audio/wav', m4a: 'audio/mp4', pdf: 'application/pdf', wasm: 'application/wasm', zip: 'application/zip',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', yaml: 'text/yaml', yml: 'text/yaml', ts: 'text/plain',
};
const TEXTUAL = /^(text\/|application\/(json|xml|manifest\+json)|image\/svg\+xml)/;

export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const t = TYPES[ext] ?? 'application/octet-stream';
  return TEXTUAL.test(t) ? `${t}; charset=utf-8` : t;
}

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}
