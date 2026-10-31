import { describe, expect, mock, test } from "bun:test";
import { GITHUB_CLONE_REPOSITORY_PAGE_SIZE } from "@orkestrator/protocol/github-clone";
import { listGitHubCloneAccounts, listGitHubCloneRepositories } from "./github-clone-browser.js";
import type { GitHubCliConfigSource } from "./github-credentials.js";
import type { AppConfig } from "./models.js";
import { CommandFailedError, type runCommand } from "./shell.js";

type Run = typeof runCommand;
type Call = { command: string; args: string[]; options?: Parameters<Run>[2] };

function runner(respond: (call: Call) => string | Error, calls: Call[] = []): Run {
  return mock(async (command: string, args: string[] = [], options?: Parameters<Run>[2]) => {
    const call = { command, args, options };
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

function pageJson(nodes: unknown[], nextCursor?: string): string {
  return JSON.stringify({
    data: {
      repositoryOwner: {
        repositories: {
          nodes,
          pageInfo: { hasNextPage: nextCursor !== undefined, endCursor: nextCursor ?? null },
        },
      },
    },
  });
}

function selectedPat(githubToken: string | undefined): GitHubCliConfigSource {
  return {
    loadConfig: async () => ({
      global: { useHostGitHubCredentials: false, githubToken } as AppConfig["global"],
    }),
  };
}

describe("listGitHubCloneAccounts", () => {
  test("returns the signed-in user and organizations in name order", async () => {
    const calls: Call[] = [];
    const run = runner(({ args }) => {
      if (args.includes("user")) return "octocat\n";
      return "zeta-corp\nAcme\noctocat\nnot a login\nbeta\n";
    }, calls);

    expect(await listGitHubCloneAccounts(undefined, run)).toEqual([
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
    await expect(listGitHubCloneAccounts(undefined, run)).rejects.toThrow(
      "GitHub CLI is not available. Set it up under GitHub authentication in Settings, then retry",
    );
  });

  test("surfaces an authentication failure", async () => {
    const run = runner(
      () => new CommandFailedError("To get started with GitHub CLI, run gh auth login"),
    );
    await expect(listGitHubCloneAccounts(undefined, run)).rejects.toThrow(
      "Could not list your GitHub organizations: To get started with GitHub CLI, run gh auth login",
    );
  });
});

describe("listGitHubCloneRepositories", () => {
  test("maps gh output to HTTPS clone URLs and the latest timestamp", async () => {
    const calls: Call[] = [];
    const run = runner(({ args }) => {
      if (args[0] === "config") return "https\n";
      return pageJson([
        ghRepository("api", { isPrivate: true, updatedAt: "2026-06-01T00:00:00Z" }),
        ghRepository("web", { description: "" }),
        { name: "broken" },
      ]);
    }, calls);

    const result = await listGitHubCloneRepositories(undefined, "acme", run);

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
    const list = calls.find((call) => call.args.includes("graphql"));
    expect(list?.args).toContain("owner=acme");
    expect(list?.args.find((arg) => arg.startsWith("query="))).toContain("first: 100");
  });

  test("uses SSH remotes when the GitHub CLI prefers SSH", async () => {
    const run = runner(({ args }) =>
      args[0] === "config" ? "ssh\n" : pageJson([ghRepository("api")]),
    );
    const result = await listGitHubCloneRepositories(undefined, "acme", run);
    expect(result.repositories[0]?.cloneUrl).toBe("git@github.com:acme/api.git");
  });

  test("pages through more than 1,000 repositories without losing the last repository", async () => {
    const calls: Call[] = [];
    const all = Array.from({ length: 1001 }, (_, index) => ghRepository(`repo-${index}`));
    const run = runner(({ args }) => {
      if (args[0] === "config") return "https";
      const offset = Number(args.find((arg) => arg.startsWith("endCursor="))?.slice(10) ?? 0);
      const next = offset + GITHUB_CLONE_REPOSITORY_PAGE_SIZE;
      return pageJson(all.slice(offset, next), next < all.length ? String(next) : undefined);
    }, calls);
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listGitHubCloneRepositories(undefined, "acme", run, cursor);
      expect(page.repositories.length).toBeLessThanOrEqual(GITHUB_CLONE_REPOSITORY_PAGE_SIZE);
      names.push(...page.repositories.map((repository) => repository.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(names).toHaveLength(1001);
    expect(names.at(-1)).toBe("repo-1000");
    expect(calls.filter((call) => call.args.includes("graphql"))).toHaveLength(11);
  });

  test("rejects oversized pages, malformed and non-advancing cursors", async () => {
    for (const output of [
      pageJson(Array.from({ length: 101 }, (_, i) => ghRepository(`repo-${i}`))),
      pageJson([], "same"),
      pageJson([], "x".repeat(513)),
    ]) {
      await expect(
        listGitHubCloneRepositories(
          undefined,
          "acme",
          runner(({ args }) => (args[0] === "config" ? "https" : output)),
          "same",
        ),
      ).rejects.toThrow("unexpected GitHub CLI output");
    }
    const run = runner(() => "");
    for (const cursor of ["", "x".repeat(513)]) {
      await expect(listGitHubCloneRepositories(undefined, "acme", run, cursor)).rejects.toThrow(
        "Invalid GitHub repository cursor",
      );
    }
    expect(run).not.toHaveBeenCalled();
  });

  test("rejects owners that are not GitHub logins without running gh", async () => {
    const calls: Call[] = [];
    const run = runner(() => "[]", calls);
    await expect(listGitHubCloneRepositories(undefined, "--help", run)).rejects.toThrow(
      "Invalid GitHub account name",
    );
    expect(calls).toHaveLength(0);
  });

  test("names the owner when listing fails", async () => {
    const run = runner(({ args }) =>
      args[0] === "config" ? "https" : new CommandFailedError("HTTP 404: Not Found"),
    );
    await expect(listGitHubCloneRepositories(undefined, "acme", run)).rejects.toThrow(
      "Could not list repositories for acme: HTTP 404: Not Found",
    );
  });
});

describe("GitHub listing edge cases", () => {
  test("accepts managed-user logins in accounts and repository lookups", async () => {
    const run = runner(({ args }) => {
      if (args.includes("user")) return "octocat_acme\n";
      if (args.includes("graphql")) return pageJson([]);
      return "";
    });
    expect(await listGitHubCloneAccounts(undefined, run)).toEqual([
      { login: "octocat_acme", kind: "user" },
    ]);
    expect(await listGitHubCloneRepositories(undefined, "octocat_acme", run)).toEqual({
      repositories: [],
      truncated: false,
    });
    await expect(listGitHubCloneRepositories(undefined, "-x", run)).rejects.toThrow(
      "Invalid GitHub account name",
    );
  });

  test("pins all lookups to github.com even with an inherited Enterprise host", async () => {
    const previous = process.env.GH_HOST;
    process.env.GH_HOST = "github.enterprise.test";
    const calls: Call[] = [];
    try {
      const run = runner(
        ({ args }) =>
          args.includes("user") ? "octocat" : args.includes("graphql") ? pageJson([]) : "",
        calls,
      );
      await listGitHubCloneAccounts(undefined, run);
      await listGitHubCloneRepositories(undefined, "octocat", run);
      for (const call of calls) {
        if (call.args[0] === "api")
          expect(call.args.slice(1, 3)).toEqual(["--hostname", "github.com"]);
        if (call.args[0] === "config")
          expect(call.args.slice(-2)).toEqual(["--host", "github.com"]);
      }
      expect(process.env.GH_HOST).toBe("github.enterprise.test");
    } finally {
      if (previous === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = previous;
    }
  });

  test("runs GitHub lookups as the stored PAT when it is the selected credential", async () => {
    const calls: Call[] = [];
    const source = selectedPat("stored_pat");
    const run = runner(
      ({ args }) =>
        args.includes("user") ? "octocat" : args.includes("graphql") ? pageJson([]) : "",
      calls,
    );
    await listGitHubCloneAccounts(source, run);
    await listGitHubCloneRepositories(source, "octocat", run);
    const apiCalls = calls.filter((call) => call.args[0] === "api");
    expect(apiCalls).toHaveLength(3);
    for (const call of apiCalls) expect(call.options?.env?.GH_TOKEN).toBe("stored_pat");
  });

  test.each([undefined, "", "   "])(
    "missing PAT %j refuses discovery before gh runs",
    async (githubToken) => {
      const source = selectedPat(githubToken);
      const run = runner(() => "host-account");
      await expect(listGitHubCloneAccounts(source, run)).rejects.toThrow(
        "personal access token is missing",
      );
      await expect(listGitHubCloneRepositories(source, "acme", run)).rejects.toThrow(
        "personal access token is missing",
      );
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("rejects malformed JSON and non-array repository output", async () => {
    for (const [output, message] of [
      ["{", "invalid JSON"],
      ["{}", "unexpected GitHub CLI output"],
      ["null", "unexpected GitHub CLI output"],
    ]) {
      await expect(
        listGitHubCloneRepositories(
          undefined,
          "acme",
          runner(({ args }) => (args[0] === "config" ? "https" : output!)),
        ),
      ).rejects.toThrow(message!);
    }
  });

  test("rejects missing or invalid viewer logins", async () => {
    for (const viewer of ["", "not a login", "--help"]) {
      await expect(
        listGitHubCloneAccounts(
          undefined,
          runner(({ args }) => (args.includes("user") ? viewer : "acme")),
        ),
      ).rejects.toThrow("Could not determine the signed-in GitHub account");
    }
  });

  test("returns every organization without a cap, alongside the viewer", async () => {
    const run = runner(({ args }) =>
      args.includes("user")
        ? "viewer"
        : Array.from({ length: 1200 }, (_, i) => `org-${i}`).join("\n"),
    );
    const accounts = await listGitHubCloneAccounts(undefined, run);
    expect(accounts).toHaveLength(1201);
    expect(accounts).toContainEqual({ login: "viewer", kind: "user" });
    expect(accounts).toContainEqual({ login: "org-1199", kind: "organization" });
  });

  test("falls back to HTTPS when an SSH-preferred repository has no SSH URL", async () => {
    const result = await listGitHubCloneRepositories(
      undefined,
      "acme",
      runner(({ args }) =>
        args[0] === "config" ? "ssh" : pageJson([ghRepository("api", { sshUrl: null })]),
      ),
    );
    expect(result.repositories[0]?.cloneUrl).toBe("https://github.com/acme/api.git");
  });
});
