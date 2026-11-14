import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { agentMailboxId, type AgentMailNotice } from "@orkestrator/protocol/agent-mail";
import { AgentMailService } from "./agent-mail-service.js";
import { fixture } from "./agent-mail-service-test-support.js";
import { RIDE_ALONG_MAX_AGE_MS } from "./storage-agent-mail-injects.js";
import type { StorageService } from "./storage.js";

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});

/** Move the clock past every retry, verification and coalescing wait. */
function later(ms: number): void {
  const base = Date.now();
  Date.now = () => base + ms;
}

const SWITCH_NOTICE: AgentMailNotice = {
  resource: { kind: "account-switch", id: "claude", label: "mini" },
  accountSwitch: { provider: "Claude Code", from: "a@example.com", to: "b@example.com" },
  state: "account-switched",
  tone: "info",
};

const WORKFLOW = {
  kind: "system" as const,
  projectId: "project",
  source: "workflow" as const,
  resourceId: "account-auto-switch:claude",
};

function riderTo(storage: StorageService, requestId: string, toEnvironmentId = "recipient") {
  return storage.sendAgentMail(
    { ...WORKFLOW, resourceId: `account-auto-switch:${requestId}` },
    {
      requestId,
      toEnvironmentId,
      toTabId: "agent",
      subject: "Claude Code moved to b@example.com on mini",
      body: "Automatic account switching moved Claude Code.",
    },
    {
      notice: { ...SWITCH_NOTICE, resource: { ...SWITCH_NOTICE.resource, id: requestId } },
      rideAlong: true,
    },
  );
}

function ordinaryTo(storage: StorageService, toEnvironmentId: string, requestId: string) {
  const fromEnvironmentId = toEnvironmentId === "recipient" ? "sender" : "recipient";
  return storage.sendAgentMail(
    { kind: "tab", environmentId: fromEnvironmentId, projectId: "project", tabId: "agent" },
    { requestId, toEnvironmentId, toTabId: "agent", body: `Work for ${toEnvironmentId}.` },
  );
}

type Dispatch = "accepted" | "rejected" | "unknown";

function service(
  storage: StorageService,
  prompts: string[],
  options: {
    /** Each dispatch's answer, in order; accepted once they run out. */
    outcomes?: Dispatch[];
    journal?: "dispatched" | "not-dispatched" | "unknown";
    recipients?: string[];
  } = {},
) {
  const outcomes = [...(options.outcomes ?? [])];
  return new AgentMailService(
    storage,
    {
      reconcileMailInject: async () => options.journal ?? "unknown",
      sessionActivitySnapshot: () => "idle",
      mailInjectPresence: async () => "idle",
      dispatchMailInject: async (input) => {
        const outcome = outcomes.shift() ?? "accepted";
        if (outcome === "rejected") return { outcome, error: "bridge would not start" };
        prompts.push(input.prompt);
        options.recipients?.push(input.environmentId);
        return outcome === "accepted"
          ? { outcome, requestId: input.requestId }
          : { outcome, requestId: input.requestId, error: "no answer" };
      },
    },
    { dispatchMailInject: async () => ({ outcome: "accepted" }) },
  );
}

/** Carry a lone rider through one refused or ambiguous dispatch, as a batch would. */
async function settleRiderAlone(
  storage: StorageService,
  riderId: string,
  outcome: { outcome: "retry"; reason: string } | { outcome: "verify"; requestId: string },
) {
  const mailbox = (await storage.getAgentMailMailbox("recipient", "agent")).descriptor;
  const mailboxId = agentMailboxId("recipient", "agent");
  expect(
    await storage.beginAgentMailInject(mailboxId, riderId, mailbox.incarnationId, undefined, {
      joinCoalescing: true,
    }),
  ).not.toBeNull();
  await storage.finishAgentMailInject(mailboxId, riderId, outcome);
}

describe("a notice that rides along", () => {
  test("never starts a turn of its own", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    try {
      const rider = await riderTo(storage, "rider-alone");
      expect(rider.placement).toBe("pending-inject");
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "pending-inject",
      });
      // Not listed for a caller that does not ask for riders, and not listed at
      // all while nothing else waits for this mailbox, so nothing can claim it
      // as a wake.
      expect(await storage.listPendingAgentMailInjects()).toEqual([]);
      expect(await storage.listPendingAgentMailInjects(100, { includeCoalescing: true })).toEqual(
        [],
      );
      expect(rider.rideAlong).toBe(true);
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("is delivered inside the batch another message starts, in one turn", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    try {
      const rider = await riderTo(storage, "rider-first");
      const message = await storage.sendAgentMail(
        { kind: "tab", environmentId: "sender", projectId: "project", tabId: "agent" },
        {
          requestId: "starts-the-turn",
          toEnvironmentId: "recipient",
          toTabId: "agent",
          body: "A worker finished.",
        },
      );
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("account-switch");
      expect(prompts[0]).toContain("A worker finished.");
      for (const id of [rider.id, message.id]) {
        expect(await storage.getAgentMailMessage("recipient", "agent", id)).toMatchObject({
          placement: "injected",
        });
      }
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("lapses after a day instead of waking anyone or piling up", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    try {
      const rider = await riderTo(storage, "rider-stale");
      later(RIDE_ALONG_MAX_AGE_MS + 60_000);
      expect(
        await storage.listPendingAgentMailInjects(100, { includeCoalescing: true }),
      ).toHaveLength(0);
      // The next rider sweeps the stale one out of the queue.
      await riderTo(storage, "rider-fresh");
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "expired",
      });
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a lapsed one leaves the queue on the next drain, with no later notice to sweep it", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    try {
      const rider = await riderTo(storage, "rider-lapsed");
      later(RIDE_ALONG_MAX_AGE_MS + 60_000);
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "expired",
      });
      const summary = await storage.getAgentMailSummary();
      expect(
        summary.mailboxes.find((entry) => entry.environmentId === "recipient")?.pendingInjectCount,
      ).toBe(0);
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("stays a rider after its batch was refused and the mail it rode with is gone", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    try {
      const rider = await riderTo(storage, "rider-retried");
      await settleRiderAlone(storage, rider.id, { outcome: "retry", reason: "rejected" });
      later(60 * 60_000);
      expect(await storage.listPendingAgentMailInjects(100, { includeCoalescing: true })).toEqual(
        [],
      );
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
      // It still rides in with the next mail that does start a turn.
      await ordinaryTo(storage, "recipient", "after-retry");
      await mail.drainInjects();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("account-switch");
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "injected",
      });
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("an unconfirmed rider is checked against the journal, never resent on its own", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts, { journal: "not-dispatched" });
    try {
      const rider = await riderTo(storage, "rider-verified");
      await settleRiderAlone(storage, rider.id, { outcome: "verify", requestId: "lost-batch" });
      later(60 * 60_000);
      await mail.init();
      // The journal says it never arrived: it goes back to waiting as a rider.
      await mail.drainInjects();
      later(60 * 60_000);
      await mail.drainInjects();
      expect(prompts).toEqual([]);
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "pending-inject",
        rideAlong: true,
      });
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a confirmed rider is marked delivered without a turn", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts, { journal: "dispatched" });
    try {
      const rider = await riderTo(storage, "rider-confirmed");
      await settleRiderAlone(storage, rider.id, { outcome: "verify", requestId: "landed-batch" });
      later(60 * 60_000);
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "injected",
      });
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a refused batch keeps its rider through the retry that delivers both", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts, { outcomes: ["rejected"] });
    try {
      const rider = await riderTo(storage, "rider-refused");
      const message = await ordinaryTo(storage, "recipient", "refused-then-sent");
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "pending-inject",
        rideAlong: true,
      });
      later(60 * 60_000);
      await mail.drainInjects();
      expect(prompts).toHaveLength(1);
      for (const id of [rider.id, message.id]) {
        expect(await storage.getAgentMailMessage("recipient", "agent", id)).toMatchObject({
          placement: "injected",
        });
      }
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("Deliver now sends it as an ordinary delivery", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    try {
      const rider = await riderTo(storage, "rider-released");
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
      await storage.retryAgentMailInject("recipient", "agent", rider.id);
      await mail.drainInjects();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("account-switch");
      expect(await storage.getAgentMailMessage("recipient", "agent", rider.id)).toMatchObject({
        placement: "injected",
      });
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a hundred and more waiting riders never keep other mail from being delivered", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const recipients: string[] = [];
    const mail = service(storage, prompts, { recipients });
    try {
      for (let index = 0; index < 120; index += 1) {
        const rider = await riderTo(storage, `rider-${index}`);
        expect(rider.placement).toBe("pending-inject");
      }
      // Queued behind every rider: one for another environment, one for theirs.
      await ordinaryTo(storage, "sender", "other-environment");
      const mine = await ordinaryTo(storage, "recipient", "same-mailbox");
      await mail.init();
      await mail.drainInjects();
      expect(recipients.toSorted()).toEqual(["recipient", "sender"]);
      expect(await storage.getAgentMailMessage("recipient", "agent", mine.id)).toMatchObject({
        placement: "injected",
      });
      // Its batch carried riders too, within the batch bound.
      const carried = prompts[recipients.indexOf("recipient")]!;
      expect(carried).toContain("account-switch");
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("waits out a coalescing stop notice, then arrives with it in one turn", async () => {
    const { storage, dataDir } = await fixture();
    const prompts: string[] = [];
    const mail = service(storage, prompts);
    try {
      const rider = await riderTo(storage, "rider-coalesced");
      // As a usage-limit stop notice is sent: held a moment to gather others.
      const stop = await storage.sendAgentMail(
        { ...WORKFLOW, resourceId: "usage-limit:claude" },
        {
          requestId: "usage-limit-stop",
          toEnvironmentId: "recipient",
          toTabId: "agent",
          body: "Claude Code reached its 5-hour limit.",
        },
        { coalesceMs: 5_000 },
      );
      await mail.init();
      await mail.drainInjects();
      expect(prompts).toEqual([]);
      later(10_000);
      await mail.drainInjects();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("account-switch");
      expect(prompts[0]).toContain("5-hour limit");
      for (const id of [rider.id, stop.id]) {
        expect(await storage.getAgentMailMessage("recipient", "agent", id)).toMatchObject({
          placement: "injected",
        });
      }
    } finally {
      await mail.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
