import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSnapshotHistory } from "./claude-transcript-tasks.js";
import { TmuxBackend } from "./tmux-backend.js";
import {
  TRANSCRIPT_WINDOW_MISSING_STATUS,
  parseTranscriptWindowOutput,
  transcriptWindowCommand,
} from "./tmux-shared.js";
import {
  TmuxTranscriptReader,
  cutTranscriptWindow,
  type TailLineSink,
  type TmuxTranscriptPage,
} from "./tmux-transcript-reader.js";

const SESSION = "session-1";
const jsonl = (value: unknown) => `${JSON.stringify(value)}\n`;
const noSink: TailLineSink = () => undefined;

const userLine = (n: number, text = `line ${n}`) => ({
  type: "user",
  uuid: `u${n}`,
  message: { role: "user", content: text },
});
const taskCreate = (id: string, subject: string) => ({
  type: "assistant",
  uuid: `use-${id}`,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "TaskCreate", input: { subject } }],
  },
});
const taskCreated = (id: string, taskNumber: number, subject: string) => ({
  type: "user",
  uuid: `result-${id}`,
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: `Task #${taskNumber} created successfully: ${subject}`,
      },
    ],
  },
});

describe("cutTranscriptWindow", () => {
  const limits = { pageBytes: 1024, pageLines: 100, unterminated: false };
  const bytes = (...lines: string[]) => Buffer.from(lines.join(""));

  test("a window from the start of the file keeps its first record", () => {
    const cut = cutTranscriptWindow({ start: 0, bytes: bytes('{"n":1}\n', '{"n":2}\n') }, limits);
    expect(cut.records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(cut.firstOffset).toBe(0);
  });

  test("a window from inside the file gives its possibly cut first line to the next page", () => {
    const cut = cutTranscriptWindow({ start: 50, bytes: bytes('n":1}\n', '{"n":2}\n') }, limits);
    expect(cut.records).toEqual([{ n: 2 }]);
    expect(cut.firstOffset).toBe(56);
  });

  test("drops an unterminated fragment, and keeps one that is a whole record at the tail", () => {
    const fragment = cutTranscriptWindow({ start: 0, bytes: bytes('{"n":1}\n', '{"n":') }, limits);
    expect(fragment.records).toEqual([{ n: 1 }]);
    expect(fragment.endOffset).toBe(8);

    const whole = cutTranscriptWindow(
      { start: 0, bytes: bytes('{"n":1}\n', '{"n":2}') },
      { ...limits, unterminated: true },
    );
    expect(whole.records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(whole.endOffset).toBe(15);
  });

  test("skips malformed and blank lines", () => {
    const cut = cutTranscriptWindow(
      { start: 0, bytes: bytes('{"n":1}\n', "not-json\n", "\n", '{"n":2}\n') },
      limits,
    );
    expect(cut.records).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("stops at the record bound, naming where the next page ends", () => {
    const cut = cutTranscriptWindow(
      { start: 0, bytes: bytes('{"n":1}\n', '{"n":2}\n', '{"n":3}\n') },
      { ...limits, pageLines: 2 },
    );
    expect(cut.records).toEqual([{ n: 2 }, { n: 3 }]);
    expect(cut.firstOffset).toBe(8);
  });

  test("stops at the byte bound, but always returns the newest record", () => {
    const cut = cutTranscriptWindow(
      { start: 0, bytes: bytes(`{"n":"${"x".repeat(40)}"}\n`, `{"n":"${"y".repeat(40)}"}\n`) },
      { ...limits, pageBytes: 10 },
    );
    expect(cut.records).toEqual([{ n: "y".repeat(40) }]);
  });

  test("reports a window that holds no whole record", () => {
    expect(
      cutTranscriptWindow({ start: 10, bytes: bytes("mid-record") }, limits).reachedRecord,
    ).toBe(false);
    expect(
      cutTranscriptWindow({ start: 10, bytes: bytes("end of record\n") }, limits).reachedRecord,
    ).toBe(false);
  });
});

/** The container read's script, run by a real `sh`, against what the local read answers. */
describe("transcriptWindowCommand", () => {
  let dir: string;
  let file: string;
  const content = Buffer.from(`${"é".repeat(50)}\n${"z".repeat(50)}\n`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ork-tmux-window-"));
    file = join(dir, "it's a transcript.jsonl");
    writeFileSync(file, content);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(end: number | undefined, maxBytes: number) {
    const result = spawnSync("/bin/sh", ["-c", transcriptWindowCommand(file, end, maxBytes)]);
    return { status: result.status, stdout: result.stdout };
  }

  test.each([
    ["the tail of the file", undefined, 20],
    ["a whole file smaller than the window", undefined, 10_000],
    ["a slice ending inside the file", 60, 20],
    ["a slice reaching the start", 30, 100],
    ["splitting a multi-byte character", 61, 2],
    ["nothing, at the very start", 0, 20],
    ["nothing, past the end of the file", content.length + 1, 20],
  ])("answers the same bytes as a local read: %s", async (_name, end, maxBytes) => {
    const { status, stdout } = run(end, maxBytes);
    expect(status).toBe(0);
    const local = await TmuxBackend.local(dir).readTranscriptWindow(file, end, maxBytes);
    expect(parseTranscriptWindowOutput(stdout)).toEqual(local!);
  });

  test("a missing file has its own status, and the local read answers undefined", async () => {
    rmSync(file);
    expect(run(undefined, 20).status).toBe(TRANSCRIPT_WINDOW_MISSING_STATUS);
    await expect(
      TmuxBackend.local(dir).readTranscriptWindow(file, undefined, 20),
    ).resolves.toBeUndefined();
  });
});

describe("TaskSnapshotHistory", () => {
  const snapshot = (subject: string) => ({
    items: [{ id: "1", subject, status: "pending" as const }],
    complete: true,
  });
  const resultFor = (id: string) => ({
    message: { content: [{ type: "tool_result", tool_use_id: id }] },
  });

  test("answers a line with the snapshots of the calls it completed, and no others", () => {
    const history = new TaskSnapshotHistory();
    history.record({ a: snapshot("a"), b: snapshot("b") });
    expect(history.forLine(resultFor("a"))).toEqual({ a: snapshot("a") });
    expect(history.forLine(resultFor("other"))).toBeUndefined();
    expect(history.forLine({ message: { content: "text" } })).toBeUndefined();
  });

  test("forgets the oldest calls past its count bound", () => {
    const history = new TaskSnapshotHistory(2);
    history.record({ a: snapshot("a") });
    history.record({ b: snapshot("b") });
    history.record({ c: snapshot("c") });
    expect(history.forLine(resultFor("a"))).toBeUndefined();
    expect(history.forLine(resultFor("b"))).toBeDefined();
    expect(history.forLine(resultFor("c"))).toBeDefined();
  });

  test("forgets the oldest calls past its byte bound", () => {
    const history = new TaskSnapshotHistory(100, JSON.stringify(snapshot("a")).length * 2);
    history.record({ a: snapshot("a") });
    history.record({ b: snapshot("b") });
    expect(history.forLine(resultFor("a"))).toBeDefined();
    history.record({ c: snapshot("c") });
    expect(history.forLine(resultFor("a"))).toBeUndefined();
    expect(history.forLine(resultFor("c"))).toBeDefined();
  });
});

describe("TmuxTranscriptReader", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ork-tmux-transcript-"));
    file = join(dir, "transcript.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A real local backend, counting what each read asked for. */
  function countingBackend() {
    const backend = TmuxBackend.local(dir);
    const reads = { windowBytes: 0, tailBytes: 0, wholeReads: 0, stats: 0 };
    const window = backend.readTranscriptWindow.bind(backend);
    backend.readTranscriptWindow = async (...args) => {
      const answer = await window(...args);
      reads.windowBytes += answer?.bytes.length ?? 0;
      return answer;
    };
    const fromOffset = backend.readFileBytesFrom.bind(backend);
    backend.readFileBytesFrom = async (...args) => {
      const bytes = await fromOffset(...args);
      reads.tailBytes += bytes.length;
      return bytes;
    };
    const whole = backend.readFile.bind(backend);
    backend.readFile = async (...args) => {
      reads.wholeReads += 1;
      return whole(...args);
    };
    const fileSize = backend.fileSize.bind(backend);
    backend.fileSize = async (...args) => {
      reads.stats += 1;
      return fileSize(...args);
    };
    return { backend, reads };
  }

  const limits = { pageBytes: 256, pageLines: 1_000, maxLineBytes: 4_096 };

  /** Every page from the tail back, newest page first. */
  async function allPages(reader: TmuxTranscriptReader) {
    const pages: TmuxTranscriptPage[] = [];
    let before: string | undefined;
    do {
      const page = await reader.readPage(file, before, noSink);
      pages.push(page);
      before = page.earlierCursor ?? undefined;
    } while (before !== undefined);
    return pages;
  }

  test("walking back through the pages reproduces the file exactly once, multi-byte text included", async () => {
    const lines = Array.from({ length: 200 }, (_, n) => userLine(n, `£ line ${n} — ✓ 🎉`));
    writeFileSync(file, lines.map(jsonl).join(""));
    const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION, limits);

    const pages = await allPages(reader);

    expect(pages.length).toBeGreaterThan(2);
    expect(pages.toReversed().flatMap((page) => page.lines)).toEqual(lines);
    expect(pages.at(-1)!.earlierCursor).toBeNull();
    expect(pages[0]!.lines.at(-1)).toEqual(lines.at(-1));
  });

  test("a whole file smaller than a page is one page with nothing before it", async () => {
    writeFileSync(file, jsonl(userLine(1)) + jsonl(userLine(2)));
    const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION);
    await expect(reader.readPage(file, undefined, noSink)).resolves.toEqual({
      lines: [userLine(1), userLine(2)],
      earlierCursor: null,
    });
  });

  test("a missing file is an empty page", async () => {
    const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION);
    await expect(reader.readPage(file, undefined, noSink)).resolves.toEqual({
      lines: [],
      earlierCursor: null,
    });
  });

  test("a record longer than a page grows the read to reach it", async () => {
    const long = userLine(2, "x".repeat(1_000));
    writeFileSync(file, jsonl(userLine(1)) + jsonl(long));
    const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION, limits);

    const pages = await allPages(reader);

    expect(pages.toReversed().flatMap((page) => page.lines)).toEqual([userLine(1), long]);
  });

  test("a record past the line bound becomes a notice and paging carries on behind it", async () => {
    const earlier = userLine(1);
    const huge = userLine(2, "x".repeat(limits.maxLineBytes * 2));
    const later = userLine(3);
    writeFileSync(file, jsonl(earlier) + jsonl(huge) + jsonl(later));
    const { backend, reads } = countingBackend();
    const reader = new TmuxTranscriptReader(backend, SESSION, limits);

    const tail = await reader.readPage(file, undefined, noSink);
    expect(tail.lines).toEqual([later]);

    const lines: unknown[] = [];
    let before = tail.earlierCursor ?? undefined;
    let pagesRead = 0;
    while (before !== undefined) {
      const page = await reader.readPage(file, before, noSink);
      lines.push(...page.lines);
      before = page.earlierCursor ?? undefined;
      pagesRead += 1;
      expect(pagesRead).toBeLessThan(10);
    }
    expect(lines).toContainEqual(earlier);
    expect(lines).not.toContainEqual(huge);
    expect(JSON.stringify(lines)).toContain("is not shown here");
    // Each read stays within the bound, growing only as far as it may.
    expect(reads.windowBytes).toBeLessThan(pagesRead * limits.maxLineBytes * 2 + limits.pageBytes);
  });

  test("a stale cursor is answered in band as expired", async () => {
    writeFileSync(file, jsonl(userLine(1)));
    const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION);
    const expired: TmuxTranscriptPage = { lines: [], earlierCursor: null, expired: true };

    await expect(reader.readPage(file, "other-session:4", noSink)).resolves.toEqual(expired);
    await expect(reader.readPage(file, `${SESSION}:nonsense`, noSink)).resolves.toEqual(expired);
    await expect(reader.readPage(file, "no-separator", noSink)).resolves.toEqual(expired);
    // The file was replaced by one shorter than the cursor's offset.
    await expect(reader.readPage(file, `${SESSION}:100000`, noSink)).resolves.toEqual(expired);
    rmSync(file);
    await expect(reader.readPage(file, `${SESSION}:4`, noSink)).resolves.toEqual(expired);
  });

  test("reopening a long transcript reads one bounded page, however long it grows", async () => {
    const line = (n: number) => jsonl(userLine(n, "x".repeat(2_000)));
    writeFileSync(file, Array.from({ length: 5_000 }, (_, n) => line(n)).join(""));
    const size = statSync(file).size;
    expect(size).toBeGreaterThan(10_000_000);
    const { backend, reads } = countingBackend();
    const reader = new TmuxTranscriptReader(backend, SESSION);

    // The tail's one pass, which the poll loop owes any session.
    reader.bindTail(file);
    await reader.drainTail(noSink);
    expect(reads.tailBytes).toBe(size);
    reads.tailBytes = 0;

    const page = await reader.readPage(file, undefined, noSink);
    expect(reads.windowBytes).toBeLessThanOrEqual(512 * 1024);
    expect(reads.tailBytes).toBe(0);
    expect(reads.wholeReads).toBe(0);
    expect(page.lines.length).toBeLessThanOrEqual(500);
    expect(page.lines.length).toBeGreaterThan(100);
    expect(page.earlierCursor).not.toBeNull();

    // A later reopen adds only what was appended since.
    reads.windowBytes = 0;
    appendFileSync(file, line(5_000));
    const again = await reader.readPage(file, undefined, noSink);
    expect(again.lines.at(-1)).toEqual(userLine(5_000, "x".repeat(2_000)));
    expect(reads.windowBytes).toBeLessThanOrEqual(512 * 1024);
    expect(reads.tailBytes).toBe(Buffer.byteLength(line(5_000)));
    expect(reads.wholeReads).toBe(0);
  });

  describe("task state", () => {
    const noise = (from: number, count: number) =>
      Array.from({ length: count }, (_, n) => userLine(from + n, "x".repeat(200)));

    /** Task 1, a long gap, task 2 and its result split across pages, then more text. */
    function taskTranscript() {
      return [
        taskCreate("t1", "First"),
        taskCreated("t1", 1, "First"),
        ...noise(0, 20),
        taskCreate("t2", "Second"),
        ...noise(100, 5),
        taskCreated("t2", 2, "Second"),
        ...noise(200, 20),
      ];
    }

    async function wholeRead(lines: unknown[]) {
      writeFileSync(file, lines.map(jsonl).join(""));
      return (await new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION).readWhole(file))
        .lines;
    }

    test.each(["page", "poll"])(
      "%s resets task state and stamps after truncation",
      async (first) => {
        writeFileSync(file, taskTranscript().map(jsonl).join(""));
        const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION, limits);
        const oldPage = await reader.readPage(file, undefined, noSink);
        expect(reader.taskList().items).toHaveLength(2);
        // Reuse an old result id without its call: neither pending calls nor
        // snapshots from the original transcript may stamp this new record.
        const replacement = [taskCreated("t1", 1, "First"), userLine(999)];
        writeFileSync(file, replacement.map(jsonl).join(""));
        expect((await reader.readPage(file, oldPage.earlierCursor!, noSink)).expired).toBe(true);
        if (first === "poll") await reader.drainTail(noSink);
        const pages = await allPages(reader);
        expect(pages.toReversed().flatMap((page) => page.lines)).toEqual(replacement);
        expect(reader.taskList().items).toEqual([]);
        await expect(reader.drainTail(noSink)).resolves.toBe(0);
        expect(reader.taskList().items).toEqual([]);
      },
    );

    test("pages carry the same stamps as the whole-file read, from any page", async () => {
      const lines = taskTranscript();
      const whole = await wholeRead(lines);
      const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION, limits);
      reader.bindTail(file);
      await reader.drainTail(noSink);

      const pages = await allPages(reader);

      expect(pages.length).toBeGreaterThan(2);
      expect(pages.toReversed().flatMap((page) => page.lines)).toEqual(whole);
      // The second task's result sits pages after the call that started it.
      const stamped = whole.find((line) => (line as { uuid?: string }).uuid === "result-t2") as {
        taskSnapshots: Record<string, { items: Array<{ subject: string }> }>;
      };
      expect(stamped.taskSnapshots.t2!.items.map((item) => item.subject)).toEqual([
        "First",
        "Second",
      ]);
    });

    test("a page read that beats the tail's first pass catches it up, delivering each line once", async () => {
      const lines = taskTranscript();
      const whole = await wholeRead(lines);
      const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION, limits);
      const delivered: unknown[] = [];

      const pages: TmuxTranscriptPage[] = [];
      let before: string | undefined;
      do {
        const page = await reader.readPage(file, before, (line) => delivered.push(line));
        pages.push(page);
        before = page.earlierCursor ?? undefined;
      } while (before !== undefined);

      expect(pages.toReversed().flatMap((page) => page.lines)).toEqual(whole);
      expect(delivered).toEqual(lines);
      expect(reader.taskList().items.map((item) => item.subject)).toEqual(["First", "Second"]);
      // The poll loop finds nothing left to read.
      await expect(reader.drainTail(noSink)).resolves.toBe(0);
    });

    test("the current task list stays correct when no page reaches the task calls", async () => {
      writeFileSync(file, [...taskTranscript(), ...noise(300, 100)].map(jsonl).join(""));
      const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION, limits);

      const tail = await reader.readPage(file, undefined, noSink);

      expect(JSON.stringify(tail.lines)).not.toContain("taskSnapshots");
      expect(reader.taskList().items.map((item) => item.subject)).toEqual(["First", "Second"]);
    });

    test("the tail stamps new task calls on top of a session already read", async () => {
      writeFileSync(file, jsonl(taskCreate("t1", "First")));
      const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION);
      await reader.readPage(file, undefined, noSink);

      appendFileSync(file, jsonl(taskCreated("t1", 1, "First")));
      const stamped: unknown[] = [];
      await reader.drainTail((_line, withStamps) => stamped.push(withStamps));

      expect(stamped).toEqual([
        expect.objectContaining({
          taskSnapshots: { t1: expect.objectContaining({ changedTaskId: "1" }) },
        }),
      ]);
    });
  });

  describe("sharing the tail with the poll loop", () => {
    test("a catch-up after the poll loop's size read does not look like a truncation", async () => {
      writeFileSync(file, jsonl(userLine(1)));
      const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION);
      reader.bindTail(file);

      // The poll loop takes the epoch and a size, then a page read overtakes it.
      const epoch = reader.tailEpoch;
      const staleSize = statSync(file).size;
      appendFileSync(file, jsonl(userLine(2)));
      const seen: unknown[] = [];
      await reader.readPage(file, undefined, (line) => seen.push(line));
      expect(seen).toEqual([userLine(1), userLine(2)]);

      await expect(reader.drainTail((line) => seen.push(line), 1, epoch)).resolves.toBe(0);
      await expect(reader.drainTail((line) => seen.push(line), staleSize, epoch)).resolves.toBe(0);
      expect(seen).toHaveLength(2);
    });

    test("a size read under the current epoch still spares the stat", async () => {
      writeFileSync(file, jsonl(userLine(1)));
      const { backend, reads } = countingBackend();
      const reader = new TmuxTranscriptReader(backend, SESSION);
      reader.bindTail(file);

      await reader.drainTail(noSink, statSync(file).size, reader.tailEpoch);

      expect(reads.stats).toBe(0);
    });

    test("a stale page window does not reset a tail advanced by polling", async () => {
      writeFileSync(file, jsonl(userLine(0)));
      const backend = TmuxBackend.local(dir);
      const reader = new TmuxTranscriptReader(backend, SESSION);
      const seen: unknown[] = [];
      const sink: TailLineSink = (line) => seen.push(line);
      reader.bindTail(file);
      await reader.drainTail(sink);
      const originalWindow = backend.readTranscriptWindow.bind(backend);
      let release!: () => void;
      let captured!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        captured = resolve;
      });
      backend.readTranscriptWindow = async (...args) => {
        const window = await originalWindow(...args);
        captured();
        await barrier;
        return window;
      };
      const page = reader.readPage(file, undefined, sink);
      await ready;
      writeFileSync(file, jsonl(userLine(0)) + jsonl(userLine(1)));
      await reader.drainTail(sink);
      let tailReads = 0;
      const originalTail = backend.readFileBytesFrom.bind(backend);
      backend.readFileBytesFrom = async (...args) => {
        tailReads += 1;
        return originalTail(...args);
      };
      release();
      await page;
      expect(seen).toEqual([userLine(0), userLine(1)]);
      expect(tailReads).toBe(0);
    });

    test("concurrent reads deliver each line once, in order", async () => {
      writeFileSync(file, Array.from({ length: 50 }, (_, n) => jsonl(userLine(n))).join(""));
      const reader = new TmuxTranscriptReader(TmuxBackend.local(dir), SESSION);
      const seen: unknown[] = [];
      const sink: TailLineSink = (line) => seen.push(line);

      reader.bindTail(file);
      await Promise.all([
        reader.drainTail(sink),
        reader.readPage(file, undefined, sink),
        reader.drainTail(sink),
      ]);

      expect(seen).toEqual(Array.from({ length: 50 }, (_, n) => userLine(n)));
    });
  });
});
