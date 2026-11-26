// Copies browser builds of runtime dependencies into web/vendor (served as static assets).
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'web/vendor'), { recursive: true });
copyFileSync(join(root, 'node_modules/fflate/esm/browser.js'), join(root, 'web/vendor/fflate.js'));
console.log('vendored fflate → web/vendor/fflate.js');

const markdown = join(root, 'web/vendor/markdown');
rmSync(markdown, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { preview: 'src/content/markdown-preview.js' },
  outdir: markdown,
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  metafile: true,
  entryNames: '[name]-[hash]',
  chunkNames: 'chunks/[name]-[hash]',
});

const outputs = Object.entries(result.metafile.outputs);
const jsEntry = outputs.find(([file, meta]) => meta.entryPoint === 'src/content/markdown-preview.js' && file.endsWith('.js'));
const js = jsEntry ? basename(jsEntry[0]) : null;
const cssPath = jsEntry?.[1].cssBundle ?? outputs.find(([file]) => /^preview-[A-Za-z0-9_-]+\.css$/.test(basename(file)))?.[0];
const css = cssPath ? basename(cssPath) : null;
if (!js || !css) throw new Error(`Failed to resolve hashed markdown preview assets from esbuild metafile (js=${js}, css=${css})`);

writeFileSync(join(markdown, 'manifest.json'), JSON.stringify({ js, css }, null, 2) + '\n');
console.log(`vendored markdown → web/vendor/markdown/{${js}, ${css}}`);
