#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const assetDir = path.join(root, '.github', 'assets');

function required(relativePath) {
  const target = path.join(root, relativePath);
  assert.equal(fs.existsSync(target), true, `missing ${relativePath}`);
  return target;
}

function verifyMagic(relativePath, expected) {
  const target = required(relativePath);
  const buffer = fs.readFileSync(target);
  assert.equal(buffer.subarray(0, expected.length).equals(expected), true, `invalid magic for ${relativePath}`);
  assert.ok(buffer.length > 100, `${relativePath} is unexpectedly small`);
  return buffer.length;
}

function assertPublicText(text, label) {
  const forbiddenFragments = [
    '/home/',
    'Menglook/codexpro-gpt',
    '.codexpro/',
    '.ai-bridge/',
    'named-tunnel-identity'
  ];
  for (const fragment of forbiddenFragments) {
    assert.equal(text.includes(fragment), false, `${label} contains private fragment: ${fragment}`);
  }
}

const pngs = [
  '.github/assets/01-connection.png',
  '.github/assets/02-workspace.png',
  '.github/assets/03-change-review.png',
  '.github/assets/04-refusal.png'
];
for (let index = 1; index <= 10; index += 1) {
  pngs.push(`.github/assets/demo-frames/frame-${String(index).padStart(2, '0')}.png`);
}

const sizes = {};
for (const file of pngs) {
  sizes[file] = verifyMagic(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}
sizes['.github/assets/quickstart.gif'] = verifyMagic(
  '.github/assets/quickstart.gif',
  Buffer.from('GIF89a', 'ascii')
);

for (const file of [
  '.github/assets/architecture.svg',
  '.github/assets/security-boundary.svg',
  '.github/assets/demo-90s-storyboard.svg'
]) {
  const text = fs.readFileSync(required(file), 'utf8');
  assert.match(text, /^<svg\b/);
  assertPublicText(text, file);
  sizes[file] = Buffer.byteLength(text);
}

const evidencePath = required('.github/assets/demo-evidence.json');
const evidenceText = fs.readFileSync(evidencePath, 'utf8');
assertPublicText(evidenceText, '.github/assets/demo-evidence.json');
const evidence = JSON.parse(evidenceText);
assert.equal(evidence.schema_version, 'codexpro-public-demo-evidence-v1');
assert.equal(evidence.workflow.ok, true);
assert.equal(evidence.workflow.source_mode, 'public-source-preview');
assert.equal(evidence.workflow.npm_package_published, false);
assert.deepEqual(evidence.workflow.change.changed_files, ['README.md']);
assert.deepEqual(evidence.workflow.refusal, {
  blocked_env: true,
  parent_escape: true,
  symlink_escape: true
});
assert.deepEqual(evidence.workflow.external_effects.git_remotes, []);
assert.equal(evidence.workflow.external_effects.automatic_push, false);
assert.equal(evidence.workflow.external_effects.automatic_deploy, false);
assert.equal(evidence.media.quickstart_gif_seconds, 30);
assert.equal(evidence.media.storyboard_seconds, 90);
assert.equal(evidence.media.mp4_generated, false);

const smoke = spawnSync(process.execPath, ['scripts/demo-workflow-smoke.mjs'], {
  cwd: root,
  encoding: 'utf8'
});
assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
const current = JSON.parse(smoke.stdout);
assert.equal(current.ok, true);
assert.deepEqual(current.refusal, evidence.workflow.refusal);
assert.deepEqual(current.external_effects, evidence.workflow.external_effects);

for (const file of [
  'docs/demo.md',
  'scripts/generate-demo-assets.mjs',
  'scripts/demo-workflow-smoke.mjs',
  'scripts/render-demo-video.mjs'
]) {
  required(file);
}

console.log(JSON.stringify({
  ok: true,
  png_count: pngs.length,
  gif: true,
  svg_count: 3,
  workflow_reproduced: true,
  mp4_present: fs.existsSync(path.join(assetDir, 'demo.mp4')),
  sizes
}, null, 2));
