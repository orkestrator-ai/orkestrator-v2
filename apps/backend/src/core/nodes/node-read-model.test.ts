import { expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { NodeReadModel } from "./node-read-model.js";

function harness() {
  let now = 0;
  let failed = false;
  let name = "before";
  const events: string[] = [];
  const model = new NodeReadModel({
    now: () => now,
    nodes: {
      selfIdentity: async () => "bk_command" as BackendId,
      selfProfile: async () => ({ displayName: "Command" }),
      listNodes: async () => ({ nodes: [] }) as never,
      link: () => null,
      subscribe: () => () => undefined,
      recordProfile: async () => undefined,
    },
    emit: (event) => {
      events.push(event);
    },
    local: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        if (command === "get_projects")
          return [
            { id: "p1", name: "One" },
            { id: "p2", name: "Two" },
          ] as T;
        if (failed && args?.projectId === "p2") throw new Error("snapshot temporarily unreadable");
        return [
          { id: `${args?.projectId}-env`, projectId: args?.projectId, name, status: "running" },
        ] as T;
      },
    },
  });
  return {
    model,
    events,
    advance: () => {
      now += 11 * 60_000;
      name = "after sleep";
    },
    fail: (value: boolean) => {
      failed = value;
    },
  };
}

test("self-summary invalidations survive ten minutes idle and reconcile after sleep", async () => {
  const h = harness();
  try {
    await h.model.summaries(undefined, { includeSelf: true });
    h.advance();
    h.model.noteLocalEvent("resource-changed", { resource: "environment" });
    await Bun.sleep(80);
    expect(h.events).toContain("node-summary-changed");
    const self = (await h.model.summaries(undefined, { includeSelf: true })).self!;
    expect(self.environments.map((row) => row.name)).toEqual(["after sleep", "after sleep"]);
  } finally {
    h.model.stop();
  }
});

test("partial self snapshot failure retains last known environments, marks truncation and retries", async () => {
  const h = harness();
  try {
    await h.model.summaries(undefined, { includeSelf: true });
    h.advance();
    h.fail(true);
    h.model.noteLocalEvent("resource-changed", { resource: "environment" });
    const partial = (await h.model.summaries(undefined, { includeSelf: true })).self!;
    expect(partial.environments.map((row) => row.name)).toEqual(["after sleep", "before"]);
    expect(partial.truncated).toBe(true);
    h.fail(false);
    const recovered = (await h.model.summaries(undefined, { includeSelf: true })).self!;
    expect(recovered.environments.map((row) => row.name)).toEqual(["after sleep", "after sleep"]);
    expect(recovered.truncated).toBe(false);
  } finally {
    h.model.stop();
  }
});
