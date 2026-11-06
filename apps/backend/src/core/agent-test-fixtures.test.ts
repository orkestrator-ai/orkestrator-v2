import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentTestTerminalSurvival, TERMINAL_SURVIVAL_FIXTURE_DIR } from "./agent-test-fixtures.js";
import { setupTerminalSessionId } from "./commands-terminal.js";
import type { PtyProcess } from "./pty.js";
import { TerminalRuntime } from "./terminal-runtime.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ork-agent-test-fixtures-"));
  directories.push(directory);
  return directory;
}

function fakeProcess(onTerminate: () => void): PtyProcess {
  return {
    pid: 1,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    terminate: async () => {
      onTerminate();
      return true;
    },
  };
}

describe("agent-test terminal survival fixture", () => {
  test("is off outside agent-test profiles", async () => {
    expect(agentTestTerminalSurvival(await dataDir(), {})).toBeUndefined();
    expect(
      agentTestTerminalSurvival(await dataDir(), { ORKESTRATOR_AGENT_TEST_ISOLATED: "0" }),
    ).toBeUndefined();
  });

  test("keeps an environment's terminals running while its marker exists", async () => {
    const root = await dataDir();
    const survives = agentTestTerminalSurvival(root, { ORKESTRATOR_AGENT_TEST_ISOLATED: "1" })!;
    const terminals = new TerminalRuntime({ survivesTermination: survives });
    let terminated = 0;
    const id = setupTerminalSessionId("e1");
    terminals.registerProcess(
      id,
      fakeProcess(() => (terminated += 1)),
    );
    try {
      const markers = path.join(root, TERMINAL_SURVIVAL_FIXTURE_DIR);
      await fs.mkdir(markers, { recursive: true });
      await fs.writeFile(path.join(markers, "e1"), "");
      // A path-like id never names a marker outside the directory.
      expect(survives("../e1")).toBe(false);
      expect(survives("e2")).toBe(false);

      expect(await terminals.terminateSessionsForEnvironment("e1")).toEqual([id]);
      expect(terminated).toBe(0);
      expect(terminals.hasProcess(id)).toBe(true);

      await fs.rm(path.join(markers, "e1"));
      expect(await terminals.terminateSessionsForEnvironment("e1")).toEqual([]);
      expect(terminated).toBe(1);
      expect(terminals.hasProcess(id)).toBe(false);
    } finally {
      terminals.shutdown();
    }
  });
});
