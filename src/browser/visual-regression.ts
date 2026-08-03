import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import type { BrowserVisualComparisonEntry } from "./browser-report.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_THRESHOLD_RATIO = 0.001;
const DEFAULT_PIXEL_DELTA_THRESHOLD = 0;

interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

interface PngChunk {
  type: string;
  data: Buffer;
}

export interface ComparePngFilesOptions {
  timestamp?: string;
  label: string;
  device: string;
  beforePath: string;
  afterPath: string;
  beforeRelPath: string;
  afterRelPath: string;
  diffPath?: string;
  diffRelPath?: string;
  beforeUrl?: string;
  afterUrl?: string;
  thresholdRatio?: number;
  pixelDeltaThreshold?: number;
}

function clampRatio(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD_RATIO;
  return Math.max(0, Math.min(1, Number(value)));
}

function clampByte(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PIXEL_DELTA_THRESHOLD;
  return Math.max(0, Math.min(255, Math.floor(Number(value))));
}

function timestamp(): string {
  return new Date().toISOString();
}

function sha256Short(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

function assertPngSignature(buffer: Buffer): void {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("File is not a PNG image.");
  }
}

function readChunks(buffer: Buffer): PngChunk[] {
  assertPngSignature(buffer);
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`Malformed PNG chunk ${type}.`);
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }
  return chunks;
}

function channelCountForColorType(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`Unsupported PNG color type ${colorType}. Only grayscale, RGB, grayscale+alpha, and RGBA screenshots are supported.`);
  }
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const p = left + above - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - above);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return above;
  return upperLeft;
}

function unfilterScanlines(inflated: Buffer, width: number, height: number, channels: number): Uint8Array {
  const rowBytes = width * channels;
  const expectedBytes = height * (rowBytes + 1);
  if (inflated.length < expectedBytes) {
    throw new Error(`PNG data is truncated. Expected at least ${expectedBytes} bytes, got ${inflated.length}.`);
  }

  const out = new Uint8Array(height * rowBytes);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[src];
    src += 1;
    const rowStart = y * rowBytes;
    const prevRowStart = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[src + x];
      const left = x >= channels ? out[rowStart + x - channels] : 0;
      const above = y > 0 ? out[prevRowStart + x] : 0;
      const upperLeft = y > 0 && x >= channels ? out[prevRowStart + x - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + above;
          break;
        case 3:
          value = raw + Math.floor((left + above) / 2);
          break;
        case 4:
          value = raw + paethPredictor(left, above, upperLeft);
          break;
        default:
          throw new Error(`Unsupported PNG filter type ${filter}.`);
      }
      out[rowStart + x] = value & 0xff;
    }
    src += rowBytes;
  }
  return out;
}

function toRgba(raw: Uint8Array, width: number, height: number, colorType: number, channels: number): Uint8Array {
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    const src = i * channels;
    const dst = i * 4;
    if (colorType === 0) {
      const gray = raw[src];
      rgba[dst] = gray;
      rgba[dst + 1] = gray;
      rgba[dst + 2] = gray;
      rgba[dst + 3] = 255;
    } else if (colorType === 2) {
      rgba[dst] = raw[src];
      rgba[dst + 1] = raw[src + 1];
      rgba[dst + 2] = raw[src + 2];
      rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      const gray = raw[src];
      rgba[dst] = gray;
      rgba[dst + 1] = gray;
      rgba[dst + 2] = gray;
      rgba[dst + 3] = raw[src + 1];
    } else {
      rgba[dst] = raw[src];
      rgba[dst + 1] = raw[src + 1];
      rgba[dst + 2] = raw[src + 2];
      rgba[dst + 3] = raw[src + 3];
    }
  }
  return rgba;
}

export function decodePng(buffer: Buffer): DecodedPng {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR")?.data;
  if (!ihdr || ihdr.length < 13) throw new Error("PNG is missing a valid IHDR chunk.");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compression = ihdr[10];
  const filterMethod = ihdr[11];
  const interlace = ihdr[12];
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}. Only 8-bit screenshots are supported.`);
  if (compression !== 0 || filterMethod !== 0 || interlace !== 0) throw new Error("Unsupported PNG compression, filter, or interlace mode.");
  const channels = channelCountForColorType(colorType);
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  if (!idat.length) throw new Error("PNG is missing IDAT data.");
  const inflated = inflateSync(idat);
  const raw = unfilterScanlines(inflated, width, height, channels);
  return { width, height, rgba: toRgba(raw, width, height, colorType, channels) };
}

let crcTable: Uint32Array | undefined;

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buffer: Buffer): number {
  const table = crcTable ?? (crcTable = makeCrcTable());
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error(`RGBA buffer length does not match ${width}x${height}.`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0;
    Buffer.from(rgba.subarray(y * rowBytes, (y + 1) * rowBytes)).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

export async function writePngRgba(path: string, width: number, height: number, rgba: Uint8Array): Promise<void> {
  await fsp.writeFile(path, encodePngRgba(width, height, rgba));
}

function maxPixelDelta(before: Uint8Array, after: Uint8Array, offset: number): number {
  return Math.max(
    Math.abs(before[offset] - after[offset]),
    Math.abs(before[offset + 1] - after[offset + 1]),
    Math.abs(before[offset + 2] - after[offset + 2]),
    Math.abs(before[offset + 3] - after[offset + 3])
  );
}

function buildDiffImage(before: DecodedPng, after: DecodedPng, pixelDeltaThreshold: number): { pixels: Uint8Array; mismatchedPixels: number } {
  const pixels = before.width * before.height;
  const diff = new Uint8Array(pixels * 4);
  let mismatchedPixels = 0;

  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    const mismatch = maxPixelDelta(before.rgba, after.rgba, offset) > pixelDeltaThreshold;
    if (mismatch) {
      mismatchedPixels += 1;
      diff[offset] = 255;
      diff[offset + 1] = 0;
      diff[offset + 2] = 0;
      diff[offset + 3] = 255;
    } else {
      const gray = Math.round((after.rgba[offset] + after.rgba[offset + 1] + after.rgba[offset + 2]) / 3);
      diff[offset] = gray;
      diff[offset + 1] = gray;
      diff[offset + 2] = gray;
      diff[offset + 3] = 255;
    }
  }

  return { pixels: diff, mismatchedPixels };
}

export async function comparePngFiles(options: ComparePngFilesOptions): Promise<BrowserVisualComparisonEntry> {
  const thresholdRatio = clampRatio(options.thresholdRatio);
  const pixelDeltaThreshold = clampByte(options.pixelDeltaThreshold);
  const base = {
    timestamp: options.timestamp ?? timestamp(),
    label: options.label,
    device: options.device,
    beforePath: options.beforeRelPath,
    afterPath: options.afterRelPath,
    beforeUrl: options.beforeUrl,
    afterUrl: options.afterUrl,
    thresholdRatio,
    pixelDeltaThreshold
  };

  let beforeBuffer: Buffer;
  let afterBuffer: Buffer;
  try {
    [beforeBuffer, afterBuffer] = await Promise.all([fsp.readFile(options.beforePath), fsp.readFile(options.afterPath)]);
  } catch (error) {
    return {
      ...base,
      beforeBytes: 0,
      afterBytes: 0,
      beforeHash: "",
      afterHash: "",
      passed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const withFileMeta = {
    ...base,
    beforeBytes: beforeBuffer.length,
    afterBytes: afterBuffer.length,
    beforeHash: sha256Short(beforeBuffer),
    afterHash: sha256Short(afterBuffer)
  };

  try {
    const before = decodePng(beforeBuffer);
    const after = decodePng(afterBuffer);
    if (before.width !== after.width || before.height !== after.height) {
      return {
        ...withFileMeta,
        width: after.width,
        height: after.height,
        totalPixels: Math.max(before.width * before.height, after.width * after.height),
        mismatchedPixels: Math.max(before.width * before.height, after.width * after.height),
        mismatchRatio: 1,
        passed: false,
        error: `Image dimensions differ: before=${before.width}x${before.height}, after=${after.width}x${after.height}`
      };
    }

    const diff = buildDiffImage(before, after, pixelDeltaThreshold);
    const totalPixels = before.width * before.height;
    const mismatchRatio = totalPixels === 0 ? 0 : diff.mismatchedPixels / totalPixels;
    if (options.diffPath) await fsp.writeFile(options.diffPath, encodePngRgba(before.width, before.height, diff.pixels));

    return {
      ...withFileMeta,
      diffPath: options.diffRelPath,
      width: before.width,
      height: before.height,
      totalPixels,
      mismatchedPixels: diff.mismatchedPixels,
      mismatchRatio,
      passed: mismatchRatio <= thresholdRatio
    };
  } catch (error) {
    return {
      ...withFileMeta,
      passed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
