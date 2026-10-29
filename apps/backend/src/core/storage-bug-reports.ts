import {
  isBugReportAgent,
  isBugReportId,
  type BugReportAgent,
  type BugReportClientContext,
  type BugReportFiled,
} from "@orkestrator/protocol/bug-report";

import type { StorageContext } from "./storage-context.js";
import type { StorageFiles } from "./storage-files.js";

/**
 * A bug report started from the desktop's Report a bug sheet.
 *
 * Its agent session runs under the synthetic runtime id
 * `bug-report:<id>` (see `bug-report-runtime.ts`), in `scratchDir`. The bridge
 * fields mirror the ones an environment row carries for its local bridge, so
 * the local-server lifecycle can find and reap the report's bridge.
 */
export interface BugReportRecord {
  id: string;
  createdAt: string;
  tabId: string;
  scratchDir: string;
  agent?: BugReportAgent;
  clientContext?: BugReportClientContext;
  /** When the first prompt was sent with its pointer to the briefing. */
  briefedAt?: string;
  bridgePort?: number;
  bridgePid?: number;
  filed?: BugReportFiled;
}

interface BugReportStore {
  version: 1;
  reports: Record<string, BugReportRecord>;
}

const emptyStore = (): BugReportStore => ({ version: 1, reports: {} });

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): BugReportRecord | null {
  if (!isRecordLike(value)) return null;
  const { id, createdAt, tabId, scratchDir } = value;
  if (
    !isBugReportId(id) ||
    typeof createdAt !== "string" ||
    typeof tabId !== "string" ||
    typeof scratchDir !== "string"
  ) {
    return null;
  }
  const record: BugReportRecord = { id, createdAt, tabId, scratchDir };
  if (isBugReportAgent(value.agent)) record.agent = value.agent;
  if (isRecordLike(value.clientContext)) {
    record.clientContext = value.clientContext as unknown as BugReportClientContext;
  }
  if (typeof value.briefedAt === "string") record.briefedAt = value.briefedAt;
  if (typeof value.bridgePort === "number") record.bridgePort = value.bridgePort;
  if (typeof value.bridgePid === "number") record.bridgePid = value.bridgePid;
  if (
    isRecordLike(value.filed) &&
    typeof value.filed.url === "string" &&
    typeof value.filed.filedAt === "string"
  ) {
    record.filed = { url: value.filed.url, filedAt: value.filed.filedAt };
  }
  return record;
}

export type BugReportsStorage = Pick<
  BugReportsRepository,
  "getBugReport" | "listBugReports" | "createBugReport" | "mutateBugReport" | "deleteBugReport"
>;

export class BugReportsRepository {
  constructor(
    private readonly context: StorageContext,
    private readonly files: StorageFiles,
  ) {}

  private enqueueBugReportMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.serialize(this.files.bugReportsFile(), "bug report storage", operation);
  }

  private async loadBugReportStore(): Promise<BugReportStore> {
    const value = await this.context.loadJson<unknown>(this.files.bugReportsFile(), emptyStore);
    if (!isRecordLike(value) || !isRecordLike(value.reports)) return emptyStore();
    const reports: Record<string, BugReportRecord> = {};
    for (const [key, candidate] of Object.entries(value.reports)) {
      const record = parseRecord(candidate);
      if (record && record.id === key) reports[key] = record;
    }
    return { version: 1, reports };
  }

  async getBugReport(id: string): Promise<BugReportRecord | null> {
    if (!isBugReportId(id)) return null;
    return (await this.loadBugReportStore()).reports[id] ?? null;
  }

  /** Newest first. */
  async listBugReports(): Promise<BugReportRecord[]> {
    return Object.values((await this.loadBugReportStore()).reports).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  /**
   * Store `record` unless a report is already open, in which case the newest
   * open one is returned instead: there is only ever one, and two sheets
   * opening at once must not start two.
   */
  async createBugReport(record: BugReportRecord): Promise<BugReportRecord> {
    return this.enqueueBugReportMutation(async () => {
      const store = await this.loadBugReportStore();
      const [existing] = Object.values(store.reports).sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
      if (existing) return existing;
      store.reports[record.id] = record;
      await this.context.saveJson(this.files.bugReportsFile(), store);
      return record;
    });
  }

  /** Apply `mutate` to the stored record; returns null when it does not exist. */
  async mutateBugReport(
    id: string,
    mutate: (current: BugReportRecord) => BugReportRecord,
  ): Promise<BugReportRecord | null> {
    return this.enqueueBugReportMutation(async () => {
      const store = await this.loadBugReportStore();
      const current = store.reports[id];
      if (!current) return null;
      const next = { ...mutate(current), id: current.id };
      store.reports[id] = next;
      await this.context.saveJson(this.files.bugReportsFile(), store);
      return next;
    });
  }

  async deleteBugReport(id: string): Promise<void> {
    await this.enqueueBugReportMutation(async () => {
      const store = await this.loadBugReportStore();
      if (!store.reports[id]) return;
      delete store.reports[id];
      await this.context.saveJson(this.files.bugReportsFile(), store);
    });
  }
}
