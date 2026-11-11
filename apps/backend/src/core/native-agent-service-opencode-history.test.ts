/**
 * "Load earlier" over OpenCode, through the native projection.
 *
 * OpenCode records each agent-loop step as its own history row, so a long
 * session outgrows the live window by itself. Its transcript snapshot names a
 * `before` cursor at the oldest row it kept (`opencode2/transcript-snapshot.ts`);
 * these tests pin that the progressive view turns it into a direct cursor and
 * that pages walk back to the session's first row, without the legacy full
 * read. Row-level paging rules are in `opencode2/transcript-snapshot.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import { withService } from "./native-agent-service-projection-test-support.js";
import { FakeOpenCode2Server } from "./opencode2/fake-server.test-support.js";
import { OpenCode2Provider } from "./opencode2/provider.js";
import { normalizeOpenCode2Transcript } from "./opencode2/transcript.js";
import type { OpenCode2Message } from "./opencode2/types.js";

const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;

const identity = {
  environmentId: "env-1",
  agent: "opencode" as const,
  logicalSessionKey: "env-env-1:opencode-history",
};

let server: FakeOpenCode2Server | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
});

function openCodeProvider(fake: FakeOpenCode2Server) {
  const provider = createNativeAgentProvider(
    { agent: "opencode", baseUrl: fake.baseUrl, authToken: "pw", directory: "/work" },
    {
      openCode: {
        connection: async () => ({
          baseUrl: fake.baseUrl,
          password: "pw",
          directory: "/work",
          generation: "g1",
        }),
        createProvider: () => new OpenCode2Provider(fake.client(), { monitorEvents: false }),
      },
    },
  );
  // A paged view must never take the legacy full read.
  provider.messages = async () => {
    throw new Error("a paged OpenCode view must not take the legacy read");
  };
  return provider;
}

/** `turns` finished turns: a user row, an assistant row and an idle row each. */
async function seedTurns(
  fake: FakeOpenCode2Server,
  provider: ReturnType<typeof openCodeProvider>,
  sessionId: string,
  turns: number,
) {
  for (let turn = 0; turn < turns; turn += 1) {
    await provider.send(sessionId, `step ${turn}`, { requestId: `req-${turn}` });
    fake.finishRun(sessionId, "succeeded", `answer ${turn}`);
  }
}

function expectedIds(fake: FakeOpenCode2Server, sessionId: string): string[] {
  return normalizeOpenCode2Transcript(
    fake.sessions.get(sessionId)!.rows as unknown as OpenCode2Message[],
  ).map((message) => (message as { id: string }).id);
}

describe("OpenCode history through the native projection", () => {
  test("a long session pages back directly to its first message", async () => {
    server = new FakeOpenCode2Server();
    const fake = server;
    const provider = openCodeProvider(fake);
    await withService(
      { prefix: "orkestrator-opencode-history-", provider: async () => provider },
      async ({ service }) => {
        const session = await service.ensureSession(identity);
        await seedTurns(fake, provider, session.providerSessionId, 90);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        expect(update.value.historyPaging).toBe("direct");
        expect(update.value.historyComplete).toBe(false);
        expect(update.value.messageWindow?.canLoadEarlier).toBe(true);

        const ids = update.value.messages.map((entry) => (entry as { id: string }).id);
        let cursor = update.value.historyCursor;
        let pages = 0;
        while (cursor) {
          const page = await service.getMessagePage({
            ...identity,
            syncVersion: 1,
            before: cursor,
            limit: 60,
          });
          expect(page.historyEpoch).toBe(update.value.historyEpoch);
          ids.unshift(...page.messages.map((entry) => (entry as { id: string }).id));
          cursor = page.nextCursor;
          pages += 1;
          if (!cursor) expect(page.complete).toBe(true);
          expect(pages).toBeLessThan(20);
        }
        expect(pages).toBeGreaterThan(0);
        expect(ids).toEqual(expectedIds(fake, session.providerSessionId));
        expect(new Set(ids).size).toBe(ids.length);
      },
    );
    await provider.dispose?.();
  });

  test("a session that fits the window offers no history to load", async () => {
    server = new FakeOpenCode2Server();
    const fake = server;
    const provider = openCodeProvider(fake);
    await withService(
      { prefix: "orkestrator-opencode-history-short-", provider: async () => provider },
      async ({ service }) => {
        const session = await service.ensureSession(identity);
        await seedTurns(fake, provider, session.providerSessionId, 5);
        const update = await service.getTranscriptUpdate({
          ...identity,
          viewVersion: 1,
          liveWindow,
          forceSnapshot: true,
        });
        if (update.status !== "snapshot") throw new Error("expected a snapshot");
        expect(update.value.messages.map((entry) => (entry as { id: string }).id)).toEqual(
          expectedIds(fake, session.providerSessionId),
        );
        expect(update.value.historyComplete).toBe(true);
        expect(update.value.historyCursor).toBeUndefined();
        expect(update.value.messageWindow?.canLoadEarlier ?? false).toBe(false);
      },
    );
    await provider.dispose?.();
  });
});
