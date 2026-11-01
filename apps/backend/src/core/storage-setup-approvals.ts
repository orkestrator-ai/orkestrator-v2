import type { StorageContext } from "./storage-context.js";
import { isRecord, nowIso } from "./storage-shared.js";

/** How many approved command lists a project keeps; the oldest goes first. */
export const MAX_SETUP_APPROVALS_PER_PROJECT = 20;

const SETUP_COMMANDS_HASH = /^[0-9a-f]{64}$/;

/**
 * The setup command lists the user approved for one project on this machine,
 * by hash (`setupCommandsHash` in `setup-approval.ts`). A list matching one of
 * these runs without asking, like one matching the default branch's.
 */
export interface PersistedSetupApprovals {
  projectId: string;
  approvals: Array<{ hash: string; approvedAt: string }>;
}

function storedApprovals(value: unknown, projectId: string): PersistedSetupApprovals["approvals"] {
  if (!isRecord(value) || value.projectId !== projectId || !Array.isArray(value.approvals)) {
    return [];
  }
  return value.approvals.filter(
    (entry): entry is { hash: string; approvedAt: string } =>
      isRecord(entry) &&
      typeof entry.hash === "string" &&
      SETUP_COMMANDS_HASH.test(entry.hash) &&
      typeof entry.approvedAt === "string",
  );
}

/**
 * The `setup-approvals` store: one row per project. Approvals are per
 * machine on purpose (each node owns its own trust); the command node's
 * "approve on every machine" action writes each node's row through that
 * node's own `approve_project_setup_commands`.
 */
export class SetupApprovalsRepository {
  constructor(private readonly context: StorageContext) {}

  private setupApprovalsFile(): string {
    return this.context.file("setup-approvals.json");
  }

  isSetupCommandsApproved(projectId: string, hash: string): boolean {
    const stored = this.context.loadStoreRow(this.setupApprovalsFile(), projectId);
    return storedApprovals(stored, projectId).some((entry) => entry.hash === hash);
  }

  /** Records `hash` as approved for the project; approving it again refreshes it. */
  approveSetupCommands(projectId: string, hash: string): void {
    if (!SETUP_COMMANDS_HASH.test(hash)) throw new Error("Invalid setup commands hash");
    this.context.updateStoreRow<void>(this.setupApprovalsFile(), projectId, (current) => {
      const approvals = [
        ...storedApprovals(current, projectId).filter((entry) => entry.hash !== hash),
        { hash, approvedAt: nowIso() },
      ].slice(-MAX_SETUP_APPROVALS_PER_PROJECT);
      const value: PersistedSetupApprovals = { projectId, approvals };
      return { result: undefined, value };
    });
  }

  deleteSetupApprovalsForProject(projectId: string): void {
    this.context.updateStoreRow<void>(this.setupApprovalsFile(), projectId, (current) =>
      current === undefined ? { result: undefined } : { result: undefined, delete: true },
    );
  }
}

/**
 * The setup approval store: what callers reach as `storage.setupApprovals`.
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to.
 */
export type SetupApprovalsStorage = Pick<
  SetupApprovalsRepository,
  "isSetupCommandsApproved" | "approveSetupCommands"
>;
