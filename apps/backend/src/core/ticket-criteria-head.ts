import { isCriterionCommit } from "@orkestrator/protocol/ticket-sections";
import type { CommandInvoker } from "./control-shared-actions.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** How long `get_ticket` waits for the build environment's HEAD before answering without it. */
const CRITERIA_HEAD_TIMEOUT_MS = 5_000;

/**
 * The HEAD of the ticket's build environment, when a recorded Verify check
 * names a commit to compare it with. Best effort: a deleted, stopped or slow
 * environment answers undefined, and the criteria then show their commit
 * with no claim either way about the current code.
 */
export async function criteriaEnvironmentHead(
  invoke: CommandInvoker,
  task: { environmentId?: unknown; sections?: unknown },
): Promise<string | undefined> {
  const environmentId = typeof task.environmentId === "string" ? task.environmentId : "";
  if (!environmentId || !hasRecordedCommit(task)) return undefined;
  // A soft budget, not a cancel: `get_environment_uncommitted_paths` runs one
  // probe per environment shared by every caller (review, guards, this) and
  // bounded by its own 30 s timeout, so this caller's shorter wait must not
  // stop it for the others. Hence no signal and no `runWithTimeout` here.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      invoke<{ head?: unknown }>("get_environment_uncommitted_paths", { environmentId }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CRITERIA_HEAD_TIMEOUT_MS);
      }),
    ]);
    const head = isRecord(result) && typeof result.head === "string" ? result.head : "";
    return isCriterionCommit(head.toLowerCase()) ? head.toLowerCase() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function hasRecordedCommit(task: { environmentId?: unknown; sections?: unknown }): boolean {
  const sections = isRecord(task.sections) ? task.sections : null;
  const criteria =
    sections && Array.isArray(sections.acceptanceCriteria) ? sections.acceptanceCriteria : [];
  return criteria.some(
    (criterion) =>
      isRecord(criterion) && isRecord(criterion.check) && isCriterionCommit(criterion.check.commit),
  );
}
