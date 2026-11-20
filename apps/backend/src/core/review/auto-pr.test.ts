import { multiReviewAddressFindingsIdentity } from "./address-findings-identity.js";
import { describe, expect, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import {
  launchPrAgent,
  launchResolveConflictsAgent,
  queueAutoPr,
  supersedePendingAutoPr,
} from "./auto-pr.js";

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
    } as MultiReviewWorkflow["addressFindingsSession"];
    const target = workflow({ autoPr: true, addressFindingsSession: fix });
    queueAutoPr(target);
    expect(target.autoPrLaunch?.addressFindingsIdentity).toBe(
      multiReviewAddressFindingsIdentity(fix),
    );
    expect(target.autoPrLaunch?.addressFindingsIdentity).toMatch(/^[0-9a-f]{64}$/);
    target.autoPrLaunch!.state = "launched";
    const original = { ...target.autoPrLaunch! };
    for (const laterAddressFindings of [
      { ...fix!, sessionKey: "fix-b" },
      { ...fix!, startedAt: "2026-10-16T11:10:00Z" },
    ]) {
      target.addressFindingsSession = laterAddressFindings;
      expect(multiReviewAddressFindingsIdentity(laterAddressFindings)).not.toBe(
        original.addressFindingsIdentity,
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

describe("a launch reply with no acknowledgement", () => {
  const storage = {
    getEnvironment: async () => ({ id: "env-1", projectId: "project-1" }) as never,
    loadConfig: async () => ({ global: { enabledAgentPlatforms: ["codex"] } }) as never,
  };
  const input = { environmentId: "env-1", targetBranch: "main", requestId: "request-1" };

  // A reply that is not an object used to throw a TypeError out of the launch
  // (reading `.tabId` of null); it now reads as unacknowledged and is retried.
  for (const reply of [null, undefined, "accepted"]) {
    test(`Resolve Conflicts retries a ${JSON.stringify(reply) ?? "undefined"} reply`, async () => {
      const outcome = await launchResolveConflictsAgent(async () => reply, storage, input);
      expect(outcome).toEqual({
        kind: "retry",
        message: "The conflict-resolution agent did not acknowledge the launch",
      });
    });

    test(`the PR agent retries a ${JSON.stringify(reply) ?? "undefined"} reply`, async () => {
      const commands: string[] = [];
      const outcome = await launchPrAgent(
        async (command) => {
          commands.push(command);
          return reply;
        },
        storage,
        input,
      );
      expect(outcome).toEqual({
        kind: "retry",
        message: "The pull request agent did not acknowledge the launch",
      });
      expect(commands).toEqual(["launch_native_agent_job"]);
    });
  }

  test("ignores a non-string tab id or error and keeps the rejection", async () => {
    const outcome = await launchPrAgent(
      async () => ({ status: "rejected", tabId: 7, error: { reason: "x" } }),
      storage,
      input,
    );
    expect(outcome).toEqual({
      kind: "rejected",
      message: "The agent rejected the pull request request",
    });
  });
});
