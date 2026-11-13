/**
 * The `git` and `pull-requests` commands are registered with their
 * definitions (plan item 7006): every one of them, none still mapped as
 * untyped, the user-facing argument text unchanged, and a refused argument
 * still a rejection (the handlers are `async`).
 */
import { describe, expect, test } from "bun:test";
import { GIT_COMMANDS } from "@orkestrator/protocol/contract/domains/git";
import { PULL_REQUESTS_COMMANDS } from "@orkestrator/protocol/contract/domains/pull-requests";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { CONTRACT_DOMAIN_MAP, type ContractDomainMap } from "./contract-domain-map.js";

const DEFINITIONS = [...GIT_COMMANDS, ...PULL_REQUESTS_COMMANDS];

// No call below reaches a service: every one is refused while its arguments
// are decoded.
const context = {} as CommandContext;

describe("git and pull-requests registrations", () => {
  const commands = createCommandRegistry();

  test("registers all 61 commands with their definitions", () => {
    expect(DEFINITIONS).toHaveLength(61);
    for (const def of DEFINITIONS) {
      expect({ name: def.name, defined: commands.contracts.get(def.name) === def }).toEqual({
        name: def.name,
        defined: true,
      });
    }
    const map: ContractDomainMap = CONTRACT_DOMAIN_MAP;
    expect(map.git).toBeUndefined();
    expect(map["pull-requests"]).toBeUndefined();
    expect(commands.helloDomains()).toMatchObject({
      git: { min: 1, max: 2 },
      "pull-requests": { min: 1, max: 3 },
    });
  });

  const run = (name: string, args: Record<string, unknown>) =>
    Promise.resolve().then(() => commands.get(name)!(args, context));

  test.each([
    ["changes_get_view", {}, "resourceKey must be a non-empty string"],
    ["changes_get_view", { resourceKey: 3 }, "resourceKey must be a non-empty string"],
    ["changes_apply_restore", { actionToken: "t" }, "idempotencyKey must be a non-empty string"],
    ["get_git_status", { targetBranch: "main" }, "Expected containerId to be a string"],
    [
      "list_environment_diff_base_commits",
      { environmentId: "env-1" },
      "Expected ref to be a string",
    ],
    [
      "get_github_pull_request",
      { owner: "o", repo: "r" },
      "Expected owner, repo and number to identify a GitHub pull request",
    ],
    [
      "list_github_repository_labels",
      { owner: "o" },
      "Expected owner and repo to identify a GitHub repository",
    ],
    [
      "list_github_pull_requests",
      { projectId: "p", filter: "all" },
      "Expected filter to be one of open, mine, review-requested, closed",
    ],
    [
      "merge_github_pull_request",
      { owner: "o", repo: "r", number: 1, method: "octopus", deleteBranch: true },
      "Expected method to be one of merge, squash, rebase",
    ],
    [
      "update_github_issue_status",
      { projectId: "p", issueNumber: 1, status: "done" },
      "Expected status to be backlog, todo, inprogress, or review",
    ],
    ["get_github_issue", { projectId: "p" }, "Expected issueNumber to be a number"],
    ["set_environment_auto_merge", { environmentId: "env-1" }, "Expected enabled to be a boolean"],
    ["pr_monitor_watch", { mode: "normal" }, "Expected environmentId to be a string"],
  ])("%s keeps its argument text", async (name, args, message) => {
    await expect(run(name, args)).rejects.toThrow(message);
    // Rejected, not thrown: in-process callers `.catch` the promise.
    let thrown = false;
    let returned: unknown;
    try {
      returned = commands.get(name)!(args, context);
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
    await expect(returned).rejects.toThrow(message);
  });
});
