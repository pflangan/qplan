/**
 * Inline the production build into a single self-contained HTML file.
 * Run after `ng build`: `node scripts/inline-build.mjs`
 * Writes dist/work-to-sub-i/browser/index.single.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/work-to-sub-i/browser');
let html = readFileSync(`${dir}/index.html`, 'utf8');

// Inline the hashed stylesheet (Beasties emits it as a print-onload link + noscript fallback).
html = html.replace(
  /<link rel="stylesheet" href="([^"]+)"[^>]*>\s*<noscript>.*?<\/noscript>/g,
  (_m, href) => `<style>${readFileSync(`${dir}/${href}`, 'utf8')}</style>`,
);

// Inline the ES module bundle. Escape any literal "</script" so it can't
// terminate the inline script tag early ("<\/script" is identical to JS).
html = html.replace(
  /<script src="([^"]+)" type="module"><\/script>/g,
  (_m, src) => {
    const js = readFileSync(`${dir}/${src}`, 'utf8').replace(/<\/script/gi, '<\\/script');
    return `<script type="module">${js}</script>`;
  },
);

// Inline the favicon as a data URI so the file needs no sidecar assets.
html = html.replace(
  /<link rel="icon"[^>]*href="favicon\.ico">/,
  `<link rel="icon" type="image/x-icon" href="data:image/x-icon;base64,${readFileSync(`${dir}/favicon.ico`).toString('base64')}">`,
);

const out = `${dir}/index.single.html`;
writeFileSync(out, html);
console.log(`wrote ${out} (${(readFileSync(out).length / 1024).toFixed(0)} kB)`);
