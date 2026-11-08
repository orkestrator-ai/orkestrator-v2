import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2SequenceTracker, readOpenCode2Events } from "./events.js";
import {
  checkOpenCode2Admission,
  classifyOpenCode2SteerLanding,
  mintOpenCode2InputId,
  newestOpenCode2IdleId,
} from "./steer.js";
import type { OpenCode2Message } from "./types.js";

/**
 * The 2.x client and steer classification against a real pinned 2.x server.
 * No credentials or remote model: a scripted local model in a disposable
 * profile. Run with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the
 * 2.x binary (docs/todo/agent-engines/0008-opencode-v2.md, task 10).
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const liveTest = process.env.RUN_LIVE_OPENCODE2 === "1" && binary ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
let client: OpenCode2Client;

beforeAll(async () => {
  if (process.env.RUN_LIVE_OPENCODE2 !== "1" || !binary) return;
  fixture = await startOpenCode2Fixture(binary);
  client = new OpenCode2Client({
    baseUrl: fixture.baseUrl,
    password: fixture.password,
    directory: fixture.directory,
  });
}, 60_000);

afterAll(async () => {
  await fixture?.stop();
});

async function history(sessionId: string): Promise<OpenCode2Message[]> {
  const page = await client.listMessages(sessionId, { limit: 200 });
  return [...page.messages].reverse();
}

async function waitFor(
  sessionId: string,
  done: (messages: OpenCode2Message[]) => boolean,
  timeoutMs = 30_000,
): Promise<OpenCode2Message[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const messages = await history(sessionId);
    if (done(messages)) return messages;
    if (Date.now() > deadline) throw new Error("timed out waiting for the session");
    await Bun.sleep(150);
  }
}

const idles = (messages: OpenCode2Message[]) => messages.filter((m) => m.type === "idle").length;

liveTest(
  "steers land in the running run, or start a new one once it has settled",
  async () => {
    expect(fixture!.version.startsWith("2.")).toBe(true);
    const events = new AbortController();
    const tracker = new OpenCode2SequenceTracker();
    const verdicts: string[] = [];
    const session = await client.createSession({ model: { providerID: "fixture", id: "fixture" } });
    const reading = client.openEvents(events.signal).then((body) =>
      readOpenCode2Events(
        body,
        (signal) => {
          if (signal.kind !== "event" || signal.event.durable?.aggregateID !== session.id) return;
          verdicts.push(tracker.note(session.id, signal.event.durable.seq));
        },
        events.signal,
      ),
    );
    try {
      // A slow tool keeps the first run open while the steer is sent.
      const first = { id: mintOpenCode2InputId(), text: "RUN_SLOW_TOOL first" };
      await client.prompt(session.id, { ...first, delivery: "steer" });
      await Bun.sleep(1500);
      const anchor = newestOpenCode2IdleId(await history(session.id));
      expect(anchor).toBeUndefined();
      const steer = { id: mintOpenCode2InputId(), text: "STEER_DURING_TOOL" };
      const admitted = await client.prompt(session.id, { ...steer, delivery: "steer" });
      expect(checkOpenCode2Admission(admitted, steer)).toEqual({ kind: "admitted" });
      let messages = await waitFor(session.id, (list) => idles(list) >= 1);
      expect(classifyOpenCode2SteerLanding(messages, steer.id, anchor)).toBe("same-run");

      // The run has settled: a steer now starts a new run.
      const settledAnchor = newestOpenCode2IdleId(messages);
      const late = { id: mintOpenCode2InputId(), text: "STEER_WHILE_IDLE" };
      await client.prompt(session.id, { ...late, delivery: "steer" });
      messages = await waitFor(session.id, (list) => idles(list) >= 2);
      expect(classifyOpenCode2SteerLanding(messages, late.id, undefined)).toBe("new-run");
      expect(classifyOpenCode2SteerLanding(messages, late.id, settledAnchor)).toBe("same-run");

      // A reused id with other text answers the original record: a conflict.
      const reuse = await client.prompt(session.id, {
        id: late.id,
        text: "A DIFFERENT TEXT",
        delivery: "steer",
      });
      expect(checkOpenCode2Admission(reuse, { id: late.id, text: "A DIFFERENT TEXT" })).toEqual({
        kind: "conflict",
      });

      // Live durable events arrive strictly in order. 2.2.6 never broadcasts a
      // few durable sequence numbers (about two per run), so a gap is only a
      // hint to re-read the snapshot, never proof of loss on its own.
      await Bun.sleep(500);
      expect(verdicts[0]).toBe("first");
      expect(verdicts.length).toBeGreaterThan(10);
      expect(verdicts).not.toContain("stale");
    } finally {
      events.abort();
      await reading.catch(() => undefined);
    }
  },
  90_000,
);
