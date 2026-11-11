import { describe, expect, test } from "bun:test";

import { eventSink } from "../src/core/backend-emit.js";
import { PR_CLOSED_COMMENT, PrMonitorService, type PrDetection } from "../src/core/pr-monitor";

/**
 * A pull request that closes without merging sends its build's ticket back
 * to the backlog (docs/architecture/tickets.md, "Build lifecycle"). The
 * monitor asks once, before it records the closed link on the ticket; the
 * store decides whether the user moved the ticket by hand since
 * (`kanban-merge-closure.ts`). The rest of the monitor's ticket effects are
 * covered in `pr-monitor-service.test.ts`.
 */

const URL = "https://github.com/org/repo/pull/1";

function closed(): PrDetection {
  return {
    url: URL,
    state: "closed",
    hasMergeConflicts: false,
    checkSummary: null,
    checkSummaryStatus: "skipped",
  };
}

function harness(task: { prUrl: string | null; prState: "open" | "closed" | null }) {
  const calls = { returned: [] as string[], closed: [] as string[], comments: [] as string[] };
  const service = new PrMonitorService({
    emit: eventSink(() => undefined),
    onWarning: () => undefined,
    now: () => new Date(0).toISOString(),
    monotonicNow: () => 0,
    random: () => 0,
    schedule: () => 1,
    cancel: () => undefined,
    effects: {
      detect: async () => closed(),
      persistPr: async () => undefined,
      clearPr: async () => undefined,
      findTaskForEnvironment: async () => ({
        taskId: "task-1",
        status: "review",
        prUrl: task.prUrl,
        prState: task.prState,
        prMergeCommented: false,
        prMergeDoneUrl: null,
        hasCommentText: (text) => calls.comments.includes(text),
      }),
      closeTaskForMerge: async (taskId) => {
        calls.closed.push(taskId);
      },
      returnTaskForClosedPr: async (taskId, prUrl) => {
        calls.returned.push(`${taskId} ${prUrl}`);
      },
      addTaskComment: async (_taskId, text) => {
        calls.comments.push(text);
      },
      updateTaskPrMetadata: async (_taskId, updates) => {
        if (updates.prUrl) task.prUrl = updates.prUrl;
        if (updates.prState === "closed" || updates.prState === "open") {
          task.prState = updates.prState;
        }
      },
    },
  });
  const target = {
    environmentId: "env-1",
    branch: "feature",
    kind: "local" as const,
    worktreePath: "/tmp/worktree",
    ready: true,
    prUrl: URL,
    prState: "open" as const,
    hasMergeConflicts: false,
  };
  return { service, calls, target };
}

describe("a closed pull request", () => {
  test("asks the store to send the ticket back to the backlog, once, and never closes it", async () => {
    const h = harness({ prUrl: URL, prState: "open" });
    await h.service.reconcileTerminal(h.target, closed());
    expect(h.calls.returned).toEqual([`task-1 ${URL}`]);
    expect(h.calls.closed).toEqual([]);
    expect(h.calls.comments).toEqual([`${PR_CLOSED_COMMENT}: ${URL}`]);

    // Observed again (a restart replays it): the ticket already links the closed PR.
    await h.service.reconcileTerminal(h.target, closed());
    expect(h.calls.returned).toHaveLength(1);
  });

  test("already recorded on the ticket is not applied again after a restart", async () => {
    const h = harness({ prUrl: URL, prState: "closed" });
    await h.service.reconcileTerminal(h.target, closed());
    expect(h.calls.returned).toEqual([]);
  });
});
