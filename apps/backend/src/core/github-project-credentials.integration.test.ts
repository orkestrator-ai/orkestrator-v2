import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { setManagedGitHubCli } from "./github-cli-binary.js";
import { gitHubGitCredentials } from "./github-git-credentials.js";
import type { GitHubCloneRepositoryList } from "@orkestrator/protocol/github-clone";
import type { Project } from "./models.js";
import { runCommand } from "./shell.js";
import { StorageService } from "./storage.js";

let root: string;
let storage: StorageService;
let saved: NodeJS.ProcessEnv;
const keys = ["GIT_EXEC_PATH", "GH_TOKEN", "GITHUB_TOKEN", "FAKE_GIT_REMOTE", "FAKE_GH_LOG"];
const pat = "selected_pat";

/** Selects a PAT in Settings as this backend's storage reports it. */
function selectPat(githubToken: string | undefined): void {
  const load = StorageService.prototype.loadConfig.bind(storage);
  storage.loadConfig = async () => {
    const config = await load();
    return {
      ...config,
      global: { ...config.global, useHostGitHubCredentials: false, githubToken },
    };
  };
}

beforeEach(async () => {
  saved = { ...process.env };
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-github-transfer-"));
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const remote = path.join(root, "remote.git");
  await runCommand("git", ["init", "--bare", "--initial-branch=main", remote]);
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  // Replace only the HTTPS transport. Git still performs real pack transfers
  // and ref updates, with authentication resolved by its real credential pipeline.
  await fs.writeFile(
    path.join(bin, "git-remote-https"),
    `#!/bin/sh
set -eu
case "$2" in https://github.com/pat-owner/*.git) ;; *) exit 21 ;; esac
credential=$(printf 'url=%s\\n\\n' "$2" | git credential fill)
printf '%s\\n' "$credential" | grep -qx 'password=selected_pat' || exit 22
while IFS= read -r request; do
  case "$request" in
    capabilities) printf 'connect\\n\\n' ;;
    'connect git-upload-pack') printf '\\n'; exec git-upload-pack "$FAKE_GIT_REMOTE" ;;
    'connect git-receive-pack') printf '\\n'; exec git-receive-pack "$FAKE_GIT_REMOTE" ;;
    *) exit 23 ;;
  esac
done
`,
    { mode: 0o755 },
  );
  const gh = path.join(bin, "gh");
  await fs.writeFile(
    gh,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
# Host login exists but cannot access repositories owned by the PAT account.
if test "$*" = 'auth token --hostname github.com'; then echo host_token; exit; fi
if test "$1 $2" = 'config get'; then echo ssh; exit; fi
test "$GH_TOKEN" = selected_pat || exit 24
case "$1 $2" in
  'repo create')
    for arg in "$@"; do case "$arg" in --source=*) source=\${arg#--source=} ;; esac; done
    git -C "$source" remote add origin "git@github.com:pat-owner/$(basename "$source").git" ;;
  'config get') echo ssh ;;
  'api --hostname')
    case "$*" in
      *graphql*) echo '{"data":{"repositoryOwner":{"repositories":{"nodes":[{"name":"private","nameWithOwner":"pat-owner/private","isPrivate":true,"url":"https://github.com/pat-owner/private","sshUrl":"git@github.com:pat-owner/private.git"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}' ;;
      *) echo pat-owner ;;
    esac ;;
  *) exit 25 ;;
esac
`,
    { mode: 0o755 },
  );
  process.env.GIT_EXEC_PATH = bin;
  process.env.FAKE_GIT_REMOTE = remote;
  process.env.FAKE_GH_LOG = path.join(root, "gh.log");
  process.env.GH_TOKEN = "inherited_host_token";
  process.env.GITHUB_TOKEN = "another_host_token";
  setManagedGitHubCli(gh);
  selectPat(pat);
});

afterEach(async () => {
  setManagedGitHubCli(undefined);
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await fs.rm(root, { recursive: true, force: true });
});

function invoke(name: string, args: Record<string, unknown>) {
  const registry = createCommandRegistry();
  const handler = registry.get(name);
  if (!handler) throw new Error(`Unknown command: ${name}`);
  return handler(args, { storage } as CommandContext);
}

test("PAT creation pushes to its private repository and PAT discovery clones it, despite host SSH preferences", async () => {
  const scratch = path.join(root, "scratch");
  const created = (await invoke("create_project_from_scratch", { localPath: scratch })) as Project;
  expect(created.gitUrl).toBe("git@github.com:pat-owner/scratch.git");
  const head = await runCommand("git", ["-C", scratch, "rev-parse", "HEAD"]);
  expect(
    (await runCommand("git", ["--git-dir", process.env.FAKE_GIT_REMOTE!, "rev-parse", "main"]))
      .stdout,
  ).toBe(head.stdout);
  const accounts = await invoke("list_github_clone_accounts", {});
  expect(accounts).toContainEqual({ login: "pat-owner", kind: "user" });
  const page = (await invoke("list_github_clone_repositories", {
    owner: "pat-owner",
  })) as GitHubCloneRepositoryList;
  const cloneUrl = page.repositories[0]!.cloneUrl;
  expect(cloneUrl).toBe("git@github.com:pat-owner/private.git");
  const clone = path.join(root, "clone");
  await invoke("add_project", { gitUrl: cloneUrl, localPath: clone, cloneOnly: true });
  expect((await runCommand("git", ["-C", clone, "rev-parse", "HEAD"])).stdout).toBe(head.stdout);
  for (const folder of [scratch, clone]) {
    const config = await fs.readFile(path.join(folder, ".git", "config"), "utf8");
    expect(config).not.toContain(pat);
    expect(config).not.toContain("credential");
    expect(config).toContain("git@github.com:pat-owner/");
  }
  expect(await storage.loadProjects()).toHaveLength(2);
}, 30_000);

test.each([undefined, "", "   "])(
  "missing PAT %j prevents registry creation, discovery and private cloning before gh/transfer",
  async (githubToken) => {
    selectPat(githubToken);
    await expect(
      invoke("create_project_from_scratch", { localPath: path.join(root, "scratch") }),
    ).rejects.toThrow("personal access token is missing");
    await expect(invoke("list_github_clone_accounts", {})).rejects.toThrow(
      "personal access token is missing",
    );
    await expect(
      invoke("add_project", {
        gitUrl: "https://github.com/pat-owner/private.git",
        localPath: path.join(root, "clone"),
      }),
    ).rejects.toThrow("personal access token is missing");
    expect(await fs.readFile(process.env.FAKE_GH_LOG!, "utf8").catch(() => "")).toBe("");
    expect(await storage.loadProjects()).toHaveLength(0);
    expect(await fs.readdir(root)).not.toContain("scratch");
  },
);

test("the real credential helper overrides host helpers, rejects other hosts/protocols and never persists tokens", async () => {
  const credentials = await gitHubGitCredentials(
    storage,
    "ssh://git@github.com/pat-owner/private.git",
  );
  const args = ["-c", "credential.helper=!echo password=host_token", ...credentials.gitOptions];
  const fill = (url: string) =>
    runCommand("git", [...args, "credential", "fill"], {
      env: { ...credentials.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false" },
      stdin: `url=${url}\n\n`,
    });
  expect((await fill("https://github.com/pat-owner/private.git")).stdout).toContain(
    `password=${pat}`,
  );
  for (const url of [
    "https://example.com/repo",
    "https://github.com.evil.test/repo",
    "http://github.com/repo",
    "https://github.com:8443/repo",
  ]) {
    await expect(fill(url)).rejects.toThrow();
  }
  expect(credentials.gitOptions.join(" ")).not.toContain(pat);
  await runCommand("git", [...args, "credential", "approve"], {
    env: credentials.env,
    stdin: `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${pat}\n\n`,
  });
  expect(await gitHubGitCredentials(storage, "https://example.com/repo.git")).toEqual({
    gitOptions: [],
  });
});
