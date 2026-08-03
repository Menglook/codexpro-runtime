#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const assetDir = path.join(root, '.github', 'assets');
const frameDir = path.join(assetDir, 'demo-frames');
fs.mkdirSync(frameDir, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout ?? '').trim();
}

const evidence = JSON.parse(run(process.execPath, ['scripts/demo-workflow-smoke.mjs']));
const generatedAt = new Date().toISOString();
const evidenceDocument = {
  schema_version: 'codexpro-public-demo-evidence-v1',
  generated_at: generatedAt,
  generator: 'scripts/generate-demo-assets.mjs',
  generation_base_revision: run('git', ['rev-parse', 'HEAD']),
  workflow: evidence,
  media: {
    quickstart_gif_seconds: 30,
    storyboard_seconds: 90,
    mp4_generated: false,
    mp4_reason: 'No trusted ffmpeg-compatible encoder was available in the generation environment.'
  }
};
fs.writeFileSync(path.join(assetDir, 'demo-evidence.json'), `${JSON.stringify(evidenceDocument, null, 2)}\n`);

const width = 640;
const height = 360;
const palette = [
  [10, 18, 32],
  [17, 29, 50],
  [41, 68, 100],
  [244, 247, 251],
  [53, 208, 127],
  [86, 182, 247],
  [245, 196, 81],
  [255, 107, 107]
];

const FONT = {
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  'A': ['01110','10001','10001','11111','10001','10001','10001'],
  'B': ['11110','10001','10001','11110','10001','10001','11110'],
  'C': ['01111','10000','10000','10000','10000','10000','01111'],
  'D': ['11110','10001','10001','10001','10001','10001','11110'],
  'E': ['11111','10000','10000','11110','10000','10000','11111'],
  'F': ['11111','10000','10000','11110','10000','10000','10000'],
  'G': ['01111','10000','10000','10111','10001','10001','01111'],
  'H': ['10001','10001','10001','11111','10001','10001','10001'],
  'I': ['11111','00100','00100','00100','00100','00100','11111'],
  'J': ['00111','00010','00010','00010','10010','10010','01100'],
  'K': ['10001','10010','10100','11000','10100','10010','10001'],
  'L': ['10000','10000','10000','10000','10000','10000','11111'],
  'M': ['10001','11011','10101','10101','10001','10001','10001'],
  'N': ['10001','11001','10101','10011','10001','10001','10001'],
  'O': ['01110','10001','10001','10001','10001','10001','01110'],
  'P': ['11110','10001','10001','11110','10000','10000','10000'],
  'Q': ['01110','10001','10001','10001','10101','10010','01101'],
  'R': ['11110','10001','10001','11110','10100','10010','10001'],
  'S': ['01111','10000','10000','01110','00001','00001','11110'],
  'T': ['11111','00100','00100','00100','00100','00100','00100'],
  'U': ['10001','10001','10001','10001','10001','10001','01110'],
  'V': ['10001','10001','10001','10001','10001','01010','00100'],
  'W': ['10001','10001','10001','10101','10101','11011','10001'],
  'X': ['10001','10001','01010','00100','01010','10001','10001'],
  'Y': ['10001','10001','01010','00100','00100','00100','00100'],
  'Z': ['11111','00001','00010','00100','01000','10000','11111'],
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110'],
  ':': ['00000','00100','00100','00000','00100','00100','00000'],
  '.': ['00000','00000','00000','00000','00000','00110','00110'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '/': ['00001','00010','00100','01000','10000','00000','00000'],
  '+': ['00000','00100','00100','11111','00100','00100','00000'],
  '<': ['00010','00100','01000','10000','01000','00100','00010'],
  '>': ['01000','00100','00010','00001','00010','00100','01000'],
  '_': ['00000','00000','00000','00000','00000','00000','11111']
};

function canvas(color = 0) {
  const pixels = new Uint8Array(width * height);
  pixels.fill(color);
  return pixels;
}

function setPixel(pixels, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  pixels[y * width + x] = color;
}

function rect(pixels, x, y, w, h, color) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  for (let py = y0; py < y1; py += 1) {
    pixels.fill(color, py * width + x0, py * width + x1);
  }
}

function outline(pixels, x, y, w, h, color, thickness = 2) {
  rect(pixels, x, y, w, thickness, color);
  rect(pixels, x, y + h - thickness, w, thickness, color);
  rect(pixels, x, y, thickness, h, color);
  rect(pixels, x + w - thickness, y, thickness, h, color);
}

function text(pixels, value, x, y, color = 3, scale = 3) {
  let cursor = x;
  for (const rawCharacter of String(value).toUpperCase()) {
    const glyph = FONT[rawCharacter] ?? FONT[' '];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row].length; column += 1) {
        if (glyph[row][column] === '1') {
          rect(pixels, cursor + column * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += 6 * scale;
  }
}

function slide({ eyebrow, title, rows, footer }) {
  const pixels = canvas(0);
  rect(pixels, 0, 0, width, 10, 5);
  text(pixels, eyebrow, 34, 28, 5, 2);
  text(pixels, title, 34, 58, 3, 4);
  let y = 122;
  for (const row of rows) {
    rect(pixels, 34, y, 572, 42, 1);
    outline(pixels, 34, y, 572, 42, 2, 1);
    rect(pixels, 48, y + 13, 16, 16, row.color);
    text(pixels, row.label, 80, y + 11, 3, 2);
    y += 50;
  }
  text(pixels, footer, 34, 332, 6, 2);
  return pixels;
}

const slides = [
  {
    eyebrow: '00-09 SEC',
    title: 'PUBLIC SOURCE PREVIEW',
    rows: [
      { label: 'CLONE PUBLIC REPOSITORY', color: 5 },
      { label: 'NPM PACKAGE NOT PUBLISHED', color: 6 },
      { label: 'NO HOSTED SERVICE REQUIRED', color: 4 }
    ],
    footer: 'REAL STATUS - NO RELEASE CLAIM'
  },
  {
    eyebrow: '09-18 SEC',
    title: 'INSTALL SAFELY',
    rows: [
      { label: 'NPM CI --IGNORE-SCRIPTS', color: 4 },
      { label: 'DEPENDENCY LIFECYCLE DISABLED', color: 4 },
      { label: 'SOURCE TREE REMAINS LOCAL', color: 5 }
    ],
    footer: 'PUBLIC REPOSITORY ONLY'
  },
  {
    eyebrow: '18-27 SEC',
    title: 'BUILD AND INSPECT',
    rows: [
      { label: 'TYPECHECK PASS', color: 4 },
      { label: 'BUILD PASS', color: 4 },
      { label: 'CLI HELP PASS', color: 4 }
    ],
    footer: 'REPRODUCIBLE COMMAND EVIDENCE'
  },
  {
    eyebrow: '27-36 SEC',
    title: 'BOUND WORKSPACE',
    rows: [
      { label: 'DISPOSABLE PUBLIC FIXTURE', color: 5 },
      { label: 'READ README INSIDE ROOT', color: 4 },
      { label: 'ONE REVIEWABLE FILE CHANGE', color: 6 }
    ],
    footer: 'WORKSPACE ID WS_PUBLIC_DEMO'
  },
  {
    eyebrow: '36-45 SEC',
    title: 'REVIEW THE DIFF',
    rows: [
      { label: 'CHANGED FILE README.MD', color: 6 },
      { label: 'UNIFIED DIFF CAPTURED', color: 5 },
      { label: 'NO HIDDEN SIDE EFFECT', color: 4 }
    ],
    footer: 'MAINTAINER CAN INSPECT BEFORE DELIVERY'
  },
  {
    eyebrow: '45-54 SEC',
    title: 'REAL REFUSAL',
    rows: [
      { label: 'DOT ENV DENIED', color: 7 },
      { label: 'PARENT ESCAPE DENIED', color: 7 },
      { label: 'SYMLINK ESCAPE DENIED', color: 7 }
    ],
    footer: 'FAIL-CLOSED RESULTS FROM PATH GUARD'
  },
  {
    eyebrow: '54-63 SEC',
    title: 'SECURITY CONTROL SMOKE',
    rows: [
      { label: 'PAYLOAD TAMPER DENIED', color: 7 },
      { label: 'CREDENTIAL URL DENIED', color: 7 },
      { label: 'CLEAN HTTPS ORIGIN ALLOWED', color: 4 }
    ],
    footer: 'TEMPORARY STATE AND PLACEHOLDER DATA'
  },
  {
    eyebrow: '63-72 SEC',
    title: 'EVIDENCE BEFORE CLAIMS',
    rows: [
      { label: 'VALIDATION RESULT RECORDED', color: 4 },
      { label: 'CHANGED FILES RECORDED', color: 5 },
      { label: 'UNVERIFIED WORK STAYS VISIBLE', color: 6 }
    ],
    footer: 'MODEL TEXT IS NOT COMPLETION PROOF'
  },
  {
    eyebrow: '72-81 SEC',
    title: 'HUMAN REVIEW GATE',
    rows: [
      { label: 'NO GIT REMOTE IN FIXTURE', color: 4 },
      { label: 'NO AUTOMATIC PUSH', color: 4 },
      { label: 'NO AUTOMATIC DEPLOY', color: 4 }
    ],
    footer: 'EXTERNAL EFFECTS REQUIRE APPROVAL'
  },
  {
    eyebrow: '81-90 SEC',
    title: 'MAINTAINER DECIDES',
    rows: [
      { label: 'REVIEW DIFF AND TESTS', color: 5 },
      { label: 'DECIDE COMMIT MERGE RELEASE', color: 6 },
      { label: 'CODEXPRO IS NOT OPENAI', color: 3 }
    ],
    footer: 'LOCAL EVIDENCE-DRIVEN CONTROL PLANE'
  }
];

const frames = slides.map(slide);

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function pngBuffer(indices) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = palette[indices[y * width + x]];
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function u16le(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function packCodes(codes) {
  const output = [];
  let accumulator = 0;
  let bits = 0;
  for (const code of codes) {
    accumulator |= code << bits;
    bits += 9;
    while (bits >= 8) {
      output.push(accumulator & 0xff);
      accumulator >>>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) output.push(accumulator & 0xff);
  return Buffer.from(output);
}

function gifImageData(indices) {
  const clearCode = 256;
  const endCode = 257;
  const codes = [clearCode];
  let sinceClear = 0;
  for (const index of indices) {
    if (sinceClear >= 200) {
      codes.push(clearCode);
      sinceClear = 0;
    }
    codes.push(index);
    sinceClear += 1;
  }
  codes.push(endCode);
  const packed = packCodes(codes);
  const blocks = [Buffer.from([8])];
  for (let offset = 0; offset < packed.length; offset += 255) {
    const block = packed.subarray(offset, Math.min(offset + 255, packed.length));
    blocks.push(Buffer.from([block.length]), block);
  }
  blocks.push(Buffer.from([0]));
  return Buffer.concat(blocks);
}

function gifBuffer(gifFrames) {
  const globalTable = Buffer.alloc(256 * 3);
  palette.forEach(([r, g, b], index) => {
    globalTable[index * 3] = r;
    globalTable[index * 3 + 1] = g;
    globalTable[index * 3 + 2] = b;
  });
  const parts = [
    Buffer.from('GIF89a', 'ascii'),
    u16le(width),
    u16le(height),
    Buffer.from([0xf7, 0x00, 0x00]),
    globalTable,
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00])
  ];
  for (const indices of gifFrames) {
    parts.push(
      Buffer.from([0x21, 0xf9, 0x04, 0x00]),
      u16le(500),
      Buffer.from([0x00, 0x00]),
      Buffer.from([0x2c]),
      u16le(0), u16le(0), u16le(width), u16le(height), Buffer.from([0x00]),
      gifImageData(indices)
    );
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

for (let index = 0; index < frames.length; index += 1) {
  fs.writeFileSync(path.join(frameDir, `frame-${String(index + 1).padStart(2, '0')}.png`), pngBuffer(frames[index]));
}

fs.copyFileSync(path.join(frameDir, 'frame-01.png'), path.join(assetDir, '01-connection.png'));
fs.copyFileSync(path.join(frameDir, 'frame-04.png'), path.join(assetDir, '02-workspace.png'));
fs.copyFileSync(path.join(frameDir, 'frame-05.png'), path.join(assetDir, '03-change-review.png'));
fs.copyFileSync(path.join(frameDir, 'frame-06.png'), path.join(assetDir, '04-refusal.png'));
fs.writeFileSync(path.join(assetDir, 'quickstart.gif'), gifBuffer(frames.slice(0, 6)));

const architectureSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="520" viewBox="0 0 1200 520"><rect width="1200" height="520" fill="#0a1220"/><style>text{font-family:Arial,sans-serif;fill:#f4f7fb}.h{font-size:30px;font-weight:700}.s{font-size:18px}.box{fill:#111d32;stroke:#56b6f7;stroke-width:3}.arrow{stroke:#35d07f;stroke-width:5;marker-end:url(#a)}</style><defs><marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#35d07f"/></marker></defs><text class="h" x="50" y="55">CodexPro public architecture</text><rect class="box" x="55" y="170" rx="18" width="210" height="120"/><text class="h" x="95" y="220">MCP client</text><text class="s" x="85" y="255">maintainer intent</text><rect class="box" x="365" y="135" rx="18" width="280" height="190"/><text class="h" x="415" y="205">CodexPro</text><text class="s" x="405" y="245">workspace + policy</text><text class="s" x="405" y="275">tasks + evidence</text><rect class="box" x="745" y="105" rx="18" width="390" height="120"/><text class="h" x="800" y="158">Allowed workspace</text><text class="s" x="810" y="193">bounded local source tree</text><rect class="box" x="745" y="285" rx="18" width="390" height="120"/><text class="h" x="830" y="338">Local handoff</text><text class="s" x="805" y="373">optional executor + receipts</text><path class="arrow" d="M265 230 H355"/><path class="arrow" d="M645 190 H735"/><path class="arrow" d="M645 275 H735"/><text class="s" x="55" y="470">Human review remains authoritative for commit, merge, release, publication, and deployment.</text></svg>`;
fs.writeFileSync(path.join(assetDir, 'architecture.svg'), architectureSvg);

const securitySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="620" viewBox="0 0 1200 620"><rect width="1200" height="620" fill="#0a1220"/><style>text{font-family:Arial,sans-serif;fill:#f4f7fb}.h{font-size:30px;font-weight:700}.s{font-size:18px}.box{fill:#111d32;stroke-width:3}.g{stroke:#35d07f}.c{stroke:#56b6f7}.y{stroke:#f5c451}.r{stroke:#ff6b6b}</style><text class="h" x="50" y="55">Security boundary and review gate</text><rect class="box g" x="70" y="120" rx="18" width="470" height="105"/><text class="h" x="110" y="170">1. Authenticated transport</text><text class="s" x="110" y="200">public or non-loopback HTTP fails closed</text><rect class="box c" x="660" y="120" rx="18" width="470" height="105"/><text class="h" x="700" y="170">2. Allowed root</text><text class="s" x="700" y="200">traversal, blocked paths, symlinks denied</text><rect class="box y" x="70" y="280" rx="18" width="470" height="105"/><text class="h" x="110" y="330">3. Tool policy</text><text class="s" x="110" y="360">read, write, Bash, Git, browser capabilities</text><rect class="box r" x="660" y="280" rx="18" width="470" height="105"/><text class="h" x="700" y="330">4. Evidence and refusal</text><text class="s" x="700" y="360">failed checks remain visible and reviewable</text><rect class="box g" x="365" y="445" rx="18" width="470" height="105"/><text class="h" x="435" y="495">5. Human review gate</text><text class="s" x="440" y="525">external effects require explicit approval</text></svg>`;
fs.writeFileSync(path.join(assetDir, 'security-boundary.svg'), securitySvg);

const storyboard = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="760" viewBox="0 0 1600 760"><rect width="1600" height="760" fill="#0a1220"/><style>text{font-family:Arial,sans-serif;fill:#f4f7fb}.h{font-size:32px;font-weight:700}.t{font-size:20px}.box{fill:#111d32;stroke:#294464;stroke-width:2}</style><text class="h" x="45" y="55">90-second evidence demo storyboard</text>${slides.map((item, index) => { const x=45+(index%5)*305; const y=100+Math.floor(index/5)*300; return `<rect class="box" x="${x}" y="${y}" rx="14" width="275" height="250"/><text class="t" x="${x+20}" y="${y+35}">${index*9}-${(index+1)*9}s</text><text class="h" x="${x+20}" y="${y+80}">${item.title.replaceAll('&','&amp;')}</text>${item.rows.map((row,rowIndex)=>`<text class="t" x="${x+20}" y="${y+125+rowIndex*35}">• ${row.label.replaceAll('&','&amp;')}</text>`).join('')}`; }).join('')}</svg>`;
fs.writeFileSync(path.join(assetDir, 'demo-90s-storyboard.svg'), storyboard);

console.log(JSON.stringify({
  ok: true,
  generated_at: generatedAt,
  evidence: '.github/assets/demo-evidence.json',
  quickstart_gif: '.github/assets/quickstart.gif',
  screenshots: ['01-connection.png','02-workspace.png','03-change-review.png','04-refusal.png'],
  diagrams: ['architecture.svg','security-boundary.svg','demo-90s-storyboard.svg'],
  mp4_generated: false
}, null, 2));
