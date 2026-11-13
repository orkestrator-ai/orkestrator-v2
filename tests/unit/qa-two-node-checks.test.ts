/**
 * The pure parts of the two-node checks of to-dos 1030 (tasks 2, 7) and 4860 (task 2): the
 * goal `scripts/qa-remote-goal-hold.ts` gives the leaf's worker (a goal the
 * leaf's own goal service accepts as running, held by a check that waits for
 * a file), and how the mixed-version `nodes` module reads a coordinator's
 * `list_nodes` machine entry (`scripts/mixed-version/scenarios/coordinator-list-nodes.ts`).
 * The live runs themselves need two backends and are recorded in the docs.
 * The gateway invoker is checked against a local stand-in server on an
 * ephemeral port.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { goalIsRunning, isNativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";

import { InvokeError } from "../../scripts/mixed-version/harness";
import {
  buildCommitCheck,
  gatewayInvoker,
  hasReadings,
  machineEvidence,
  type ListedMachine,
  type ListedNode,
} from "../../scripts/mixed-version/scenarios/coordinator-list-nodes";
import { heldGoal, waitForFileCheck } from "../../scripts/qa-remote-goal-hold";
import { nativeWebPlatform } from "../register-dom";

// The root preload installs Happy DOM's fetch, abort and Response classes; a
// loopback server and Bun's fetch need Bun's own.
const { Response, AbortController } = nativeWebPlatform;

describe("the remote goal hold's seeded goal", () => {
  test("is a valid running goal on the session's own provider session", () => {
    const goal = heldGoal({
      providerSessionId: "provider-1",
      check: waitForFileCheck("/work/release"),
      now: new Date("2026-11-13T00:00:00Z"),
    });
    expect(isNativeAgentGoal(goal)).toBe(true);
    expect(goalIsRunning(goal.status)).toBe(true);
    expect(goal).toMatchObject({ status: "checking", providerSessionId: "provider-1" });
    expect(goal.iterations).toBeLessThan(goal.maxIterations);
  });

  test("waits on a quoted path, so a space or a quote cannot split the check", () => {
    expect(waitForFileCheck("/a b/it's")).toBe(`until [ -f '/a b/it'"'"'s' ]; do sleep 1; done`);
  });
});

describe("a list_nodes machine entry", () => {
  const ok: ListedMachine = {
    status: "ok",
    osFamily: "linux",
    os: "Debian GNU/Linux 13 (trixie)",
    cpuCores: 8,
    totalRamGb: 16,
    latestSampleAgeSeconds: 3,
    load: [
      { window: "5m", windowSeconds: 300, coveredSeconds: 15, cpuPercent: 12, ramPercent: 40 },
    ],
  };

  test("has readings only once the machine has sampled itself", () => {
    expect(hasReadings(ok)).toBe(true);
    expect(hasReadings({ ...ok, latestSampleAgeSeconds: null })).toBe(false);
    expect(
      hasReadings({
        ...ok,
        load: [
          {
            window: "5m",
            windowSeconds: 300,
            coveredSeconds: 0,
            cpuPercent: null,
            ramPercent: null,
          },
        ],
      }),
    ).toBe(false);
    expect(hasReadings({ status: "unavailable", reason: "older-version" })).toBe(false);
    expect(hasReadings(undefined)).toBe(false);
  });

  test("records figures, and for an unavailable machine only its reason", () => {
    expect(machineEvidence(ok)).toMatchObject({ status: "ok", cpuCores: 8, totalRamGb: 16 });
    expect(machineEvidence({ status: "unavailable", reason: "older-version" })).toEqual({
      status: "unavailable",
      reason: "older-version",
    });
  });
});

describe("NO-C8's buildCommit check", () => {
  const entry = (fields: Partial<ListedNode>): ListedNode => ({
    nodeId: "leaf",
    available: true,
    state: "connected",
    version: "2.36.1",
    hasProject: true,
    machine: { status: "unavailable", reason: "older-version" },
    ...fields,
  });

  test("fails when list_nodes omits the field, even when the hello has none", () => {
    expect(buildCommitCheck(entry({}), undefined)).toEqual({
      passed: false,
      observed: "absent",
      expected: null,
    });
    expect(buildCommitCheck(undefined, undefined).passed).toBe(false);
  });

  test("passes an explicit null for a hello without the field", () => {
    expect(buildCommitCheck(entry({ buildCommit: null }), undefined)).toEqual({
      passed: true,
      observed: null,
      expected: null,
    });
  });

  test("passes a matching commit and fails a different one or a missing one", () => {
    const commit = "209b1249b965618855d928d9fde3cdeaaa2b9373";
    expect(buildCommitCheck(entry({ buildCommit: commit }), commit).passed).toBe(true);
    expect(buildCommitCheck(entry({ buildCommit: "other" }), commit).passed).toBe(false);
    expect(buildCommitCheck(entry({ buildCommit: null }), commit).passed).toBe(false);
  });
});

describe("the gateway invoker", () => {
  let server: ReturnType<typeof Bun.serve>;
  let node: { origin: string; token: string };
  const seen: Array<{ authorization: string | null; body: unknown }> = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as { command: string };
        seen.push({ authorization: request.headers.get("authorization"), body });
        switch (body.command) {
          case "ok":
            return Response.json({ result: { answer: 42 } });
          case "string-error":
            return Response.json({ error: "Unknown backend command: x" }, { status: 400 });
          case "object-error":
            return Response.json({ error: { message: "not allowed" } }, { status: 403 });
          case "plain-text":
            return new Response("upstream exploded", { status: 502 });
          case "long-text":
            return new Response("x".repeat(2_000), { status: 500 });
          case "slow":
            await Bun.sleep(5_000);
            return Response.json({ result: null });
          default:
            return new Response("unexpected", { status: 500 });
        }
      },
    });
    node = { origin: `http://127.0.0.1:${server.port}`, token: "test-token" };
  });

  afterAll(() => {
    server.stop(true);
  });

  async function failure(command: string): Promise<InvokeError> {
    try {
      await gatewayInvoker(node, nativeWebPlatform)(command);
    } catch (error) {
      expect(error).toBeInstanceOf(InvokeError);
      return error as InvokeError;
    }
    throw new Error(`${command} did not fail`);
  }

  test("posts the command with the node's bearer and returns the result", async () => {
    expect(
      await gatewayInvoker(node, nativeWebPlatform)<{ answer: number }>("ok", { a: 1 }),
    ).toEqual({ answer: 42 });
    expect(seen.at(-1)).toEqual({
      authorization: "Bearer test-token",
      body: { command: "ok", args: { a: 1 } },
    });
  });

  test("maps a string error, an object error and a non-JSON body to InvokeError", async () => {
    expect((await failure("string-error")).failure).toEqual({
      status: 400,
      message: "Unknown backend command: x",
    });
    expect((await failure("object-error")).failure).toEqual({
      status: 403,
      message: "not allowed",
    });
    expect((await failure("plain-text")).failure).toEqual({
      status: 502,
      message: "upstream exploded",
    });
  });

  test("bounds the message it keeps from a large body", async () => {
    expect((await failure("long-text")).failure.message).toHaveLength(500);
  });

  test("aborts when the caller's signal does", async () => {
    const controller = new AbortController();
    const pending = gatewayInvoker(node, nativeWebPlatform)(
      "slow",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
