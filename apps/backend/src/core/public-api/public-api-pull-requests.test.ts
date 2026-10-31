import { afterEach, describe, expect, test } from "bun:test";
import type { MergeEnvironmentPrResult } from "../commands-review.js";
import { requestKey } from "./operation-ledger.js";
import { reconcileOperation } from "./reconciler.js";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";
import type { PublicApiHarness } from "./test-support.js";

/**
 * Pull request management as public actions: each runs the backend twin of the
 * app's Merge buttons or pull request viewer against the environment's own pull
 * request. GitHub is stubbed at the registry command; nothing leaves the host.
 */

afterEach(cleanupSessionHarnesses);

const PR_URL = "https://github.com/acme/site/pull/7";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REF = { owner: "acme", repo: "site", number: 7 };

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ref: REF,
    title: "Fix the login redirect",
    htmlUrl: PR_URL,
    state: "open",
    isDraft: false,
    baseRef: "main",
    headRef: "fix-login",
    headSha: HEAD,
    mergeability: "clean",
    checksState: "success",
    reviewers: [],
    ...overrides,
  };
}

type Stub = (args: Record<string, unknown>) => unknown;

/** Stub registry commands and record every call. */
function stubCommands(harness: PublicApiHarness, stubs: Record<string, Stub>) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  for (const [command, stub] of Object.entries(stubs)) {
    harness.commands.set(command, async (args) => {
      calls.push({ command, args });
      return stub(args);
    });
  }
  return {
    calls,
    of(command: string) {
      return calls.filter((call) => call.command === command).map((call) => call.args);
    },
  };
}

async function withPullRequest(harness: PublicApiHarness, fields: Record<string, unknown> = {}) {
  await harness.storage.updateEnvironment("env-1", {
    prUrl: PR_URL,
    prState: "open",
    ...fields,
  });
}

const merged: MergeEnvironmentPrResult = { outcome: "merged", cleanupOutcome: "not-requested" };

describe("pr.get", () => {
  test("reads the stored pull request live, with what the environment has recorded", async () => {
    const { harness } = await setup();
    await withPullRequest(harness, { prBaseBranch: "main", hasMergeConflicts: false });
    const stubs = stubCommands(harness, { get_github_pull_request: () => detail() });
    const read = await harness.call<Record<string, any>>("pr.get", { environmentId: "env-1" });
    if (!read.ok) throw new Error(read.error.message);
    expect(read.result).toMatchObject({
      environmentId: "env-1",
      attachment: "stored",
      url: PR_URL,
      number: 7,
      pullRequest: { state: "open", headSha: HEAD, mergeability: "clean", checksState: "success" },
      environment: {
        branch: "main",
        prUrl: PR_URL,
        prState: "open",
        prBaseBranch: "main",
        hasMergeConflicts: false,
        cleanupAfterMergeRequested: false,
      },
    });
    expect(stubs.of("get_github_pull_request")).toEqual([REF]);
  });

  test("finds a pull request the environment has not stored yet, by its branch", async () => {
    const { harness } = await setup();
    const stubs = stubCommands(harness, {
      detect_pr_local: () => ({ url: PR_URL, state: "open" }),
      get_github_pull_request: () => detail(),
    });
    const read = await harness.call<Record<string, any>>("pr.get", { environmentId: "env-1" });
    expect(read.ok && read.result).toMatchObject({ attachment: "detected", url: PR_URL });
    expect(stubs.of("detect_pr_local")).toEqual([{ environmentId: "env-1", branch: "main" }]);
  });

  test("no pull request is an answer, and a failed lookup is not that answer", async () => {
    const { harness } = await setup();
    stubCommands(harness, { detect_pr_local: () => null });
    const none = await harness.call<Record<string, any>>("pr.get", { environmentId: "env-1" });
    expect(none.ok && none.result).toMatchObject({ attachment: "none", pullRequest: null });

    stubCommands(harness, {
      detect_pr_local: () => {
        throw new Error("gh is not signed in");
      },
    });
    const unknown = await harness.call<Record<string, any>>("pr.get", { environmentId: "env-1" });
    expect(unknown.ok && unknown.result).toMatchObject({
      attachment: "unknown",
      pullRequest: null,
      error: "gh is not signed in",
    });
  });

  test("keeps the stored state when GitHub cannot be read, and never echoes a token", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    stubCommands(harness, {
      get_github_pull_request: () => {
        throw new Error("Bearer ghp_abcdefghijklmnop is not valid");
      },
    });
    const read = await harness.call<Record<string, any>>("pr.get", { environmentId: "env-1" });
    if (!read.ok) throw new Error(read.error.message);
    expect(read.result).toMatchObject({ attachment: "stored", url: PR_URL, pullRequest: null });
    expect(read.result.environment.prState).toBe("open");
    expect(JSON.stringify(read.result)).not.toContain("ghp_abcdefghijklmnop");
  });

  test("an unknown environment is not-found", async () => {
    const { harness } = await setup();
    const read = await harness.call("pr.get", { environmentId: "missing" });
    expect(!read.ok && read.error.code).toBe("not-found");
  });
});

describe("other reads", () => {
  test("pr.list defaults to open and passes the search text", async () => {
    const { harness, projectId } = await setup();
    const stubs = stubCommands(harness, {
      list_github_pull_requests: () => ({ pullRequests: [{ number: 7 }], hasMore: false }),
    });
    const listed = await harness.call("pr.list", { projectId, query: " login " });
    expect(listed.ok && listed.result).toMatchObject({ pullRequests: [{ number: 7 }] });
    expect(stubs.of("list_github_pull_requests")).toEqual([
      { projectId, filter: "open", query: "login" },
    ]);
    const missing = await harness.call("pr.list", { projectId: "missing" });
    expect(!missing.ok && missing.error.code).toBe("not-found");
  });

  test("pr.files leaves hunks out unless one file is asked for", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    stubCommands(harness, {
      get_github_pull_request_files: () => ({
        ref: REF,
        headSha: HEAD,
        truncated: false,
        files: [
          { path: "a.ts", status: "modified", hunks: [{ header: "@@" }] },
          { path: "b.ts", status: "added", hunks: [{ header: "@@" }] },
        ],
        threads: [
          { id: "t-a", path: "a.ts" },
          { id: "t-b", path: "b.ts" },
        ],
      }),
    });
    const all = await harness.call<Record<string, any>>("pr.files", { environmentId: "env-1" });
    if (!all.ok) throw new Error(all.error.message);
    expect(all.result.files).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "added" },
    ]);
    expect(all.result.threads).toHaveLength(2);

    const one = await harness.call<Record<string, any>>("pr.files", {
      environmentId: "env-1",
      path: "b.ts",
    });
    if (!one.ok) throw new Error(one.error.message);
    expect(one.result.file.hunks).toEqual([{ header: "@@" }]);
    expect(one.result.threads).toEqual([{ id: "t-b", path: "b.ts" }]);

    const unchanged = await harness.call("pr.files", { environmentId: "env-1", path: "c.ts" });
    expect(!unchanged.ok && unchanged.error.code).toBe("not-found");
  });

  test("pr.timeline and pr.options read the environment's pull request and repository", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const stubs = stubCommands(harness, {
      get_github_pull_request_timeline: () => ({
        ref: REF,
        items: [{ kind: "commit" }],
        truncated: false,
      }),
      list_github_repository_labels: () => [{ name: "bug", color: "" }],
      list_github_repository_assignable_users: () => [{ login: "octocat" }],
    });
    const timeline = await harness.call("pr.timeline", { environmentId: "env-1" });
    expect(timeline.ok && timeline.result).toMatchObject({ number: 7, truncated: false });
    const options = await harness.call("pr.options", { environmentId: "env-1" });
    expect(options.ok && options.result).toMatchObject({
      labels: [{ name: "bug" }],
      assignableUsers: [{ login: "octocat" }],
    });
    expect(stubs.of("list_github_repository_labels")).toEqual([{ owner: "acme", repo: "site" }]);
  });

  test("a viewer read that fails is a failed operation with GitHub's reason", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    stubCommands(harness, {
      get_github_pull_request_timeline: () => {
        throw new Error("GitHub is not configured.");
      },
    });
    const read = await harness.call("pr.timeline", { environmentId: "env-1" });
    expect(!read.ok && read.error).toMatchObject({
      code: "operation-failed",
      message: "GitHub is not configured.",
    });
  });
});

describe("pr.merge", () => {
  test("runs the Merge button once per request key, squashing by default", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const stubs = stubCommands(harness, { merge_environment_pr: () => merged });
    const input = { environmentId: "env-1" };
    const done = await harness.call<Record<string, unknown>>("pr.merge", input, {
      requestId: "merge-1",
    });
    if (!done.ok) throw new Error(`${done.error.code}: ${done.error.message}`);
    expect(done.receipt).toMatchObject({ action: "pr.merge", state: "succeeded" });
    expect(done.result).toEqual({
      environmentId: "env-1",
      url: PR_URL,
      number: 7,
      method: "squash",
      merged: true,
      outcome: "merged",
      cleanup: "not-requested",
    });
    expect(stubs.of("merge_environment_pr")).toEqual([
      { environmentId: "env-1", method: "squash", deleteBranch: true, cleanupAfterMerge: false },
    ]);

    const replay = await harness.call("pr.merge", input, { requestId: "merge-1" });
    expect(replay.receipt?.replayed).toBe(true);
    expect(stubs.of("merge_environment_pr")).toHaveLength(1);

    const conflict = await harness.call(
      "pr.merge",
      { environmentId: "env-1", method: "rebase" },
      { requestId: "merge-1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
    expect(stubs.of("merge_environment_pr")).toHaveLength(1);
  });

  test("passes the method, branch choice and cleanup through to the button's command", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const stubs = stubCommands(harness, {
      merge_environment_pr: (args) => ({
        outcome: "merged",
        cleanupOutcome: args.cleanupAfterMerge ? "completed" : "not-requested",
      }),
    });
    await harness.call(
      "pr.merge",
      { environmentId: "env-1", method: "rebase", deleteBranch: false },
      { requestId: "keep" },
    );
    await withPullRequest(harness);
    const cleaned = await harness.call<Record<string, unknown>>(
      "pr.merge",
      { environmentId: "env-1", cleanup: true },
      { requestId: "clean" },
    );
    expect(stubs.of("merge_environment_pr")).toEqual([
      { environmentId: "env-1", method: "rebase", deleteBranch: false, cleanupAfterMerge: false },
      { environmentId: "env-1", method: "squash", deleteBranch: true, cleanupAfterMerge: true },
    ]);
    expect(cleaned.ok && cleaned.result.cleanup).toBe("completed");
  });

  test("refuses what the button could not do, before admitting anything", async () => {
    const { harness } = await setup();
    const stubs = stubCommands(harness, {
      merge_environment_pr: () => merged,
      detect_pr_local: () => null,
    });
    const none = await harness.call("pr.merge", { environmentId: "env-1" }, { requestId: "m-1" });
    expect(!none.ok && none.error.code).toBe("not-found");

    await withPullRequest(harness, { prState: "merged" });
    const already = await harness.call(
      "pr.merge",
      { environmentId: "env-1" },
      { requestId: "m-2" },
    );
    expect(!already.ok && already.error.code).toBe("conflict");

    const contradiction = await harness.call(
      "pr.merge",
      { environmentId: "env-1", cleanup: true, deleteBranch: false },
      { requestId: "m-3" },
    );
    expect(!contradiction.ok && contradiction.error.code).toBe("invalid-input");

    await harness.storage.updateEnvironment("env-1", {
      prState: "open",
      deletionRequestedAt: new Date(0).toISOString(),
    });
    const deleting = await harness.call(
      "pr.merge",
      { environmentId: "env-1" },
      { requestId: "m-4" },
    );
    expect(!deleting.ok && deleting.error.code).toBe("conflict");
    expect(stubs.of("merge_environment_pr")).toEqual([]);
  });

  test("expectedHeadSha refuses a moved branch and is enforced by the merge itself", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const stubs = stubCommands(harness, {
      get_github_pull_request: () => detail(),
      merge_environment_pr: () => merged,
    });
    const moved = await harness.call(
      "pr.merge",
      { environmentId: "env-1", expectedHeadSha: "f".repeat(40) },
      { requestId: "sha-1" },
    );
    expect(!moved.ok && moved.error.code).toBe("target-mismatch");
    expect(stubs.of("merge_environment_pr")).toEqual([]);

    const malformed = await harness.call(
      "pr.merge",
      { environmentId: "env-1", expectedHeadSha: "abc" },
      { requestId: "sha-2" },
    );
    expect(!malformed.ok && malformed.error.code).toBe("invalid-input");

    const matched = await harness.call(
      "pr.merge",
      { environmentId: "env-1", expectedHeadSha: HEAD.toUpperCase() },
      { requestId: "sha-3" },
    );
    expect(matched.ok).toBe(true);
    expect(stubs.of("merge_environment_pr")[0]).toMatchObject({ expectedHeadSha: HEAD });
  });

  test("a detected pull request is stored first, because the merge acts on the stored one", async () => {
    const { harness } = await setup();
    let storedAtMerge: string | null | undefined;
    stubCommands(harness, {
      detect_pr_local: () => ({ url: PR_URL, state: "open" }),
      merge_environment_pr: async () => {
        storedAtMerge = (await harness.storage.getEnvironment("env-1"))?.prUrl;
        return merged;
      },
    });
    const done = await harness.call("pr.merge", { environmentId: "env-1" }, { requestId: "d-1" });
    expect(done.ok).toBe(true);
    expect(storedAtMerge).toBe(PR_URL);
  });

  test("a detected pull request that already merged is refused, and not stored as open", async () => {
    const { harness } = await setup();
    const stubs = stubCommands(harness, {
      detect_pr_local: () => ({ url: PR_URL, state: "merged" }),
      merge_environment_pr: () => merged,
    });
    const refused = await harness.call(
      "pr.merge",
      { environmentId: "env-1" },
      { requestId: "d-2" },
    );
    expect(!refused.ok && refused.error.code).toBe("conflict");
    expect(stubs.of("merge_environment_pr")).toEqual([]);
    expect((await harness.storage.getEnvironment("env-1"))?.prUrl).toBeNull();
  });

  test("a merge whose cleanup failed is partial, and says the merge happened", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    stubCommands(harness, {
      merge_environment_pr: () => ({
        outcome: "merged",
        cleanupOutcome: "failed",
        cleanupError: "Worktree is busy",
      }),
    });
    const done = await harness.call(
      "pr.merge",
      { environmentId: "env-1", cleanup: true },
      { requestId: "partial" },
    );
    expect(!done.ok && done.error.code).toBe("partial-failure");
    expect(!done.ok && done.error.message).toContain("Merged, but");
    expect(done.receipt?.state).toBe("partial");
  });

  test("a failed merge is settled by GitHub, not by the failed command", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const failure = () => {
      throw new Error("gh: Pull Request is not mergeable (HTTP 405)");
    };

    stubCommands(harness, {
      merge_environment_pr: failure,
      get_github_pull_request: () => detail(),
    });
    const refused = await harness.call(
      "pr.merge",
      { environmentId: "env-1" },
      { requestId: "f-1" },
    );
    expect(!refused.ok && refused.error).toMatchObject({
      code: "operation-failed",
      message: "gh: Pull Request is not mergeable (HTTP 405)",
    });
    expect(refused.receipt?.state).toBe("failed");

    stubCommands(harness, {
      get_github_pull_request: () => {
        throw new Error("offline");
      },
    });
    const lost = await harness.call("pr.merge", { environmentId: "env-1" }, { requestId: "f-2" });
    expect(!lost.ok && lost.error.code).toBe("run-unknown");
    expect(lost.receipt?.state).toBe("unknown");

    stubCommands(harness, { get_github_pull_request: () => detail({ state: "merged" }) });
    const lostAnswer = await harness.call<Record<string, unknown>>(
      "pr.merge",
      { environmentId: "env-1" },
      { requestId: "f-3" },
    );
    expect(lostAnswer.ok && lostAnswer.result).toMatchObject({ merged: true, outcome: "merged" });
  });

  test("a pending merge stays running until the monitor records it merged", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    stubCommands(harness, {
      merge_environment_pr: () => ({ outcome: "pending", cleanupOutcome: "not-requested" }),
    });
    const pending = await harness.call(
      "pr.merge",
      { environmentId: "env-1" },
      { requestId: "p-1" },
    );
    expect(pending.ok).toBe(true);
    expect(pending.receipt).toMatchObject({ state: "running", stage: "merge-pending" });
    const operationId = pending.receipt!.operationId;

    const waiting = await harness.call("run.get", { operationId });
    expect(waiting.receipt?.state).toBe("running");

    await harness.storage.updateEnvironment("env-1", { prState: "merged" });
    const settled = await harness.call<Record<string, unknown>>("run.get", { operationId });
    expect(settled.receipt?.state).toBe("succeeded");
    expect(settled.ok && settled.result).toMatchObject({ merged: true, outcome: "merged" });
  });

  test("a pending merge whose pull request was closed fails", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    stubCommands(harness, {
      merge_environment_pr: () => ({ outcome: "pending", cleanupOutcome: "not-requested" }),
    });
    const pending = await harness.call(
      "pr.merge",
      { environmentId: "env-1" },
      { requestId: "p-2" },
    );
    await harness.storage.updateEnvironment("env-1", { prState: "closed" });
    const settled = await harness.call("run.get", { operationId: pending.receipt!.operationId });
    expect(settled.receipt?.state).toBe("failed");
  });

  /** A merge left in flight by a process that is gone. */
  async function inFlightMerge(harness: PublicApiHarness) {
    const scope = "environment:env-1";
    const admitted = await harness.storage.publicOperations.admitPublicOperation({
      authority: "operator",
      action: "pr.merge",
      scope,
      requestId: "crashed",
      requestKey: requestKey("operator", "pr.merge", scope, "crashed"),
      fingerprint: "f".repeat(64),
      resources: { environmentId: "env-1" },
      resolved: { url: PR_URL, method: "squash", deleteBranch: true, cleanup: false },
      generation: "previous-generation",
    });
    const { operationId } = admitted.record;
    await harness.storage.publicOperations.updatePublicOperation(operationId, (current) => ({
      ...current,
      state: "running",
      stage: "merging",
    }));
    return operationId;
  }

  test("after a restart a merge is settled from GitHub and never run again", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const operationId = await inFlightMerge(harness);
    const stubs = stubCommands(harness, {
      get_github_pull_request: () => detail({ state: "merged" }),
      merge_environment_pr: () => merged,
    });
    const read = await harness.call<Record<string, unknown>>("run.get", { operationId });
    expect(read.receipt?.state).toBe("succeeded");
    expect(read.ok && read.result).toMatchObject({ merged: true, cleanup: "not-requested" });
    expect(stubs.of("merge_environment_pr")).toEqual([]);
  });

  test("after a restart an open pull request is interrupted, not assumed either way", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const operationId = await inFlightMerge(harness);
    const stubs = stubCommands(harness, {
      get_github_pull_request: () => detail(),
      merge_environment_pr: () => merged,
    });
    const read = await harness.call("run.get", { operationId });
    expect(read.receipt?.state).toBe("interrupted");
    expect(read.receipt?.error?.code).toBe("run-interrupted");
    expect(stubs.of("merge_environment_pr")).toEqual([]);
  });

  test("a merge still pending after a day stops being reported as running", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    stubCommands(harness, {
      merge_environment_pr: () => ({ outcome: "pending", cleanupOutcome: "not-requested" }),
      get_github_pull_request: () => detail(),
    });
    const pending = await harness.call(
      "pr.merge",
      { environmentId: "env-1" },
      { requestId: "p-3" },
    );
    const lookup = await harness.storage.publicOperations.getPublicOperation(
      pending.receipt!.operationId,
    );
    if (lookup.status !== "found") throw new Error("The merge was not recorded");
    const { record } = lookup;
    const context = {
      command: harness.context,
      generation: record.generation,
      now: () => Date.parse(record.createdAt) + 25 * 60 * 60 * 1000,
    } as unknown as Parameters<typeof reconcileOperation>[1];
    const settled = await reconcileOperation(record, context);
    expect(settled.state).toBe("interrupted");
  });
});

describe("viewer changes", () => {
  test("close, reopen, ready and draft run the viewer's state command and report the state", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const stubs = stubCommands(harness, {
      update_github_pull_request_state: (args) =>
        detail({
          state: args.action === "close" ? "closed" : "open",
          isDraft: args.action === "convert-to-draft",
        }),
    });
    const close = await harness.call<Record<string, unknown>>(
      "pr.close",
      { environmentId: "env-1" },
      { requestId: "s-1" },
    );
    expect(close.ok && close.result).toEqual({
      environmentId: "env-1",
      url: PR_URL,
      number: 7,
      state: "closed",
      isDraft: false,
    });
    await harness.call("pr.reopen", { environmentId: "env-1" }, { requestId: "s-2" });
    await harness.call("pr.ready", { environmentId: "env-1" }, { requestId: "s-3" });
    const draft = await harness.call<Record<string, unknown>>(
      "pr.draft",
      { environmentId: "env-1" },
      { requestId: "s-4" },
    );
    expect(draft.ok && draft.result.isDraft).toBe(true);
    expect(stubs.of("update_github_pull_request_state")).toEqual([
      { ...REF, action: "close" },
      { ...REF, action: "reopen" },
      { ...REF, action: "ready-for-review" },
      { ...REF, action: "convert-to-draft" },
    ]);
  });

  test("pr.comment posts once per key and keeps the text out of its receipt", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const stubs = stubCommands(harness, {
      add_github_pull_request_comment: () => ({
        id: 99,
        htmlUrl: `${PR_URL}#issuecomment-99`,
        body: "Secret plan",
      }),
    });
    const input = { environmentId: "env-1", body: "Secret plan" };
    const posted = await harness.call<Record<string, unknown>>("pr.comment", input, {
      requestId: "c-1",
    });
    if (!posted.ok) throw new Error(posted.error.message);
    expect(posted.result).toEqual({
      environmentId: "env-1",
      url: PR_URL,
      number: 7,
      commentId: 99,
      commentUrl: `${PR_URL}#issuecomment-99`,
    });
    expect(stubs.of("add_github_pull_request_comment")).toEqual([{ ...REF, body: "Secret plan" }]);
    expect(JSON.stringify(posted.receipt)).not.toContain("Secret plan");
    expect(JSON.stringify(posted.result)).not.toContain("Secret plan");

    const replay = await harness.call("pr.comment", input, { requestId: "c-1" });
    expect(replay.receipt?.replayed).toBe(true);
    expect(stubs.of("add_github_pull_request_comment")).toHaveLength(1);

    const changed = await harness.call(
      "pr.comment",
      { ...input, body: "Different" },
      { requestId: "c-1" },
    );
    expect(!changed.ok && changed.error.code).toBe("request-conflict");
  });

  test("a comment GitHub refuses is a failed operation with a sanitized reason", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    stubCommands(harness, {
      add_github_pull_request_comment: () => {
        throw new Error("Refused for ghp_abcdefghijklmnop");
      },
    });
    const failed = await harness.call(
      "pr.comment",
      { environmentId: "env-1", body: "Hi" },
      { requestId: "c-2" },
    );
    expect(!failed.ok && failed.error.code).toBe("operation-failed");
    expect(!failed.ok && failed.error.message).toBe("Refused for [redacted]");
  });

  test("a change without a pull request is refused and admits nothing", async () => {
    const { harness } = await setup();
    const stubs = stubCommands(harness, {
      detect_pr_local: () => null,
      add_github_pull_request_comment: () => ({ id: 1, htmlUrl: "" }),
    });
    const refused = await harness.call(
      "pr.comment",
      { environmentId: "env-1", body: "Hi" },
      { requestId: "c-3" },
    );
    expect(!refused.ok && refused.error.code).toBe("not-found");
    expect(refused.receipt).toBeUndefined();
    expect(stubs.of("add_github_pull_request_comment")).toEqual([]);
  });

  test("a failed lookup is not reported as no pull request", async () => {
    const { harness } = await setup();
    stubCommands(harness, {
      detect_pr_local: () => {
        throw new Error("gh is offline");
      },
    });
    const refused = await harness.call(
      "pr.close",
      { environmentId: "env-1" },
      { requestId: "c-4" },
    );
    expect(!refused.ok && refused.error.code).toBe("not-ready");
  });

  test("a pull request outside github.com is refused plainly", async () => {
    const { harness } = await setup();
    await harness.storage.updateEnvironment("env-1", {
      prUrl: "https://git.example.com/acme/site/pull/7",
    });
    const refused = await harness.call(
      "pr.close",
      { environmentId: "env-1" },
      { requestId: "c-5" },
    );
    expect(!refused.ok && refused.error.code).toBe("capability-unavailable");
  });

  test("comment edits, reviews, threads, viewed files, reviewers and labels reach their commands", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const stubs = stubCommands(harness, {
      get_github_pull_request: () => detail(),
      update_github_pull_request_comment: () => ({ id: 5, htmlUrl: "u" }),
      submit_github_pull_request_review: () => ({ reviewId: 12 }),
      add_github_pull_request_review_comment: () => ({ id: 6, htmlUrl: "v" }),
      reply_github_pull_request_review_thread: () => ({ id: 7, htmlUrl: "w" }),
      set_github_pull_request_thread_resolved: (args) => ({ isResolved: args.resolved }),
      set_github_pull_request_file_viewed: (args) => ({
        viewedState: args.viewed ? "viewed" : "unviewed",
      }),
      set_github_pull_request_reviewers: () =>
        detail({ reviewers: [{ login: "octocat", kind: "user", requested: true }] }),
      change_github_pull_request_label: () => [{ name: "bug", color: "" }],
    });
    const environmentId = "env-1";
    const run = async (action: Parameters<typeof harness.call>[0], input: object, key: string) => {
      const answer = await harness.call<Record<string, unknown>>(
        action,
        { environmentId, ...input },
        { requestId: key },
      );
      if (!answer.ok) throw new Error(`${action}: ${answer.error.message}`);
      return answer.result;
    };

    await run("pr.comment.edit", { commentId: 5, body: "Edited" }, "a");
    expect(stubs.of("update_github_pull_request_comment")).toEqual([
      { ...REF, commentId: 5, body: "Edited" },
    ]);

    const inline = { path: "a.ts", line: 4, side: "RIGHT", body: "Why?" };
    expect(await run("pr.review", { event: "APPROVE" }, "b")).toMatchObject({
      reviewId: 12,
      event: "APPROVE",
    });
    await run("pr.review", { event: "COMMENT", comments: [inline] }, "c");
    expect(stubs.of("submit_github_pull_request_review")).toEqual([
      { ...REF, event: "APPROVE", body: "" },
      { ...REF, event: "COMMENT", body: "", comments: [inline] },
    ]);

    // An inline comment that names no commit lands on the current head.
    await run("pr.review.comment", { ...inline, startLine: 2 }, "d");
    expect(stubs.of("add_github_pull_request_review_comment")).toEqual([
      { ...REF, commitId: HEAD, comment: { ...inline, startLine: 2 } },
    ]);

    await run("pr.thread.reply", { threadId: "t", body: "Fixed" }, "e");
    expect(stubs.of("reply_github_pull_request_review_thread")).toEqual([
      { ...REF, threadId: "t", body: "Fixed" },
    ]);
    expect(await run("pr.thread.resolve", { threadId: "t" }, "f")).toMatchObject({
      isResolved: true,
    });
    expect(await run("pr.thread.resolve", { threadId: "t", resolved: false }, "g")).toMatchObject({
      isResolved: false,
    });
    expect(await run("pr.file.viewed", { path: "a.ts" }, "h")).toMatchObject({
      viewedState: "viewed",
    });
    expect(await run("pr.reviewers", { add: ["octocat"] }, "i")).toMatchObject({
      reviewers: [{ login: "octocat", requested: true }],
    });
    expect(stubs.of("set_github_pull_request_reviewers")).toEqual([
      { ...REF, add: ["octocat"], remove: [] },
    ]);
    expect(await run("pr.label", { name: "bug" }, "j")).toMatchObject({ labels: ["bug"] });
    await run("pr.label", { name: "bug", present: false }, "k");
    expect(stubs.of("change_github_pull_request_label")).toEqual([
      { ...REF, name: "bug", present: true },
      { ...REF, name: "bug", present: false },
    ]);
  });

  test("refuses malformed changes before admission", async () => {
    const { harness } = await setup();
    await withPullRequest(harness);
    const expectRefused = async (action: Parameters<typeof harness.call>[0], input: object) => {
      const refused = await harness.call(
        action,
        { environmentId: "env-1", ...input },
        { requestId: `bad-${action}-${JSON.stringify(input).length}` },
      );
      expect(refused.ok).toBe(false);
      expect(refused.receipt).toBeUndefined();
    };
    await expectRefused("pr.review", { event: "LGTM" });
    await expectRefused("pr.review.comment", {
      path: "a.ts",
      line: 2,
      startLine: 2,
      side: "RIGHT",
      body: "x",
    });
    await expectRefused("pr.reviewers", {});
    await expectRefused("pr.comment", { body: "   " });
    await expectRefused("pr.comment", { body: "x".repeat(65_537) });
  });
});
