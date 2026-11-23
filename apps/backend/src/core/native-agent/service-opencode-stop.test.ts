import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeAgentProvider } from "./provider.js";
import { NativeAgentService, nativeAgentSessionStorageKey } from "./service.js";
import {
  addEnvironment,
  createStorage,
  refusingInvoke,
} from "./service-projection-test-support.js";
import { FakeOpenCode2Server } from "../opencode2/fake-server.test-support.js";
import { OpenCode2Provider } from "../opencode2/provider.js";

const identity = {
  environmentId: "env-1",
  agent: "opencode" as const,
  logicalSessionKey: "env-env-1:tab-opencode-stop",
};

/**
 * A short stop settle window keeps each stop from waiting out the production
 * three seconds. `null` keeps the production window, for the cases whose
 * assertions are about polling across it while every read is slow.
 */
function openCodeProvider(server: FakeOpenCode2Server, stopSettleMs: number | null = 250) {
  return createNativeAgentProvider(
    { agent: "opencode", baseUrl: server.baseUrl, authToken: "pw", directory: "/work" },
    {
      openCode: {
        connection: async () => ({
          baseUrl: server.baseUrl,
          password: "pw",
          directory: "/work",
          generation: "g1",
        }),
        createProvider: () =>
          new OpenCode2Provider(server.client(), {
            monitorEvents: false,
            ...(stopSettleMs === null ? {} : { stopSettleMs }),
          }),
      },
    },
  );
}

/**
 * A stop rejects the session's pending forms and permissions after the
 * interrupt. On OpenCode 2 that cleanup is best-effort: a reject the server
 * refuses never fails the stop, and the ladder still finishes with its notice.
 */
describe("OpenCode stop with a pending-request reject the server refuses", () => {
  for (const outcome of ["graceful", "force-stop", "force-stop error", "no force-stop"] as const) {
    test(`still completes the ${outcome} ladder and records a notice`, async () => {
      const root = await mkdtemp(join(tmpdir(), "ork-opencode-stop-"));
      const storage = await createStorage(root);
      await addEnvironment(storage);
      const delayed = outcome === "graceful" || outcome === "force-stop";
      let stopping = false;
      const server = new FakeOpenCode2Server(async () => {
        if (delayed && stopping) await Bun.sleep(90);
      });
      const provider = openCodeProvider(server, delayed ? null : 250);
      const calls: string[] = [];
      let polls = 0;
      provider.status = async () => {
        calls.push("status");
        polls += 1;
        return outcome === "graceful" && polls >= 2 ? "idle" : "running";
      };
      if (outcome === "force-stop" || outcome === "force-stop error") {
        provider.hardAbort = async () => {
          calls.push("hard-abort");
          if (outcome === "force-stop error") throw new Error("force-stop unavailable");
        };
      }
      const abort = provider.abort.bind(provider);
      provider.abort = async (id) => {
        calls.push("abort");
        stopping = true;
        try {
          await abort(id);
        } finally {
          stopping = false;
        }
      };
      let now = 0;
      const service = new NativeAgentService(storage, refusingInvoke, {
        provider: async () => provider,
        abortGraceMs: 20,
        now: () => (now += 10),
      });
      try {
        const session = await service.ensureSession(identity);
        if (delayed) server.addChildSession(session.providerSessionId, { running: false });
        server.sessions.get(session.providerSessionId)!.forms.push({
          id: "form-stopped",
          sessionID: session.providerSessionId,
          title: "Continue?",
          fields: [{ key: "x", type: "string", title: "Continue the turn?" }],
        });
        server.failNextFormReject = { status: 500, body: { _tag: "Refused" } };
        calls.length = 0;
        polls = 0;

        const firstStopCall = server.calls.length;
        const stopped = service.stopProjectionSession(identity);
        // Only the force-stop's own failure reaches the caller.
        let projection: Awaited<typeof stopped>;
        if (outcome === "force-stop error") {
          await expect(stopped).rejects.toThrow("force-stop unavailable");
          projection = service.cachedProjectionSnapshot(
            identity.environmentId,
            identity.agent,
            identity.logicalSessionKey,
          );
        } else {
          projection = await stopped;
        }

        if (delayed) {
          const scans = server.calls
            .slice(firstStopCall)
            .filter((call) => call.path === "/api/experimental/job");
          expect(scans.length).toBeGreaterThan(2);
          expect(scans.length).toBeLessThan(31);
        }
        expect(calls[0]).toBe("abort");
        expect(calls.filter((call) => call === "status").length).toBeGreaterThanOrEqual(2);
        expect(calls.includes("hard-abort")).toBe(
          outcome === "force-stop" || outcome === "force-stop error",
        );
        if (outcome === "force-stop" || outcome === "force-stop error")
          expect(calls.indexOf("hard-abort")).toBeGreaterThan(calls.indexOf("status"));
        // The reject was attempted, and refused.
        expect(
          server.calls.some(
            (call) => call.method === "DELETE" && call.path.endsWith("/form/form-stopped"),
          ),
        ).toBe(true);
        expect(server.sessions.get(session.providerSessionId)!.forms).toHaveLength(1);
        const messages =
          projection?.messages.map((message) => (message as { content?: unknown }).content) ?? [];
        expect(messages).toContain(
          outcome === "graceful"
            ? "The turn stopped after a graceful interrupt."
            : outcome === "force-stop" || outcome === "force-stop error"
              ? "The turn did not stop within the grace period and a force-stop was requested."
              : "The turn did not stop within the grace period; this provider has no force-stop action.",
        );
      } finally {
        await service.shutdown();
        await provider.dispose?.();
        server.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

/**
 * A user steer whose acknowledgement was lost stays a pending steer in storage.
 * When it is still held behind a card, the stop withdraws it (#2250
 * (retired)), and OpenCode's answer for it becomes `absent`: the pending steer
 * clears and the next prompt runs alone, without the stopped redirect.
 */
describe("OpenCode stop with an unconfirmed user steer held behind a card", () => {
  test("the view names the parked run, and the withdrawn steer clears so the next prompt runs alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-opencode-stop-unknown-"));
    const storage = await createStorage(root);
    await addEnvironment(storage);
    const server = new FakeOpenCode2Server();
    const provider = openCodeProvider(server);
    const service = new NativeAgentService(storage, refusingInvoke, {
      provider: async () => provider,
      abortGraceMs: 20,
    });
    const key = nativeAgentSessionStorageKey(
      identity.environmentId,
      identity.agent,
      identity.logicalSessionKey,
    );
    try {
      const session = await service.ensureSession(identity);
      const providerSessionId = session.providerSessionId;
      await expect(
        service.dispatchIntent({ ...identity, prompt: "run a command", requestId: "stop-turn" }),
      ).resolves.toEqual({ outcome: "accepted", requestId: "stop-turn" });
      server.sessions.get(providerSessionId)!.permissions.push({
        id: "per_1",
        sessionID: providerSessionId,
        action: "shell",
        resources: ["echo parked"],
      });

      // Parked on the card, the view still names the run a steer joins.
      const parked = await service.getSessionStateUpdate({ ...identity, viewVersion: 1 });
      if (parked.status !== "snapshot") throw new Error("expected snapshot");
      expect(parked.value.turn.phase).toBe("blocked");
      expect(parked.value.turn.runId).toBeString();
      expect(await provider.activeSteerRun!(providerSessionId)).toEqual({
        state: "running",
        runId: parked.value.turn.runId!,
      });

      // OpenCode holds the steer behind the card, but its answer is lost.
      server.loseNextPromptAck = true;
      const steered = await service.performProjectionAction({
        ...identity,
        action: { kind: "steer", text: "held redirect", expectedRunId: parked.value.turn.runId },
      });
      expect(steered.outcome).toBe("unknown");
      const steerRequestId = steered.requestId!;
      const pending = (await storage.getNativeAgentSession(key))?.pendingSteer;
      expect(pending).toMatchObject({ requestId: steerRequestId, origin: "user" });
      expect(server.sessions.get(providerSessionId)!.inbox).toHaveLength(1);

      await service.stopProjectionSession(identity);
      expect(server.withdrawals).toEqual([
        { sessionId: providerSessionId, inputId: expect.any(String) },
      ]);
      expect(server.sessions.get(providerSessionId)!.inbox).toEqual([]);
      expect(await provider.steerStatus!(providerSessionId, steerRequestId)).toBe("absent");

      // The next prompt settles the pending steer as never delivered and runs.
      await expect(
        service.dispatchIntent({ ...identity, prompt: "the next prompt", requestId: "after-stop" }),
      ).resolves.toEqual({ outcome: "accepted", requestId: "after-stop" });
      const settled = await storage.getNativeAgentSession(key);
      expect(settled?.pendingSteer).toBeUndefined();
      expect(settled?.dispatchedRequestIds ?? []).not.toContain(steerRequestId);
      expect(settled?.dispatchedRequestIds).toContain("after-stop");
      server.finishRun(providerSessionId);
      const texts = server.sessions
        .get(providerSessionId)!
        .rows.filter((row) => row.type === "user")
        .map((row) => String(row.text));
      expect(texts).toEqual(["run a command", "the next prompt"]);
    } finally {
      await service.shutdown();
      await provider.dispose?.();
      server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
