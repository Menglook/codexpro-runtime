import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import type { ExternalCallRecordV1 } from "./externalCallContract.js";

export const EXTERNAL_CALL_LEDGER_DIRECTORY = ".codexpro/external-calls";
export const EXTERNAL_CALL_LEDGER_FILENAME = "ledger.jsonl";

export interface ExternalCallLedgerAppendResult {
  appended: boolean;
  record: ExternalCallRecordV1;
  path: string;
}

export function externalCallLedgerPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), EXTERNAL_CALL_LEDGER_DIRECTORY, EXTERNAL_CALL_LEDGER_FILENAME);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)])
    );
  }
  return value;
}

function sameRecord(left: ExternalCallRecordV1, right: ExternalCallRecordV1): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function parseLines(text: string): ExternalCallRecordV1[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const value = JSON.parse(line) as ExternalCallRecordV1;
      if (value.version !== 1 || !value.call_id || !Number.isInteger(value.revision)) {
        throw new Error(`Invalid external call ledger entry at line ${index + 1}.`);
      }
      return value;
    });
}

export async function readExternalCallRecords(projectRoot: string): Promise<ExternalCallRecordV1[]> {
  try {
    return parseLines(await fsPromises.readFile(externalCallLedgerPath(projectRoot), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function readExternalCallRecordsSync(projectRoot: string): ExternalCallRecordV1[] {
  try {
    return parseLines(fs.readFileSync(externalCallLedgerPath(projectRoot), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function validateAppend(records: readonly ExternalCallRecordV1[], record: ExternalCallRecordV1): ExternalCallRecordV1 | null {
  const duplicate = records.find((item) => item.call_id === record.call_id && item.revision === record.revision);
  if (duplicate) {
    if (!sameRecord(duplicate, record)) {
      throw new Error(`External call ledger conflict for ${record.call_id} revision ${record.revision}.`);
    }
    return duplicate;
  }
  const latest = [...records].reverse().find((item) => item.call_id === record.call_id);
  if (latest && record.revision <= latest.revision) {
    throw new Error(`External call revision must increase for ${record.call_id}.`);
  }
  return null;
}

export async function appendExternalCallRecord(
  projectRoot: string,
  record: ExternalCallRecordV1
): Promise<ExternalCallLedgerAppendResult> {
  const target = externalCallLedgerPath(projectRoot);
  const records = await readExternalCallRecords(projectRoot);
  const duplicate = validateAppend(records, record);
  if (duplicate) return { appended: false, record: duplicate, path: target };
  await fsPromises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fsPromises.appendFile(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return { appended: true, record, path: target };
}

export function appendExternalCallRecordSync(
  projectRoot: string,
  record: ExternalCallRecordV1
): ExternalCallLedgerAppendResult {
  const target = externalCallLedgerPath(projectRoot);
  const records = readExternalCallRecordsSync(projectRoot);
  const duplicate = validateAppend(records, record);
  if (duplicate) return { appended: false, record: duplicate, path: target };
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  return { appended: true, record, path: target };
}

export async function latestExternalCallRecord(projectRoot: string, callId: string): Promise<ExternalCallRecordV1 | null> {
  const normalized = callId.trim();
  const records = await readExternalCallRecords(projectRoot);
  return records
    .filter((item) => item.call_id === normalized)
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
}

export async function pendingExternalCallRecords(projectRoot: string): Promise<ExternalCallRecordV1[]> {
  const records = await readExternalCallRecords(projectRoot);
  const latest = new Map<string, ExternalCallRecordV1>();
  for (const record of records) {
    const current = latest.get(record.call_id);
    if (!current || record.revision > current.revision) latest.set(record.call_id, record);
  }
  return [...latest.values()].filter((record) => !["completed", "failed", "delivery_unknown"].includes(record.delivery_state));
}

export class ExternalCallLedger {
  constructor(readonly projectRoot: string) {}

  read(): Promise<ExternalCallRecordV1[]> {
    return readExternalCallRecords(this.projectRoot);
  }

  append(record: ExternalCallRecordV1): Promise<ExternalCallLedgerAppendResult> {
    return appendExternalCallRecord(this.projectRoot, record);
  }

  latest(callId: string): Promise<ExternalCallRecordV1 | null> {
    return latestExternalCallRecord(this.projectRoot, callId);
  }

  pending(): Promise<ExternalCallRecordV1[]> {
    return pendingExternalCallRecords(this.projectRoot);
  }
}

export const readExternalCallLedger = readExternalCallRecords;
export const persistExternalCallRecord = appendExternalCallRecord;
export const loadExternalCallRecord = latestExternalCallRecord;
