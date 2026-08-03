#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const topLevelDocuments = [
  'README.md',
  'README.zh-CN.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'NOTICE.md',
  'PUBLIC_LAUNCH_CHECKLIST.md'
];

function collectMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectMarkdownFiles(target);
      return entry.isFile() && entry.name.endsWith('.md') ? [target] : [];
    });
}

function normalizeTarget(sourceFile, rawTarget) {
  const withoutTitle = rawTarget.trim().replace(/\s+["'][^"']*["']$/, '');
  const decoded = decodeURIComponent(withoutTitle);
  const withoutAnchor = decoded.split('#', 1)[0].split('?', 1)[0];
  if (!withoutAnchor) return null;
  return path.resolve(path.dirname(sourceFile), withoutAnchor);
}

const documents = [
  ...topLevelDocuments.map((file) => path.join(root, file)),
  ...collectMarkdownFiles(path.join(root, 'docs'))
].filter((file) => fs.existsSync(file));

const failures = [];
let checked = 0;
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const document of documents) {
  const content = fs.readFileSync(document, 'utf8');
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1].trim();
    if (/^(?:https?:|mailto:|tel:|data:)/i.test(rawTarget) || rawTarget.startsWith('#')) continue;
    const target = normalizeTarget(document, rawTarget);
    if (!target) continue;
    checked += 1;
    if (!fs.existsSync(target)) {
      failures.push({
        document: path.relative(root, document),
        target: rawTarget
      });
    }
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, checked, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, documents: documents.length, checked, failures: 0 }, null, 2));
