import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { readProviderStatus } from "../agent-provider-contract.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";
import { OPENCODE2_FLAGS } from "./server.js";

/**
 * Timed-out shell commands (OpenCode 2.3.1, anomalyco/opencode#63699) against
 * a real pinned 2.x server started with Orkestrator's own `OPENCODE_FLAGS`
 * and a scripted local model. A foreground command still running when its
 * timeout expires moves to the background instead of being killed: the run
 * settles, the command finishes on its own, and its report wakes the session
 * (`background-subagents.ts`). Run with RUN_LIVE_OPENCODE2=1 and
 * OPENCODE2_CLI_PATH set to the 2.x binary.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
let provider: OpenCode2Provider | undefined;
let client: OpenCode2Client | undefined;

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!, { env: { OPENCODE_FLAGS: OPENCODE2_FLAGS } });
  client = new OpenCode2Client({
    baseUrl: fixture.baseUrl,
    password: fixture.password,
    directory: fixture.directory,
  });
  provider = new OpenCode2Provider(client);
}, 60_000);

afterAll(async () => {
  await provider?.dispose();
  await fixture?.stop();
});

async function until(read: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await read())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(150);
  }
}

/** A shell call whose one-second timeout expires long before the command ends. */
const timedOut = (command: string) =>
  `RUN_TOOL:shell ${JSON.stringify({ command, description: "slow command", timeout: 1_000 })}`;

async function rows(id: string) {
  return (await client!.listMessages(id, { limit: 100, order: "asc" })).messages;
}

async function idleRows(id: string): Promise<number> {
  return (await rows(id)).filter((row) => row.type === "idle").length;
}

liveTest(
  "a timed-out command finishes while nobody reads the session, and its outcome is there on return",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    const command = "sleep 5; echo LIVE-SHELL-DONE";
    await p.send(id, timedOut(command), { requestId: "shell-1" });

    // The run settles once the timeout moved the command to the background.
    await until(async () => (await idleRows(id)) === 1);
    const call = (await rows(id))
      .flatMap((row) => {
        const content = (row as { content?: unknown }).content;
        return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
      })
      .find((part) => part.type === "tool") as
      { state?: { metadata?: { status?: string; shellID?: string } } } | undefined;
    expect(call?.state?.metadata?.status).toBe("running");
    const jobs = await client!.listBackgroundJobs({ sessionId: id, kind: "shell" });
    expect(jobs).toEqual([
      expect.objectContaining({
        kind: "shell",
        sessionID: id,
        status: "running",
        shellID: call?.state?.metadata?.shellID,
      }),
    ]);
    expect(await p.status(id)).toBe("idle");
    expect(await p.activity(id)).toBe("working");
    expect(await p.settleTurn(id, "shell-1")).toBe(false);
    expect(await readProviderStatus(p, id)).toMatchObject({
      status: "idle",
      backgroundWorkLive: true,
    });

    const readOptions = { limit: 100, targetBytes: 2_000_000 };
    const before = await p.transcriptSnapshot(id, readOptions);
    expect(JSON.stringify(before)).not.toContain("Background command completed:");

    // Away: nothing reads through the provider while the command ends and
    // its report wakes the session into a run that settles.
    await until(async () => (await idleRows(id)) === 2, 30_000);
    await until(async () => (await client!.activeSessions()).has(id) === false);

    // Return with the token held before the report, as a remounted tab does.
    const resumed = await p.transcriptSnapshot(id, {
      ...readOptions,
      knownSourceToken: before.sourceToken,
    });
    expect(JSON.stringify(resumed)).toContain("Background command completed:");

    // Reload from a fresh provider with no cached transcript.
    const fresh = new OpenCode2Provider(client!, { monitorEvents: false });
    try {
      expect(await fresh.status(id)).toBe("idle");
      expect(await fresh.activity(id)).toBe("idle");
      expect(await fresh.observeSession(id)).toEqual({ status: "idle" });
      expect(await fresh.settleTurn(id, "shell-1")).toBe(true);
      const snapshot = JSON.stringify(
        await fresh.transcriptSnapshot(id, { limit: 100, targetBytes: 2_000_000 }),
      );
      expect(snapshot).toContain(`Background command completed: ${command}\\nLIVE-SHELL-DONE`);
      const report = (await rows(id)).find((row) => row.type === "synthetic");
      expect(report?.metadata).toMatchObject({ source: "shell", state: "completed" });
      expect(report?.metadata?.shellID).toBe(jobs[0]?.shellID);
      expect(await client!.listBackgroundJobs({ sessionId: id })).toEqual([]);
    } finally {
      await fresh.dispose();
    }
  },
  90_000,
);

liveTest(
  "a stop terminates a timed-out command and the run its report wakes",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    // A real model takes a while to answer; the run the terminated command's
    // report wakes is held so the stop meets it mid-response.
    fixture!.model.hold = async ({ texts }) => {
      if (texts.some((text) => text.includes('state="error"'))) await Bun.sleep(2_000);
    };
    await p.send(id, timedOut("sleep 60; echo NEVER-PRINTED"), { requestId: "shell-stop" });
    await until(async () => (await idleRows(id)) === 1 && (await p.activity(id)) === "working");
    await p.abort(id);
    fixture!.model.hold = undefined;
    await until(async () => (await p.activity(id)) === "idle", 15_000);
    expect(await client!.listBackgroundJobs({ sessionId: id, kind: "shell" })).toEqual([]);
    const running = await client!.api<unknown[]>("GET", "/api/shell", "OpenCode shells", {});
    expect(running).toEqual([]);
    // Whatever the terminated command reported, no run it woke went on to answer.
    const history = await rows(id);
    const report = history.find((row) => row.type === "synthetic");
    // 2.3.1 reports a removed command as a failed job.
    expect(report?.metadata).toMatchObject({ source: "shell", state: "error" });
    const snapshot = JSON.stringify(
      await p.transcriptSnapshot(id, { limit: 100, targetBytes: 2_000_000 }),
    );
    expect(snapshot).toContain("Background command stopped: sleep 60; echo NEVER-PRINTED");
    const after = history.slice(history.indexOf(report!) + 1);
    expect(
      after.every(
        (row) => row.type !== "idle" || (row as { outcome?: string }).outcome === "interrupted",
      ),
    ).toBe(true);
    expect(JSON.stringify(history)).not.toContain("NEVER-PRINTED\n");
    await Bun.sleep(1_000);
    expect(await p.activity(id)).toBe("idle");
    expect(await readProviderStatus(p, id)).not.toMatchObject({ backgroundWorkLive: true });
  },
  60_000,
);
