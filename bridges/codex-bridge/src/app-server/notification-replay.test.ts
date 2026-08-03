/**
 * Replays every committed fixture through the production rendering pipeline.
 *
 * Two distinct jobs:
 *
 *  1. **Snapshot the structure** of what each recording renders to, so a Codex
 *     upgrade that changes a field name shows up as a snapshot diff instead of a
 *     blank transcript in the UI.
 *  2. **Assert no unknown methods or unsupported item types**, which is the
 *     earlier and louder signal — those mean the pinned protocol has moved.
 *
 * Adding a fixture requires no registration: drop a scrubbed `*.jsonl` into
 * `../testing/fixtures/` and it is picked up here.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NotificationRecorder } from "./notification-recorder.js";
import { replayRecording, summarizeForSnapshot } from "../testing/replay-recording.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "testing", "fixtures");

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

function readFixture(name: string): string[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8").split("\n");
}

describe("recorded app-server stream replay", () => {
  const names = fixtureNames();

  // Guards against the whole suite silently passing because the directory is
  // empty (e.g. fixtures excluded from a package build).
  test("fixtures are present", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    describe(name, () => {
      test("renders to a stable structure", async () => {
        const summary = await replayRecording(readFixture(name));
        expect(summarizeForSnapshot(summary)).toMatchSnapshot();
      });

      test("uses no unknown methods or unrenderable items", async () => {
        const summary = await replayRecording(readFixture(name));
        // If this fails after a Codex bump, the protocol added something the
        // reducer drops on the floor. Follow docs/upgrade-agents.md.
        expect(summary.unknownMethods).toEqual([]);
        expect(summary.unsupportedItemTypes).toEqual([]);
        expect(summary.invalidLines).toBe(0);
      });
    });
  }
});

describe("synthetic-full-turn fixture", () => {
  test("renders each turn with the expected phases and parts", async () => {
    const summary = await replayRecording(readFixture("synthetic-full-turn.jsonl"));

    expect(summary.turns).toHaveLength(3);
    const [first, second, third] = summary.turns;

    expect(first.phase).toBe("completed");
    expect(first.content).toBe("Listed the workspace and updated the README.");
    // Reasoning, command, web search, patch, message — in stream order.
    expect(first.parts.map((part) => part.type)).toEqual([
      "thinking",
      "tool-invocation",
      "tool-invocation",
      "tool-invocation",
      "text",
    ]);
    expect(first.finalDiff).toContain("+Added line");

    // Interrupted mid-delta: the partial text must still render, since that is
    // what the user saw on screen when they hit stop.
    expect(second.phase).toBe("interrupted");
    expect(second.content).toBe("Working on it");

    // A failed turn keeps the structured code so the UI can special-case it.
    // `CodexErrorInfo` is externally tagged: a bare string for unit variants, an
    // object with a single key for the ones carrying data.
    expect(third.phase).toBe("failed");
    expect(third.error?.code).toBe("usageLimitExceeded");
  });

  test("command output deltas render before the aggregated output lands", async () => {
    // Truncate the fixture just before `item/completed` for the command.
    const lines = readFixture("synthetic-full-turn.jsonl").filter(
      (line) => !line.includes('"aggregatedOutput"'),
    );
    const summary = await replayRecording(lines);
    const command = summary.turns[0]?.parts.find((part) => part.toolName === "bash");
    // `content` is the command; the streamed output is spliced into `toolOutput`.
    expect(command?.content).toBe("ls -1");
    expect(command?.toolOutput).toContain("README.md");
    expect(command?.toolOutput).toContain("src");
    // Still pending: the authoritative item never arrived in this truncated run.
    expect(command?.toolState).toBe("pending");
  });

  test("applies the caller's command-output memory cap", async () => {
    const lines = readFixture("synthetic-full-turn.jsonl").filter(
      (line) => !line.includes('"aggregatedOutput"'),
    );
    const summary = await replayRecording(lines, { maxCommandOutputChars: 4 });
    const command = summary.turns[0]?.parts.find((part) => part.toolName === "bash");

    expect(command?.toolOutput).toBe("READ\n… output truncated");
  });

  test("ignored bookkeeping notifications do not become unknown methods", async () => {
    const summary = await replayRecording(readFixture("synthetic-full-turn.jsonl"));
    // The fixture contains thread/tokenUsage/updated, which is deliberately
    // ignored rather than unknown.
    expect(summary.unknownMethods).toEqual([]);
    expect(summary.counts.notifications).toBeGreaterThan(20);
  });

  test("a genuinely new method is reported rather than dropped", async () => {
    const lines = [
      ...readFixture("synthetic-full-turn.jsonl"),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "turn/somethingBrandNew",
        params: { threadId: "t", turnId: "turn-1" },
      }),
    ];
    const summary = await replayRecording(lines);
    expect(summary.unknownMethods).toEqual(["turn/somethingBrandNew"]);
  });

  test("classifies responses, server requests, invalid lines, and unsupported items", async () => {
    const summary = await replayRecording([
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
      }),
      "{not valid json",
      JSON.stringify({ __recorderNotice: "metadata, not protocol" }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "item-1", type: "futureItemVariant" },
        },
      }),
    ]);

    expect(summary.counts).toEqual({
      notifications: 1,
      responses: 1,
      serverRequests: 1,
    });
    expect(summary.serverRequestMethods).toEqual([
      "item/commandExecution/requestApproval",
    ]);
    expect(summary.invalidLines).toBe(1);
    expect(summary.unsupportedItemTypes).toEqual(["futureItemVariant"]);
  });
});

describe("synthetic-raw-apply-patch fixture", () => {
  const read = () => readFixture("synthetic-raw-apply-patch.jsonl");

  /**
   * Raw `apply_patch` calls are the only representation of a patch when Codex
   * emits no structured `fileChange`. They arrive as `item.dynamic.started` /
   * `item.dynamic.output`, which are *known* kinds — so a replay that dropped
   * them would report no unknown methods and no unsupported items, and this
   * harness would call a transcript missing every patch a clean pass.
   */
  test("replays raw patch calls rather than dropping them on the floor", async () => {
    const summary = await replayRecording(read());
    const [turn] = summary.turns;

    expect(summary.unknownMethods).toEqual([]);
    expect(summary.unsupportedItemTypes).toEqual([]);
    expect(turn?.phase).toBe("completed");

    const patches = (turn?.parts ?? []).filter((part) => part.toolName === "apply_patch");
    expect(patches.map((part) => [part.toolTitle, part.toolState])).toEqual([
      // Structured item wins for the call id it shares with the raw call…
      ["update: /replay/workspace/README.md", "success"],
      // …while a raw-only patch still renders one card per file…
      ["update: src/a.ts", "success"],
      ["add: src/b.ts", "success"],
      // …and a failure surfaces as a failure.
      ["update: src/missing.ts", "failure"],
    ]);
  });

  test("gives a raw-only patch a per-file diff, not an opaque blob of patch text", async () => {
    const summary = await replayRecording(read());
    const added = summary.turns[0]?.parts.find(
      (part) => part.toolTitle === "add: src/b.ts",
    );

    expect(added?.toolDiff).toMatchObject({
      filePath: "/replay/workspace/src/b.ts",
      additions: 1,
      deletions: 0,
    });
    expect(added?.toolDiff?.diff).toContain("--- /dev/null");
    expect(added?.toolArgs).toEqual({ path: "src/b.ts", kind: "add" });
  });

  test("the structured preview is not blanked by the raw call that follows it", async () => {
    // Truncate just before the structured completion: what remains is the
    // preview plus the raw call, which is the window a user actually watches
    // while a patch waits for approval.
    const lines = read().filter((line) => !line.includes('"fileChange"'));
    const summary = await replayRecording(lines);
    const preview = summary.turns[0]?.parts.find(
      (part) => part.toolTitle === "update: /replay/workspace/README.md",
    );

    expect(preview).toBeDefined();
    expect(preview?.toolName).toBe("apply_patch");
  });

  test("a successful raw-only patch stays hidden until the turn is terminal", async () => {
    const lines = read().filter((line) => !line.includes('"turn/completed"'));
    const summary = await replayRecording(lines);
    const titles = (summary.turns[0]?.parts ?? []).map((part) => part.toolTitle);

    expect(summary.turns[0]?.phase).not.toBe("completed");
    // The failure is not held back — nothing structured is coming for it.
    expect(titles).toContain("update: src/missing.ts");
    expect(titles).not.toContain("update: src/a.ts");
    expect(titles).not.toContain("add: src/b.ts");
  });
});

describe("NotificationRecorder", () => {
  function makeRecorder(overrides: Partial<ConstructorParameters<typeof NotificationRecorder>[0]> = {}) {
    const writes: string[] = [];
    const recorder = new NotificationRecorder({
      directory: "/tmp/does-not-exist",
      fileName: "test.jsonl",
      flushIntervalMs: 0,
      appendFileImpl: async (_path, contents) => {
        writes.push(contents);
      },
      ensureDirImpl: async () => undefined,
      ...overrides,
    });
    return { recorder, writes };
  }

  test("records lines verbatim", async () => {
    const { recorder, writes } = makeRecorder();
    recorder.record('{"jsonrpc":"2.0","method":"a"}');
    recorder.record('{"jsonrpc":"2.0","method":"b"}');
    await recorder.close();

    expect(writes.join("")).toBe('{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"b"}\n');
    expect(recorder.getStats().linesRecorded).toBe(2);
  });

  test("record() does not await the write", () => {
    let resolveWrite: (() => void) | undefined;
    const { recorder } = makeRecorder({
      appendFileImpl: () => new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
    });

    // The whole point: a hung disk must not block the read loop.
    recorder.record("line");
    expect(recorder.getStats().linesRecorded).toBe(1);
    resolveWrite?.();
  });

  test("stops at maxBytes and records why, instead of truncating a line", async () => {
    const { recorder, writes } = makeRecorder({ maxBytes: 40 });
    recorder.record("0123456789012345678");
    recorder.record("this one does not fit");
    await recorder.close();

    const written = writes.join("");
    expect(written).toContain("0123456789012345678");
    expect(written).not.toContain("this one does not fit");
    expect(written).toContain("recording stopped: max bytes reached");
    expect(recorder.getStats().capped).toBe(true);
    expect(recorder.getStats().linesDropped).toBe(1);
  });

  test("a write failure is counted, not thrown", async () => {
    const { recorder } = makeRecorder({
      appendFileImpl: async () => {
        throw new Error("disk full");
      },
    });
    recorder.record("line");
    await recorder.close();

    expect(recorder.getStats().writeErrors).toBe(1);
    expect(recorder.getStats().linesDropped).toBe(1);
  });

  test("close() flushes buffered lines", async () => {
    const { recorder, writes } = makeRecorder({ flushIntervalMs: 60_000 });
    recorder.record("buffered");
    expect(writes).toHaveLength(0);
    await recorder.close();
    expect(writes.join("")).toBe("buffered\n");
  });

  test("records nothing after close", async () => {
    const { recorder, writes } = makeRecorder();
    await recorder.close();
    recorder.record("too late");
    await recorder.flush();
    expect(writes).toHaveLength(0);
    expect(recorder.getStats().linesDropped).toBe(1);
  });
});
