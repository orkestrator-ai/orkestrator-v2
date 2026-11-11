import * as credentialModes from "../src/core/container-credential-mode.js";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { withheldGitHubCredentialEnvironment } from "@orkestrator/protocol/native-agent";

import { createCommandFixtures } from "./command-fixtures";

const {
  ASYNC_TEST_BUDGET_MS,
  commandTesting,
  createCommandRegistry,
  createContext,
  createEnvironment,
  createTempDir,
  fs,
  path,
  reserveFreePort,
  runGit,
  spawnSync,
  withFakeDocker,
} = await createCommandFixtures();

import type { Environment } from "./command-fixtures";

describe("Electron backend command registry", () => {
  // The `security` stub only takes effect on darwin, where `getHostClaudeCredentials`
  // consults the Keychain; elsewhere resolution starts at the on-disk credential.
  // Seeding both with the same payload keeps these tests asserting the same thing
  // on every platform instead of silently depending on the developer's OS.

  test("refuses every foreground lifecycle command once shutdown has begun", async () => {
    const environment = createEnvironment({
      id: "env-foreground-shutdown",
      environmentType: "containerized",
      containerId: "container-shutdown",
      status: "running",
      lifecycleError: "Previous failure",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    await context.environmentLifecycleTasks.beginShutdown();

    for (const command of [
      "start_environment",
      "stop_environment",
      "recreate_environment",
      "delete_environment",
    ]) {
      await expect(
        commands.get(command)?.({ environmentId: environment.id }, context),
      ).rejects.toThrow("Backend is shutting down");
    }

    // Refusal is total: nothing was mutated on the way out.
    expect(environment.status).toBe("running");
    expect(environment.containerId).toBe("container-shutdown");
    expect(environment.lifecycleError).toBe("Previous failure");
    // A refused delete must not keep the tombstone that blocks local-server
    // starts and merges for this environment.
    expect(context.runtime.environments.isDeleting(environment.id)).toBe(false);
  });

  test("gives an image without the helper the token-bearing rewrite, idempotently", async () => {
    const home = await createTempDir("ork-github-config-home-");
    const credentialFile = path.join(home, "runtime", "github-token");
    // Git prefers $XDG_CONFIG_HOME/git/config over $HOME/.gitconfig. In an
    // XDG-configured developer shell, overriding HOME alone lets this test's
    // placeholder token rewrite the developer's real global Git config. Pin
    // the global file explicitly as a second barrier against ambient Git path
    // configuration being added to the test runner later.
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sync = spawnSync(
        "bash",
        ["-c", commandTesting.buildSyncContainerGitHubCredentialCommand(credentialFile)],
        { env, input: "token-value", encoding: "utf8" },
      );
      expect(sync.status).toBe(0);
    }

    const values = spawnSync(
      "git",
      [
        "config",
        "--global",
        "--get-all",
        "url.https://x-access-token:token-value@github.com/.insteadOf",
      ],
      { env, encoding: "utf8" },
    );
    expect(values.status).toBe(0);
    expect(values.stdout.trim().split("\n")).toEqual([
      "https://github.com/",
      "https://github.com",
      "git@github.com:",
    ]);
  });

  describe("GitHub credential helper", () => {
    const repoRoot = path.join(import.meta.dir, "../../..");
    let helper = "";

    async function helperEnvironment() {
      const home = await createTempDir("ork-github-helper-home-");
      // The image build marks it executable; the checkout need not.
      helper = path.join(home, "git-credential");
      await fs.copyFile(path.join(repoRoot, "docker/orkestrator-git-credential.sh"), helper);
      await fs.chmod(helper, 0o755);
      const credentialFile = path.join(home, "runtime", "github-token");
      return {
        home,
        credentialFile,
        // See the note on the test above: never let this reach a real Git config.
        // Only PATH is inherited, so no askpass, config or token in the runner's
        // environment can answer for the fixture.
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CEILING_DIRECTORIES: path.dirname(home),
          GIT_TERMINAL_PROMPT: "0",
          ORKESTRATOR_GITHUB_CREDENTIAL_FILE: credentialFile,
          GITHUB_TOKEN: "",
          GH_TOKEN: "",
        },
      };
    }

    function sync(env: NodeJS.ProcessEnv, credentialFile: string, token: string) {
      const result = spawnSync(
        "bash",
        ["-c", commandTesting.buildSyncContainerGitHubCredentialCommand(credentialFile, helper)],
        { env, input: token, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
    }

    // What Git itself would send, through whichever helpers its config selects.
    // Run outside any repository: Git also reads the config of the repository it
    // starts in, so from a checkout with its own credential.helper it would ask
    // that helper for the developer's real login.
    function fillResult(env: NodeJS.ProcessEnv, url: string) {
      return spawnSync("git", ["credential", "fill"], {
        cwd: path.dirname(helper),
        env,
        input: `url=${url}\n\n`,
        encoding: "utf8",
      });
    }

    function fill(env: NodeJS.ProcessEnv, url: string, extraEnv: NodeJS.ProcessEnv = {}) {
      return fillResult({ ...env, ...extraEnv }, url).stdout;
    }

    async function setupCredentialBlock(): Promise<string> {
      const script = await fs.readFile(path.join(repoRoot, "docker/workspace-setup.sh"), "utf8");
      const start = script.indexOf('TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"');
      const end = script.indexOf("\nprint_workspace_disk_status()", start);
      expect(start).toBeGreaterThanOrEqual(0);
      return script
        .slice(start, end)
        .replaceAll("/usr/local/bin/orkestrator-git-credential", helper);
    }

    // One home walks a token through its life: installed, rotated, refused to
    // other hosts and to a withheld session, then removed.
    test("answers Git from the token file, only for GitHub over HTTPS, until an empty token removes it", async () => {
      const { env, home, credentialFile } = await helperEnvironment();
      sync(env, credentialFile, "first-token");

      expect(fill(env, "https://github.com/owner/repo.git")).toContain("password=first-token");
      expect(await fs.readFile(path.join(home, ".gitconfig"), "utf8")).not.toContain("first-token");

      // A rotated token applies with no config change; SSH remotes come along.
      await fs.writeFile(credentialFile, "second-token");
      expect(fill(env, "https://github.com/owner/repo.git")).toContain("password=second-token");
      const rewrite = spawnSync(
        "git",
        ["config", "--global", "--get", "url.https://github.com/.insteadOf"],
        { env, encoding: "utf8" },
      );
      expect(rewrite.stdout.trim()).toBe("git@github.com:");

      // Never to another host or over plain HTTP.
      for (const url of [
        "https://example.com/owner/repo.git",
        "https://github.com.example.com/owner/repo.git",
        "http://github.com/owner/repo.git",
      ]) {
        expect(fill(env, url)).not.toContain("second-token");
      }
      // Not through the helper directly either, whatever the config scoping.
      const direct = spawnSync(helper, ["get"], {
        env,
        input: "protocol=https\nhost=example.com\n\n",
        encoding: "utf8",
      });
      expect(direct.stdout).toBe("");
      const store = spawnSync(helper, ["store"], {
        env,
        input: "protocol=https\nhost=github.com\n\n",
        encoding: "utf8",
      });
      expect(store.stdout).toBe("");

      // A session whose GitHub credential is withheld gets nothing from it.
      const withheld = withheldGitHubCredentialEnvironment(env, { ghConfigDir: "/nonexistent" });
      expect(
        fill(withheld as NodeJS.ProcessEnv, "https://github.com/owner/repo.git"),
      ).not.toContain("second-token");

      // An empty token removes the helper and the SSH rewrite.
      sync(env, credentialFile, "");
      const config = await fs.readFile(path.join(home, ".gitconfig"), "utf8");
      expect(config).not.toContain(helper);
      expect(config).not.toContain("git@github.com:");
      expect(fill(env, "https://github.com/owner/repo.git")).not.toContain("password=");
    });

    test("the fixture is not answered by the runner's checkout or environment", async () => {
      const ambient = "password=ambient-fake-credential";
      const answer = `!f() { echo username=ambient; echo ${ambient}; }; f`;
      const checkout = await createTempDir("ork-github-helper-checkout-");
      await runGit(checkout, ["init", "-b", "work", "."]);
      await runGit(checkout, ["config", "--local", "credential.helper", answer]);
      const askpass = path.join(checkout, "askpass.sh");
      await fs.writeFile(askpass, "#!/bin/sh\necho ambient-fake-credential\n", { mode: 0o755 });

      const url = "https://github.com/owner/repo.git";
      const runnerCwd = process.cwd();
      const runnerEnv = { ...process.env };
      Object.assign(process.env, {
        GIT_ASKPASS: askpass,
        SSH_ASKPASS: askpass,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: answer,
      });
      process.chdir(checkout);
      try {
        const { env, credentialFile } = await helperEnvironment();
        // A control: run from inside that checkout, Git does consult its helper.
        const control = spawnSync("git", ["credential", "fill"], {
          cwd: checkout,
          env,
          input: `url=${url}\n\n`,
          encoding: "utf8",
        });
        expect(control.stdout).toContain(ambient);

        sync(env, credentialFile, "");
        const filled = fill(env, url);
        expect(filled).not.toContain(ambient);
        expect(filled).not.toContain("password=");
      } finally {
        process.chdir(runnerCwd);
        for (const name of Object.keys(process.env)) {
          if (!(name in runnerEnv)) delete process.env[name];
        }
        Object.assign(process.env, runnerEnv);
      }
    });

    // A home carrying both kinds of leftover at once: each must be replaced.
    test("replaces a token-bearing rewrite an older image left and a GitHub helper copied from a host config", async () => {
      const { env, home, credentialFile } = await helperEnvironment();
      const legacy = spawnSync(
        "bash",
        ["-c", commandTesting.buildSyncContainerGitHubCredentialCommand(credentialFile)],
        { env, input: "old-token", encoding: "utf8" },
      );
      expect(legacy.status).toBe(0);
      expect(await fs.readFile(path.join(home, ".gitconfig"), "utf8")).toContain("old-token");
      // What `gh auth setup-git` writes on a Mac; the path does not exist here.
      await fs.appendFile(
        path.join(home, ".gitconfig"),
        '[credential "https://github.com"]\n\thelper =\n\thelper = !/opt/homebrew/bin/gh auth git-credential\n',
      );
      sync(env, credentialFile, "new-token");

      const config = await fs.readFile(path.join(home, ".gitconfig"), "utf8");
      expect(config).not.toContain("old-token");
      expect(config).not.toContain("homebrew");
      const filled = fillResult(env, "https://github.com/owner/repo.git");
      expect(filled.stdout).toContain("password=new-token");
      expect(filled.stderr).not.toContain("homebrew");
    });

    test("keeps working after setup clears credential.helper, on either order", async () => {
      const { env, home, credentialFile } = await helperEnvironment();
      const setup = await setupCredentialBlock();
      // A container with no host gitconfig: nothing has set credential.helper
      // yet, so setup's reset is appended after what sync installed.
      sync(env, credentialFile, "secret-token");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const configured = spawnSync("bash", ["-c", setup], {
          env: { ...env, GH_TOKEN: "secret-token" },
          encoding: "utf8",
        });
        expect(configured.status).toBe(0);
        expect(fill(env, "https://github.com/owner/repo.git")).toContain("password=secret-token");
      }
      expect(await fs.readFile(path.join(home, ".gitconfig"), "utf8")).not.toContain(
        "secret-token",
      );

      sync(env, credentialFile, "secret-token");
      expect(fill(env, "https://github.com/owner/repo.git")).toContain("password=secret-token");
    });

    test("takes a token out of an origin left by an earlier clone", async () => {
      const { env, credentialFile } = await helperEnvironment();
      const workspace = await createTempDir("ork-github-helper-workspace-");
      await runGit(workspace, ["init", "-b", "work", "."]);
      await runGit(workspace, [
        "remote",
        "add",
        "origin",
        "https://x-access-token:old-token@github.com/owner/repo.git",
      ]);
      const command = commandTesting
        .buildSyncContainerGitHubCredentialCommand(credentialFile, helper)
        .replaceAll("git -C /workspace", `git -C ${workspace}`);
      const result = spawnSync("bash", ["-c", command], { env, input: "", encoding: "utf8" });
      expect(result.status).toBe(0);

      const origin = spawnSync("git", ["-C", workspace, "remote", "get-url", "origin"], {
        env,
        encoding: "utf8",
      });
      expect(origin.stdout.trim()).toBe("https://github.com/owner/repo.git");
    });
  });

  test(
    "survives a login shell whose logout hook fails",
    async () => {
      const workspace = await createTempDir("ork-container-script-nonrepo-");
      const home = await createTempDir("ork-container-script-home-");
      // Debian's ~/.bash_logout runs `clear_console -q`, which fails when no console
      // is attached. Under `set -e` a failing logout hook replaces the script's own
      // exit status, which turned an empty status into an error for every workspace
      // that had not been cloned yet.
      await fs.writeFile(path.join(home, ".bash_logout"), "false\n");
      const loginEnv = { ...process.env, HOME: home };
      const script = commandTesting.buildContainerGitStatusScript("main", true);

      const nonRepo = spawnSync("bash", ["-lc", script], {
        cwd: workspace,
        encoding: "utf8",
        env: loginEnv,
      });
      expect(nonRepo.status).toBe(0);
      expect(nonRepo.stdout).toBe("");
      expect(commandTesting.parseContainerGitStatusResponse(nonRepo.stdout, true)).toEqual([]);

      const repo = await createTempDir("ork-container-script-missing-ref-");
      await runGit(repo, ["init", "-b", "work", "."]);
      await fs.writeFile(path.join(repo, "file.txt"), "a\n");
      await runGit(repo, ["add", "-A"]);
      await runGit(repo, ["commit", "-m", "base"]);
      const missingRef = spawnSync(
        "bash",
        [
          "-lc",
          commandTesting.buildContainerGitStatusScript(
            "0123456789012345678901234567890123456789",
            true,
          ),
        ],
        { cwd: repo, encoding: "utf8", env: loginEnv },
      );
      expect(missingRef.status).toBe(0);
      expect(commandTesting.isMissingTargetRefResponse(missingRef.stdout)).toBe(true);
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("releases local and container merge guards when lifecycle persistence fails", async () => {
    for (const kind of ["local", "container"] as const) {
      const environment = createEnvironment(
        kind === "local"
          ? {
              id: "env-local-lifecycle-failure",
              worktreePath: "/tmp/worktree",
              prUrl: "https://github.com/acme/repo/pull/42",
            }
          : {
              id: "env-container-lifecycle-failure",
              environmentType: "containerized",
              worktreePath: undefined,
              containerId: "container-1",
              status: "running",
            },
      );
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
      let failLifecycleWrite = true;
      context.storage.updateEnvironment = mock(
        async (environmentId: string, updates: Partial<Environment>) => {
          if (updates.lifecycleOperation === "merging" && failLifecycleWrite) {
            failLifecycleWrite = false;
            throw new Error("lifecycle storage unavailable");
          }
          return updateEnvironment(environmentId, updates);
        },
      );

      const command = kind === "local" ? "merge_pr_local" : "merge_pr";
      const argumentsFor = (method: string) =>
        kind === "local"
          ? { environmentId: environment.id, method, deleteBranch: false }
          : { containerId: environment.containerId, method, deleteBranch: false };

      await expect(commands.get(command)?.(argumentsFor("squash"), context)).rejects.toThrow(
        "lifecycle storage unavailable",
      );

      // An invalid method fails after acquiring the guard. If the first call
      // leaked that guard, this would instead report "already being merged".
      await expect(commands.get(command)?.(argumentsFor("fast-forward"), context)).rejects.toThrow(
        "Invalid merge method: fast-forward",
      );
    }
  });

  test.each([
    ["Claude", "start_claude_server", "container-claude-redaction", "CLAUDE_BRIDGE_TOKEN"],
    // OpenCode 2 refuses a token-file image, so its case runs on a verifier image.
    ["OpenCode", "start_opencode_server", "container-opencode-redaction", "OPENCODE_PASSWORD"],
  ] as const)(
    "redacts a generated %s container credential when detached startup fails",
    async (_label, commandName, containerId, credentialName) => {
      const hostPort = await reserveFreePort();
      const environment = createEnvironment({
        id: `env-${containerId}`,
        environmentType: "containerized",
        containerId,
        status: "running",
      });
      const { context } = createContext(environment);
      if (commandName === "start_opencode_server") credentialModeSpy.mockResolvedValue("verifier");
      const commands = createCommandRegistry();
      const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
      process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
      const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"/run/orkestrator-bridge/"*) exit 0 ;;
      *"ss -Hltne"*) exit 0 ;; # the listener stop (#2030): nothing of the agent's listens
      *"cat > /tmp/.orkestrator-start-"*) cat > "$FAKE_DOCKER_EXEC_LOG.secrets"; exit 0 ;;
    esac
    case "$*" in
      *"cat /tmp/claude-bridge-token"*)
        exit 0 ;;
    esac
    exit 9 ;;
esac
exit 0
`;

      try {
        await withFakeDocker(dockerScript, async (logs) => {
          const failure = await Promise.resolve(
            commands.get(commandName)?.({ containerId }, context),
          ).then(
            () => null,
            (error: unknown) => error as Error,
          );

          expect(failure).toBeInstanceOf(Error);
          const execLog = await fs.readFile(logs.exec, "utf8");
          const secrets = await fs.readFile(`${logs.exec}.secrets`, "utf8");
          const token = secrets.match(new RegExp(`${credentialName}='([^']+)'`))?.[1];
          // Only stdin carried it, so a failed exec has it nowhere to leak from.
          expect(execLog).not.toContain(token!);
          expect(token).toMatch(/^okb_[A-Za-z0-9_-]{43}$/);
          expect(failure!.message).not.toContain(token!);
        });
      } finally {
        if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
        else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      }
    },
  );
});

// These command fixtures intentionally represent legacy token-file images.
let credentialModeSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  credentialModeSpy = spyOn(credentialModes, "containerCredentialMode").mockResolvedValue(
    "token-file",
  );
});
afterEach(() => credentialModeSpy.mockRestore());
