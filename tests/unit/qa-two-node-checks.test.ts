/**
 * The pure parts of the two-node checks of to-dos 1030 (retired; tasks 2, 7) and 4860 (retired; task 2): the
 * goal `scripts/qa-remote-goal-hold.ts` gives the leaf's worker (a goal the
 * leaf's own goal service accepts as running, held by a check that waits for
 * a file), and how the mixed-version `nodes` module reads a coordinator's
 * `list_nodes` machine entry (`scripts/mixed-version/scenarios/coordinator-list-nodes.ts`).
 * The live runs themselves need two backends and are recorded in the docs.
 * The gateway invoker, and the production `list_nodes` handler with NO-C6 to
 * NO-C8 over its answer, are checked against a local stand-in command node on
 * an ephemeral port, for a current leaf and for one older than
 * `get_machine_load`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { goalIsRunning, isNativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";

import { InvokeError } from "../../scripts/mixed-version/harness";
import {
  buildCommitCheck,
  coordinatorListNodes,
  gatewayInvoker,
  hasReadings,
  listNodesChecks,
  listNodesSettled,
  machineEvidence,
  type ListedLeafExpectation,
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

describe("a coordinator's list_nodes over a stand-in command node", () => {
  const GIT_URL = "https://github.com/acme/site.git";
  const report = {
    osFamily: "linux",
    os: "Debian GNU/Linux 13 (trixie)",
    arch: "x64",
    cpuCores: 8,
    totalRamGb: 16,
    latestSampleAgeSeconds: 2,
    load: [
      { window: "5m", windowSeconds: 300, coveredSeconds: 20, cpuPercent: 10, ramPercent: 30 },
    ],
  };
  /** What the stand-in leaf is: its release, commit and whether it serves its load. */
  const leaf = {
    version: "2.36.4",
    buildCommit: "209b1249b965618855d928d9fde3cdeaaa2b9373" as string | undefined,
    servesLoad: true,
    hasProject: true,
  };
  let server: ReturnType<typeof Bun.serve>;
  let command: { origin: string; token: string };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (request.headers.get("authorization") !== "Bearer list-token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const { command: name, args } = (await request.json()) as {
          command: string;
          args: Record<string, unknown>;
        };
        switch (name) {
          case "get_node_status":
            return Response.json({
              result: { nodeId: "bk_command", mode: "command", controllers: [] },
            });
          case "get_projects":
            return Response.json({ result: [{ id: "p1", gitUrl: GIT_URL }] });
          case "get_machine_load":
            return Response.json({ result: report });
          case "get_node_summaries":
            return Response.json({
              result: {
                selfId: "bk_command",
                nodes: [
                  {
                    nodeId: "bk_leaf",
                    available: true,
                    version: leaf.version,
                    // A release before the field leaves it out of its summary.
                    ...(leaf.buildCommit === undefined ? {} : { buildCommit: leaf.buildCommit }),
                    view: {
                      displayName: "Leaf",
                      connection: { state: "connected", remoteMode: "leaf" },
                    },
                    projects: leaf.hasProject ? [{ repositoryHint: repositoryHint(GIT_URL) }] : [],
                  },
                ],
              },
            });
          case "invoke_on_node":
            if (args.nodeId !== "bk_leaf" || args.command !== "get_machine_load") break;
            return leaf.servesLoad
              ? Response.json({ result: { outcome: "ok", result: report } })
              : Response.json(
                  { error: "Unknown backend command: get_machine_load" },
                  { status: 400 },
                );
        }
        return Response.json({ error: `unexpected ${name}` }, { status: 500 });
      },
    });
    command = { origin: `http://127.0.0.1:${server.port}`, token: "list-token" };
  });

  afterAll(() => {
    server.stop(true);
  });

  /**
   * The handler's 2 s deadline (`runWithTimeout`) builds its signal from the
   * global AbortController, which the root preload replaces with Happy DOM's;
   * Bun's `AbortSignal.any` in the invoker accepts only Bun's own. A
   * qualification run has no preload, so lend the call Bun's for its duration.
   */
  async function listNodes() {
    const preloaded = globalThis.AbortController;
    globalThis.AbortController = AbortController;
    try {
      return await coordinatorListNodes(command, "p1", nativeWebPlatform);
    } finally {
      globalThis.AbortController = preloaded;
    }
  }

  const expectation = (): ListedLeafExpectation => ({
    id: "bk_leaf",
    version: leaf.version,
    helloBuildCommit: leaf.buildCommit,
    servesLoad: leaf.servesLoad,
  });

  test("a current leaf is listed connected with its project, readings and commit", async () => {
    Object.assign(leaf, {
      version: "2.36.4",
      buildCommit: "209b1249b965618855d928d9fde3cdeaaa2b9373",
      servesLoad: true,
      hasProject: true,
    });
    const listed = await listNodes();
    expect(listed.self.nodeId).toBe("bk_command");
    expect(listNodesSettled(listed, expectation())).toBe(true);
    const { checks, leafEvidence } = listNodesChecks(listed, expectation());
    expect(checks.map((entry) => [entry.id, entry.passed])).toEqual([
      ["NO-C6", true],
      ["NO-C7", true],
      ["NO-C8", true],
    ]);
    expect(leafEvidence).toMatchObject({
      buildCommit: leaf.buildCommit,
      machine: { status: "ok", cpuCores: 8 },
    });
  });

  test("an older leaf reads older-version over the link and a null commit", async () => {
    Object.assign(leaf, {
      version: "2.34.4-beta",
      buildCommit: undefined,
      servesLoad: false,
      hasProject: true,
    });
    const listed = await listNodes();
    expect(listNodesSettled(listed, expectation())).toBe(true);
    const { checks, leafEvidence } = listNodesChecks(listed, expectation());
    expect(checks.every((entry) => entry.passed)).toBe(true);
    expect(checks[1]!.description).toContain("older-version");
    expect(leafEvidence).toMatchObject({
      buildCommit: null,
      helloBuildCommit: null,
      machine: { status: "unavailable", reason: "older-version" },
    });
  });

  test("fails NO-C6 without the project and NO-C7 when a leaf that serves load reads unavailable", async () => {
    Object.assign(leaf, {
      version: "2.36.4",
      buildCommit: undefined,
      servesLoad: false,
      hasProject: false,
    });
    const listed = await listNodes();
    // The scenario expects readings from this leaf, so its older-version answer fails NO-C7.
    const current = { ...expectation(), servesLoad: true };
    expect(listNodesSettled(listed, current)).toBe(false);
    const { checks } = listNodesChecks(listed, current);
    expect(checks.map((entry) => [entry.id, entry.passed])).toEqual([
      ["NO-C6", false],
      ["NO-C7", false],
      ["NO-C8", true],
    ]);
  });

  test("an answer without the leaf is never settled and fails every check", () => {
    const listed = {
      self: { nodeId: "bk_command", version: "x", buildCommit: null, machine: { status: "ok" } },
      nodes: [],
    };
    expect(listNodesSettled(listed, expectation())).toBe(false);
    expect(listNodesChecks(listed, expectation()).checks.some((entry) => entry.passed)).toBe(false);
  });
});
