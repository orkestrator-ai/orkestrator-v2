import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ProviderTranscriptSnapshot } from "../agent-provider-contract.js";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { OpenCode2Provider } from "./provider.js";
import { checkOpenCode2Admission, mintOpenCode2InputId } from "./steer.js";

/**
 * The qualification checks of to-do 0008 (retired) task 7 that the other 2.x live
 * files do not already make: an exact retry of an input id, a turn that runs
 * while nothing reads it, a server restart under a live provider, and the
 * resume picker's archive and restore. A real
 * pinned 2.x server and a scripted local model (no credentials, no remote
 * calls). Run with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x
 * binary, or through `mise run verify:opencode2:live`.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
let provider: OpenCode2Provider | undefined;
/**
 * The monitor's `/api/event` connections as the server answered them. Only an
 * accepted event stream counts: an attempt refused while the server is down
 * never reaches here, so a monitor that stopped reconnecting cannot pass for
 * one that reconnected.
 */
type StreamRecord = { open: boolean; bytes: number };
const streams: StreamRecord[] = [];

/** Wraps an accepted event-stream body so the test sees its bytes and its end. */
function observeStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const record: StreamRecord = { open: true, bytes: 0 };
  streams.push(record);
  const reader = body.getReader();
  const end = () => {
    record.open = false;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          end();
          controller.close();
          return;
        }
        record.bytes += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
}

const client = () =>
  new OpenCode2Client({
    baseUrl: fixture!.baseUrl,
    password: fixture!.password,
    directory: fixture!.directory,
  });

beforeAll(async () => {
  if (!live) return;
  fixture = await startOpenCode2Fixture(binary!);
  const counting: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      const accepted =
        new URL(String(input)).pathname === "/api/event" &&
        response.ok &&
        response.body !== null &&
        (response.headers.get("content-type") ?? "").includes("text/event-stream");
      if (!accepted) return response;
      return new Response(observeStream(response.body!), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    { preconnect: fetch.preconnect },
  );
  provider = new OpenCode2Provider(
    new OpenCode2Client({
      baseUrl: fixture.baseUrl,
      password: fixture.password,
      directory: fixture.directory,
      fetch: counting,
    }),
    { monitorRetryMs: 100 },
  );
}, 60_000);

afterAll(async () => {
  await provider?.dispose();
  await fixture?.stop();
});

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(150);
  }
}

type Row = { id: string; role: string; content: string };

async function transcript(sessionId: string): Promise<Row[]> {
  const window = (await provider!.transcriptSnapshot(sessionId, {
    limit: 50,
    targetBytes: 4_000_000,
  })) as ProviderTranscriptSnapshot;
  return window.messages as Row[];
}

const idle = (sessionId: string) =>
  until(async () => ((await provider!.activity(sessionId)) === "idle" ? true : undefined));

liveTest(
  "an exact retry of an input id answers the original record and runs once",
  async () => {
    const session = await client().createSession({ agent: "build" });
    const sessionId = session.id;
    const input = { id: mintOpenCode2InputId(), text: "RETRY_ONCE" };
    const first = await client().prompt(sessionId, { ...input, delivery: "queue" });
    expect(checkOpenCode2Admission(first, input)).toEqual({ kind: "admitted" });
    const retry = await client().prompt(sessionId, { ...input, delivery: "queue" });
    expect(checkOpenCode2Admission(retry, input)).toEqual({ kind: "admitted" });

    await idle(sessionId);
    const rows = (await client().listMessages(sessionId, { limit: 50 })).messages;
    expect(rows.filter((row) => row.id === input.id)).toHaveLength(1);
    expect(
      fixture!.model.calls.filter((call) => call.userTexts.at(-1) === "RETRY_ONCE"),
    ).toHaveLength(1);
  },
  60_000,
);

liveTest(
  "a turn that runs while nothing reads it is complete on the next read",
  async () => {
    // The backend-side half of the inactive-environment path: no activity,
    // transcript or status read happens until the turn has finished.
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    const before = fixture!.model.calls.length;
    await p.send(id, "RUN_SLOW_TOOL unobserved", { requestId: "q-unobserved" });
    // The slow tool's call, then the answer after its result.
    await until(async () => (fixture!.model.calls.length >= before + 2 ? true : undefined), 60_000);
    // The run settles after the answer streams; give it time without reading.
    await Bun.sleep(1_500);

    await idle(id);
    expect(await p.dispatchStatus(id, "q-unobserved")).toBe("dispatched");
    const rows = await transcript(id);
    expect(rows.some((row) => row.role === "user" && row.content.includes("unobserved"))).toBe(
      true,
    );
    expect(rows.at(-1)?.role).toBe("assistant");
  },
  90_000,
);

liveTest(
  "a server restart under a live provider: the monitor reconnects, history is intact and the next turn runs",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "live", { model: "fixture/fixture" });
    await p.send(id, "before restart", { requestId: "q-before" });
    await idle(id);
    const rowsBefore = await transcript(id);
    const current = () => streams.at(-1);
    await until(async () => (current()?.open ? true : undefined));
    const streamsBefore = streams.length;
    const streamBefore = current()!;

    await fixture!.restart();
    // The old stream ended with the server, and a new one was accepted and is
    // carrying bytes (2.2.6 writes a `: heartbeat` comment as soon as it opens).
    await until(async () =>
      streams.length > streamsBefore && current()!.open && current()!.bytes > 0 ? true : undefined,
    );
    expect(streamBefore.open).toBe(false);
    const streamAfter = current()!;
    // Nothing is answered from a cache that predates the restart.
    expect((await transcript(id)).map((row) => row.id)).toEqual(rowsBefore.map((row) => row.id));
    expect(await p.dispatchStatus(id, "q-before")).toBe("dispatched");

    const bytesAtSend = streamAfter.bytes;
    await p.send(id, "after restart", { requestId: "q-after" });
    await idle(id);
    expect(await p.dispatchStatus(id, "q-after")).toBe("dispatched");
    const rows = await transcript(id);
    expect(rows.some((row) => row.role === "user" && row.content.includes("after restart"))).toBe(
      true,
    );
    expect(rows.at(-1)?.role).toBe("assistant");
    // The reconnected stream is still the open one: the turn did not need a
    // further reconnect, and it carried the turn's events.
    expect(current()).toBe(streamAfter);
    expect(streamAfter.open).toBe(true);
    expect(streamAfter.bytes).toBeGreaterThan(bytesAtSend);
    expect(p.observationStreamLive()).toBe(true);
  },
  120_000,
);

liveTest(
  "the resume picker archives a released conversation and restores it, but not one a tab holds",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "archive me", { model: "fixture/fixture" });
    await p.send(id, "to be archived", { requestId: "q-archive" });
    await idle(id);
    const entry = (await p.listResumableSessions()).find((row) => row.sessionId.endsWith(id));
    expect(entry).toBeDefined();
    // Held for a tab: refused, as Codex and Cursor refuse it.
    await expect(p.setResumableSessionArchived(entry!.sessionId, true)).rejects.toThrow(
      "This conversation is open in a tab",
    );

    await p.closeSession(id);
    await p.setResumableSessionArchived(entry!.sessionId, true);
    const listed = (rows: Awaited<ReturnType<typeof p.listResumableSessions>>) =>
      rows.find((row) => row.sessionId === entry!.sessionId);
    expect(listed(await p.listResumableSessions())).toBeUndefined();
    expect(listed(await p.listResumableSessions({ includeArchived: true }))?.archived).toBe(true);
    await expect(p.resumeSession(entry!.sessionId)).rejects.toThrow("archived");

    await p.setResumableSessionArchived(entry!.sessionId, false);
    expect(listed(await p.listResumableSessions())).toBeDefined();
    expect(await p.resumeSession(entry!.sessionId)).toBe(id);
  },
  60_000,
);
