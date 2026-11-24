import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });

// 1. Bundle UI into single self-contained HTML
const uiResult = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'ui', 'app.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  write: false,
});

const uiJs = uiResult.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');
const template = fs.readFileSync(path.join(root, 'src', 'ui', 'template.html'), 'utf8');
const html = template.replace('<!-- INLINE_SCRIPT -->', () => `<script>${uiJs}</script>`);
fs.writeFileSync(path.join(distDir, 'app.html'), html, 'utf8');

// 2. Bundle MCP server into single ESM file (zero runtime node_modules needed)
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'server.ts')],
  bundle: true,
  minify: false,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  outfile: path.join(distDir, 'server.mjs'),
  banner: {
    js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
  },
});

const htmlKB = (Buffer.byteLength(html) / 1024).toFixed(1);
const srvKB = (fs.statSync(path.join(distDir, 'server.mjs')).size / 1024).toFixed(1);
console.log(`Built dist/app.html (${htmlKB} KB) and dist/server.mjs (${srvKB} KB)`);
