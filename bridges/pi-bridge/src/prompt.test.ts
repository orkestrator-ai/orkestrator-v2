/**
 * Turn lifecycle.
 *
 * `dispatchPrompt` is driven here against a stub `AgentSession` rather than a
 * real one: the behaviour worth pinning is what this bridge does around the
 * SDK — when it reports a turn accepted, what it records when the turn ends,
 * and what it does with a run that outlives its budget — none of which needs a
 * model to answer.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { newSessionState } from "./agent-session.js";
import { dispatchPrompt, journal, setStructuredResult, type DispatchInput } from "./prompt.js";
import type { SessionState } from "./state.js";

// The timeout is read from the environment at import, and six hours is not a
// thing a test can wait for. Set before `config.ts` is first loaded by the
// dynamic import below.
process.env.PI_BRIDGE_PROMPT_TIMEOUT_MS = "60000";

interface StubSession {
  session: AgentSession;
  finish: () => void;
  fail: (error: unknown) => void;
  accept: (accepted: boolean) => void;
  aborted: () => number;
  never: boolean;
}

/**
 * A session whose run this test controls.
 *
 * `preflightResult` is how the bridge learns a prompt was accepted, so the
 * stub exposes it directly instead of inferring acceptance from the run.
 */
function stubSession(options: { autoAccept?: boolean; onAbort?: () => void } = {}): StubSession {
  let settleRun: () => void = () => undefined;
  let rejectRun: (error: unknown) => void = () => undefined;
  let announce: (accepted: boolean) => void = () => undefined;
  let abortCount = 0;

  const run = new Promise<void>((resolve, reject) => {
    settleRun = resolve;
    rejectRun = reject;
  });

  const session = {
    prompt: (_text: string, opts: { preflightResult?: (ok: boolean) => void }) => {
      announce = opts.preflightResult ?? (() => undefined);
      if (options.autoAccept !== false) queueMicrotask(() => announce(true));
      return run;
    },
    abort: async () => {
      options.onAbort?.();
      abortCount += 1;
      // A real abort ends the run; the bridge must not depend on that, but it
      // is the honest stub.
      settleRun();
    },
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
  } as unknown as AgentSession;

  return {
    session,
    finish: () => settleRun(),
    fail: (error) => rejectRun(error),
    accept: (accepted) => announce(accepted),
    aborted: () => abortCount,
    never: false,
  };
}

function runningState(): SessionState {
  const state = newSessionState();
  state.status = "running";
  state.promptSequence = 1;
  state.currentTurnUsage = {};
  return state;
}

function input(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return { prompt: "do the thing", images: [], ...overrides };
}

describe("dispatchPrompt", () => {
  test("resolves as soon as the prompt is accepted, not when the turn ends", async () => {
    const state = runningState();
    const stub = stubSession();

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    // The turn has not finished — the route is free to answer 202 anyway.
    expect(state.status).toBe("running");

    stub.finish();
    await handle.completion;
    expect(state.status).toBe("idle");
  });

  test("installs a cancel handle that aborts the live run", async () => {
    const state = runningState();
    const stub = stubSession();

    const handle = await dispatchPrompt(state, stub.session, input());
    expect(state.cancelTurn).toBeDefined();

    await state.cancelTurn?.();
    expect(stub.aborted()).toBe(1);
    await handle.completion;
  });

  test("rejects when Pi refuses the prompt at preflight", async () => {
    const state = runningState();
    const stub = stubSession({ autoAccept: false });
    queueMicrotask(() => {
      stub.accept(false);
      stub.finish();
    });

    await expect(dispatchPrompt(state, stub.session, input())).rejects.toThrow();
  });

  test("records a completed turn as idle with its journal entry", async () => {
    const state = runningState();
    const stub = stubSession();
    journal(state, "req-1", "accepted");

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    stub.finish();
    await handle.completion;

    expect(state.status).toBe("idle");
    expect(state.error).toBeUndefined();
    expect(state.promptJournal.get("req-1")?.state).toBe("completed");
    // Everything the turn was holding is released, or the next turn inherits it.
    expect(state.cancelTurn).toBeUndefined();
    expect(state.compacting).toBe(false);
  });

  test("records a failed turn with the text Pi refused with", async () => {
    const state = runningState();
    const stub = stubSession();

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    stub.fail(new Error("provider is out of quota"));
    await handle.completion;

    expect(state.status).toBe("error");
    expect(state.error).toBe("provider is out of quota");
    expect(state.promptJournal.get("req-1")?.state).toBe("failed");
  });

  test("aborts a run that outlived its budget before reporting the turn failed", async () => {
    process.env.PI_BRIDGE_PROMPT_TIMEOUT_MS = "60000";
    const state = runningState();
    const order: string[] = [];
    const stub = stubSession({ onAbort: () => order.push("abort") });
    state.approvals.set("a1", {
      id: "a1",
      toolCallId: "call-1",
      toolName: "bash",
      input: { command: "deploy" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      settle: (decision) => {
        state.approvals.delete("a1");
        order.push(decision);
      },
    });

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    // Stand in for the timeout firing: the wait rejects while the run is still
    // going. The bridge must spend the cancel handle before `settleTurn` drops
    // it, or the run keeps writing into a transcript reported as failed and
    // nothing can stop it.
    const cancel = state.cancelTurn;
    expect(cancel).toBeDefined();
    stub.fail(new Error("The Pi turn exceeded its time budget"));
    await handle.completion;

    expect(stub.aborted()).toBe(1);
    expect(order).toEqual(["deny", "abort"]);
    expect(state.status).toBe("error");
    expect(state.cancelTurn).toBeUndefined();
  });

  test("leaves a superseded turn's outcome to the turn that replaced it", async () => {
    const state = runningState();
    const stub = stubSession();
    journal(state, "req-1", "accepted");

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    // A second turn claimed the session while the first was still running.
    state.promptSequence += 1;
    stub.finish();
    await handle.completion;

    // Still running: the *new* turn owns the status, and the old run must not
    // report the session idle underneath it.
    expect(state.status).toBe("running");
    expect(state.promptJournal.get("req-1")?.state).toBe("accepted");
  });

  test("does not settle a turn whose session already failed", async () => {
    const state = runningState();
    const stub = stubSession();

    const handle = await dispatchPrompt(state, stub.session, input({ requestId: "req-1" }));
    state.status = "error";
    state.error = "something else failed first";
    stub.finish();
    await handle.completion;

    expect(state.error).toBe("something else failed first");
  });
});

describe("structured output", () => {
  test("parses the turn's final JSON value", async () => {
    const state = runningState();
    const stub = stubSession();
    state.currentTurnOutput = '{"verdict":"ready"}';

    const handle = await dispatchPrompt(
      state,
      stub.session,
      input({ requestId: "req-1", schema: { type: "object" } }),
    );
    stub.finish();
    await handle.completion;

    expect(state.structured.get("req-1")).toMatchObject({
      ok: true,
      provider: "pi",
      requestId: "req-1",
      value: { verdict: "ready" },
    });
  });

  test("reports a turn that ended with prose as malformed rather than throwing", async () => {
    const state = runningState();
    const stub = stubSession();
    state.currentTurnOutput = "I could not decide.";

    const handle = await dispatchPrompt(
      state,
      stub.session,
      input({ requestId: "req-1", schema: { type: "object" } }),
    );
    stub.finish();
    await handle.completion;

    expect(state.structured.get("req-1")).toMatchObject({
      ok: false,
      error: { code: "malformed_output", retryable: true },
    });
  });

  test("refuses an output past the size cap instead of retaining it", async () => {
    const state = runningState();
    const stub = stubSession();
    state.currentTurnOutput = `{"a":"${"x".repeat(2 * 1024 * 1024)}"}`;

    const handle = await dispatchPrompt(
      state,
      stub.session,
      input({ requestId: "req-1", schema: { type: "object" } }),
    );
    stub.finish();
    await handle.completion;

    const result = state.structured.get("req-1") as { ok: boolean; error?: { message: string } };
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("size limit");
  });

  test("bounds how many results one session retains", () => {
    const state = runningState();
    for (let index = 0; index < 80; index += 1) {
      setStructuredResult(state, `req-${index}`, { ok: true });
    }
    // Oldest-first eviction, so a long-lived session running structured turns
    // cannot retain every result it has ever produced.
    expect(state.structured.size).toBe(64);
    expect(state.structured.has("req-79")).toBe(true);
    expect(state.structured.has("req-0")).toBe(false);
  });
});
