// scripts/copy-css.js
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const src = path.join(repoRoot, 'src', 'styles.css');
const destDir = path.join(repoRoot, 'dist');
const dest = path.join(destDir, 'styles.css');

if (!fs.existsSync(src)) {
  console.error('z5-linter: styles.css not found at', src);
  process.exit(1);
}

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

fs.copyFileSync(src, dest);
console.log('z5-linter: copied styles.css to', dest);
