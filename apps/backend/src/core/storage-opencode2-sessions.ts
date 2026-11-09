import type { StorageContext } from "./storage-context.js";
import { isRecord } from "./storage-shared.js";

/**
 * How many OpenCode 2.x sessions one environment's workflows may record. A
 * full row refuses a new 2.x session (the workflow takes 1.x instead) rather
 * than forgetting one: a forgotten id would be read on 1.x, as missing.
 */
export const MAX_OPENCODE2_SESSIONS_PER_ENVIRONMENT = 4_096;

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The OpenCode 2.x sessions an environment's workflows created (build
 * pipelines, Multi Review, graphs), so the routing provider sends every later
 * call on them to 2.x. Interactive sessions carry the same fact on their own
 * record (`openCodeProtocol: "v2"`); a workflow keeps only a provider session
 * id, which both OpenCode lines mint in the same format.
 */
export interface PersistedOpenCode2Sessions {
  environmentId: string;
  sessionIds: string[];
}

function storedIds(value: unknown, environmentId: string): string[] {
  if (!isRecord(value) || value.environmentId !== environmentId) return [];
  if (!Array.isArray(value.sessionIds)) return [];
  return value.sessionIds.filter(
    (id): id is string => typeof id === "string" && SESSION_ID.test(id),
  );
}

/** The `opencode2-sessions` store: one row per environment, deleted with its sessions. */
export class OpenCode2SessionsRepository {
  constructor(private readonly context: StorageContext) {}

  private file(): string {
    return this.context.file("opencode2-sessions.json");
  }

  isOpenCode2Session(environmentId: string, sessionId: string): boolean {
    return storedIds(this.context.loadStoreRow(this.file(), environmentId), environmentId).includes(
      sessionId,
    );
  }

  /** Whether the environment can record another 2.x session. */
  hasOpenCode2SessionCapacity(environmentId: string): boolean {
    return (
      storedIds(this.context.loadStoreRow(this.file(), environmentId), environmentId).length <
      MAX_OPENCODE2_SESSIONS_PER_ENVIRONMENT
    );
  }

  /** Records a 2.x session; throws when the environment's row is full. */
  recordOpenCode2Session(environmentId: string, sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid OpenCode session id");
    this.context.updateStoreRow<void>(this.file(), environmentId, (current) => {
      const sessionIds = storedIds(current, environmentId);
      if (sessionIds.includes(sessionId)) return { result: undefined };
      if (sessionIds.length >= MAX_OPENCODE2_SESSIONS_PER_ENVIRONMENT) {
        throw new Error("This environment cannot record more OpenCode 2 sessions");
      }
      const value: PersistedOpenCode2Sessions = {
        environmentId,
        sessionIds: [...sessionIds, sessionId],
      };
      return { result: undefined, value };
    });
  }

  deleteOpenCode2SessionsForEnvironment(environmentId: string): void {
    this.context.updateStoreRow<void>(this.file(), environmentId, (current) =>
      current === undefined ? { result: undefined } : { result: undefined, delete: true },
    );
  }
}

/**
 * The 2.x session record: what callers reach as `storage.openCode2Sessions`.
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to.
 */
export type OpenCode2SessionsStorage = Pick<
  OpenCode2SessionsRepository,
  "isOpenCode2Session" | "hasOpenCode2SessionCapacity" | "recordOpenCode2Session"
>;
