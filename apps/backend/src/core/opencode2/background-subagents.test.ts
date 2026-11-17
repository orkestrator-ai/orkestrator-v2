import { afterEach, describe, expect, test } from "bun:test";
import { readProviderStatus } from "../agent-provider-contract.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import { openCode2RequestRun } from "./workflow-results.js";
import type { OpenCode2Message } from "./types.js";

/**
 * OpenCode 2.3.0 runs every sub-agent in the background: the parent's run
 * settles while its child works, and the child's report wakes the parent
 * later (`background-subagents.ts`).
 */
let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
let clock = Date.now();
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

function setup() {
  server = new FakeOpenCode2Server();
  clock = Date.now();
  provider = new OpenCode2Provider(server.client(), {
    monitorEvents: false,
    now: () => clock,
  });
  return { server, provider };
}

/** A parent whose request settled after launching a child that still runs. */
async function launched(requestId = "r-1", answer = "launched it") {
  const { server, provider } = setup();
  const parent = await provider.createSession("build", "p");
  await provider.send(parent, "go", { requestId });
  const child = server.addChildSession(parent);
  server.finishRun(parent, "succeeded", answer);
  return { server, provider, parent, child };
}

describe("background sub-agents", () => {
  test("the environment keeps working while a child runs; the turn and composer are free", async () => {
    const { server, provider, parent, child } = await launched();
    expect(await provider.status(parent)).toBe("idle");
    expect((await provider.activityBatch([parent])).get(parent)).toBe("working");
    expect(await provider.activity(parent)).toBe("working");
    expect(await provider.observeSession(parent)).toEqual({
      status: "idle",
      backgroundWorkLive: true,
    });

    // The child reports; its parent wakes into a run of its own, then settles.
    server.reportChild(child, "completed", "found it");
    expect(await provider.status(parent)).toBe("running");
    server.finishRun(parent, "succeeded", "all done");
    // Within the report grace a report may still be on its way.
    expect((await provider.observeSession(parent)).backgroundWorkLive).toBe(true);
    clock += 10_000;
    expect(await provider.observeSession(parent)).toEqual({ status: "idle" });
    expect((await provider.activityBatch([parent])).get(parent)).toBe("idle");
  });

  test("a workflow keeps supervising until the woken run settles", async () => {
    const { server, provider, parent, child } = await launched();
    expect(await readProviderStatus(provider, parent)).toMatchObject({
      status: "idle",
      backgroundWorkLive: true,
    });
    server.reportChild(child);
    server.finishRun(parent, "succeeded", "done");
    clock += 10_000;
    expect((await readProviderStatus(provider, parent)).backgroundWorkLive).toBeUndefined();
  });

  test("a structured result is the run the report wakes, not the launch", async () => {
    const { server, provider } = setup();
    const parent = await provider.createSession("plan", "p");
    await provider.send(parent, "plan", { requestId: "s-1", schema: { type: "object" } });
    const child = server.addChildSession(parent);
    server.finishRun(parent, "succeeded", "I launched a sub-agent");
    expect(await provider.structured(parent, "s-1")).toBeNull();
    server.reportChild(child, "completed", "facts");
    expect(await provider.structured(parent, "s-1")).toBeNull();
    server.finishRun(parent, "succeeded", '{"steps":3}');
    clock += 10_000;
    expect(await provider.structured(parent, "s-1")).toMatchObject({
      ok: true,
      value: { steps: 3 },
    });
  });

  test("a stop ends the running children and the run their reports wake", async () => {
    const { server, provider, parent, child } = await launched();
    await provider.abort(parent);
    expect(server.interrupts).toContain(child);
    expect(server.sessions.get(child)!.running).toBe(false);
    // The cancelled report woke the parent; the stop interrupted that run too.
    expect(server.sessions.get(parent)!.running).toBe(false);
    expect(server.interrupts.filter((id) => id === parent).length).toBeGreaterThanOrEqual(2);
    const outcomes = server.sessions
      .get(parent)!
      .rows.filter((row) => row.type === "idle")
      .map((row) => row.outcome);
    expect(outcomes.at(-1)).toBe("interrupted");
  });

  test("a stop with no running child interrupts only the session", async () => {
    const { server, provider } = setup();
    const parent = await provider.createSession("build", "p");
    await provider.send(parent, "go", { requestId: "r-1" });
    server.addChildSession(parent, { running: false });
    await provider.abort(parent);
    expect(server.interrupts).toEqual([parent]);
  });

  test("a child a restarted server never resumed stops counting once its grace passes", async () => {
    const { server, provider, parent, child } = await launched();
    server.sessions.get(child)!.running = false;
    expect(await provider.activity(parent)).toBe("idle");
    expect(await provider.observeSession(parent)).toEqual({ status: "idle" });
  });
});

describe("openCode2RequestRun", () => {
  const row = (id: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ id, type, time: { created: 1 }, ...extra }) as unknown as OpenCode2Message;
  const report = (id: string) =>
    row(id, "synthetic", {
      metadata: { source: "subagent", childID: "ses_c", state: "completed" },
      text: '<subagent sessionID="ses_c" state="completed">\nok\n</subagent>',
    });
  const user = (id: string, requestId: string) =>
    row(id, "user", { text: "x", metadata: { orkestrator: { requestId } } });

  test("follows the runs a sub-agent's report wakes, and stops at the next request", () => {
    const rows = [
      user("u1", "r"),
      row("a1", "assistant", { content: [] }),
      row("i1", "idle", { outcome: "succeeded" }),
      report("s1"),
      row("a2", "assistant", { content: [] }),
      row("i2", "idle", { outcome: "failed" }),
      user("u2", "next"),
      row("a3", "assistant", { content: [] }),
      row("i3", "idle", { outcome: "succeeded" }),
    ];
    const run = openCode2RequestRun(rows, "r")!;
    expect(run.assistants.map((assistant) => assistant.id)).toEqual(["a1", "a2"]);
    expect(run.idle?.id).toBe("i2");
    // A woken run still going leaves the request unsettled.
    expect(openCode2RequestRun(rows.slice(0, 5), "r")?.idle).toBeUndefined();
    // A plain synthetic row after the boundary is not a continuation.
    const shell = row("s2", "synthetic", {
      metadata: { source: "shell" },
      text: "<shell>x</shell>",
    });
    expect(openCode2RequestRun([...rows.slice(0, 3), shell], "r")?.idle?.id).toBe("i1");
  });
});
