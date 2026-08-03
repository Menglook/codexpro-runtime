#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));

assert.equal(packageJson.name, '@menglook/codexpro');
assert.equal(packageJson.version, '0.1.0');
assert.equal(packageJson.private, true, 'source candidate must remain private until explicit npm authorization');
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages?.['']?.version, packageJson.version);
assert.equal(packageLock.packages?.['']?.name, packageJson.name);

const changelog = read('CHANGELOG.md');
assert.match(changelog, /0\.1\.0 source candidate/);
assert.match(changelog, /not published to npm/i);

const readiness = read('docs/release-readiness.md');
assert.match(readiness, /public source candidate/i);
assert.match(readiness, /npm registry \| Not published/i);
assert.match(readiness, /GitHub Release \| None/i);
assert.match(readiness, /GitHub Pages \| Not deployed/i);

for (const file of ['README.md', 'README.zh-CN.md', 'docs/quickstart.md', 'PUBLIC_LAUNCH_CHECKLIST.md']) {
  const text = read(file);
  assert.match(text, /not published|not currently installable|without publishing|尚未发布|未发布/i, `${file} must preserve unpublished status`);
}

assert.equal(fs.existsSync(path.join(root, '.github', 'assets', 'demo.mp4')), false, 'an unverified demo MP4 must not appear');
assert.equal(fs.existsSync(path.join(root, '.github', 'workflows', 'pages.yml')), false, 'Pages must not be enabled by this source-candidate change');

const tag = spawnSync('git', ['tag', '--list', 'v0.1.0'], { cwd: root, encoding: 'utf8' });
assert.equal(tag.status, 0);
assert.equal(String(tag.stdout ?? '').trim(), '', 'v0.1.0 tag must not exist before explicit release authorization');

const requiredScripts = [
  'docs:check',
  'typecheck',
  'build',
  'cli:help',
  'security:check',
  'demo:check',
  'package:check',
  'release:readiness',
  'fresh-install:check'
];
for (const script of requiredScripts) assert.ok(packageJson.scripts?.[script], `missing npm script ${script}`);

console.log(JSON.stringify({
  ok: true,
  package: packageJson.name,
  version: packageJson.version,
  source_candidate: true,
  private_package: true,
  git_tag_present: false,
  npm_published_claimed: false,
  github_release_claimed: false,
  pages_deployed_claimed: false,
  required_scripts: requiredScripts
}, null, 2));
