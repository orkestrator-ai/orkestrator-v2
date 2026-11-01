import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  capabilities,
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
  type RecordedRequest,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const LEAF = "bk_leaf";

async function fixture(
  respond: (request: RecordedRequest) => Response | undefined,
  options: { nodeRouting?: boolean } = {},
): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  const own = capabilities();
  const gateway = await startFakeGateway((request) => {
    const answer = respond(request);
    if (answer) return answer;
    if (request.body.args.action === "capabilities") {
      return envelope(
        publicSuccessEnvelope("capabilities", {
          ...own,
          features: { ...own.features, nodeRouting: options.nodeRouting ?? true },
        }),
      );
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

function requestsFor(gateway: FakeGateway, action: string) {
  return gateway.requests.filter((request) => request.body.args.action === action);
}

function receipt(action: PublicReceipt["action"]): PublicReceipt {
  return {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    operationId: "op-1790000000000-0a1b2c3d-000000000000000021",
    action,
    state: "running",
    stage: "executing",
    resources: { sessionId: "ses_pr", tabId: "agent-job-pr" },
  };
}

describe("--node", () => {
  test("sends request.node after checking the connected node can route it", async () => {
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "project.list" && request.body.args.node === LEAF
        ? envelope({
            ...publicSuccessEnvelope("project.list", {
              items: [{ id: "p1", name: "Site", environmentCount: 1, localPath: null }],
              total: 1,
            }),
            node: { nodeId: LEAF, name: "Studio" },
          })
        : undefined,
    );
    const run = await box.run(["--node", LEAF, "project", "list", "--json"]);
    expect(run.code).toBe(0);
    const capabilitiesProbe = requestsFor(gateway, "capabilities");
    expect(capabilitiesProbe[0]?.body.args.node).toBeUndefined();
    expect(requestsFor(gateway, "project.list")[0]?.body.args.node).toBe(LEAF);
    expect(JSON.parse(run.out).result.items[0].id).toBe("p1");
  });

  test("a backend without node routing is refused before anything is routed", async () => {
    const { box, gateway } = await fixture(() => undefined, { nodeRouting: false });
    const run = await box.run(["--node", LEAF, "project", "list", "--json"]);
    expect(run.code).toBe(8);
    expect(JSON.parse(run.out).error.code).toBe("backend-incompatible");
    expect(requestsFor(gateway, "project.list")).toHaveLength(0);
  });

  test("the backend's node codes keep their exit classes", async () => {
    const { box } = await fixture((request) =>
      request.body.args.action === "project.list"
        ? envelope(
            publicErrorEnvelope("project.list", {
              code: "node-unavailable",
              message: "Studio is not connected",
            }),
          )
        : undefined,
    );
    const run = await box.run(["--node", LEAF, "project", "list", "--json"]);
    expect(run.code).toBe(4);
    expect(JSON.parse(run.out).error.code).toBe("node-unavailable");
  });

  test("--node all is for the aggregate reads; mutations name one node", async () => {
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "environment.list"
        ? envelope(
            publicSuccessEnvelope("environment.list", {
              items: [
                {
                  id: "env-1",
                  name: "auth",
                  environmentType: "local",
                  status: "running",
                  ready: true,
                  nodeId: LEAF,
                  nodeName: "Studio",
                },
              ],
              total: 1,
              nodes: [],
            }),
          )
        : undefined,
    );
    const listed = await box.run(["--node", "all", "environment", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("NODE");
    expect(listed.out).toContain("Studio");
    expect(requestsFor(gateway, "environment.list")[0]?.body.args.node).toBe("all");
    const mutation = await box.run(["--node", "all", "pr", "create", "env-1", "--json"]);
    expect(mutation.code).toBe(2);
    expect(requestsFor(gateway, "pr.create")).toHaveLength(0);
  });

  test("node list always runs on the connected node", async () => {
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "node.list"
        ? envelope(
            publicSuccessEnvelope("node.list", {
              items: [
                {
                  nodeId: "install-a",
                  name: "Desk",
                  self: true,
                  enabled: true,
                  available: true,
                  state: "self",
                  mode: "command",
                  version: "9",
                  publicActions: true,
                },
                {
                  nodeId: LEAF,
                  name: "Studio",
                  self: false,
                  enabled: true,
                  available: true,
                  state: "connected",
                  mode: "leaf",
                  version: "9",
                  publicActions: true,
                },
              ],
              total: 2,
              mode: "command",
              controlledBy: [],
            }),
          )
        : undefined,
    );
    const run = await box.run(["node", "list", "--output", "id"]);
    expect(run.code).toBe(0);
    expect(run.out.trim().split("\n")).toEqual(["install-a", LEAF]);
    expect(requestsFor(gateway, "node.list")[0]?.body.args.node).toBeUndefined();
    const refused = await box.run(["--node", LEAF, "node", "list", "--json"]);
    expect(refused.code).toBe(2);
  });
});

describe("review and pr commands", () => {
  test("review launch sends the reviewer rows and auto-actions", async () => {
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "review.launch"
        ? envelope(
            publicSuccessEnvelope(
              "review.launch",
              { workflowId: "review-1", phase: "reviewing", reused: false },
              receipt("review.launch"),
            ),
          )
        : undefined,
    );
    const run = await box.run([
      "review",
      "launch",
      "env-1",
      "--reviewer",
      "codex=gpt-5.5@high",
      "--reviewer",
      "claude=opus",
      "--auto-fix",
      "--no-auto-pr",
      "--output",
      "id",
    ]);
    expect(run.code).toBe(0);
    expect(run.out.trim()).toBe("review-1");
    expect(requestsFor(gateway, "review.launch")[0]?.body.args.input).toEqual({
      environmentId: "env-1",
      reviewers: [
        { agent: "codex", model: "gpt-5.5", reasoningEffort: "high" },
        { agent: "claude", model: "opus" },
      ],
      autoFix: true,
      autoPr: false,
    });
    const bad = await box.run(["review", "launch", "env-1", "--reviewer", "gpt-5.5", "--json"]);
    expect(bad.code).toBe(2);
  });

  test("review launch sends each reviewer's focus from --focus and --focus-file", async () => {
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "review.launch"
        ? envelope(
            publicSuccessEnvelope(
              "review.launch",
              { workflowId: "review-1", phase: "reviewing", reused: false },
              receipt("review.launch"),
            ),
          )
        : undefined,
    );
    const focusFile = path.join(box.root, "security.md");
    await writeFile(focusFile, "Security\n\nTrace untrusted input to its sinks.\nCheck auth.\n");
    const run = await box.run([
      "review",
      "launch",
      "env-1",
      "--reviewer",
      "codex=gpt-5.5@high",
      "--reviewer",
      "claude=opus",
      "--reviewer",
      "pi=default",
      "--focus-file",
      `1=${focusFile}`,
      "--focus",
      "3=Migrations",
      "--json",
    ]);
    expect(run.code).toBe(0);
    expect(requestsFor(gateway, "review.launch")[0]?.body.args.input).toEqual({
      environmentId: "env-1",
      reviewers: [
        {
          agent: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
          lens: {
            label: "Security",
            instruction: "Trace untrusted input to its sinks.\nCheck auth.",
          },
        },
        { agent: "claude", model: "opus" },
        { agent: "pi", model: "default", lens: { label: "Migrations", instruction: "Migrations" } },
      ],
    });
    // The receipt the CLI prints is the backend's: IDs and states, no focus text.
    expect(run.out).not.toContain("Trace untrusted input");

    for (const argv of [
      ["--focus", "1=Security"],
      ["--reviewer", "claude=opus", "--focus", "2=Security"],
      ["--reviewer", "claude=opus", "--focus", "Security"],
      ["--reviewer", "claude=opus", "--focus", `1=${"x".repeat(65)}`],
      ["--reviewer", "claude=opus", "--focus", "1=A", "--focus", "1=B"],
    ]) {
      const bad = await box.run(["review", "launch", "env-1", ...argv, "--json"]);
      expect(bad.code).toBe(2);
    }
    expect(requestsFor(gateway, "review.launch")).toHaveLength(1);
  });

  test("pr create and pr resolve submit runs with a request key", async () => {
    const { box, gateway } = await fixture((request) => {
      const action = request.body.args.action;
      return action === "pr.create" || action === "pr.resolve"
        ? envelope(
            publicSuccessEnvelope(
              action,
              { sessionId: "ses_pr", tabId: "agent-job-pr", runId: "op-1" },
              receipt(action),
            ),
          )
        : undefined;
    });
    const created = await box.run([
      "pr",
      "create",
      "env-1",
      "--target-branch",
      "develop",
      "--request-id",
      "pr-key",
      "--output",
      "id",
    ]);
    expect(created.code).toBe(0);
    expect(created.out.trim()).toBe("ses_pr");
    const sent = requestsFor(gateway, "pr.create")[0]!.body.args;
    expect(sent.input).toEqual({ environmentId: "env-1", targetBranch: "develop" });
    expect((sent.request as { requestId: string }).requestId).toBe("pr-key");
    const resolved = await box.run(["--node", LEAF, "pr", "resolve", "env-1", "--json"]);
    expect(resolved.code).toBe(0);
    expect(requestsFor(gateway, "pr.resolve")[0]?.body.args.node).toBe(LEAF);
  });

  test("review start and pr push submit runs; the backend builds their prompts", async () => {
    const { box, gateway } = await fixture((request) => {
      const action = request.body.args.action;
      return action === "review.start" || action === "pr.push"
        ? envelope(
            publicSuccessEnvelope(
              action,
              { sessionId: "ses_button", tabId: "agent-job-button", runId: "op-1" },
              receipt(action),
            ),
          )
        : undefined;
    });
    const review = await box.run([
      "review",
      "start",
      "env-1",
      "--target-branch",
      "develop",
      "--output",
      "id",
    ]);
    expect(review.code).toBe(0);
    expect(review.out.trim()).toBe("ses_button");
    // Only the selection crosses: no prompt is built or sent by the client.
    expect(requestsFor(gateway, "review.start")[0]!.body.args.input).toEqual({
      environmentId: "env-1",
      targetBranch: "develop",
    });
    const push = await box.run(["pr", "push", "env-1", "--agent", "codex", "--json"]);
    expect(push.code).toBe(0);
    expect(requestsFor(gateway, "pr.push")[0]!.body.args.input).toEqual({
      environmentId: "env-1",
      agent: "codex",
    });
    // Push has no target branch to choose.
    const bad = await box.run(["pr", "push", "env-1", "--target-branch", "main", "--json"]);
    expect(bad.code).toBe(2);
    expect(requestsFor(gateway, "pr.push")).toHaveLength(1);
  });
});

describe("node receipts and partial reads", () => {
  test("receipt namespaces and request recovery are scoped to each leaf", async () => {
    const { formatPublicNamespace } = await import("@orkestrator/protocol/public-api");
    const second = "bk_second";
    const namespaces: Record<string, string> = {
      [LEAF]: formatPublicNamespace(1_790_000_000_000, "11111111"),
      [second]: formatPublicNamespace(1_790_000_000_000, "22222222"),
    };
    let rotated = false;
    const { box, gateway } = await fixture((request) => {
      const args = request.body.args;
      const node = args.node as string;
      if (args.action === "capabilities" && namespaces[node]) {
        const own = capabilities();
        return envelope(
          publicSuccessEnvelope("capabilities", {
            ...own,
            requestKeys: {
              ...own.requestKeys,
              currentNamespace: rotated
                ? formatPublicNamespace(1_790_000_000_001, "33333333")
                : namespaces[node],
            },
          }),
        );
      }
      if (args.action === "pr.create" || args.action === "run.get") {
        return envelope({
          ...publicSuccessEnvelope(
            String(args.action),
            {},
            { ...receipt("pr.create"), namespace: namespaces[node]!, requestId: "shared" },
          ),
          node: { nodeId: node, name: node },
        });
      }
      return undefined;
    });
    for (const [node, environment] of [
      [LEAF, "env-a"],
      [second, "env-b"],
    ]) {
      const run = await box.run([
        "--node",
        node!,
        "pr",
        "create",
        environment!,
        "--request-id",
        "shared",
        "--json",
      ]);
      expect(run.code).toBe(0);
      expect(JSON.parse(run.out).node.nodeId).toBe(node);
    }
    expect(
      requestsFor(gateway, "pr.create").map(
        (request) => (request.body.args.request as { namespace: string }).namespace,
      ),
    ).toEqual([namespaces[LEAF], namespaces[second]]);
    const saved = await box.run(["run", "receipts", "--json"]);
    expect(
      JSON.parse(saved.out)
        .result.items.map((item: { node: string }) => item.node)
        .sort(),
    ).toEqual([LEAF, second].sort());
    const humanSaved = await box.run(["run", "receipts"]);
    expect(humanSaved.out).toContain(LEAF);
    expect(humanSaved.out).toContain(second);
    rotated = true;
    const recovered = await box.run([
      "--node",
      second,
      "run",
      "get",
      "--request-id",
      "shared",
      "--action",
      "pr.create",
      "--json",
    ]);
    expect(recovered.code).toBe(0);
    expect(requestsFor(gateway, "run.get").at(-1)?.body.args).toMatchObject({
      node: second,
      input: { namespace: namespaces[second] },
    });
    const hint = await box.run(["--node", LEAF, "run", "get", "op-saved"]);
    expect(hint.err).toContain(`--node ${LEAF}`);
  });

  test("a lost leaf response prints recovery on that leaf and --wait recovers there", async () => {
    let lose = true;
    const { box, gateway } = await fixture((request) => {
      if (request.body.args.action === "pr.create") {
        if (lose) return new Response("response lost", { status: 200 });
        return envelope(publicSuccessEnvelope("pr.create", {}, receipt("pr.create")));
      }
      if (request.body.args.action === "run.get")
        return envelope(
          publicSuccessEnvelope("run.get", {}, { ...receipt("pr.create"), state: "succeeded" }),
        );
      return undefined;
    });
    const lost = await box.run([
      "--node",
      LEAF,
      "pr",
      "create",
      "env-1",
      "--request-id",
      "lost-key",
      "--json",
    ]);
    expect(JSON.parse(lost.out)).toMatchObject({
      node: { nodeId: LEAF },
      error: {
        code: "transport-uncertain",
        details: { recovery: expect.stringContaining(`--node ${LEAF}`) },
      },
    });
    const human = await box.run([
      "--node",
      LEAF,
      "pr",
      "create",
      "env-1",
      "--request-id",
      "lost-human",
    ]);
    expect(human.err).toContain(`--node ${LEAF}`);
    const waited = await box.run([
      "--node",
      LEAF,
      "pr",
      "create",
      "env-1",
      "--request-id",
      "lost-wait",
      "--wait",
      "--timeout",
      "1s",
      "--json",
    ]);
    expect(waited.code).toBe(0);
    expect(JSON.parse(waited.out).node.nodeId).toBe(LEAF);
    expect(
      requestsFor(gateway, "run.get").every((request) => request.body.args.node === LEAF),
    ).toBe(true);
    lose = false;
    const success = await box.run([
      "--node",
      LEAF,
      "pr",
      "create",
      "env-1",
      "--request-id",
      "received",
    ]);
    expect(success.err).toContain(`--node ${LEAF}`);
  });

  test("aggregate warnings survive human and JSON reads, including empty attention", async () => {
    const { box } = await fixture((request) => {
      const action = request.body.args.action;
      if (!["project.list", "environment.list", "attention.list"].includes(String(action)))
        return undefined;
      return envelope(
        publicSuccessEnvelope(
          String(action),
          {
            items: [],
            total: 0,
            more: 0,
            counts: { interactions: 0, runs: 0, setups: 0 },
            nodes: [
              {
                nodeId: LEAF,
                name: "Studio",
                ok: false,
                error: { code: "node-unavailable", message: "Studio was not checked" },
              },
            ],
          },
          undefined,
          ["Studio was not checked"],
        ),
      );
    });
    for (const command of [["project", "list"], ["environment", "list"], ["attention"]]) {
      const human = await box.run(["--node", "all", ...command]);
      expect(human.code).toBe(0);
      expect(human.err).toContain("warning:");
      expect(human.err).toContain("Studio was not checked");
      const json = await box.run(["--node", "all", ...command, "--json"]);
      expect(JSON.parse(json.out).warnings).toContain("Studio was not checked");
      expect(JSON.parse(json.out).result.nodes[0].error.code).toBe("node-unavailable");
    }
  });

  test("each aggregate attention line identifies its node even with duplicate names", async () => {
    const { box } = await fixture((request) =>
      request.body.args.action === "attention.list"
        ? envelope(
            publicSuccessEnvelope("attention.list", {
              items: [
                {
                  kind: "setup",
                  phase: "ready",
                  environmentName: "auth",
                  environmentId: "env-1",
                  nodeId: LEAF,
                  nodeName: "Studio",
                },
                {
                  kind: "setup",
                  phase: "failed",
                  environmentName: "auth",
                  environmentId: "env-1",
                  nodeId: "bk_desk",
                  nodeName: "Desk",
                },
              ],
              more: 0,
              counts: { interactions: 0, runs: 0, setups: 2 },
              nodes: [],
            }),
          )
        : undefined,
    );
    const run = await box.run(["--node", "all", "attention"]);
    expect(run.code).toBe(0);
    expect(run.out.split("\n").filter((line) => line.includes("auth"))).toEqual([
      expect.stringContaining(`Studio --node ${LEAF}`),
      expect.stringContaining("Desk --node bk_desk"),
    ]);
  });
});

test("a lost response on the node hop preserves recovery and --wait queries that leaf", async () => {
  const { box, gateway } = await fixture((request) => {
    if (request.body.args.action === "pr.create")
      return envelope({
        ...publicErrorEnvelope("pr.create", {
          code: "node-outcome-unknown",
          message: "Leaf committed but its response was lost",
          retryable: true,
          details: { nodeId: LEAF },
        }),
        node: { nodeId: LEAF, name: "Studio" },
      });
    if (request.body.args.action === "run.get")
      return envelope(
        publicSuccessEnvelope("run.get", {}, { ...receipt("pr.create"), state: "succeeded" }),
      );
    return undefined;
  });
  const unknown = await box.run([
    "--node",
    LEAF,
    "pr",
    "create",
    "env-1",
    "--request-id",
    "hop-lost",
    "--json",
  ]);
  expect(JSON.parse(unknown.out)).toMatchObject({
    node: { nodeId: LEAF },
    error: {
      code: "node-outcome-unknown",
      details: {
        recovery: expect.stringContaining(`--node ${LEAF}`),
        namespace: expect.any(String),
      },
    },
  });
  const waited = await box.run([
    "--node",
    LEAF,
    "pr",
    "create",
    "env-1",
    "--request-id",
    "hop-wait",
    "--wait",
    "--timeout",
    "1s",
    "--json",
  ]);
  expect(waited.code).toBe(0);
  expect(requestsFor(gateway, "pr.create")).toHaveLength(2);
  expect(requestsFor(gateway, "run.get")[0]?.body.args).toMatchObject({
    node: LEAF,
    input: { requestId: "hop-wait", action: "pr.create" },
  });
});
