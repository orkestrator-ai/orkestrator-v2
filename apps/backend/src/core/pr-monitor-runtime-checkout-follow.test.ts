import { expect, mock, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { Environment } from "./models.js";
import { ProjectCheckoutMergeFollower } from "./project-checkout-merge-follow.js";
import type { ProjectGitService } from "./project-git-service.js";
import { PrMonitorRuntime } from "./pr-monitor-runtime.js";
import { createEnvironment, type StorageService } from "./storage.js";

const prUrl = "https://github.com/o/r/pull/7";

function setup(
  options: {
    coordinator?: boolean;
    projectHome?: boolean;
    environment?: Partial<Environment>;
  } = {},
) {
  const environment: Environment = {
    ...createEnvironment("project-1", { name: "feature" }),
    environmentType: "local",
    worktreePath: "/unused/worktree",
    prUrl,
    prState: "merged",
    ...options.environment,
  };
  const home = {
    ...createEnvironment("project-1", { name: "home" }),
    projectHome: true,
  } as Environment;
  const storage = {
    loadEnvironments: mock(async () => []),
    getEnvironment: mock(async () => environment),
    getEnvironmentsByProject: mock(async () =>
      options.projectHome ? [environment, home] : [environment],
    ),
    coordinators: {
      getCoordinatorWorkspace: mock(async () =>
        options.coordinator ? { id: "coordinator-1" } : null,
      ),
    },
  } as unknown as StorageService;
  const projectGit = {} as ProjectGitService;
  const context: CommandContext = {
    storage,
    projectGit,
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
  } as unknown as CommandContext;
  const follower = new ProjectCheckoutMergeFollower();
  const follow = mock((_projectId: string, _git: unknown, _key?: string) => undefined);
  follower.follow = follow;
  const scheduleMergeCleanup = mock(() => undefined);
  const runtime = new PrMonitorRuntime({ checkoutFollower: follower, scheduleMergeCleanup });
  return { runtime, context, environment, follow, projectGit, scheduleMergeCleanup };
}

async function settle() {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

test("a merge the backend confirmed follows into the coordinator's checkout", async () => {
  const { runtime, context, environment, follow, projectGit } = setup({ coordinator: true });
  runtime.followMergeIntoProjectCheckout(environment, context);
  await settle();
  expect(follow).toHaveBeenCalledWith("project-1", projectGit, prUrl);
  runtime.shutdown();
});

test("a project with only a project home is followed too", async () => {
  const { runtime, context, environment, follow } = setup({ projectHome: true });
  runtime.followMergeIntoProjectCheckout(environment, context);
  await settle();
  expect(follow).toHaveBeenCalledTimes(1);
  runtime.shutdown();
});

test("a project nothing reads the checkout of is left alone", async () => {
  const { runtime, context, environment, follow } = setup();
  runtime.followMergeIntoProjectCheckout(environment, context);
  await settle();
  expect(follow).not.toHaveBeenCalled();
  runtime.shutdown();
});

test("the project home's own PR is not followed", async () => {
  const { runtime, context, environment, follow } = setup({
    coordinator: true,
    environment: { projectHome: true },
  });
  runtime.followMergeIntoProjectCheckout(environment, context);
  await settle();
  expect(follow).not.toHaveBeenCalled();
  runtime.shutdown();
});

test("the monitor's terminal follow-up follows a merge made elsewhere, not a close", async () => {
  const { runtime, context, follow, scheduleMergeCleanup } = setup({ coordinator: true });
  // Binds the runtime to the context, as every entry point does.
  await runtime.sync(context);
  runtime.resumeTerminalEffects("environment", { url: prUrl, state: "closed" });
  await settle();
  expect(follow).not.toHaveBeenCalled();

  runtime.resumeTerminalEffects("environment", { url: prUrl, state: "merged" });
  await settle();
  expect(follow).toHaveBeenCalledWith("project-1", context.projectGit, prUrl);
  expect(scheduleMergeCleanup).toHaveBeenCalledTimes(1);

  // A replacement PR on the environment does not inherit the old merge.
  follow.mockClear();
  runtime.resumeTerminalEffects("environment", {
    url: "https://github.com/o/r/pull/6",
    state: "merged",
  });
  await settle();
  expect(follow).not.toHaveBeenCalled();
  runtime.shutdown();
});

test("after shutdown nothing is followed", async () => {
  const { runtime, context, environment, follow } = setup({ coordinator: true });
  runtime.shutdown();
  runtime.followMergeIntoProjectCheckout(environment, context);
  await settle();
  expect(follow).not.toHaveBeenCalled();
});
