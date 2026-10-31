import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PUBLIC_EXIT,
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicActionResponse,
} from "@orkestrator/protocol/public-api";
import type {
  NativeAgentGoalReason,
  NativeAgentGoalStatus,
  NativeAgentGoalView,
} from "@orkestrator/protocol/native-agent-goal";
import {
  nativeTabLogicalSessionKey,
  type PublicSessionGoal,
} from "@orkestrator/protocol/public-api-resources";
import { nativeAgentSessionStorageKey } from "../../../apps/backend/src/core/native-agent-service.js";
import {
  cleanupSessionHarnesses,
  setActivity,
  setup,
} from "../../../apps/backend/src/core/public-api/test-provider.js";
import {
  captureIo,
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const GOAL_ID = "goal-1";

function view(
  status: NativeAgentGoalStatus,
  overrides: Partial<NativeAgentGoalView> = {},
): NativeAgentGoalView {
  return {
    goalId: GOAL_ID,
    objective: "Make the tests pass",
    status,
    iterations: 3,
    maxIterations: 20,
    noProgressStreak: 0,
    setAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function read(overrides: Partial<PublicSessionGoal> = {}): PublicSessionGoal {
  return {
    sessionId: "session-id",
    agent: "claude",
    activity: "idle",
    pendingInteractionCount: 0,
    goal: view("active"),
    description: "Running",
    history: [],
    ...overrides,
  };
}

const MUTATED = {
  sessionId: "session-id",
  goal: {
    goalId: GOAL_ID,
    status: "active",
    running: true,
    iterations: 0,
    maxIterations: 20,
    hasCheck: true,
    updatedAt: new Date(0).toISOString(),
  },
};

/** Each `session.goal.get` answers with the next read; the last one repeats. */
async function fixture(
  reads: PublicSessionGoal[] = [],
  overrides: Partial<Record<string, PublicActionResponse | (() => Response)>> = {},
) {
  const box = await createSandbox();
  let next = 0;
  const gateway = await startFakeGateway((request) => {
    const action = String(request.body.args.action);
    const override = overrides[action];
    if (typeof override === "function") return override();
    if (override) return envelope(override);
    if (action === "session.goal.get") {
      const answer = reads[Math.min(next, reads.length - 1)]!;
      next += 1;
      return envelope(publicSuccessEnvelope("session.goal.get", answer));
    }
    if (action.startsWith("session.goal.")) {
      return envelope(publicSuccessEnvelope(action, MUTATED));
    }
    return defaultResponder()(request);
  });
  cleanups.push(
    () => gateway.stop(),
    () => box.cleanup(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  const sent = (action: string) =>
    gateway.requests.filter((request) => request.body.args.action === action);
  return { box, gateway, sent };
}

const SET = ["session", "goal", "set", "session-id", "--objective", "Make the tests pass"];

describe("session goal set", () => {
  test("sends structured fields, and an objective full of flags stays one string", async () => {
    const { box, sent } = await fixture();
    const objective = "Explain --budget 5 and --check rm";
    const run = await box.run([
      "session",
      "goal",
      "set",
      "session-id",
      "--objective",
      objective,
      "--check",
      "bun test --bail",
      "--max-iterations",
      "7",
      "--budget",
      "5000",
      "--request-id",
      "goal-key",
      "--json",
    ]);
    expect(run.code).toBe(0);
    const [write] = sent("session.goal.set");
    expect(write!.body.args.input).toEqual({
      sessionId: "session-id",
      objective,
      check: "bun test --bail",
      maxIterations: 7,
      tokenBudget: 5000,
    });
    expect(write!.body.args.request).toMatchObject({ requestId: "goal-key" });
  });

  test("a limit left out is left to the backend", async () => {
    const { box, sent } = await fixture();
    await box.run([...SET, "--json"]);
    expect(sent("session.goal.set")[0]!.body.args.input).toEqual({
      sessionId: "session-id",
      objective: "Make the tests pass",
    });
  });

  test("reads the objective from a file or stdin, one source only", async () => {
    const { box, sent, gateway } = await fixture();
    const file = path.join(box.root, "objective.md");
    await writeFile(file, "From a file\n");
    await box.run(["session", "goal", "set", "s", "--objective-file", file, "--json"]);
    expect(sent("session.goal.set")[0]!.body.args.input).toMatchObject({
      objective: "From a file\n",
    });

    const io = captureIo(box.env, box.root);
    io.stdinBytes = new TextEncoder().encode("From stdin\n");
    await box.run(["session", "goal", "set", "s", "--objective-stdin", "--json"], io);
    expect(sent("session.goal.set")[1]!.body.args.input).toMatchObject({
      objective: "From stdin\n",
    });

    const before = gateway.requests.length;
    const both = await box.run([
      "session",
      "goal",
      "set",
      "s",
      "--objective-file",
      file,
      "--objective",
      "two",
    ]);
    expect(both.code).toBe(PUBLIC_EXIT.invalidInput);
    expect(gateway.requests).toHaveLength(before);
  });

  test("needs an objective, and --timeout needs --wait, before any request", async () => {
    const { box, gateway } = await fixture();
    const before = gateway.requests.length;
    expect((await box.run(["session", "goal", "set", "s"])).code).toBe(PUBLIC_EXIT.invalidInput);
    expect((await box.run([...SET, "--timeout", "5m"])).code).toBe(PUBLIC_EXIT.invalidInput);
    expect(gateway.requests).toHaveLength(before);
  });

  test("--verifier sends an agent, and a model split at its first colon", async () => {
    const { box, sent } = await fixture();
    await box.run([...SET, "--verifier", "codex", "--json"]);
    expect(sent("session.goal.set")[0]!.body.args.input).toMatchObject({
      verifier: { agent: "codex" },
    });
    await box.run([...SET, "--verifier", "opencode:vendor/model:tag", "--json"]);
    expect(sent("session.goal.set")[1]!.body.args.input).toMatchObject({
      verifier: { agent: "opencode", model: "vendor/model:tag" },
    });
    await box.run([...SET, "--json"]);
    expect(sent("session.goal.set")[2]!.body.args.input).not.toHaveProperty("verifier");
  });

  test("a malformed --verifier is refused before any request", async () => {
    const { box, gateway } = await fixture();
    const before = gateway.requests.length;
    for (const value of ["nobody", "nobody:model", "codex:", ""]) {
      const run = await box.run([...SET, "--verifier", value, "--json"]);
      expect(run.code).toBe(PUBLIC_EXIT.invalidInput);
    }
    expect(gateway.requests).toHaveLength(before);
  });

  test("a verifier's name shows with the goal", async () => {
    const { box } = await fixture([
      read({ goal: view("active", { verifier: { agent: "codex", model: "o3" } }) }),
    ]);
    const run = await box.run(["session", "goal", "get", "session-id"]);
    expect(run.out).toContain("codex:o3");
  });

  test("--output id prints the goal ID", async () => {
    const { box } = await fixture();
    const run = await box.run([...SET, "--output", "id"]);
    expect(run.out.trim()).toBe(GOAL_ID);
  });

  test("a refusal keeps its code and exit", async () => {
    const { box } = await fixture([], {
      "session.goal.set": publicErrorEnvelope("session.goal.set", {
        code: "conflict",
        message: "A goal is already running",
      }),
    });
    const run = await box.run([...SET, "--json"]);
    expect(run.code).toBe(PUBLIC_EXIT.conflict);
    expect(JSON.parse(run.out).error.code).toBe("conflict");
  });
});

describe("--wait exits with how the goal ended", () => {
  const ENDINGS: Array<[string, Partial<PublicSessionGoal>, number, string | null]> = [
    ["complete", { goal: view("complete") }, 0, null],
    ["claimed", { goal: view("claimed") }, 10, "goal-claimed"],
    ["blocked", { goal: view("blocked") }, 11, "goal-blocked"],
    ["limited", { goal: view("limited") }, 12, "goal-limited"],
    ["paused", { goal: view("paused") }, 13, "goal-paused"],
    ["cleared while running", { goal: null, history: [view("active")] }, 14, "goal-gone"],
    ["cleared while paused", { goal: null, history: [view("paused")] }, 14, "goal-gone"],
    ["missing altogether", { goal: null }, 14, "goal-gone"],
    [
      "replaced after completing",
      { goal: view("active", { goalId: "goal-2" }), history: [view("complete")] },
      0,
      null,
    ],
    [
      "replaced after a claim",
      { goal: view("active", { goalId: "goal-2" }), history: [view("claimed")] },
      10,
      "goal-claimed",
    ],
  ];

  for (const [name, ending, code, errorCode] of ENDINGS) {
    test(`${name}: ${code}`, async () => {
      const { box } = await fixture([read(), read(ending)]);
      const run = await box.run([...SET, "--wait", "--timeout", "10s", "--json"]);
      expect(run.code).toBe(code);
      const body = JSON.parse(run.out);
      expect(body.ok).toBe(errorCode === null);
      if (errorCode) {
        expect(body.error.code).toBe(errorCode);
        expect(body.error.exitCode).toBe(code);
        expect(body.error.details).toMatchObject({ sessionId: "session-id" });
        expect(run.out).not.toContain("Make the tests pass");
      }
    });
  }

  test("every ending's status is distinct, and none collides with another class", () => {
    const codes = [
      PUBLIC_EXIT.goalClaimed,
      PUBLIC_EXIT.goalBlocked,
      PUBLIC_EXIT.goalLimited,
      PUBLIC_EXIT.goalPaused,
      PUBLIC_EXIT.goalGone,
    ];
    expect(new Set(codes).size).toBe(codes.length);
    const others = Object.entries(PUBLIC_EXIT)
      .filter(([name]) => !name.startsWith("goal"))
      .map(([, code]) => code as number);
    for (const code of codes) expect(others).not.toContain(code);
  });

  test("a running goal outlasting the deadline exits 5 and is not cancelled", async () => {
    const { box, sent } = await fixture([read()]);
    const run = await box.run([...SET, "--wait", "--timeout", "300ms", "--json"]);
    expect(run.code).toBe(PUBLIC_EXIT.deadline);
    const body = JSON.parse(run.out);
    expect(body.error.code).toBe("deadline-exceeded");
    expect(body.error.details).toMatchObject({ goalId: GOAL_ID, status: "active" });
    expect(sent("session.goal.pause")).toHaveLength(0);
    expect(sent("session.goal.clear")).toHaveLength(0);
  });

  test("a turn waiting on an answer exits 6, unless told to keep waiting", async () => {
    const waiting = read({ activity: "waiting", pendingInteractionCount: 1 });
    const first = await fixture([waiting]);
    const stopped = await first.box.run([...SET, "--wait", "--timeout", "10s", "--json"]);
    expect(stopped.code).toBe(PUBLIC_EXIT.interactionRequired);
    expect(JSON.parse(stopped.out).error.details.pendingInteractionCount).toBe(1);

    const second = await fixture([waiting, read({ goal: view("complete") })]);
    const kept = await second.box.run([
      ...SET,
      "--wait",
      "--timeout",
      "10s",
      "--continue-on-interaction",
      "--json",
    ]);
    expect(kept.code).toBe(0);
  });

  test("a lost response is found by its key, and the wait goes on", async () => {
    let attempts = 0;
    const { box, sent } = await fixture([read({ goal: view("complete") })], {
      "session.goal.set": () => {
        attempts += 1;
        return new Response("gateway fell over", { status: 502 });
      },
      "run.get": envelope.bind(null, {
        ...publicSuccessEnvelope("run.get", {}),
        receipt: {
          operationId: "op-1",
          namespace: "ns",
          requestId: "goal-key",
          action: "session.goal.set",
          state: "succeeded",
          stage: "completed",
          replayed: true,
          resources: {},
          result: MUTATED,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          retainedUntil: new Date(0).toISOString(),
        },
      } as PublicActionResponse),
    });
    const run = await box.run([
      ...SET,
      "--wait",
      "--timeout",
      "10s",
      "--request-id",
      "goal-key",
      "--json",
    ]);
    expect(attempts).toBe(1);
    expect(sent("session.goal.set")).toHaveLength(1);
    expect(run.code).toBe(0);
  });

  test("a failed set is reported, and nothing is observed", async () => {
    const { box, sent } = await fixture([read()], {
      "session.goal.set": publicErrorEnvelope("session.goal.set", {
        code: "capability-unavailable",
        message: "Goals are not available",
      }),
    });
    const run = await box.run([...SET, "--wait", "--json"]);
    expect(run.code).toBe(PUBLIC_EXIT.conflict);
    expect(sent("session.goal.get")).toHaveLength(0);
  });
});

describe("session goal get", () => {
  test("shows a goal, or none, with exit 0", async () => {
    const shown = await fixture([read()]);
    const human = await shown.box.run(["session", "goal", "get", "session-id"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Make the tests pass");
    expect(human.out).toContain("3/20");

    const empty = await fixture([read({ goal: null, description: null })]);
    const json = await empty.box.run(["session", "goal", "get", "session-id", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out).result.goal).toBeNull();
  });

  test("--check-output asks for the output tail", async () => {
    const { box, sent } = await fixture([read({ checkOutput: "FAILED" })]);
    const run = await box.run(["session", "goal", "get", "s", "--check-output", "--json"]);
    expect(sent("session.goal.get")[0]!.body.args.input).toEqual({
      sessionId: "s",
      includeCheckOutput: true,
    });
    expect(JSON.parse(run.out).result.checkOutput).toBe("FAILED");
  });

  test("--wait observes the goal the session holds, so a later run can pick it up", async () => {
    const { box } = await fixture([read(), read({ goal: view("limited") })]);
    const run = await box.run(["session", "goal", "get", "s", "--wait", "--timeout", "10s"]);
    expect(run.code).toBe(PUBLIC_EXIT.goalLimited);
  });

  test("--wait with no goal is the gone status, not a success", async () => {
    const { box } = await fixture([read({ goal: null })]);
    const run = await box.run(["session", "goal", "get", "s", "--wait", "--json"]);
    expect(run.code).toBe(PUBLIC_EXIT.goalGone);
  });

  test("--wait on a goal that already ended answers at once", async () => {
    const { box } = await fixture([read({ goal: view("complete") })]);
    expect((await box.run(["session", "goal", "get", "s", "--wait"])).code).toBe(0);
  });
});

describe("session goal pause, resume and clear", () => {
  test("each sends its action with a request key", async () => {
    const { box, sent } = await fixture([read({ goal: view("complete") })]);
    for (const verb of ["pause", "clear"]) {
      const run = await box.run([
        "session",
        "goal",
        verb,
        "session-id",
        "--request-id",
        `key-${verb}`,
        "--json",
      ]);
      expect(run.code).toBe(0);
      const [write] = sent(`session.goal.${verb}`);
      expect(write!.body.args.input).toEqual({ sessionId: "session-id" });
      expect(write!.body.args.request).toMatchObject({ requestId: `key-${verb}` });
    }
    const resume = await box.run([
      "session",
      "goal",
      "resume",
      "session-id",
      "--max-iterations",
      "50",
      "--budget",
      "900",
      "--wait",
      "--timeout",
      "10s",
    ]);
    expect(resume.code).toBe(0);
    expect(sent("session.goal.resume")[0]!.body.args.input).toEqual({
      sessionId: "session-id",
      maxIterations: 50,
      tokenBudget: 900,
    });
  });

  test("a positional session is required, and nothing is sent without it", async () => {
    const { box, gateway } = await fixture();
    const before = gateway.requests.length;
    for (const verb of ["pause", "resume", "clear", "get"]) {
      expect((await box.run(["session", "goal", verb])).code).toBe(PUBLIC_EXIT.invalidInput);
    }
    expect(gateway.requests).toHaveLength(before);
  });
});

/**
 * The client against the real `public_action`, ledger and goal service, with a
 * scripted provider. The loop's own transitions are the goal service's tests, so
 * here the goal is moved to its end state on the session record, as the loop
 * would, while the client observes it.
 */
describe("a script against a real backend", () => {
  async function realBackend() {
    const { harness, stub, service } = await setup();
    const started = await harness.call<{ sessionId: string; tabId: string }>(
      "session.start",
      { environmentId: "env-1", agent: "claude", prompt: "first turn" },
      { requestId: "start" },
    );
    if (!started.ok) throw new Error(started.error.message);
    const { sessionId, tabId } = started.result;
    setActivity(service, "claude", tabId, stub.sends[0]!.sessionId, "idle");
    const box = await createSandbox();
    const gateway = await startFakeGateway(async (request) => {
      const handler = harness.commands.get(String(request.body.command))!;
      const answer = await handler(request.body.args, harness.context);
      return Response.json({ result: answer });
    });
    cleanups.push(
      () => gateway.stop(),
      () => box.cleanup(),
      () => cleanupSessionHarnesses(),
    );
    const dataDir = await box.publishDescriptor(gateway, {
      installationId: (await harness.storage.previewServices.getPreviewBackendIdentity())
        .instanceId,
    });
    await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
    const key = nativeAgentSessionStorageKey(
      "env-1",
      "claude",
      nativeTabLogicalSessionKey("env-1", tabId),
    );
    return {
      box,
      harness,
      service,
      sessionId,
      key,
      /** Once the goal is set and observed, end it the way the loop would. */
      endWhenSet(status: NativeAgentGoalStatus, statusReason: NativeAgentGoalReason) {
        const timer = setInterval(() => {
          void harness.storage
            .updateNativeAgentGoal(key, (goal) =>
              goal ? { ...goal, status, statusReason, iterations: 4 } : undefined,
            )
            .then((session) => {
              if (session?.goal) clearInterval(timer);
            });
        }, 20);
        cleanups.push(async () => clearInterval(timer));
      },
    };
  }

  test("complete exits 0 and prints the goal; the record has the objective", async () => {
    const { box, sessionId, key, harness, endWhenSet, service } = await realBackend();
    endWhenSet("complete", "check-passed");
    const objective = "Explain --budget 5 --check rm";
    const run = await box.run([
      "session",
      "goal",
      "set",
      sessionId,
      "--objective",
      objective,
      "--check",
      "bun test",
      "--max-iterations",
      "9",
      "--request-id",
      "script-1",
      "--wait",
      "--timeout",
      "10s",
      "--json",
    ]);
    await service.goals.settled();
    expect(run.code).toBe(0);
    const body = JSON.parse(run.out);
    expect(body).toMatchObject({
      ok: true,
      action: "session.goal.set",
      result: { goal: { status: "complete", objective, maxIterations: 9 } },
      receipt: { action: "session.goal.set", state: "succeeded" },
    });
    expect(JSON.stringify(body.receipt)).not.toContain(objective);
    const stored = await harness.storage.getNativeAgentSession(key);
    expect(stored?.goal).toMatchObject({ objective, check: "bun test" });
    expect((stored?.goal as { tokenBudget?: number }).tokenBudget).toBeUndefined();

    // The same request again: the same goal, the same answer, nothing new.
    const again = await box.run([
      "session",
      "goal",
      "set",
      sessionId,
      "--objective",
      objective,
      "--check",
      "bun test",
      "--max-iterations",
      "9",
      "--request-id",
      "script-1",
      "--wait",
      "--timeout",
      "10s",
      "--json",
    ]);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out).receipt.replayed).toBe(true);
    expect((await harness.storage.getNativeAgentSession(key))?.goalHistory ?? []).toEqual([]);
  });

  test("a claim exits 10, and the script can read why and clear it", async () => {
    const { box, sessionId, endWhenSet, service } = await realBackend();
    endWhenSet("claimed", "agent-claimed");
    const run = await box.run([
      "session",
      "goal",
      "set",
      sessionId,
      "--objective",
      "Make it pass",
      "--wait",
      "--timeout",
      "10s",
      "--json",
    ]);
    await service.goals.settled();
    expect(run.code).toBe(PUBLIC_EXIT.goalClaimed);
    expect(JSON.parse(run.out).error).toMatchObject({
      code: "goal-claimed",
      details: { status: "claimed", statusReason: "agent-claimed", iterations: 4 },
    });

    const read = await box.run(["session", "goal", "get", sessionId, "--json"]);
    expect(JSON.parse(read.out).result.goal.status).toBe("claimed");
    const cleared = await box.run(["session", "goal", "clear", sessionId, "--json"]);
    expect(JSON.parse(cleared.out).result.cleared).toBe(true);
    const gone = await box.run(["session", "goal", "get", sessionId, "--wait", "--json"]);
    expect(gone.code).toBe(PUBLIC_EXIT.goalGone);
  });

  test("a refused second goal exits 8 with nothing changed", async () => {
    const { box, sessionId, service, harness, key } = await realBackend();
    const set = (objective: string) =>
      box.run(["session", "goal", "set", sessionId, "--objective", objective, "--json"]);
    expect((await set("One")).code).toBe(0);
    await service.goals.settled();
    const refused = await set("Two");
    expect(refused.code).toBe(PUBLIC_EXIT.conflict);
    expect(JSON.parse(refused.out).error.code).toBe("conflict");
    expect((await harness.storage.getNativeAgentSession(key))?.goal).toMatchObject({
      objective: "One",
    });
  });
});
