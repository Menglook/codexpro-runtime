#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const sourceRoot = process.cwd();
const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-fresh-install-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? sourceRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
    env: {
      ...process.env,
      CODEXPRO_HOME: path.join(base, 'codexpro-home'),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      ...options.env
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return {
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim()
  };
}

try {
  const packDir = path.join(base, 'pack');
  const consumerDir = path.join(base, 'consumer');
  await fsp.mkdir(packDir, { recursive: true });
  await fsp.mkdir(consumerDir, { recursive: true });

  const packed = run('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', packDir
  ]);
  const packReport = JSON.parse(packed.stdout);
  const report = Array.isArray(packReport) ? packReport[0] : packReport;
  assert.equal(report.name, '@menglook/codexpro');
  assert.equal(report.version, '0.1.0');
  const tarball = path.join(packDir, report.filename);
  assert.equal(fs.existsSync(tarball), true, 'npm tarball was not created');

  const archive = run('tar', ['-tzf', tarball]);
  const entries = archive.stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(entries.length > 100, 'candidate archive is unexpectedly small');
  assert.equal(entries.every((entry) => entry.startsWith('package/')), true);

  const forbiddenPatterns = [
    /(^|\/)\.git(\/|$)/i,
    /(^|\/)\.codexpro(\/|$)/i,
    /(^|\/)\.ai-bridge(\/|$)/i,
    /(^|\/)planning-local(\/|$)/i,
    /(^|\/)benchmarks(\/|$)/i,
    /(^|\/)node_modules(\/|$)/i,
    /(^|\/)\.env(?:\.|$)/i,
    /(^|\/)(?:token|credentials?|cookies?)(?:\.|$)/i,
    /codexpro-stack\.mjs$/i
  ];
  const forbidden = entries.filter((entry) => forbiddenPatterns.some((pattern) => pattern.test(entry)));
  assert.deepEqual(forbidden, [], `forbidden archive entries: ${forbidden.join(', ')}`);

  const requiredEntries = [
    'package/package.json',
    'package/CHANGELOG.md',
    'package/README.md',
    'package/README.zh-CN.md',
    'package/docs/quickstart.md',
    'package/docs/release-readiness.md',
    'package/docs/demo.md',
    'package/.github/assets/quickstart.gif',
    'package/dist/stdio.js',
    'package/dist/http.js',
    'package/scripts/codexpro-cli.mjs',
    'package/scripts/demo-workflow-smoke.mjs'
  ];
  for (const entry of requiredEntries) {
    assert.equal(entries.includes(entry), true, `archive is missing ${entry}`);
  }

  await fsp.writeFile(path.join(consumerDir, 'package.json'), `${JSON.stringify({
    name: 'codexpro-fresh-install-consumer',
    version: '1.0.0',
    private: true,
    type: 'module'
  }, null, 2)}\n`);

  run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball
  ], { cwd: consumerDir, timeout: 240_000 });

  const installedRoot = path.join(consumerDir, 'node_modules', '@menglook', 'codexpro');
  const installedPackage = JSON.parse(await fsp.readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installedPackage.name, '@menglook/codexpro');
  assert.equal(installedPackage.version, '0.1.0');
  assert.equal(installedPackage.private, true);

  const cli = run(process.execPath, [path.join(installedRoot, 'scripts', 'codexpro-cli.mjs'), '--help'], {
    cwd: consumerDir,
    timeout: 30_000
  });
  assert.match(cli.stdout, /CodexPro task commands|CodexPro easy launcher/);

  const stdio = run(process.execPath, [path.join(installedRoot, 'dist', 'stdio.js'), '--help'], {
    cwd: consumerDir,
    timeout: 30_000
  });
  assert.match(`${stdio.stdout}\n${stdio.stderr}`, /CodexPro|Usage|MCP/i);

  const http = run(process.execPath, [path.join(installedRoot, 'dist', 'http.js'), '--help'], {
    cwd: consumerDir,
    timeout: 30_000
  });
  assert.match(`${http.stdout}\n${http.stderr}`, /CodexPro|Usage|HTTP|MCP/i);

  const demo = run(process.execPath, [path.join(installedRoot, 'scripts', 'demo-workflow-smoke.mjs')], {
    cwd: consumerDir,
    timeout: 30_000
  });
  const demoResult = JSON.parse(demo.stdout);
  assert.equal(demoResult.ok, true);
  assert.deepEqual(demoResult.external_effects.git_remotes, []);
  assert.equal(demoResult.external_effects.automatic_push, false);

  console.log(JSON.stringify({
    ok: true,
    package: installedPackage.name,
    version: installedPackage.version,
    archive_file_count: entries.length,
    archive_size: report.size ?? null,
    archive_integrity: report.integrity ?? null,
    forbidden_entries: forbidden,
    installed_cli_help: true,
    installed_stdio_help: true,
    installed_http_help: true,
    packaged_demo_workflow: true,
    registry_used_for_package: false,
    published_package_claimed: false
  }, null, 2));
} finally {
  await fsp.rm(base, { recursive: true, force: true });
}
