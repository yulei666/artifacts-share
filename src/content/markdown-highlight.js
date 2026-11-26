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

for (const [name, language] of Object.entries({ bash, css, go, javascript, json, markdown, python, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language);
}

const MAX_HIGHLIGHT_CHARS = 64 * 1024;

export function highlightBlocks(blocks) {
  for (const { code, lang } of blocks) {
    if (!code.isConnected) continue;
    const text = code.textContent ?? '';
    if (text.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(lang)) continue;
    code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    code.classList.add('hljs');
  }
}
