/**
 * `closeProviderSessionIfRunning`: the service path OpenCode tab teardown
 * uses, so the provider's own close (workflow settlement, reviewer permission
 * restore, pending-request rejection) runs instead of a raw HTTP abort. It
 * must never start a bridge to do so.
 */
import { describe, expect, mock, test } from "bun:test";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("native agent service tab close", () => {
  test("closes through the provider's own closeSession", async () => {
    const stub = createProviderStub("opencode");
    const closeSession = mock(async (_sessionId: string) => undefined);
    Object.assign(stub.provider, { closeSession });
    await withService(
      { prefix: "orkestrator-native-close-", provider: async () => stub.provider },
      async ({ service }) => {
        await expect(
          service.closeProviderSessionIfRunning("env-1", "opencode", "oc-session"),
        ).resolves.toBe("closed");
        expect(closeSession).toHaveBeenCalledWith("oc-session");
      },
    );
  });

  test("reports a provider without close as unsupported and propagates close failures", async () => {
    const stub = createProviderStub("opencode");
    await withService(
      { prefix: "orkestrator-native-close-unsupported-", provider: async () => stub.provider },
      async ({ service }) => {
        await expect(
          service.closeProviderSessionIfRunning("env-1", "opencode", "oc-session"),
        ).resolves.toBe("unsupported");
        Object.assign(stub.provider, {
          closeSession: async () => {
            throw new Error("OpenCode pending requests could not be rejected");
          },
        });
        await expect(
          service.closeProviderSessionIfRunning("env-1", "opencode", "oc-session"),
        ).rejects.toThrow("could not be rejected");
      },
    );
  });

  test("never starts a bridge: no running bridge answers not-running", async () => {
    const commands: string[] = [];
    await withService(
      {
        prefix: "orkestrator-native-close-absent-",
        invoke: async <T>(command: string): Promise<T> => {
          commands.push(command);
          if (command === "peek_local_agent_bridge") return null as T;
          throw new Error(`Unexpected backend command: ${command}`);
        },
      },
      async ({ service }) => {
        await expect(
          service.closeProviderSessionIfRunning("env-1", "opencode", "oc-session"),
        ).resolves.toBe("not-running");
        expect(commands).toEqual(["peek_local_agent_bridge"]);
      },
    );
  });
  test("reads the identity a later resume needs, and never guesses one", async () => {
    const stub = createProviderStub("codex");
    await withService(
      { prefix: "orkestrator-native-resumable-", provider: async () => stub.provider },
      async ({ service }) => {
        // A provider without a state read cannot say.
        Object.assign(stub.provider, { sessionStateSnapshot: undefined });
        await expect(
          service.resumableSessionIdIfRunning("env-1", "codex", "session-client-1"),
        ).resolves.toBeUndefined();
        Object.assign(stub.provider, {
          sessionStateSnapshot: async () => ({ status: "idle", resumableSessionId: "thread-1" }),
        });
        await expect(
          service.resumableSessionIdIfRunning("env-1", "codex", "session-client-1"),
        ).resolves.toBe("thread-1");
        // Codex cannot resume a bridge session, even before thread creation.
        Object.assign(stub.provider, { sessionStateSnapshot: async () => ({ status: "idle" }) });
        await expect(
          service.resumableSessionIdIfRunning("env-1", "codex", "session-client-1"),
        ).resolves.toBeUndefined();
        for (const snapshot of [
          { status: "missing", resumableSessionId: "thread-stale" },
          { status: "idle", resumableSessionId: "   " },
        ]) {
          Object.assign(stub.provider, { sessionStateSnapshot: async () => snapshot });
          await expect(
            service.resumableSessionIdIfRunning("env-1", "codex", "session-client-1"),
          ).resolves.toBeUndefined();
        }
        Object.assign(stub.provider, {
          sessionStateSnapshot: async () => {
            throw new Error("bridge restarted");
          },
        });
        await expect(
          service.resumableSessionIdIfRunning("env-1", "codex", "session-client-1"),
        ).resolves.toBeUndefined();
      },
    );
  });
});
