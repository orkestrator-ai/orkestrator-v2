import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { closeSession, ensureSession, newSessionState, resumeSession } from "./agent-session.js";
import { workingDirectory } from "./config.js";
import { sessions } from "./state.js";

let sessionDirectory: string;
let previousSessionDirectory: string | undefined;

beforeEach(async () => {
  sessionDirectory = await mkdtemp(join(tmpdir(), "pi-bridge-agent-session-"));
  previousSessionDirectory = process.env.PI_SESSION_DIR;
  process.env.PI_SESSION_DIR = sessionDirectory;
  sessions.clear();
});

afterEach(async () => {
  if (previousSessionDirectory === undefined) delete process.env.PI_SESSION_DIR;
  else process.env.PI_SESSION_DIR = previousSessionDirectory;
  sessions.clear();
  await rm(sessionDirectory, { recursive: true, force: true });
});

describe("session ownership", () => {
  test("shares one bridge state across concurrent resumes of the same Pi file", async () => {
    const sessionFile = join(sessionDirectory, "conversation.jsonl");
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "resume-race",
        timestamp: "2026-08-25T00:00:00.000Z",
        cwd: workingDirectory,
      })}\n`,
      "utf8",
    );

    const [first, second] = await Promise.all([
      resumeSession(sessionFile, undefined),
      resumeSession(sessionFile, undefined),
    ]);

    expect(first).toBe(second);
    expect(Array.from(sessions.values())).toEqual([first]);
  });

  test("waits for a cold attach and disposes it when the owner closes", async () => {
    const state = newSessionState();
    let publish: (() => void) | undefined;
    let disposed = 0;
    const attached = {
      dispose: () => {
        disposed += 1;
      },
    } as unknown as AgentSession;
    state.attaching = new Promise<AgentSession>((resolve) => {
      publish = () => {
        state.session = attached;
        resolve(attached);
      };
    });

    const closing = closeSession(state);
    await expect(ensureSession(state)).rejects.toThrow(/closed/);
    publish!();
    await closing;

    expect(disposed).toBe(1);
    expect(state.session).toBeNull();
    await expect(ensureSession(state)).rejects.toThrow(/closed/);
  });
});
