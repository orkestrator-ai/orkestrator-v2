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
});
