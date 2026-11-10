/**
 * The progressive read's "does the preview fill the window?" check: the same
 * decision as before, measured once per provider revision.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  createProviderStub,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { collaborators } from "./native-agent-service-test-collaborators.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;

interface Identity {
  environmentId: string;
  agent: "opencode";
  logicalSessionKey: string;
}

function row(id: string, content: string) {
  return { id, role: "assistant", content, parts: [], createdAt: "2026-11-10T00:00:00.000Z" };
}

const stringify = JSON.stringify;
afterEach(() => {
  mock.restore();
});

/** Counts `JSON.stringify` calls on exactly the arrays a provider stub handed out. */
function countWindowMeasurements(windows: Set<unknown>): { count: number } {
  const counter = { count: 0 };
  spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...rest: unknown[]) => {
    if (windows.has(value)) counter.count += 1;
    return (stringify as (...args: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify);
  return counter;
}

async function pollIncompletePreview(content: string) {
  let revision = 1;
  const windows = new Set<unknown>();
  const messages = mock(async () => [row("prompt", "first"), row("response", content)]);
  const stub = createProviderStub("opencode", {
    interactiveSnapshot: async () => {
      const window = [row("response", content)];
      windows.add(window);
      return {
        status: "idle" as const,
        messages: window,
        messagesComplete: false,
        providerRevision: revision,
      };
    },
    messages,
  });
  return {
    stub,
    windows,
    messages,
    /** A new provider revision, which the next read sees once the projection is invalidated. */
    bump: (service: Parameters<typeof collaborators>[0], identity: Identity) => {
      revision += 1;
      collaborators(service).projections.invalidateProjection(
        nativeAgentSessionStorageKey(
          identity.environmentId,
          identity.agent,
          identity.logicalSessionKey,
        ),
      );
    },
  };
}

describe("progressive preview fill check", () => {
  test("a preview that fills the window by bytes is measured once per revision and never recovered", async () => {
    const preview = await pollIncompletePreview("x".repeat(600 * 1024));
    const measured = countWindowMeasurements(preview.windows);
    await withService(
      { prefix: "orkestrator-preview-fill-full-", provider: async () => preview.stub.provider },
      async ({ service }) => {
        const identity: Identity = {
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "env-env-1:preview-fill-full",
        };
        await service.ensureSession(identity);
        const read = () => service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        for (let poll = 0; poll < 4; poll += 1) await read();
        expect(measured.count).toBe(1);
        preview.bump(service, identity);
        await read();
        await read();
        expect(measured.count).toBe(2);
        // Filling the window by bytes means the bridge cut it; nothing to recover.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(preview.messages).not.toHaveBeenCalled();
        expect(collaborators(service).projections.cacheGauges().progressivePreviewFills).toBe(1);
      },
    );
  });

  test("a short preview still schedules one recovery per revision without re-measuring", async () => {
    const preview = await pollIncompletePreview("short");
    const measured = countWindowMeasurements(preview.windows);
    await withService(
      { prefix: "orkestrator-preview-fill-short-", provider: async () => preview.stub.provider },
      async ({ service }) => {
        const identity: Identity = {
          environmentId: "env-1",
          agent: "opencode",
          logicalSessionKey: "env-env-1:preview-fill-short",
        };
        await service.ensureSession(identity);
        const read = () => service.getTranscriptUpdate({ ...identity, viewVersion: 1, liveWindow });
        await read();
        await waitForCondition(() => preview.messages.mock.calls.length === 1);
        const recovered = await read();
        expect(recovered.status).toBe("snapshot");
        if (recovered.status !== "snapshot") throw new Error("expected a snapshot");
        expect(recovered.value.messages.map((message) => (message as { id: string }).id)).toEqual([
          "prompt",
          "response",
        ]);
        await read();
        expect(measured.count).toBe(1);
        expect(preview.messages).toHaveBeenCalledTimes(1);

        preview.bump(service, identity);
        await read();
        await waitForCondition(() => preview.messages.mock.calls.length === 2);
        expect(measured.count).toBe(2);
      },
    );
  });
});
