import { afterEach, describe, expect, test } from "bun:test";
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
});
