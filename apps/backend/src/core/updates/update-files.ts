/**
 * The update service's durable state: `<dataDir>/updates/state.json` (current
 * or last job, notices) and the append-only `audit.jsonl`.
 *
 * Deliberately files, not SQLite: rolling back a failed update can restore
 * the database from its pre-migration snapshot, and the record of that very
 * update must survive the restore. The backend is the only writer of both
 * files; hosts report through the host protocol instead.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  UPDATE_JOB_PHASES,
  type UpdateAuditEntry,
  type UpdateJob,
  type UpdateNotice,
} from "@orkestrator/protocol/updates";

export const UPDATES_DIRECTORY = "updates";
export const MAX_AUDIT_ENTRY_BYTES = 4 * 1024;
export const MAX_AUDIT_FILE_BYTES = 1024 * 1024;
export const MAX_NOTICES = 20;
const MAX_STATE_BYTES = 512 * 1024;

export type PersistedUpdateState = {
  version: 1;
  job: UpdateJob | null;
  notices: UpdateNotice[];
};

const EMPTY_STATE: PersistedUpdateState = { version: 1, job: null, notices: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJob(value: unknown): value is UpdateJob {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.fromVersion === "string" &&
    isRecord(value.target) &&
    typeof value.target.version === "string" &&
    typeof value.target.tag === "string" &&
    (UPDATE_JOB_PHASES as readonly unknown[]).includes(value.phase) &&
    Array.isArray(value.approvedConsentIds) &&
    Array.isArray(value.actionsOnHost)
  );
}

function isNotice(value: unknown): value is UpdateNotice {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.jobId === "string" &&
    Array.isArray(value.items)
  );
}

export class UpdateFiles {
  readonly directory: string;

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, UPDATES_DIRECTORY);
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  get statePath(): string {
    return path.join(this.directory, "state.json");
  }

  get auditPath(): string {
    return path.join(this.directory, "audit.jsonl");
  }

  /** A missing file is a fresh install; a damaged one is kept aside, never trusted. */
  readState(): PersistedUpdateState {
    if (!existsSync(this.statePath)) return { ...EMPTY_STATE, notices: [] };
    try {
      if (statSync(this.statePath).size > MAX_STATE_BYTES) throw new Error("too large");
      const value = JSON.parse(readFileSync(this.statePath, "utf8")) as unknown;
      if (!isRecord(value) || value.version !== 1) throw new Error("unknown shape");
      const job = value.job === null || value.job === undefined ? null : value.job;
      if (job !== null && !isJob(job)) throw new Error("invalid job");
      const notices = Array.isArray(value.notices) ? value.notices.filter(isNotice) : [];
      return { version: 1, job, notices: notices.slice(-MAX_NOTICES) };
    } catch (error) {
      const aside = path.join(this.directory, `state.corrupt-${Date.now()}.json`);
      try {
        renameSync(this.statePath, aside);
      } catch {
        // Unreadable and immovable: the next write replaces it.
      }
      console.warn(
        `[Updates] Ignored an unreadable update state file (${error instanceof Error ? error.message : String(error)})`,
      );
      return { ...EMPTY_STATE, notices: [] };
    }
  }

  writeState(state: PersistedUpdateState): void {
    this.ensureDirectory();
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ ...state, notices: state.notices.slice(-MAX_NOTICES) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, this.statePath);
  }

  appendAudit(entry: UpdateAuditEntry): void {
    this.ensureDirectory();
    let line = JSON.stringify(entry);
    if (Buffer.byteLength(line) > MAX_AUDIT_ENTRY_BYTES) {
      // Keep the who/what/when; the long tail is what goes.
      const { approvedConsentIds, detail: _detail, ...rest } = entry;
      line = JSON.stringify({
        ...rest,
        approvedConsentIds: approvedConsentIds?.slice(0, 32),
        detail: "truncated",
      });
      if (Buffer.byteLength(line) > MAX_AUDIT_ENTRY_BYTES) {
        line = JSON.stringify({
          at: entry.at,
          action: entry.action,
          jobId: entry.jobId,
          fromVersion: entry.fromVersion,
          toVersion: entry.toVersion,
          channel: entry.channel,
          requester: null,
          detail: "truncated",
        });
      }
    }
    if (existsSync(this.auditPath) && statSync(this.auditPath).size > MAX_AUDIT_FILE_BYTES) {
      renameSync(this.auditPath, path.join(this.directory, "audit.1.jsonl"));
    }
    appendFileSync(this.auditPath, `${line}\n`, { mode: 0o600 });
    chmodSync(this.auditPath, 0o600);
  }

  /** Newest first, across the current and the rotated file. */
  readAudit(limit: number): UpdateAuditEntry[] {
    const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
    const entries: UpdateAuditEntry[] = [];
    for (const file of [this.auditPath, path.join(this.directory, "audit.1.jsonl")]) {
      if (!existsSync(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).reverse();
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as UpdateAuditEntry);
        } catch {
          // A torn last line from a crash mid-append.
        }
        if (entries.length >= bounded) return entries;
      }
    }
    return entries;
  }
}
