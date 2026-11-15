/**
 * The header reader against session files the pinned Pi SDK wrote itself.
 *
 * `session-headers.ts` is a second reader of Pi's private session format. The
 * first block fails when it stops agreeing with `SessionManager.list` on files
 * Pi wrote, so a Pi bump that changes the format fails here rather than
 * silently changing the resume dialog.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { listResumableSessions, sessionListReadSettledForTests } from "./agent-session.js";
import { workingDirectory } from "./config.js";
import {
  KNOWN_SESSION_VERSIONS,
  listSessionsFromHeaders,
  SESSION_HEAD_WINDOW_BYTES,
  SESSION_TAIL_WINDOW_BYTES,
  UnrecognisedSessionFormat,
  type ListedSession,
} from "./session-headers.js";

const CWD = "/workspace/pi-session-headers";
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-bridge-session-headers-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function user(text: string, timestamp: number, blocks = false) {
  return {
    role: "user" as const,
    content: blocks ? [{ type: "text" as const, text }] : text,
    timestamp,
  };
}

function assistant(text: string, timestamp: number) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "not listed" },
      { type: "text", text },
    ],
    api: "openai-completions",
    provider: "loopback",
    model: "loop-1",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as never;
}

/** What the dialog reads from Pi's own `SessionInfo`. */
function fromPi(info: SessionInfo): ListedSession {
  return {
    path: info.path,
    ...(info.name ? { name: info.name } : {}),
    created: info.created,
    modified: info.modified,
    firstMessage: info.firstMessage,
    ...(info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
  };
}

async function headerList(limit = 200) {
  return listSessionsFromHeaders({ directory, cwd: CWD, limit });
}

/** A session line by line, for shapes Pi's writer cannot be asked to produce. */
function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

function headerLine(extra: Record<string, unknown> = {}): string {
  return line({
    type: "session",
    version: 3,
    id: "hand-written",
    timestamp: "2026-11-04T00:00:00.000Z",
    cwd: CWD,
    ...extra,
  });
}

function messageLine(id: string, message: unknown): string {
  return line({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-11-04T00:00:01.000Z",
    message,
  });
}

describe("the format Pi writes", () => {
  test("the reader knows the session version the pinned SDK writes", () => {
    // A bump that raises this needs the reader checked against the new
    // format first: until then every list falls back to Pi's full read.
    expect(KNOWN_SESSION_VERSIONS).toContain(CURRENT_SESSION_VERSION);
    expect(Math.max(...KNOWN_SESSION_VERSIONS)).toBe(CURRENT_SESSION_VERSION);
  });

  test("agrees with Pi's listing on sessions Pi wrote", async () => {
    const named = SessionManager.create(CWD, directory);
    named.appendModelChange("loopback", "loop-1");
    named.appendThinkingLevelChange("high");
    named.appendMessage(user("first prompt", 1_000, true));
    named.appendMessage(assistant("first answer", 1_100));
    named.appendSessionInfo("First name");
    named.appendMessage(user("second prompt", 2_000));
    named.appendSessionInfo("  Renamed  ");
    named.appendMessage(assistant("second answer", 5_000));

    const cleared = SessionManager.create(CWD, directory);
    cleared.appendMessage(user("cleared prompt", 3_000));
    cleared.appendSessionInfo("Gone");
    cleared.appendSessionInfo("");
    cleared.appendMessage(assistant("answer", 3_100));

    const answerOnly = SessionManager.create(CWD, directory);
    answerOnly.appendMessage(assistant("nobody asked", 4_000));

    const fork = SessionManager.forkFrom(named.getSessionFile()!, CWD, directory);
    fork.appendMessage(user("forked prompt", 6_000));

    const elsewhere = SessionManager.create("/workspace/other", directory);
    elsewhere.appendMessage(user("other workspace", 7_000));

    // Not a session to Pi either: the first parsed entry is not the header.
    await writeFile(join(directory, "headless.jsonl"), messageLine("m1", user("orphan", 8_000)));

    const pi = (await SessionManager.list(CWD, directory)).map(fromPi);
    const listed = await headerList();

    expect(pi.length).toBe(4);
    expect(listed.sessions).toEqual(pi);
    // The fork copies its parent's entries, the name included.
    expect(listed.sessions.map((session) => session.name)).toEqual([
      "Renamed",
      "Renamed",
      undefined,
      undefined,
    ]);
    expect(listed.sessions[0]).toMatchObject({
      firstMessage: "first prompt",
      parentSessionPath: named.getSessionFile(),
    });
    expect(listed.sessions.at(-1)?.firstMessage).toBe("cleared prompt");
  });

  test("without a working directory every session is listed, as Pi lists its default directory", async () => {
    SessionManager.create(CWD, directory).appendMessage(user("here", 1_000));
    SessionManager.create("/workspace/other", directory).appendMessage(user("there", 2_000));

    const listed = await listSessionsFromHeaders({ directory, limit: 200 });

    expect(listed.sessions.map((session) => session.firstMessage)).toEqual(["there", "here"]);
  });

  test("keeps the newest by last message and stops reading older files", async () => {
    const files: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const manager = SessionManager.create(CWD, directory);
      manager.appendMessage(user(`prompt ${index}`, 10_000 + index * 1_000));
      files.push(manager.getSessionFile()!);
    }
    // Each file was modified just after its last message, as Pi writes them.
    for (const [index, file] of files.entries()) {
      const modified = new Date(10_500 + index * 1_000);
      await utimes(file, modified, modified);
    }

    const pi = (await SessionManager.list(CWD, directory)).slice(0, 3).map(fromPi);
    const listed = await headerList(3);

    expect(listed.sessions).toEqual(pi);
    expect(listed.filesRead).toBeLessThan(files.length);
  });

  test("a file touched after its last message still ranks by that message", async () => {
    const sessions = [
      { prompt: "touched", activity: 100_000, mtime: 1_000_000 },
      { prompt: "newest", activity: 500_000, mtime: 600_000 },
      { prompt: "older", activity: 400_000, mtime: 450_000 },
    ];
    for (const session of sessions) {
      const manager = SessionManager.create(CWD, directory);
      manager.appendMessage(user(session.prompt, session.activity));
      const modified = new Date(session.mtime);
      await utimes(manager.getSessionFile()!, modified, modified);
    }

    const listed = await headerList(2);

    expect(listed.sessions.map((session) => session.firstMessage)).toEqual(["newest", "older"]);
    expect(listed.sessions).toEqual(
      (await SessionManager.list(CWD, directory)).slice(0, 2).map(fromPi),
    );
  });
});

describe("a session larger than its windows", () => {
  const filler = "x".repeat(64 * 1024);

  async function largeSession(middle: (path: string) => Promise<void>, end: string) {
    const manager = SessionManager.create(CWD, directory);
    manager.appendMessage(user("opening prompt", 1_000));
    manager.appendMessage(assistant("opening answer", 1_100));
    const path = manager.getSessionFile()!;
    await middle(path);
    await appendFile(path, end);
    return path;
  }

  async function fill(path: string, bytes: number, from: number) {
    let lines = "";
    for (let index = 0; index * filler.length < bytes; index += 1) {
      lines += messageLine(`fill-${from + index}`, {
        role: "toolResult",
        toolCallId: `call-${from + index}`,
        toolName: "read",
        content: [{ type: "text", text: filler }],
        isError: false,
        timestamp: 2_000 + index,
      });
    }
    await appendFile(path, lines);
  }

  test("reads only its head and tail, and agrees with Pi on what they hold", async () => {
    await largeSession(
      (path) => fill(path, 4 * SESSION_HEAD_WINDOW_BYTES, 0),
      line({
        type: "session_info",
        id: "name",
        parentId: null,
        timestamp: "2026-11-04T00:00:02.000Z",
        name: "Named at the end",
      }) + messageLine("last", assistant("last answer", 90_000)),
    );

    const listed = await headerList();

    expect(listed.bytesRead).toBeLessThanOrEqual(
      SESSION_HEAD_WINDOW_BYTES + SESSION_TAIL_WINDOW_BYTES + 1,
    );
    expect(listed.sessions).toEqual((await SessionManager.list(CWD, directory)).map(fromPi));
    expect(listed.sessions[0]).toMatchObject({
      name: "Named at the end",
      firstMessage: "opening prompt",
      modified: new Date(90_000),
    });
  });

  test("a name set only between the windows is not seen (the documented difference)", async () => {
    await largeSession(
      async (path) => {
        await fill(path, 2 * SESSION_HEAD_WINDOW_BYTES, 0);
        await appendFile(
          path,
          line({
            type: "session_info",
            id: "name",
            parentId: null,
            timestamp: "2026-11-04T00:00:02.000Z",
            name: "Named in the middle",
          }),
        );
        await fill(path, 2 * SESSION_TAIL_WINDOW_BYTES, 1_000);
      },
      messageLine("last", assistant("last answer", 90_000)),
    );

    const [pi] = await SessionManager.list(CWD, directory);
    const [listed] = (await headerList()).sessions;

    expect(pi?.name).toBe("Named in the middle");
    expect(listed?.name).toBeUndefined();
    expect(listed?.modified).toEqual(pi!.modified);
  });

  test("a tail with no whole message dates the session by its file", async () => {
    const path = await largeSession(
      (file) => fill(file, 2 * SESSION_HEAD_WINDOW_BYTES, 0),
      messageLine("huge", {
        role: "toolResult",
        toolCallId: "huge",
        toolName: "read",
        content: [{ type: "text", text: "y".repeat(SESSION_TAIL_WINDOW_BYTES * 2) }],
        isError: false,
        timestamp: 3_000,
      }),
    );
    const modified = new Date(123_456_000);
    await utimes(path, modified, modified);

    const [listed] = (await headerList()).sessions;

    expect(listed?.modified).toEqual(modified);
    expect(listed?.firstMessage).toBe("opening prompt");
  });
});

describe("a format the reader does not recognise", () => {
  test.each([
    [
      "a newer session version",
      headerLine({ version: CURRENT_SESSION_VERSION + 1 }),
      "session-version",
    ],
    ["a version that is not a number", headerLine({ version: "3" }), "session-version"],
    ["a parent that is not a path", headerLine({ parentSession: 7 }), "session-header"],
    ["a message that is not an object", headerLine() + messageLine("m1", "hello"), "message-entry"],
    [
      "content that is neither text nor blocks",
      headerLine() + messageLine("m1", { role: "user", content: { text: "hello" } }),
      "message-content",
    ],
    [
      "a name that is not text",
      headerLine() + line({ type: "session_info", id: "n", parentId: null, name: 7 }),
      "session-info-entry",
    ],
  ])("%s is refused rather than guessed at", async (_name, content, reason) => {
    await writeFile(join(directory, "unknown.jsonl"), content);

    const failure = await headerList().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnrecognisedSessionFormat);
    expect((failure as UnrecognisedSessionFormat).reason).toBe(reason);
  });

  test("an entry type it has not seen is ignored, as Pi's listing ignores it", async () => {
    await writeFile(
      join(directory, "new-entry.jsonl"),
      headerLine() +
        line({ type: "something_new", id: "s", parentId: null, payload: [1, 2] }) +
        messageLine("m1", user("still listed", 1_000)),
    );

    expect((await headerList()).sessions).toEqual(
      (await SessionManager.list(CWD, directory)).map(fromPi),
    );
  });

  describe("through the resume list", () => {
    const previousSessionDirectory = process.env.PI_SESSION_DIR;
    beforeEach(() => {
      process.env.PI_SESSION_DIR = directory;
    });
    afterEach(async () => {
      await sessionListReadSettledForTests();
      if (previousSessionDirectory === undefined) delete process.env.PI_SESSION_DIR;
      else process.env.PI_SESSION_DIR = previousSessionDirectory;
    });

    test("hands the whole list to Pi's own reader, and says why", async () => {
      const known = SessionManager.create(workingDirectory, directory);
      known.appendMessage(user("known prompt", 1_000));
      await writeFile(
        join(directory, "future.jsonl"),
        line({
          type: "session",
          version: CURRENT_SESSION_VERSION + 1,
          id: "future",
          timestamp: "2026-11-04T00:00:00.000Z",
          cwd: workingDirectory,
        }) + messageLine("m1", user("future prompt", 2_000)),
      );
      const list = spyOn(SessionManager, "list");
      const logs = captureLogs();
      try {
        const entries = await listResumableSessions();

        expect(list).toHaveBeenCalledTimes(1);
        expect(entries.map((entry) => entry.detail)).toEqual(["future prompt", "known prompt"]);
        expect(
          logs.records().filter((record) => record.event === "session-list.read-by-pi"),
        ).toMatchObject([{ level: "info", fields: { reason: "session-version" } }]);
      } finally {
        logs.restore();
        list.mockRestore();
      }
    });

    test("a recognised history never asks Pi to read every file", async () => {
      SessionManager.create(workingDirectory, directory).appendMessage(user("known", 1_000));
      const list = spyOn(SessionManager, "list");
      try {
        expect((await listResumableSessions()).map((entry) => entry.detail)).toEqual(["known"]);
        expect(list).not.toHaveBeenCalled();
      } finally {
        list.mockRestore();
      }
    });
  });
});

test("an abandoned read stops before reading files", async () => {
  SessionManager.create(CWD, directory).appendMessage(user("prompt", 1_000));
  const read = new AbortController();
  read.abort(new Error("gave up"));

  await expect(
    listSessionsFromHeaders({ directory, cwd: CWD, limit: 200, signal: read.signal }),
  ).rejects.toThrow("gave up");
});
