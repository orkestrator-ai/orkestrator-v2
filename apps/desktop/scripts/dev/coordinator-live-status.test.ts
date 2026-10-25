import { describe, expect, test } from "bun:test";
import type { CoordinatorTranscriptMessage } from "./coordinator-live.js";
import type { DelegationMailMessage } from "./coordinator-live-delegation.js";
import {
  STATUS_REVIEW_DONE_MARKER,
  STATUS_WAITER_DONE_MARKER,
  STATUS_WAITING_MARKER,
  approvalWaitApplies,
  carrierRowIndex,
  evaluateStatusReview,
  evaluateStatusWaiting,
  revieweeEnvironmentInput,
  statusReviewAgentSettings,
  statusReviewPrompt,
  statusWaitingPrompt,
  toolCallRows,
  waiterEnvironmentInput,
  waiterTaskPrompt,
  type StatusProbe,
} from "./coordinator-live-status.js";

const COORDINATOR = "coordinator:ws:conversation";
const probe: StatusProbe = {
  platform: "claude",
  token: "0123456789ab",
  revieweeEnvironmentId: "env-review",
  waiterEnvironmentId: "env-waiter",
  waiterTabId: "startup-agent",
  outsidePath: "/tmp/coordinator-live-status-x/it's-outside.txt",
};

const carrier = (id: string) =>
  `<orkestrator-peer-message version="1">\n<orkestrator-peer-payload-json>\n{"messageId":"${id}"}\n</orkestrator-peer-payload-json>\n</orkestrator-peer-message>`;
const user = (content: string): CoordinatorTranscriptMessage => ({ role: "user", content });
const reply = (content: string): CoordinatorTranscriptMessage => ({
  role: "assistant",
  content,
});
const call = (toolName: string, toolArgs: unknown = {}): CoordinatorTranscriptMessage => ({
  role: "assistant",
  content: "",
  parts: [{ type: "tool-invocation", toolName, toolArgs, toolState: "completed" }],
});

function notice(
  id: string,
  resource: { kind: string; id: string; environmentId: string },
  state: string,
  tone: string,
  createdAt = "2026-10-25T10:00:00.000Z",
): DelegationMailMessage {
  return {
    id,
    createdAt,
    from: { kind: "system" },
    toEnvironmentId: COORDINATOR,
    toTabId: "coordinator-tab",
    placement: "injected",
    notice: { resource, state, tone },
  };
}

const review = { kind: "multi-review", id: "review-1", environmentId: "env-review" };
const waiterTab = {
  kind: "agent-tab",
  id: "env-waiter:startup-agent",
  environmentId: "env-waiter",
};
const failed = (checks: Array<{ name: string; passed: boolean }>) =>
  checks.filter((item) => !item.passed).map((item) => item.name);

describe("status prompts", () => {
  test("the review prompt launches without rows and acts on each notice", () => {
    const prompt = statusReviewPrompt(probe);
    expect(prompt).toContain(`environmentId "${probe.revieweeEnvironmentId}"`);
    expect(prompt).toContain("autoFix false and autoPr false");
    expect(prompt).toContain("Leave out reviewers, reviewModel, fixModel");
    expect(prompt).toContain("address_multi_review");
    expect(prompt).toContain(`${STATUS_REVIEW_DONE_MARKER} ${probe.token}`);
    expect(prompt).toContain("Never wait, sleep, poll");
  });

  test("the approval prompt delegates the worker task and never answers for it", () => {
    const prompt = statusWaitingPrompt(probe);
    expect(prompt).toContain("send_prompt_to_tab");
    expect(prompt).toContain(`environmentId "${probe.waiterEnvironmentId}"`);
    expect(prompt).toContain(`tabId "${probe.waiterTabId}"`);
    expect(prompt).toContain(JSON.stringify(waiterTaskPrompt(probe)));
    expect(prompt).toContain("do not try to approve or answer anything");
    expect(prompt).toContain(`${STATUS_WAITING_MARKER} ${probe.token}`);
    expect(prompt).toContain(`${STATUS_WAITER_DONE_MARKER} ${probe.token}`);
    // The path is shell-quoted, apostrophe included.
    expect(waiterTaskPrompt(probe)).toContain(
      "touch '/tmp/coordinator-live-status-x/it'\\''s-outside.txt'",
    );
    expect(waiterTaskPrompt(probe)).not.toContain("escalated");
    expect(waiterTaskPrompt({ ...probe, platform: "codex" })).toContain("escalated");
  });

  test("environments: the reviewee is plain, the waiter asks for approvals", () => {
    expect(revieweeEnvironmentInput({ projectId: "p", token: "t" })).toEqual({
      projectId: "p",
      name: "status-review-t",
      environmentType: "local",
      networkAccessMode: "restricted",
    });
    const waiter = waiterEnvironmentInput({ projectId: "p", token: "t", platform: "claude" });
    expect(waiter).toMatchObject({
      name: "status-waiter-t",
      initialAgentPlatform: "claude",
      agentSettings: { defaultAgent: "claude", executionPolicy: { approvals: "ask" } },
    });
    expect(
      (waiter.agentSettings as { executionPolicy: Record<string, unknown> }).executionPolicy,
    ).toEqual({ approvals: "ask" });
    // Codex asks only to leave its sandbox, so its sandbox stays on.
    expect(
      waiterEnvironmentInput({ projectId: "p", token: "t", platform: "codex" }).agentSettings,
    ).toMatchObject({ executionPolicy: { approvals: "ask", sandbox: "provider" } });
    expect(approvalWaitApplies("cursor")).toBe(false);
    expect(approvalWaitApplies("grok")).toBe(true);
  });

  test("review defaults name the platform and keep every other saved setting", () => {
    expect(
      statusReviewAgentSettings(
        { defaultAgent: "codex", multiReview: { autoFix: true }, platforms: { pi: {} } },
        "pi",
      ),
    ).toEqual({
      defaultAgent: "pi",
      multiReview: { autoFix: true, reviewerCount: 1 },
      platforms: { pi: {} },
    });
    expect(statusReviewAgentSettings(undefined, "claude")).toEqual({
      defaultAgent: "claude",
      multiReview: { reviewerCount: 1 },
    });
  });
});

describe("transcript rows", () => {
  test("carrier and tool rows are found by index", () => {
    const messages = [
      user("prompt"),
      call("mcp__orkestrator__address_multi_review"),
      user(carrier("n-1")),
      call("orkestrator_address_multi_review"),
    ];
    expect(carrierRowIndex(messages, "n-1")).toBe(2);
    expect(carrierRowIndex(messages, "n-2")).toBe(-1);
    expect(toolCallRows(messages, "address_multi_review")).toEqual([1, 3]);
  });
});

describe("the review part", () => {
  const ready = notice("n-ready", review, "ready", "attention");
  const fixDone = notice("n-fix", review, "fix-done", "success", "2026-10-25T10:05:00.000Z");
  const messages = [
    user("prompt"),
    call("mcp__orkestrator__launch_multi_review"),
    reply("launched"),
    user(carrier(ready.id)),
    call("mcp__orkestrator__address_multi_review", { workflowId: "review-1" }),
    reply("addressing"),
    user(carrier(fixDone.id)),
    reply(`${STATUS_REVIEW_DONE_MARKER} ${probe.token}`),
  ];
  const base = {
    probe,
    coordinatorEnvironmentId: COORDINATOR,
    messages,
    launchResults: ['{"delivery":"async","wake":"..."}'],
    mail: [ready, fixDone],
    escapedInteractions: [],
  };

  test("ready, address, fix-done and the done line pass", () => {
    expect(failed(evaluateStatusReview(base))).toEqual([]);
  });

  test("a second ready, an address before ready and a missing fix wake fail", () => {
    const checks = evaluateStatusReview({
      ...base,
      messages: [
        user("prompt"),
        call("mcp__orkestrator__launch_multi_review"),
        call("mcp__orkestrator__address_multi_review"),
        user(carrier(ready.id)),
      ],
      mail: [ready, notice("n-ready-2", review, "ready", "attention")],
    });
    expect(failed(checks)).toEqual([
      "review-ready-wake",
      "review-addressed-after-ready",
      "review-fix-done-wake",
      "review-one-wake-per-state",
      "review-done-line",
    ]);
  });

  test("polling, a sync launch, a wrong tone and an escaped question fail", () => {
    const checks = evaluateStatusReview({
      ...base,
      messages: [...messages, call("mcp__orkestrator__get_multi_review")],
      launchResults: ['{"delivery":"sync"}'],
      mail: [ready, { ...fixDone, notice: { ...fixDone.notice!, tone: "failure" } }],
      escapedInteractions: ["question"],
    });
    expect(failed(checks)).toEqual([
      "review-launch-async",
      "review-fix-done-wake",
      "review-no-polling",
      "review-no-user-action",
    ]);
    expect(checks.find((item) => item.name === "review-no-polling")?.detail).toBe(
      "get_multi_review 1",
    );
  });

  test("notices about other environments do not count", () => {
    const other = { ...review, environmentId: "env-other" };
    const checks = evaluateStatusReview({
      ...base,
      mail: [notice("n-x", other, "ready", "attention"), fixDone],
    });
    expect(failed(checks)).toContain("review-ready-wake");
  });
});

describe("the approval part", () => {
  const seenAt = Date.parse("2026-10-25T10:00:00.000Z");
  const waiting = notice("n-wait", waiterTab, "waiting", "attention", "2026-10-25T10:00:21.000Z");
  const report: DelegationMailMessage = {
    id: "m-report",
    createdAt: "2026-10-25T10:01:00.000Z",
    from: { kind: "tab", environmentId: "env-waiter", tabId: "startup-agent" },
    toEnvironmentId: COORDINATOR,
    toTabId: "coordinator-tab",
    placement: "injected",
  };
  const messages = [
    user("prompt"),
    call("mcp__orkestrator__send_prompt_to_tab", { environmentId: "env-waiter" }),
    reply("sent"),
    user(carrier(waiting.id)),
    reply(`${STATUS_WAITING_MARKER} ${probe.token}`),
    user(carrier(report.id)),
    reply(`${STATUS_WAITER_DONE_MARKER} ${probe.token}`),
  ];
  const base = {
    probe,
    coordinatorEnvironmentId: COORDINATOR,
    messages,
    mail: [waiting, report],
    held: [
      { kind: "command-approval" as const, createdAt: seenAt, seenAt, releasedAt: seenAt + 40_000 },
    ],
    escapedInteractions: [],
    workerInteractions: [],
  };

  test("a held approval, one waiting wake after 20 s, then the report pass", () => {
    expect(failed(evaluateStatusWaiting(base))).toEqual([]);
  });

  test("a four-second observation lag does not shorten the backend debounce", () => {
    expect(
      failed(
        evaluateStatusWaiting({
          ...base,
          held: [{ ...base.held[0]!, seenAt: seenAt + 4_000 }],
          mail: [{ ...waiting, createdAt: "2026-10-25T10:00:20.000Z" }, report],
        }),
      ),
    ).toEqual([]);
  });

  test("worker report takes precedence over a later finished notice in either mailbox order", () => {
    const finished = notice(
      "n-done",
      waiterTab,
      "completed",
      "success",
      "2026-10-25T10:02:00.000Z",
    );
    // The coordinator acknowledged the report before the later notice arrived.
    const rows = [...messages, user(carrier(finished.id))];
    for (const mail of [
      [waiting, report, finished],
      [finished, report, waiting],
    ]) {
      const checks = evaluateStatusWaiting({ ...base, messages: rows, mail });
      expect(failed(checks)).toEqual([]);
      expect(checks.find((item) => item.name === "waiting-report")?.detail).toContain(
        "report from tab",
      );
    }
  });

  test("a notice too early or after the answer fails the debounce check", () => {
    const early = { ...waiting, createdAt: "2026-10-25T10:00:05.000Z" };
    expect(failed(evaluateStatusWaiting({ ...base, mail: [early, report] }))).toEqual([
      "waiting-after-debounce",
    ]);
    const answered = [{ ...base.held[0]!, releasedAt: seenAt + 10_000 }];
    expect(failed(evaluateStatusWaiting({ ...base, held: answered }))).toEqual([
      "waiting-after-debounce",
    ]);
  });

  test("no approval, a question held instead, or no report fail", () => {
    expect(failed(evaluateStatusWaiting({ ...base, held: [] }))).toEqual([
      "waiting-approval-held",
      "waiting-after-debounce",
    ]);
    expect(
      failed(
        evaluateStatusWaiting({
          ...base,
          held: [...base.held, { kind: "question", createdAt: seenAt, seenAt }],
        }),
      ),
    ).toEqual(["waiting-approval-held"]);
    expect(
      failed(evaluateStatusWaiting({ ...base, mail: [waiting], messages: messages.slice(0, 5) })),
    ).toEqual(["waiting-report"]);
  });

  test("a finished notice stands in for a report, but a second waiting wake fails", () => {
    const finished = notice("n-done", waiterTab, "completed", "success", report.createdAt);
    const withNotice = messages.map((message) =>
      message.content === carrier(report.id) ? user(carrier(finished.id)) : message,
    );
    expect(
      failed(evaluateStatusWaiting({ ...base, mail: [waiting, finished], messages: withNotice })),
    ).toEqual([]);
    const again = notice("n-wait-2", waiterTab, "waiting", "attention", report.createdAt);
    const checks = evaluateStatusWaiting({ ...base, mail: [waiting, again, report] });
    expect(failed(checks)).toEqual(["waiting-wake"]);
    expect(checks.find((item) => item.name === "waiting-wake")?.detail).toStartWith(
      "2 waiting notices",
    );
  });
});
