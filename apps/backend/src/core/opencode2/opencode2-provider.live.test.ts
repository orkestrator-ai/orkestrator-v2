import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";

/**
 * `OpenCode2Provider` against a real pinned 2.x server and a scripted local
 * model (no credentials, no remote calls). Run with RUN_LIVE_OPENCODE2=1 and
 * OPENCODE2_CLI_PATH set to the 2.x binary.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
let provider: OpenCode2Provider | undefined;

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!);
  provider = new OpenCode2Provider(
    new OpenCode2Client({
      baseUrl: fixture.baseUrl,
      password: fixture.password,
      directory: fixture.directory,
    }),
  );
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

liveTest(
  "dispatches, reports activity, steers the running run and refuses a settled one",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    await p.send(id, "RUN_SLOW_TOOL first", { requestId: "live-1" });
    expect(await p.dispatchStatus(id, "live-1")).toBe("dispatched");
    await until(async () => (await p.activity(id)) === "working");

    const run = await p.activeSteerRun(id);
    expect(run.state).toBe("running");
    const runId = (run as { runId: string }).runId;
    expect(
      await p.performSessionAction(id, {
        kind: "steer",
        text: "STEER_DURING_TOOL",
        requestId: "live-steer",
        expectedRunId: runId,
      }),
    ).toEqual({ outcome: "applied", requestId: "live-steer" });

    await until(async () => (await p.activity(id)) === "idle");
    expect(await p.steerStatus(id, "live-steer")).toBe("dispatched");
    // The steer reached the model inside the first run.
    expect(fixture!.model.calls.some((call) => call.userTexts.at(-1) === "STEER_DURING_TOOL")).toBe(
      true,
    );

    // The run has settled: a steer aimed at it is not sent.
    expect(
      await p.performSessionAction(id, {
        kind: "steer",
        text: "TOO_LATE",
        requestId: "live-late",
        expectedRunId: runId,
      }),
    ).toEqual({ outcome: "idle" });
    expect(await p.steerStatus(id, "live-late")).toBe("unknown");

    // Abort on an idle session is harmless; close keeps the conversation.
    await p.abort(id);
    await p.closeSession(id);
    const rows = (
      await new OpenCode2Client({
        baseUrl: fixture!.baseUrl,
        password: fixture!.password,
        directory: fixture!.directory,
      }).listMessages(id, { limit: 50 })
    ).messages;
    expect(rows.length).toBeGreaterThan(3);
  },
  90_000,
);
