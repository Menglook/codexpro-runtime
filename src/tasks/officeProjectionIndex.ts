import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PathGuard, Workspace } from "../guard.js";

export type OfficeProjectionIndexName = "identities" | "goals" | "durable-jobs";

export interface OfficeProjectionIndexFile<T> {
  version: 1;
  updated_at: string;
  entries: Record<string, T>;
}

export interface OfficeProjectionIndexLoadResult<T> {
  entries: Map<string, T>;
  rebuilt: boolean;
  rebuild_duration_ms: number;
}

export type OfficeProjectionIndexEntryValidator<T> = (key: string, value: unknown) => value is T;

const INDEX_ROOT = ".codexpro/office-projection-index";
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 120_000;
const LOCK_POLL_MS = 10;
const MAX_READ_CACHE_ENTRIES = 48;

interface OfficeProjectionIndexReadCacheEntry {
  mtime_ms: number;
  ctime_ms: number;
  size: number;
  file: OfficeProjectionIndexFile<unknown>;
  validated_by: Set<unknown>;
}

const readCache = new Map<string, OfficeProjectionIndexReadCacheEntry>();

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameStat(entry: OfficeProjectionIndexReadCacheEntry, stat: { mtimeMs: number; ctimeMs: number; size: number }): boolean {
  return entry.mtime_ms === stat.mtimeMs && entry.ctime_ms === stat.ctimeMs && entry.size === stat.size;
}

function cacheRead<T>(
  filePath: string,
  stat: { mtimeMs: number; ctimeMs: number; size: number },
  validate?: OfficeProjectionIndexEntryValidator<T>
): OfficeProjectionIndexFile<T> | null {
  const cached = readCache.get(filePath);
  if (!cached || !sameStat(cached, stat)) return null;
  if (validate && !cached.validated_by.has(validate)) {
    if (Object.entries(cached.file.entries).some(([key, value]) => !validate(key, value))) {
      readCache.delete(filePath);
      return null;
    }
    cached.validated_by.add(validate);
  }
  readCache.delete(filePath);
  readCache.set(filePath, cached);
  return cached.file as OfficeProjectionIndexFile<T>;
}

function cacheWrite<T>(
  filePath: string,
  stat: { mtimeMs: number; ctimeMs: number; size: number },
  file: OfficeProjectionIndexFile<T>,
  validate?: OfficeProjectionIndexEntryValidator<T>
): void {
  readCache.delete(filePath);
  readCache.set(filePath, {
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    size: stat.size,
    file: file as OfficeProjectionIndexFile<unknown>,
    validated_by: new Set(validate ? [validate] : [])
  });
  while (readCache.size > MAX_READ_CACHE_ENTRIES) {
    const oldest = readCache.keys().next().value;
    if (typeof oldest !== "string") break;
    readCache.delete(oldest);
  }
}

function cacheDelete(filePath: string): void {
  readCache.delete(filePath);
}

function indexPath(name: OfficeProjectionIndexName): string {
  return `${INDEX_ROOT}/${name}.json`;
}

function lockPath(name: OfficeProjectionIndexName): string {
  return `${INDEX_ROOT}/${name}.lock`;
}

function invalidPath(name: OfficeProjectionIndexName): string {
  return `${INDEX_ROOT}/${name}.invalid`;
}

async function readFile<T>(
  guard: PathGuard,
  workspace: Workspace,
  name: OfficeProjectionIndexName,
  validate?: OfficeProjectionIndexEntryValidator<T>
): Promise<OfficeProjectionIndexFile<T> | null> {
  const invalid = guard.resolve(workspace, invalidPath(name));
  const resolved = guard.resolve(workspace, indexPath(name));
  try {
    const [invalidState, before] = await Promise.all([
      fsp.access(invalid.absPath)
        .then(() => "present" as const)
        .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "absent" as const : "error" as const),
      fsp.stat(resolved.absPath)
    ]);
    if (invalidState !== "absent") {
      cacheDelete(resolved.absPath);
      return null;
    }
    const cached = cacheRead<T>(resolved.absPath, before, validate);
    if (cached) return cached;
    const parsed = JSON.parse(await fsp.readFile(resolved.absPath, "utf8")) as OfficeProjectionIndexFile<T>;
    if (
      parsed.version !== 1
      || typeof parsed.updated_at !== "string"
      || !Number.isFinite(Date.parse(parsed.updated_at))
      || !parsed.entries
      || typeof parsed.entries !== "object"
      || Array.isArray(parsed.entries)
    ) {
      cacheDelete(resolved.absPath);
      return null;
    }
    if (validate && Object.entries(parsed.entries).some(([key, value]) => !validate(key, value))) {
      cacheDelete(resolved.absPath);
      return null;
    }
    const after = await fsp.stat(resolved.absPath);
    if (before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.size === after.size) {
      cacheWrite(resolved.absPath, after, parsed, validate);
    }
    return parsed;
  } catch (error) {
    cacheDelete(resolved.absPath);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeFile<T>(
  guard: PathGuard,
  workspace: Workspace,
  name: OfficeProjectionIndexName,
  entries: Record<string, T>
): Promise<void> {
  const target = guard.resolve(workspace, indexPath(name), { forWrite: true });
  await fsp.mkdir(path.dirname(target.absPath), { recursive: true });
  const temporary = `${target.absPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const payload: OfficeProjectionIndexFile<T> = {
    version: 1,
    updated_at: new Date().toISOString(),
    entries
  };
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporary, target.absPath);
    const stat = await fsp.stat(target.absPath);
    cacheWrite(target.absPath, stat, payload);
    const invalid = guard.resolve(workspace, invalidPath(name), { forWrite: true });
    await fsp.rm(invalid.absPath, { force: true }).catch(() => undefined);
  } catch (error) {
    cacheDelete(target.absPath);
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withIndexLock<T>(
  guard: PathGuard,
  workspace: Workspace,
  name: OfficeProjectionIndexName,
  operation: () => Promise<T>
): Promise<T> {
  const lock = guard.resolve(workspace, lockPath(name), { forWrite: true });
  await fsp.mkdir(path.dirname(lock.absPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fsp.mkdir(lock.absPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fsp.stat(lock.absPath).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fsp.rm(lock.absPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Office projection index lock timed out: ${name}`);
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await operation();
  } finally {
    await fsp.rm(lock.absPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readOfficeProjectionIndex<T>(
  guard: PathGuard,
  workspace: Workspace,
  name: OfficeProjectionIndexName,
  validate?: OfficeProjectionIndexEntryValidator<T>
): Promise<Map<string, T> | null> {
  const file = await readFile<T>(guard, workspace, name, validate);
  return file ? new Map(Object.entries(file.entries)) : null;
}

export async function ensureOfficeProjectionIndex<T>(
  guard: PathGuard,
  workspace: Workspace,
  name: OfficeProjectionIndexName,
  rebuild: () => Promise<Iterable<readonly [string, T]>>,
  validate?: OfficeProjectionIndexEntryValidator<T>
): Promise<OfficeProjectionIndexLoadResult<T>> {
  const current = await readFile<T>(guard, workspace, name, validate);
  if (current) {
    return {
      entries: new Map(Object.entries(current.entries)),
      rebuilt: false,
      rebuild_duration_ms: 0
    };
  }
  return await withIndexLock(guard, workspace, name, async () => {
    const afterLock = await readFile<T>(guard, workspace, name, validate);
    if (afterLock) {
      return {
        entries: new Map(Object.entries(afterLock.entries)),
        rebuilt: false,
        rebuild_duration_ms: 0
      };
    }
    const startedAt = Date.now();
    const replacement = Object.fromEntries(await rebuild());
    if (validate && Object.entries(replacement).some(([key, value]) => !validate(key, value))) {
      throw new Error(`Office projection index rebuild produced invalid entries: ${name}`);
    }
    await writeFile(guard, workspace, name, replacement);
    return {
      entries: new Map(Object.entries(replacement)),
      rebuilt: true,
      rebuild_duration_ms: Math.max(0, Date.now() - startedAt)
    };
  });
}

export async function replaceOfficeProjectionIndex<T>(
  guard: PathGuard,
  workspace: Workspace,
  name: OfficeProjectionIndexName,
  entries: Iterable<readonly [string, T]>
): Promise<void> {
  const replacement = Object.fromEntries(entries);
  await withIndexLock(guard, workspace, name, async () => {
    await writeFile(guard, workspace, name, replacement);
  });
}

export async function upsertOfficeProjectionIndex<T>(
  guard: PathGuard,
  workspace: Workspace,
  name: OfficeProjectionIndexName,
  key: string,
  value: T
): Promise<void> {
  try {
    await withIndexLock(guard, workspace, name, async () => {
      const current = await readFile<T>(guard, workspace, name);
      if (!current) return;
      await writeFile(guard, workspace, name, {
        ...current.entries,
        [key]: value
      });
    });
  } catch (error) {
    const invalid = guard.resolve(workspace, invalidPath(name), { forWrite: true });
    await fsp.mkdir(path.dirname(invalid.absPath), { recursive: true });
    await fsp.writeFile(invalid.absPath, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 }).catch(() => undefined);
    throw error;
  }
}
