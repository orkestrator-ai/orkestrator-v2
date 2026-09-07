import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcpClientMethods,
  BoundedTerminalOutput,
  spawnNodeTerminal,
} from "./acp-client-methods.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acp-client-methods-"));
  directories.push(directory);
  return directory;
}

describe("ACP filesystem client methods", () => {
  test("reads line ranges and writes workspace files", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "input.txt"), "one\ntwo\nthree\n");
    const methods = new AcpClientMethods(cwd);
    expect(
      await methods.readTextFile({
        sessionId: "session-1",
        path: join(cwd, "input.txt"),
        line: 2,
        limit: 1,
      }),
    ).toEqual({ content: "two\n" });
    await methods.writeTextFile({
      sessionId: "session-1",
      path: join(cwd, "output.txt"),
      content: "written",
    });
    expect(await readFile(join(cwd, "output.txt"), "utf8")).toBe("written");
  });

  test("refuses traversal and symlink components", async () => {
    const cwd = await workspace();
    const outside = await workspace();
    await mkdir(join(cwd, "safe"));
    await symlink(outside, join(cwd, "safe", "link"));
    const methods = new AcpClientMethods(cwd);
    await expect(
      methods.writeTextFile({
        sessionId: "session-1",
        path: join(cwd, "safe", "link", "escaped.txt"),
        content: "no",
      }),
    ).rejects.toThrow("symlinks");
    await expect(
      methods.readTextFile({ sessionId: "session-1", path: join(outside, "secret.txt") }),
    ).rejects.toThrow("outside the workspace");
  });
});

describe("ACP terminal client methods", () => {
  test("retains a UTF-8-safe tail across thousands of small chunks", () => {
    const output = new BoundedTerminalOutput(8);
    for (let index = 0; index < 5_000; index += 1) output.append("x");
    output.append(Buffer.from([0xf0, 0x9f]));
    output.append(Buffer.from([0x98, 0x80]));
    expect(output.text()).toBe("xxxx😀");
    expect(output.truncated).toBe(true);
  });

  test("captures bounded output and supports wait and release", async () => {
    const cwd = await workspace();
    const methods = new AcpClientMethods(cwd);
    const { terminalId } = await methods.createTerminal({
      sessionId: "session-1",
      command: process.execPath,
      args: ["-e", 'process.stdout.write("abcdef")'],
      cwd,
      outputByteLimit: 4,
    });
    expect(await methods.waitForTerminalExit({ sessionId: "session-1", terminalId })).toMatchObject(
      {
        exitCode: 0,
      },
    );
    expect(methods.terminalOutput({ sessionId: "session-1", terminalId })).toMatchObject({
      output: "cdef",
      truncated: true,
    });
    methods.releaseTerminal({ sessionId: "session-1", terminalId });
    expect(() => methods.terminalOutput({ sessionId: "session-1", terminalId })).toThrow(
      "not found",
    );
  });

  test("kills a running command and scopes terminal ids to their session", async () => {
    const cwd = await workspace();
    const methods = new AcpClientMethods(cwd);
    const { terminalId } = await methods.createTerminal({
      sessionId: "session-1",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd,
    });
    expect(() => methods.killTerminal({ sessionId: "session-2", terminalId })).toThrow("not found");
    methods.killTerminal({ sessionId: "session-1", terminalId });
    expect(await methods.waitForTerminalExit({ sessionId: "session-1", terminalId })).toBeTruthy();
    methods.releaseTerminal({ sessionId: "session-1", terminalId });
  });

  test("settles a terminal whose executable does not exist", async () => {
    const cwd = await workspace();
    const methods = new AcpClientMethods(cwd);
    const { terminalId } = await methods.createTerminal({
      sessionId: "session-1",
      command: `missing-acp-command-${process.pid}`,
      cwd,
    });
    await expect(
      methods.waitForTerminalExit({ sessionId: "session-1", terminalId }),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(methods.terminalOutput({ sessionId: "session-1", terminalId }).output).toContain(
      "ENOENT",
    );
    methods.releaseTerminal({ sessionId: "session-1", terminalId });
  });

  test("settles a missing executable through the Node pipe fallback", async () => {
    const cwd = await workspace();
    const methods = new AcpClientMethods(cwd, spawnNodeTerminal);
    const { terminalId } = await methods.createTerminal({
      sessionId: "session-1",
      command: `missing-node-acp-command-${process.pid}`,
      cwd,
    });
    await expect(
      methods.waitForTerminalExit({ sessionId: "session-1", terminalId }),
    ).resolves.toMatchObject({ exitCode: 1 });
    expect(methods.terminalOutput({ sessionId: "session-1", terminalId }).output).toContain(
      "ENOENT",
    );
    methods.releaseTerminal({ sessionId: "session-1", terminalId });
  });
});
