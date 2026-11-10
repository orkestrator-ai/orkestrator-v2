import type { SelfImprovementService } from "../self-improvement/service.js";
import { PublicActionError } from "./errors.js";
import { onlyActionKeys } from "./input.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Self-improvement for `orkestrator self-improvement …` (and `mise run
 * improvement` in this repository): the same service Settings →
 * Self-improvement drives. A run is a mutation: it files tickets. Refusals are
 * raised before admission, so a refused run leaves no record; the receipt of a
 * started run holds only whether it started, never what it found.
 */

const UNAVAILABLE = "Self-improvement is not available in this backend";

function service(context: PublicActionContext): SelfImprovementService {
  const value = context.command.selfImprovement;
  if (!value) throw new PublicActionError("capability-unavailable", UNAVAILABLE);
  return value;
}

function unavailableReason(context: PublicActionContext): string | null {
  return context.command.selfImprovement ? null : UNAVAILABLE;
}

const selfImprovementStatus: ReadActionHandler<Record<string, never>> = {
  kind: "read",
  action: "self-improvement.status",
  parse(input) {
    onlyActionKeys(input, "self-improvement.status");
    return {};
  },
  unavailableReason,
  async run(_input, context) {
    return { result: { ...(await service(context).status()) } };
  },
};

const selfImprovementRun: MutationActionHandler<{ dryRun: boolean }> = {
  kind: "mutation",
  action: "self-improvement.run",
  parse(input) {
    onlyActionKeys(input, "self-improvement.run");
    if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
      throw new PublicActionError("invalid-input", "dryRun must be true or false");
    }
    const dryRun = input.dryRun === true;
    return { value: { dryRun }, scope: "self-improvement", intent: { dryRun } };
  },
  async prepare(input, context) {
    const status = await service(context).status();
    if (!status.enabled) {
      throw new PublicActionError(
        "capability-unavailable",
        "Self-improvement is off: turn it on in Settings → Experimental",
      );
    }
    if (!status.project) {
      throw new PublicActionError(
        "not-ready",
        "Choose the project for self-improvement's tickets in Settings → Self-improvement",
      );
    }
    if (status.running)
      throw new PublicActionError("busy", "A self-improvement run is already in progress");
    return {
      async execute() {
        const started = await service(context).run({
          trigger: input.dryRun ? "dry-run" : "manual",
        });
        if (!started.started) {
          // Something changed between the checks above and the start (a run began,
          // the switch went off, another backend took the data directory).
          throw new PublicActionError(
            started.refusal === "already-running" ? "busy" : "not-ready",
            started.refusal === "not-writer"
              ? "Another backend is using this data directory; runs happen there"
              : "The self-improvement run could not start",
          );
        }
        return {
          state: "succeeded",
          result: {
            started: true,
            dryRun: input.dryRun,
            startedAt: started.status.running?.startedAt ?? null,
          },
        };
      },
    };
  },
};

export const SELF_IMPROVEMENT_HANDLERS: PublicActionHandler[] = [
  selfImprovementStatus,
  selfImprovementRun,
];
