#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  env: process.env
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'npm pack --dry-run failed\n');
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  console.error(`Unable to parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const packageReport = Array.isArray(report) ? report[0] : report;
const files = Array.isArray(packageReport?.files) ? packageReport.files.map((entry) => String(entry.path ?? '')) : [];
const forbiddenPatterns = [
  /(^|\/)\.codexpro(\/|$)/i,
  /(^|\/)\.ai-bridge(\/|$)/i,
  /(^|\/)planning-local(\/|$)/i,
  /(^|\/)benchmarks(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)codexpro-stack\.mjs$/i,
  /(^|\/)(?:token|credentials?|cookies?)(?:\.|$)/i
];
const forbidden = files.filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file)));

const required = [
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'NOTICE.md',
  'SECURITY.md',
  'GOVERNANCE.md',
  'ROADMAP.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'PUBLIC_LAUNCH_CHECKLIST.md',
  'docs/quickstart.md',
  'docs/architecture.md',
  'docs/security-model.md',
  'docs/maintainer-workflows.md',
  'docs/adoption.md',
  'docs/public-boundary.md',
  'docs/troubleshooting.md'
];
const missing = required.filter((file) => !files.includes(file));

const summary = {
  ok: forbidden.length === 0 && missing.length === 0,
  package: packageReport?.name ?? null,
  version: packageReport?.version ?? null,
  fileCount: files.length,
  forbidden,
  missing
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exit(1);
