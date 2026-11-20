// Copies browser builds of runtime dependencies into web/vendor (served as static assets).
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'web/vendor'), { recursive: true });
copyFileSync(join(root, 'node_modules/fflate/esm/browser.js'), join(root, 'web/vendor/fflate.js'));
console.log('vendored fflate → web/vendor/fflate.js');

const markdown = join(root, 'web/vendor/markdown');
rmSync(markdown, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: { preview: 'src/content/markdown-preview.js' },
  outdir: markdown,
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  chunkNames: 'chunks/[name]-[hash]',
});
