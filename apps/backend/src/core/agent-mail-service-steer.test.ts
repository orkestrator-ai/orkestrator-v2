import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import {
  AGENT_MAIL_MAX_BODY_BYTES,
  renderAgentMailCarrier,
} from "@orkestrator/protocol/agent-mail";
import { AgentMailService } from "./agent-mail-service.js";
import { fixture, replaceRecipientTab } from "./agent-mail-service-test-support.js";
import { createProviderStub } from "./native-agent-service-projection-test-support.js";
import { NativeAgentService, nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { seedStore } from "./storage-test-support.js";
import type { StorageService } from "./storage.js";

describe("Deliver now while the recipient is mid-turn", () => {
  async function busyRecipientMail(storage: StorageService, body: string) {
    return storage.sendAgentMail(
      { kind: "tab", environmentId: "sender", projectId: "project", tabId: "agent" },
      {
        requestId: `deliver-now-${crypto.randomUUID()}`,
        toEnvironmentId: "recipient",
        toTabId: "agent",
        body,
      },
    );
  }

  function steeringAgents(options: {
    presence: () => "working" | "idle";
    steer: () => Promise<Awaited<ReturnType<NonNullable<NativeAgentService["steerMailInject"]>>>>;
    journal?: () => "dispatched" | "not-dispatched" | "unknown";
  }) {
    const steers: Array<{ text: string; requestId: string }> = [];
    const reconciled: string[] = [];
    const dispatches: string[] = [];
    return {
      steers,
      reconciled,
      dispatches,
      agents: {
        reconcileMailInject: async () => "unknown" as const,
        sessionActivitySnapshot: () => options.presence(),
        mailInjectPresence: async () => options.presence(),
        steerMailInject: async (input: { text: string; requestId: string }) => {
          steers.push({ text: input.text, requestId: input.requestId });
          return options.steer();
        },
        reconcileMailSteer: async (input: { requestId: string }) => {
          reconciled.push(input.requestId);
          return options.journal?.() ?? "unknown";
        },
        dispatchMailInject: async (input: { prompt: string; requestId: string }) => {
          dispatches.push(input.prompt);
          return { outcome: "accepted" as const, requestId: input.requestId };
        },
      },
    };
  }

  test("an escape-heavy first carrier waits for lossless idle delivery", async () => {
    const { storage, dataDir } = await fixture();
    let service: AgentMailService | undefined;
    try {
      const body = "<".repeat(12_000);
      expect(Buffer.byteLength(body)).toBeLessThan(AGENT_MAIL_MAX_BODY_BYTES);
      const message = await busyRecipientMail(storage, body);
      expect(Buffer.byteLength(renderAgentMailCarrier(message))).toBeGreaterThan(65_536);
      let presence: "working" | "idle" = "working";
      const world = steeringAgents({
        presence: () => presence,
        steer: async () => ({ outcome: "applied" }),
      });
      service = new AgentMailService(storage, world.agents, {
        dispatchMailInject: async () => ({ outcome: "accepted" }),
      });
      await service.init();
      await storage.retryAgentMailInject("recipient", "agent", message.id, { steer: true });
      await service.drainInjects();
      expect(world.steers).toHaveLength(0);
      expect(world.dispatches).toHaveLength(0);
      expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject({
        body,
        placement: "pending-inject",
        placementReason: "steer-too-large",
      });
      await service.drainInjects();
      expect(world.steers).toHaveLength(0);
      presence = "idle";
      await service.drainInjects();
      expect(world.dispatches).toEqual([renderAgentMailCarrier(message)]);
      expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject({
        body,
        placement: "injected",
      });
    } finally {
      await service?.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test.each([-1, 0, 1])(
    "steer batching counts escaping and separators at the 60 KB boundary (%s)",
    async (offset) => {
      const { storage, dataDir } = await fixture();
      let service: AgentMailService | undefined;
      try {
        const first = await busyRecipientMail(storage, "<".repeat(5_000));
        // Same routing metadata and fixed-size ids make the empty carrier an
        // exact measure of the remaining space for a plain UTF-8 body.
        const emptyBytes = Buffer.byteLength(renderAgentMailCarrier({ ...first, body: "" }));
        const remaining =
          60 * 1024 - Buffer.byteLength(renderAgentMailCarrier(first)) - 2 - emptyBytes;
        const second = await busyRecipientMail(storage, "x".repeat(remaining + offset));
        const third = await busyRecipientMail(storage, "Tail.");
        const joined = [first, second].map(renderAgentMailCarrier).join("\n\n");
        expect(Buffer.byteLength(joined)).toBe(60 * 1024 + offset);
        let presence: "working" | "idle" = "working";
        const world = steeringAgents({
          presence: () => presence,
          steer: async () => ({ outcome: "applied" }),
        });
        service = new AgentMailService(storage, world.agents, {
          dispatchMailInject: async () => ({ outcome: "accepted" }),
        });
        await service.init();
        await storage.retryAgentMailInject("recipient", "agent", first.id, { steer: true });
        await service.drainInjects();
        expect(world.steers).toHaveLength(1);
        expect(Buffer.byteLength(world.steers[0]!.text)).toBeLessThanOrEqual(60 * 1024);
        expect(world.steers[0]!.text).toBe(offset <= 0 ? joined : renderAgentMailCarrier(first));
        const released = offset <= 0 ? third : second;
        expect(await storage.getAgentMailMessage("recipient", "agent", released.id)).toMatchObject({
          placement: "pending-inject",
          placementReason: "batch-full",
        });
        presence = "idle";
        await service.drainInjects();
        await service.drainInjects();
        for (const message of [first, second, third]) {
          expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject(
            { placement: "injected", body: message.body },
          );
          const carriers = [...world.steers.map(({ text }) => text), ...world.dispatches];
          expect(carriers.filter((text) => text.includes(message.id))).toHaveLength(1);
        }
      } finally {
        await service?.shutdown();
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  test.each(["returned", "thrown"])("a %s steer refusal holds mail until idle", async (kind) => {
    const { storage, dataDir } = await fixture();
    let service: AgentMailService | undefined;
    try {
      const message = await busyRecipientMail(storage, "Refused.");
      let presence: "working" | "idle" = "working";
      const world = steeringAgents({
        presence: () => presence,
        steer: async () => {
          if (kind === "thrown") throw new Error("lookup failed before dispatch");
          return { outcome: "refused", reason: "steer-refused" };
        },
      });
      service = new AgentMailService(storage, world.agents, {
        dispatchMailInject: async () => ({ outcome: "accepted" }),
      });
      await service.init();
      await storage.retryAgentMailInject("recipient", "agent", message.id, { steer: true });
      await service.drainInjects();
      expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject({
        placement: "pending-inject",
        placementReason: "steer-refused",
      });
      await service.drainInjects();
      expect(world.steers).toHaveLength(1);
      expect(world.dispatches).toHaveLength(0);
      presence = "idle";
      await service.drainInjects();
      expect(world.dispatches).toHaveLength(1);
      expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject({
        placement: "injected",
      });
    } finally {
      await service?.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("steers the waiting mail into the running turn", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const first = await busyRecipientMail(storage, "First.");
      const second = await busyRecipientMail(storage, "Second.");
      const world = steeringAgents({
        presence: () => "working",
        steer: async () => ({ outcome: "applied" }),
      });
      const service = new AgentMailService(storage, world.agents, {
        dispatchMailInject: async () => ({ outcome: "accepted" }),
      });
      await service.init();

      // Waiting for the turn to end is the default; nothing is offered.
      await service.drainInjects();
      expect(world.steers).toHaveLength(0);

      await storage.retryAgentMailInject("recipient", "agent", first.id, { steer: true });
      await service.drainInjects();

      // One steer carries everything waiting, in send order, under a fresh uuid.
      expect(world.steers).toHaveLength(1);
      expect(world.steers[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(world.steers[0]!.text.indexOf("First.")).toBeLessThan(
        world.steers[0]!.text.indexOf("Second."),
      );
      expect(world.dispatches).toHaveLength(0);
      for (const message of [first, second]) {
        expect(
          (await storage.getAgentMailMessage("recipient", "agent", message.id)).placement,
        ).toBe("injected");
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("an agent that cannot steer says so and delivers when the turn ends", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const message = await busyRecipientMail(storage, "Later.");
      let presence: "working" | "idle" = "working";
      const world = steeringAgents({
        presence: () => presence,
        steer: async () => ({ outcome: "refused", reason: "steer-unsupported" }),
      });
      const service = new AgentMailService(storage, world.agents, {
        dispatchMailInject: async () => ({ outcome: "accepted" }),
      });
      await service.init();
      await storage.retryAgentMailInject("recipient", "agent", message.id, { steer: true });
      await service.drainInjects();
      expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject({
        placement: "pending-inject",
        placementReason: "steer-unsupported",
      });

      // One attempt: the next pass mid-turn does not offer it again.
      await service.drainInjects();
      expect(world.steers).toHaveLength(1);

      presence = "idle";
      await service.drainInjects();
      expect(world.dispatches).toHaveLength(1);
      expect((await storage.getAgentMailMessage("recipient", "agent", message.id)).placement).toBe(
        "injected",
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a turn that ended before the steer gets the mail the ordinary way at once", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const message = await busyRecipientMail(storage, "Just missed.");
      const world = steeringAgents({
        presence: () => "working",
        steer: async () => ({ outcome: "idle" }),
      });
      const service = new AgentMailService(storage, world.agents, {
        dispatchMailInject: async () => ({ outcome: "accepted" }),
      });
      await service.init();
      await storage.retryAgentMailInject("recipient", "agent", message.id, { steer: true });
      await service.drainInjects();
      expect(world.steers).toHaveLength(1);
      expect(world.dispatches).toHaveLength(1);
      expect((await storage.getAgentMailMessage("recipient", "agent", message.id)).placement).toBe(
        "injected",
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("an unanswered steer is confirmed against the steer journal, never resent", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const message = await busyRecipientMail(storage, "Did it land?");
      let journal: "dispatched" | "unknown" = "unknown";
      const world = steeringAgents({
        presence: () => "working",
        steer: async () => ({ outcome: "unknown" }),
        journal: () => journal,
      });
      const service = new AgentMailService(storage, world.agents, {
        dispatchMailInject: async () => ({ outcome: "accepted" }),
      });
      await service.init();
      await storage.retryAgentMailInject("recipient", "agent", message.id, { steer: true });
      await service.drainInjects();
      expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject({
        placement: "pending-inject",
        placementReason: "verifying",
      });

      // Pressing Deliver now again skips the wait, but only asks the journal.
      await storage.retryAgentMailInject("recipient", "agent", message.id, { steer: true });
      await service.drainInjects();
      expect(world.reconciled).toEqual([world.steers[0]!.requestId]);

      journal = "dispatched";
      await storage.retryAgentMailInject("recipient", "agent", message.id);
      await service.drainInjects();
      expect(world.steers).toHaveLength(1);
      expect(world.dispatches).toHaveLength(0);
      expect(world.reconciled).toHaveLength(2);
      expect((await storage.getAgentMailMessage("recipient", "agent", message.id)).placement).toBe(
        "injected",
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a steer interrupted by a restart settles from the steer journal", async () => {
    const { storage, dataDir } = await fixture();
    try {
      const delivered = await busyRecipientMail(storage, "Landed.");
      const mailbox = (await storage.getAgentMailMailbox("recipient", "agent")).descriptor;
      await storage.beginAgentMailInject(
        mailbox.mailboxId,
        delivered.id,
        mailbox.incarnationId,
        undefined,
        { steerRequestId: "steer-before-crash" },
      );
      const world = steeringAgents({
        presence: () => "working",
        steer: async () => ({ outcome: "applied" }),
        journal: () => "dispatched",
      });
      const service = new AgentMailService(storage, world.agents, {
        dispatchMailInject: async () => ({ outcome: "accepted" }),
      });
      await service.init();
      expect(world.reconciled).toEqual(["steer-before-crash"]);
      expect(
        (await storage.getAgentMailMessage("recipient", "agent", delivered.id)).placement,
      ).toBe("injected");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test.each([
    { ordinary: "absent", steer: "absent", expected: "pending-inject" },
    { ordinary: "absent", steer: "unknown", expected: "inject_failed" },
    { ordinary: "absent", steer: "missing", expected: "inject_failed" },
    { ordinary: "absent", steer: "dispatched", expected: "injected" },
    { ordinary: "pending", steer: "absent", expected: "inject_failed" },
    { ordinary: "retired", steer: "absent", expected: "inject_failed" },
    { ordinary: "dispatched", steer: "absent", expected: "injected" },
    { ordinary: "refused", steer: "absent", expected: "pending-inject" },
    { ordinary: "dispatched", steer: "unknown", expected: "injected" },
    { ordinary: "dispatched", steer: "missing", expected: "injected" },
    { ordinary: "absent", steer: "absent", expected: "pending-inject", pendingSteer: true },
    { ordinary: "absent", steer: "unknown", expected: "inject_failed", pendingSteer: true },
    { ordinary: "absent", steer: "dispatched", expected: "injected", pendingSteer: true },
  ] as const)("startup recovery: %j", async (scenario) => {
    const { ordinary, steer, expected } = scenario;
    const pendingSteer = "pendingSteer" in scenario;
    const { storage, dataDir } = await fixture();
    let service: AgentMailService | undefined;
    let native: NativeAgentService | undefined;
    try {
      const message = await busyRecipientMail(storage, "Interrupted steer.");
      const mailbox = (await storage.getAgentMailMailbox("recipient", "agent")).descriptor;
      const claim = await storage.beginAgentMailInject(
        mailbox.mailboxId,
        message.id,
        mailbox.incarnationId,
        undefined,
        { steerRequestId: "steer-before-crash" },
      );
      expect(claim?.injectRequestId).toBeTruthy();
      const input = {
        environmentId: "recipient",
        agent: "claude" as const,
        logicalSessionKey: "env-recipient:agent",
        requestId: claim!.injectRequestId!,
      };
      const key = nativeAgentSessionStorageKey(
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
      );
      const session = await storage.adoptNativeAgentSession({
        ...input,
        key,
        providerSessionId: "restart-session",
        origin: "interactive-native",
      });
      seedStore(dataDir, "native-agent-sessions.json", {
        [key]: {
          ...session,
          ...(pendingSteer
            ? {
                pendingSteer: {
                  requestId: "steer-before-crash",
                  text: renderAgentMailCarrier(message),
                  inputDigest: "a".repeat(64),
                  expectedRunId: "run-before-crash",
                  state: "prepared",
                  createdAt: new Date().toISOString(),
                },
              }
            : {}),
          ...(ordinary === "pending" || ordinary === "refused"
            ? {
                pendingDispatch: {
                  requestId: input.requestId,
                  prompt: renderAgentMailCarrier(message),
                  createdAt: new Date().toISOString(),
                  ...(ordinary === "refused" ? { mailRefused: true as const } : {}),
                },
              }
            : {}),
          ...(ordinary === "retired"
            ? {
                retiredDispatch: {
                  requestId: input.requestId,
                  retiredAt: new Date().toISOString(),
                },
              }
            : {}),
          ...(ordinary === "dispatched" ? { dispatchedRequestIds: [input.requestId] } : {}),
        },
      });
      const stub = createProviderStub("claude", { dispatchStatus: async () => "unknown" });
      if (steer !== "missing") Object.assign(stub.provider, { steerStatus: async () => steer });
      native = new NativeAgentService(
        storage,
        async () => {
          throw new Error("Unexpected invoke");
        },
        { provider: async () => stub.provider },
      );
      // The normal reconciler keeps absence inconclusive. Steer recovery
      // can use it only in combination with positive non-dispatch evidence.
      if (ordinary === "absent") expect(await native.reconcileMailInject(input)).toBe("unknown");
      let presence: "working" | "idle" = "working";
      const dispatches: string[] = [];
      const start = () =>
        new AgentMailService(
          storage,
          {
            reconcileMailInject: (request) => native!.reconcileMailInject(request),
            reconcileMailSteer: (request) => native!.reconcileMailSteer(request),
            sessionActivitySnapshot: () => presence,
            mailInjectPresence: async () => presence,
            dispatchMailInject: async (request) => {
              dispatches.push(request.prompt);
              return { outcome: "accepted", requestId: request.requestId };
            },
          },
          { dispatchMailInject: async () => ({ outcome: "accepted" }) },
        );
      service = start();
      await service.init();
      expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject({
        placement: expected,
        ...(expected === "inject_failed" ? { placementReason: "ambiguous" } : {}),
      });
      // Another startup and idle drain must never duplicate either journal's
      // confirmed send, or replay an unresolved fallback.
      await service.shutdown();
      service = start();
      await service.init();
      presence = "idle";
      await service.drainInjects();
      await service.drainInjects();
      expect(dispatches).toHaveLength(expected === "pending-inject" ? 1 : 0);
      if (expected === "pending-inject")
        expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject({
          placement: "injected",
          body: message.body,
        });
    } finally {
      await service?.shutdown();
      await native?.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a terminal agent mid-turn is told it cannot take mail now", async () => {
    const { storage, dataDir } = await fixture();
    try {
      await replaceRecipientTab(storage, "claude-tmux");
      const message = await busyRecipientMail(storage, "Terminal.");
      const tmuxDispatches: string[] = [];
      const service = new AgentMailService(
        storage,
        {
          reconcileMailInject: async () => "unknown",
          sessionActivitySnapshot: () => "idle",
          dispatchMailInject: async (input) => ({
            outcome: "accepted",
            requestId: input.requestId,
          }),
        },
        {
          mailInjectPresence: async () => "working",
          dispatchMailInject: async (input) => {
            tmuxDispatches.push(input.text);
            return { outcome: "accepted" };
          },
        },
      );
      await service.init();
      await storage.retryAgentMailInject("recipient", "agent", message.id, { steer: true });
      await service.drainInjects();
      expect(tmuxDispatches).toHaveLength(0);
      expect(await storage.getAgentMailMessage("recipient", "agent", message.id)).toMatchObject({
        placement: "pending-inject",
        placementReason: "steer-unsupported",
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
