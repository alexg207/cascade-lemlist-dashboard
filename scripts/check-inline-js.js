#!/usr/bin/env node
// Pre-deploy guard for the single-file frontend.
//
// A single-file vanilla-JS app has a nasty failure mode: a duplicate top-level
// declaration (e.g. two `const API = ...`) is a SyntaxError that silently kills
// the ENTIRE inline <script> — the page renders blank with no console error
// after load. `node --check` on a .js file catches this, but the script is
// embedded in index.html, so we extract it and compile it with vm.Script, which
// throws on both plain syntax errors AND "Identifier 'x' has already been
// declared". Also runs `node --check` on every real .js file in the repo.
//
// Usage: node scripts/check-inline-js.js   (npm run check)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failed = false;

// 1) Inline <script> in public/index.html
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
if (!scripts.length) { console.error('✗ no inline <script> found in index.html'); process.exit(1); }
scripts.forEach((src, i) => {
  try {
    // Compiling (not running) surfaces syntax + duplicate-declaration errors.
    new vm.Script(src, { filename: `index.html#inline-${i}` });
    console.log(`ok: index.html inline script #${i} (${src.split('\n').length} lines)`);
  } catch (e) {
    console.error(`✗ index.html inline script #${i}: ${e.message}`);
    failed = true;
  }
});

// 2) node --check every .js in lib/, api/, scripts/, plus server.js
function walk(dir) {
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out = out.concat(walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}
const jsFiles = ['server.js'].map(f => path.join(ROOT, f))
  .concat(['lib', 'api', 'scripts'].flatMap(d => { const dd = path.join(ROOT, d); return fs.existsSync(dd) ? walk(dd) : []; }));
for (const f of jsFiles) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    console.log(`ok: ${path.relative(ROOT, f)}`);
  } catch (e) {
    console.error(`✗ ${path.relative(ROOT, f)}: ${e.stderr ? e.stderr.toString() : e.message}`);
    failed = true;
  }
}

if (failed) { console.error('\nCHECK FAILED'); process.exit(1); }
console.log('\n✓ all checks passed');
