import { describe, expect, mock, test } from "bun:test";
import { GITHUB_CLONE_REPOSITORY_LIMIT } from "@orkestrator/protocol/github-clone";
import { listGitHubCloneAccounts, listGitHubCloneRepositories } from "./github-clone-browser.js";
import { CommandFailedError, type runCommand } from "./shell.js";

type Run = typeof runCommand;
type Call = { command: string; args: string[] };

function runner(respond: (call: Call) => string | Error, calls: Call[] = []): Run {
  return mock(async (command: string, args: string[] = []) => {
    const call = { command, args };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return { stdout: result, stderr: "" };
  }) as unknown as Run;
}

function ghRepository(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    nameWithOwner: `acme/${name}`,
    description: `${name} service`,
    isPrivate: false,
    isFork: false,
    isArchived: false,
    pushedAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    url: `https://github.com/acme/${name}`,
    sshUrl: `git@github.com:acme/${name}.git`,
    ...overrides,
  };
}

describe("listGitHubCloneAccounts", () => {
  test("returns the signed-in user and organizations in name order", async () => {
    const calls: Call[] = [];
    const run = runner(({ args }) => {
      if (args.includes("user")) return "octocat\n";
      return "zeta-corp\nAcme\noctocat\nnot a login\nbeta\n";
    }, calls);

    expect(await listGitHubCloneAccounts(run)).toEqual([
      { login: "Acme", kind: "organization" },
      { login: "beta", kind: "organization" },
      { login: "octocat", kind: "user" },
      { login: "zeta-corp", kind: "organization" },
    ]);
    expect(calls.every((call) => call.command === "gh")).toBe(true);
    expect(calls.find((call) => call.args.includes("--paginate"))?.args).toContain(
      "user/orgs?per_page=100",
    );
  });

  test("explains a missing GitHub CLI", async () => {
    const run = runner(
      () => new CommandFailedError("spawn gh ENOENT", { executableMissing: true }),
    );
    await expect(listGitHubCloneAccounts(run)).rejects.toThrow(
      "GitHub CLI is not installed. Install gh and run `gh auth login`, then retry",
    );
  });

  test("surfaces an authentication failure", async () => {
    const run = runner(
      () => new CommandFailedError("To get started with GitHub CLI, run gh auth login"),
    );
    await expect(listGitHubCloneAccounts(run)).rejects.toThrow(
      "Could not list your GitHub organizations: To get started with GitHub CLI, run gh auth login",
    );
  });
});

describe("listGitHubCloneRepositories", () => {
  test("maps gh output to HTTPS clone URLs and the latest timestamp", async () => {
    const calls: Call[] = [];
    const run = runner(({ args }) => {
      if (args[0] === "config") return "https\n";
      return JSON.stringify([
        ghRepository("api", { isPrivate: true, updatedAt: "2026-06-01T00:00:00Z" }),
        ghRepository("web", { description: "" }),
        { name: "broken" },
      ]);
    }, calls);

    const result = await listGitHubCloneRepositories("acme", run);

    expect(result).toEqual({
      truncated: false,
      repositories: [
        {
          name: "api",
          fullName: "acme/api",
          description: "api service",
          isPrivate: true,
          isFork: false,
          isArchived: false,
          updatedAt: "2026-06-01T00:00:00Z",
          cloneUrl: "https://github.com/acme/api.git",
        },
        {
          name: "web",
          fullName: "acme/web",
          description: null,
          isPrivate: false,
          isFork: false,
          isArchived: false,
          updatedAt: "2026-05-01T00:00:00Z",
          cloneUrl: "https://github.com/acme/web.git",
        },
      ],
    });
    const list = calls.find((call) => call.args[0] === "repo");
    expect(list?.args.slice(0, 5)).toEqual([
      "repo",
      "list",
      "acme",
      "--limit",
      String(GITHUB_CLONE_REPOSITORY_LIMIT + 1),
    ]);
  });

  test("uses SSH remotes when the GitHub CLI prefers SSH", async () => {
    const run = runner(({ args }) =>
      args[0] === "config" ? "ssh\n" : JSON.stringify([ghRepository("api")]),
    );
    const result = await listGitHubCloneRepositories("acme", run);
    expect(result.repositories[0]?.cloneUrl).toBe("git@github.com:acme/api.git");
  });

  test("reports truncation past the listing limit", async () => {
    const run = runner(({ args }) =>
      args[0] === "config"
        ? new Error("unset")
        : JSON.stringify(
            Array.from({ length: GITHUB_CLONE_REPOSITORY_LIMIT + 1 }, (_, index) =>
              ghRepository(`repo-${index}`),
            ),
          ),
    );
    const result = await listGitHubCloneRepositories("acme", run);
    expect(result.truncated).toBe(true);
    expect(result.repositories).toHaveLength(GITHUB_CLONE_REPOSITORY_LIMIT);
  });

  test("rejects owners that are not GitHub logins without running gh", async () => {
    const calls: Call[] = [];
    const run = runner(() => "[]", calls);
    await expect(listGitHubCloneRepositories("--help", run)).rejects.toThrow(
      "Invalid GitHub account name",
    );
    expect(calls).toHaveLength(0);
  });

  test("names the owner when listing fails", async () => {
    const run = runner(({ args }) =>
      args[0] === "config" ? "https" : new CommandFailedError("HTTP 404: Not Found"),
    );
    await expect(listGitHubCloneRepositories("acme", run)).rejects.toThrow(
      "Could not list repositories for acme: HTTP 404: Not Found",
    );
  });
});
