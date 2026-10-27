import { describe, test, expect } from "bun:test";
import {
  KNOWN_SERVER_REQUEST_METHODS,
  ServerRequestRouter,
  type ServerRequestRouterOptions,
} from "./server-request-router.js";
import {
  INTERACTIVE_APPROVAL_METHODS,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResolution,
} from "./approvals.js";
import type { InboundServerRequest } from "./envelope-validation.js";
import type { InteractionRequest, InteractionResolution } from "./interactions.js";
import type { InteractionDeadlineClock } from "@orkestrator/protocol/agent-interaction-deadline";
import {
  AGENT_INTERACTION_DEFAULT_TIMEOUT_MS,
  AGENT_INTERACTION_HOLD_CEILING_MS,
} from "@orkestrator/protocol/agent-interactions";

interface Answer {
  generation: number;
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

function harness(overrides: Partial<ServerRequestRouterOptions> = {}) {
  const answers: Answer[] = [];
  const violations: Array<{ method: string; detail: string }> = [];
  const transcript: Array<{ threadId: string | null; message: string }> = [];

  const router = new ServerRequestRouter({
    respond: async (generation, id, result) => {
      answers.push({ generation, id, result });
    },
    respondWithError: async (generation, id, code, message) => {
      answers.push({ generation, id, error: { code, message } });
    },
    onInvariantViolation: (method, detail) => violations.push({ method, detail }),
    reportToTranscript: ({ threadId, message }) => transcript.push({ threadId, message }),
    ...overrides,
  });

  return { router, answers, violations, transcript };
}

function request(method: string, id: string | number = "srv-1"): InboundServerRequest {
  return {
    kind: "server-request",
    id,
    method,
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("exhaustiveness", () => {
  /**
   * The core invariant: silence hangs a turn forever. Every method in the pinned
   * union must produce exactly one response.
   */
  test.each(KNOWN_SERVER_REQUEST_METHODS)("%s is always answered", async (method) => {
    const h = harness();
    h.router.handle(request(method), 1);
    await settle();

    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.id).toBe("srv-1");
    // Either a result or an error, but never nothing.
    expect(h.answers[0]!.result !== undefined || h.answers[0]!.error !== undefined).toBe(true);
    expect(h.router.getPending()).toHaveLength(0);
  });

  test("an unknown method gets a protocol error rather than a hang", async () => {
    const unknown: string[] = [];
    const h = harness({ onUnknownRequest: (method) => unknown.push(method) });
    h.router.handle(request("orkestrator/from/the/future"), 1);
    await settle();

    expect(h.answers[0]!.error?.code).toBe(-32601);
    expect(unknown).toEqual(["orkestrator/from/the/future"]);
    expect(h.router.getMetrics().unknown).toBe(1);
  });

  test("the final backstop answers when no routing branch attempts a response", async () => {
    const h = harness({ responseTimeoutMs: 5 });
    const internals = h.router as unknown as {
      route: () => Promise<void>;
    };
    internals.route = () => new Promise<void>(() => undefined);

    h.router.handle(request("future/request"), 7);
    await Bun.sleep(25);

    expect(h.answers).toEqual([
      {
        generation: 7,
        id: "srv-1",
        error: {
          code: -32601,
          message: "Orkestrator did not produce a response in time",
        },
      },
    ]);
    expect(h.router.getMetrics().timedOut).toBe(1);
    expect(h.router.getPending()).toHaveLength(0);
  });
});

describe("approval requests", () => {
  test("command approval is declined, not approved", async () => {
    const h = harness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    // Declining refuses the command; approving would authorise something the
    // user never saw.
    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
  });

  test("file-change approval is declined", async () => {
    const h = harness();
    h.router.handle(request("item/fileChange/requestApproval"), 1);
    await settle();
    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
  });

  test("legacy approval paths use the snake_case denied shape", async () => {
    for (const method of ["execCommandApproval", "applyPatchApproval"]) {
      const h = harness();
      h.router.handle(request(method), 1);
      await settle();

      expect(h.answers[0]!.result).toMatchObject({
        decision: { denied: { rejection: expect.any(String) } },
      });
    }
  });

  test("an approval request is recorded as an invariant violation", async () => {
    const h = harness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    // We asked for approvalPolicy=never, so this means policy diverged.
    expect(h.violations[0]!.detail).toContain("approvalPolicy=never");
  });

  test("the user is told why the action was refused", async () => {
    const h = harness();
    h.router.handle(request("item/fileChange/requestApproval"), 1);
    await settle();

    expect(h.transcript[0]!.threadId).toBe("thread-1");
    expect(h.transcript[0]!.message).toContain("declined");
  });
});

describe("requests needing UI we do not have", () => {
  test("user input is answered with empty answers rather than left pending", async () => {
    const h = harness();
    h.router.handle(request("item/tool/requestUserInput"), 1);
    await settle();

    expect(h.answers[0]!.result).toEqual({ answers: {} });
    expect(h.transcript[0]!.message).toContain("cancelled");
  });

  test("MCP elicitation is cancelled with the documented action shape", async () => {
    const h = harness();
    h.router.handle(request("mcpServer/elicitation/request"), 1);
    await settle();

    expect(h.answers[0]!.result).toEqual({ action: "cancel", content: null, _meta: null });
    // We *do* advertise mcpServerOpenaiFormElicitation, so reaching this branch
    // means the request could not be parked — an ordinary outcome, not protocol
    // drift. Counting it as a violation inflated the figure operators watch.
    expect(h.violations).toHaveLength(0);
    expect(h.transcript[0]!.message).toContain("no Orkestrator tab was attached");
  });

  test("an unparkable question is cancelled without being called a violation", async () => {
    const h = harness();
    h.router.handle(request("item/tool/requestUserInput"), 1);
    await settle();

    expect(h.answers[0]!.result).toEqual({ answers: {} });
    expect(h.violations).toHaveLength(0);
  });

  test("permission escalation with no one to grant it is declined, not failed", async () => {
    const h = harness();
    h.router.handle(request("item/permissions/requestApproval"), 1);
    await settle();

    // An *empty grant profile*, not a `-32601`. To app-server the two mean
    // different things: an error says this client cannot answer permission
    // requests at all, which fails the turn, while an empty profile says "no,
    // carry on with what you have" and lets it continue sandboxed.
    expect(h.answers[0]!.error).toBeUndefined();
    // Turn-scoped: refusing once is not refusing for the rest of the session.
    expect(h.answers[0]!.result).toEqual({ permissions: {}, scope: "turn" });
  });

  test("a dynamic tool call is reported failed, not silently succeeded", async () => {
    const h = harness();
    h.router.handle(request("item/tool/call"), 1);
    await settle();

    expect(h.answers[0]!.result).toEqual({ contentItems: [], success: false });
  });

  test("auth refresh and attestation return errors, never invented values", async () => {
    for (const method of ["account/chatgptAuthTokens/refresh", "attestation/generate"]) {
      const h = harness();
      h.router.handle(request(method), 1);
      await settle();

      expect(h.answers[0]!.error).toBeDefined();
      expect(h.answers[0]!.result).toBeUndefined();
    }
  });
});

describe("bookkeeping", () => {
  test("tracks id, method, thread, turn, item and resolution", async () => {
    const h = harness();
    h.router.handle(request("item/fileChange/requestApproval", 42), 7);
    await settle();

    const record = h.router.getHistory()[0]!;
    expect(record).toMatchObject({
      id: 42,
      method: "item/fileChange/requestApproval",
      generation: 7,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      resolution: "declined",
    });
    expect(record.resolvedAt).toBeGreaterThanOrEqual(record.receivedAt);
  });

  test("counts declines and cancellations separately", async () => {
    const h = harness();
    h.router.handle(request("item/fileChange/requestApproval", "a"), 1);
    h.router.handle(request("item/tool/requestUserInput", "b"), 1);
    await settle();

    const metrics = h.router.getMetrics();
    expect(metrics.total).toBe(2);
    expect(metrics.declined).toBe(1);
    expect(metrics.cancelled).toBe(1);
    expect(metrics.pending).toBe(0);
  });

  test("the same id from two generations is tracked independently", async () => {
    const h = harness();
    h.router.handle(request("item/fileChange/requestApproval", "srv-1"), 1);
    h.router.handle(request("item/fileChange/requestApproval", "srv-1"), 2);
    await settle();

    expect(h.answers.map((answer) => answer.generation)).toEqual([1, 2]);
    expect(h.router.getHistory()).toHaveLength(2);
  });

  test("a failure to send does not leave the request pending", async () => {
    const h = harness({
      respond: async () => {
        throw new Error("generation died mid-response");
      },
    });
    h.router.handle(request("item/fileChange/requestApproval"), 1);
    await settle();

    expect(h.router.getPending()).toHaveLength(0);
    expect(h.router.getHistory()[0]!.resolution).toBe("declined");
  });

  test("history is bounded so a hostile peer cannot grow it without limit", async () => {
    const h = harness();
    for (let index = 0; index < 260; index += 1) {
      h.router.handle(request("item/fileChange/requestApproval", index), 1);
    }
    await settle();

    expect(h.router.getHistory().length).toBeLessThanOrEqual(200);
  });

  test("a response whose write never flushes is recorded, not answered twice", async () => {
    let released: (() => void) | null = null;
    const h = harness({
      responseTimeoutMs: 5,
      // Never resolves: models a back-pressured stdin on a dying child.
      respond: () =>
        new Promise<void>((resolve) => {
          released = resolve;
        }),
    });

    h.router.handle(request("item/fileChange/requestApproval"), 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Writing again down the same stuck pipe cannot help, and a second response
    // would risk answering one request twice — so record it and stop.
    expect(h.router.getMetrics().timedOut).toBe(1);
    expect(h.answers).toHaveLength(0);
    expect(h.router.getPending()).toHaveLength(1);

    released?.();
    await settle();
    // Once the write flushes the request settles normally.
    expect(h.router.getPending()).toHaveLength(0);
    expect(h.router.getHistory().at(-1)?.resolution).toBe("declined");
  });
});

describe("interactive approvals", () => {
  /**
   * Every test here guards one half of the same invariant: an approval must be
   * answered exactly once, and when in doubt it must be answered *no*.
   */
  function approvalHarness(
    overrides: Partial<ServerRequestRouterOptions> = {},
    options: { accept?: boolean } = {},
  ) {
    const presented: ApprovalRequest[] = [];
    const resolved: Array<{
      approvalId: string;
      decision: ApprovalDecision;
      resolution: ApprovalResolution;
    }> = [];

    const h = harness({
      presentApproval: (approval) => {
        presented.push(approval);
        return options.accept !== false;
      },
      onApprovalResolved: (approval, decision, resolution) => {
        resolved.push({ approvalId: approval.approvalId, decision, resolution });
      },
      approvalTimeoutMs: 50,
      ...overrides,
    });

    return { ...h, presented, resolved };
  }

  test("parks the request instead of auto-declining", async () => {
    const h = approvalHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    // Nothing answered yet: the user is looking at it.
    expect(h.answers).toHaveLength(0);
    expect(h.presented).toHaveLength(1);
    expect(h.router.getParkedApprovals()).toHaveLength(1);
    expect(h.router.getMetrics().awaitingUser).toBe(1);
  });

  test("an approval is sent as accept and recorded as user-approved", async () => {
    const h = approvalHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    const approvalId = h.presented[0]!.approvalId;
    expect(h.router.resolveApproval(approvalId, "approve")).toBe(true);
    await settle();

    expect(h.answers).toEqual([{ generation: 1, id: "srv-1", result: { decision: "accept" } }]);
    expect(h.router.getMetrics().approvalsApproved).toBe(1);
    expect(h.router.getHistory().at(-1)?.resolution).toBe("user-approved");
    // An approval needs no transcript note.
    expect(h.transcript).toHaveLength(0);
  });

  test("approving a request that proposes policy amendments sends plain accept", async () => {
    const h = approvalHarness();
    h.router.handle(
      {
        ...request("item/commandExecution/requestApproval"),
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          command: "curl https://two.example",
          proposedExecpolicyAmendment: ["curl"],
          proposedNetworkPolicyAmendments: [{ host: "two.example", action: "allow" }],
        },
      },
      1,
    );
    await settle();

    expect(h.presented[0]).not.toHaveProperty("amendments");
    expect(h.router.resolveApproval(h.presented[0]!.approvalId, "approve")).toBe(true);
    await settle();

    expect(h.answers[0]!.result).toEqual({ decision: "accept" });
    expect(h.router.getMetrics().approvalsApproved).toBe(1);
    expect(h.router.getHistory().at(-1)?.resolution).toBe("user-approved");
    expect(h.transcript).toEqual([]);
  });

  test("withdraws an approval answered by another client without recording a decline", async () => {
    const h = approvalHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    expect(h.router.withdrawResolved("srv-1")).toBe(true);
    await settle();

    expect(h.answers).toEqual([]);
    expect(h.router.getParkedApprovals()).toEqual([]);
    expect(h.router.getMetrics().approvalsApproved).toBe(0);
    expect(h.router.getMetrics().approvalsDenied).toBe(0);
    expect(h.router.getHistory().at(-1)?.resolution).toBe("externally-answered");
    expect(h.resolved).toEqual([
      expect.objectContaining({ decision: "withdrawn", resolution: "withdrawn" }),
    ]);
    expect(h.transcript).toEqual([]);
    expect(h.router.withdrawResolved("missing")).toBe(false);
  });

  test("a denial is sent as decline and explained in the transcript", async () => {
    const h = approvalHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    h.router.resolveApproval(h.presented[0]!.approvalId, "deny");
    await settle();

    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
    expect(h.transcript[0]!.message).toContain("You declined");
    expect(h.router.getMetrics().approvalsDenied).toBe(1);
  });

  test("answering twice is ignored", async () => {
    const h = approvalHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    const approvalId = h.presented[0]!.approvalId;
    expect(h.router.resolveApproval(approvalId, "approve")).toBe(true);
    // A double click, or a click racing the expiry timer.
    expect(h.router.resolveApproval(approvalId, "deny")).toBe(false);
    await settle();

    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.result).toEqual({ decision: "accept" });
  });

  test("an unanswered approval expires as a denial", async () => {
    const h = approvalHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();
    await Bun.sleep(80);

    // Deny, never approve: an ignored prompt must not authorise anything.
    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
    expect(h.resolved[0]!.resolution).toBe("timed-out");
    expect(h.router.getMetrics().approvalsExpired).toBe(1);
    expect(h.transcript[0]!.message).toContain("expired");
  });

  test("the fast backstop does not fire while a human is deciding", async () => {
    // The 10s backstop exists for a branch that fails to answer. A parked approval
    // has legitimately not answered yet, and answering here would resolve a prompt
    // the user is still reading.
    const h = approvalHarness({ responseTimeoutMs: 10, approvalTimeoutMs: 5_000 });
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();
    await Bun.sleep(40);

    expect(h.answers).toHaveLength(0);
    expect(h.router.getParkedApprovals()).toHaveLength(1);
    expect(h.router.getMetrics().timedOut).toBe(0);
  });

  test("falls back to auto-decline when the UI will not take it", async () => {
    const h = approvalHarness({}, { accept: false });
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    // Exactly the pre-approval behaviour, so attaching a UI is purely additive.
    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
    expect(h.violations).toHaveLength(1);
    expect(h.router.getParkedApprovals()).toHaveLength(0);
  });

  test("a presentApproval that throws falls back rather than hanging the turn", async () => {
    const h = harness({
      presentApproval: () => {
        throw new Error("renderer exploded");
      },
    });
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
  });

  test("with no presentApproval installed nothing changes", async () => {
    const h = harness();
    h.router.handle(request("item/fileChange/requestApproval"), 1);
    await settle();

    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
    expect(h.router.getMetrics().approvalsPresented).toBe(0);
  });

  test("abandonGeneration withdraws the card without answering the dead child", async () => {
    const h = approvalHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    h.router.abandonGeneration(1);
    await settle();

    // app-server has forgotten the request, so writing to it is pointless — but the
    // UI still has a card up and the transcript needs to explain the gap.
    expect(h.answers).toHaveLength(0);
    expect(h.resolved[0]!.resolution).toBe("engine-restarted");
    expect(h.transcript[0]!.message).toContain("restarted");
    expect(h.router.getParkedApprovals()).toHaveLength(0);
    expect(h.router.getHistory().at(-1)?.resolution).toBe("user-declined");
  });

  test("abandonGeneration leaves a different generation's approval alone", async () => {
    const h = approvalHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(request("item/commandExecution/requestApproval", "srv-1"), 1);
    h.router.handle(request("item/commandExecution/requestApproval", "srv-2"), 2);
    await settle();

    h.router.abandonGeneration(1);
    await settle();

    const remaining = h.router.getParkedApprovals();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.generation).toBe(2);
  });

  test("abandonThread answers on the way out so the turn is not left waiting", async () => {
    const h = approvalHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    h.router.abandonThread("thread-1");
    await settle();

    // The child is still alive here, so it *must* be answered — unlike a restart.
    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
    expect(h.resolved[0]!.resolution).toBe("session-closed");
  });

  test("abandonThread ignores approvals on other threads", async () => {
    const h = approvalHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    h.router.abandonThread("some-other-thread");
    await settle();

    expect(h.answers).toHaveLength(0);
    expect(h.router.getParkedApprovals()).toHaveLength(1);
  });

  test("resolving an unknown approval id reports false", () => {
    const h = approvalHarness();
    expect(h.router.resolveApproval("apr-does-not-exist", "approve")).toBe(false);
  });

  test("approval ids are unique and generation-scoped", async () => {
    const h = approvalHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(request("item/commandExecution/requestApproval", "a"), 1);
    h.router.handle(request("item/fileChange/requestApproval", "b"), 2);
    await settle();

    const ids = h.presented.map((approval) => approval.approvalId);
    expect(new Set(ids).size).toBe(2);
    // The generation is in the id, so an id from a dead child can never collide
    // with one from its replacement.
    expect(ids[0]).toContain("-1-");
    expect(ids[1]).toContain("-2-");
  });

  test("each interactive method parks and answers in its own shape", async () => {
    for (const method of INTERACTIVE_APPROVAL_METHODS) {
      const h = approvalHarness({ approvalTimeoutMs: 5_000 });
      h.router.handle(request(method), 1);
      await settle();

      expect(h.presented).toHaveLength(1);
      h.router.resolveApproval(h.presented[0]!.approvalId, "approve");
      await settle();

      expect(h.answers).toHaveLength(1);
      expect(h.answers[0]!.error).toBeUndefined();
    }
  });

  test("non-approval server requests are never parked as approvals", async () => {
    const nonApprovals = KNOWN_SERVER_REQUEST_METHODS.filter(
      (method) => !INTERACTIVE_APPROVAL_METHODS.includes(method as never),
    );

    for (const method of nonApprovals) {
      /**
       * Both handlers are installed on purpose.
       *
       * With only `presentApproval` wired up this could not distinguish "the
       * approval path correctly ignored an interaction method" from "the
       * interaction path was never reachable", so it silently failed to guard
       * `item/tool/requestUserInput` and `mcpServer/elicitation/request` at all.
       */
      const presentedInteractions: InteractionRequest[] = [];
      const h = approvalHarness({
        approvalTimeoutMs: 5_000,
        presentInteraction: (interaction) => {
          presentedInteractions.push(interaction);
          return true;
        },
      });
      h.router.handle(request(method), 1);
      await settle();

      expect(h.presented).toHaveLength(0);
      // The two interaction methods reach `describeInteraction`, which rejects
      // this fixture's params (no questions, no mode) and falls through.
      expect(presentedInteractions).toHaveLength(0);
      expect(h.answers).toHaveLength(1);
      expect(h.router.getParkedApprovals()).toHaveLength(0);
      expect(h.router.getParkedInteractions()).toHaveLength(0);
    }
  });
});

describe("interactive questions and MCP elicitation", () => {
  test("parks a Codex question and maps the user's answers onto the protocol", async () => {
    const presented: InteractionRequest[] = [];
    const h = harness({
      presentInteraction: (interaction) => {
        presented.push(interaction);
        return true;
      },
      approvalTimeoutMs: 5_000,
    });
    h.router.handle(
      {
        ...request("item/tool/requestUserInput"),
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          questions: [
            {
              id: "language",
              header: "Language",
              question: "Which language?",
              isOther: true,
              isSecret: false,
              options: [{ label: "TypeScript", description: "Typed JavaScript" }],
            },
          ],
          autoResolutionMs: 60_000,
        },
      },
      1,
    );
    await settle();

    expect(h.answers).toHaveLength(0);
    expect(presented[0]?.kind).toBe("question");
    expect(
      h.router.resolveInteraction(presented[0]!.interactionId, {
        action: "accept",
        answers: { language: ["TypeScript"] },
      }),
    ).toBe(true);
    await settle();

    expect(h.answers[0]?.result).toEqual({
      answers: { language: { answers: ["TypeScript"] } },
    });
    expect(h.router.getParkedInteractions()).toHaveLength(0);
    expect(h.router.getHistory().at(-1)?.resolution).toBe("user-answered");
  });

  test("parks and accepts an MCP form with structured content", async () => {
    const presented: InteractionRequest[] = [];
    const h = harness({
      presentInteraction: (interaction) => {
        presented.push(interaction);
        return true;
      },
      approvalTimeoutMs: 5_000,
    });
    h.router.handle(
      {
        ...request("mcpServer/elicitation/request"),
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "deploy",
          mode: "form",
          message: "Choose a region",
          requestedSchema: {
            type: "object",
            properties: { region: { type: "string" } },
            required: ["region"],
          },
        },
      },
      2,
    );
    await settle();

    expect(presented[0]?.kind).toBe("mcp-form");
    h.router.resolveInteraction(presented[0]!.interactionId, {
      action: "accept",
      content: { region: "eu-west-1" },
    });
    await settle();
    expect(h.answers[0]?.result).toEqual({
      action: "accept",
      content: { region: "eu-west-1" },
      _meta: null,
    });
  });

  /**
   * Parity with the approval suite above. Every test guards one half of the same
   * invariant: an interaction must be answered exactly once, and when in doubt it
   * must be answered *no*.
   */
  function interactionHarness(
    overrides: Partial<ServerRequestRouterOptions> = {},
    options: { accept?: boolean } = {},
  ) {
    const presented: InteractionRequest[] = [];
    const resolved: Array<{
      interactionId: string;
      action: string;
      resolution: InteractionResolution;
    }> = [];

    const h = harness({
      presentInteraction: (interaction) => {
        presented.push(interaction);
        return options.accept !== false;
      },
      onInteractionResolved: (interaction, answer, resolution) => {
        resolved.push({
          interactionId: interaction.interactionId,
          action: answer.action,
          resolution,
        });
      },
      approvalTimeoutMs: 50,
      ...overrides,
    });

    return { ...h, presented, resolved };
  }

  function questionRequest(id: string | number = "srv-1"): InboundServerRequest {
    return {
      kind: "server-request",
      id,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [{ id: "q", header: "Question", question: "Continue?" }],
      },
    };
  }

  test("an undescribable request falls through and is cancelled, never parked", async () => {
    // `presentInteraction` is installed, but the params have no questions, so
    // `describeInteraction` returns null. Parking a card nobody could render
    // would hang the turn for the full approval window.
    const h = interactionHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(request("item/tool/requestUserInput"), 1);
    await settle();

    expect(h.presented).toHaveLength(0);
    expect(h.router.getParkedInteractions()).toHaveLength(0);
    expect(h.answers[0]!.result).toEqual({ answers: {} });
    expect(h.router.getMetrics().interactionsPresented).toBe(0);
  });

  test("a UI that will not take the interaction gets the automatic cancel", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 5_000 }, { accept: false });
    h.router.handle(questionRequest(), 1);
    await settle();

    expect(h.presented).toHaveLength(1);
    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.result).toEqual({ answers: {} });
    expect(h.router.getParkedInteractions()).toHaveLength(0);
  });

  test("a presentInteraction that throws cancels rather than hanging the turn", async () => {
    const h = harness({
      presentInteraction: () => {
        throw new Error("renderer exploded");
      },
      approvalTimeoutMs: 5_000,
    });
    h.router.handle(questionRequest(), 1);
    await settle();

    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.result).toEqual({ answers: {} });
    expect(h.router.getParkedInteractions()).toHaveLength(0);
  });

  test("an unanswered interaction auto-cancels and is counted as expired", async () => {
    const h = interactionHarness();
    h.router.handle(questionRequest(), 1);
    await settle();
    await Bun.sleep(90);

    // Cancel, never accept: an ignored prompt must not answer on the user's behalf.
    expect(h.answers[0]!.result).toEqual({ answers: {} });
    expect(h.resolved[0]!.resolution).toBe("timed-out");
    expect(h.resolved[0]!.action).toBe("cancel");
    expect(h.router.getMetrics().interactionsExpired).toBe(1);
    expect(h.router.getHistory().at(-1)).toMatchObject({
      resolution: "cancelled",
      timedOut: true,
    });
    expect(h.transcript.at(-1)?.message).toContain("timed out");
  });

  test("an explicitly blocking question remains parked without a timer", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 20 });
    const blocking = questionRequest();
    blocking.params = { ...(blocking.params as object), isBlocking: true };
    h.router.handle(blocking, 1);
    await settle();
    await Bun.sleep(50);

    expect(h.answers).toHaveLength(0);
    expect(h.router.getParkedInteractions()).toHaveLength(1);
    expect(h.presented[0]?.expiresAt).toBeUndefined();
  });

  test("a shorter autoResolutionMs shortens the park, it does not extend it", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(
      {
        ...questionRequest(),
        params: { ...(questionRequest().params as object), autoResolutionMs: 30 },
      },
      1,
    );
    await settle();
    await Bun.sleep(80);

    expect(h.router.getParkedInteractions()).toHaveLength(0);
    expect(h.router.getMetrics().interactionsExpired).toBe(1);
  });

  test("the fast backstop does not fire while a human is deciding", async () => {
    // AGENTS.md invariant: the 10s backstop exists for a branch that failed to
    // answer. A parked interaction has legitimately not answered yet, and
    // answering here would resolve a prompt the user is still reading.
    const h = interactionHarness({ responseTimeoutMs: 10, approvalTimeoutMs: 5_000 });
    h.router.handle(questionRequest(), 1);
    await settle();
    await Bun.sleep(40);

    expect(h.answers).toHaveLength(0);
    expect(h.router.getParkedInteractions()).toHaveLength(1);
    expect(h.router.getMetrics().timedOut).toBe(0);
  });

  test("answering twice is ignored", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(questionRequest(), 1);
    await settle();

    const id = h.presented[0]!.interactionId;
    expect(h.router.resolveInteraction(id, { action: "accept", answers: { q: ["Yes"] } })).toBe(
      true,
    );
    // A double click, or a click racing the expiry timer.
    expect(h.router.resolveInteraction(id, { action: "cancel" })).toBe(false);
    await settle();

    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.result).toEqual({ answers: { q: { answers: ["Yes"] } } });
  });

  test("resolving an unknown interaction id reports false", () => {
    const h = interactionHarness();
    expect(h.router.resolveInteraction("ask-does-not-exist", { action: "cancel" })).toBe(false);
  });

  test("withdraws an interaction answered by another client without responding", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(questionRequest(), 1);
    await settle();

    expect(h.router.withdrawResolved("srv-1")).toBe(true);
    await settle();

    expect(h.answers).toEqual([]);
    expect(h.router.getParkedInteractions()).toEqual([]);
    expect(h.router.getMetrics().interactionsAnswered).toBe(0);
    expect(h.router.getHistory().at(-1)?.resolution).toBe("externally-answered");
    expect(h.resolved[0]).toMatchObject({ action: "cancel", resolution: "withdrawn" });
  });

  test.each(["decline", "cancel"] as const)(
    "a %s resolves as cancelled, not answered",
    async (action) => {
      const h = interactionHarness({ approvalTimeoutMs: 5_000 });
      h.router.handle(questionRequest(), 1);
      await settle();

      h.router.resolveInteraction(h.presented[0]!.interactionId, { action });
      await settle();

      expect(h.resolved[0]!.resolution).toBe(action === "decline" ? "declined" : "cancelled");
      // Both map to the same *record* resolution: only an accept is an answer.
      expect(h.router.getHistory().at(-1)?.resolution).toBe("cancelled");
      expect(h.router.getMetrics().interactionsAnswered).toBe(0);
    },
  );

  test("abandonThread answers a live child on the way out", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(questionRequest(), 1);
    await settle();

    h.router.abandonThread("thread-1");
    await settle();

    // The child is still alive, so it *must* be answered — unlike a restart.
    expect(h.answers[0]!.result).toEqual({ answers: {} });
    expect(h.resolved[0]!.resolution).toBe("session-closed");
    expect(h.router.getParkedInteractions()).toHaveLength(0);
    expect(h.transcript.at(-1)?.message).toContain("session closed");
  });

  test("abandonThread ignores interactions on other threads", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(questionRequest(), 1);
    await settle();

    h.router.abandonThread("some-other-thread");
    await settle();

    expect(h.answers).toHaveLength(0);
    expect(h.router.getParkedInteractions()).toHaveLength(1);
  });

  test("a dead generation retires the record without writing to the dead child", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(questionRequest(), 4);
    await settle();

    h.router.abandonGeneration(4);
    await settle();

    // skipSend: app-server has forgotten the request, so there is nothing to
    // answer — but the record still has to be retired to the audit trail.
    expect(h.answers).toHaveLength(0);
    expect(h.router.getPending()).toHaveLength(0);
    expect(h.router.getHistory().at(-1)).toMatchObject({
      method: "item/tool/requestUserInput",
      resolution: "cancelled",
    });
    expect(h.resolved[0]!.resolution).toBe("engine-restarted");
    expect(h.transcript.at(-1)?.message).toContain("provider restarted");
  });

  test("abandonGeneration leaves another generation's interaction alone", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(questionRequest("srv-1"), 1);
    h.router.handle(questionRequest("srv-2"), 2);
    await settle();

    h.router.abandonGeneration(1);
    await settle();

    const remaining = h.router.getParkedInteractions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.generation).toBe(2);
  });

  test("interaction ids are unique and generation-scoped", async () => {
    const h = interactionHarness({ approvalTimeoutMs: 5_000 });
    h.router.handle(questionRequest("srv-1"), 1);
    h.router.handle(questionRequest("srv-1"), 2);
    await settle();

    const ids = h.presented.map((interaction) => interaction.interactionId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toContain("-1-");
    expect(ids[1]).toContain("-2-");
  });

  test("metrics count presented, answered and expired, and awaitingUser sums both maps", async () => {
    const h = harness({
      presentApproval: () => true,
      presentInteraction: () => true,
      approvalTimeoutMs: 5_000,
    });
    h.router.handle(request("item/commandExecution/requestApproval", "srv-a"), 1);
    h.router.handle(questionRequest("srv-b"), 1);
    await settle();

    expect(h.router.getMetrics()).toMatchObject({
      approvalsPresented: 1,
      interactionsPresented: 1,
      interactionsAnswered: 0,
      interactionsExpired: 0,
      // One approval and one interaction: the figure the UI uses for "waiting on
      // you" has to cover both maps, not just approvals.
      awaitingUser: 2,
    });

    const interactionId = h.router.getParkedInteractions()[0]!.interactionId;
    h.router.resolveInteraction(interactionId, { action: "accept", answers: { q: ["Yes"] } });
    await settle();

    expect(h.router.getMetrics()).toMatchObject({
      interactionsAnswered: 1,
      awaitingUser: 1,
    });
  });

  test("withdraws interactions from a dead generation without answering it", async () => {
    const presented: InteractionRequest[] = [];
    const h = harness({
      presentInteraction: (interaction) => {
        presented.push(interaction);
        return true;
      },
      approvalTimeoutMs: 5_000,
    });
    h.router.handle(
      {
        ...request("item/tool/requestUserInput"),
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          questions: [
            {
              id: "q",
              header: "Question",
              question: "Continue?",
              isOther: false,
              isSecret: false,
              options: [{ label: "Yes", description: "" }],
            },
          ],
          autoResolutionMs: null,
        },
      },
      7,
    );
    await settle();
    h.router.abandonGeneration(7);
    await settle();

    expect(h.answers).toHaveLength(0);
    expect(h.router.getParkedInteractions()).toHaveLength(0);
    expect(
      h.router.resolveInteraction(presented[0]!.interactionId, {
        action: "accept",
        answers: { q: ["Yes"] },
      }),
    ).toBe(false);
  });
});

describe("pausing a parked deadline", () => {
  const START = 1_800_000_000_000;
  const WINDOW = AGENT_INTERACTION_DEFAULT_TIMEOUT_MS;
  const CEILING = AGENT_INTERACTION_HOLD_CEILING_MS;

  /** Timers fire only when the test advances time past them; nothing waits. */
  function manualClock() {
    let now = START;
    let nextId = 0;
    let unrefs = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const clock: InteractionDeadlineClock = {
      now: () => now,
      setTimeout: (callback, ms) => {
        nextId += 1;
        timers.set(nextId, { at: now + ms, callback });
        return { id: nextId, unref: () => (unrefs += 1) };
      },
      clearTimeout: (handle) => {
        timers.delete((handle as { id: number }).id);
      },
    };
    const advance = (ms: number) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    };
    return {
      clock,
      advance,
      now: () => now,
      armed: () => timers.size,
      unrefs: () => unrefs,
    };
  }

  function pauseHarness(options: { accept?: boolean } = {}) {
    const time = manualClock();
    const approvals: ApprovalRequest[] = [];
    const interactions: InteractionRequest[] = [];
    const resolved: string[] = [];
    let generationLive = true;
    const h = harness({
      clock: time.clock,
      approvalTimeoutMs: WINDOW,
      isGenerationLive: () => generationLive,
      presentApproval: (approval) => {
        approvals.push(approval);
        return options.accept !== false;
      },
      onApprovalResolved: (_approval, _decision, resolution) => resolved.push(resolution),
      presentInteraction: (interaction) => {
        interactions.push(interaction);
        return options.accept !== false;
      },
      onInteractionResolved: (_interaction, _answer, resolution) => resolved.push(resolution),
    });
    return {
      ...h,
      ...time,
      approvals,
      interactions,
      resolved,
      killGeneration: () => {
        generationLive = false;
      },
    };
  }

  function question(params: Record<string, unknown> = {}): InboundServerRequest {
    return {
      kind: "server-request",
      id: "srv-q",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [{ id: "q", header: "Question", question: "Continue?" }],
        ...params,
      },
    };
  }

  function mcpForm(): InboundServerRequest {
    return {
      kind: "server-request",
      id: "srv-mcp",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "deploy",
        mode: "form",
        message: "Choose a region",
        requestedSchema: { type: "object", properties: {} },
      },
    };
  }

  test("a parked approval publishes a full pause and keeps its timer unref'd", async () => {
    const h = pauseHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();

    expect(h.approvals[0]).toMatchObject({
      requestedAt: START,
      expiresAt: START + WINDOW,
      hold: { available: true },
    });
    expect(h.approvals[0]!.hold).toEqual({ available: true });
    expect(h.router.getParkedApprovals()[0]).toMatchObject({
      expiresAt: START + WINDOW,
      hold: { available: true },
    });
    expect(h.unrefs()).toBeGreaterThan(0);
  });

  test("a held approval is not declined past its window, and is declined at the ceiling", async () => {
    const h = pauseHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();
    const approvalId = h.approvals[0]!.approvalId;

    h.advance(60_000);
    const heldAt = START + 60_000;
    expect(h.router.holdApproval(approvalId, true)).toEqual({
      status: "applied",
      expiresAt: heldAt + CEILING,
      hold: { available: true, heldAt },
    });
    // Rehydration sees the moved deadline at once; when it was raised does not move.
    expect(h.router.getParkedApprovals()[0]).toMatchObject({
      requestedAt: START,
      expiresAt: heldAt + CEILING,
      hold: { available: true, heldAt },
    });

    h.advance(WINDOW * 20);
    await settle();
    expect(h.answers).toHaveLength(0);
    expect(h.router.getParkedApprovals()).toHaveLength(1);
    expect(h.router.getMetrics().approvalsExpired).toBe(0);

    h.advance(heldAt + CEILING - h.now() - 1);
    await settle();
    expect(h.answers).toHaveLength(0);

    h.advance(1);
    await settle();
    // The pause only moved the deadline: expiry still declines, never approves.
    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
    expect(h.resolved).toEqual(["timed-out"]);
    expect(h.router.getMetrics().approvalsExpired).toBe(1);
    expect(h.router.getHistory().at(-1)).toMatchObject({
      resolution: "user-declined",
      timedOut: true,
    });
    expect(h.transcript.at(-1)?.message).toContain("expired");
  });

  test("resuming restarts a fresh full window rather than the remainder", async () => {
    const h = pauseHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();
    const approvalId = h.approvals[0]!.approvalId;

    // Paused three seconds before expiry, resumed an hour later.
    h.advance(WINDOW - 3_000);
    expect(h.router.holdApproval(approvalId, true).status).toBe("applied");
    h.advance(60 * 60_000);
    const resumedAt = h.now();
    expect(h.router.holdApproval(approvalId, false)).toEqual({
      status: "applied",
      expiresAt: resumedAt + WINDOW,
      hold: { available: true },
    });
    expect(h.router.getParkedApprovals()[0]!.expiresAt).toBe(resumedAt + WINDOW);

    h.advance(WINDOW - 1);
    await settle();
    expect(h.answers).toHaveLength(0);

    h.advance(1);
    await settle();
    expect(h.answers[0]!.result).toEqual({ decision: "decline" });
    expect(h.resolved).toEqual(["timed-out"]);
  });

  test("a repeated pause or resume is unchanged and a hold never answers", async () => {
    const h = pauseHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();
    const approvalId = h.approvals[0]!.approvalId;

    expect(h.router.holdApproval(approvalId, false)).toEqual({
      status: "unchanged",
      expiresAt: START + WINDOW,
      hold: { available: true },
    });
    expect(h.router.holdApproval(approvalId, true).status).toBe("applied");
    expect(h.router.holdApproval(approvalId, true)).toEqual({
      status: "unchanged",
      expiresAt: START + CEILING,
      hold: { available: true, heldAt: START },
    });
    await settle();

    expect(h.answers).toHaveLength(0);
    expect(h.resolved).toEqual([]);
    expect(h.router.getParkedApprovals()).toHaveLength(1);
  });

  test("a hold on a settled, unknown or dead-generation approval is stale", async () => {
    const h = pauseHarness();
    h.router.handle(request("item/commandExecution/requestApproval", "srv-a"), 1);
    h.router.handle(request("item/commandExecution/requestApproval", "srv-b"), 1);
    await settle();
    const [answered, orphaned] = h.approvals.map((approval) => approval.approvalId);

    h.router.resolveApproval(answered!, "deny");
    await settle();
    expect(h.router.holdApproval(answered!, true)).toEqual({ status: "stale" });
    expect(h.router.holdApproval("apr-does-not-exist", true)).toEqual({ status: "stale" });

    h.killGeneration();
    expect(h.router.holdApproval(orphaned!, true)).toEqual({ status: "stale" });
    // Stale changes nothing: the card keeps its original deadline.
    expect(h.router.getParkedApprovals()[0]!.expiresAt).toBe(START + WINDOW);
  });

  test("settling a held approval disarms its deadline", async () => {
    const h = pauseHarness();
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    await settle();
    const approvalId = h.approvals[0]!.approvalId;
    h.router.holdApproval(approvalId, true);

    h.router.resolveApproval(approvalId, "approve");
    await settle();
    expect(h.armed()).toBe(0);
    h.advance(CEILING * 2);
    await settle();
    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.result).toEqual({ decision: "accept" });
  });

  test("a card nobody takes leaves no deadline armed", async () => {
    const h = pauseHarness({ accept: false });
    h.router.handle(request("item/commandExecution/requestApproval"), 1);
    h.router.handle(question(), 1);
    await settle();

    expect(h.armed()).toBe(0);
    expect(h.answers).toHaveLength(2);
  });

  test("a held MCP elicitation publishes that its server may still give up first", async () => {
    const h = pauseHarness();
    h.router.handle(mcpForm(), 1);
    await settle();
    const interactionId = h.interactions[0]!.interactionId;

    expect(h.interactions[0]).toMatchObject({
      expiresAt: START + WINDOW,
      hold: { available: true, reason: "upstream-may-expire" },
    });
    h.advance(1_000);
    expect(h.router.holdInteraction(interactionId, true)).toEqual({
      status: "applied",
      expiresAt: START + 1_000 + CEILING,
      hold: { available: true, heldAt: START + 1_000, reason: "upstream-may-expire" },
    });
    expect(h.router.getParkedInteractions()[0]).toMatchObject({
      requestedAt: START,
      expiresAt: START + 1_000 + CEILING,
      hold: { available: true, heldAt: START + 1_000, reason: "upstream-may-expire" },
    });

    h.advance(START + 1_000 + CEILING - h.now());
    await settle();
    expect(h.answers[0]!.result).toEqual({ action: "cancel", content: null, _meta: null });
    expect(h.resolved).toEqual(["timed-out"]);
    expect(h.router.getMetrics().interactionsExpired).toBe(1);
  });

  test("an auto-resolving question pauses only until app-server would resolve it", async () => {
    const autoResolutionMs = 60 * 60_000;
    const h = pauseHarness();
    h.router.handle(question({ autoResolutionMs }), 1);
    await settle();
    const interactionId = h.interactions[0]!.interactionId;
    const limit = START + autoResolutionMs;

    // The first deadline is still the shorter of the window and the provider's.
    expect(h.interactions[0]).toMatchObject({
      expiresAt: START + WINDOW,
      hold: { available: true, reason: "provider-limit" },
    });
    expect(h.router.holdInteraction(interactionId, true)).toEqual({
      status: "applied",
      expiresAt: limit,
      hold: { available: true, heldAt: START, reason: "provider-limit" },
    });

    h.advance(limit - h.now() - 1);
    await settle();
    expect(h.answers).toHaveLength(0);
    h.advance(1);
    await settle();
    expect(h.answers[0]!.result).toEqual({ answers: {} });
    expect(h.resolved).toEqual(["timed-out"]);
  });

  test("a question whose provider limit already is the countdown cannot be paused", async () => {
    const h = pauseHarness();
    h.router.handle(question({ autoResolutionMs: 30_000 }), 1);
    await settle();
    const interactionId = h.interactions[0]!.interactionId;

    expect(h.interactions[0]).toMatchObject({
      expiresAt: START + 30_000,
      hold: { available: false, reason: "no-extension" },
    });
    expect(h.router.holdInteraction(interactionId, true)).toEqual({ status: "unavailable" });
    expect(h.router.getParkedInteractions()[0]!.expiresAt).toBe(START + 30_000);
  });

  test("a blocking question has no deadline, so no hold and nothing to pause", async () => {
    const h = pauseHarness();
    h.router.handle(question({ isBlocking: true }), 1);
    await settle();
    const interactionId = h.interactions[0]!.interactionId;

    expect(h.interactions[0]!.expiresAt).toBeUndefined();
    expect(h.interactions[0]!.hold).toBeUndefined();
    expect(h.router.getParkedInteractions()[0]!.hold).toBeUndefined();
    expect(h.armed()).toBe(0);
    expect(h.router.holdInteraction(interactionId, true)).toEqual({ status: "unavailable" });
  });

  test("a hold on a settled or dead-generation interaction is stale", async () => {
    const h = pauseHarness();
    h.router.handle(question(), 1);
    h.router.handle(mcpForm(), 1);
    await settle();
    const [asked, elicited] = h.interactions.map((interaction) => interaction.interactionId);

    h.router.resolveInteraction(asked!, { action: "cancel" });
    await settle();
    expect(h.router.holdInteraction(asked!, true)).toEqual({ status: "stale" });

    h.killGeneration();
    expect(h.router.holdInteraction(elicited!, true)).toEqual({ status: "stale" });
  });
});
