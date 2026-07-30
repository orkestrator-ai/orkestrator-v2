import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "../../../apps/backend/src/core/commands";
import { APP_SLUG } from "../../../apps/backend/src/core/constants";
import * as realPty from "../../../apps/backend/src/core/pty";
import { runCommand } from "../../../apps/backend/src/core/shell";

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

const {
  CONTAINER_SAFE_BASE64_READER,
  buildContainerSafeBase64Reader,
  createCommandRegistry,
} = await import("../../../apps/backend/src/core/commands");

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
      [
        "exec",
        "-it",
        "--user",
        "node",
        "container-1",
        "bash",
        "-lc",
        [
          "source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true",
          "orkestrator_source_runtime_env 2>/dev/null || true",
          "exec zsh -l",
        ].join("\n"),
      ],
      expect.objectContaining({ cols: 80, rows: 24 }),
    );
    expect(commands.get("list_terminal_sessions")?.({}, context)).toEqual([...sessionsBeforeAttach, sessionId]);

    commands.get("terminal_write")?.({ sessionId, data: "pwd\r" }, context);
    commands.get("terminal_resize")?.({ sessionId, cols: 121.9, rows: 40 }, context);
    spawnedPtys[0]?.emitData("ready\r\n");
    expect(spawnedPtys[0]?.write).toHaveBeenCalledWith("pwd\r");
    expect(spawnedPtys[0]?.resize).toHaveBeenCalledWith(121, 40);
    expect(emitted).toEqual([
      {
        event: `terminal-output-${sessionId}`,
        payload: {
          text: "ready\r\n",
          revision: 1,
          generation: 1,
        },
      },
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
    await fs.symlink(path.join(root, "README.md"), path.join(root, "readme-link.md"));
    await fs.symlink(path.join(root, "src"), path.join(root, "src-link"));
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
    const changedTree = await commands.get("get_local_file_tree")?.(
      { worktreePath: root, knownDigest: "stale" },
      context,
    ) as {
      unchanged: boolean;
      digest: string;
      value?: unknown;
    };
    expect(changedTree).toMatchObject({
      unchanged: false,
      value: expect.any(Array),
    });
    await expect(commands.get("get_local_file_tree")?.(
      { worktreePath: root, knownDigest: changedTree.digest },
      context,
    )).resolves.toEqual({
      unchanged: true,
      digest: changedTree.digest,
    });
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

  test("caps a local file tree at exactly 5000 nodes", async () => {
    const root = await createTempDir("ork-commands-io-local-cap-");
    for (let offset = 0; offset < 5_001; offset += 250) {
      await Promise.all(
        Array.from(
          { length: Math.min(250, 5_001 - offset) },
          (_, index) => fs.writeFile(
            path.join(root, `file-${String(offset + index).padStart(4, "0")}.txt`),
            "",
          ),
        ),
      );
    }
    const commands = createCommandRegistry();
    const tree = await commands.get("get_local_file_tree")?.(
      { worktreePath: root },
      createContext(),
    ) as Array<{ children?: unknown[] }>;
    const countNodes = (nodes: Array<{ children?: unknown[] }>): number =>
      nodes.reduce(
        (total, node) =>
          total + 1 + countNodes((node.children ?? []) as Array<{ children?: unknown[] }>),
        0,
      );

    expect(countNodes(tree)).toBe(5_000);
  }, 15_000);

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

  test("container base64 reader uses one bounded no-follow file snapshot", async () => {
    const directory = await createTempDir("ork-container-reader-");
    const workspace = path.join(directory, "workspace");
    const outside = path.join(directory, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);

    const regularFile = path.join(workspace, "image.bin");
    await fs.writeFile(regularFile, Buffer.from([0, 1, 2]));
    await expect(runCommand("node", [
      "-e",
      CONTAINER_SAFE_BASE64_READER,
      "--",
      workspace,
      regularFile,
      "3",
    ])).resolves.toMatchObject({ stdout: "AAEC" });

    const oversizedFile = path.join(workspace, "oversized.bin");
    await fs.writeFile(oversizedFile, Buffer.from([0, 1, 2, 3]));
    await expect(runCommand("node", [
      "-e",
      CONTAINER_SAFE_BASE64_READER,
      "--",
      workspace,
      oversizedFile,
      "3",
    ])).rejects.toThrow("File exceeds the attachment size limit");

    const changedFile = path.join(workspace, "changed.bin");
    await fs.writeFile(changedFile, "abc");
    await expect(runCommand("node", [
      "-e",
      buildContainerSafeBase64Reader("append"),
      "--",
      workspace,
      changedFile,
      "10",
    ])).rejects.toThrow("File changed while it was being read");

    const replacedFile = path.join(workspace, "replaced.bin");
    await fs.writeFile(replacedFile, "original");
    await expect(runCommand("node", [
      "-e",
      buildContainerSafeBase64Reader("replace"),
      "--",
      workspace,
      replacedFile,
      "20",
    ])).rejects.toThrow("Attachment is not a stable regular file");

    const directLink = path.join(workspace, "direct.bin");
    const chainLink = path.join(workspace, "chain.bin");
    await fs.symlink(regularFile, directLink);
    await fs.symlink(directLink, chainLink);
    for (const linkedPath of [directLink, chainLink]) {
      await expect(runCommand("node", [
        "-e",
        CONTAINER_SAFE_BASE64_READER,
        "--",
        workspace,
        linkedPath,
        "3",
      ])).rejects.toThrow("Symbolic-link attachments are not allowed");
    }

    const outsideFile = path.join(outside, "private.bin");
    await fs.writeFile(outsideFile, "private");
    const linkedDirectory = path.join(workspace, "linked-directory");
    await fs.symlink(outside, linkedDirectory);
    await expect(runCommand("node", [
      "-e",
      CONTAINER_SAFE_BASE64_READER,
      "--",
      workspace,
      path.join(linkedDirectory, "private.bin"),
      "10",
    ])).rejects.toThrow("Symbolic-link attachments are not allowed");
    await expect(runCommand("node", [
      "-e",
      CONTAINER_SAFE_BASE64_READER,
      "--",
      workspace,
      outsideFile,
      "10",
    ])).rejects.toThrow("File is outside the container workspace");

    const directoryTarget = path.join(workspace, "folder.bin");
    await fs.mkdir(directoryTarget);
    await expect(runCommand("node", [
      "-e",
      CONTAINER_SAFE_BASE64_READER,
      "--",
      workspace,
      directoryTarget,
      "10",
    ])).rejects.toThrow("Attachment is not a stable regular file");
  });

  test("executes container file reads and writes through docker without a live daemon", async () => {
    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"find /workspace"*) printf 'src/app.ts\\nREADME.md\\n' ;;
  *"cat '/workspace/src/app.ts'"*) printf 'export const value = 2;\\n' ;;
  *"git show 'main':'src/app.ts'"*) printf 'export const value = 1;\\n' ;;
  *"git show 'missing':'src/app.ts'"*) ;;
  *"/workspace/assets/blob.bin"*) printf 'AAEC\\n' ;;
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
      const changedTree = await commands.get("get_file_tree")?.(
        { containerId: "container-1", knownDigest: "stale" },
        context,
      ) as {
        unchanged: boolean;
        digest: string;
        value?: unknown;
      };
      expect(changedTree).toMatchObject({
        unchanged: false,
        value: expect.any(Array),
      });
      await expect(commands.get("get_file_tree")?.(
        { containerId: "container-1", knownDigest: changedTree.digest },
        context,
      )).resolves.toEqual({
        unchanged: true,
        digest: changedTree.digest,
      });
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
      const dockerLog = await fs.readFile(logPath, "utf8");
      expect(dockerLog).toContain("-type l -prune");
      expect(dockerLog).toContain("exec -i container-1 bash -lc base64 -d > '/workspace/generated/out.bin'");
    });
  });

  test("returns exactly the configured 5000-file container tree boundary", async () => {
    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
i=1
while [ "$i" -le 5000 ]; do
  printf 'generated/file-%s.ts\\n' "$i"
  i=$((i + 1))
done
`, async ({ logPath }) => {
      const commands = createCommandRegistry();
      const files = await commands.get("get_file_tree")?.(
        { containerId: "container-tree-cap" },
        createContext(),
      ) as Array<{ path: string }>;

      expect(files).toHaveLength(5_000);
      expect(files[0]?.path).toBe("generated/file-1.ts");
      expect(files.at(-1)?.path).toBe("generated/file-5000.ts");
      expect(await fs.readFile(logPath, "utf8")).toContain("head -5000");
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
