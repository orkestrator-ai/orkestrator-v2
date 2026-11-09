import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CommandFailedError, runCommand } from "./shell.js";
import {
  detectHttpsRemedy,
  gitHubHttpsUrl,
  gitHubSshRemote,
  probeGitHubHttpsAccess,
  sshConnectFailure,
  switchOriginToHttps,
  USE_HTTPS_REMOTE_ERRORS,
} from "./git-ssh-transport.js";
import { startFailureRemedy } from "./environment-start-remedy.js";
import {
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  gitSshUnreachableMessage,
} from "./commands-error-text.js";

const MAC_OUTPUT = `ssh: connect to host github.com port 22: Operation timed out\r
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.`;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function repoWithOrigin(origin: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-ssh-transport-"));
  tempDirs.push(dir);
  await runCommand("git", ["init", "-q", dir]);
  await runCommand("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

type Call = { command: string; args: readonly string[] };

/**
 * Real git for local config reads and writes; the network-facing calls (the
 * credential-helper lookup and `ls-remote`) answer as scripted, so no test
 * reaches GitHub or reads the developer's credential configuration.
 */
function scriptedGit(script: { helper?: string | null; lsRemote?: "ok" | "fail" }) {
  const calls: Call[] = [];
  const run: typeof runCommand = async (command, args = [], options) => {
    calls.push({ command, args });
    if (command === "git" && args.includes("--get-urlmatch")) {
      if (script.helper === null || script.helper === undefined) {
        throw new CommandFailedError("", { exitCode: 1 });
      }
      return { stdout: `${script.helper}\n`, stderr: "" };
    }
    if (command === "git" && args.includes("ls-remote")) {
      if (script.lsRemote === "ok") return { stdout: "abc\tHEAD\n", stderr: "" };
      throw new CommandFailedError("fatal: unable to access 'https://github.com/x/y.git/'", {
        exitCode: 128,
      });
    }
    return runCommand(command, args, options);
  };
  return { run, calls };
}

describe("sshConnectFailure", () => {
  test("reads the host and port from OpenSSH's connect failure", () => {
    expect(sshConnectFailure(MAC_OUTPUT)).toEqual({ host: "github.com", port: 22 });
    expect(
      sshConnectFailure("ssh: connect to host GitLab.example.com port 2222: Connection refused"),
    ).toEqual({ host: "gitlab.example.com", port: 2222 });
    for (const cause of ["Connection timed out", "Network is unreachable", "No route to host"]) {
      expect(sshConnectFailure(`ssh: connect to host github.com port 22: ${cause}`)).toEqual({
        host: "github.com",
        port: 22,
      });
    }
  });

  test("ignores authentication failures and anything that is not a hostname", () => {
    expect(sshConnectFailure("git@github.com: Permission denied (publickey).")).toBeNull();
    expect(
      sshConnectFailure("ssh: connect to host /tmp/x port 22: Operation timed out"),
    ).toBeNull();
    expect(
      sshConnectFailure("ssh: connect to host github.com port 99999: Operation timed out"),
    ).toBeNull();
  });

  test("the message names the cause and nothing but the host and port", () => {
    const message = gitSshUnreachableMessage({ host: "github.com", port: 22 });
    expect(message).toStartWith(
      "Couldn't reach the git remote over SSH (github.com, port 22). Your network may be blocking SSH.",
    );
  });
});

describe("gitHubSshRemote", () => {
  test.each([
    ["git@github.com:acme/widget.git", "acme", "widget"],
    ["git@github.com:acme/widget", "acme", "widget"],
    ["ssh://git@github.com/acme/widget.git", "acme", "widget"],
    ["ssh://git@github.com:22/acme/my.repo.git", "acme", "my.repo"],
    ["ssh://github.com/acme/widget.git", "acme", "widget"],
  ])("%s", (url, owner, repo) => {
    expect(gitHubSshRemote(url)).toEqual({ owner, repo });
  });

  test.each([
    "https://github.com/acme/widget.git",
    "git@gitlab.com:acme/widget.git",
    "git@github.com:acme/team/widget.git",
    "git@github.com:../widget.git",
    "ssh://git@github.com:2222/acme/widget.git",
    "/srv/repos/widget.git",
  ])("not a GitHub SSH remote: %s", (url) => {
    expect(gitHubSshRemote(url)).toBeNull();
  });

  test("the HTTPS form carries no credential", () => {
    expect(gitHubHttpsUrl({ owner: "acme", repo: "widget" })).toBe(
      "https://github.com/acme/widget.git",
    );
  });
});

describe("probeGitHubHttpsAccess", () => {
  test("needs a credential helper before it tries the network", async () => {
    const { run, calls } = scriptedGit({ helper: null, lsRemote: "ok" });
    await expect(
      probeGitHubHttpsAccess(os.tmpdir(), "https://github.com/a/b.git", run),
    ).resolves.toEqual({ ok: false, reason: "no-credential-helper" });
    expect(calls.some((call) => call.args.includes("ls-remote"))).toBe(false);
  });

  test("an empty helper value resets the list, so it counts as none", async () => {
    const { run } = scriptedGit({ helper: "", lsRemote: "ok" });
    await expect(
      probeGitHubHttpsAccess(os.tmpdir(), "https://github.com/a/b.git", run),
    ).resolves.toEqual({ ok: false, reason: "no-credential-helper" });
  });

  test("lists the HTTPS remote without prompting", async () => {
    const { run, calls } = scriptedGit({ helper: "!gh auth git-credential", lsRemote: "ok" });
    await expect(
      probeGitHubHttpsAccess(os.tmpdir(), "https://github.com/a/b.git", run),
    ).resolves.toEqual({ ok: true });
    const listing = calls.find((call) => call.args.includes("ls-remote"));
    expect(listing?.args).toContain("https://github.com/a/b.git");
  });

  test("a refused listing is unreachable", async () => {
    const { run } = scriptedGit({ helper: "osxkeychain", lsRemote: "fail" });
    await expect(
      probeGitHubHttpsAccess(os.tmpdir(), "https://github.com/a/b.git", run),
    ).resolves.toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("detectHttpsRemedy", () => {
  test("offers HTTPS for a GitHub SSH origin that HTTPS can reach", async () => {
    const repo = await repoWithOrigin("git@github.com:acme/widget.git");
    const { run } = scriptedGit({ helper: "!gh auth git-credential", lsRemote: "ok" });
    await expect(detectHttpsRemedy(repo, run)).resolves.toBe("use-https");
  });

  test("offers nothing when HTTPS fails too, or the remote is not GitHub SSH", async () => {
    const github = await repoWithOrigin("git@github.com:acme/widget.git");
    await expect(
      detectHttpsRemedy(github, scriptedGit({ helper: "x", lsRemote: "fail" }).run),
    ).resolves.toBeNull();
    const gitlab = await repoWithOrigin("git@gitlab.com:acme/widget.git");
    const { run, calls } = scriptedGit({ helper: "x", lsRemote: "ok" });
    await expect(detectHttpsRemedy(gitlab, run)).resolves.toBeNull();
    expect(calls.some((call) => call.args.includes("ls-remote"))).toBe(false);
  });
});

describe("switchOriginToHttps", () => {
  test("points origin at HTTPS once HTTPS is proven to work", async () => {
    const repo = await repoWithOrigin("git@github.com:acme/widget.git");
    const { run } = scriptedGit({ helper: "!gh auth git-credential", lsRemote: "ok" });
    await expect(switchOriginToHttps(repo, run)).resolves.toEqual({
      remoteUrl: "https://github.com/acme/widget.git",
      changed: true,
    });
    const { stdout } = await runCommand("git", [
      "-C",
      repo,
      "config",
      "--get",
      "remote.origin.url",
    ]);
    expect(stdout.trim()).toBe("https://github.com/acme/widget.git");

    // Asking again is done, not an error.
    await expect(switchOriginToHttps(repo, run)).resolves.toEqual({
      remoteUrl: "https://github.com/acme/widget.git",
      changed: false,
    });
  });

  test("already-HTTPS origins return no credentials and perform no mutation", async () => {
    const repo = await repoWithOrigin("https://x@github.com/acme/widget.git");
    const { run, calls } = scriptedGit({});
    await expect(switchOriginToHttps(repo, run)).resolves.toEqual({
      remoteUrl: "https://github.com/acme/widget.git",
      changed: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["-C", repo, "config", "--get", "remote.origin.url"]);
  });

  test("leaves origin alone when HTTPS would not work", async () => {
    const repo = await repoWithOrigin("git@github.com:acme/widget.git");
    await expect(switchOriginToHttps(repo, scriptedGit({ helper: null }).run)).rejects.toThrow(
      USE_HTTPS_REMOTE_ERRORS.noCredentialHelper,
    );
    await expect(
      switchOriginToHttps(repo, scriptedGit({ helper: "x", lsRemote: "fail" }).run),
    ).rejects.toThrow(USE_HTTPS_REMOTE_ERRORS.unreachable);
    const { stdout } = await runCommand("git", [
      "-C",
      repo,
      "config",
      "--get",
      "remote.origin.url",
    ]);
    expect(stdout.trim()).toBe("git@github.com:acme/widget.git");
  });

  test("refuses a remote that is not GitHub SSH", async () => {
    const repo = await repoWithOrigin("git@gitlab.com:acme/widget.git");
    await expect(
      switchOriginToHttps(repo, scriptedGit({ helper: "x", lsRemote: "ok" }).run),
    ).rejects.toThrow(USE_HTTPS_REMOTE_ERRORS.notGitHubSsh);
  });
});

describe("startFailureRemedy", () => {
  const unreachable = gitSshUnreachableMessage({ host: "github.com", port: 22 });

  test("checks HTTPS only for a local start that could not reach the remote", async () => {
    const repo = await repoWithOrigin("git@github.com:acme/widget.git");
    const storage = { getProject: async () => ({ localPath: repo }) as never };
    const { run, calls } = scriptedGit({ helper: "x", lsRemote: "ok" });
    const local = { environmentType: "local" as const, projectId: "p" };

    await expect(startFailureRemedy(local, unreachable, storage, run)).resolves.toBe("use-https");
    await expect(
      startFailureRemedy(
        local,
        ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitRemoteTimedOut,
        storage,
        run,
      ),
    ).resolves.toBe("use-https");

    const before = calls.length;
    await expect(
      startFailureRemedy(
        local,
        ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitSshAuthentication,
        storage,
        run,
      ),
    ).resolves.toBeNull();
    await expect(
      startFailureRemedy(
        { environmentType: "containerized", projectId: "p" },
        unreachable,
        storage,
        run,
      ),
    ).resolves.toBeNull();
    expect(calls.length).toBe(before);
  });

  test("a failed check offers nothing", async () => {
    const storage = {
      getProject: async () => {
        throw new Error("storage unavailable");
      },
    };
    await expect(
      startFailureRemedy({ environmentType: "local", projectId: "p" }, unreachable, storage),
    ).resolves.toBeNull();
  });
});
