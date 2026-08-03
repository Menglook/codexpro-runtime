#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathGuard } from '../dist/guard.js';
import {
  analyzeAuthorizationPayload,
  createAuthorizationPayloadBinding,
  verifyAuthorizationPayloadBinding
} from '../dist/security/authorizationIntegrity.js';

const blockedGlobs = [
  '.git', '.git/**', '**/.git/**',
  'node_modules', 'node_modules/**', '**/node_modules/**',
  '.env', '.env/**', '.env.*', '.env.*/**', '**/.env', '**/.env/**', '**/.env.*', '**/.env.*/**',
  '**/*.pem', '**/*.key', '**/id_rsa', '**/id_rsa.*', '**/id_ed25519', '**/id_ed25519.*', '**/.ssh/**'
];

function expectDenied(label, action) {
  let denied = false;
  try {
    action();
  } catch {
    denied = true;
  }
  assert.equal(denied, true, `${label} must be denied`);
}

const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-security-smoke-'));
try {
  process.env.CODEXPRO_HOME = path.join(base, 'codexpro-home');
  const { BrowserAuthorizationStore } = await import('../dist/browser/browser-authorization.js');

  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(root, 'README.md'), '# fixture\n');
  await fsp.writeFile(path.join(outside, 'outside.txt'), 'placeholder\n');
  await fsp.symlink(path.join(outside, 'outside.txt'), path.join(root, 'escape-link'));

  const workspace = {
    id: 'ws_security_smoke',
    root: fs.realpathSync(root),
    openedAt: new Date().toISOString()
  };
  const guard = new PathGuard({ blockedGlobs });

  assert.equal(guard.resolve(workspace, 'README.md').relPath, 'README.md');
  expectDenied('blocked credential path', () => guard.resolve(workspace, '.env'));
  expectDenied('parent escape', () => guard.resolve(workspace, '../outside/outside.txt'));
  expectDenied('symlink escape', () => guard.resolve(workspace, 'escape-link'));

  const suspiciousPayload = { operation: 're\u200Bad', target: 'README.md' };
  const integrity = analyzeAuthorizationPayload(suspiciousPayload);
  assert.equal(integrity.requires_warning, true);
  assert.equal(integrity.unicode_findings.some((finding) => finding.code === 'zero_width_character'), true);

  const cleanPayload = { operation: 'read', target: 'README.md' };
  const binding = createAuthorizationPayloadBinding(cleanPayload, {
    scope: 'public-security-smoke',
    approvedBy: 'maintainer-test',
    manualConfirmation: true
  });
  assert.equal(verifyAuthorizationPayloadBinding(cleanPayload, binding).valid, true);
  assert.equal(verifyAuthorizationPayloadBinding({ ...cleanPayload, target: 'OTHER.md' }, binding).valid, false);

  const rejectedBrowser = new BrowserAuthorizationStore(60_000, 60_000);
  const rejectedChallenge = rejectedBrowser.createChallenge('browser-smoke-01');
  expectDenied('credentialed browser URL', () => rejectedBrowser.authorize({
    challenge: rejectedChallenge.challenge,
    authorizationId: 'authorization-smoke-0001',
    browserInstanceId: 'browser-smoke-01',
    tabId: 1,
    windowId: 1,
    url: 'https://placeholder:placeholder@example.invalid/'
  }));

  const allowedBrowser = new BrowserAuthorizationStore(60_000, 60_000);
  const allowedChallenge = allowedBrowser.createChallenge('browser-smoke-02');
  const authorization = allowedBrowser.authorize({
    challenge: allowedChallenge.challenge,
    authorizationId: 'authorization-smoke-0002',
    browserInstanceId: 'browser-smoke-02',
    tabId: 2,
    windowId: 1,
    url: 'https://example.invalid/docs'
  });
  assert.equal(authorization.origin, 'https://example.invalid');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'allowed_workspace_path',
      'blocked_credential_path',
      'parent_escape_denied',
      'symlink_escape_denied',
      'unicode_integrity_warning',
      'payload_tamper_denied',
      'credentialed_browser_url_denied',
      'challenge_bound_browser_origin_allowed'
    ]
  }, null, 2));
} finally {
  await fsp.rm(base, { recursive: true, force: true });
}
