import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { readProviderStatus } from "../agent-provider-contract.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";

/**
 * Background sub-agents (OpenCode 2.3.0, anomalyco/opencode#63382) against a
 * real pinned 2.x server and a scripted local model: a `subagent` call
 * returns at once, the parent's run settles while the child works, and the
 * child's report wakes the parent (`background-subagents.ts`). Run with
 * RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x binary.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
let provider: OpenCode2Provider | undefined;
let client: OpenCode2Client | undefined;

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!);
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

const launch = (seconds: number) =>
  `RUN_TOOL:subagent ${JSON.stringify({
    agent: "general",
    description: "probe child",
    prompt: `RUN_BASH:sleep ${seconds}`,
  })}`;

type Part = Record<string, unknown>;
async function idleRows(id: string): Promise<number> {
  const rows = (await client!.listMessages(id, { limit: 50, order: "asc" })).messages;
  return rows.filter((row) => row.type === "idle").length;
}

async function subagentCards(id: string): Promise<Part[]> {
  const snapshot = await provider!.transcriptSnapshot(id, { limit: 100, targetBytes: 2_000_000 });
  if ("unchanged" in snapshot) throw new Error("unexpected unchanged");
  return (snapshot.messages as Array<{ parts?: Part[] }>)
    .flatMap((row) => row.parts ?? [])
    .filter((part) => part.type === "subagent");
}

liveTest(
  "a background sub-agent keeps its parent's work live and settles its card from the report",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    await p.send(id, launch(4), { requestId: "bg-1" });
    // The parent's own run settles while the child works.
    await until(async () => (await idleRows(id)) === 1);
    expect(await p.status(id)).toBe("idle");
    expect(await p.activity(id)).toBe("working");
    expect(await p.settleTurn(id, "bg-1")).toBe(false);
    expect(await readProviderStatus(p, id)).toMatchObject({
      status: "idle",
      backgroundWorkLive: true,
    });
    expect(await subagentCards(id)).toEqual([
      expect.objectContaining({ subagentId: expect.stringMatching(/^ses/), agentState: "active" }),
    ]);

    // The report wakes the parent; once that run settles, nothing is live.
    await until(async () => (await p.observeSession(id)).backgroundWorkLive !== true, 30_000);
    expect(await p.status(id)).toBe("idle");
    expect(await p.activity(id)).toBe("idle");
    expect(await p.settleTurn(id, "bg-1")).toBe(true);
    const [card] = await subagentCards(id);
    expect(card).toMatchObject({ agentState: "finished", toolState: "success" });
    expect(String(card!.toolOutput)).toContain("ack:");
    // The report row is folded onto the card rather than shown on its own.
    const snapshot = await p.transcriptSnapshot(id, { limit: 100, targetBytes: 2_000_000 });
    expect(JSON.stringify(snapshot)).not.toContain("Sub-agent reported");
    const rows = (await client!.listMessages(id, { limit: 50, order: "asc" })).messages;
    expect(rows.map((row) => row.type)).toContain("synthetic");
    expect(rows.filter((row) => row.type === "idle")).toHaveLength(2);
  },
  90_000,
);

liveTest(
  "a stop ends the running child and the run its cancelled report wakes",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    // A real model takes a while to answer; the run the cancelled report
    // wakes is held so the stop meets it mid-response.
    fixture!.model.hold = async ({ texts }) => {
      if (texts.some((text) => text.includes('state="cancelled"'))) await Bun.sleep(2_000);
    };
    await p.send(id, launch(20), { requestId: "bg-stop" });
    await until(async () => (await idleRows(id)) === 1 && (await p.activity(id)) === "working");
    await p.abort(id);
    fixture!.model.hold = undefined;
    await until(async () => (await p.activity(id)) === "idle", 10_000);
    const rows = (await client!.listMessages(id, { limit: 50, order: "asc" })).messages;
    // The cancelled report reached the parent; no run it woke went on to answer.
    const report = rows.find((row) => row.type === "synthetic");
    expect((report?.metadata as { state?: string } | undefined)?.state).toBe("cancelled");
    const after = rows.slice(rows.indexOf(report!) + 1);
    expect(
      after.every(
        (row) => row.type !== "idle" || (row as { outcome?: string }).outcome === "interrupted",
      ),
    ).toBe(true);
    const [card] = await subagentCards(id);
    expect(card).toMatchObject({ agentState: "failed" });
    await Bun.sleep(1_000);
    expect(await p.activity(id)).toBe("idle");
  },
  60_000,
);
