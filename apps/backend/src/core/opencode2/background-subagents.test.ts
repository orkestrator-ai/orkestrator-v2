import { afterEach, describe, expect, test } from "bun:test";
import { readProviderStatus } from "../agent-provider-contract.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import { openCode2RequestRun } from "./workflow-results.js";
import type { OpenCode2Message } from "./types.js";

/**
 * OpenCode 2.3.0 runs every sub-agent in the background: the parent's run
 * settles while its child works, and the child's report wakes the parent
 * later. 2.3.1 does the same with a shell command still running when its
 * timeout expires (`background-subagents.ts`).
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

/** A session whose request settled after a shell command moved to the background. */
async function backgrounded(requestId = "r-1", answer = "the tests are still running") {
  const { server, provider } = setup();
  const session = await provider.createSession("build", "p");
  await provider.send(session, "run the tests", { requestId });
  const shell = server.addBackgroundShell(session, "bun test");
  server.finishRun(session, "succeeded", answer);
  return { server, provider, session, shell };
}

describe("background shells (2.3.1)", () => {
  test("a timed-out command keeps the environment working; the composer is free", async () => {
    const { server, provider, session, shell } = await backgrounded();
    expect(await provider.status(session)).toBe("idle");
    expect((await provider.activityBatch([session])).get(session)).toBe("working");
    expect(await provider.observeSession(session)).toEqual({
      status: "idle",
      backgroundWorkLive: true,
    });

    // The command ends; its report wakes the session into a run of its own.
    server.finishBackgroundShell(shell, "completed", "42 pass");
    expect(await provider.status(session)).toBe("running");
    server.finishRun(session, "succeeded", "all tests pass");
    expect(await provider.observeSession(session)).toEqual({ status: "idle" });
    expect((await provider.activityBatch([session])).get(session)).toBe("idle");
  });

  test("the outcome is in the history, so a tab that was away reads it on return", async () => {
    const { server, provider, session, shell } = await backgrounded();
    // Nothing reads the session while the command runs and ends.
    server.finishBackgroundShell(shell, "completed", "42 pass");
    server.finishRun(session, "succeeded", "all tests pass");
    for (const read of [
      async () => JSON.stringify(await provider.interactiveState(session)),
      async () =>
        JSON.stringify(await provider.transcriptSnapshot(session, { limit: 20, targetBytes: 1e6 })),
    ]) {
      const text = await read();
      expect(text).toContain("Background command completed: bun test\\n42 pass");
      expect(text).toContain("all tests pass");
    }
  });

  test("a workflow waits for the run the report wakes and takes its answer", async () => {
    const { server, provider } = setup();
    const session = await provider.createSession("plan", "p");
    await provider.send(session, "plan", { requestId: "s-1", schema: { type: "object" } });
    const shell = server.addBackgroundShell(session);
    server.finishRun(session, "succeeded", "waiting for the build");
    expect(await readProviderStatus(provider, session)).toMatchObject({
      status: "idle",
      backgroundWorkLive: true,
    });
    expect(await provider.structured(session, "s-1")).toBeNull();
    expect(await provider.settleTurn(session, "s-1")).toBe(false);
    server.finishBackgroundShell(shell);
    expect(await provider.structured(session, "s-1")).toBeNull();
    server.finishRun(session, "succeeded", '{"built":true}');
    expect(await provider.structured(session, "s-1")).toMatchObject({
      ok: true,
      value: { built: true },
    });
    expect(await provider.settleTurn(session, "s-1")).toBe(true);
  });

  test("a report still on its way counts until its grace passes", async () => {
    const { server, provider, session, shell } = await backgrounded();
    const job = server.backgroundShells.find((entry) => entry.shellID === shell)!;
    job.status = "completed";
    job.time.completed = clock;
    expect(await provider.observeSession(session)).toMatchObject({ backgroundWorkLive: true });
    expect((await provider.activityBatch([session])).get(session)).toBe("working");
    // A settled job left listed (its report never admitted) is not waited on forever.
    clock += 10_000;
    expect(await provider.observeSession(session)).toEqual({ status: "idle" });
    expect((await provider.activityBatch([session])).get(session)).toBe("idle");
  });

  test("a report waiting in the inbox is still owed", async () => {
    const { server, provider, session, shell } = await backgrounded();
    server.backgroundShells.length = 0;
    server.sessions.get(session)!.inbox.push({
      id: "report-inbox",
      type: "synthetic",
      payload: {
        text: `<shell id="${shell}" state="completed" command="bun test">\nok\n</shell>`,
        metadata: { source: "shell", shellID: shell, jobID: shell, state: "completed" },
      },
    });
    expect(await provider.observeSession(session)).toMatchObject({ backgroundWorkLive: true });
  });

  test("a sub-agent's background shell keeps its parent working", async () => {
    const { server, provider, parent, child } = await launched();
    server.sessions.get(child)!.running = false;
    server.sessions.get(child)!.busy = { busy: clock - 60_000, idle: clock - 60_000 };
    clock += 60_000;
    expect(await provider.observeSession(parent)).toEqual({ status: "idle" });
    server.addBackgroundShell(child, "bun run build");
    expect((await provider.activityBatch([parent])).get(parent)).toBe("working");
    expect(await provider.observeSession(parent)).toMatchObject({ backgroundWorkLive: true });
  });

  test("a stop terminates the command and the run its report wakes", async () => {
    const { server, provider, session, shell } = await backgrounded();
    await provider.abort(session);
    expect(server.shellRemovals).toEqual([shell]);
    expect(server.backgroundShells).toEqual([]);
    // The terminated command's report woke the session; the stop interrupted that run.
    expect(server.sessions.get(session)!.running).toBe(false);
    const outcomes = server.sessions
      .get(session)!
      .rows.filter((row) => row.type === "idle")
      .map((row) => row.outcome);
    expect(outcomes.at(-1)).toBe("interrupted");
    expect((await provider.activityBatch([session])).get(session)).toBe("idle");
  });

  test("a stop terminates a sub-agent's background shell too", async () => {
    const { server, provider, parent, child } = await launched();
    const shell = server.addBackgroundShell(child);
    await provider.abort(parent);
    expect(server.shellRemovals).toEqual([shell]);
    expect(server.sessions.get(child)!.running).toBe(false);
  });

  test("an unreadable job list keeps observation pending but not activity", async () => {
    const { server, provider, session } = await backgrounded();
    const client = server.client();
    const { OpenCode2BackgroundWork } = await import("./background-subagents.js");
    client.listBackgroundJobs = async () => {
      throw new Error("offline");
    };
    const work = new OpenCode2BackgroundWork(client, {
      running: async () => new Set(),
      now: () => clock,
    });
    expect(await work.live(session)).toBe(true);
    await expect(work.shellOwners()).rejects.toThrow("offline");
    // The provider's activity read degrades to the session's own run.
    server.backgroundShells.length = 0;
    expect((await provider.activityBatch([session])).get(session)).toBe("idle");
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

  test("follows the run a background shell's report wakes (2.3.1)", () => {
    const shellReport = row("s1", "synthetic", {
      description: "bun test",
      metadata: { source: "shell", shellID: "shl_1", jobID: "shl_1", state: "completed" },
      text: '<shell id="shl_1" state="completed" command="bun test">\nok\n</shell>',
    });
    const rows = [
      user("u1", "r"),
      row("a1", "assistant", { content: [] }),
      row("i1", "idle", { outcome: "succeeded" }),
      shellReport,
      row("a2", "assistant", { content: [] }),
      row("i2", "idle", { outcome: "succeeded" }),
    ];
    const run = openCode2RequestRun(rows, "r")!;
    expect(run.assistants.map((assistant) => assistant.id)).toEqual(["a1", "a2"]);
    expect(run.idle?.id).toBe("i2");
    expect(openCode2RequestRun(rows.slice(0, 4), "r")?.idle).toBeUndefined();
  });
});

// Use the real client with deterministic lifecycle reads; no wall-clock races.
describe("background work read failures and stop races", () => {
  test("unreadable activity, child lists and inboxes remain pending", async () => {
    const { server, parent } = await launched();
    const client = server.client();
    const { OpenCode2BackgroundWork } = await import("./background-subagents.js");
    const work = new OpenCode2BackgroundWork(client, {
      running: async () => {
        throw new Error("offline");
      },
      now: () => clock,
    });
    expect(await work.live(parent)).toBe(true);
    const work2 = new OpenCode2BackgroundWork(client, {
      running: async () => new Set(),
      now: () => clock,
    });
    client.listInbox = async () => {
      throw new Error("offline");
    };
    expect(await work2.live(parent)).toBe(true);
    client.listInbox = async () => [];
    client.listChildSessions = async () => {
      throw new Error("offline");
    };
    expect(await work2.live(parent)).toBe(true);
  });

  test("a failed inbox read keeps observation pending and suppresses the launch result", async () => {
    server = new FakeOpenCode2Server();
    const client = server.client();
    provider = new OpenCode2Provider(client, { monitorEvents: false, now: () => clock });
    const parent = await provider.createSession("plan", "p");
    await provider.send(parent, "plan", { requestId: "read-failure", schema: { type: "object" } });
    const child = server.addChildSession(parent, { running: false });
    server.finishRun(parent, "succeeded", '{"launch":true}');
    const readInbox = client.listInbox.bind(client);
    client.listInbox = async () => {
      throw new Error("transient inbox failure");
    };
    expect(await provider.observeSession(parent)).toMatchObject({ backgroundWorkLive: true });
    expect(await provider.structured(parent, "read-failure")).toBeNull();
    client.listInbox = readInbox;
    server.reportChild(child);
    server.finishRun(parent, "succeeded", '{"done":true}');
    clock += 20_000;
    expect(await provider.structured(parent, "read-failure")).toMatchObject({
      ok: true,
      value: { done: true },
    });
  });

  for (const kind of ["late-child", "late-report", "inbox", "new-prompt"] as const) {
    test(`stop handles ${kind}`, async () => {
      const { server, parent, child } = await launched();
      const client = server.client();
      const { OpenCode2BackgroundWork } = await import("./background-subagents.js");
      server.sessions.get(child)!.running = kind === "new-prompt";
      if (kind === "inbox") {
        server.sessions.get(parent)!.inbox.push({
          id: "report-inbox",
          type: "synthetic",
          payload: {
            text: '<subagent sessionID="' + child + '" state="completed">done</subagent>',
            metadata: { source: "subagent", childID: child, state: "completed" },
          },
        });
      }
      let polls = 0;
      const work = new OpenCode2BackgroundWork(client, {
        now: () => clock,
        running: async () =>
          new Set([...server.sessions.values()].filter((s) => s.running).map((s) => s.id)),
        sleep: async (ms) => {
          clock += ms;
          if (++polls !== 3) return;
          if (kind === "late-child") server.sessions.get(child)!.running = true;
          else if (kind === "new-prompt") {
            await provider!.send(parent, "next", { requestId: "next" });
          } else {
            server.sessions.get(parent)!.inbox.length = 0;
            server.reportChild(child);
          }
        },
      });
      await work.stop(parent);
      expect(server.sessions.get(child)!.running).toBe(false);
      expect(server.sessions.get(parent)!.running).toBe(kind === "new-prompt");
    });
  }
});
