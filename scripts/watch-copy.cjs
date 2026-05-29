// scripts/watch-copy.cjs
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const src = path.join(repoRoot, 'src', 'styles.css');
const destDir = path.join(repoRoot, 'dist');
const dest = path.join(destDir, 'styles.css');

function copy() {
  if (!fs.existsSync(src)) {
    console.warn('z5-linter: styles.css not found at', src);
    return;
  }
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(new Date().toLocaleTimeString(), 'z5-linter: copied styles.css to', dest);
}

// initial copy
copy();

// watch for changes
fs.watch(src, { persistent: true }, (eventType) => {
  setTimeout(copy, 50);
});
