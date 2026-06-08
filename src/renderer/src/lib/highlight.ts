// Syntax highlighting for the coding-mode solution panel.
//
// We bundle highlight.js (CSP blocks CDN script/style loads in the packaged
// app) and register ONLY the languages the app supports, so the bundle stays
// lean. Tokens are coloured in styles.css against the app's theme vars, so
// highlighting follows dark/light instead of importing a fixed hljs theme.

import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import ruby from 'highlight.js/lib/languages/ruby';
import sql from 'highlight.js/lib/languages/sql';
import type { CodingLanguage } from '../../../shared/ipc';

// Our CodingLanguage values map 1:1 onto highlight.js language ids.
hljs.registerLanguage('python', python);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('go', go);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('sql', sql);

/**
 * Highlight `code` as `language`, returning HTML (token <span>s). highlight.js
 * escapes the code content, so the result is safe to inject. Falls back to
 * escaped plain text if anything goes wrong.
 */
export function highlightCode(code: string, language: CodingLanguage): string {
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}
