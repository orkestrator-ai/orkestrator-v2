import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nonInteractiveGitEnv } from "./git-noninteractive-env.js";
import { CommandFailedError, runCommand } from "./shell.js";

let root: string;
let repo: string;
let binDir: string;
let baseEnv: NodeJS.ProcessEnv;

function isolatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-git-noninteractive-")));
  repo = path.join(root, "repo");
  binDir = path.join(root, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(root, "gitconfig"), "");
  baseEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  baseEnv.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
  delete baseEnv.GIT_SSH_COMMAND;
  delete baseEnv.GIT_SSH;
  await runCommand("git", ["init", "-q", repo], { env: baseEnv });

  // Stands in for OpenSSH: without batch mode it blocks the way a passphrase
  // prompt on the controlling terminal does.
  await fs.writeFile(
    path.join(binDir, "ssh"),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "BatchMode=yes" ]; then
    echo "git@example.invalid: Permission denied (publickey)." >&2
    exit 255
  fi
done
sleep 30
`,
  );
  await fs.chmod(path.join(binDir, "ssh"), 0o755);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("nonInteractiveGitEnv", () => {
  test("disables Git and SSH prompts by default", async () => {
    const env = await nonInteractiveGitEnv(repo, isolatedEnv());
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
  });

  test("keeps a GIT_SSH_COMMAND from the environment", async () => {
    const env = await nonInteractiveGitEnv(
      repo,
      isolatedEnv({ GIT_SSH_COMMAND: "ssh -i /keys/deploy" }),
    );
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i /keys/deploy -o BatchMode=yes");
  });

  test("keeps the repository's core.sshCommand", async () => {
    await runCommand("git", ["config", "core.sshCommand", "/usr/bin/ssh -p 2222"], {
      cwd: repo,
      env: isolatedEnv(),
    });
    try {
      const env = await nonInteractiveGitEnv(repo, isolatedEnv());
      expect(env.GIT_SSH_COMMAND).toBe("/usr/bin/ssh -p 2222 -o BatchMode=yes");
    } finally {
      await runCommand("git", ["config", "--unset", "core.sshCommand"], {
        cwd: repo,
        env: isolatedEnv(),
      });
    }
  });

  test("leaves non-OpenSSH wrappers and GIT_SSH programs alone", async () => {
    const wrapper = await nonInteractiveGitEnv(
      repo,
      isolatedEnv({ GIT_SSH_COMMAND: "/opt/bin/plink -batch" }),
    );
    expect(wrapper.GIT_SSH_COMMAND).toBe("/opt/bin/plink -batch");

    const program = await nonInteractiveGitEnv(repo, isolatedEnv({ GIT_SSH: "/opt/bin/my-ssh" }));
    expect(program.GIT_SSH_COMMAND).toBeUndefined();
    expect(program.GIT_SSH).toBe("/opt/bin/my-ssh");
  });

  test("an SSH fetch that would prompt fails fast with ssh's error", async () => {
    const env = isolatedEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` });
    const started = Date.now();
    const error = await runCommand(
      "git",
      ["fetch", "--prune", "git@example.invalid:owner/repo.git"],
      { cwd: repo, env: await nonInteractiveGitEnv(repo, env), timeoutMs: 10_000 },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).timedOut).toBe(false);
    expect((error as Error).message).toContain("Permission denied (publickey)");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
