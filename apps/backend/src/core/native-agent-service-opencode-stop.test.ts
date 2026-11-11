import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import { NativeAgentService } from "./native-agent-service.js";
import {
  addEnvironment,
  createStorage,
  refusingInvoke,
} from "./native-agent-service-projection-test-support.js";
import { FakeOpenCode2Server } from "./opencode2/fake-server.test-support.js";
import { OpenCode2Provider } from "./opencode2/provider.js";

const identity = {
  environmentId: "env-1",
  agent: "opencode" as const,
  logicalSessionKey: "env-env-1:tab-opencode-stop",
};

function openCodeProvider(server: FakeOpenCode2Server) {
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
        createProvider: () => new OpenCode2Provider(server.client(), { monitorEvents: false }),
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
      const server = new FakeOpenCode2Server();
      const provider = openCodeProvider(server);
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
        return abort(id);
      };
      let now = 0;
      const service = new NativeAgentService(storage, refusingInvoke, {
        provider: async () => provider,
        abortGraceMs: 20,
        now: () => (now += 10),
      });
      try {
        const session = await service.ensureSession(identity);
        server.sessions.get(session.providerSessionId)!.forms.push({
          id: "form-stopped",
          sessionID: session.providerSessionId,
          title: "Continue?",
          fields: [{ key: "x", type: "string", title: "Continue the turn?" }],
        });
        server.failNextFormReject = { status: 500, body: { _tag: "Refused" } };
        calls.length = 0;
        polls = 0;

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
