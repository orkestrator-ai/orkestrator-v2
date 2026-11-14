import { afterEach, describe, expect, test } from "bun:test";
import { readProviderStatus } from "../agent-provider-contract.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import {
  OPENCODE2_RESTART_CUT_MESSAGE,
  openCode2CutRun,
  openCode2OpenRun,
  openCode2SessionRunUnsettledSince,
} from "./restart-cut.js";
import type { OpenCode2Message } from "./types.js";

const user = (id: string, created: number, requestId?: string): OpenCode2Message =>
  ({
    id,
    type: "user",
    text: id,
    time: { created },
    ...(requestId ? { metadata: { orkestrator: { requestId } } } : {}),
  }) as OpenCode2Message;
const assistant = (id: string): OpenCode2Message =>
  ({ id, type: "assistant", content: [], time: { created: 1 } }) as OpenCode2Message;
const idle = (id: string): OpenCode2Message =>
  ({ id, type: "idle", outcome: "succeeded", time: { created: 1 } }) as OpenCode2Message;

describe("openCode2SessionRunUnsettledSince", () => {
  test("a run busy before the provider began and never idle since", () => {
    expect(openCode2SessionRunUnsettledSince({ time: { busy: 100 } }, 200)).toBe(true);
    expect(openCode2SessionRunUnsettledSince({ time: { busy: 100, idle: 50 } }, 200)).toBe(true);
  });

  test("not a settled run, a run started under this provider, or a session never busy", () => {
    expect(openCode2SessionRunUnsettledSince({ time: { busy: 100, idle: 100 } }, 200)).toBe(false);
    expect(openCode2SessionRunUnsettledSince({ time: { busy: 100, idle: 150 } }, 200)).toBe(false);
    expect(openCode2SessionRunUnsettledSince({ time: { busy: 200 } }, 200)).toBe(false);
    expect(openCode2SessionRunUnsettledSince({ time: { busy: 300, idle: 50 } }, 200)).toBe(false);
    expect(openCode2SessionRunUnsettledSince({ time: {} }, 200)).toBe(false);
    expect(openCode2SessionRunUnsettledSince({}, 200)).toBe(false);
  });
});

describe("openCode2CutRun", () => {
  test("names the open run's first Orkestrator request", () => {
    const rows = [user("u1", 10, "r1"), assistant("a1"), idle("i1"), user("u2", 20, "r2")];
    expect(openCode2OpenRun(rows)?.map((row) => row.id)).toEqual(["u2"]);
    expect(openCode2CutRun([...rows, assistant("a2")], 100)).toEqual({ requestId: "r2" });
    // Input typed in a terminal carries no request id.
    expect(openCode2CutRun([user("u", 10)], 100)).toEqual({});
  });

  test("a settled history, or input admitted since the provider began, is not a cut run", () => {
    expect(openCode2CutRun([user("u1", 10, "r1"), idle("i1")], 100)).toBeUndefined();
    expect(openCode2CutRun([], 100)).toBeUndefined();
    // A continuation this provider sent, before its run marked the session busy.
    expect(
      openCode2CutRun([user("u1", 10, "r1"), assistant("a1"), user("u2", 150, "r2")], 100),
    ).toBeUndefined();
  });
});

let server: FakeOpenCode2Server | undefined;
const providers: OpenCode2Provider[] = [];
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.dispose();
  server?.stop();
  server = undefined;
});

/** A provider for a fresh server generation, as the backend builds after a restart. */
async function generation(fake: FakeOpenCode2Server): Promise<OpenCode2Provider> {
  // `time.busy` and the provider's start are both wall-clock milliseconds.
  await Bun.sleep(2);
  const provider = new OpenCode2Provider(fake.client(), { monitorEvents: false });
  providers.push(provider);
  return provider;
}

describe("a run a server stop cut short (to-do 8045 (retired))", () => {
  test("reads as a restart interruption, settled, so the workflow continues it once", async () => {
    server = new FakeOpenCode2Server();
    const before = await generation(server);
    const id = await before.createSession("build", "cut");
    await before.send(id, "work", { requestId: "req-cut" });
    server.stopMidRun(id);

    const after = await generation(server);
    after.registerSession(id);
    expect(await after.activity(id)).toBe("idle");
    expect(await after.settleTurn(id, "req-cut")).toBe(true);
    const observation = await readProviderStatus(after, id, "req-cut");
    expect(observation).toMatchObject({
      status: "error",
      interruption: "restart",
      interruptedRequestId: "req-cut",
      turnSettled: true,
      error: OPENCODE2_RESTART_CUT_MESSAGE,
    });
    expect(await after.structured(id, "req-cut")).toBeNull();
    // A tab reads the session as idle rather than busy or failed.
    expect((await after.sessionState(id)).status).toBe("idle");

    // The continuation runs on the same session, and the interruption clears.
    await after.send(id, "continue", { requestId: "req-continue" });
    expect(await after.status(id)).toBe("running");
    server.finishRun(id, "succeeded", "done");
    expect(await readProviderStatus(after, id, "req-continue")).toMatchObject({
      status: "idle",
      turnSettled: true,
    });
    expect(await after.settleTurn(id, "req-cut")).toBe(true);
  });

  test("a continuation admitted before its run marked the session busy is not cut", async () => {
    server = new FakeOpenCode2Server();
    const before = await generation(server);
    const id = await before.createSession("build", "race");
    await before.send(id, "work", { requestId: "req-cut" });
    server.stopMidRun(id);
    const after = await generation(server);
    const busy = server.sessions.get(id)!.busy;
    await after.send(id, "continue", { requestId: "req-continue" });
    // The read lands after the input entered the history but before the
    // server listed the new run as active or moved `time.busy`.
    const session = server.sessions.get(id)!;
    session.running = false;
    session.busy = busy;
    expect(await readProviderStatus(after, id, "req-continue")).toMatchObject({
      status: "idle",
      turnSettled: false,
    });
  });

  test("the provider that saw the run start never judges it from a racing read", async () => {
    server = new FakeOpenCode2Server();
    const provider = await generation(server);
    const id = await provider.createSession("build", "same");
    await provider.send(id, "work", { requestId: "req-same" });
    server.stopMidRun(id);
    expect(await provider.status(id)).toBe("idle");
    expect(await provider.settleTurn(id, "req-same")).toBe(false);
  });

  test("a run still listed as active is running, however old", async () => {
    server = new FakeOpenCode2Server();
    const before = await generation(server);
    const id = await before.createSession("build", "alive");
    await before.send(id, "work", { requestId: "req-alive" });
    const after = await generation(server);
    expect(await after.status(id)).toBe("running");
    expect(await after.settleTurn(id, "req-alive")).toBe(false);
  });
});
