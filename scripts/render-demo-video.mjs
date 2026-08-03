#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const frameDir = path.join(root, '.github', 'assets', 'demo-frames');
const output = path.join(root, '.github', 'assets', 'demo.mp4');

const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.error(JSON.stringify({
    ok: false,
    reason: 'ffmpeg_unavailable',
    message: 'Install a trusted ffmpeg binary, regenerate the demo assets, then run npm run demo:video.'
  }, null, 2));
  process.exit(2);
}

const frames = Array.from({ length: 10 }, (_, index) =>
  path.join(frameDir, `frame-${String(index + 1).padStart(2, '0')}.png`)
);
for (const frame of frames) {
  if (!fs.existsSync(frame)) {
    console.error(JSON.stringify({ ok: false, reason: 'missing_frame', frame: path.basename(frame) }, null, 2));
    process.exit(1);
  }
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-demo-video-'));
try {
  const list = path.join(temp, 'frames.txt');
  const lines = [];
  for (const frame of frames) {
    lines.push(`file '${frame.replaceAll("'", "'\\''")}'`);
    lines.push('duration 9');
  }
  lines.push(`file '${frames.at(-1).replaceAll("'", "'\\''")}'`);
  fs.writeFileSync(list, `${lines.join('\n')}\n`);

  const render = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'concat',
    '-safe', '0',
    '-i', list,
    '-vf', 'scale=1280:720:flags=neighbor,format=yuv420p',
    '-r', '30',
    '-movflags', '+faststart',
    '-y', output
  ], { cwd: root, encoding: 'utf8' });

  if (render.status !== 0) {
    console.error(render.stderr || render.stdout || 'ffmpeg render failed');
    process.exit(render.status ?? 1);
  }

  console.log(JSON.stringify({
    ok: true,
    output: '.github/assets/demo.mp4',
    duration_seconds: 90,
    source_frames: frames.length
  }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
