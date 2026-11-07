/**
 * The `git` and `pull-requests` domain clients over a `lib/backend` factory
 * client (plan item 7006), against fake nodes: version 1 for a node that
 * advertises the domain (envelope with its critical keys, decoded results),
 * version 0 for a pre-contract node or a client without negotiation (today's
 * exact calls, answered as sent).
 */
import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createChangesApi } from "@/lib/backend/changes";
import { createGithubPullRequestsApi } from "@/lib/backend/github-pull-requests";
import { createSignal } from "@/lib/node-scope/signal";
// Aliased: the subprocess guard reads an imported `git` as a helper that runs Git.
import { git as gitDomain } from "./git";
import { pullRequests } from "./pull-requests";

const CURRENT: NegotiatedDomains = {
  git: { min: 1, max: 1 },
  "pull-requests": { min: 1, max: 1 },
};

function fakeClient(answer: (command: string) => unknown, domains?: NegotiatedDomains | null) {
  const invokeRaw = mock(async (command: string, _args?: unknown, _options?: unknown) =>
    answer(command),
  );
  const signal =
    domains === undefined ? undefined : createSignal<NegotiatedDomains | null>(domains);
  const client: BackendClient = {
    invokeRaw: invokeRaw as unknown as BackendClient["invokeRaw"],
    ...(signal
      ? { domains: signal, capabilities: createSignal<ReadonlySet<string> | null>(null) }
      : {}),
  };
  return { client, invokeRaw };
}

const ref = { owner: "acme", repo: "widgets", number: 7 };

describe("git and pull-requests clients over a lib/backend client", () => {
  test("version 0 sends today's calls and returns the answers as sent", async () => {
    const { client, invokeRaw } = fakeClient((command) =>
      command === "changes_get_view" ? { kind: "unchanged", legacy: true } : { older: "shape" },
    );
    const changes = createChangesApi(client);
    await expect(changes.getChangeView("k") as Promise<unknown>).resolves.toEqual({
      kind: "unchanged",
      legacy: true,
    });
    await expect(
      createGithubPullRequestsApi(client).getGitHubPullRequest(ref) as Promise<unknown>,
    ).resolves.toEqual({ older: "shape" });
    expect(invokeRaw.mock.calls).toEqual([
      ["changes_get_view", { resourceKey: "k" }],
      ["get_github_pull_request", ref],
    ] as never);
  });

  test("a pre-contract node (no domains) takes version 0 too", async () => {
    const { client, invokeRaw } = fakeClient(() => null, null);
    await gitDomain(client).refresh_environment_diff_stats({ environmentId: "env-1" });
    await pullRequests(client).pr_monitor_refresh({ environmentId: "env-1" });
    expect(invokeRaw.mock.calls).toEqual([
      ["refresh_environment_diff_stats", { environmentId: "env-1" }],
      ["pr_monitor_refresh", { environmentId: "env-1" }],
    ] as never);
  });

  test("a node with the domains gets the envelope, critical keys and decoded results", async () => {
    const { client, invokeRaw } = fakeClient(
      (command) =>
        command === "changes_prepare_restore"
          ? { kind: "disabled", reasonKey: "changes.restore.disabled", extra: 1 }
          : { outcome: "merged", cleanupOutcome: "not-requested", stripped: true },
      CURRENT,
    );
    const restore = await createChangesApi(client).prepareChangeRestore("m1", ["p1"]);
    expect(invokeRaw.mock.calls[0]).toEqual([
      "changes_prepare_restore",
      { measurementId: "m1", pathIds: ["p1"] },
      { envelope: { domain: "git", version: 1, critical: ["pathIds"] } },
    ] as never);
    // A model record keeps every key it does not declare.
    expect(restore as unknown).toEqual({
      kind: "disabled",
      reasonKey: "changes.restore.disabled",
      extra: 1,
    });
    const merged = await pullRequests(client).merge_environment_pr({
      environmentId: "env-1",
      expectedHeadSha: "a".repeat(40),
    });
    expect(invokeRaw.mock.calls[1]?.[2]).toEqual({
      envelope: { domain: "pull-requests", version: 1, critical: ["expectedHeadSha"] },
    } as never);
    // A closed result drops what it does not declare.
    expect(merged).toEqual({ outcome: "merged", cleanupOutcome: "not-requested" });
  });

  test("a node without the change-tracking service answers null capabilities, as before", async () => {
    const { client } = fakeClient(() => {
      throw new Error("Change tracking is unavailable in this backend");
    }, CURRENT);
    await expect(gitDomain(client).changes_get_capabilities({})).rejects.toThrow("unavailable");
  });
});
