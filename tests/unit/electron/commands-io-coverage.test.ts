import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import { APP_SLUG } from "../../../apps/backend/src/core/constants";
import * as realPty from "../../../apps/backend/src/core/pty";

type ExitEvent = { exitCode: number; signal?: number };

const spawnedPtys: Array<{
  command: string;
  args: string[];
  options: Record<string, unknown>;
  write: ReturnType<typeof mock>;
  resize: ReturnType<typeof mock>;
  kill: ReturnType<typeof mock>;
  emitData: (data: string) => void;
  emitExit: (event?: ExitEvent) => void;
}> = [];

const spawnPty = mock((command: string, args: string[], options: Record<string, unknown>) => {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: ExitEvent) => void> = [];
  const process = {
    command,
    args,
    options,
    write: mock(() => undefined),
    resize: mock(() => undefined),
    kill: mock(() => undefined),
    emitData: (data: string) => dataListeners.forEach((listener) => listener(data)),
    emitExit: (event: ExitEvent = { exitCode: 0 }) => exitListeners.forEach((listener) => listener(event)),
  };
  spawnedPtys.push(process);
  return {
    pid: spawnedPtys.length,
    cols: Number(options.cols ?? 80),
    rows: Number(options.rows ?? 24),
    process: command,
    handleFlowControl: false,
    onData: (listener: (data: string) => void) => {
      dataListeners.push(listener);
      return { dispose: () => undefined };
    },
    onExit: (listener: (event: ExitEvent) => void) => {
      exitListeners.push(listener);
      return { dispose: () => undefined };
    },
    write: process.write,
    resize: process.resize,
    kill: process.kill,
    clear: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
  };
});

const realPtySnapshot = { ...realPty };
mock.module("../../../apps/backend/src/core/pty", () => ({ spawnPty }));

const { createCommandRegistry } = await import("../../../apps/backend/src/core/commands");

const tempDirs: string[] = [];

function createContext(environment: Record<string, unknown> | null = null): CommandContext {
  return {
    appRoot: "",
    resourceRoot: "",
    emit: mock(() => undefined),
    storage: {
      getEnvironment: mock(async () => environment),
    },
  } as unknown as CommandContext;
}

async function createTempDir(prefix: string, parent = os.tmpdir()): Promise<string> {
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, prefix));
  tempDirs.push(directory);
  return directory;
}

async function withFakeDocker(
  script: string,
  run: (artifacts: { logPath: string; stdinPath: string }) => Promise<void>,
): Promise<void> {
  const root = await createTempDir("ork-commands-io-docker-");
  const binDirectory = path.join(root, "bin");
  const logPath = path.join(root, "docker.log");
  const stdinPath = path.join(root, "docker.stdin");
  await fs.mkdir(binDirectory, { recursive: true });
  const executable = path.join(binDirectory, "docker");
  await fs.writeFile(executable, script);
  await fs.chmod(executable, 0o755);

  const previousPath = process.env.PATH;
  const previousLog = process.env.FAKE_DOCKER_LOG;
  const previousStdin = process.env.FAKE_DOCKER_STDIN;
  process.env.PATH = `${binDirectory}${path.delimiter}${previousPath ?? ""}`;
  process.env.FAKE_DOCKER_LOG = logPath;
  process.env.FAKE_DOCKER_STDIN = stdinPath;
  try {
    await run({ logPath, stdinPath });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = previousLog;
    if (previousStdin === undefined) delete process.env.FAKE_DOCKER_STDIN;
    else process.env.FAKE_DOCKER_STDIN = previousStdin;
  }
}

afterEach(async () => {
  spawnedPtys.length = 0;
  spawnPty.mockClear();
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

afterAll(() => {
  mock.module("../../../apps/backend/src/core/pty", () => realPtySnapshot);
});

describe("backend command I/O coverage", () => {
  test("attaches, drives, lists, and detaches a container terminal", () => {
    const context = createContext();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    context.emit = (event, payload) => emitted.push({ event, payload });
    const commands = createCommandRegistry();
    const sessionsBeforeAttach = commands.get("list_terminal_sessions")?.({}, context) as string[];

    const sessionId = commands.get("attach_terminal")?.(
      { containerId: "container-1", cols: 0, rows: Number.NaN, user: "node" },
      context,
    ) as string;

    expect(sessionId).toStartWith("container-1:");
    expect(spawnPty).toHaveBeenCalledWith(
      "docker",
      ["exec", "-it", "--user", "node", "container-1", "zsh", "-l"],
      expect.objectContaining({ cols: 80, rows: 24 }),
    );
    expect(commands.get("list_terminal_sessions")?.({}, context)).toEqual([...sessionsBeforeAttach, sessionId]);

    commands.get("terminal_write")?.({ sessionId, data: "pwd\r" }, context);
    commands.get("terminal_resize")?.({ sessionId, cols: 121.9, rows: 40 }, context);
    spawnedPtys[0]?.emitData("ready\r\n");
    expect(spawnedPtys[0]?.write).toHaveBeenCalledWith("pwd\r");
    expect(spawnedPtys[0]?.resize).toHaveBeenCalledWith(121, 40);
    expect(emitted).toEqual([
      { event: `terminal-output-${sessionId}`, payload: Array.from(Buffer.from("ready\r\n")) },
    ]);

    commands.get("detach_terminal")?.({ sessionId }, context);
    expect(spawnedPtys[0]?.kill).toHaveBeenCalledTimes(1);
    expect(commands.get("list_terminal_sessions")?.({}, context)).toEqual(sessionsBeforeAttach);

    expect(() => commands.get("terminal_write")?.({ sessionId: 1, data: "x" }, context)).toThrow(
      "Expected sessionId to be a string",
    );
  });

  test("builds a local tree and reads and writes local file payloads safely", async () => {
    const root = await createTempDir("ork-commands-io-local-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await fs.writeFile(path.join(root, "README.md"), "hello\n");
    await fs.writeFile(path.join(root, "src", "app.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(root, ".git", "config"), "ignored");
    await fs.writeFile(path.join(root, "node_modules", "ignored", "index.js"), "ignored");
    const commands = createCommandRegistry();
    const context = createContext();

    await expect(commands.get("get_local_file_tree")?.({ worktreePath: root }, context)).resolves.toEqual([
      {
        name: "src",
        path: "src",
        isDirectory: true,
        children: [{ name: "app.ts", path: path.join("src", "app.ts"), isDirectory: false, extension: ".ts" }],
      },
      { name: "README.md", path: "README.md", isDirectory: false, extension: ".md" },
    ]);
    await expect(commands.get("read_local_file")?.(
      { worktreePath: root, filePath: "src/app.ts" },
      context,
    )).resolves.toEqual({ path: "src/app.ts", content: "export const value = 1;\n", language: "typescript" });

    const data = Buffer.from([0, 1, 2, 255]).toString("base64");
    const writtenPath = await commands.get("write_local_file")?.(
      { worktreePath: root, filePath: "generated/data.bin", base64Data: data },
      context,
    );
    expect(writtenPath).toBe(path.join(root, "generated", "data.bin"));
    expect(await fs.readFile(writtenPath as string)).toEqual(Buffer.from([0, 1, 2, 255]));

    await expect(commands.get("write_local_file")?.(
      { worktreePath: root, filePath: "../escape.bin", base64Data: data },
      context,
    )).rejects.toThrow("parent directory traversal is not allowed");
    await expect(commands.get("write_local_file")?.(
      { worktreePath: root, filePath: "bad.bin", base64Data: "%%%" },
      context,
    )).rejects.toThrow("File payload is not valid base64");
  });

  test("reads base64 only from regular files in workspace storage", async () => {
    const workspaceStorage = path.join(os.homedir(), APP_SLUG, "workspaces");
    const allowedRoot = await createTempDir("commands-io-host-", workspaceStorage);
    const filePath = path.join(allowedRoot, "image.bin");
    await fs.writeFile(filePath, Buffer.from([0, 255, 128]));
    const commands = createCommandRegistry();
    const context = createContext();

    await expect(commands.get("read_file_base64")?.({ filePath }, context)).resolves.toBe("AP+A");

    const outsideRoot = await createTempDir("ork-commands-io-outside-");
    const outsideFile = path.join(outsideRoot, "private.bin");
    await fs.writeFile(outsideFile, "private");
    await expect(commands.get("read_file_base64")?.({ filePath: outsideFile }, context)).rejects.toThrow(
      "file is outside Orkestrator workspace storage",
    );
  });

  test("executes container file reads and writes through docker without a live daemon", async () => {
    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"find /workspace"*) printf 'src/app.ts\\nREADME.md\\n' ;;
  *"cat '/workspace/src/app.ts'"*) printf 'export const value = 2;\\n' ;;
  *"git show 'main':'src/app.ts'"*) printf 'export const value = 1;\\n' ;;
  *"git show 'missing':'src/app.ts'"*) ;;
  *"stat -c %s '/workspace/assets/blob.bin'"*) printf '3\\n' ;;
  *"base64 -w 0 '/workspace/assets/blob.bin'"*) printf 'AAEC\\n' ;;
  *"mkdir -p '/workspace/generated'"*) ;;
  *"base64 -d > '/workspace/generated/out.bin'"*) cat > "$FAKE_DOCKER_STDIN" ;;
  *) printf 'unexpected docker invocation: %s\\n' "$*" >&2; exit 33 ;;
esac
`;

    await withFakeDocker(dockerScript, async ({ logPath, stdinPath }) => {
      const commands = createCommandRegistry();
      const context = createContext();

      await expect(commands.get("get_file_tree")?.({ containerId: "container-1" }, context)).resolves.toEqual([
        { name: "app.ts", path: "src/app.ts", isDirectory: false, extension: ".ts" },
        { name: "README.md", path: "README.md", isDirectory: false, extension: ".md" },
      ]);
      await expect(commands.get("read_container_file")?.(
        { containerId: "container-1", filePath: "src/app.ts" },
        context,
      )).resolves.toEqual({ path: "src/app.ts", content: "export const value = 2;\n", language: "ts" });
      await expect(commands.get("read_file_at_branch")?.(
        { containerId: "container-1", filePath: "src/app.ts", branch: "main" },
        context,
      )).resolves.toEqual({ path: "src/app.ts", content: "export const value = 1;\n", language: "ts" });
      await expect(commands.get("read_file_at_branch")?.(
        { containerId: "container-1", filePath: "src/app.ts", branch: "missing" },
        context,
      )).resolves.toBeNull();
      await expect(commands.get("read_container_file_base64")?.(
        { containerId: "container-1", filePath: "assets/blob.bin" },
        context,
      )).resolves.toBe("AAEC");
      await expect(commands.get("write_container_file")?.(
        { containerId: "container-1", filePath: "generated/out.bin", base64Data: "AAEC" },
        context,
      )).resolves.toBe("/workspace/generated/out.bin");

      expect(await fs.readFile(stdinPath, "utf8")).toBe("AAEC");
      expect(await fs.readFile(logPath, "utf8")).toContain("exec -i container-1 bash -lc base64 -d > '/workspace/generated/out.bin'");
    });
  });

  test("rejects unsafe container file paths and malformed writes before invoking docker", async () => {
    const commands = createCommandRegistry();
    const context = createContext();

    await expect(commands.get("read_container_file")?.(
      { containerId: "container-1", filePath: "../secret" },
      context,
    )).rejects.toThrow("parent directory traversal is not allowed");
    await expect(commands.get("write_container_file")?.(
      { containerId: "container-1", filePath: "result.bin", base64Data: "not-base64!" },
      context,
    )).rejects.toThrow("File payload is not valid base64");
  });

  test("reports persisted status for every local server kind and accepts stale cleanup", async () => {
    const environment = {
      id: "env-1",
      localOpencodePort: 4101,
      opencodePid: 5101,
      localClaudePort: 4102,
      claudeBridgePid: 5102,
      localCodexPort: 4103,
      codexBridgePid: 5103,
    };
    const context = createContext(environment);
    const commands = createCommandRegistry();

    await expect(commands.get("get_local_opencode_server_status")?.(
      { environmentId: "env-1" },
      context,
    )).resolves.toEqual({ running: false, port: 4101, pid: 5101 });
    await expect(commands.get("get_local_claude_server_status")?.(
      { environmentId: "env-1" },
      context,
    )).resolves.toEqual({ running: false, port: 4102, pid: 5102 });
    await expect(commands.get("get_local_codex_server_status")?.(
      { environmentId: "env-1" },
      context,
    )).resolves.toEqual({ running: false, port: 4103, pid: 5103 });
    expect(commands.get("cleanup_stale_local_servers_cmd")?.({}, context)).toBeUndefined();

    expect(() => commands.get("get_local_codex_server_status")?.(
      { environmentId: 1 },
      context,
    )).toThrow("Expected environmentId to be a string");
  });
});
