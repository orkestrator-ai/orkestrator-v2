import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandOutput } from "./ssh-agent-socket.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fakeCommand(body: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-ssh-agent-command-"));
  directories.push(directory);
  const command = path.join(directory, "fake");
  await fs.writeFile(command, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return command;
}

describe("commandOutput", () => {
  test("returns trimmed stdout", async () => {
    expect(await commandOutput(await fakeCommand("printf ' /tmp/agent.sock\\n'"), [])).toBe(
      "/tmp/agent.sock",
    );
  });

  test("empty output is no answer", async () => {
    expect(await commandOutput(await fakeCommand("exit 0"), [])).toBeUndefined();
  });

  test("a failing command is no answer, even with output", async () => {
    expect(await commandOutput(await fakeCommand("echo partial; exit 1"), [])).toBeUndefined();
  });

  test("a missing command is no answer", async () => {
    expect(await commandOutput("ork-no-such-command-6060", [])).toBeUndefined();
  });

  test("a command past its timeout is no answer, even with output", async () => {
    const command = await fakeCommand("echo partial; exec sleep 30");
    expect(await commandOutput(command, [], { timeoutMs: 100 })).toBeUndefined();
  });

  test("output past its limit is no answer rather than a cut path", async () => {
    const command = await fakeCommand("printf /tmp/agent.sock");
    expect(await commandOutput(command, [], { maxOutputBytes: 4 })).toBeUndefined();
  });
});
