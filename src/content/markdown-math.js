// Lazy KaTeX math renderer (dynamically imported only when math placeholders are present).
import katex from 'katex';

const MAX_MATH_EXPRESSIONS = 200;
const MAX_MATH_CHARS = 16 * 1024;
const CSS_LOAD_TIMEOUT_MS = 3000;

let katexCssPromise = null;

function ensureKatexCss() {
  const href = typeof __KATEX_CSS_PATH__ === 'string' ? __KATEX_CSS_PATH__ : null;
  if (!href || typeof document === 'undefined' || !document.head) {
    return Promise.resolve();
  }
  if (katexCssPromise) return katexCssPromise;

  const existing = [...document.head.querySelectorAll('link[rel="stylesheet"]')]
    .find((link) => link.getAttribute('href') === href);
  if (existing) {
    katexCssPromise = Promise.resolve();
    return katexCssPromise;
  }

  katexCssPromise = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, CSS_LOAD_TIMEOUT_MS);
    link.addEventListener('load', finish, { once: true });
    link.addEventListener('error', finish, { once: true });
    document.head.append(link);
  });

  return katexCssPromise;
}

export async function renderMath(article) {
  if (!article || typeof article.querySelectorAll !== 'function') return;
  const nodes = article.querySelectorAll('.math-block[data-math], .math-inline[data-math]');
  if (!nodes.length) return;

  await ensureKatexCss();

  const limit = Math.min(nodes.length, MAX_MATH_EXPRESSIONS);
  for (let index = 0; index < limit; index++) {
    const el = nodes[index];
    if (el.isConnected === false) continue;
    const tex = el.getAttribute('data-math');
    if (!tex || tex.length > MAX_MATH_CHARS) continue;
    try {
      katex.render(tex, el, {
        displayMode: el.classList.contains('math-block'),
        throwOnError: false,
        strict: false,
        trust: false,
        maxSize: 100,
        maxExpand: 200,
      });
    } catch {
      // KaTeX clears `el.textContent` before parsing; restore raw TeX on unexpected throws.
      el.textContent = tex;
    }
  }
}
