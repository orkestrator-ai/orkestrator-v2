/**
 * The `coordinator` commands of the project part are registered with their
 * definitions (plan item 7009): the registry holds each definition, advertises
 * the domain in the hello, keeps every key the handlers read (a defined
 * command drops the keys it does not declare), drops unknown ones and refuses
 * an unknown critical key.
 */
import { expect, mock, test } from "bun:test";
import { COORDINATOR_PROJECT_COMMANDS } from "@orkestrator/protocol/contract/domains/coordinator";
import { createCommandRegistry, type CommandContext } from "./commands.js";

const snapshot = {
  workspace: { id: "c1", projectId: "p1", conversations: [] },
  projectPath: "/p",
  workflows: [],
};

const gitStatus = { projectId: "p1", revision: 1 };

test("registers every project-part coordinator command with its definition", () => {
  const registry = createCommandRegistry();
  for (const def of COORDINATOR_PROJECT_COMMANDS) {
    expect({ name: def.name, defined: registry.contracts.get(def.name) === def }).toEqual({
      name: def.name,
      defined: true,
    });
  }
  expect(registry.helloDomains().coordinator).toEqual({ min: 1, max: 1 });
});

test("coordinator and project Git handlers receive every key they read", async () => {
  const ensure = mock(async () => snapshot);
  const createConversation = mock(async () => snapshot);
  const switchBranch = mock(async () => gitStatus);
  const fetch = mock(async () => gitStatus);
  const baseBranchTip = mock(async () => ({ branch: "dev", commit: null, fetched: false }));
  const context = {
    coordinators: { ensure, createConversation },
    projectGit: { switchBranch, fetch, baseBranchTip },
    storage: {},
  } as unknown as CommandContext;
  const registry = createCommandRegistry();
  const run = (name: string, args: Record<string, unknown>) => registry.get(name)!(args, context);

  await run("ensure_project_coordinator", {
    projectId: "p1",
    keepConversationErrors: true,
    unknownKey: 1,
  });
  expect(ensure.mock.calls[0]).toEqual(["p1", { clearConversationErrors: false }] as never);

  await run("create_coordinator_conversation", {
    projectId: "p1",
    title: "Side",
    closeUnused: ["conv-2"],
  });
  expect(createConversation.mock.calls[0]).toEqual([
    "p1",
    "Side",
    { closeUnused: ["conv-2"] },
  ] as never);

  await run("switch_project_git_branch", {
    projectId: "p1",
    ref: "refs/heads/dev",
    confirmationToken: "token-1",
    includeNestedRepositories: true,
  });
  expect(switchBranch.mock.calls[0]).toEqual([
    "p1",
    "refs/heads/dev",
    { confirmationToken: "token-1", includeNestedRepositories: true },
  ] as never);

  await run("fetch_project_git", { projectId: "p1", force: true });
  expect(fetch.mock.calls[0]).toEqual(["p1", true] as never);

  await run("get_project_base_branch_tip", { projectId: "p1", branch: "dev" });
  expect(baseBranchTip.mock.calls[0]).toEqual(["p1", "dev"] as never);
});

test("the conditional coordinator view reads its known stamp", async () => {
  const context = {
    coordinators: { get: mock(async () => snapshot) },
    storage: {},
  } as unknown as CommandContext;
  const view = createCommandRegistry().get("get_project_coordinator_view")!;
  const first = (await view({ projectId: "p1" }, context)) as {
    status: string;
    generation: string;
    revision: number;
  };
  expect(first.status).toBe("snapshot");
  const again = (await view(
    { projectId: "p1", knownGeneration: first.generation, knownRevision: first.revision },
    context,
  )) as { status: string };
  expect(again.status).toBe("unchanged");
});

test("an unknown critical key is refused; an unknown plain key is dropped", async () => {
  const get = mock(async () => null);
  const context = { coordinators: { get }, storage: {} } as unknown as CommandContext;
  const command = createCommandRegistry().get("get_project_coordinator")!;
  await expect(
    Promise.resolve().then(() =>
      command({ projectId: "p1", steer: true }, context, { critical: ["steer"] } as never),
    ),
  ).rejects.toMatchObject({ code: "unsupported-field" });
  expect(await command({ projectId: "p1", steer: true }, context)).toBeNull();
  expect(get.mock.calls).toEqual([["p1"]] as never);
});
