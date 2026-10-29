import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import { TEST_TICKET, TEST_WORKSPACE, agentTestTemplate } from "./graph-agent-test-support.js";
import { GraphArtifactStore } from "./graph-artifacts.js";
import {
  GraphActivationJournalFenceError,
  type GraphExecutorContext,
  type GraphNodeExecutor,
} from "./graph-run-executors.js";
import { compiledPlan } from "./graph-run-executor-test-support.js";
import { GraphRunService } from "./graph-run-service.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import { StorageService } from "./storage.js";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function world(executor: GraphNodeExecutor) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-journal-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment(graphEnvironmentFixture());
  const artifacts = new GraphArtifactStore({ storage, fence: { beginMutation: () => () => {} } });
  const service = new GraphRunService(storage, { artifacts, autoAdvance: false });
  void service.init();
  service.executors.register(executor);
  cleanup = async () => {
    await service.shutdown();
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  };
  const template = agentTestTemplate();
  const plan = compiledPlan(template);
  const run = await service.create({
    projectId: "p1",
    environmentId: "e1",
    template: { id: template.id, revision: template.revision, digest: plan.templateDigest },
    plan,
    roles: { worker: { platform: "claude", model: "model" } },
    inputs: { ticket: TEST_TICKET, target: TEST_WORKSPACE },
  });
  return { storage, service, run };
}

/** The policy the compiled plan's node carries (a valid execution policy). */
function policyOf(context: GraphExecutorContext) {
  if (context.node.kind !== "agent") throw new Error("agent nodes only");
  return context.node.capabilities.policy;
}

function session(dispatchState: "prepared" | "dispatching" | "sent") {
  return {
    agent: "claude" as const,
    providerSessionId: "session-1",
    requestId: "request-1",
    dispatchState,
    resultTransport: "tool-v1",
  };
}

describe("the executor journal", () => {
  test("journaled facts are durable before the call returns, without moving the state", async () => {
    let stored: GraphRun | null = null;
    let storage: StorageService | undefined;
    const executor: GraphNodeExecutor = {
      kind: "agent",
      async start(context: GraphExecutorContext) {
        const policy = policyOf(context);
        await context.journal({ policy, enforcement: "enforced", session: session("dispatching") });
        stored = await storage!.graphRuns.getGraphRun(context.run.id);
        return { state: "running", policy, enforcement: "enforced", session: session("sent") };
      },
      async observe() {
        return { state: "unchanged" };
      },
      async cancel() {
        return { state: "cancelled" };
      },
    };
    const built = await world(executor);
    storage = built.storage;
    const after = await built.service.advanceNow(built.run.id);
    const journaled = stored!.activations[0]!;
    expect(journaled.state).toBe("admitting");
    expect(journaled.session?.dispatchState).toBe("dispatching");
    expect(journaled.policy).toBeDefined();
    expect(journaled.enforcement).toBe("enforced");
    expect(after?.activations[0]?.state).toBe("running");
    expect(after?.activations[0]?.session?.dispatchState).toBe("sent");
  });

  test("a journal write the record refuses rejects with the fence error", async () => {
    let refused: unknown;
    const executor: GraphNodeExecutor = {
      kind: "agent",
      async start(context: GraphExecutorContext) {
        try {
          // A session without its policy is refused by the record's rules.
          await context.journal({ session: session("dispatching") });
        } catch (error) {
          refused = error;
        }
        return { state: "unchanged" };
      },
      async observe() {
        return { state: "unchanged" };
      },
      async cancel() {
        return { state: "cancelled" };
      },
    };
    const built = await world(executor);
    const after = await built.service.advanceNow(built.run.id);
    expect(refused).toBeInstanceOf(GraphActivationJournalFenceError);
    expect(after?.activations[0]?.session).toBeUndefined();
    expect(after?.activations[0]?.state).toBe("admitting");
  });
});
