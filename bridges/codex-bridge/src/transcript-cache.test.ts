import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTranscriptCache,
  getTranscriptCacheStats,
  readCachedTranscript,
  setTranscriptCacheLimitsForTesting,
} from "./transcript-cache.js";

const tempDirs: string[] = [];

afterEach(async () => {
  clearTranscriptCache();
  setTranscriptCacheLimitsForTesting();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempTranscript(filename = "session.jsonl"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-transcript-cache-"));
  tempDirs.push(dir);
  return join(dir, filename);
}

describe("readCachedTranscript", () => {
  test("appends only complete new lines across incremental reads", async () => {
    const transcriptPath = await createTempTranscript();
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call-spawn-1",
          arguments: "{}",
        },
      })}\n{"timestamp":"2026-04-16T11:17:24.000Z","type":"event_msg"`,
      "utf8",
    );

    const initial = await readCachedTranscript(transcriptPath);
    expect(initial.records).toHaveLength(1);

    await appendFile(
      transcriptPath,
      `${',"payload":{"type":"agent_message","phase":"commentary","message":"working"}}\n'}${JSON.stringify(
        {
          timestamp: "2026-04-16T11:17:25.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
          },
        },
      )}\n`,
      "utf8",
    );

    const updated = await readCachedTranscript(transcriptPath);
    expect(updated.records).toHaveLength(3);
    expect(updated.records[1]?.payload?.type).toBe("agent_message");
    expect(updated.records[2]?.payload?.type).toBe("task_complete");
  });

  test("reloads from scratch when the transcript file is replaced", async () => {
    const transcriptPath = await createTempTranscript();
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "old" },
      })}\n`,
      "utf8",
    );

    const initial = await readCachedTranscript(transcriptPath);
    expect(initial.records[0]?.payload?.message).toBe("old");

    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: "2026-04-16T11:18:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "new" },
      })}\n`,
      "utf8",
    );
    const replacementTime = new Date(Date.now() + 1000);
    await utimes(transcriptPath, replacementTime, replacementTime);

    const replaced = await readCachedTranscript(transcriptPath);
    expect(replaced.records).toHaveLength(1);
    expect(replaced.records[0]?.payload?.message).toBe("new");
  });

  test("an active entry larger than the soft budget stays cached", async () => {
    setTranscriptCacheLimitsForTesting({ softBudgetBytes: 64 });
    const transcriptPath = await createTempTranscript();
    const record = JSON.stringify({
      timestamp: "2026-04-16T11:17:23.623Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "x".repeat(200) },
    });
    await writeFile(transcriptPath, `${record}\n`, "utf8");

    await readCachedTranscript(transcriptPath);
    // Still cached: recently-accessed entries are protected past the soft
    // budget, so re-reads of an oversized working set stay incremental.
    expect(getTranscriptCacheStats().entries).toBe(1);
  });

  test("idle entries beyond the soft budget are evicted; the hard cap always holds", async () => {
    setTranscriptCacheLimitsForTesting({
      softBudgetBytes: 64,
      hardBudgetBytes: 400,
      activeGraceMs: 60_000,
    });
    const record = (message: string) =>
      `${JSON.stringify({
        timestamp: "2026-04-16T11:17:23.623Z",
        type: "event_msg",
        payload: { type: "agent_message", message },
      })}\n`;

    const first = await createTempTranscript("first.jsonl");
    await writeFile(first, record("a".repeat(200)), "utf8");
    await readCachedTranscript(first);

    const second = await createTempTranscript("second.jsonl");
    await writeFile(second, record("b".repeat(200)), "utf8");
    await readCachedTranscript(second);

    // Both are active and together exceed the hard cap, so LRU eviction
    // applies regardless of recency.
    expect(getTranscriptCacheStats().entries).toBe(1);

    setTranscriptCacheLimitsForTesting({ softBudgetBytes: 350, activeGraceMs: 0 });
    const third = await createTempTranscript("third.jsonl");
    await writeFile(third, record("c".repeat(200)), "utf8");
    await readCachedTranscript(third);

    // With no grace, entries beyond the soft budget are evicted oldest-first.
    expect(getTranscriptCacheStats().entries).toBe(1);
    expect(getTranscriptCacheStats().bytes).toBeLessThanOrEqual(350);
  });
});
