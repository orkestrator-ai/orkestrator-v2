import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { promises as fs } from "node:fs";
import type { MailboxPresence } from "@orkestrator/protocol/agent-mail";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { AgentMailService } from "./agent-mail-service.js";
import { fixture } from "./agent-mail-service-test-support.js";
import { AGENT_MAIL_HELD_BACKOFF_MAX_MS } from "./storage-agent-mail-injects.js";
import type { StorageService } from "./storage.js";

/*
 * A Claude CLI still running background work refuses a prompt (HTTP 409)
 * while its turn, and so the mailbox's presence, reads idle. The drain runs
 * every 2 s; it must back off from that refusal rather than send again on
 * every pass, and log the repeating hold once.
 */

const START = Date.parse("2026-11-22T12:00:00.000Z");

let service: AgentMailService | undefined;
let dataDir: string | undefined;
let logs: LogCapture | undefined;

afterEach(async () => {
  await service?.shutdown();
  service = undefined;
  setSystemTime();
  logs?.restore();
  logs = undefined;
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function refusingRecipient(options: {
  presence: () => MailboxPresence;
  dispatch?: () => Promise<"held" | "accepted">;
}): Promise<{ storage: StorageService; dispatches: () => number }> {
  const made = await fixture();
  dataDir = made.dataDir;
  let dispatches = 0;
  service = new AgentMailService(
    made.storage,
    {
      reconcileMailInject: async () => "unknown",
      sessionActivitySnapshot: () => "idle",
      mailInjectPresence: async () => options.presence(),
      dispatchMailInject: async (input) => {
        dispatches += 1;
        return (await (options.dispatch?.() ?? Promise.resolve("held" as const))) === "accepted"
          ? { outcome: "accepted", requestId: input.requestId }
          : { outcome: "held", reason: "busy" };
      },
    },
    { dispatchMailInject: async () => ({ outcome: "accepted" }) },
  );
  await made.storage.sendAgentMail(
    { kind: "tab", environmentId: "sender", projectId: "project", tabId: "agent" },
    {
      requestId: "refused-at-rest",
      toEnvironmentId: "recipient",
      toTabId: "agent",
      body: "Deliver once the session takes prompts again.",
    },
  );
  await service.init();
  return { storage: made.storage, dispatches: () => dispatches };
}

async function deferredMs(storage: StorageService): Promise<number> {
  const [entry] = await storage.listPendingAgentMailInjects(100, { includeDeferred: true });
  return entry?.deferredUntil ? Date.parse(entry.deferredUntil) - Date.now() : 0;
}

describe("mail held by a session that refuses while it reads idle", () => {
  test("backs off between attempts, doubling up to the cap, instead of every pass", async () => {
    setSystemTime(new Date(START));
    let presence: MailboxPresence = "idle";
    const { storage, dispatches } = await refusingRecipient({ presence: () => presence });
    await service!.drainInjects();
    expect(dispatches()).toBe(1);

    const waits: number[] = [];
    let now = START;
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const wait = await deferredMs(storage);
      waits.push(wait);
      // Every 2 s pass inside the wait, with presence flipping between idle
      // and unknown as a fresh and a stale observation do, sends nothing.
      for (let elapsed = 2_000; elapsed < wait; elapsed += 2_000) {
        presence = presence === "idle" ? "unknown" : "idle";
        setSystemTime(new Date(now + elapsed));
        await service!.refreshPresence();
        await service!.drainInjects();
      }
      expect(dispatches()).toBe(attempt);
      now += wait;
      setSystemTime(new Date(now));
      presence = "idle";
      await service!.drainInjects();
      expect(dispatches()).toBe(attempt + 1);
    }
    expect(waits).toEqual([
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      AGENT_MAIL_HELD_BACKOFF_MAX_MS,
      AGENT_MAIL_HELD_BACKOFF_MAX_MS,
    ]);
  });

  test("a real presence change ends the backoff at once", async () => {
    setSystemTime(new Date(START));
    let presence: MailboxPresence = "idle";
    let accept = false;
    const { storage, dispatches } = await refusingRecipient({
      presence: () => presence,
      dispatch: async () => (accept ? "accepted" : "held"),
    });
    await service!.drainInjects();
    setSystemTime(new Date(START + 2_000));
    await service!.drainInjects();
    expect(dispatches()).toBe(2);
    expect(await deferredMs(storage)).toBe(4_000);

    // The session ran a turn of its own, then went idle.
    presence = "working";
    await service!.refreshPresence();
    presence = "idle";
    accept = true;
    await service!.refreshPresence();
    await service!.drainInjects();
    expect(dispatches()).toBe(3);
    const [message] = (await storage.getAgentMailMailbox("recipient", "agent")).messages;
    expect(message?.placement).toBe("injected");
  });

  test("a presence read during our own dispatch is not taken as a session change", async () => {
    setSystemTime(new Date(START));
    let presence: MailboxPresence = "idle";
    let dispatching = false;
    let release!: () => void;
    let refreshed!: Promise<void>;
    const { dispatches } = await refusingRecipient({
      // The dispatch's durable pending row reads as `working` while it runs.
      presence: () => (dispatching ? "working" : presence),
      dispatch: async () => {
        if (dispatches() === 2) {
          dispatching = true;
          refreshed = service!.refreshPresence();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          dispatching = false;
        }
        return "held";
      },
    });
    await service!.drainInjects();
    setSystemTime(new Date(START + 2_000));
    const draining = service!.drainInjects();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    await refreshed;
    release();
    await draining;
    expect(dispatches()).toBe(2);

    await service!.refreshPresence();
    setSystemTime(new Date(START + 4_000));
    await service!.drainInjects();
    expect(dispatches()).toBe(2);
  });

  test("a repeating identical hold logs once, and its end says how many repeats", async () => {
    logs = captureLogs();
    setSystemTime(new Date(START));
    let accept = false;
    const { storage } = await refusingRecipient({
      presence: () => "idle",
      dispatch: async () => (accept ? "accepted" : "held"),
    });
    let now = START;
    await service!.drainInjects();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      now += await deferredMs(storage);
      setSystemTime(new Date(now));
      await service!.drainInjects();
    }
    accept = true;
    now += await deferredMs(storage);
    setSystemTime(new Date(now));
    await service!.drainInjects();

    const dispatched = logs.records().filter((record) => record.event === "inject.dispatched");
    expect(dispatched.map((record) => record.fields?.outcome)).toEqual(["held", "accepted"]);
    expect(dispatched[0]?.fields).toMatchObject({ reason: "busy" });
    expect(dispatched[1]?.fields).toMatchObject({ previousHoldRepeats: 4 });
  });
});
