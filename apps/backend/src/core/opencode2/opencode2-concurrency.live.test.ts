import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ProviderTranscriptSnapshot } from "../agent-provider-contract.js";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";
import {
  exclusiveOpenCode2Reload,
  openCode2ReloadGateCount,
  openCode2ReloadGateKey,
  withinOpenCode2Dispatch,
} from "./reload-gate.js";

/**
 * Concurrent sessions on one 2.x server (to-do 7905 task 2): two tabs in one
 * environment share one `opencode serve` and its reload gate. Two providers
 * on the same server generation (a tab's and a pipeline's, as
 * `environment-provider.ts` builds them) and two sessions on one provider
 * dispatch through the shared gate at the same time; every run settles with
 * its own reply, a steer reaches only the session it was sent to, and a
 * reload asked for while a dispatch holds the gate is refused. A real pinned 2.x server
 * and a scripted local model (no credentials, no remote calls). Run with
 * RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x binary, or
 * through `mise run verify:opencode2:live`.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
let tab: OpenCode2Provider | undefined;
let pipeline: OpenCode2Provider | undefined;
let gateKey = "";

const client = () =>
  new OpenCode2Client({
    baseUrl: fixture!.baseUrl,
    password: fixture!.password,
    directory: fixture!.directory,
  });

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!);
  tab = new OpenCode2Provider(client());
  pipeline = new OpenCode2Provider(client());
  gateKey = openCode2ReloadGateKey({ baseUrl: fixture.baseUrl, generation: "live-concurrency" });
}, 60_000);

afterAll(async () => {
  await tab?.dispose();
  await pipeline?.dispose();
  await fixture?.stop();
});

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

type Row = { role: string; content: string };

async function replies(provider: OpenCode2Provider, sessionId: string): Promise<string[]> {
  const window = (await provider.transcriptSnapshot(sessionId, {
    limit: 50,
    targetBytes: 4_000_000,
  })) as ProviderTranscriptSnapshot;
  return (window.messages as Row[])
    .filter((row) => row.role === "assistant" && row.content.includes("ack:"))
    .map((row) => row.content.trim());
}

async function userTexts(sessionId: string): Promise<string[]> {
  const page = await client().listMessages(sessionId, { limit: 50 });
  return page.messages.flatMap((row) =>
    row.type === "user" && typeof (row as { text?: unknown }).text === "string"
      ? [(row as { text: string }).text]
      : [],
  );
}

liveTest(
  "two providers and two sessions on one server run their turns together, each settling on its own reply",
  async () => {
    const sessions = await Promise.all([
      tab!.createSession("build", "tab one", { model: "fixture/fixture" }),
      tab!.createSession("build", "tab two", { model: "fixture/fixture" }),
      pipeline!.createSession("build", "pipeline", { model: "fixture/fixture" }),
    ]);
    const [one, two, three] = sessions as [string, string, string];
    const owner = (id: string) => (id === three ? pipeline! : tab!);
    const prompts = new Map([
      [one, "RUN_SLOW_TOOL alpha"],
      [two, "RUN_SLOW_TOOL beta"],
      [three, "RUN_SLOW_TOOL gamma"],
    ]);
    // Every dispatch holds the shared gate, as the environment provider sends it.
    await Promise.all(
      sessions.map((id, index) =>
        withinOpenCode2Dispatch(gateKey, () =>
          owner(id).send(id, prompts.get(id)!, { requestId: `concurrent-${index}` }),
        ),
      ),
    );
    expect(openCode2ReloadGateCount()).toBe(0);

    // The runs overlap: the server lists all three as running at once.
    await until(async () => {
      const running = await client().activeSessions();
      return sessions.every((id) => running.has(id)) ? true : undefined;
    });
    expect(await tab!.activityBatch([one, two])).toEqual(
      new Map([
        [one, "working"],
        [two, "working"],
      ]),
    );

    // While a dispatch holds the shared gate, a reload of the server is refused.
    let release!: () => void;
    const holding = withinOpenCode2Dispatch(
      gateKey,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    expect(await exclusiveOpenCode2Reload(gateKey, async () => "reloaded")).toBe("busy");
    release();
    await holding;

    // A steer to the first tab's run reaches it and nothing else.
    const run = await tab!.activeSteerRun(one);
    expect(run.state).toBe("running");
    expect(
      await withinOpenCode2Dispatch(gateKey, () =>
        tab!.performSessionAction(one, {
          kind: "steer",
          text: "STEER_ONLY_ALPHA",
          requestId: "concurrent-steer",
          expectedRunId: (run as { runId: string }).runId,
        }),
      ),
    ).toEqual({ outcome: "applied", requestId: "concurrent-steer" });

    for (const id of sessions) {
      await until(async () => ((await owner(id).activity(id)) === "idle" ? true : undefined));
    }
    for (const [index, id] of sessions.entries()) {
      expect(await owner(id).dispatchStatus(id, `concurrent-${index}`)).toBe("dispatched");
      expect(await owner(id).settleTurn(id, `concurrent-${index}`)).toBe(true);
    }
    expect(await tab!.steerStatus(one, "concurrent-steer")).toBe("dispatched");
    expect(await tab!.steerStatus(two, "concurrent-steer")).toBe("unknown");
    expect(await pipeline!.steerStatus(three, "concurrent-steer")).toBe("unknown");

    // Each session's final reply answers its own last input.
    expect((await replies(tab!, one)).at(-1)).toBe("ack:STEER_ONLY_ALPHA");
    expect((await replies(tab!, two)).at(-1)).toBe("ack:RUN_SLOW_TOOL beta");
    expect((await replies(pipeline!, three)).at(-1)).toBe("ack:RUN_SLOW_TOOL gamma");
    expect(await userTexts(one)).toContain("STEER_ONLY_ALPHA");
    expect(await userTexts(two)).not.toContain("STEER_ONLY_ALPHA");
    expect(await userTexts(three)).not.toContain("STEER_ONLY_ALPHA");
    // The steer reached the model once, inside the first run.
    expect(
      fixture!.model.calls.filter((call) => call.userTexts.at(-1) === "STEER_ONLY_ALPHA"),
    ).toHaveLength(1);
  },
  120_000,
);

liveTest(
  "a second turn on each session after the concurrent ones runs on its own",
  async () => {
    const [one, two] = await Promise.all([
      tab!.createSession("build", "again one", { model: "fixture/fixture" }),
      tab!.createSession("build", "again two", { model: "fixture/fixture" }),
    ]);
    for (const round of [1, 2]) {
      await Promise.all(
        [one, two].map((id, index) =>
          withinOpenCode2Dispatch(gateKey, () =>
            tab!.send(id, `round ${round} session ${index}`, {
              requestId: `round-${round}-${index}`,
            }),
          ),
        ),
      );
      for (const id of [one, two]) {
        await until(async () => ((await tab!.activity(id)) === "idle" ? true : undefined));
      }
    }
    expect(await replies(tab!, one)).toEqual(["ack:round 1 session 0", "ack:round 2 session 0"]);
    expect(await replies(tab!, two)).toEqual(["ack:round 1 session 1", "ack:round 2 session 1"]);
  },
  90_000,
);
