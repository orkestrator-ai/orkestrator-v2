import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as shell from "./shell.js";
import { detectEnvironmentPullRequest, PR_DETECTION_TIMEOUT_MS } from "./commands-pr-monitor.js";
import { withContainerRuntimeCredential } from "./container-scripts.js";
import { BackendRuntime } from "./backend-runtime.js";
import { runStoredEnvironmentMerge } from "./commands-review.js";
import { createEnvironment } from "./storage.js";
import type { CommandContext } from "./commands-context.js";
import {
  PrViewerPermissionCache,
  PR_VIEWER_PERMISSION_TIMEOUT_MS,
} from "./pr-viewer-permission.js";

const PR = "https://github.com/acme/repo/pull/9";
const target = {
  environmentId: "e1",
  kind: "container" as const,
  containerId: "container-1",
  branch: "feature",
  ready: true,
  prUrl: PR,
  prState: "open" as const,
  hasMergeConflicts: false,
};
const result = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
afterEach(() => mock.restore());

test("container detection wraps and quotes permission commands with their own timeout and cache scope", async () => {
  const command = spyOn(shell, "runCommand").mockImplementation(async (_name, args) => {
    const script = args!.at(-1)!;
    return result(
      script.includes(".permissions")
        ? '{"push":false}'
        : JSON.stringify({
            url: PR,
            state: "OPEN",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          }),
    );
  });
  const cache = new PrViewerPermissionCache();
  // A host answer must never satisfy the container's lookup.
  await cache.resolve(
    "local-gh",
    { host: "github.com", owner: "acme", repo: "repo" },
    async () => true,
  );
  expect(await detectEnvironmentPullRequest(target, { viewerPermissions: cache })).toMatchObject({
    viewerCanMerge: false,
  });
  expect(command.mock.calls[0]).toEqual([
    "docker",
    [
      "exec",
      "container-1",
      "bash",
      "-lc",
      withContainerRuntimeCredential(
        `gh pr view '${PR}' --json url,state,headRefOid,mergeable,mergeStateStatus,isDraft,baseRefName`,
      ),
    ],
    expect.objectContaining({ timeoutMs: PR_DETECTION_TIMEOUT_MS }),
  ]);
  expect(command.mock.calls[1]).toEqual([
    "docker",
    [
      "exec",
      "container-1",
      "bash",
      "-lc",
      withContainerRuntimeCredential(
        "'gh' 'api' '--hostname' 'github.com' 'repos/acme/repo' '--jq' '.permissions'",
      ),
    ],
    expect.objectContaining({ timeoutMs: PR_VIEWER_PERMISSION_TIMEOUT_MS }),
  ]);
  expect(await detectEnvironmentPullRequest(target, { viewerPermissions: cache })).toMatchObject({
    viewerCanMerge: false,
  });
  expect(command).toHaveBeenCalledTimes(3);
});

test("container permission timeouts remain unknown without hiding PR metadata", async () => {
  spyOn(shell, "runCommand").mockImplementation(async (_name, args, options) => {
    if (args!.at(-1)!.includes(".permissions")) {
      expect(options?.timeoutMs).toBe(PR_VIEWER_PERMISSION_TIMEOUT_MS);
      throw new shell.CommandFailedError("timed out", { timedOut: true });
    }
    return result(JSON.stringify({ url: PR, state: "OPEN", mergeable: "MERGEABLE" }));
  });
  expect(
    await detectEnvironmentPullRequest(target, {
      viewerPermissions: new PrViewerPermissionCache(),
    }),
  ).toMatchObject({ state: "open", viewerCanMerge: null });
});

for (const [message, invalidated] of [
  ["GraphQL: user does not have the correct permissions to execute MergePullRequest", true],
  ["Pull Request is not mergeable (HTTP 405)", false],
  ["Head branch was modified (HTTP 409)", false],
] as const) {
  test(`container merge cache invalidation: ${message}`, async () => {
    const runtime = new BackendRuntime({ emit: () => undefined });
    const environment = {
      ...createEnvironment("p1", { name: "feature" }),
      environmentType: "containerized" as const,
      containerId: "container-1",
      prUrl: PR,
      prState: "open" as const,
    };
    const context = {
      runtime,
      storage: { updateEnvironment: async () => environment },
    } as unknown as CommandContext;
    const repo = { host: "github.com", owner: "acme", repo: "repo" };
    const cache = runtime.prMonitor.viewerPermissions;
    spyOn(shell, "runCommand").mockImplementation(async (_name, args) => {
      const script = args!.at(-1)!;
      if (script.includes("'merge'")) throw new Error(message);
      return result(script.includes(".isDraft") ? "false" : PR);
    });
    try {
      await cache.resolve("container:container-1", repo, async () => true);
      await cache.resolve("local-gh", repo, async () => true);
      await expect(
        runStoredEnvironmentMerge(environment, "squash", false, context, async () => undefined),
      ).rejects.toThrow(message);
      let calls = 0;
      expect(
        await cache.resolve("container:container-1", repo, async () => {
          calls += 1;
          return false;
        }),
      ).toBe(!invalidated);
      expect(calls).toBe(invalidated ? 1 : 0);
      expect(await cache.resolve("local-gh", repo, async () => false)).toBe(true);
    } finally {
      runtime.shutdown();
    }
  });
}
