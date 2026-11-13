/**
 * The pure checks `suborks-live.spec.ts` and `suborks-restart-live.spec.ts`
 * wait on, read from a caller tab's projection (4340 (retired) tasks 1 and 4).
 * Pure, so `suborks-live-checks.test.ts` covers them without a profile.
 *
 * Every check asks for a state, never for a change since an earlier sample:
 * a poll can land after the event it waits for, so a baseline taken after
 * that event would never see it.
 */
import type { NativeAgentSuborkBatchView } from "@orkestrator/protocol/suborks";
import { SUBMIT_ANSWER_TOOL } from "./suborks-fake-model-script";

export type Row = { id?: string; role?: string; content?: unknown; parts?: unknown };
export type Projection = {
  turn: { phase: string; error?: string };
  messages?: Row[];
  suborks?: NativeAgentSuborkBatchView[];
  notices?: unknown;
  recoverableDispatch?: unknown;
} | null;

/** Every text a row holds, in its content or its parts, wherever the provider put it. */
export function rowText(row: Row): string {
  const parts = Array.isArray(row.parts)
    ? row.parts
    : Array.isArray(row.content)
      ? row.content
      : [];
  return [
    typeof row.content === "string" ? row.content : "",
    ...parts.map((part) => {
      const record = (part && typeof part === "object" ? part : {}) as {
        text?: unknown;
        content?: unknown;
      };
      return typeof record.text === "string"
        ? record.text
        : typeof record.content === "string"
          ? record.content
          : "";
    }),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The call once it is over *and* its delivery is: settlement is published
 * before the mail is sent, and a transient send failure leaves the delivery
 * `waiting` for the next pass. `undefined` until then. A stopped call or a
 * failed delivery is returned too, so the spec fails on it rather than waiting.
 */
export function finishedCall(view: Projection | undefined): NativeAgentSuborkBatchView | undefined {
  return view?.suborks?.find((batch) => batch.status !== "running" && batch.delivery !== "waiting");
}

/**
 * The caller has been woken by its call's answers and that turn has settled:
 * after the user row carrying the `/subork` request (found by its tag) comes
 * a later user row (the delivery mail, the only other prompt the tab gets)
 * and an assistant row after that, and the tab is idle. Found by position in
 * the rows, so a wake already finished by the first poll still counts.
 */
export function wokenAfterCall(view: Projection | undefined, tag: string): boolean {
  if (view?.turn.phase !== "idle") return false;
  const rows = view.messages ?? [];
  const request = rows.findIndex((row) => row.role === "user" && rowText(row).includes(tag));
  if (request < 0) return false;
  const mail = rows.findIndex((row, index) => index > request && row.role === "user");
  if (mail < 0) return false;
  return rows.some((row, index) => index > mail && row.role === "assistant");
}

/**
 * Every intended target's turn has been sent to its provider and is not over:
 * the call is running and holds exactly the targets named, each `running`
 * (a `starting` target has not reached its provider; a finished one would
 * not cross the restart).
 */
export function targetsInFlight(
  view: Projection | undefined,
  targets: readonly string[],
): NativeAgentSuborkBatchView | undefined {
  const batch = view?.suborks?.find((candidate) => candidate.status === "running");
  if (!batch) return undefined;
  const agents = batch.suborks.map((subork) => subork.agent ?? "").sort();
  if (agents.join(",") !== [...targets].sort().join(",")) return undefined;
  return batch.suborks.every((subork) => subork.status === "running") ? batch : undefined;
}

/** Submissions the fake answered, under whichever name the provider offered the tool. */
export function submitCount(toolCalls: Record<string, number>): number {
  return Object.entries(toolCalls)
    .filter(([name]) => name === SUBMIT_ANSWER_TOOL || name.endsWith(`_${SUBMIT_ANSWER_TOOL}`))
    .reduce((total, [, count]) => total + count, 0);
}
