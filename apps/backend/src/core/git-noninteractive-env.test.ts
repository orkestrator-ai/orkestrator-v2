import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { nonInteractiveGitEnv } from "./git-noninteractive-env.js";
import { CommandFailedError, runCommand } from "./shell.js";

import { createNonInteractiveGitFixture } from "./git-noninteractive-test-support.js";

let fixture: Awaited<ReturnType<typeof createNonInteractiveGitFixture>>;
let repo: string;
let baseEnv: NodeJS.ProcessEnv;

function isolatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
  }
  return env;
}

beforeAll(async () => {
  fixture = await createNonInteractiveGitFixture();
  repo = fixture.repo;
  baseEnv = fixture.env;
});

afterAll(async () => {
  await fixture.cleanup();
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
    expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes -i /keys/deploy");
  });

  test("keeps the repository's core.sshCommand", async () => {
    await runCommand("git", ["config", "core.sshCommand", "/usr/bin/ssh -p 2222"], {
      cwd: repo,
      env: isolatedEnv(),
    });
    try {
      const env = await nonInteractiveGitEnv(repo, isolatedEnv());
      expect(env.GIT_SSH_COMMAND).toBe("/usr/bin/ssh -o BatchMode=yes -p 2222");
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
    const env = isolatedEnv({ GIT_SSH_COMMAND: `${fixture.command} -o BatchMode=no` });
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

describe("SSH resolver edge cases", () => {
  test.each([
    "ssh",
    "/usr/bin/ssh",
    "/usr/bin/ssh.exe",
    "'/path with spaces/ssh'",
    '"/path with spaces/ssh.exe"',
  ])("recognizes executable %s", async (program) => {
    const env = await nonInteractiveGitEnv(
      repo,
      isolatedEnv({ GIT_SSH_COMMAND: `${program} -i /keys/deploy` }),
    );
    expect(env.GIT_SSH_COMMAND).toBe(`${program} -o BatchMode=yes -i /keys/deploy`);
  });

  test.each(["ssh", "/usr/bin/ssh", "/path with spaces/ssh"])(
    "enforces direct GIT_SSH=%s",
    async (program) => {
      const env = await nonInteractiveGitEnv(repo, isolatedEnv({ GIT_SSH: program }));
      expect(env.GIT_SSH_COMMAND).toBe(`'${program}' -o BatchMode=yes`);
      expect(env.GIT_SSH).toBe(program);
    },
  );

  test.each(["", "   "])("empty GIT_SSH_COMMAND falls through to config", async (value) => {
    await fixture.git(["config", "core.sshCommand", "ssh -i /keys/repo"]);
    try {
      expect(
        (await nonInteractiveGitEnv(repo, isolatedEnv({ GIT_SSH_COMMAND: value }))).GIT_SSH_COMMAND,
      ).toBe("ssh -o BatchMode=yes -i /keys/repo");
    } finally {
      await fixture.git(["config", "--unset", "core.sshCommand"]);
    }
  });

  test("undefined cwd reads global config and environment wins over config", async () => {
    await fixture.git(["config", "--global", "core.sshCommand", "ssh -p 2222"]);
    try {
      expect((await nonInteractiveGitEnv(undefined, isolatedEnv())).GIT_SSH_COMMAND).toBe(
        "ssh -o BatchMode=yes -p 2222",
      );
      expect(
        (
          await nonInteractiveGitEnv(
            repo,
            isolatedEnv({ GIT_SSH_COMMAND: "ssh -p 3333", GIT_SSH: "wrapper" }),
          )
        ).GIT_SSH_COMMAND,
      ).toBe("ssh -o BatchMode=yes -p 3333");
    } finally {
      await fixture.git(["config", "--global", "--unset", "core.sshCommand"]);
    }
  });

  test.each([false, true])("config failure falls back safely (timeout=%s)", async (timedOut) => {
    const failingRun: typeof runCommand = async (_command, _args, options) => {
      expect(options?.cwd).toBe(repo);
      expect(options?.timeoutMs).toBe(10_000);
      throw new CommandFailedError("config unavailable", { timedOut });
    };
    const env = await nonInteractiveGitEnv(repo, isolatedEnv(), failingRun);
    expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
  });

  test.each(["environment", "config", "GIT_SSH", "GIT_SSH=ssh"])(
    "real OpenSSH confirms BatchMode precedence via %s",
    async (source) => {
      const command = "/usr/bin/ssh -o BatchMode=no -p 2222";
      if (source === "config") await fixture.git(["config", "core.sshCommand", command]);
      try {
        const env = await nonInteractiveGitEnv(
          repo,
          isolatedEnv(
            source === "environment"
              ? { GIT_SSH_COMMAND: command }
              : source.startsWith("GIT_SSH")
                ? { GIT_SSH: source === "GIT_SSH" ? "/usr/bin/ssh" : "ssh" }
                : {},
          ),
        );
        const { stdout } = await runCommand(
          "sh",
          ["-c", `${env.GIT_SSH_COMMAND} -G -F /dev/null example.invalid`],
          { env, timeoutMs: 5_000 },
        );
        expect(stdout).toContain("batchmode yes");
        if (!source.startsWith("GIT_SSH")) expect(stdout).toContain("port 2222");
      } finally {
        if (source === "config") await fixture.git(["config", "--unset", "core.sshCommand"]);
      }
    },
  );
});
