import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHubCliSelection } from "./github-cli-binary.js";
import { getGitHubTokenLogin } from "./github-credentials.js";
import type { AppConfig } from "./models.js";
import {
  containerCloneUrl,
  gitMirrorFetchPlan,
  readGitMirrorAccount,
  resolveGitMirrorAccess,
} from "./project-git-mirror-access.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/**
 * A `gh` that answers `auth token` with the host login's token and `api user`
 * with the login of whichever token it was handed, and records its arguments.
 */
async function fakeGh(): Promise<{ selection: GitHubCliSelection; calls: () => Promise<string> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-mirror-access-"));
  roots.push(root);
  const log = path.join(root, "calls");
  const script = path.join(root, "gh");
  await fs.writeFile(
    script,
    `#!/bin/sh
printf '%s|%s\\n' "$*" "\${GH_TOKEN:-}" >> '${log}'
case "$1" in
  auth) echo host-cli-token ;;
  api) case "\${GH_TOKEN:-}" in
    alice-token) echo Alice ;;
    app-token) echo 'my-app[bot]' ;;
    odd-token) echo 'not a login' ;;
    *) echo 'HTTP 401: Bad credentials' >&2; exit 1 ;;
  esac ;;
esac
`,
    { mode: 0o755 },
  );
  const selection = new GitHubCliSelection();
  selection.pin(script);
  return { selection, calls: () => fs.readFile(log, "utf8").catch(() => "") };
}

const global = (value: Partial<AppConfig["global"]>) => value as AppConfig["global"];

describe("the URL a container's clone uses", () => {
  test("follows convert_ssh_to_https", () => {
    expect(containerCloneUrl("git@github.com:acme/repo.git")).toBe(
      "https://github.com/acme/repo.git",
    );
    expect(containerCloneUrl("ssh://git@git.example.com:2222/acme/repo.git")).toBe(
      "https://git.example.com:2222/acme/repo.git",
    );
    expect(containerCloneUrl("https://github.com/acme/repo.git")).toBe(
      "https://github.com/acme/repo.git",
    );
    expect(containerCloneUrl("http://git.example.com/repo.git")).toBe(
      "http://git.example.com/repo.git",
    );
  });

  test("nothing a container could not clone over HTTP(S)", () => {
    expect(containerCloneUrl("/srv/repo.git")).toBeNull();
    expect(containerCloneUrl("file:///srv/repo.git")).toBeNull();
    expect(containerCloneUrl("git@nohost")).toBeNull();
  });
});

describe("which access a new container is given", () => {
  const github = "git@github.com:acme/repo.git";

  test("no container credential (the default) is anonymous, and reads no host token", async () => {
    const gh = await fakeGh();
    expect(
      await resolveGitMirrorAccess({ gitUrl: github, global: global({}), gitHubCli: gh.selection }),
    ).toEqual({ kind: "anonymous" });
    expect(await gh.calls()).toBe("");
  });

  test("a PAT for containers is its own kind, carrying that token", async () => {
    expect(
      await resolveGitMirrorAccess({
        gitUrl: github,
        global: global({ containerGitHubCredential: "pat", githubToken: " pat-token " }),
        gitHubCli: undefined,
      }),
    ).toEqual({ kind: "github-pat", token: "pat-token" });
  });

  test("the host login for containers is its own kind, carrying the host token", async () => {
    const gh = await fakeGh();
    expect(
      await resolveGitMirrorAccess({
        gitUrl: "https://github.com/acme/repo.git",
        global: global({ containerGitHubCredential: "host-cli" }),
        gitHubCli: gh.selection,
      }),
    ).toEqual({ kind: "github-host-cli", token: "host-cli-token" });
  });

  test("a selected source with no token is anonymous, as the container's clone is", async () => {
    expect(
      await resolveGitMirrorAccess({
        gitUrl: github,
        global: global({ containerGitHubCredential: "pat", githubToken: "  " }),
        gitHubCli: undefined,
      }),
    ).toEqual({ kind: "anonymous" });
  });

  test("a remote off GitHub is anonymous: containers are given nothing for other hosts", async () => {
    for (const gitUrl of ["git@gitlab.example.com:acme/repo.git", "http://github.com/acme/repo"]) {
      expect(
        await resolveGitMirrorAccess({
          gitUrl,
          global: global({ containerGitHubCredential: "pat", githubToken: "pat-token" }),
          gitHubCli: undefined,
        }),
      ).toEqual({ kind: "anonymous" });
    }
  });

  test("where containers never get a credential, nor does the mirror", async () => {
    expect(
      await resolveGitMirrorAccess({
        gitUrl: github,
        global: global({ containerGitHubCredential: "pat", githubToken: "pat-token" }),
        gitHubCli: undefined,
        containersGetGitHubCredential: false,
      }),
    ).toEqual({ kind: "anonymous" });
  });

  test("the agent-test fixture remote is anonymous and local", async () => {
    expect(
      await resolveGitMirrorAccess({
        gitUrl: "/data/fixtures/origin.git",
        global: global({ containerGitHubCredential: "pat", githubToken: "pat-token" }),
        gitHubCli: undefined,
        localRemote: true,
      }),
    ).toEqual({ kind: "anonymous", localRemote: true });
  });
});

describe("how a mirror is fetched", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/backend",
    HTTPS_PROXY: "http://proxy.example:3128",
    GIT_CONFIG_GLOBAL: "/home/backend/.gitconfig",
    GIT_CONFIG_PARAMETERS: "'credential.helper'='store'",
    GIT_CONFIG_COUNT: "1",
    GIT_ASKPASS: "/usr/bin/askpass",
    GIT_SSH_COMMAND: "ssh -i key",
    SSH_ASKPASS: "/usr/bin/ssh-askpass",
    GH_TOKEN: "backend-token",
    GITHUB_TOKEN: "backend-token",
    ORKESTRATOR_GITHUB_TOKEN: "backend-token",
  };

  test("anonymous: the converted URL, HTTPS only, no configuration, helper or home of the host's", () => {
    const plan = gitMirrorFetchPlan(
      "git@github.com:acme/repo.git",
      { kind: "anonymous" },
      "/scratch/home",
      base,
    );
    expect(plan).toEqual({
      url: "https://github.com/acme/repo.git",
      gitOptions: ["-c", "credential.helper="],
      env: {
        PATH: "/usr/bin",
        HOME: "/scratch/home",
        HTTPS_PROXY: "http://proxy.example:3128",
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "https",
      },
    });
  });

  test("a GitHub kind sends only its own token, to GitHub over HTTPS, by environment", () => {
    const plan = gitMirrorFetchPlan(
      "https://github.com/acme/repo.git",
      { kind: "github-pat", token: "container-token" },
      "/scratch/home",
      base,
    )!;
    expect(plan.env.ORKESTRATOR_GITHUB_TOKEN).toBe("container-token");
    expect(plan.env.GH_TOKEN).toBeUndefined();
    expect(plan.gitOptions.join(" ")).toContain("credential.https://github.com.helper=");
    expect(plan.gitOptions.join(" ")).not.toContain("container-token");
  });

  test("a plain-HTTP remote is fetched over HTTP, as the container's clone is", () => {
    expect(
      gitMirrorFetchPlan("http://git.example.com/repo.git", { kind: "anonymous" }, "/h", base)?.env
        .GIT_ALLOW_PROTOCOL,
    ).toBe("http");
  });

  test("only the agent-test fixture is fetched as a local path", () => {
    expect(gitMirrorFetchPlan("/srv/origin.git", { kind: "anonymous" }, "/h", base)).toBeNull();
    const local = gitMirrorFetchPlan(
      "/srv/origin.git",
      { kind: "anonymous", localRemote: true },
      "/h",
      base,
    );
    expect(local?.url).toBe("/srv/origin.git");
    expect(local?.env.GIT_ALLOW_PROTOCOL).toBe("file");
  });
});

describe("the account a token acts as", () => {
  test("read with gh, by environment, lower-cased", async () => {
    const gh = await fakeGh();
    expect(await getGitHubTokenLogin("alice-token", gh.selection)).toBe("alice");
    expect(await getGitHubTokenLogin("app-token", gh.selection)).toBe("my-app[bot]");
    const calls = await gh.calls();
    expect(calls).toContain("api --hostname github.com user --jq .login|alice-token");
  });

  test("a refused token, an answer that is no login, or no gh reads as unknown", async () => {
    const gh = await fakeGh();
    expect(await getGitHubTokenLogin("revoked-token", gh.selection)).toBeUndefined();
    expect(await getGitHubTokenLogin("odd-token", gh.selection)).toBeUndefined();
    const missing = new GitHubCliSelection();
    missing.pin(path.join(os.tmpdir(), "ork-no-such-gh", "gh"));
    expect(await getGitHubTokenLogin("alice-token", missing)).toBeUndefined();
  });

  test("anonymous access has no account to read", async () => {
    const gh = await fakeGh();
    expect(await readGitMirrorAccount({ kind: "anonymous" }, gh.selection)).toBeUndefined();
    expect(await gh.calls()).toBe("");
  });
});
