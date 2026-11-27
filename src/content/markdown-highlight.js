import { codeToTokens, isSupportedLanguage } from '@pierre/highlights';
import githubLight from '@pierre/highlights/themes/github-light';
import githubDarkDimmed from '@pierre/highlights/themes/github-dark-dimmed';

const MAX_HIGHLIGHT_CHARS = 64 * 1024;
const MAX_TOKENIZE_LINE_LENGTH = 20_000;
const SKIP_LANGUAGES = new Set(['', 'mermaid', 'mmd', 'plain', 'plaintext', 'text', 'txt']);
const THEMES = { light: githubLight, dark: githubDarkDimmed };

function parseDefaultForegrounds(fg) {
  let light = '';
  let dark = '';
  if (typeof fg !== 'string') return { light, dark };
  for (const part of fg.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('--hls-dark:')) {
      dark = trimmed.slice('--hls-dark:'.length).trim();
    } else if (!trimmed.startsWith('--')) {
      light = trimmed;
    }
  }
  return { light, dark };
}

function buildHighlightedFragment(doc, text, tokens, defaultFg) {
  const fragment = doc.createDocumentFragment();
  let lf = -1;

  for (let i = 0; i < tokens.length; i++) {
    if (i > 0) {
      lf = text.indexOf('\n', lf + 1);
      const lineBreak = lf > 0 && text.charCodeAt(lf - 1) === 13 ? '\r\n' : '\n';
      fragment.append(doc.createTextNode(lineBreak));
    }

    for (const token of tokens[i]) {
      const content = token.content;
      if (!content) continue;

      const style = token.htmlStyle;
      const lightColor = style?.color || token.color || defaultFg.light || '';
      const darkColor = style?.['--hls-dark'] || defaultFg.dark || '';

      const fontBits = typeof token.fontStyle === 'number' ? token.fontStyle : 0;
      const isItalic = (fontBits & 1) !== 0
        || style?.['font-style'] === 'italic'
        || style?.['--hls-dark-font-style'] === 'italic';
      const weightVal = style?.['font-weight'] || style?.['--hls-dark-font-weight'] || '';
      const isBold = (fontBits & 2) !== 0
        || weightVal === 'bold'
        || Number(weightVal) >= 600;
      const decoration = style?.['text-decoration'] || style?.['--hls-dark-text-decoration'] || '';
      const isUnderline = (fontBits & 4) !== 0 || decoration.includes('underline');
      const isStrike = (fontBits & 8) !== 0 || decoration.includes('line-through');

      const hasLightColor = Boolean(lightColor) && lightColor !== 'inherit' && lightColor !== defaultFg.light;
      const hasDarkColor = Boolean(darkColor) && darkColor !== 'inherit' && darkColor !== defaultFg.dark;
      const hasStyle = hasLightColor || hasDarkColor || isItalic || isBold || isUnderline || isStrike;

      if (!hasStyle) {
        fragment.append(doc.createTextNode(content));
        continue;
      }

      const span = doc.createElement('span');
      span.className = 'code-tok';
      if (lightColor && lightColor !== 'inherit') span.style.setProperty('--tok-light', lightColor);
      if (darkColor && darkColor !== 'inherit') span.style.setProperty('--tok-dark', darkColor);
      if (isItalic) span.style.fontStyle = 'italic';
      if (isBold) span.style.fontWeight = '600';
      if (isUnderline && isStrike) span.style.textDecoration = 'underline line-through';
      else if (isUnderline) span.style.textDecoration = 'underline';
      else if (isStrike) span.style.textDecoration = 'line-through';
      span.textContent = content;
      fragment.append(span);
    }
  }

  return fragment;
}

export function highlightBlocks(blocks) {
  for (const { code, lang } of blocks) {
    if (!code || !code.isConnected) continue;
    const key = String(lang || '').trim().toLowerCase();
    if (SKIP_LANGUAGES.has(key)) continue;
    const text = code.textContent ?? '';
    if (!text || text.length > MAX_HIGHLIGHT_CHARS) continue;

    try {
      if (!isSupportedLanguage(key)) continue;
      const result = codeToTokens(text, {
        lang: key,
        themes: THEMES,
        defaultColor: 'light',
        tokenizeMaxLineLength: MAX_TOKENIZE_LINE_LENGTH,
      });
      const defaultFg = parseDefaultForegrounds(result.fg);
      const doc = code.ownerDocument ?? document;
      const fragment = buildHighlightedFragment(doc, text, result.tokens, defaultFg);
      code.replaceChildren(fragment);
      code.classList.add('code-highlighted');
    } catch {
      // Leave plain code untouched when WASM or tokenization fails.
    }
  }
}
