/**
 * Storage workloads: display-tail persistence (E04) and Codex rollout reads
 * (E08). Both run against temporary directories that are removed afterwards.
 */
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { measureIo } from "./counters.js";
import {
  FIXTURE_CREATED_AT,
  interruptedJsonl,
  rolloutJsonl,
  rolloutTimestampMs,
  textMessages,
} from "./fixtures.js";
import type { CaseDefinition, WorkloadContext, WorkloadDefinition } from "./harness.js";

type Json = Record<string, unknown>;

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(entryPath) : (await stat(entryPath)).size;
  }
  return total;
}

/**
 * Syscall byte counts vary by a few dozen bytes between runs (the process
 * reads small files lazily), so they are reported in rounded KiB; -1 where
 * `/proc/self/io` is unavailable.
 */
function kib(bytes: number | undefined): number {
  return bytes === undefined ? -1 : Math.round(bytes / 1024);
}

async function withTempDir<T>(prefix: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// --- (d) Display-tail storage ----------------------------------------------------

interface StorageLike {
  init(): Promise<void>;
  getNativeAgentDisplayTail(key: string): Promise<unknown>;
  putNativeAgentDisplayTail(key: string, tail: unknown): Promise<boolean>;
  nativeAgentDisplayTailStore?: () => { records: { stats(): Record<string, number> } };
}

export async function displayTailWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const storageModule = await context.load<{
    StorageService: new (dataDir: string) => StorageLike;
  }>("apps/backend/src/core/storage.ts");
  const tails = await context.load<{ createNativeAgentDisplayTail: (input: Json) => unknown }>(
    "apps/backend/src/core/native-agent-display-tails.ts",
  );
  const shared = await context.load<{
    nativeAgentSessionStorageKey: (environmentId: string, agent: string, logical: string) => string;
  }>("apps/backend/src/core/native-agent-service-shared.ts");
  const recordStore = await context.loadOptional(
    "apps/backend/src/core/native-agent-display-tail-store.ts",
  );

  const key = (index: number) =>
    shared.nativeAgentSessionStorageKey("env-1", "codex", `s-${index}`);
  const tail = (index: number, revision: number) =>
    tails.createNativeAgentDisplayTail({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: `s-${index}`,
      providerSessionId: `p-${index}`,
      historyEpoch: `e-${revision}`,
      messages: textMessages(20, 2 * 1024, { prefix: `t${index}r${revision}-` }),
      historyComplete: true,
      updatedAt: FIXTURE_CREATED_AT,
    });
  const recordStats = (storage: StorageLike): Record<string, number> | undefined =>
    storage.nativeAgentDisplayTailStore?.().records.stats();
  const statDelta = (before?: Record<string, number>, after?: Record<string, number>) => {
    const delta: Record<string, number> = {};
    for (const name of [
      "payloadReads",
      "headerReads",
      "payloadWrites",
      "bytesWritten",
      "indexWrites",
    ]) {
      delta[name] = (after?.[name] ?? 0) - (before?.[name] ?? 0);
    }
    return delta;
  };

  const caseFor = (records: number): CaseDefinition => ({
    id: `records-${records}`,
    description: `${records} persisted tails of ~40 KiB; update one, then cold-read one`,
    repetitions: 3,
    run: () =>
      withTempDir("orkestrator-efficiency-tails-", async (dataDir) => {
        const storage = new storageModule.StorageService(dataDir);
        await storage.init();
        for (let index = 0; index < records; index += 1) {
          if (!(await storage.putNativeAgentDisplayTail(key(index), tail(index, 1)))) {
            throw new Error("display tail fixture was rejected");
          }
        }
        const updateBefore = recordStats(storage);
        const started = performance.now();
        const update = await measureIo(() => storage.putNativeAgentDisplayTail(key(0), tail(0, 2)));
        const updateMs = performance.now() - started;
        const updateStats = statDelta(updateBefore, recordStats(storage));

        const cold = new storageModule.StorageService(dataDir);
        await cold.init();
        const coldBefore = recordStats(cold);
        const read = await measureIo(() => cold.getNativeAgentDisplayTail(key(records - 1)));
        const coldStats = statDelta(coldBefore, recordStats(cold));
        if (!read.result) throw new Error("cold read missed the persisted tail");
        return {
          counters: {
            store: recordStore ? "keyed-records" : "shared-file",
            updateKiBRead: kib(update.io?.readBytes),
            updateKiBWritten: kib(update.io?.writeBytes),
            // The shared file is parsed and rewritten whole: every record is a
            // payload read on each operation. Derived, not observed.
            updatePayloadReads: recordStore ? updateStats.payloadReads! : records,
            updatePayloadWrites: recordStore ? updateStats.payloadWrites! : records,
            coldReadKiBRead: kib(read.io?.readBytes),
            coldReadPayloadReads: recordStore ? coldStats.payloadReads! : records,
            diskKiB: kib(await directoryBytes(dataDir)),
          },
          measuredMs: updateMs,
        };
      }),
  });

  return {
    id: "d-display-tail-storage",
    title: "Display-tail storage: one update and one cold read",
    findings: ["E04"],
    fixture: { records: "1,32,128", messagesPerTail: 20, messageBytes: 2 * 1024 },
    method:
      "Real StorageService on a temp data dir. KiB are /proc/self/io rchar/wchar deltas around the awaited call, rounded (Linux; -1 elsewhere), and include backups and index files. HEAD payload counts come from KeyedRecordStore.stats(); the baseline shared file is parsed whole, so its payload counts equal the record count (derived).",
    cases: [1, 32, 128].map(caseFor),
  };
}

// --- (h) Codex rollout ------------------------------------------------------------

interface CodexBaselineCache {
  readCachedTranscript?: (path: string) => Promise<{ records: unknown[] }>;
  readTranscriptSince?: (
    path: string,
    since: number,
  ) => Promise<{ records: unknown[]; status: string }>;
  acquireTranscriptSnapshot?: (
    path: string,
  ) => Promise<{ unreadableRecords: number; status: string }>;
  setTranscriptCacheLimitsForTesting: (overrides?: Json) => void;
  clearTranscriptCache: () => void;
  getTranscriptCacheStats: () => Record<string, number>;
}

/** Reads one rollout the way this root's consumers do; counts full parses. */
function rolloutReader(cache: CodexBaselineCache) {
  const previous = new Map<string, unknown>();
  let fullParses = 0;
  let bytesRead = 0;
  return {
    bounded: typeof cache.readTranscriptSince === "function",
    async readSince(file: string, sinceMs: number): Promise<number> {
      if (cache.readTranscriptSince) {
        return (await cache.readTranscriptSince(file, sinceMs)).records.length;
      }
      // Baseline: the whole-file cache, filtered by the consumer.
      const transcript = await cache.readCachedTranscript!(file);
      // An unchanged file returns the cached object; a new object at the same
      // size is a reload from scratch (`readFile` of the whole rollout) — the
      // self-eviction thrash. The fixtures never append, so no partial reads.
      if (previous.get(file) !== transcript) {
        fullParses += 1;
        bytesRead += (await stat(file)).size;
      }
      previous.set(file, transcript);
      return transcript.records.filter(
        (record) => Date.parse(String((record as { timestamp?: unknown }).timestamp)) >= sinceMs,
      ).length;
    },
    counters(): Record<string, number> {
      const stats = cache.getTranscriptCacheStats();
      return cache.readTranscriptSince
        ? {
            fullParses: stats.coldScans ?? 0,
            coldScans: stats.coldScans ?? 0,
            blockRereads: stats.blockRereads ?? 0,
            sourceBytesRead: stats.sourceBytesRead ?? 0,
            retainedEstimateBytes: stats.bytes ?? 0,
            cachedEntries: stats.entries ?? 0,
          }
        : {
            fullParses,
            coldScans: fullParses,
            blockRereads: 0,
            sourceBytesRead: bytesRead,
            // The baseline budget counted source bytes, not parsed heap.
            retainedEstimateBytes: stats.bytes ?? 0,
            cachedEntries: stats.entries ?? 0,
          };
    },
  };
}

export async function codexRolloutWorkload(context: WorkloadContext): Promise<WorkloadDefinition> {
  const cache = await context.load<CodexBaselineCache>(
    "bridges/codex-bridge/src/transcript-cache.ts",
  );
  const padding = 400;
  const scenario = (
    id: string,
    description: string,
    limits: Json,
    files: number[],
    reads: number,
    tailRecords: number,
  ): CaseDefinition => ({
    id,
    description,
    repetitions: 3,
    run: () =>
      withTempDir("orkestrator-efficiency-codex-", async (directory) => {
        cache.clearTranscriptCache();
        cache.setTranscriptCacheLimitsForTesting(limits);
        try {
          const paths: string[] = [];
          for (const [index, records] of files.entries()) {
            const file = path.join(directory, `rollout-${index}.jsonl`);
            await writeFile(file, rolloutJsonl(records, padding));
            paths.push(file);
          }
          const reader = rolloutReader(cache);
          let returned = 0;
          const started = performance.now();
          for (let read = 0; read < reads; read += 1) {
            for (const [index, file] of paths.entries()) {
              const since = rolloutTimestampMs(Math.max(0, files[index]! - tailRecords));
              returned = await reader.readSince(file, since);
            }
          }
          const measuredMs = performance.now() - started;
          let sourceBytes = 0;
          for (const file of paths) sourceBytes += (await stat(file)).size;
          return {
            counters: { ...reader.counters(), sourceBytes, recordsReturnedLastRead: returned },
            measuredMs,
          };
        } finally {
          cache.clearTranscriptCache();
          cache.setTranscriptCacheLimitsForTesting();
        }
      }),
  });
  // Injectable budgets, as the step-10 tests use: small enough that a fixture
  // of a few hundred KiB crosses them. `blockSourceBytes` is HEAD-only and
  // ignored by the baseline's limit object.
  const softCapped = {
    softBudgetBytes: 16 * 1024,
    hardBudgetBytes: 4 * 1024 * 1024,
    activeGraceMs: 60_000,
    blockSourceBytes: 8 * 1024,
  };
  const hardCapped = {
    softBudgetBytes: 16 * 1024,
    hardBudgetBytes: 64 * 1024,
    activeGraceMs: 60_000,
    blockSourceBytes: 8 * 1024,
  };
  return {
    id: "h-codex-rollout",
    title: "Codex rollout reads under soft and hard cache budgets",
    findings: ["E08"],
    fixture: {
      recordPaddingBytes: padding,
      small: "1 file × 64 records, default budgets, 10 whole-file reads",
      softCap: "2 files × 128 records, soft 16 KiB / hard 4 MiB, 10 alternating tail reads",
      hardCap: "1 file × 512 records, soft 16 KiB / hard 64 KiB, 20 tail reads",
    },
    method:
      "HEAD: readTranscriptSince + getTranscriptCacheStats (coldScans, blockRereads, sourceBytesRead, estimated retained heap). Baseline: readCachedTranscript + timestamp filter; a full parse is a new cached object at unchanged size and reads the whole file; its budget counted source bytes, not heap.",
    cases: [
      scenario("small", "small rollout, default budgets", {}, [64], 10, 64),
      scenario(
        "above-soft-cap",
        "working set above the soft cap, both files active",
        softCapped,
        [128, 128],
        10,
        8,
      ),
      scenario(
        "above-hard-cap",
        "single file above the hard cap, repeated tail reads",
        hardCapped,
        [512],
        20,
        8,
      ),
      {
        id: "interrupted-jsonl",
        description: "one corrupt middle record and an unterminated final record",
        run: () =>
          withTempDir("orkestrator-efficiency-codex-", async (directory) => {
            cache.clearTranscriptCache();
            const file = path.join(directory, "rollout.jsonl");
            await writeFile(file, interruptedJsonl(64, padding));
            try {
              const started = performance.now();
              const records = cache.readTranscriptSince
                ? (await cache.readTranscriptSince(file, 0)).records.length
                : (await cache.readCachedTranscript!(file)).records.length;
              const measuredMs = performance.now() - started;
              const snapshot = await cache.acquireTranscriptSnapshot?.(file);
              return {
                counters: {
                  recordsReturned: records,
                  unreadableMarkers: snapshot?.unreadableRecords ?? 0,
                  status: snapshot?.status ?? "not-reported",
                },
                measuredMs,
              };
            } finally {
              cache.clearTranscriptCache();
            }
          }),
      },
    ],
  };
}
