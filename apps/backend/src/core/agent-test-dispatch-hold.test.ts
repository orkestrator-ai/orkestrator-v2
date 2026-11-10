/**
 * The test-only prompt dispatch hold (to-do 0050 task 3): off outside an
 * isolated agent-test backend, and inside one it parks a bridge send at the
 * marker's point, writes a content-free record and lets it go once the marker
 * is removed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  agentTestDispatchHold,
  DISPATCH_HOLD_FIXTURE_DIR,
  dispatchHoldMarkerName,
  dispatchHoldRecordName,
  installAgentTestDispatchHold,
  promptDispatchHold,
  type AgentTestDispatchHold,
  type DispatchHoldPoint,
  type DispatchHoldRecord,
} from "./agent-test-dispatch-hold.js";
import { httpProvider, piConnection } from "./agent-provider-test-support.js";

const ISOLATED = { ORKESTRATOR_AGENT_TEST_ISOLATED: "1" } as NodeJS.ProcessEnv;
const directories: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-dispatch-hold-"));
  directories.push(directory);
  return directory;
}

async function arm(root: string, point: DispatchHoldPoint): Promise<string> {
  const directory = path.join(root, DISPATCH_HOLD_FIXTURE_DIR);
  await fs.mkdir(directory, { recursive: true });
  const marker = path.join(directory, dispatchHoldMarkerName(point));
  await fs.writeFile(marker, "");
  return marker;
}

async function readRecord(root: string, point: DispatchHoldPoint) {
  const file = path.join(root, DISPATCH_HOLD_FIXTURE_DIR, dispatchHoldRecordName(point));
  if (!existsSync(file)) return undefined;
  return JSON.parse(await fs.readFile(file, "utf8")) as DispatchHoldRecord;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function hold(root: string, options: { maxHoldMs?: number } = {}): AgentTestDispatchHold {
  const created = agentTestDispatchHold({
    dataDir: root,
    runtimeFlavor: "agent-test",
    env: ISOLATED,
    pollMs: 10,
    ...options,
  });
  if (!created) throw new Error("the hold should exist in an isolated agent-test backend");
  cleanups.push(() => created.dispose());
  return created;
}

describe("agent-test dispatch hold gate", () => {
  test("is off unless the backend is an isolated agent-test profile", async () => {
    const root = await dataDir();
    expect(
      agentTestDispatchHold({ dataDir: root, runtimeFlavor: "production", env: ISOLATED }),
    ).toBeUndefined();
    expect(
      agentTestDispatchHold({ dataDir: root, runtimeFlavor: "development", env: ISOLATED }),
    ).toBeUndefined();
    expect(
      agentTestDispatchHold({ dataDir: root, runtimeFlavor: undefined, env: ISOLATED }),
    ).toBeUndefined();
    expect(
      agentTestDispatchHold({ dataDir: root, runtimeFlavor: "agent-test", env: {} }),
    ).toBeUndefined();
    expect(
      agentTestDispatchHold({ dataDir: root, runtimeFlavor: "agent-test", env: ISOLATED }),
    ).toBeDefined();
  });

  test("is off for the default data directory even with the agent-test switches", async () => {
    const home = await dataDir();
    const env = { ...ISOLATED, XDG_CONFIG_HOME: path.join(home, ".config") };
    const defaultDir =
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "orkestrator-v2")
        : path.join(home, ".config", "orkestrator-v2");
    expect(
      agentTestDispatchHold({ dataDir: defaultDir, runtimeFlavor: "agent-test", env }),
    ).toBeUndefined();
  });

  test("the bridge client seam answers undefined when nothing is installed", () => {
    expect(
      promptDispatchHold("before-send", { agent: "pi", sessionId: "s", requestId: "r" }),
    ).toBeUndefined();
  });
});

describe("agent-test dispatch hold", () => {
  test("resolves at once and touches nothing without a marker", async () => {
    const root = await dataDir();
    await hold(root).hold("before-send", { agent: "pi", sessionId: "s", requestId: "r" });
    expect(existsSync(path.join(root, DISPATCH_HOLD_FIXTURE_DIR))).toBe(false);
  });

  test("parks until the marker is removed and records ids only", async () => {
    const root = await dataDir();
    const marker = await arm(root, "before-send");
    let released = false;
    const held = hold(root)
      .hold("before-send", { agent: "pi", sessionId: "session-1", requestId: "request-1" })
      .then(() => {
        released = true;
      });
    await until(async () => (await readRecord(root, "before-send")) !== undefined);
    const record = (await readRecord(root, "before-send"))!;
    expect(record).toMatchObject({
      point: "before-send",
      agent: "pi",
      sessionId: "session-1",
      requestId: "request-1",
      pid: process.pid,
    });
    expect(record.releasedAt).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(released).toBe(false);
    await fs.rm(marker);
    await held;
    expect(released).toBe(true);
    const after = (await readRecord(root, "before-send"))!;
    expect(after.release).toBe("marker-removed");
    expect(after.releasedAt).toBeDefined();
    expect(Object.keys(after).sort()).toEqual(
      ["agent", "heldAt", "pid", "point", "release", "releasedAt", "requestId", "sessionId"].sort(),
    );
  });

  test("only the armed point holds", async () => {
    const root = await dataDir();
    await arm(root, "after-response");
    await hold(root).hold("before-send", { agent: "pi", sessionId: "s", requestId: "r" });
    expect(await readRecord(root, "before-send")).toBeUndefined();
  });

  test("a forgotten marker is released after the bound", async () => {
    const root = await dataDir();
    await arm(root, "before-send");
    await hold(root, { maxHoldMs: 40 }).hold("before-send", {
      agent: "pi",
      sessionId: "s",
      requestId: "r",
    });
    expect((await readRecord(root, "before-send"))?.release).toBe("max-hold");
  });

  test("dispose stops polling and leaves a held send unsettled", async () => {
    const root = await dataDir();
    const marker = await arm(root, "before-send");
    const created = hold(root);
    let settled = false;
    void created.hold("before-send", { agent: "pi", sessionId: "s", requestId: "r" }).then(() => {
      settled = true;
    });
    await until(async () => (await readRecord(root, "before-send")) !== undefined);
    created.dispose();
    await fs.rm(marker);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    expect((await readRecord(root, "before-send"))?.releasedAt).toBeUndefined();
  });

  test("ids are bounded in the record", async () => {
    const root = await dataDir();
    const marker = await arm(root, "before-send");
    const held = hold(root).hold("before-send", {
      agent: "pi",
      sessionId: "s".repeat(1_000),
      requestId: "r".repeat(1_000),
    });
    await until(async () => (await readRecord(root, "before-send")) !== undefined);
    const record = (await readRecord(root, "before-send"))!;
    expect(record.sessionId.length).toBe(256);
    expect(record.requestId!.length).toBe(256);
    await fs.rm(marker);
    await held;
  });
});

describe("bridge client dispatch hold", () => {
  test("holds a send before the prompt request leaves the backend", async () => {
    const root = await dataDir();
    const marker = await arm(root, "before-send");
    cleanups.push(installAgentTestDispatchHold(hold(root)));
    const { provider, requests } = httpProvider(() => Response.json({ ok: true }), piConnection);
    let sent = false;
    const send = provider
      .send("session-1", "synthetic prompt", { requestId: "request-1" })
      .then(() => {
        sent = true;
      });
    await until(async () => (await readRecord(root, "before-send")) !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests.filter((request) => request.url.endsWith("/prompt"))).toHaveLength(0);
    expect(sent).toBe(false);
    await fs.rm(marker);
    await send;
    expect(requests.filter((request) => request.url.endsWith("/prompt"))).toHaveLength(1);
    expect((await readRecord(root, "before-send"))?.requestId).toBe("request-1");
  });

  test("holds an accepted send before it returns to the caller", async () => {
    const root = await dataDir();
    const marker = await arm(root, "after-response");
    cleanups.push(installAgentTestDispatchHold(hold(root)));
    const { provider, requests } = httpProvider(() => Response.json({ ok: true }), piConnection);
    let sent = false;
    const send = provider
      .send("session-1", "synthetic prompt", { requestId: "request-2" })
      .then(() => {
        sent = true;
      });
    await until(async () => (await readRecord(root, "after-response")) !== undefined);
    expect(requests.filter((request) => request.url.endsWith("/prompt"))).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toBe(false);
    await fs.rm(marker);
    await send;
    expect(sent).toBe(true);
  });

  test("a rejected send is never held after the response", async () => {
    const root = await dataDir();
    await arm(root, "after-response");
    cleanups.push(installAgentTestDispatchHold(hold(root)));
    const { provider } = httpProvider(
      () => Response.json({ error: "busy" }, { status: 409 }),
      piConnection,
    );
    await expect(
      provider.send("session-1", "synthetic prompt", { requestId: "request-3" }),
    ).rejects.toThrow();
    expect(await readRecord(root, "after-response")).toBeUndefined();
  });

  test("uninstalling detaches the hold", async () => {
    const root = await dataDir();
    await arm(root, "before-send");
    const uninstall = installAgentTestDispatchHold(hold(root));
    uninstall();
    expect(
      promptDispatchHold("before-send", { agent: "pi", sessionId: "s", requestId: "r" }),
    ).toBeUndefined();
  });
});
