import { afterEach, describe, expect, test } from "bun:test";
import {
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicReceipt,
  type PublicErrorCode,
} from "@orkestrator/protocol/public-api";
import type { PublicEnvironmentSummary } from "@orkestrator/protocol/public-api-resources";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  capabilities,
  captureIo,
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  useVirtualClock,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

import { runClient } from "../src/client/main.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const OPERATION = "op-1790000000000-0a1b2c3d-000000000000000001";

function receipt(overrides: Partial<PublicReceipt>): PublicReceipt {
  return {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    operationId: OPERATION,
    ...overrides,
  };
}

async function fixture(
  receipts: PublicReceipt[],
  extra: Record<string, (call: number) => unknown> = {},
  { virtualClock = true }: { virtualClock?: boolean } = {},
): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox({ virtualClock });
  let call = 0;
  const counters: Record<string, number> = {};
  const gateway = await startFakeGateway((request) => {
    const action = String(request.body.args.action);
    if (action === "run.get") {
      const next = receipts[Math.min(call, receipts.length - 1)]!;
      call += 1;
      return envelope(publicSuccessEnvelope("run.get", null, next));
    }
    if (extra[action]) {
      counters[action] = (counters[action] ?? 0) + 1;
      return envelope(publicSuccessEnvelope(action, extra[action]!(counters[action]!)));
    }
    return defaultResponder()(request);
  });
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return { box, gateway };
}

describe("run wait exit mapping", () => {
  test("raw run output uses base64 bytes even when text is lossy", async () => {
    const { box } = await fixture([receipt({})], {
      "run.output": () => ({
        stream: "stdout",
        text: "��",
        base64: "//4=",
        offset: 0,
        totalBytes: 2,
        complete: true,
      }),
    });
    const result = await box.run(["run", "output", OPERATION, "--raw"]);
    expect(result.code).toBe(0);
    expect(Buffer.from(result.out, "binary")).toEqual(Buffer.from([0xff, 0xfe]));
  });
  test("invalid session wait options never submit a mutation", async () => {
    const { box, gateway } = await fixture([receipt({})]);
    for (const argv of [
      [
        "session",
        "start",
        "--environment",
        "env",
        "--agent",
        "codex",
        "--prompt",
        "hello",
        "--timeout",
        "5m",
      ],
      ["session", "prompt", "session-id", "--prompt", "hello", "--wait", "--timeout", "25h"],
    ]) {
      const result = await box.run(["--json", ...argv]);
      expect(result.code).toBe(2);
    }
    expect(gateway.requests).toHaveLength(0);
  });
  test("0 only after the run succeeds", async () => {
    const running = receipt({
      state: "running",
      stage: "executing",
      execution: { state: "running" },
      completedAt: undefined,
    });
    const { box } = await fixture([running, running, receipt({})]);
    const result = await box.run(["--json", "run", "wait", OPERATION, "--timeout", "10s"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).receipt.state).toBe("succeeded");
  });

  test("6 when an interaction needs an answer, unless told to keep waiting", async () => {
    const waiting = PUBLIC_API_FIXTURES.runWaitingForInput.receipt!;
    const { box } = await fixture([{ ...waiting, operationId: OPERATION }]);
    const result = await box.run(["--json", "run", "wait", OPERATION, "--timeout", "10s"]);
    expect(result.code).toBe(6);
    expect(JSON.parse(result.out).error.details.interactions[0].id).toBe("q-1");
    const keepWaiting = await box.run([
      "--json",
      "run",
      "wait",
      OPERATION,
      "--timeout",
      "600ms",
      "--continue-on-interaction",
    ]);
    expect(keepWaiting.code).toBe(5);
  });

  test("7 for an unknown dispatch, 1 for failures, 5 at the deadline with the receipt kept", async () => {
    const unknown = PUBLIC_API_FIXTURES.promptUnknown.receipt!;
    const first = await fixture([{ ...unknown, operationId: OPERATION }]);
    expect((await first.box.run(["--json", "run", "wait", OPERATION])).code).toBe(7);

    const failed = await fixture([
      receipt({
        state: "failed",
        error: { code: "run-failed", message: "boom" },
        execution: { state: "failed" },
      }),
    ]);
    const failedResult = await failed.box.run(["--json", "run", "wait", OPERATION]);
    expect(failedResult.code).toBe(1);
    expect(JSON.parse(failedResult.out).error.code).toBe("run-failed");

    const running = receipt({
      state: "running",
      execution: { state: "running" },
      completedAt: undefined,
    });
    const slow = await fixture([running]);
    const deadline = await slow.box.run(["--json", "run", "wait", OPERATION, "--timeout", "500ms"]);
    expect(deadline.code).toBe(5);
    const body = JSON.parse(deadline.out);
    expect(body.error.code).toBe("deadline-exceeded");
    expect(body.receipt.operationId).toBe(OPERATION);
  });
});

describe("waiting through a lost submission response", () => {
  const START = [
    "--json",
    "session",
    "start",
    "--environment",
    "env",
    "--agent",
    "codex",
    "--prompt",
    "hello",
    "--request-id",
    "slow-start",
  ];

  /** `session.start` admits but its response is lost; `run.get` finds it later. */
  async function lostStart(
    byKey: Array<PublicReceipt | null>,
    byId: PublicReceipt[],
    options: {
      action?: "session.start" | "session.prompt";
      mutationDelay?: number;
      lookupError?: PublicErrorCode;
      lookupDelay?: number;
      lookupFailures?: number;
      successfulSubmission?: boolean;
      onLookup?: () => void;
      /** Cases whose subject is real elapsed time keep the real clock. */
      realClock?: boolean;
    } = {},
  ) {
    const box = await createSandbox({ virtualClock: !options.realClock });
    const lookups: Array<Record<string, unknown>> = [];
    let starts = 0;
    const gateway = await startFakeGateway(async (request) => {
      const action = String(request.body.args.action);
      const input = request.body.args.input as Record<string, unknown>;
      if (action === (options.action ?? "session.start")) {
        starts += 1;
        if (options.mutationDelay) await Bun.sleep(options.mutationDelay);
        if (options.successfulSubmission)
          return envelope(
            publicSuccessEnvelope(action, { sessionId: "ses_slow", runId: OPERATION }, byId[0]),
          );
        return new Response("upstream timeout", { status: 504 });
      }
      if (action === "run.get" && input.requestId !== undefined) {
        lookups.push(input);
        options.onLookup?.();
        if (options.lookupDelay) await Bun.sleep(options.lookupDelay);
        if (options.lookupFailures && lookups.length <= options.lookupFailures)
          return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
        if (options.lookupError)
          return envelope(
            publicErrorEnvelope("run.get", {
              code: options.lookupError,
              message: "lookup refused",
            }),
          );
        const next = byKey.shift();
        return next
          ? envelope(publicSuccessEnvelope("run.get", null, next))
          : envelope(
              publicErrorEnvelope("run.get", { code: "not-found", message: "not admitted yet" }),
            );
      }
      if (action === "run.get") {
        const next = byId.length > 1 ? byId.shift()! : byId[0]!;
        return envelope(publicSuccessEnvelope("run.get", null, next));
      }
      return defaultResponder()(request);
    });
    cleanups.push(
      () => box.cleanup(),
      () => gateway.stop(),
    );
    const dataDir = await box.publishDescriptor(gateway);
    await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
    return { box, lookups, starts: () => starts };
  }

  const admitted = receipt({
    action: "session.start",
    requestId: "slow-start",
    state: "running",
    stage: "admitted",
    resources: { environmentId: "env" },
    execution: undefined,
    completedAt: undefined,
  });
  const dispatched = receipt({
    action: "session.start",
    requestId: "slow-start",
    state: "running",
    stage: "dispatching",
    resources: { environmentId: "env", sessionId: "ses_slow", tabId: "agent-job-slow" },
    execution: { state: "running" },
    completedAt: undefined,
  });
  const finished = receipt({
    action: "session.start",
    requestId: "slow-start",
    resources: { environmentId: "env", sessionId: "ses_slow", tabId: "agent-job-slow" },
  });

  test("--wait finds the run by its request key and observes it to the end", async () => {
    const { box, lookups, starts } = await lostStart([null, admitted], [dispatched, finished]);
    const result = await box.run([...START, "--wait", "--timeout", "30s"]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out);
    expect(output.receipt.state).toBe("succeeded");
    expect(output.result).toMatchObject({ sessionId: "ses_slow", runId: OPERATION });
    expect(output.warnings.join("\n")).toContain("request key");
    // Looked up under the saved key and namespace; never resubmitted.
    expect(lookups).toHaveLength(2);
    expect(lookups[0]).toMatchObject({ requestId: "slow-start", action: "session.start" });
    expect(typeof lookups[0]!.namespace).toBe("string");
    expect(lookups[0]!.submittedInput).toEqual({
      environmentId: "env",
      agent: "codex",
      prompt: "hello",
    });
    expect(starts()).toBe(1);
  });

  test("the original error stands if the key never appears within the wait", async () => {
    const { box, starts } = await lostStart([], [finished]);
    const result = await box.run([...START, "--wait", "--timeout", "600ms"]);
    expect(result.code).toBe(4);
    const error = JSON.parse(result.out).error;
    expect(error.code).toBe("transport-uncertain");
    expect(error.details).toMatchObject({ requestId: "slow-start" });
    expect(starts()).toBe(1);
  });

  test.each(["history-expired", "auth-failed", "identity-mismatch", "request-conflict"] as const)(
    "preserves definitive %s lookup errors and recovery details",
    async (code) => {
      const { box } = await lostStart([], [], { lookupError: code });
      const result = await box.run([...START, "--wait", "--timeout", "10s"]);
      expect(JSON.parse(result.out).error).toMatchObject({
        code,
        details: { requestId: "slow-start", namespace: expect.any(String) },
      });
    },
  );

  test("signal interruption during recovery retains the key and interruption error", async () => {
    const controller = new AbortController();
    const { box } = await lostStart([], [], { onLookup: () => controller.abort("SIGTERM") });
    const io = captureIo(box.env);
    const code = await runClient([...START, "--wait"], {
      io,
      version: "test",
      signal: controller.signal,
    });
    expect(code).toBe(143);
    expect(JSON.parse(io.out.join("")).error).toMatchObject({
      code: "observation-interrupted",
      details: { requestId: "slow-start" },
    });
  });

  test("connection failures are retried without another submission", async () => {
    const { box, starts, lookups } = await lostStart([finished], [finished], { lookupFailures: 1 });
    expect((await box.run([...START, "--wait", "--timeout", "10s"])).code).toBe(0);
    expect(lookups).toHaveLength(2);
    expect(starts()).toBe(1);
  });

  test("prompt recovery reconstructs the run ID from its receipt", async () => {
    const final = { ...finished, action: "session.prompt" as const };
    const { box, lookups } = await lostStart([final], [final], { action: "session.prompt" });
    const result = await box.run([
      "--json",
      "session",
      "prompt",
      "ses_slow",
      "--prompt",
      "hello",
      "--wait",
      "--request-id",
      "slow-start",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).result.runId).toBe(OPERATION);
    expect(lookups[0]!.submittedInput).toEqual({ sessionId: "ses_slow", prompt: "hello" });
  });

  test("submission and an absent-key lookup share one deadline", async () => {
    const { box, lookups } = await lostStart([], [], { mutationDelay: 180, realClock: true });
    const started = Date.now();
    const result = await box.run([...START, "--wait", "--timeout", "300ms"]);
    expect(JSON.parse(result.out).error.code).toBe("transport-uncertain");
    expect(lookups).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(450);
  });

  test("a stalled lookup is bounded by the remaining deadline", async () => {
    const { box } = await lostStart([], [], {
      mutationDelay: 120,
      lookupDelay: 600,
      realClock: true,
    });
    const started = Date.now();
    const result = await box.run([...START, "--wait", "--timeout", "250ms"]);
    expect(JSON.parse(result.out).error.code).toBe("transport-uncertain");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("recovery and final observation share the remaining deadline", async () => {
    const { box } = await lostStart([admitted], [dispatched], {
      mutationDelay: 160,
      realClock: true,
    });
    const started = Date.now();
    const result = await box.run([...START, "--wait", "--timeout", "300ms"]);
    expect(JSON.parse(result.out).error.code).toBe("deadline-exceeded");
    expect(Date.now() - started).toBeLessThan(450);
  });

  test("ordinary admission retains the full observation duration", async () => {
    const { box } = await lostStart([], [dispatched, finished], {
      mutationDelay: 300,
      successfulSubmission: true,
      realClock: true,
    });
    const result = await box.run([...START, "--wait", "--timeout", "400ms"]);
    expect(result.code).toBe(0);
  });

  test.each(["--prompt", "--environment"])(
    "locally known changed %s is refused before sending and preserves its saved digest",
    async (field) => {
      const { box, starts } = await lostStart([finished, finished], [finished]);
      expect((await box.run([...START, "--wait"])).code).toBe(0);
      const changed = [...START];
      changed[changed.indexOf(field) + 1] = "changed";
      const result = await box.run([...changed, "--wait"]);
      expect(JSON.parse(result.out).error.code).toBe("request-conflict");
      expect(starts()).toBe(1);
      expect((await box.run([...START, "--wait"])).code).toBe(0);
      expect(starts()).toBe(2);
    },
  );

  test("without --wait a lost response is reported, not looked up", async () => {
    const { box, lookups } = await lostStart([finished], [finished]);
    const result = await box.run(START);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.code).toBe("transport-uncertain");
    expect(lookups).toHaveLength(0);
  });
});

describe("environment --wait through a lost submission response", () => {
  type Mutation =
    | "environment.start"
    | "environment.stop"
    | "environment.recreate"
    | "environment.delete"
    | "environment.exec";

  function environmentSummary(overrides: Partial<PublicEnvironmentSummary> = {}) {
    return {
      id: "env",
      projectId: "proj",
      name: "env",
      branch: "env",
      environmentType: "container",
      status: "running",
      ready: true,
      setup: { phase: "ready", complete: true, overridden: false },
      lifecycle: { operation: null, error: null, deletionRequested: false },
      activity: { state: null, hasUnreadWork: false },
      pendingAgentLaunch: false,
      startupSession: null,
      workspacePath: null,
      base: { branch: null, commit: null },
      pr: { url: null, state: null },
      createdAt: "2026-11-01T00:00:00.000Z",
      lastActivityAt: null,
      settingsRevision: "rev-1",
      ...overrides,
    } satisfies PublicEnvironmentSummary;
  }

  /** `action` admits but its response is lost; `run.get` finds it by key later. */
  async function lostEnvironmentMutation(
    action: Mutation,
    byKey: Array<PublicReceipt | null>,
    byId: PublicReceipt[],
    options: {
      mutationDelay?: number;
      readDelay?: "run.get" | "environment.get";
      environment?: PublicEnvironmentSummary | null;
      /** Cases whose subject is real elapsed time keep the real clock. */
      realClock?: boolean;
    } = {},
  ) {
    const box = await createSandbox({ virtualClock: !options.realClock });
    const lookups: Array<Record<string, unknown>> = [];
    let submissions = 0;
    const gateway = await startFakeGateway(async (request) => {
      const called = String(request.body.args.action);
      const input = request.body.args.input as Record<string, unknown>;
      if (called === action) {
        submissions += 1;
        if (options.mutationDelay) await Bun.sleep(options.mutationDelay);
        return new Response("upstream timeout", { status: 504 });
      }
      if (called === "run.get" && input.requestId !== undefined) {
        lookups.push(input);
        const next = byKey.shift();
        return next
          ? envelope(publicSuccessEnvelope("run.get", null, next))
          : envelope(
              publicErrorEnvelope("run.get", { code: "not-found", message: "not admitted yet" }),
            );
      }
      if (called === options.readDelay && input.requestId === undefined) await Bun.sleep(1_500);
      if (called === "run.get") {
        const next = byId.length > 1 ? byId.shift()! : byId[0]!;
        return envelope(publicSuccessEnvelope("run.get", null, next));
      }
      if (called === "environment.get")
        return envelope(
          options.environment === null
            ? publicErrorEnvelope("environment.get", { code: "not-found", message: "deleted" })
            : publicSuccessEnvelope("environment.get", options.environment ?? environmentSummary()),
        );
      return defaultResponder()(request);
    });
    cleanups.push(
      () => box.cleanup(),
      () => gateway.stop(),
    );
    const dataDir = await box.publishDescriptor(gateway);
    await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
    return { box, lookups, submissions: () => submissions };
  }

  const startReceipt = (overrides: Partial<PublicReceipt>) =>
    receipt({
      action: "environment.start",
      requestId: "slow-env",
      resources: { environmentId: "env" },
      dispatch: undefined,
      execution: undefined,
      ...overrides,
    });
  const execReceipt = (overrides: Partial<PublicReceipt>) =>
    receipt({
      action: "environment.exec",
      requestId: "slow-exec",
      resources: { environmentId: "env" },
      dispatch: undefined,
      result: { operationId: OPERATION },
      ...overrides,
    });
  const START = ["--json", "environment", "start", "env", "--request-id", "slow-env"];
  const EXEC = ["--json", "environment", "exec", "env", "--request-id", "slow-exec"];
  const COMMAND = ["--", "sh", "-c", "exit 3"];

  test("start --wait ready finds the start by its request key and waits for setup", async () => {
    const provisioning = startReceipt({ state: "running", stage: "setup", completedAt: undefined });
    const { box, lookups, submissions } = await lostEnvironmentMutation(
      "environment.start",
      [null, provisioning],
      [provisioning, startReceipt({})],
    );
    const result = await box.run([...START, "--wait", "ready", "--timeout", "30s"]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out);
    expect(output.receipt.state).toBe("succeeded");
    expect(output.result).toMatchObject({ condition: "ready", environment: { ready: true } });
    expect(output.warnings.join("\n")).toContain("request key");
    expect(lookups).toHaveLength(2);
    expect(lookups[0]).toMatchObject({ requestId: "slow-env", action: "environment.start" });
    expect(typeof lookups[0]!.namespace).toBe("string");
    expect(lookups[0]!.submittedInput).toEqual({ environmentId: "env" });
    expect(submissions()).toBe(1);
  });

  test("a recovered start that failed setup still reports the setup failure", async () => {
    const { box, submissions } = await lostEnvironmentMutation(
      "environment.start",
      [startReceipt({ state: "running", stage: "setup", completedAt: undefined })],
      [startReceipt({ state: "running", stage: "setup", completedAt: undefined })],
      {
        environment: environmentSummary({
          status: "error",
          ready: false,
          setup: { phase: "failed", complete: false, overridden: false },
          lifecycle: { operation: null, error: "setup script exited 2", deletionRequested: false },
        }),
      },
    );
    const result = await box.run([...START, "--wait", "ready", "--timeout", "30s"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).error).toMatchObject({
      code: "setup-failed",
      message: "setup script exited 2",
    });
    expect(submissions()).toBe(1);
  });

  test("the other lifecycle commands share the recovery", async () => {
    const stopped = startReceipt({ action: "environment.stop" });
    const { box, lookups, submissions } = await lostEnvironmentMutation(
      "environment.stop",
      [stopped],
      [stopped],
      { environment: environmentSummary({ status: "stopped", ready: false }) },
    );
    const result = await box.run([
      "--json",
      "environment",
      "stop",
      "env",
      "--request-id",
      "slow-env",
      "--wait",
      "stopped",
      "--timeout",
      "30s",
    ]);
    expect(result.code).toBe(0);
    expect(lookups[0]).toMatchObject({ action: "environment.stop" });
    expect(submissions()).toBe(1);
  });

  test.each([false, true])("recreate recovery preserves discard=%s intent", async (discard) => {
    const completed = startReceipt({ action: "environment.recreate" });
    const { box, lookups, submissions } = await lostEnvironmentMutation(
      "environment.recreate",
      [completed],
      [completed],
    );
    const result = await box.run([
      "--json",
      "environment",
      "recreate",
      "env",
      "--request-id",
      "slow-env",
      "--wait",
      "ready",
      ...(discard ? ["--discard"] : []),
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      receipt: { action: "environment.recreate", state: "succeeded" },
      result: { condition: "ready", environment: { ready: true } },
    });
    expect(lookups[0]).toMatchObject({
      action: "environment.recreate",
      submittedInput: { environmentId: "env", ...(discard ? { discard: true } : {}) },
    });
    expect(lookups[0]!.submittedInput).toEqual({
      environmentId: "env",
      ...(discard ? { discard: true } : {}),
    });
    expect(submissions()).toBe(1);
  });

  test("delete recovery waits for a successful operation and a missing environment", async () => {
    const running = startReceipt({
      action: "environment.delete",
      state: "running",
      completedAt: undefined,
    });
    const completed = startReceipt({ action: "environment.delete" });
    const { box, lookups, submissions } = await lostEnvironmentMutation(
      "environment.delete",
      [running],
      [running, completed],
      { environment: null },
    );
    const result = await box.run([
      "--json",
      "environment",
      "delete",
      "env",
      "--request-id",
      "slow-env",
      "--wait",
      "deleted",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      receipt: { action: "environment.delete", state: "succeeded" },
      result: { condition: "deleted", environment: null },
    });
    expect(lookups[0]).toMatchObject({
      action: "environment.delete",
      submittedInput: { environmentId: "env" },
    });
    expect(submissions()).toBe(1);
  });

  test.each(["run.get", "environment.get"] as const)(
    "recovered lifecycle bounds a stalled %s read by the remaining deadline",
    async (readDelay) => {
      const running = startReceipt({ state: "running", stage: "setup", completedAt: undefined });
      const { box, submissions } = await lostEnvironmentMutation(
        "environment.start",
        [running],
        [startReceipt({})],
        { mutationDelay: 400, readDelay, realClock: true },
      );
      const started = Date.now();
      const result = await box.run([...START, "--wait", "ready", "--timeout", "600ms"]);
      expect(result.code).toBe(5);
      expect(JSON.parse(result.out)).toMatchObject({
        error: { code: "deadline-exceeded" },
        receipt: {
          operationId: OPERATION,
          action: "environment.start",
          state: readDelay === "run.get" ? "running" : "succeeded",
        },
      });
      expect(Date.now() - started).toBeLessThan(950);
      expect(submissions()).toBe(1);
    },
  );

  test("exec --wait observes a recovered, not yet claimed command to its exit", async () => {
    // The worker had not claimed the operation when it was found: the lookup
    // reports admission, not the command's outcome, so the client keeps
    // observing instead of treating the missing claim as a failure.
    const unclaimed = execReceipt({
      state: "running",
      stage: "executing",
      result: { operationId: OPERATION, launch: "unconfirmed" },
      execution: { state: "pending", reason: "control timed out" },
      completedAt: undefined,
    });
    const exited = execReceipt({
      execution: { state: "completed", evidence: "process-exit", exitCode: 0 },
    });
    const { box, lookups, submissions } = await lostEnvironmentMutation(
      "environment.exec",
      [null, unclaimed],
      [unclaimed, exited],
    );
    const result = await box.run([...EXEC, "--wait", "--timeout", "30s", ...COMMAND]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.out);
    expect(output.receipt.state).toBe("succeeded");
    expect(output.result).toEqual({ execution: exited.execution });
    expect(output.warnings.join("\n")).toContain("request key");
    expect(lookups[0]).toMatchObject({ requestId: "slow-exec", action: "environment.exec" });
    expect(lookups[0]!.submittedInput).toEqual({ environmentId: "env", argv: COMMAND.slice(1) });
    expect(submissions()).toBe(1);
  });

  test("exec --wait --exit-code passes a recovered command's own exit code through", async () => {
    const exited = execReceipt({
      state: "failed",
      error: { code: "exec-failed", message: "exited 3" },
      execution: { state: "failed", evidence: "process-exit", exitCode: 3 },
    });
    const { box, submissions } = await lostEnvironmentMutation(
      "environment.exec",
      [exited],
      [exited],
    );
    const result = await box.run([...EXEC, "--wait", "--exit-code", ...COMMAND]);
    expect(result.code).toBe(3);
    expect(submissions()).toBe(1);
  });

  test.each([
    ["start", [...START, "--wait", "running", "--timeout", "600ms"], "environment.start"],
    ["exec", [...EXEC, "--wait", "--timeout", "600ms", ...COMMAND], "environment.exec"],
  ] as const)(
    "%s: the original error stands if the key never appears within the wait",
    async (_name, argv, action) => {
      const { box, submissions } = await lostEnvironmentMutation(action, [], []);
      const result = await box.run([...argv]);
      expect(result.code).toBe(4);
      const error = JSON.parse(result.out).error;
      expect(error.code).toBe("transport-uncertain");
      expect(error.details).toMatchObject({ requestId: expect.stringMatching(/^slow-/) });
      expect(submissions()).toBe(1);
    },
  );

  test.each([
    ["start", START, "environment.start"],
    ["exec", [...EXEC, ...COMMAND], "environment.exec"],
  ] as const)(
    "%s without --wait reports a lost response, not looked up",
    async (_name, argv, action) => {
      const { box, lookups } = await lostEnvironmentMutation(action, [], []);
      const result = await box.run([...argv]);
      expect(result.code).toBe(4);
      expect(JSON.parse(result.out).error.code).toBe("transport-uncertain");
      expect(lookups).toHaveLength(0);
    },
  );

  test("exec recovery and final observation share the --timeout deadline", async () => {
    const running = execReceipt({
      state: "running",
      stage: "executing",
      execution: { state: "running" },
      completedAt: undefined,
    });
    const { box } = await lostEnvironmentMutation("environment.exec", [running], [running], {
      mutationDelay: 400,
      realClock: true,
    });
    const started = Date.now();
    const result = await box.run([...EXEC, "--wait", "--timeout", "500ms", ...COMMAND]);
    expect(JSON.parse(result.out).error.code).toBe("deadline-exceeded");
    // A fresh budget after recovery would run past 400 + 500 ms.
    expect(Date.now() - started).toBeLessThan(850);
  });
});

describe("transcript following", () => {
  const page = (ids: string[], token: string) => ({
    sessionId: "ses_eA",
    order: "oldest-first",
    messages: ids.map((id) => ({
      id,
      role: "assistant",
      createdAt: null,
      text: `text ${id}`,
      textTruncated: false,
      parts: [],
    })),
    complete: true,
    truncated: false,
    token,
    historyEpoch: "e",
    freshness: "current",
  });
  const FOLLOW = ["--jsonl", "session", "transcript", "ses_eA", "--follow", "--timeout"];
  const sentTokens = (gateway: FakeGateway) =>
    gateway.requests
      .filter((request) => request.body.args.action === "session.transcript")
      .map((request) => (request.body.args.input as { knownToken?: string }).knownToken);
  const followed = (out: string) =>
    out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; message?: { id: string } })
      .filter((record) => record.type === "message")
      .map((record) => record.message!.id);

  test("streams each new message once as JSONL and flags gaps", async () => {
    const pages = [
      page(["a", "b"], "t1"),
      page(["a", "b"], "t1"),
      page(["a", "b", "c"], "t2"),
      page(["x", "y"], "t3"),
    ];
    const { box, gateway } = await fixture([], {
      "session.transcript": (call) => pages[Math.min(call - 1, pages.length - 1)],
    });
    const result = await box.run([
      "--jsonl",
      "session",
      "transcript",
      "ses_eA",
      "--follow",
      "--timeout",
      "3s",
    ]);
    expect(result.code).toBe(0);
    const records = result.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const messages = records
      .filter((record) => record.type === "message")
      .map((record) => record.message.id);
    expect(messages).toEqual(["a", "b", "c", "x", "y"]);
    expect(records.some((record) => record.type === "gap")).toBe(true);
    expect(records.at(-1)).toMatchObject({ ok: true, action: "session.transcript" });
    // This backend does not advertise knownToken: it would refuse the input.
    expect(sentTokens(gateway).every((token) => token === undefined)).toBe(true);
  });

  test("sends the held token where advertised and keeps the page on unchanged", async () => {
    const answers = [
      page(["a", "b"], "t1"),
      { sessionId: "ses_eA", status: "unchanged", token: "t1" },
      page(["a", "b", "c"], "t2"),
      { sessionId: "ses_eA", status: "unchanged", token: "t2" },
    ];
    const { box, gateway } = await fixture([], {
      capabilities: () =>
        capabilities({ features: { ...capabilities().features, transcriptKnownToken: true } }),
      "session.transcript": (call) => answers[Math.min(call - 1, answers.length - 1)],
    });
    const result = await box.run([...FOLLOW, "2s"]);
    expect(result.code).toBe(0);
    expect(followed(result.out)).toEqual(["a", "b", "c"]);
    const tokens = sentTokens(gateway);
    expect(tokens.length).toBeGreaterThanOrEqual(4);
    expect(tokens.slice(0, 4)).toEqual([undefined, "t1", "t1", "t2"]);
    expect(tokens.slice(4).every((token) => token === "t2")).toBe(true);
    // Capabilities are read once for the whole follow, not per poll.
    expect(
      gateway.requests.filter((request) => request.body.args.action === "capabilities"),
    ).toHaveLength(1);
  });

  test.each([true, false])(
    "--node follow uses the leaf's knownToken capability (%s), not the hub's",
    async (leafSupportsToken) => {
      const leaf = "bk_leaf";
      const box = await createSandbox({ virtualClock: true });
      cleanups.push(() => box.cleanup());
      let polls = 0;
      const gateway = await startFakeGateway((request) => {
        const { action, node, input } = request.body.args;
        if (action === "capabilities") {
          const own = capabilities();
          return envelope(
            publicSuccessEnvelope("capabilities", {
              ...own,
              features: {
                ...own.features,
                nodeRouting: true,
                // Deliberately disagree so using the hub's flag fails either case.
                ...(node === leaf
                  ? leafSupportsToken && { transcriptKnownToken: true }
                  : { transcriptKnownToken: !leafSupportsToken }),
              },
            }),
          );
        }
        if (action === "session.transcript" && node === leaf) {
          polls += 1;
          const token = polls < 3 ? "t1" : "t2";
          const knownToken = (input as { knownToken?: string }).knownToken;
          if (!leafSupportsToken && knownToken !== undefined) {
            return envelope(
              publicErrorEnvelope("session.transcript", {
                code: "invalid-input",
                message: "This leaf does not accept knownToken",
              }),
            );
          }
          return envelope({
            ...publicSuccessEnvelope(
              "session.transcript",
              leafSupportsToken && knownToken === token
                ? { sessionId: "ses_eA", status: "unchanged", token }
                : page(polls < 3 ? ["a", "b"] : ["a", "b", "c"], token),
            ),
            node: { nodeId: leaf, name: "Studio" },
          });
        }
        return defaultResponder()(request);
      });
      cleanups.push(() => gateway.stop());
      const dataDir = await box.publishDescriptor(gateway);
      const added = await box.run([
        "connection",
        "add",
        "local",
        "--data-dir",
        dataDir,
        "--default",
        "--no-check",
      ]);
      expect(added.code).toBe(0);
      gateway.requests.length = 0;

      const result = await box.run(["--node", leaf, ...FOLLOW, "2s"]);
      expect(result.code).toBe(0);
      expect(followed(result.out)).toEqual(["a", "b", "c"]);
      expect(
        gateway.requests
          .filter((request) => request.body.args.action === "capabilities")
          .map((request) => request.body.args.node),
      ).toEqual([undefined, leaf]);
      const transcriptRequests = gateway.requests.filter(
        (request) => request.body.args.action === "session.transcript",
      );
      expect(transcriptRequests.length).toBeGreaterThanOrEqual(4);
      expect(transcriptRequests.every((request) => request.body.args.node === leaf)).toBe(true);
      const tokens = sentTokens(gateway);
      expect(tokens.slice(0, 4)).toEqual(
        leafSupportsToken ? [undefined, "t1", "t1", "t2"] : Array(4).fill(undefined),
      );
      expect(
        tokens.slice(4).every((token) => token === (leafSupportsToken ? "t2" : undefined)),
      ).toBe(true);
    },
  );
  /*
   * The trigger measurement for an event-stream follow (public-cli.md,
   * "Following without an event stream"). A scripted busy session: one 1 KiB
   * message every 400 ms for 30 s, then 30 s idle, followed for 60 s on the
   * virtual clock against a backend that answers `unchanged` to a held token.
   * The budget it pins: at most 35 reads a minute (an open native tab polls
   * about twice a second while streaming), every message out within 2 s of
   * being written, and an idle stretch that downloads no page at all.
   */
  test("a busy-session follow stays within the polling budget", async () => {
    const box = await createSandbox();
    cleanups.push(() => box.cleanup());
    const io = captureIo(box.env, box.root);
    useVirtualClock(io);
    const start = io.now();
    const BUSY_MESSAGES = 75;
    const SPACING_MS = 400;
    const writtenAt = (index: number) => start + SPACING_MS * (index + 1);
    const text = "x".repeat(1024);
    const firstServed = new Map<string, number>();
    const reads: Array<{ at: number; bytes: number; unchanged: boolean }> = [];
    const gateway = await startFakeGateway((request) => {
      const { action, input } = request.body.args;
      if (action === "capabilities") {
        return envelope(
          publicSuccessEnvelope(
            "capabilities",
            capabilities({ features: { ...capabilities().features, transcriptKnownToken: true } }),
          ),
        );
      }
      if (action !== "session.transcript") return defaultResponder()(request);
      const now = io.now();
      let written = 0;
      while (written < BUSY_MESSAGES && writtenAt(written) <= now) written += 1;
      const token = `t${written}`;
      const ids = Array.from({ length: written }, (_, index) => `m${index}`).slice(-100);
      const known = (input as { knownToken?: string }).knownToken === token;
      const result = known
        ? { sessionId: "ses_eA", status: "unchanged", token }
        : {
            ...page(ids, token),
            messages: page(ids, token).messages.map((message) => ({ ...message, text })),
          };
      if (!known) for (const id of ids) if (!firstServed.has(id)) firstServed.set(id, now);
      const response = publicSuccessEnvelope("session.transcript", result);
      reads.push({ at: now - start, bytes: JSON.stringify(response).length, unchanged: known });
      return envelope(response);
    });
    cleanups.push(() => gateway.stop());
    const dataDir = await box.publishDescriptor(gateway);
    const added = await box.run([
      "connection",
      "add",
      "local",
      "--data-dir",
      dataDir,
      "--default",
      "--no-check",
    ]);
    expect(added.code).toBe(0);

    const result = await box.run([...FOLLOW, "60s"], io);
    expect(result.code).toBe(0);
    expect(followed(result.out)).toEqual(
      Array.from({ length: BUSY_MESSAGES }, (_, index) => `m${index}`),
    );

    const latencies = Array.from(
      { length: BUSY_MESSAGES },
      (_, index) => firstServed.get(`m${index}`)! - writtenAt(index),
    );
    const busy = reads.filter((read) => read.at <= SPACING_MS * BUSY_MESSAGES);
    const idle = reads.filter((read) => read.at > SPACING_MS * BUSY_MESSAGES + 2_000);
    const measured = {
      reads: reads.length,
      maxLatencyMs: Math.max(...latencies),
      meanLatencyMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / BUSY_MESSAGES),
      busyReads: busy.length,
      busyBytes: busy.reduce((sum, read) => sum + read.bytes, 0),
      idleReads: idle.length,
      idleBytes: idle.reduce((sum, read) => sum + read.bytes, 0),
    };
    // The figures recorded in public-cli.md; a change to the poll schedule or
    // the conditional read shows up here first. Poll times are fixed by the
    // backoff (250 ms doubling to 2 s), so the counts and latencies are exact.
    expect(measured).toMatchObject({
      reads: 34,
      maxLatencyMs: 1_750,
      meanLatencyMs: 937,
      busyReads: 18,
      idleReads: 15,
    });
    expect(measured.reads).toBeLessThanOrEqual(35);
    expect(measured.maxLatencyMs).toBeLessThanOrEqual(2_000);
    // A changed read carries the whole window (here at most 75 messages of
    // about 1.1 KiB each); an unchanged one carries only the token.
    expect(measured.busyBytes).toBeLessThan(measured.busyReads * 75 * 1_200);
    expect(idle.every((read) => read.unchanged)).toBe(true);
    expect(measured.idleBytes).toBeLessThan(idle.length * 200);
  });
});
