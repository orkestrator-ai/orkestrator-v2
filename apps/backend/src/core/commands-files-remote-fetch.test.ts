import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as shell from "./shell.js";
import { CommandFailedError, GitRemoteTimeoutError } from "./shell.js";
import { resolveRemoteWorktreeStartPoint } from "./commands-files.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** A credential-free Git fixture that can exercise the selected SSH command. */
async function useRecordingGit(
  options: { sshCommandConfig?: string; variantConfig?: string; fetchScript?: string } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-remote-fetch-"));
  const record = path.join(root, "fetch-env.txt");
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(
    path.join(binDir, "git"),
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    fetch)
      printf 'prompt=%s ssh=%s' "$GIT_TERMINAL_PROMPT" "$GIT_SSH_COMMAND" > ${quote(record)}
      ${options.fetchScript ?? "exit 0"}
      ;;
    config)
      for key in "$@"; do
        case "$key" in
          core.sshCommand) ${options.sshCommandConfig === undefined ? "exit 1" : `printf '%s\\n' ${quote(options.sshCommandConfig)}; exit 0`} ;;
          ssh.variant) ${options.variantConfig === undefined ? "exit 1" : `printf '%s\\n' ${quote(options.variantConfig)}; exit 0`} ;;
        esac
      done
      exit 1 ;;
    rev-parse) exit 0 ;;
  esac
done
exit 0
`,
  );
  await fs.chmod(path.join(binDir, "git"), 0o755);

  const names = ["PATH", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"] as const;
  const original = names.map((name) => process.env[name]);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  for (const name of names.slice(1)) delete process.env[name];
  cleanups.push(async () => {
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    recorded: () => fs.readFile(record, "utf8"),
    transport: async (name: string, script: string) => {
      const executable = path.join(root, name);
      await fs.writeFile(executable, `#!/bin/sh\n${script}\n`);
      await fs.chmod(executable, 0o755);
      return executable;
    },
  };
}

describe("resolveRemoteWorktreeStartPoint", () => {
  test("fetches without any chance of prompting on the backend's terminal", async () => {
    const git = await useRecordingGit();

    await resolveRemoteWorktreeStartPoint("/repo", "main");

    expect(await git.recorded()).toBe("prompt=0 ssh=ssh -o BatchMode=yes");
  });

  test("keeps a configured ssh command and only adds BatchMode", async () => {
    const git = await useRecordingGit({ sshCommandConfig: "ssh -i /keys/work" });

    await resolveRemoteWorktreeStartPoint("/repo", "main");

    expect(await git.recorded()).toBe("prompt=0 ssh=ssh -o BatchMode=yes -i /keys/work");
  });
});

describe("SSH command precedence and argument contracts", () => {
  test("GIT_SSH_COMMAND wins over GIT_SSH and repository config", async () => {
    const git = await useRecordingGit({ sshCommandConfig: "plink -i config-key" });
    process.env.GIT_SSH = "/custom/wrapper";
    process.env.GIT_SSH_COMMAND = "ssh -i env-key";
    await resolveRemoteWorktreeStartPoint("/repo", "main");
    expect(await git.recorded()).toBe("prompt=0 ssh=ssh -o BatchMode=yes -i env-key");
    expect(process.env.GIT_SSH).toBe("/custom/wrapper");
  });

  test("core.sshCommand wins over GIT_SSH", async () => {
    const git = await useRecordingGit({ sshCommandConfig: "ssh -i config-key" });
    process.env.GIT_SSH = "/custom/wrapper";
    await resolveRemoteWorktreeStartPoint("/repo", "main");
    expect(await git.recorded()).toBe("prompt=0 ssh=ssh -o BatchMode=yes -i config-key");
  });

  test("keeps an arbitrary selected GIT_SSH program", async () => {
    const git = await useRecordingGit();
    process.env.GIT_SSH = "/custom/wrapper";
    await resolveRemoteWorktreeStartPoint("/repo", "main");
    expect(await git.recorded()).toBe("prompt=0 ssh=");
  });

  test.each(["simple", "plink", "putty", "tortoiseplink"])(
    "preserves %s arguments through a real Git SSH fetch",
    async (variant) => {
      const { stdout } = await shell.runCommand("which", ["git"]);
      const realGit = stdout.trim();
      const git = await useRecordingGit();
      const argvPath = path.join(git.root, "ssh-argv.txt");
      const transport = await git.transport(
        "transport with spaces",
        `
printf '%s\\n' "$@" > ${quote(argvPath)}
${variant === "simple" ? '[ "$#" -eq 2 ] || exit 91' : ""}
exit 17
`,
      );
      await fs.writeFile(
        path.join(git.root, "bin", "git"),
        `#!/bin/sh\nexec ${quote(realGit)} "$@"\n`,
      );
      await shell.runCommand(realGit, ["init", git.root]);
      await shell.runCommand(realGit, [
        "-C",
        git.root,
        "remote",
        "add",
        "origin",
        "git@example.invalid:repo.git",
      ]);
      await shell.runCommand(realGit, [
        "-C",
        git.root,
        "config",
        "core.sshCommand",
        quote(transport),
      ]);
      await shell.runCommand(realGit, ["-C", git.root, "config", "ssh.variant", variant]);
      if (variant === "simple") process.env.GIT_SSH_VARIANT = "simple";
      // The transport refuses the connection after recording Git's actual argv.
      await expect(resolveRemoteWorktreeStartPoint(git.root, "main")).rejects.toBeInstanceOf(
        CommandFailedError,
      );
      const argv = (await fs.readFile(argvPath, "utf8")).trimEnd().split("\n");
      expect(argv).toEqual([
        ...(variant === "tortoiseplink" ? ["-batch"] : []),
        "git@example.invalid",
        "git-upload-pack 'repo.git'",
      ]);
    },
  );

  test("environment variant overrides repository config", async () => {
    const git = await useRecordingGit({ sshCommandConfig: "ssh", variantConfig: "ssh" });
    process.env.GIT_SSH_VARIANT = "simple";
    await resolveRemoteWorktreeStartPoint("/repo", "main");
    expect(await git.recorded()).toBe("prompt=0 ssh=");
  });

  test.each(["plink", "putty", "tortoiseplink", "custom-wrapper"])(
    "does not add OpenSSH options to auto-detected %s",
    async (command) => {
      const git = await useRecordingGit({ sshCommandConfig: `${command} -i key` });
      await resolveRemoteWorktreeStartPoint("/repo", "main");
      expect(await git.recorded()).toBe("prompt=0 ssh=");
    },
  );

  test("keeps a quoted OpenSSH executable and its configured arguments", async () => {
    const git = await useRecordingGit({
      fetchScript: String.raw`exec sh -c "$GIT_SSH_COMMAND \"\$@\"" transport git@example.invalid "git-upload-pack '/repo.git'"`,
    });
    const transport = await git.transport(
      "ssh with spaces",
      `
[ "$#" -eq 8 ] || exit 91
[ "$1" = "-o" ] && [ "$2" = "BatchMode=yes" ] || exit 92
[ "$3" = "-o" ] && [ "$4" = "BatchMode=no" ] || exit 93
[ "$5" = "-i" ] && [ "$6" = "key with spaces" ] || exit 94
[ "$7" = "git@example.invalid" ] || exit 95
[ "$8" = "git-upload-pack '/repo.git'" ] || exit 96
`,
    );
    process.env.GIT_SSH_COMMAND = `${quote(transport)} -o BatchMode=no -i 'key with spaces'`;
    process.env.GIT_SSH_VARIANT = "ssh";
    await resolveRemoteWorktreeStartPoint("/repo", "main");
    expect(await git.recorded()).toBe(
      `prompt=0 ssh=${quote(transport)} -o BatchMode=yes -o BatchMode=no -i 'key with spaces'`,
    );
  });

  test("enforces the effective OpenSSH BatchMode despite a configured no", async () => {
    const git = await useRecordingGit({
      fetchScript: `exec sh -c "$GIT_SSH_COMMAND -G example.invalid" > ssh-config.txt`,
    });
    process.env.GIT_SSH_COMMAND = "ssh -F /dev/null -o BatchMode=no -i '/keys/work key'";
    // Use an isolated cwd for the read-only ssh -G output.
    const realRun = shell.runCommand;
    const run = spyOn(shell, "runCommand").mockImplementation((command, args, options) =>
      realRun(command, args, { ...options, cwd: git.root }),
    );
    try {
      await resolveRemoteWorktreeStartPoint("/repo", "main");
      expect(await fs.readFile(path.join(git.root, "ssh-config.txt"), "utf8")).toContain(
        "batchmode yes",
      );
      expect(await git.recorded()).toBe(
        "prompt=0 ssh=ssh -o BatchMode=yes -F /dev/null -o BatchMode=no -i '/keys/work key'",
      );
    } finally {
      run.mockRestore();
    }
  });
});

describe("remote fetch failure outcomes", () => {
  test("converts a real subprocess timeout and preserves the timeout and signal", async () => {
    await useRecordingGit({ fetchScript: "exec sleep 5" });
    const realRun = shell.runCommand;
    const run = spyOn(shell, "runCommand").mockImplementation((command, args = [], options) =>
      realRun(command, args, args.includes("fetch") ? { ...options, timeoutMs: 20 } : options),
    );
    try {
      const failure = await resolveRemoteWorktreeStartPoint("/repo", "main").catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(GitRemoteTimeoutError);
      expect(failure).toBeInstanceOf(CommandFailedError);
      expect(failure).toMatchObject({ timedOut: true, signal: "SIGTERM", exitCode: null });
      expect(run.mock.calls.find(([, args]) => args?.includes("fetch"))?.[2]?.timeoutMs).toBe(
        120_000,
      );
      expect(run.mock.calls.some(([, args]) => args?.includes("rev-parse"))).toBe(false);
    } finally {
      run.mockRestore();
    }
  });

  test("propagates non-timeout fetch failures unchanged", async () => {
    await useRecordingGit({ fetchScript: "printf 'remote refused\\n' >&2; exit 17" });
    const failure = await resolveRemoteWorktreeStartPoint("/repo", "main").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect(failure).not.toBeInstanceOf(GitRemoteTimeoutError);
    expect(failure).toMatchObject({
      message: "remote refused",
      timedOut: false,
      exitCode: 17,
      signal: null,
    });
  });
});
