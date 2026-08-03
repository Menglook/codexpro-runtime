#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PathGuard } from '../dist/guard.js';

const blockedGlobs = [
  '.git', '.git/**', '**/.git/**',
  'node_modules', 'node_modules/**', '**/node_modules/**',
  '.env', '.env/**', '.env.*', '.env.*/**', '**/.env', '**/.env/**', '**/.env.*', '**/.env.*/**',
  '**/*.pem', '**/*.key', '**/id_rsa', '**/id_rsa.*', '**/id_ed25519', '**/id_ed25519.*', '**/.ssh/**'
];

function git(cwd, args, allowFailure = false) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim()
  };
}

function expectDenied(action) {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-public-demo-'));
try {
  const root = path.join(base, 'public-demo-fixture');
  const outside = path.join(base, 'outside');
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(root, 'README.md'), '# Public Demo Fixture\n\nThis repository is disposable.\n');
  await fsp.writeFile(path.join(outside, 'outside.txt'), 'outside fixture\n');
  await fsp.symlink(path.join(outside, 'outside.txt'), path.join(root, 'escape-link'));

  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'CodexPro Public Demo']);
  git(root, ['config', 'user.email', 'demo@example.invalid']);
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--quiet', '-m', 'demo: create disposable fixture']);

  const workspace = {
    id: 'ws_public_demo',
    root: fs.realpathSync(root),
    openedAt: new Date(0).toISOString()
  };
  const guard = new PathGuard({ blockedGlobs });
  const readTarget = guard.resolve(workspace, 'README.md');
  const before = await fsp.readFile(readTarget.absPath, 'utf8');
  assert.match(before, /Public Demo Fixture/);

  await fsp.appendFile(readTarget.absPath, '\n- Reviewable change generated inside the allowed root.\n');
  const after = await fsp.readFile(readTarget.absPath, 'utf8');
  assert.notEqual(before, after);

  const diff = git(root, ['diff', '--', 'README.md']).stdout
    .replaceAll(root, '<PUBLIC_DEMO_ROOT>')
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm, 'index <before>..<after> 100644');
  assert.match(diff, /Reviewable change generated inside the allowed root/);

  const denied = {
    blocked_env: expectDenied(() => guard.resolve(workspace, '.env')),
    parent_escape: expectDenied(() => guard.resolve(workspace, '../outside/outside.txt')),
    symlink_escape: expectDenied(() => guard.resolve(workspace, 'escape-link'))
  };
  assert.deepEqual(denied, {
    blocked_env: true,
    parent_escape: true,
    symlink_escape: true
  });

  const remotes = git(root, ['remote']).stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  assert.deepEqual(remotes, []);

  const result = {
    ok: true,
    fixture: 'public-demo-fixture',
    source_mode: 'public-source-preview',
    npm_package_published: false,
    workspace: {
      id: workspace.id,
      display_root: '<DISPOSABLE_PUBLIC_FIXTURE>',
      allowed_file: 'README.md'
    },
    read: {
      file: 'README.md',
      matched_public_fixture: true
    },
    change: {
      changed_files: ['README.md'],
      diff
    },
    refusal: denied,
    external_effects: {
      git_remotes: remotes,
      automatic_push: false,
      automatic_deploy: false,
      package_publish: false,
      github_release: false
    }
  };

  console.log(JSON.stringify(result, null, 2));
} finally {
  await fsp.rm(base, { recursive: true, force: true });
}
