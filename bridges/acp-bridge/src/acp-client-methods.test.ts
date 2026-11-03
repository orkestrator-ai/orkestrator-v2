import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  AcpClientMethods,
  BoundedTerminalOutput,
  ClientMethodRefusedError,
  spawnNodeTerminal,
} from "./acp-client-methods.js";
import {
  acpClientMethodGrant,
  coordinatorProcessPolicy,
  effectiveTurnExecutionPolicy,
} from "./acp-policy.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acp-client-methods-"));
  // Bun 1.4.2 exposes macOS's /var -> /private/var alias through tmpdir(); use
  // the same canonical path the production workspace guard compares against.
  const canonical = await realpath(directory);
  directories.push(canonical);
  return canonical;
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

// Security report M13: these calls never pass through a permission request,
// so the session's policy has to be checked where they are served.
describe("ACP client methods under a denying policy", () => {
  function recordingSpawn() {
    const spawned: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
    const spawn = (command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ command, env: options.env });
      return {
        kill: () => undefined,
        onData: () => undefined,
        onExit: (listener: (exitCode: number | null, signal: string | null) => void) =>
          queueMicrotask(() => listener(0, null)),
      };
    };
    return { spawned, spawn };
  }

  test("refuses a file write without touching the workspace, and still reads", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "existing.txt"), "kept");
    const methods = new AcpClientMethods(cwd, undefined, { writeTextFile: false, terminal: true });
    for (const path of [join(cwd, "existing.txt"), join(cwd, "created.txt")]) {
      await expect(
        methods.handle("fs/write_text_file", { sessionId: "session-1", path, content: "no" }),
      ).rejects.toBeInstanceOf(ClientMethodRefusedError);
    }
    expect(await readFile(join(cwd, "existing.txt"), "utf8")).toBe("kept");
    await expect(readFile(join(cwd, "created.txt"), "utf8")).rejects.toThrow();
    expect(
      await methods.handle("fs/read_text_file", {
        sessionId: "session-1",
        path: join(cwd, "existing.txt"),
      }),
    ).toEqual({ content: "kept" });
  });

  test("refuses every terminal method without spawning", async () => {
    const cwd = await workspace();
    const { spawned, spawn } = recordingSpawn();
    const methods = new AcpClientMethods(cwd, spawn, { writeTextFile: true, terminal: false });
    await expect(
      methods.handle("terminal/create", { sessionId: "session-1", command: "touch", cwd }),
    ).rejects.toThrow("refused by this session's execution policy");
    for (const method of [
      "terminal/output",
      "terminal/wait_for_exit",
      "terminal/kill",
      "terminal/release",
    ]) {
      await expect(
        methods.handle(method, { sessionId: "session-1", terminalId: "any" }),
      ).rejects.toBeInstanceOf(ClientMethodRefusedError);
    }
    expect(spawned).toEqual([]);
    // Writes are a separate grant.
    await methods.handle("fs/write_text_file", {
      sessionId: "session-1",
      path: join(cwd, "allowed.txt"),
      content: "yes",
    });
    expect(await readFile(join(cwd, "allowed.txt"), "utf8")).toBe("yes");
  });

  test("a terminal it does run never inherits the bridge-control credentials", async () => {
    const cwd = await workspace();
    const { spawned, spawn } = recordingSpawn();
    const names = [
      "ACP_BRIDGE_TOKEN",
      "CODEX_BRIDGE_TOKEN",
      "ORKESTRATOR_AGENT_MCP_TOKEN",
      "ORKESTRATOR_AGENT_MCP_URL",
    ];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const previousGh = process.env.GH_TOKEN;
    for (const name of names) process.env[name] = `fake-${name}`;
    process.env.GH_TOKEN = "fake-gh";
    try {
      await new AcpClientMethods(cwd, spawn).createTerminal({
        sessionId: "session-1",
        command: "env",
        cwd,
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (previousGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGh;
    }
    expect(spawned).toHaveLength(1);
    for (const name of names) expect(spawned[0]!.env[name]).toBeUndefined();
    // The managed GitHub credential is the session's to use.
    expect(spawned[0]!.env.GH_TOKEN).toBe("fake-gh");
  });
});

describe("acpClientMethodGrant", () => {
  const base: NativeAgentExecutionPolicy = {
    id: "interactive-container",
    sandbox: "container",
    approvals: "auto-approve",
    projectResources: true,
    networkAccess: "full",
  };

  test("an ordinary worker keeps both, as does a probe with no policy", () => {
    expect(acpClientMethodGrant(undefined)).toEqual({ writeTextFile: true, terminal: true });
    expect(acpClientMethodGrant(base)).toEqual({ writeTextFile: true, terminal: true });
    expect(
      acpClientMethodGrant({ ...base, capabilityPolicy: { deny: ["network", "git.push"] } }),
    ).toEqual({ writeTextFile: true, terminal: true });
  });

  test("file and shell denials refuse their method, in either policy form", () => {
    for (const deny of [["file.write"], ["file.patch"]] as const) {
      expect(acpClientMethodGrant({ ...base, capabilityPolicy: { deny: [...deny] } })).toEqual({
        writeTextFile: false,
        terminal: true,
      });
    }
    for (const deny of [["shell"], ["shell.mutate"]] as const) {
      expect(acpClientMethodGrant({ ...base, capabilityPolicy: { deny: [...deny] } })).toEqual({
        writeTextFile: true,
        terminal: false,
      });
    }
    expect(
      acpClientMethodGrant({ ...base, toolPolicy: { deny: ["apply_patch", "shell"] } }),
    ).toEqual({ writeTextFile: false, terminal: false });
  });

  test("a read-only policy, a coordinator and approvals: deny refuse both", () => {
    expect(
      acpClientMethodGrant({
        ...base,
        capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate"] },
      }),
    ).toEqual({ writeTextFile: false, terminal: false });
    expect(acpClientMethodGrant(coordinatorProcessPolicy())).toEqual({
      writeTextFile: false,
      terminal: false,
    });
    expect(
      acpClientMethodGrant(effectiveTurnExecutionPolicy({ policy: base, readOnly: true })),
    ).toEqual({ writeTextFile: false, terminal: false });
    expect(acpClientMethodGrant({ ...base, approvals: "deny" })).toEqual({
      writeTextFile: false,
      terminal: false,
    });
  });
});
