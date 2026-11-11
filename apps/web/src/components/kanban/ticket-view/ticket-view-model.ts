import { hasKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";
import type { PrNotReadyReason, PrMergeReadiness } from "@orkestrator/protocol/pr-merge-readiness";
import { prRequiredCheckFailures, type PrCheckSummary } from "@orkestrator/protocol/pr-monitor";

import type { BuildPipeline } from "@/stores/buildPipelineStore";
import type { KanbanStatus, KanbanTask } from "@/stores/kanbanStore";

/**
 * The ticket view's decisions that need no React: which tab it opens on,
 * whether the Notes tab can open, and what its pull request bar says.
 */

export type TicketViewTab = "ticket" | "notes";

export type TicketNotesAvailability =
  { available: true; pipeline: BuildPipeline } | { available: false; reason: string };

/**
 * Notes are the key information of the ticket's linked build. A ticket built
 * on another machine names that machine: its pipeline, and so its Notes, are
 * read there.
 */
export function ticketNotesAvailability(
  task: Pick<KanbanTask, "sync">,
  pipeline: BuildPipeline | undefined,
): TicketNotesAvailability {
  if (pipeline) {
    return hasKeyInformation(pipeline.keyInformation)
      ? { available: true, pipeline }
      : { available: false, reason: "Its build has not written Notes yet." };
  }
  const remote = task.sync?.work;
  if (remote?.buildPipelineId) {
    const where = remote.nodeName ?? "another machine";
    return { available: false, reason: `Built on ${where}: open its Notes there.` };
  }
  return { available: false, reason: "No build has run for this ticket yet." };
}

/**
 * A ticket opened from the Review column with Notes opens on them; every other
 * ticket opens on its own text.
 */
export function defaultTicketViewTab(
  openedFrom: KanbanStatus,
  notes: TicketNotesAvailability,
): TicketViewTab {
  return openedFrom === "review" && notes.available ? "notes" : "ticket";
}

export type TicketPrTone = "neutral" | "good" | "warn" | "bad" | "merged";

export interface TicketPrState {
  /** Short label for the bar: Open, Draft, Checks running, Ready to merge… */
  label: string;
  tone: TicketPrTone;
  /** A sentence on what it waits for, when it is not ready. */
  detail?: string;
  /** The Merge button may act: GitHub reports it ready to merge now. */
  mergeable: boolean;
}

/**
 * What the Notes tab's bar says about the build's pull request, from the same
 * readiness rule the environment name and auto-merge use
 * (`@orkestrator/protocol/pr-merge-readiness`). Merge is enabled only when
 * that rule says ready.
 */
export function ticketPrState(input: {
  prUrl: string | null | undefined;
  prState: "open" | "merged" | "closed" | null | undefined;
  readiness: PrMergeReadiness | null;
  checkSummary: PrCheckSummary | null;
  holdMessage?: string;
}): TicketPrState {
  if (!input.prUrl) return { label: "No pull request", tone: "neutral", mergeable: false };
  if (input.prState === "merged") return { label: "Merged", tone: "merged", mergeable: false };
  if (input.prState === "closed") {
    return { label: "Closed without merging", tone: "bad", mergeable: false };
  }
  const readiness = input.readiness;
  if (readiness?.ready) {
    return { label: "Ready to merge", tone: "good", mergeable: true };
  }
  const reason: PrNotReadyReason | null = readiness ? readiness.reason : null;
  const failed = input.checkSummary ? prRequiredCheckFailures(input.checkSummary).failed : 0;
  const pending = input.checkSummary?.pending ?? 0;
  const detail = input.holdMessage;
  const state = (label: string, tone: TicketPrTone): TicketPrState => ({
    label,
    tone,
    mergeable: false,
    ...(detail ? { detail } : {}),
  });
  switch (reason) {
    case "draft":
      return state("Draft", "neutral");
    case "conflicts":
      return state("Conflicts", "bad");
    case "checks-failing":
      return state("Checks failed", "bad");
    case "checks-pending":
      return state("Checks running", "warn");
    case "checks-not-passing":
      return failed > 0
        ? state("Checks failed", "bad")
        : pending > 0
          ? state("Checks running", "warn")
          : state("Checks not passing", "warn");
    case "behind":
      return state("Behind its base", "warn");
    case "blocked":
      return state("Blocked", "warn");
    case "no-merge-permission":
      return state("No merge permission", "warn");
    case "stale":
    case "mergeability-unknown":
      return state("Open · checking", "neutral");
    default:
      return state("Open", "neutral");
  }
}

/** Checks as a second chip when they say something the state does not. */
export function ticketChecksLabel(summary: PrCheckSummary | null): string | null {
  if (!summary || summary.total === 0) return null;
  const { failed } = prRequiredCheckFailures(summary);
  if (failed > 0) return `${failed} of ${summary.total} checks failed`;
  if (summary.pending > 0) return `${summary.pending} of ${summary.total} checks running`;
  return `${summary.total} checks passed`;
}
