import { multiReviewAddressFindingsIdentity } from "./multi-review-address-findings-identity.js";
import { describe, expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import {
  launchResolveConflictsAgent,
  queueAutoPr,
  supersedePendingAutoPr,
} from "./multi-review-auto-pr.js";

function workflow(fields: Partial<MultiReviewWorkflow>): MultiReviewWorkflow {
  return { id: "workflow-1", ...fields } as unknown as MultiReviewWorkflow;
}

describe("queueAutoPr", () => {
  test("queues nothing unless auto-PR is on", () => {
    for (const autoPr of [undefined, false]) {
      const target = workflow({ autoPr });
      queueAutoPr(target);
      expect(target.autoPrLaunch).toBeUndefined();
    }
  });

  test("queues one stable request and never repeats a pending or delivered launch", () => {
    const target = workflow({ autoPr: true });
    queueAutoPr(target);
    expect(target.autoPrLaunch).toEqual({
      state: "pending",
      requestId: "multi-review-pr:workflow-1",
    });

    const launched = workflow({
      autoPr: true,
      autoPrLaunch: { state: "launched", requestId: "multi-review-pr:workflow-1", tabId: "tab" },
    });
    queueAutoPr(launched);
    expect(launched.autoPrLaunch?.state).toBe("launched");
  });

  test("binds a queued launch to Address Findings attempt and retains it across later Fixes", () => {
    const fix = {
      sessionKey: "fix-a",
      startedAt: "2026-10-16T10:10:00Z",
    } as MultiReviewWorkflow["fixSession"];
    const target = workflow({ autoPr: true, fixSession: fix });
    queueAutoPr(target);
    expect(target.autoPrLaunch?.fixIdentity).toBe(multiReviewAddressFindingsIdentity(fix));
    expect(target.autoPrLaunch?.fixIdentity).toMatch(/^[0-9a-f]{64}$/);
    target.autoPrLaunch!.state = "launched";
    const original = { ...target.autoPrLaunch! };
    for (const laterAddressFindings of [
      { ...fix!, sessionKey: "fix-b" },
      { ...fix!, startedAt: "2026-10-16T11:10:00Z" },
    ]) {
      target.fixSession = laterAddressFindings;
      expect(multiReviewAddressFindingsIdentity(laterAddressFindings)).not.toBe(
        original.fixIdentity,
      );
      supersedePendingAutoPr(target);
      queueAutoPr(target);
      expect(target.autoPrLaunch).toEqual(original);
    }
  });

  test.each(["skipped", "failed"] as const)(
    "re-queues a %s launch after a later Address Findings",
    (state) => {
      const target = workflow({
        autoPr: true,
        autoPrLaunch: { state, requestId: "multi-review-pr:workflow-1", message: "earlier" },
      });
      queueAutoPr(target);
      expect(target.autoPrLaunch).toEqual({
        state: "pending",
        requestId: "multi-review-pr:workflow-1",
      });
    },
  );
});

describe("supersedePendingAutoPr", () => {
  test("drops only an undelivered launch", () => {
    const pending = workflow({ autoPrLaunch: { state: "pending", requestId: "pr" } });
    supersedePendingAutoPr(pending);
    expect(pending.autoPrLaunch).toBeUndefined();

    const launched = workflow({ autoPrLaunch: { state: "launched", requestId: "pr" } });
    supersedePendingAutoPr(launched);
    expect(launched.autoPrLaunch?.state).toBe("launched");
  });
});

for (const queued of [false, true]) {
  test(`coordinator Resolve keeps the reused tab receipt (queued=${queued})`, async () => {
    const calls: unknown[] = [];
    const result = await launchResolveConflictsAgent(
      async (command, args) => {
        calls.push({ command, args });
        return {
          status: "accepted",
          tabId: "existing-resolve",
          reused: true,
          queued,
          completionActionArmed: true,
        };
      },
      {
        getEnvironment: async () => ({ id: "env-1", projectId: "project-1" }) as never,
        loadConfig: async () => ({ global: { enabledAgentPlatforms: ["codex"] } }) as never,
      },
      { environmentId: "env-1", targetBranch: "main", requestId: "resolve-1" },
    );
    expect(calls).toEqual([
      expect.objectContaining({
        command: "launch_native_agent_job",
        args: expect.objectContaining({
          tabReuse: "any-agent",
          activateTab: false,
          requestId: "resolve-1",
        }),
      }),
    ]);
    expect(result).toEqual({ kind: "launched", tabId: "existing-resolve", refreshArmed: true });
  });
}
