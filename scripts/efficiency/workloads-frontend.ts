/**
 * Frontend history accounting (E10): serialization visits when one live-tail
 * message changes while 0/1/8 MiB of history is retained.
 *
 * Runs the renderer's real projection store. The mounted hook is React-bound,
 * so its per-install work is reproduced here with the same calls it makes:
 * measure the retained history, then `setProjection` with the joined messages
 * and the sync-cache entry. At the baseline the hook measured with a private
 * `encodedBytes` (`TextEncoder` over `JSON.stringify`), reproduced verbatim.
 */
import { countingMessages, newTally } from "./counters.js";
import { textMessages, type FixtureMessage } from "./fixtures.js";
import type { CaseDefinition, WorkloadContext, WorkloadDefinition } from "./harness.js";

type Json = Record<string, unknown>;

interface StoreModule {
  useNativeAgentProjectionStore: {
    getState(): {
      setProjection(key: string, projection: Json | null, sync?: Json | null): void;
      reset(): void;
      projectionBytes: ReadonlyMap<string, number>;
    };
  };
}

const HISTORY_MESSAGE_BYTES = 4 * 1024;
const LIVE_MESSAGES = 100;
const LIVE_MESSAGE_BYTES = 1024;
const SESSION_KEY = "env-1\0codex\0efficiency";

export async function frontendAccountingWorkload(
  context: WorkloadContext,
): Promise<WorkloadDefinition> {
  const store = await context.load<StoreModule>(
    "apps/web/src/stores/nativeAgentProjectionStore.ts",
  );
  const accounting = await context.loadOptional<{
    retainedHistoryBytes: (messages: readonly unknown[]) => number;
  }>("apps/web/src/lib/native-history-accounting.ts");
  // The baseline hook's own measurement (useNativeAgentSession.ts at e8fbf1d0).
  const measureHistory =
    accounting?.retainedHistoryBytes ??
    ((messages: readonly unknown[]) =>
      new TextEncoder().encode(JSON.stringify(messages)).byteLength);

  const install = (history: FixtureMessage[], live: FixtureMessage[]) => {
    const historyBytes = measureHistory(history);
    const liveProjection = {
      platform: "codex",
      environmentId: "env-1",
      messages: live,
      revision: 1,
    };
    store.useNativeAgentProjectionStore.getState().setProjection(
      SESSION_KEY,
      { ...liveProjection, messages: [...history, ...live] },
      {
        liveProjection,
        historyComplete: false,
        historyMessages: history,
        historyBytes,
      },
    );
  };

  const caseFor = (mebibytes: number): CaseDefinition => ({
    id: `history-${mebibytes}MiB`,
    description: `${mebibytes} MiB retained history + ${LIVE_MESSAGES}-message live tail; one tail message changes`,
    run: async () => {
      store.useNativeAgentProjectionStore.getState().reset();
      const tally = newTally();
      const historyCount = Math.round((mebibytes * 1024 * 1024) / HISTORY_MESSAGE_BYTES);
      const history = countingMessages(
        textMessages(historyCount, HISTORY_MESSAGE_BYTES, { prefix: "h" }),
        tally,
      );
      const live = countingMessages(
        textMessages(LIVE_MESSAGES, LIVE_MESSAGE_BYTES, { prefix: "l" }),
        tally,
      );
      install(history, live);
      const firstInstallVisits = tally.messages;
      tally.messages = 0;
      const changed = [...live];
      changed[changed.length - 1] = countingMessages(
        [{ ...live.at(-1)!, content: `${live.at(-1)!.content} more` }],
        tally,
      )[0]!;
      const started = performance.now();
      install(history, changed);
      const measuredMs = performance.now() - started;
      const updateVisits = tally.messages;
      const accounted = store.useNativeAgentProjectionStore
        .getState()
        .projectionBytes.get(SESSION_KEY);
      const exact = Buffer.byteLength(JSON.stringify([...history, ...changed]));
      store.useNativeAgentProjectionStore.getState().reset();
      return {
        counters: {
          historyMessages: historyCount,
          firstInstallMessageVisits: firstInstallVisits,
          tailUpdateMessageVisits: updateVisits,
          accountedBytesExact: accounted === exact,
        },
        measuredMs,
      };
    },
  });

  return {
    id: "g-frontend-accounting",
    title: "Frontend accounting: tail update with retained history",
    findings: ["E10"],
    fixture: {
      historyMiB: "0,1,8",
      historyMessageBytes: HISTORY_MESSAGE_BYTES,
      liveMessages: LIVE_MESSAGES,
      liveMessageBytes: LIVE_MESSAGE_BYTES,
    },
    method:
      "Real nativeAgentProjectionStore.setProjection plus the hook's history measurement; message visits counted by non-enumerable toJSON; accounted bytes checked against an exact encode.",
    cases: [0, 1, 8].map(caseFor),
  };
}
