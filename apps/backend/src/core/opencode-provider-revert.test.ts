/**
 * Undo and Redo over OpenCode, through the provider's transcript reads.
 *
 * OpenCode 1.19 keeps a reverted turn: `session.revert` records
 * `Session.revert` and answers with the updated Session, `session.unrevert`
 * clears it, and only the next prompt deletes the reverted messages
 * (`SessionRevert.cleanup`: `message.removed` for each, then a
 * `session.updated` without the marker). The fake server below follows that
 * contract, and its message reads follow `MessageV2.page` (see
 * `opencode-history-test-support.ts`), so these tests pin that the snapshot
 * and every history page hide the reverted turn while the marker is set, that
 * Redo brings it back, and that the prompt which deletes it leaves no gap.
 */
import { describe, expect, test } from "bun:test";
import type {
  ProviderTranscriptPage,
  ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import {
  deferred,
  openCodeFake,
  openCodeProvider,
  waitUntil,
} from "./agent-provider-test-support.js";
import { openCodeHistoryServer, openCodeMessageId } from "./opencode-history-test-support.js";
import { withService } from "./native-agent-service-projection-test-support.js";

const SESSION = "owned-session";
/** Small enough that the 26-message session needs several history pages. */
const WINDOW = { limit: 64, targetBytes: 12 * 1024 } as const;

type Provider = ReturnType<typeof openCodeProvider>;

function revertServer(
  fake: ReturnType<typeof openCodeFake>,
  count: number,
  text: (index: number) => string = (index) => `${index}:`.padEnd(1_500, "x"),
) {
  const history = openCodeHistoryServer(count, text);
  let revert: { messageID: string; partID?: string; snapshot: string } | undefined;
  const session = () => ({
    id: SESSION,
    directory: "/workspace",
    title: "Revert",
    ...(revert ? { revert } : {}),
  });
  const publish = (event: Record<string, unknown>) => fake.subscriptions.at(-1)?.push(event);
  const updated = () =>
    publish({ type: "session.updated", properties: { sessionID: SESSION, info: session() } });
  const syncSession = () => fake.setSessionGetResponse(SESSION, { data: session() });
  syncSession();
  fake.setMessagesHandler(async (parameters) => ({
    data: history.read(
      parameters?.limit as number | undefined,
      parameters?.before as string | undefined,
    ),
  }));
  const calls = { revert: [] as unknown[], unrevert: [] as unknown[] };
  const sessionClient = fake.client.session as unknown as Record<string, unknown>;
  sessionClient.revert = async (parameters: { messageID: string }) => {
    calls.revert.push(parameters);
    revert = { messageID: parameters.messageID, snapshot: "snapshot-1" };
    syncSession();
    if (server.publishActions) updated();
    return { data: session() };
  };
  sessionClient.unrevert = async (parameters: unknown) => {
    calls.unrevert.push(parameters);
    revert = undefined;
    syncSession();
    if (server.publishActions) updated();
    return { data: session() };
  };
  const server = {
    history,
    calls,
    /** Whether actions also publish `session.updated`, as OpenCode does. */
    publishActions: true,
    /** A revert made outside this backend (OpenCode's own TUI), seen only as an event. */
    externalRevert(marker: { messageID: string; partID?: string } | undefined) {
      revert = marker ? { ...marker, snapshot: "snapshot-1" } : undefined;
      syncSession();
      updated();
    },
    /** What OpenCode does on the next prompt: clean up the revert, then run the turn. */
    prompt() {
      if (revert) {
        const index = history.messages.findIndex(({ info }) => info.id === revert!.messageID);
        for (const removed of history.messages.slice(index)) {
          history.remove(removed.info.id);
          publish({
            type: "message.removed",
            properties: { sessionID: SESSION, messageID: removed.info.id },
          });
        }
        revert = undefined;
        syncSession();
        updated();
      }
      for (const [offset, role] of (["user", "assistant"] as const).entries()) {
        const index = count + offset;
        const id = openCodeMessageId(index);
        const info = { id, sessionID: SESSION, role, time: { created: 1_000 + index } };
        const part = { id: `part-${index}`, messageID: id, type: "text", text: `new ${index}` };
        history.messages.push({ info, parts: [part] });
        publish({ type: "message.updated", properties: { sessionID: SESSION, info } });
        publish({ type: "message.part.updated", properties: { sessionID: SESSION, part } });
      }
    },
  };
  return server;
}

function rowIds(rows: readonly unknown[]): string[] {
  return rows.map((row) => (row as { id: string }).id);
}

async function snapshot(provider: Provider): Promise<ProviderTranscriptSnapshot> {
  const result = await provider.transcriptSnapshot!(SESSION, WINDOW);
  if (!("messages" in result)) throw new Error("expected a transcript snapshot");
  return result;
}

/** Every row a reader holds after paging back to the first message, deduplicated by id. */
async function readAll(provider: Provider, first: ProviderTranscriptSnapshot): Promise<string[]> {
  const ids = rowIds(first.messages);
  let cursor = first.historyCursor;
  for (let pages = 0; cursor; pages += 1) {
    expect(pages).toBeLessThan(20);
    const page: ProviderTranscriptPage | undefined = await provider.transcriptPage!(SESSION, {
      cursor,
      limit: 8,
      targetBytes: 512 * 1024,
    });
    if (page?.status !== "page") throw new Error("expected a history page");
    expect<string | undefined>(page.historyEpoch).toBe(first.historyEpoch);
    ids.unshift(...rowIds(page.messages).filter((id) => !ids.includes(id)));
    cursor = page.historyCursor;
    if (!cursor) expect(page.complete).toBe(true);
  }
  return ids;
}

async function waitForSnapshot(
  provider: Provider,
  predicate: (ids: string[]) => boolean,
): Promise<ProviderTranscriptSnapshot> {
  let latest: ProviderTranscriptSnapshot | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    latest = await snapshot(provider);
    if (predicate(rowIds(latest.messages))) return latest;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for the snapshot; last rows ${rowIds(latest!.messages)}`);
}

const ids = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => openCodeMessageId(from + index));

async function connected(fake: ReturnType<typeof openCodeFake>, provider: Provider) {
  provider.registerSession?.(SESSION);
  await waitUntil(() => fake.subscriptions.length === 1 && fake.messageCalls.length > 0);
}

/** Apply the action on the server immediately, but hold its response in flight. */
function delayAction(fake: ReturnType<typeof openCodeFake>, action: "revert" | "unrevert") {
  const started = deferred();
  const gate = deferred();
  const client = fake.client.session as unknown as Record<
    string,
    (parameters: unknown) => Promise<unknown>
  >;
  const original = client[action]!;
  client[action] = async (parameters) => {
    const response = await original(parameters);
    started.resolve();
    await gate.promise;
    return response;
  };
  return { started: started.promise, release: gate.resolve };
}

describe("OpenCode revert response recovery", () => {
  for (const newerCut of [undefined, 24]) {
    test(`a delayed undo cannot overwrite a newer session.updated cut=${newerCut}`, async () => {
      const fake = openCodeFake();
      const server = revertServer(fake, 26);
      server.publishActions = false;
      const delayed = delayAction(fake, "revert");
      const provider = openCodeProvider(fake);
      try {
        await connected(fake, provider);
        server.externalRevert({ messageID: openCodeMessageId(20) });
        await waitForSnapshot(provider, (rows) => rows.at(-1) === openCodeMessageId(19));
        const undo = provider.performSessionAction!(SESSION, {
          kind: "undo",
          messageId: openCodeMessageId(10),
        });
        await delayed.started;
        // Another client redid or changed the revert while Undo was in flight.
        server.externalRevert(
          newerCut === undefined
            ? undefined
            : {
                messageID: openCodeMessageId(newerCut),
              },
        );
        const end = newerCut ?? 26;
        await waitForSnapshot(provider, (rows) => rows.at(-1) === openCodeMessageId(end - 1));
        const reads = fake.sessionGetCallCount;
        delayed.release();
        await undo;
        // Even before a reread, the event's marker must survive the stale response.
        const state = await provider.sessionStateSnapshot!(SESSION);
        if (newerCut === undefined) expect(state.notices).toBeUndefined();
        else
          expect(state.notices).toContainEqual(
            expect.objectContaining({
              occurrenceId: `opencode-revert:${openCodeMessageId(newerCut)}:`,
            }),
          );
        expect(await readAll(provider, await snapshot(provider))).toEqual(ids(0, end));
        expect(fake.sessionGetCallCount).toBeGreaterThan(reads);
      } finally {
        delayed.release();
        await provider.dispose?.();
      }
    });
  }

  for (const firstKind of ["undo", "redo"] as const) {
    test(`concurrent ${firstKind} and its inverse reconcile responses completed in reverse order`, async () => {
      const fake = openCodeFake();
      const server = revertServer(fake, 26);
      server.publishActions = false;
      const first = delayAction(fake, firstKind === "undo" ? "revert" : "unrevert");
      const second = delayAction(fake, firstKind === "undo" ? "unrevert" : "revert");
      const provider = openCodeProvider(fake);
      try {
        await connected(fake, provider);
        await snapshot(provider);
        const action = (kind: "undo" | "redo") =>
          provider.performSessionAction!(SESSION, {
            kind,
            ...(kind === "undo" ? { messageId: openCodeMessageId(20) } : {}),
          });
        const firstResult = action(firstKind);
        await first.started;
        const secondResult = action(firstKind === "undo" ? "redo" : "undo");
        await second.started;
        second.release();
        await secondResult;
        const reads = fake.sessionGetCallCount;
        first.release();
        await firstResult;
        const expected = ids(0, firstKind === "undo" ? 26 : 20);
        expect(await readAll(provider, await snapshot(provider))).toEqual(expected);
        expect(fake.sessionGetCallCount).toBeGreaterThan(reads);
        // Once reconciled, later reads use the fresh marker.
        const reconciledReads = fake.sessionGetCallCount;
        await snapshot(provider);
        expect(fake.sessionGetCallCount).toBe(reconciledReads);
      } finally {
        first.release();
        second.release();
        await provider.dispose?.();
      }
    });
  }

  for (const response of [
    { data: { id: "another-session" } },
    { data: null },
    { data: { id: SESSION, revert: { messageID: 42 } } },
  ]) {
    test(`an invalid action response invalidates marker freshness: ${JSON.stringify(response)}`, async () => {
      const fake = openCodeFake();
      const server = revertServer(fake, 26);
      server.publishActions = false;
      const provider = openCodeProvider(fake);
      try {
        await connected(fake, provider);
        await provider.performSessionAction!(SESSION, {
          kind: "undo",
          messageId: openCodeMessageId(20),
        });
        await snapshot(provider);
        Object.assign(fake.client.session, { unrevert: async () => response });
        // The server has redone the turn; the malformed answer cannot prove it.
        fake.setSessionGetResponse(SESSION, { data: { id: SESSION } });
        const reads = fake.sessionGetCallCount;
        await provider.performSessionAction!(SESSION, { kind: "redo" });
        expect(await readAll(provider, await snapshot(provider))).toEqual(ids(0, 26));
        expect(fake.sessionGetCallCount).toBeGreaterThan(reads);
      } finally {
        await provider.dispose?.();
      }
    });
  }

  test("failed session reads retain the prior marker and retry until recovery", async () => {
    const fake = openCodeFake();
    const server = revertServer(fake, 26);
    server.publishActions = false;
    const provider = openCodeProvider(fake);
    try {
      await connected(fake, provider);
      await provider.performSessionAction!(SESSION, {
        kind: "undo",
        messageId: openCodeMessageId(20),
      });
      await snapshot(provider);
      Object.assign(fake.client.session, { unrevert: async () => ({ data: null }) });
      await provider.performSessionAction!(SESSION, { kind: "redo" });
      fake.setSessionGetError(new Error("session unavailable"));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const reads = fake.sessionGetCallCount;
        expect(rowIds((await snapshot(provider)).messages).at(-1)).toBe(openCodeMessageId(19));
        expect(fake.sessionGetCallCount).toBeGreaterThan(reads);
        expect((await provider.sessionStateSnapshot!(SESSION)).notices).toContainEqual(
          expect.objectContaining({ kind: "advisory" }),
        );
      }
      fake.setSessionGetError(null);
      fake.setSessionGetResponse(SESSION, { data: { id: SESSION } });
      expect(await readAll(provider, await snapshot(provider))).toEqual(ids(0, 26));
      expect((await provider.sessionStateSnapshot!(SESSION)).notices).toBeUndefined();
      const reads = fake.sessionGetCallCount;
      await snapshot(provider);
      expect(fake.sessionGetCallCount).toBe(reads);
    } finally {
      await provider.dispose?.();
    }
  });
});

describe("OpenCode undo and redo in the transcript", () => {
  test("undo hides the reverted turn in the snapshot and every page; redo restores it", async () => {
    const fake = openCodeFake();
    const server = revertServer(fake, 26);
    // The action's own answer must be enough; the event is checked below.
    server.publishActions = false;
    const provider = openCodeProvider(fake);
    try {
      await connected(fake, provider);
      const before = await snapshot(provider);
      expect(before.complete).toBe(false);
      expect(await readAll(provider, before)).toEqual(ids(0, 26));

      const outcome = await provider.performSessionAction!(SESSION, {
        kind: "undo",
        messageId: openCodeMessageId(20),
      });
      expect(outcome).toEqual({ outcome: "applied" });
      expect(server.calls.revert).toEqual([
        { sessionID: SESSION, messageID: openCodeMessageId(20) },
      ]);

      const reverted = await snapshot(provider);
      expect(reverted.sourceToken).not.toBe(before.sourceToken);
      // Paged history and cursors named before the revert must expire.
      expect(reverted.historyEpoch).not.toBe(before.historyEpoch);
      expect(rowIds(reverted.messages).at(-1)).toBe(openCodeMessageId(19));
      expect(await readAll(provider, reverted)).toEqual(ids(0, 20));
      // Nothing was deleted in OpenCode.
      expect(server.history.messages).toHaveLength(26);

      const state = await provider.sessionStateSnapshot!(SESSION);
      expect(state.notices).toContainEqual(
        expect.objectContaining({ kind: "advisory", severity: "info" }),
      );
      expect(state.phase).toBe("idle");

      // The `session.updated` OpenCode publishes carries the same marker.
      server.externalRevert({ messageID: openCodeMessageId(20) });
      await waitUntil(() => fake.subscriptions[0] !== undefined);
      const echoed = await waitForSnapshot(provider, (rows) => rows.length > 0);
      expect(echoed.historyEpoch).toBe(reverted.historyEpoch);
      expect(rowIds(echoed.messages)).toEqual(rowIds(reverted.messages));

      await provider.performSessionAction!(SESSION, { kind: "redo" });
      expect(server.calls.unrevert).toHaveLength(1);
      const restored = await snapshot(provider);
      expect(restored.historyEpoch).not.toBe(reverted.historyEpoch);
      expect(await readAll(provider, restored)).toEqual(ids(0, 26));
      expect((await provider.sessionStateSnapshot!(SESSION)).notices).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  test("the prompt that deletes the reverted turn leaves no gap", async () => {
    const fake = openCodeFake();
    const server = revertServer(fake, 26);
    const provider = openCodeProvider(fake);
    try {
      await connected(fake, provider);
      await snapshot(provider);
      await provider.performSessionAction!(SESSION, {
        kind: "undo",
        messageId: openCodeMessageId(20),
      });
      const reverted = await waitForSnapshot(
        provider,
        (rows) => rows.at(-1) === openCodeMessageId(19),
      );

      server.prompt();
      const next = await waitForSnapshot(provider, (rows) => rows.at(-1) === openCodeMessageId(27));
      expect(next.historyEpoch).not.toBe(reverted.historyEpoch);
      const expected = [...ids(0, 20), openCodeMessageId(26), openCodeMessageId(27)];
      expect(server.history.messages.map(({ info }) => info.id)).toEqual(expected);
      expect(await readAll(provider, next)).toEqual(expected);
      expect((await provider.sessionStateSnapshot!(SESSION)).notices).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  test("a revert made before the backend saw the session is read from it", async () => {
    // A restarted backend, or a revert from OpenCode's own TUI while the
    // stream was down: no event says so, so the first read asks the session.
    const fake = openCodeFake();
    const server = revertServer(fake, 26);
    server.publishActions = false;
    server.externalRevert({ messageID: openCodeMessageId(10) });
    const provider = openCodeProvider(fake);
    try {
      // A short tail read that the revert covers entirely: nothing on screen,
      // and the read's oldest message still names the cursor to older rows.
      const tail = await provider.transcriptSnapshot!(SESSION, {
        limit: 8,
        targetBytes: 512 * 1024,
      });
      if (!("messages" in tail)) throw new Error("expected a transcript snapshot");
      expect(fake.sessionGetCalls).toContainEqual({ sessionID: SESSION });
      expect(tail.messages).toEqual([]);
      expect(tail.complete).toBe(false);
      expect(await readAll(provider, tail)).toEqual(ids(0, 10));
    } finally {
      await provider.dispose?.();
    }
  });

  test("a partial revert hides the rest of its message from the reverted part on", async () => {
    const fake = openCodeFake();
    // Short steps, so the whole session fits the window before and after.
    const server = revertServer(fake, 26, (index) => `${index}:`);
    const target = server.history.messages[15]!;
    target.parts.push({
      id: "part-15-late",
      messageID: target.info.id,
      type: "text",
      text: "late text in the reverted part",
    });
    const provider = openCodeProvider(fake);
    try {
      await connected(fake, provider);
      await snapshot(provider);
      server.externalRevert({ messageID: target.info.id, partID: "part-15-late" });
      const reverted = await waitForSnapshot(
        provider,
        (rows) => rows.at(-1) === openCodeMessageId(15),
      );
      expect(await readAll(provider, reverted)).toEqual(ids(0, 16));
      const serialized = JSON.stringify(reverted.messages);
      expect(serialized).toContain("15:");
      expect(serialized).not.toContain("late text in the reverted part");

      server.externalRevert(undefined);
      const restored = await waitForSnapshot(
        provider,
        (rows) => rows.at(-1) === openCodeMessageId(25),
      );
      expect(JSON.stringify(restored.messages)).toContain("late text in the reverted part");
    } finally {
      await provider.dispose?.();
    }
  });
});

describe("OpenCode undo through the native projection", () => {
  test("the progressive view drops the reverted turn and gets it back on redo", async () => {
    const fake = openCodeFake();
    const server = revertServer(fake, 26, (index) => `${index}:`);
    const provider = openCodeProvider(fake);
    const identity = {
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "env-env-1:opencode-revert",
    };
    const liveWindow = { messages: 100, targetBytes: 512 * 1024 } as const;
    try {
      await withService(
        { prefix: "orkestrator-opencode-revert-", provider: async () => provider },
        async ({ service }) => {
          const view = async () => {
            const update = await service.getTranscriptUpdate({
              ...identity,
              viewVersion: 1,
              liveWindow,
              forceSnapshot: true,
            });
            if (update.status !== "snapshot") throw new Error("expected a snapshot");
            return update.value;
          };
          await service.ensureSession(identity);
          await waitUntil(() => fake.subscriptions.length === 1);
          const before = await view();
          expect(rowIds(before.messages)).toEqual(ids(0, 26));

          await service.performProjectionAction({
            ...identity,
            action: { kind: "undo", messageId: openCodeMessageId(20) },
          });
          const reverted = await view();
          expect(rowIds(reverted.messages)).toEqual(ids(0, 20));
          expect(reverted.historyEpoch).not.toBe(before.historyEpoch);
          expect(server.history.messages).toHaveLength(26);

          await service.performProjectionAction({ ...identity, action: { kind: "redo" } });
          const restored = await view();
          expect(rowIds(restored.messages)).toEqual(ids(0, 26));
        },
      );
    } finally {
      await provider.dispose?.();
    }
  });
});
