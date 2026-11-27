import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import { mathPlugin } from './markdown-math-plugin.js';
import './markdown-preview.css';

const MAX_HIGHLIGHT_CHARS = 64 * 1024;
const MERMAID_LANGS = new Set(['mermaid', 'mmd']);
const SKIP_HIGHLIGHT_LANGS = new Set(['mermaid', 'mmd', 'plain', 'plaintext', 'text', 'txt']);

function codeLanguage(code) {
  return [...code.classList].find((name) => name.startsWith('language-'))?.slice('language-'.length) ?? '';
}

const parser = new MarkdownIt({ html: false }).use(mathPlugin);

const article = document.getElementById('reader:preview');
const source = document.getElementById('reader:source');
const status = document.querySelector('[role=status]');
const copyStatus = document.getElementById('reader:copy-status');
const buttons = document.querySelectorAll('[data-view]');
let ready = false;
let rendered = false;
let rawSource = null;
let sourcePopulated = false;

function select(view) {
  if (view === 'source' && ready && !sourcePopulated) {
    source.textContent = rawSource;
    rawSource = null;
    sourcePopulated = true;
  }
  article.hidden = !rendered || view !== 'preview';
  source.hidden = !ready || view !== 'source';
  status.hidden = view === 'source' ? ready : rendered;
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.view === view));
}

for (const button of buttons) button.addEventListener('click', () => select(button.dataset.view));

async function copyCode(code) {
  const { copied, copySelected, copyFailed } = article.dataset;
  const text = code.textContent;
  try {
    await navigator.clipboard.writeText(text);
    return copied;
  } catch {
    if (!code.isConnected || article.hidden) return copyFailed;
    const selection = window.getSelection();
    if (!selection) return copyFailed;
    const previous = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
    const active = document.activeElement;
    const field = document.createElement('textarea');
    field.className = 'visually-hidden';
    field.readOnly = true;
    field.value = text;
    document.body.append(field);
    let didCopy = false;
    try {
      field.focus({ preventScroll: true });
      field.select();
      didCopy = document.execCommand('copy');
    } catch {
      // Leave the original code selected if the browser also blocks legacy copying.
    } finally {
      field.remove();
      active?.focus({ preventScroll: true });
    }
    selection.removeAllRanges();
    if (didCopy) {
      for (const oldRange of previous) selection.addRange(oldRange);
      return copied;
    }
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.addRange(range);
    return copySelected;
  }
}

function addCopyButtons() {
  const feedback = document.createElement('span');
  feedback.setAttribute('aria-hidden', 'true');
  let announceFeedback;
  let clearFeedback;
  for (const code of article.querySelectorAll('pre > code')) {
    const pre = code.parentElement;
    const block = document.createElement('div');
    block.className = 'code-block';
    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    const language = [...code.classList].find((name) => name.startsWith('language-'))?.slice('language-'.length);
    if (language) {
      const label = document.createElement('span');
      label.className = 'code-language';
      label.textContent = language;
      toolbar.append(label);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', article.dataset.copy);
    button.title = article.dataset.copy;
    const icon = document.createElement('span');
    icon.className = 'copy-icon';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    button.addEventListener('click', async () => {
      const message = await copyCode(code);
      clearTimeout(announceFeedback);
      clearTimeout(clearFeedback);
      toolbar.insertBefore(feedback, button);
      feedback.textContent = message;
      // Give assistive technology time to observe the empty region before repeating a message.
      copyStatus.textContent = '';
      announceFeedback = setTimeout(() => { copyStatus.textContent = message; }, 100);
      clearFeedback = setTimeout(() => {
        feedback.remove();
        copyStatus.textContent = '';
      }, 2500);
    });
    toolbar.append(button);
    pre.replaceWith(block);
    block.append(toolbar, pre);
  }
}

async function renderMathBlocks() {
  if (!article.querySelector('.math-block[data-math], .math-inline[data-math]')) return;
  const { renderMath } = await import('./markdown-math.js');
  await renderMath(article);
}

async function highlightCode() {
  const blocks = [];
  for (const code of article.querySelectorAll('pre > code[class*="language-"]')) {
    const lang = codeLanguage(code);
    if (!lang || SKIP_HIGHLIGHT_LANGS.has(lang.toLowerCase())) continue;
    if ((code.textContent ?? '').length > MAX_HIGHLIGHT_CHARS) continue;
    blocks.push({ code, lang });
  }
  if (!blocks.length) return;
  const { highlightBlocks } = await import('./markdown-highlight.js');
  highlightBlocks(blocks);
}

async function renderDiagrams() {
  const hasDiagram = [...article.querySelectorAll('pre > code[class*="language-"]')].some((code) =>
    MERMAID_LANGS.has(codeLanguage(code).toLowerCase()),
  );
  if (!hasDiagram) return;
  const { renderDiagrams: renderPeleDiagrams } = await import('./markdown-diagram.js');
  await renderPeleDiagrams(article);
}

try {
  const sourceNode = document.getElementById('reader:markdown');
  const text = JSON.parse(sourceNode.textContent);
  rawSource = text;
  sourceNode.textContent = '';
  ready = true;
  article.innerHTML = parser.render(text);
  addCopyButtons();
  const slugger = new GithubSlugger();
  for (const heading of article.querySelectorAll('h1, h2, h3, h4, h5, h6')) heading.id = slugger.slug(heading.textContent);
  rendered = true;
  select('preview');
  if (location.hash) {
    // The heading did not exist when the browser first processed the fragment.
    try { document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView(); } catch {}
  }
  void renderMathBlocks().catch(() => {});
  void highlightCode().catch(() => {});
  void renderDiagrams().catch(() => {});
} catch {
  status.textContent = status.dataset.error;
}
