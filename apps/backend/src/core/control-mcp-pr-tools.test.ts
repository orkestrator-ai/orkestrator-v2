import { afterEach, describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { runCommand } from "./shell.js";
import { CONTROL_MCP_PROFILE_CAPABILITIES } from "@orkestrator/protocol/control-mcp";
import { controlMcpHarness, rpc, type RpcResult } from "./control-mcp-test-support.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import { cleanupSessionHarnesses } from "./public-api/test-provider.js";

/**
 * The pull request tools as an externally connected agent sees them: which
 * credentials list them, how a merge is confirmed, and that a merge cannot run
 * without a confirmation or on the wrong input.
 */

const PR_URL = "https://github.com/acme/site/pull/7";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const READS = ["pr_get", "pr_list", "pr_timeline", "pr_files", "pr_options"];
const CHANGES = [
  "pr_merge",
  "pr_close",
  "pr_reopen",
  "pr_ready",
  "pr_draft",
  "pr_comment",
  "pr_comment_edit",
  "pr_review",
  "pr_review_comment",
  "pr_thread_reply",
  "pr_thread_resolve",
  "pr_file_viewed",
  "pr_reviewers",
  "pr_label",
];

type Harness = Awaited<ReturnType<typeof controlMcpHarness>>;
const open: Harness[] = [];

afterEach(async () => {
  for (const mcp of open.splice(0)) await mcp.close();
  await cleanupSessionHarnesses();
});

async function harness(): Promise<Harness> {
  const mcp = await controlMcpHarness();
  open.push(mcp);
  await mcp.harness.storage.updateEnvironment("env-1", { prUrl: PR_URL, prState: "open" });
  return mcp;
}

function stubGitHub(mcp: Harness, overrides: Record<string, unknown> = {}) {
  const merges: Array<Record<string, unknown>> = [];
  mcp.harness.commands.set("get_github_pull_request", async () => ({
    ref: { owner: "acme", repo: "site", number: 7 },
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
  }));
  mcp.harness.commands.set("merge_environment_pr", async (args) => {
    merges.push(args);
    return { outcome: "merged", cleanupOutcome: "not-requested" };
  });
  return merges;
}

function envelope(result: RpcResult) {
  return result.structuredContent as {
    ok: boolean;
    result: Record<string, unknown>;
    receipt?: { state: string };
    error: {
      code: string;
      message: string;
      details: { confirmToken: string; description: string; refused?: string };
    };
  };
}

async function toolNames(mcp: Harness, token: string): Promise<string[]> {
  return (await mcp.list(token)).tools.map((tool: { name: string }) => tool.name);
}

describe("who can see the pull request tools", () => {
  test("a full credential lists every read and change, with the tool-style arguments", async () => {
    const mcp = await harness();
    const { tools } = await mcp.list(mcp.defaultToken);
    const byName = new Map(
      (
        tools as Array<{
          name: string;
          inputSchema: { properties?: Record<string, unknown>; required?: string[] };
        }>
      ).map((tool) => [tool.name, tool]),
    );
    for (const name of [...READS, ...CHANGES]) expect(byName.has(name)).toBe(true);

    for (const name of CHANGES) {
      const schema = byName.get(name)!.inputSchema;
      expect(Object.keys(schema.properties ?? {})).toEqual(
        expect.arrayContaining(["environmentId", "requestId", "nodeId"]),
      );
      expect(schema.required).toEqual(expect.arrayContaining(["environmentId", "requestId"]));
    }
    for (const name of READS) {
      const schema = byName.get(name)!.inputSchema;
      expect(Object.keys(schema.properties ?? {})).toContain("nodeId");
      expect(Object.keys(schema.properties ?? {})).not.toContain("requestId");
    }
    for (const name of ["pr_merge", "pr_close", "pr_review"]) {
      expect(Object.keys(byName.get(name)!.inputSchema.properties ?? {})).toContain("confirmToken");
    }
    expect(Object.keys(byName.get("pr_comment")!.inputSchema.properties ?? {})).not.toContain(
      "confirmToken",
    );
  });

  test("a read-only credential lists the reads and refuses every change", async () => {
    const mcp = await harness();
    const merges = stubGitHub(mcp);
    const { token } = await mcp.credential("read-only");
    const names = await toolNames(mcp, token);
    for (const name of READS) expect(names).toContain(name);
    for (const name of CHANGES) expect(names).not.toContain(name);
    const refused = envelope(
      await mcp.call(token, "run_action", {
        action: "pr.merge",
        input: { environmentId: "env-1" },
        requestId: "ro",
      }),
    );
    expect(refused.error.code).toBe("capability-unavailable");
    expect(merges).toEqual([]);
  });

  test("merging needs the destructive grant; sessions.control is not enough", async () => {
    const mcp = await harness();
    const merges = stubGitHub(mcp);
    const { token } = await mcp.credential("custom", {
      capabilities: ["sessions.read", "sessions.control"],
    });
    const names = await toolNames(mcp, token);
    expect(names).toContain("pr_comment");
    expect(names).toContain("pr_close");
    expect(names).not.toContain("pr_merge");
    const refused = envelope(
      await mcp.call(token, "run_action", {
        action: "pr.merge",
        input: { environmentId: "env-1" },
        requestId: "custom",
      }),
    );
    expect(refused.error.code).toBe("capability-unavailable");
    expect(merges).toEqual([]);
    expect(CONTROL_MCP_PROFILE_CAPABILITIES.voice).not.toContain("environments.destructive");
  });

  test("a credential can be denied just the merge", async () => {
    const mcp = await harness();
    const { token } = await mcp.credential("full", { deniedActions: ["pr.merge"] });
    const names = await toolNames(mcp, token);
    expect(names).not.toContain("pr_merge");
    expect(names).toContain("pr_get");
  });

  test("a coordinator never gets a pull request tool from this surface", async () => {
    const mcp = await harness();
    mcp.harness.commands.set("get_project_coordinator", async () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "tab-1", mailboxIncarnationId: "incarnation-1" },
        ],
      },
    }));
    const side = mcp.server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities("main"),
    });
    const listed = await rpc(side.url, side.token, "tools/list");
    const names = (listed.body.result?.tools ?? []).map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of [...READS, ...CHANGES]) expect(names).not.toContain(name);
  });

  test("find_actions and describe_action reach the merge for a client with a fixed tool list", async () => {
    const mcp = await harness();
    const { token } = await mcp.credential("custom", {
      capabilities: ["discovery", "environments.destructive"],
    });
    const found = envelope(await mcp.call(token, "find_actions", { query: "merge" }));
    const items = found.result.items as Array<{ action: string; callable: boolean }>;
    expect(items.map((row) => row.action)).toContain("pr.merge");
    const described = envelope(await mcp.call(token, "describe_action", { action: "pr.merge" }));
    expect(described.ok).toBe(true);
    expect(described.result.cli).toBe("orkestrator pr merge");
  });
});

describe("merge_pr", () => {
  test("sits next to create_pr with its argument style, and needs the same grant as pr_merge", async () => {
    const mcp = await harness();
    const { tools } = await mcp.list(mcp.defaultToken);
    const tool = (
      tools as Array<{
        name: string;
        inputSchema: { properties?: Record<string, unknown>; required?: string[] };
      }>
    ).find((candidate) => candidate.name === "merge_pr");
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["requestId", "environmentId", "nodeId", "confirmToken"]),
    );
    expect(tool!.inputSchema.required).toEqual(
      expect.arrayContaining(["requestId", "environmentId"]),
    );

    const readOnly = await mcp.credential("read-only");
    expect(await toolNames(mcp, readOnly.token)).not.toContain("merge_pr");
    const control = await mcp.credential("custom", {
      capabilities: ["sessions.read", "sessions.control"],
    });
    const controlNames = await toolNames(mcp, control.token);
    expect(controlNames).toContain("create_pr");
    expect(controlNames).not.toContain("merge_pr");
  });

  test("merges through the button's command only after confirmation, once per request key", async () => {
    const mcp = await harness();
    const merges = stubGitHub(mcp);
    const args = { environmentId: "env-1", requestId: "named-1", method: "rebase" };

    const first = envelope(await mcp.call(mcp.defaultToken, "merge_pr", args));
    expect(first.error.code).toBe("confirmation-required");
    expect(first.error.details.description).toContain("with rebase");
    expect(merges).toEqual([]);

    // Like create_pr: the result's fields and its receipt, not the public envelope.
    const second = await mcp.call(mcp.defaultToken, "merge_pr", {
      ...args,
      confirmToken: first.error.details.confirmToken,
    });
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent).toMatchObject({
      merged: true,
      method: "rebase",
      url: PR_URL,
      receipt: { action: "pr.merge", state: "succeeded" },
    });
    expect(merges).toEqual([
      {
        environmentId: "env-1",
        method: "rebase",
        deleteBranch: true,
        cleanupAfterMerge: false,
        expectedPrUrl: PR_URL,
      },
    ]);

    const replay = await mcp.call(mcp.defaultToken, "merge_pr", {
      ...args,
      confirmToken: first.error.details.confirmToken,
    });
    expect(replay.isError).toBeFalsy();
    expect(merges).toHaveLength(1);
  });

  test("a confirmation does not carry over to another request", async () => {
    const mcp = await harness();
    const merges = stubGitHub(mcp);
    const first = envelope(
      await mcp.call(mcp.defaultToken, "merge_pr", {
        environmentId: "env-1",
        requestId: "named-2",
      }),
    );
    const other = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        environmentId: "env-1",
        requestId: "named-other",
        confirmToken: first.error.details.confirmToken,
      }),
    );
    expect(other.error.code).toBe("confirmation-required");
    expect(merges).toEqual([]);
  });
});

describe("confirming a merge", () => {
  test("names the pull request and what it does, runs only with the token, and only once", async () => {
    const mcp = await harness();
    const merges = stubGitHub(mcp);
    const args = { environmentId: "env-1", requestId: "merge-1" };

    const first = envelope(await mcp.call(mcp.defaultToken, "pr_merge", args));
    expect(first.ok).toBe(false);
    expect(first.error.code).toBe("confirmation-required");
    expect(first.error.details.description).toBe(
      'This merges pull request #7 "Fix the login redirect" (fix-login into main) with squash and deletes its branch. It cannot be undone.',
    );
    expect(merges).toEqual([]);

    const second = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        ...args,
        confirmToken: first.error.details.confirmToken,
      }),
    );
    expect(second.ok).toBe(true);
    expect(second.receipt?.state).toBe("succeeded");
    expect(second.result).toMatchObject({ merged: true, url: PR_URL, number: 7 });
    expect(merges).toHaveLength(1);

    const replay = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        ...args,
        confirmToken: first.error.details.confirmToken,
      }),
    );
    expect(replay.ok).toBe(true);
    expect(merges).toHaveLength(1);
  });

  test("a project home's changed checkout needs fresh approval for its new PR", async () => {
    const mcp = await harness();
    const merges = stubGitHub(mcp);
    const environment = (await mcp.harness.storage.getEnvironment("env-1"))!;
    const { projectPath } = await mcp.harness.createRepository("home-confirm");
    await mcp.harness.storage.updateProject(environment.projectId, { localPath: projectPath });
    await runCommand("git", ["checkout", "-b", "feature/a"], { cwd: projectPath });
    await mcp.harness.storage.removeEnvironment("env-1");
    await mcp.harness.storage.addEnvironment({
      ...environment,
      projectHome: true,
      branch: "feature/a",
      worktreePath: await realpath(projectPath),
    });
    const args = { environmentId: "env-1", requestId: "home-switch" };
    const first = envelope(await mcp.call(mcp.defaultToken, "pr_merge", args));
    expect(first.error.details.description).not.toContain("deletes its branch");
    await runCommand("git", ["checkout", "-b", "feature/b"], { cwd: projectPath });
    mcp.harness.commands.set("detect_pr_local", async () => ({
      url: "https://github.com/acme/site/pull/8",
      state: "open",
    }));
    const changed = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        ...args,
        confirmToken: first.error.details.confirmToken,
      }),
    );
    expect(changed.error.code).toBe("confirmation-required");
    expect(changed.error.details.refused).toBe("mismatch");
    expect(merges).toEqual([]);
    const approved = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        ...args,
        confirmToken: changed.error.details.confirmToken,
      }),
    );
    expect(approved.ok).toBe(true);
    expect(merges).toEqual([
      expect.objectContaining({
        expectedPrUrl: "https://github.com/acme/site/pull/8",
        deleteBranch: false,
      }),
    ]);
  });

  test("cleanup requested after confirmation requires fresh approval", async () => {
    const mcp = await harness();
    const merges = stubGitHub(mcp);
    const args = { environmentId: "env-1", requestId: "changed-cleanup" };
    const first = envelope(await mcp.call(mcp.defaultToken, "pr_merge", args));
    await mcp.harness.storage.updateEnvironment("env-1", {
      cleanupAfterMergeRequestedAt: new Date().toISOString(),
    });
    const changed = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        ...args,
        confirmToken: first.error.details.confirmToken,
      }),
    );
    expect(changed.error.code).toBe("confirmation-required");
    expect(changed.error.details.description).toContain("then deletes environment");
    expect(merges).toEqual([]);
  });

  test.each(["pr.comment.edit", "pr.review.comment", "pr.thread.reply"])(
    "voice previews the body and PR for %s",
    async (action) => {
      const mcp = await harness();
      stubGitHub(mcp);
      const { token } = await mcp.credential("voice");
      const response = envelope(
        await mcp.call(token, "run_action", {
          action,
          input: {
            environmentId: "env-1",
            body: "Please add a regression test",
            commentId: 1,
            threadId: "thread-1",
            path: "a.ts",
            line: 1,
            side: "RIGHT",
          },
          requestId: action,
        }),
      );
      expect(response.error.code).toBe("confirmation-required");
      expect(response.error.details.description).toContain("Please add a regression test");
      expect(response.error.details.description).toContain("pull request #7");
    },
  );

  test("a token for one merge does not run a different one", async () => {
    const mcp = await harness();
    const merges = stubGitHub(mcp);
    const first = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        environmentId: "env-1",
        requestId: "merge-2",
      }),
    );
    const changed = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        environmentId: "env-1",
        requestId: "merge-2",
        cleanup: true,
        confirmToken: first.error.details.confirmToken,
      }),
    );
    expect(changed.error.code).toBe("confirmation-required");
    expect(changed.error.details.refused).toBe("mismatch");
    expect(merges).toEqual([]);
  });

  test("says when it deletes the environment and what stands against the merge", async () => {
    const mcp = await harness();
    stubGitHub(mcp, { checksState: "failure", mergeability: "blocked", isDraft: true });
    const first = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        environmentId: "env-1",
        requestId: "merge-3",
        cleanup: true,
      }),
    );
    const { description } = first.error.details;
    expect(description).toContain("then deletes environment sessions and its worktree");
    expect(description).toContain("it is a draft and is marked ready first");
    expect(description).toContain("its checks are failing");
    expect(description).toContain("a required review or check is unmet");
  });

  test("warns that an earlier cleanup request still applies to a plain merge", async () => {
    const mcp = await harness();
    stubGitHub(mcp);
    await mcp.harness.storage.updateEnvironment("env-1", {
      cleanupAfterMergeRequestedAt: new Date(0).toISOString(),
    });
    const first = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        environmentId: "env-1",
        requestId: "merge-4",
      }),
    );
    expect(first.error.details.description).toContain("then deletes environment sessions");
  });

  test("still confirms when the pull request cannot be read", async () => {
    const mcp = await harness();
    const merges = stubGitHub(mcp);
    mcp.harness.commands.set("get_github_pull_request", async () => {
      throw new Error("offline");
    });
    const first = envelope(
      await mcp.call(mcp.defaultToken, "pr_merge", {
        environmentId: "env-1",
        requestId: "merge-5",
      }),
    );
    expect(first.error.code).toBe("confirmation-required");
    expect(first.error.details.description).toContain("pull request #7");
    expect(merges).toEqual([]);
  });

  test("closing and reviewing need a confirmation for every profile; commenting only for voice", async () => {
    const mcp = await harness();
    stubGitHub(mcp);
    mcp.harness.commands.set("add_github_pull_request_comment", async () => ({
      id: 1,
      htmlUrl: "u",
    }));
    const close = envelope(
      await mcp.call(mcp.defaultToken, "pr_close", { environmentId: "env-1", requestId: "c" }),
    );
    expect(close.error.code).toBe("confirmation-required");
    expect(close.error.details.description).toContain("without merging");

    const review = envelope(
      await mcp.call(mcp.defaultToken, "pr_review", {
        environmentId: "env-1",
        event: "APPROVE",
        requestId: "r",
      }),
    );
    expect(review.error.code).toBe("confirmation-required");
    expect(review.error.details.description).toContain("This approves");

    const comment = envelope(
      await mcp.call(mcp.defaultToken, "pr_comment", {
        environmentId: "env-1",
        body: "Hi",
        requestId: "n",
      }),
    );
    expect(comment.ok).toBe(true);

    const { token } = await mcp.credential("voice");
    const spoken = envelope(
      await mcp.call(token, "run_action", {
        action: "pr.comment",
        input: { environmentId: "env-1", body: "Hi" },
        requestId: "v",
      }),
    );
    expect(spoken.error.code).toBe("confirmation-required");
    expect(spoken.error.details.description).toContain("Hi");
  });
});

describe("reading through the tools", () => {
  test("pr_get returns the status an agent needs in one call", async () => {
    const mcp = await harness();
    stubGitHub(mcp);
    const read = envelope(await mcp.call(mcp.defaultToken, "pr_get", { environmentId: "env-1" }));
    expect(read.result).toMatchObject({
      attachment: "stored",
      url: PR_URL,
      number: 7,
      pullRequest: { state: "open", baseRef: "main", headSha: HEAD },
    });
  });
});
