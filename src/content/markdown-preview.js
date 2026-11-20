import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import './markdown-preview.css';

const MAX_RENDERED_DIAGRAMS = 20;

for (const [name, language] of Object.entries({ bash, css, go, javascript, json, markdown, python, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language);
}

const parser = new MarkdownIt({
  html: false,
  highlight(code, lang) {
    if (code.length > 64 * 1024 || lang.toLowerCase() === 'mermaid' || !hljs.getLanguage(lang)) return '';
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  },
});

const article = document.getElementById('reader:preview');
const source = document.getElementById('reader:source');
const status = document.querySelector('[role=status]');
const buttons = document.querySelectorAll('[data-view]');
let ready = false;
let rendered = false;

function select(view) {
  article.hidden = !rendered || view !== 'preview';
  source.hidden = !ready || view !== 'source';
  status.hidden = view === 'source' ? ready : rendered;
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.view === view));
}

for (const button of buttons) button.addEventListener('click', () => select(button.dataset.view));

async function renderDiagrams() {
  const diagrams = article.querySelectorAll('pre > code.language-mermaid');
  if (!diagrams.length) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
  });
  // Bound the total layout work and leave any remaining diagrams readable as code.
  for (let index = 0; index < Math.min(diagrams.length, MAX_RENDERED_DIAGRAMS); index++) {
    const code = diagrams[index];
    try {
      const { svg } = await mermaid.render(`markdown-diagram-${crypto.randomUUID()}`, code.textContent);
      const figure = document.createElement('figure');
      figure.className = 'diagram';
      figure.innerHTML = svg;
      code.parentElement.replaceWith(figure);
    } catch {
      // Keep the original code block when a diagram cannot be rendered.
    }
  }
}

try {
  const text = JSON.parse(document.getElementById('reader:markdown').textContent);
  source.textContent = text;
  ready = true;
  article.innerHTML = parser.render(text);
  const slugger = new GithubSlugger();
  for (const heading of article.querySelectorAll('h1, h2, h3, h4, h5, h6')) heading.id = slugger.slug(heading.textContent);
  rendered = true;
  select('preview');
  if (location.hash) {
    // The heading did not exist when the browser first processed the fragment.
    try { document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView(); } catch {}
  }
  void renderDiagrams().catch(() => {});
} catch {
  status.textContent = status.dataset.error;
}
