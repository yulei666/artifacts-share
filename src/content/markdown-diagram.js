import { renderAsync } from 'pele/lazy';

export const MAX_RENDERED_DIAGRAMS = 20;

const DEFAULT_MONO_FONT = 'ui-monospace, "SF Mono", Consolas, monospace';
const MERMAID_LANGUAGES = new Set(['mermaid', 'mmd']);

function isMermaidCode(code) {
  const classes = code.classList
    ? [...code.classList]
    : typeof code.className === 'string'
      ? code.className.trim().split(/\s+/)
      : null;
  if (!classes) return false;
  return classes.some((name) => (
    name.startsWith('language-') && MERMAID_LANGUAGES.has(name.slice('language-'.length).toLowerCase())
  ));
}

async function waitForFonts(doc) {
  try {
    await doc?.fonts?.ready;
  } catch {
    // Continue rendering if the environment does not expose document.fonts.
  }
}

function readFonts(article) {
  const view = article.ownerDocument?.defaultView ?? globalThis;
  if (typeof view?.getComputedStyle !== 'function') {
    return { fontFamily: undefined, fontFamilyMono: DEFAULT_MONO_FONT };
  }
  const style = view.getComputedStyle(article);
  const fontFamily = style?.fontFamily?.trim() || undefined;
  const fontFamilyMono = style?.getPropertyValue('--font-mono')?.trim() || DEFAULT_MONO_FONT;
  return { fontFamily, fontFamilyMono };
}

export async function renderDiagrams(article) {
  if (!article) return;
  const diagrams = [...article.querySelectorAll('pre > code[class*="language-"]')].filter(isMermaidCode);
  if (!diagrams.length) return;

  const doc = article.ownerDocument ?? document;
  await waitForFonts(doc);

  const { fontFamily, fontFamilyMono } = readFonts(article);
  const maxWidth = article.clientWidth || undefined;
  const count = Math.min(diagrams.length, MAX_RENDERED_DIAGRAMS);

  // Bound the total layout work and leave any remaining diagrams readable as code.
  for (let index = 0; index < count; index++) {
    const code = diagrams[index];
    if (!code.isConnected) continue;
    const source = code.textContent ?? '';
    if (!source.trim()) continue;
    try {
      const { svg } = await renderAsync(source, {
        idPrefix: `markdown-diagram-${index}`,
        fontFamily,
        fontFamilyMono,
        maxWidth,
        autoDirection: false,
        links: false,
        images: false,
      });
      const target = code.closest?.('.code-block') ?? code.parentElement;
      if (!target || !target.isConnected) continue;
      const figure = doc.createElement('figure');
      figure.className = 'diagram';
      figure.innerHTML = svg;
      target.replaceWith(figure);
    } catch {
      // Keep the original code block intact on any render error.
    }
  }
}
