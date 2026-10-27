import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ORKESTRATOR_SECTION_NOTE } from "@orkestrator/protocol/agents-md-orkestrator";
import {
  AGENTS_MD_GENERATED_BY,
  AgentsMdPrError,
  agentsMdBranchName,
  defaultAgentsMdPrDependencies,
  openAgentsMdPullRequest,
  readAgentsMdSectionFromBase,
  type AgentsMdPrDependencies,
} from "./agents-md-pr.js";
import { CommandFailedError, runCommand } from "./shell.js";

// Real Git against a local bare "origin"; only `gh` is faked, so nothing
// reaches GitHub.

const TIMEOUT = 60_000;
const KEY = "0123456789abcdef01234567";
const AGENTS = [
  "# Agent Instructions",
  "",
  "Keep this exactly.\tTabs and trailing spaces  ",
  "",
  "## Orkestrator",
  "",
  "- Never touch ports 34121/34122.",
  "",
  "## Testing",
  "",
  "```bash",
  "# not a heading",
  "```",
  "",
].join("\n");

let root: string;
let origin: string;
let seed: string;
let checkout: string;
let prs: Array<{
  url: string;
  head: string;
  base: string;
  body: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
}>;
let ghCalls: string[][];
let ghAuthOk: boolean;
let ghMissing: boolean;
let failCreateOnce: boolean;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", args, { cwd, timeoutMs: TIMEOUT })).stdout;
}

async function configure(cwd: string) {
  await git(cwd, "config", "user.name", "Test User");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "commit.gpgsign", "false");
}

async function pushSeed(files: Record<string, string>, message = "seed") {
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(seed, name), content);
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", message);
  await git(seed, "push", "-q", "origin", "HEAD:main");
}

function deps(): AgentsMdPrDependencies {
  const real = defaultAgentsMdPrDependencies();
  return {
    ...real,
    worktreeRoot: path.join(root, "worktrees"),
    gh: async (args) => {
      ghCalls.push(args);
      if (args[0] === "auth") {
        if (ghMissing) throw new CommandFailedError("spawn gh ENOENT", { executableMissing: true });
        if (!ghAuthOk) throw new Error("You are not logged into any GitHub hosts.");
        return "";
      }
      const head = args[args.indexOf("--head") + 1]!;
      if (args[1] === "list")
        return JSON.stringify(
          prs
            .filter((pr) => pr.head === head)
            .map((pr) => ({ url: pr.url, state: pr.state ?? "OPEN" })),
        );
      if (args[1] === "create") {
        if (failCreateOnce) {
          failCreateOnce = false;
          throw new Error("connection reset");
        }
        const body = await readFile(args[args.indexOf("--body-file") + 1]!, "utf8");
        const url = `https://github.com/acme/widgets/pull/${prs.length + 7}`;
        prs.push({ url, head, base: args[args.indexOf("--base") + 1]!, body });
        return `Creating pull request\n${url}\n`;
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
  };
}

async function remoteFile(branch: string, file = "AGENTS.md"): Promise<string> {
  await git(checkout, "fetch", "-q", "origin", `refs/heads/${branch}`);
  return git(checkout, "show", `FETCH_HEAD:${file}`);
}

async function checkoutSnapshot() {
  return {
    head: await git(checkout, "rev-parse", "HEAD"),
    branch: await git(checkout, "rev-parse", "--abbrev-ref", "HEAD"),
    status: await git(checkout, "status", "--porcelain=v1", "--untracked-files=all"),
    agents: await readFile(path.join(checkout, "AGENTS.md"), "utf8"),
    worktrees: await git(checkout, "worktree", "list", "--porcelain"),
    branches: await git(checkout, "branch", "--list"),
  };
}

const open = (changes: Parameters<typeof openAgentsMdPullRequest>[0]["changes"], key = KEY) =>
  openAgentsMdPullRequest({
    root: checkout,
    baseBranch: "main",
    key,
    changes,
    reason: "Agreed in the coordinator chat",
    deps: deps(),
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agents-md-pr-"));
  origin = path.join(root, "origin.git");
  seed = path.join(root, "seed");
  checkout = path.join(root, "checkout");
  prs = [];
  ghCalls = [];
  ghAuthOk = true;
  ghMissing = false;
  failCreateOnce = false;
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "init", "-q", "-b", "main", seed);
  await configure(seed);
  await git(seed, "remote", "add", "origin", origin);
  await pushSeed({ "AGENTS.md": AGENTS, "README.md": "readme\n" });
  await git(root, "clone", "-q", origin, checkout);
  await configure(checkout);
  // The user's own state: another branch and uncommitted work.
  await git(checkout, "checkout", "-q", "-b", "feature/mine");
  await writeFile(path.join(checkout, "AGENTS.md"), `${AGENTS}local edit\n`);
  await writeFile(path.join(checkout, "scratch.txt"), "untracked\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("openAgentsMdPullRequest", () => {
  test(
    "opens a PR with only the section change, from fresh origin/main, leaving the checkout alone",
    async () => {
      // Upstream moved after the checkout was cloned; the PR must build on it.
      await pushSeed({ "README.md": "readme v2\n" }, "upstream");
      const before = await checkoutSnapshot();
      const result = await open([
        { action: "add", text: "Commit flaky-test records in the same change." },
      ]);
      expect(result.status).toBe("opened");
      expect(result.url).toBe("https://github.com/acme/widgets/pull/7");
      expect(result.branch).toBe(agentsMdBranchName(KEY));
      expect(await checkoutSnapshot()).toEqual(before);

      const updated = await remoteFile(result.branch);
      expect(updated).toBe(
        AGENTS.replace(
          "- Never touch ports 34121/34122.\n",
          "- Never touch ports 34121/34122.\n- Commit flaky-test records in the same change.\n",
        ),
      );
      const changed = await git(checkout, "diff", "--name-only", "origin/main", "FETCH_HEAD");
      expect(changed.trim()).toBe("AGENTS.md");
      expect(await git(checkout, "show", "FETCH_HEAD:README.md")).toBe("readme v2\n");
      expect(prs).toHaveLength(1);
      expect(prs[0]!.base).toBe("main");
      expect(prs[0]!.body).toContain("Add: Commit flaky-test records in the same change.");
      expect(prs[0]!.body).toContain("**Reason:** Agreed in the coordinator chat");
      expect(prs[0]!.body.trimEnd().endsWith(AGENTS_MD_GENERATED_BY)).toBe(true);
      // The temporary worktree is gone.
      expect(await readdir(path.join(root, "worktrees"))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "creates the section at the end when the base has none, and the file when missing",
    async () => {
      await pushSeed({ "AGENTS.md": "# Rules\n\nBe nice." }, "no section");
      const result = await open([{ action: "add", text: "Use bun." }]);
      expect(await remoteFile(result.branch)).toBe(
        `# Rules\n\nBe nice.\n\n## Orkestrator\n\n${ORKESTRATOR_SECTION_NOTE}\n\n- Use bun.\n`,
      );
      await git(seed, "rm", "-q", "AGENTS.md");
      await git(seed, "commit", "-q", "-m", "drop");
      await git(seed, "push", "-q", "origin", "HEAD:main");
      const second = await open([{ action: "add", text: "Use bun." }], "fedcba9876543210fedcba98");
      expect(await remoteFile(second.branch)).toBe(
        `## Orkestrator\n\n${ORKESTRATOR_SECTION_NOTE}\n\n- Use bun.\n`,
      );
    },
    TIMEOUT,
  );

  test(
    "a retry with the same key returns the existing PR without opening another",
    async () => {
      const first = await open([{ action: "add", text: "Use bun." }]);
      const second = await open([{ action: "add", text: "Use bun." }]);
      expect(second).toMatchObject({ status: "existing", url: first.url });
      expect(prs).toHaveLength(1);
      expect(ghCalls.filter((args) => args[1] === "create")).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "a restart after the push resumes from the pushed branch and opens one PR",
    async () => {
      failCreateOnce = true;
      const error = await open([{ action: "add", text: "Use bun." }]).catch((caught) => caught);
      expect(error).toBeInstanceOf(AgentsMdPrError);
      expect((error as AgentsMdPrError).code).toBe("pr-failed");
      const pushed = await git(checkout, "ls-remote", "--heads", "origin", agentsMdBranchName(KEY));
      expect(pushed).not.toBe("");
      const resumed = await open([{ action: "add", text: "Use bun." }]);
      expect(resumed.status).toBe("opened");
      expect(prs).toHaveLength(1);
      expect(await readdir(path.join(root, "worktrees"))).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a replacement whose original changed upstream is a conflict and pushes nothing",
    async () => {
      await pushSeed(
        { "AGENTS.md": AGENTS.replace("Never touch ports", "Avoid ports") },
        "upstream edit",
      );
      const error = await open([
        {
          action: "replace",
          replaces: "Never touch ports 34121/34122.",
          text: "Never bind ports 34121 or 34122.",
        },
      ]).catch((caught) => caught);
      expect((error as AgentsMdPrError).code).toBe("conflict");
      expect((error as Error).message).toContain("no longer in the section");
      expect(await git(checkout, "ls-remote", "--heads", "origin", agentsMdBranchName(KEY))).toBe(
        "",
      );
      expect(prs).toHaveLength(0);
    },
    TIMEOUT,
  );

  test(
    "nothing to change when upstream already has the entry",
    async () => {
      const result = await open([{ action: "add", text: "never touch ports 34121/34122" }]);
      expect(result.status).toBe("unchanged");
      expect(prs).toHaveLength(0);
    },
    TIMEOUT,
  );

  test(
    "missing gh sign-in fails clearly before anything is pushed",
    async () => {
      ghAuthOk = false;
      const error = await open([{ action: "add", text: "Use bun." }]).catch((caught) => caught);
      expect((error as AgentsMdPrError).code).toBe("gh-auth");
      expect((error as Error).message).toContain("gh auth login");
      ghMissing = true;
      const missing = await open([{ action: "add", text: "Use bun." }]).catch((caught) => caught);
      expect((missing as AgentsMdPrError).code).toBe("gh-missing");
      expect((missing as Error).message).toContain("not installed");
      expect(await git(checkout, "ls-remote", "--heads", "origin", agentsMdBranchName(KEY))).toBe(
        "",
      );
    },
    TIMEOUT,
  );

  test(
    "ignores the checkout's hooks and line-ending filters; bytes stay exact",
    async () => {
      const crlf = AGENTS.replaceAll("\n", "\r\n");
      await pushSeed({ "AGENTS.md": crlf }, "crlf");
      await git(checkout, "config", "core.autocrlf", "true");
      const hooks = path.join(checkout, ".git", "hooks");
      for (const hook of [
        "pre-commit",
        "commit-msg",
        "prepare-commit-msg",
        "post-commit",
        "pre-push",
        "post-checkout",
        "reference-transaction",
      ]) {
        await writeFile(path.join(hooks, hook), "#!/bin/sh\nexit 1\n");
        await chmod(path.join(hooks, hook), 0o755);
      }
      const result = await open([{ action: "add", text: "Use bun." }]);
      expect(result.status).toBe("opened");
      await git(
        checkout,
        "-c",
        "core.hooksPath=/dev/null",
        "fetch",
        "-q",
        "origin",
        `refs/heads/${result.branch}`,
      );
      const bytes = (
        await runCommand("git", ["cat-file", "blob", "FETCH_HEAD:AGENTS.md"], { cwd: checkout })
      ).stdout;
      expect(bytes).toBe(
        crlf.replace(
          "- Never touch ports 34121/34122.\r\n",
          "- Never touch ports 34121/34122.\r\n- Use bun.\r\n",
        ),
      );
    },
    TIMEOUT,
  );
});

describe("readAgentsMdSectionFromBase", () => {
  test(
    "reads the section from fresh origin/main, not the checkout",
    async () => {
      await pushSeed({ "AGENTS.md": `${AGENTS.replace("## Testing", "## Testing2")}` }, "x");
      const read = await readAgentsMdSectionFromBase({
        root: checkout,
        baseBranch: "main",
        deps: deps(),
      });
      expect(read.fetched).toBe(true);
      expect(read.fileExists).toBe(true);
      expect(read.section.entries).toEqual(["Never touch ports 34121/34122."]);
      expect(read.baseCommit).toBe((await git(seed, "rev-parse", "HEAD")).trim());
    },
    TIMEOUT,
  );
});

async function seedRequestBranch(content: string) {
  await git(seed, "checkout", "-q", "-b", "foreign");
  await writeFile(path.join(seed, "AGENTS.md"), content);
  await git(seed, "add", "AGENTS.md");
  await git(seed, "commit", "-q", "-m", "foreign branch");
  await git(seed, "push", "-q", "origin", `HEAD:refs/heads/${agentsMdBranchName(KEY)}`);
  await git(seed, "checkout", "-q", "main");
}

describe("PR recovery integrity", () => {
  for (const content of [
    AGENTS.replace("Keep this exactly.", "Unapproved outside edit."),
    AGENTS.replace("- Never touch", "- Use something else.\n- Never touch"),
  ]) {
    test(
      "rejects an AGENTS.md-only branch with unapproved content",
      async () => {
        await seedRequestBranch(content);
        await expect(open([{ action: "add", text: "Use bun." }])).rejects.toMatchObject({
          code: "conflict",
        });
        expect(prs).toHaveLength(0);
        expect(ghCalls.some((args) => args[1] === "create")).toBe(false);
      },
      TIMEOUT,
    );
  }
  test(
    "rechecks replacement conflicts after push and before PR recovery",
    async () => {
      const changes = [
        {
          action: "replace" as const,
          replaces: "Never touch ports 34121/34122.",
          text: "Use bun.",
        },
      ];
      failCreateOnce = true;
      await expect(open(changes)).rejects.toMatchObject({ code: "pr-failed" });
      await pushSeed(
        { "AGENTS.md": AGENTS.replace("Never touch ports 34121/34122.", "Upstream replacement.") },
        "upstream",
      );
      await expect(open(changes)).rejects.toMatchObject({ code: "conflict" });
      expect(prs).toHaveLength(0);
      expect(ghCalls.filter((args) => args[1] === "create")).toHaveLength(1);
    },
    TIMEOUT,
  );
  test(
    "a foreign branch appearing during a failed push is rejected",
    async () => {
      const dependencies = deps();
      const remoteGit = dependencies.remoteGit;
      dependencies.remoteGit = async (command, args, options) => {
        if (command === "push") {
          await seedRequestBranch(AGENTS.replace("Keep this exactly.", "Unapproved outside edit."));
          throw new Error("push rejected");
        }
        return remoteGit(command, args, options);
      };
      await expect(
        openAgentsMdPullRequest({
          root: checkout,
          baseBranch: "main",
          key: KEY,
          changes: [{ action: "add", text: "Use bun." }],
          reason: "approved",
          deps: dependencies,
        }),
      ).rejects.toMatchObject({ code: "push-failed" });
      expect(prs).toHaveLength(0);
    },
    TIMEOUT,
  );
  test(
    "a lost push reply accepts the exact commit already on origin",
    async () => {
      const dependencies = deps();
      const remoteGit = dependencies.remoteGit;
      dependencies.remoteGit = async (command, args, options) => {
        const result = await remoteGit(command, args, options);
        if (command === "push") throw new Error("reply lost");
        return result;
      };
      expect(
        (
          await openAgentsMdPullRequest({
            root: checkout,
            baseBranch: "main",
            key: KEY,
            changes: [{ action: "add", text: "Use bun." }],
            reason: "approved",
            deps: dependencies,
          })
        ).status,
      ).toBe("opened");
      expect(prs).toHaveLength(1);
    },
    TIMEOUT,
  );
  for (const state of ["CLOSED", "MERGED"] as const) {
    test(
      `reports ${state} PRs clearly instead of successful open recovery`,
      async () => {
        await open([{ action: "add", text: "Use bun." }]);
        prs[0]!.state = state;
        const error = await open([{ action: "add", text: "Use bun." }]).catch((error) => error);
        expect(error).toBeInstanceOf(AgentsMdPrError);
        expect(error.code).toBe("pr-failed");
        expect(error.message).toContain(state);
        expect(error.message).toContain(prs[0]!.url);
        expect(ghCalls.filter((args) => args[1] === "create")).toHaveLength(1);
      },
      TIMEOUT,
    );
  }
  test(
    "private temp files ignore predictable hooks and body symlinks",
    async () => {
      const parent = path.join(root, "worktrees");
      const hooks = path.join(parent, "no-hooks");
      await mkdir(hooks, { recursive: true });
      const marker = path.join(root, "hook-ran");
      const victim = path.join(root, "victim");
      await writeFile(victim, "untouched");
      await symlink(victim, path.join(parent, `${KEY}.body.md`));
      await writeFile(path.join(hooks, "post-commit"), `#!/bin/sh\necho ran > '${marker}'\n`);
      await chmod(path.join(hooks, "post-commit"), 0o755);
      const dependencies = deps();
      const realGit = dependencies.git;
      dependencies.git = async (args, options) => {
        expect(args.slice(0, 2)).toEqual(["-c", "core.hooksPath=/dev/null"]);
        if (options.cwd !== checkout) {
          const privateRoot = path.dirname(options.cwd);
          expect((await stat(privateRoot)).mode & 0o777).toBe(0o700);
        }
        return realGit(args, options);
      };
      await openAgentsMdPullRequest({
        root: checkout,
        baseBranch: "main",
        key: KEY,
        changes: [{ action: "add", text: "Use bun." }],
        reason: "approved",
        deps: dependencies,
      });
      expect(await readFile(victim, "utf8")).toBe("untouched");
      expect(await stat(marker).catch(() => null)).toBeNull();
      expect((await readdir(parent)).sort()).toEqual([`${KEY}.body.md`, "no-hooks"]);
    },
    TIMEOUT,
  );
});
