// Lightweight markdown-it math tokenizer (no KaTeX import) emitting safe raw-TeX placeholders.

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;
const BACKTICK = 0x60;
const TILDE = 0x7e;
const NEWLINE = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;

// Memoize failed multi-line closing-`$$` scans per (state, blkIndent) to keep unclosed `$$` O(N).
const noCloseBeforeByState = new WeakMap();

function isEscaped(src, pos) {
  let backslashes = 0;
  for (let i = pos - 1; i >= 0 && src.charCodeAt(i) === BACKSLASH; i--) backslashes++;
  return (backslashes & 1) === 1;
}

function isDigit(code) {
  return code >= 0x30 && code <= 0x39;
}

function hasOnlySpacesOrTabs(src, start, end) {
  for (let i = start; i < end; i++) {
    const ch = src.charCodeAt(i);
    if (ch !== SPACE && ch !== TAB) return false;
  }
  return true;
}

function findUnescapedDoubleDollarInRange(src, start, end) {
  for (let i = start; i + 1 < end; i++) {
    const ch = src.charCodeAt(i);
    if (ch === BACKSLASH) {
      i++;
      continue;
    }
    if (ch === DOLLAR && src.charCodeAt(i + 1) === DOLLAR) {
      return i;
    }
  }
  return -1;
}

function isFenceLine(src, lineStart, lineMax, indent) {
  if (indent >= 4 || lineStart + 3 > lineMax) return false;
  const marker = src.charCodeAt(lineStart);
  if (marker !== BACKTICK && marker !== TILDE) return false;
  let pos = lineStart + 1;
  while (pos < lineMax && src.charCodeAt(pos) === marker) pos++;
  if (pos - lineStart < 3) return false;
  if (marker === BACKTICK) {
    for (let i = pos; i < lineMax; i++) {
      if (src.charCodeAt(i) === BACKTICK) return false;
    }
  }
  return true;
}

function mathBlock(state, startLine, endLine, silent) {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;

  const src = state.src;
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const startMax = state.eMarks[startLine];
  if (startPos + 2 > startMax) return false;
  if (src.charCodeAt(startPos) !== DOLLAR || src.charCodeAt(startPos + 1) !== DOLLAR) {
    return false;
  }
  // Ignore runs of 3+ leading dollar signs such as `$$$`.
  if (startPos + 2 < startMax && src.charCodeAt(startPos + 2) === DOLLAR) return false;

  const inlineClose = findUnescapedDoubleDollarInRange(src, startPos + 2, startMax);

  if (inlineClose >= 0) {
    if (!hasOnlySpacesOrTabs(src, inlineClose + 2, startMax)) return false;
    const content = src.slice(startPos + 2, inlineClose).trim();
    if (!content) return false;
    if (silent) return true;

    const token = state.push('math_block', 'div', 0);
    token.block = true;
    token.content = content;
    token.map = [startLine, startLine + 1];
    token.markup = '$$';
    state.line = startLine + 1;
    return true;
  }

  let noCloseByIndent = noCloseBeforeByState.get(state);
  const noCloseBefore = noCloseByIndent?.get(state.blkIndent) ?? -1;
  if (startLine < noCloseBefore) return false;

  let nextLine = startLine + 1;
  let closingLine = -1;
  let closingEnd = -1;

  for (; nextLine < endLine; nextLine++) {
    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
    const lineMax = state.eMarks[nextLine];
    if (lineStart < lineMax && state.sCount[nextLine] < state.blkIndent) break;
    if (isFenceLine(src, lineStart, lineMax, state.sCount[nextLine] - state.blkIndent)) break;

    const closeIdx = findUnescapedDoubleDollarInRange(src, lineStart, lineMax);
    if (closeIdx >= 0 && hasOnlySpacesOrTabs(src, closeIdx + 2, lineMax)) {
      closingLine = nextLine;
      closingEnd = closeIdx;
      break;
    }
  }

  if (closingLine < 0) {
    if (!noCloseByIndent) {
      noCloseByIndent = new Map();
      noCloseBeforeByState.set(state, noCloseByIndent);
    }
    if (nextLine > noCloseBefore) noCloseByIndent.set(state.blkIndent, nextLine);
    return false;
  }

  const parts = [];
  const firstLine = src.slice(startPos + 2, startMax).trim();
  if (firstLine.length > 0) parts.push(firstLine);
  if (closingLine > startLine + 1) {
    const middle = state.getLines(startLine + 1, closingLine, state.sCount[startLine], false);
    if (middle.length > 0) parts.push(middle);
  }
  const closingStart = state.bMarks[closingLine] + state.tShift[closingLine];
  if (closingEnd > closingStart) {
    const closingPart = src.slice(closingStart, closingEnd).trimEnd();
    if (closingPart.trim().length > 0) parts.push(closingPart);
  }

  const content = parts.join('\n').trim();
  if (!content) return false;
  if (silent) return true;

  const token = state.push('math_block', 'div', 0);
  token.block = true;
  token.content = content;
  token.map = [startLine, closingLine + 1];
  token.markup = '$$';
  state.line = closingLine + 1;
  return true;
}

function createMathInline(md) {
  const { isWhiteSpace } = md.utils;

  return function mathInline(state, silent) {
    const src = state.src;
    const start = state.pos;
    const max = state.posMax;

    if (src.charCodeAt(start) !== DOLLAR) return false;
    // Never open inline math on an escaped `$` or as part of a `$$` run.
    if (isEscaped(src, start)) return false;
    if (start > 0 && src.charCodeAt(start - 1) === DOLLAR) return false;
    if (start + 1 >= max) return false;

    const afterOpen = src.charCodeAt(start + 1);
    if (afterOpen === DOLLAR || afterOpen === NEWLINE || isWhiteSpace(afterOpen)) return false;

    let close = -1;
    for (let pos = start + 1; pos < max; pos++) {
      const ch = src.charCodeAt(pos);
      if (ch === NEWLINE || ch === BACKTICK) return false;
      if (ch === BACKSLASH) {
        // Keep `\$` inside math without prematurely closing, and allow `\\$` to close.
        if (pos + 1 >= max || src.charCodeAt(pos + 1) === NEWLINE) return false;
        pos++;
        continue;
      }
      if (ch === DOLLAR) {
        // First unescaped `$` must be a valid Pandoc/GitHub closing delimiter.
        const beforeClose = src.charCodeAt(pos - 1);
        const afterClose = pos + 1 < max ? src.charCodeAt(pos + 1) : -1;
        if (isWhiteSpace(beforeClose) || beforeClose === NEWLINE) return false;
        if (afterClose === DOLLAR || isDigit(afterClose)) return false;
        close = pos;
        break;
      }
    }

    if (close < 0) return false;

    const content = src.slice(start + 1, close);
    if (!content) return false;

    if (!silent) {
      const token = state.push('math_inline', 'span', 0);
      token.markup = '$';
      token.content = content;
    }

    state.pos = close + 1;
    return true;
  };
}

export function mathPlugin(md) {
  md.block.ruler.after('blockquote', 'math_block', mathBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.inline.ruler.after('backticks', 'math_inline', createMathInline(md));

  md.renderer.rules.math_block = (tokens, idx) => {
    const escaped = md.utils.escapeHtml(tokens[idx].content);
    return `<div class="math-block" data-math="${escaped}">${escaped}</div>\n`;
  };

  md.renderer.rules.math_inline = (tokens, idx) => {
    const escaped = md.utils.escapeHtml(tokens[idx].content);
    return `<span class="math-inline" data-math="${escaped}">${escaped}</span>`;
  };
}
