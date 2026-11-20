// Copies browser builds of runtime dependencies into web/vendor (served as static assets).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'web/vendor'), { recursive: true });
copyFileSync(join(root, 'node_modules/fflate/esm/browser.js'), join(root, 'web/vendor/fflate.js'));
console.log('vendored fflate → web/vendor/fflate.js');
