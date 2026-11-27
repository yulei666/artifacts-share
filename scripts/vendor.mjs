// Copies browser builds of runtime dependencies into web/vendor (served as static assets).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKDOWN_PUBLIC_PATH = '/__share/markdown/';
mkdirSync(join(root, 'web/vendor'), { recursive: true });
copyFileSync(join(root, 'node_modules/fflate/esm/browser.js'), join(root, 'web/vendor/fflate.js'));
console.log('vendored fflate → web/vendor/fflate.js');

const markdown = join(root, 'web/vendor/markdown');
rmSync(markdown, { recursive: true, force: true });

// Strip legacy .woff and .ttf fallbacks from KaTeX CSS so only modern .woff2 fonts are emitted.
const katexWoff2Only = {
  name: 'katex-woff2-only',
  setup(b) {
    b.onLoad({ filter: /katex[\\/]dist[\\/]katex(?:-swap)?\.min\.css$/ }, (args) => {
      const css = readFileSync(args.path, 'utf8')
        .replace(/,url\(fonts\/[^)]+\.woff\)\s*format\(["']?woff["']?\)/g, '')
        .replace(/,url\(fonts\/[^)]+\.ttf\)\s*format\(["']?truetype["']?\)/g, '');
      return { contents: css, loader: 'css', resolveDir: dirname(args.path) };
    });
  },
};

const katexResult = await build({
  absWorkingDir: root,
  entryPoints: { katex: 'node_modules/katex/dist/katex.min.css' },
  outdir: markdown,
  bundle: true,
  minify: true,
  metafile: true,
  entryNames: 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  publicPath: MARKDOWN_PUBLIC_PATH,
  loader: { '.woff2': 'file' },
  plugins: [katexWoff2Only],
});

const katexCssOut = Object.keys(katexResult.metafile.outputs).find((file) => file.endsWith('.css'));
const katexCss = katexCssOut ? relative(markdown, resolve(root, katexCssOut)).replaceAll('\\', '/') : null;
if (!katexCss) throw new Error('Failed to resolve hashed KaTeX CSS asset from esbuild metafile');

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
  assetNames: 'assets/[name]-[hash]',
  publicPath: MARKDOWN_PUBLIC_PATH,
  loader: { '.woff2': 'file' },
  define: {
    __KATEX_CSS_PATH__: JSON.stringify(`${MARKDOWN_PUBLIC_PATH}${katexCss}`),
  },
});

const outputs = Object.entries(result.metafile.outputs);
const jsEntry = outputs.find(([file, meta]) => meta.entryPoint === 'src/content/markdown-preview.js' && file.endsWith('.js'));
const js = jsEntry ? basename(jsEntry[0]) : null;
const cssPath = jsEntry?.[1].cssBundle ?? outputs.find(([file]) => /^preview-[A-Za-z0-9_-]+\.css$/.test(basename(file)))?.[0];
const css = cssPath ? basename(cssPath) : null;
if (!js || !css) throw new Error(`Failed to resolve hashed markdown preview assets from esbuild metafile (js=${js}, css=${css})`);

writeFileSync(join(markdown, 'manifest.json'), JSON.stringify({ js, css }, null, 2) + '\n');
console.log(`vendored markdown → web/vendor/markdown/{${js}, ${css}, ${katexCss}}`);
