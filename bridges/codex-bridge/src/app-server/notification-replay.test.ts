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
        // reducer drops on the floor. Follow docs/codex-upgrade-guide.md.
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
