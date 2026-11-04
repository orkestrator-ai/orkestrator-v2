import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFile, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { listResumableSessions, setSessionListTimeoutForTests } from "./agent-session.js";
import { workingDirectory } from "./config.js";
import { TimeoutError } from "./timeout.js";

let directory: string;
let list: ReturnType<typeof spyOn<typeof SessionManager, "list">>;
const previousSessionDirectory = process.env.PI_SESSION_DIR;

function sessionLine(id: string): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-11-04T00:00:00.000Z",
    cwd: workingDirectory,
  })}\n`;
}

function messageLine(id: string, text: string): string {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-11-04T00:00:01.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  })}\n`;
}

async function writeSession(name: string, text: string): Promise<string> {
  const path = join(directory, `${name}.jsonl`);
  await writeFile(path, sessionLine(name) + messageLine("m1", text));
  return path;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-bridge-session-list-"));
  process.env.PI_SESSION_DIR = directory;
  list = spyOn(SessionManager, "list");
});

afterEach(async () => {
  list.mockRestore();
  setSessionListTimeoutForTests();
  if (previousSessionDirectory === undefined) delete process.env.PI_SESSION_DIR;
  else process.env.PI_SESSION_DIR = previousSessionDirectory;
  await rm(directory, { recursive: true, force: true });
});

describe("the resumable session list", () => {
  test("answers from memory while no file changed", async () => {
    const path = await writeSession("one", "first prompt");

    const first = await listResumableSessions();
    const second = await listResumableSessions();

    expect(first).toEqual([
      expect.objectContaining({ sessionId: path, detail: "first prompt", status: "idle" }),
    ]);
    expect(second).toEqual(first);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "an appended line",
      async (path: string) => appendFile(path, messageLine("m2", "second prompt")),
    ],
    ["a touched file", async (path: string) => utimes(path, new Date(5_000), new Date(5_000))],
    ["a new file", async () => void (await writeSession("two", "other prompt"))],
    ["a removed file", async (path: string) => unlink(path)],
  ])("%s reads the sessions again", async (_name, change) => {
    const path = await writeSession("one", "first prompt");
    await listResumableSessions();

    await change(path);
    await listResumableSessions();

    expect(list).toHaveBeenCalledTimes(2);
  });

  test("a changed file shows in the answer, and the next read is cached again", async () => {
    await writeSession("one", "first prompt");
    await listResumableSessions();

    const second = await writeSession("two", "other prompt");
    const listed = await listResumableSessions();
    await listResumableSessions();

    expect(listed.map((entry) => entry.sessionId)).toContain(second);
    expect(listed).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("a list too large to keep is read each time, bounded as before", async () => {
    list.mockImplementation(
      async () =>
        Array.from({ length: 500 }, (_, index) => ({
          path: `/sessions/${index}.jsonl`,
          id: String(index),
          cwd: workingDirectory,
          name: "n".repeat(64 * 1024),
          created: new Date(1_000),
          modified: new Date(2_000),
          messageCount: 1,
          firstMessage: "hello",
          allMessagesText: "hello",
        })) as SessionInfo[],
    );

    expect(await listResumableSessions()).toHaveLength(200);
    await listResumableSessions();

    expect(list).toHaveBeenCalledTimes(2);
  });

  test("a timeout is reported, not an empty history, and stops the read", async () => {
    await writeSession("one", "first prompt");
    let signal: AbortSignal | undefined;
    list.mockImplementation((_cwd, _dir, _progress, given) => {
      signal = given;
      return new Promise((_, reject) => {
        given!.addEventListener("abort", () => reject(given!.reason));
      });
    });
    setSessionListTimeoutForTests(5);

    const failure = await listResumableSessions().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TimeoutError);
    expect(signal?.aborted).toBe(true);
  });

  test("any other failure still reads as no sessions", async () => {
    list.mockImplementation(async () => {
      throw new Error("unreadable");
    });
    expect(await listResumableSessions()).toEqual([]);
  });
});
