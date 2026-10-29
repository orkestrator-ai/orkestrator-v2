/**
 * System nodes in the graph runtime (items 202, 203, 207): a run of push →
 * open pull request → notify driven by real scheduler passes, including a
 * backend restart in the middle, never repeats a side effect.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { graphPullRequestStateType } from "@orkestrator/protocol/graphs/system-actions";
import { GraphNodeSystemExecutor } from "./graph-node-system.js";
import { GraphRunService } from "./graph-run-service.js";
import {
  compiled,
  SYSTEM_BRANCH,
  systemWorld,
  type SystemWorld,
} from "./graph-system-test-support.js";
import { ManualTime } from "./recurring-test-support.js";

const worlds: SystemWorld[] = [];
const services: GraphRunService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const world of worlds.splice(0)) await world.cleanup();
});

function shipTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "ship",
    revision: 1,
    name: "Ship",
    parameters: [],
    roles: [],
    types: [graphPullRequestStateType()],
    inputs: [
      { name: "code", type: "workspace@1" },
      { name: "description", type: "pr-description@1" },
    ],
    outputs: [{ name: "pr", type: "pr-result@1", from: { node: "pr", port: "pr" } }],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "push",
        kind: "system",
        action: "push-branch",
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "code", type: "workspace@1" }],
      },
      {
        id: "pr",
        kind: "system",
        action: "open-pull-request",
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "description", type: "pr-description@1" },
        ],
        outputs: [
          { name: "pr", type: "pr-result@1" },
          { name: "state", type: "pull-request-state@1" },
        ],
      },
      {
        id: "notify",
        kind: "system",
        action: "notify",
        params: { to: "coordinator", message: "The run is shipping." },
      },
    ],
    edges: [
      { id: "code-push", from: { input: "code" }, to: { node: "push", port: "code" } },
      { id: "push-pr", from: { node: "push", port: "code" }, to: { node: "pr", port: "code" } },
      {
        id: "description-pr",
        from: { input: "description" },
        to: { node: "pr", port: "description" },
      },
    ],
    limits: { maxAgentSessions: 1, maxConcurrentAgents: 1 },
  };
}

describe("system nodes in a run", () => {
  test("a run pushes, opens the pull request and mails once, across a restart", async () => {
    const w = await systemWorld();
    worlds.push(w);
    const plan = compiled(shipTemplate());
    const time = new ManualTime(0);
    const service = (owner: string) => {
      const created: GraphRunService = new GraphRunService(w.storage, {
        artifacts: w.artifacts,
        autoAdvance: false,
        schedulerClock: { now: time.now, timers: time.timerFactory },
      });
      created.executors.register(
        new GraphNodeSystemExecutor(
          w.deps({
            owner,
            requestObservation: (runId, key) => created.requestObservation(runId, key),
          }),
        ),
      );
      services.push(created);
      return created;
    };

    const first = service("process-1");
    await first.init();
    const run = await first.create({
      projectId: "p1",
      environmentId: "e1",
      template: {
        id: plan.template.id,
        revision: plan.template.revision,
        digest: plan.templateDigest,
      },
      plan,
      roles: {},
      inputs: {
        code: { branch: SYSTEM_BRANCH, headRef: w.head, baseRef: null },
        description: { title: "Add CSV export", body: "Exports reports as CSV." },
      },
    });
    // One pass: push and notify run (no dependency between them); the pull request waits on the push.
    await first.advanceNow(run.id);
    expect(w.shell.pushes).toHaveLength(1);
    await first.shutdown();

    // A restarted backend picks the run up where the record says.
    const second = service("process-2");
    await second.init();
    let current = await second.advanceNow(run.id);
    for (let pass = 0; pass < 6 && current?.status !== "complete"; pass++) {
      time.jump(3_000);
      current = await second.advanceNow(run.id);
    }
    expect(current?.status).toBe("complete");
    expect(w.shell.pushes).toHaveLength(1);
    expect(w.shell.creates).toHaveLength(1);
    expect(w.mail.delivered.size).toBe(1);
    const pr = current!.activations.find((activation) => activation.nodeId === "pr")!;
    expect(pr.state).toBe("complete");
    expect(Object.keys(pr.outputs).sort()).toEqual(["pr", "state"]);
  });
});
