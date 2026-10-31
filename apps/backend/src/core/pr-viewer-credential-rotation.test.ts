import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as shell from "./shell.js";
import { BackendRuntime } from "./backend-runtime.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { createEnvironment, StorageService } from "./storage.js";
import { detectEnvironmentPullRequest } from "./commands-pr-monitor.js";
import { setGitHubCliConfigSource } from "./github-credentials.js";

const PR = "https://github.com/acme/repo/pull/1";
const repo = { host: "github.com", owner: "acme", repo: "repo" };
afterEach(() => {
  mock.restore();
  setGitHubCliConfigSource(undefined);
});

for (const oldPermission of [false, true]) {
  for (const change of [
    "set_github_token",
    "update_global_config",
    "save_config",
    "propagate_github_token_to_containers",
  ]) {
    test(`${change} refreshes ${oldPermission ? "allowed to denied" : "denied to allowed"} permissions, including an old lookup`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ork-permission-rotation-"));
      const storage = new StorageService(root);
      await storage.init();
      await storage.updateGlobalConfig({
        ...(await storage.loadConfig()).global,
        useHostGitHubCredentials: false,
      });
      await storage.setGitHubToken("test-old-credential");
      setGitHubCliConfigSource(async () => (await storage.loadConfig()).global);
      const runtime = new BackendRuntime({ emit: () => undefined });
      const context = { storage, runtime, emit: () => undefined } as unknown as CommandContext;
      const container = change === "propagate_github_token_to_containers";
      if (container)
        await storage.addEnvironment({
          ...createEnvironment("p1", { name: "feature" }),
          containerId: "c1",
          status: "running",
        });
      let currentPermission = oldPermission;
      let permissionCalls = 0;
      const runner = spyOn(shell, "runCommand").mockImplementation(async (name, args) => {
        const isPermission =
          name === "docker"
            ? args!.at(-1)!.includes(".permissions")
            : args!.includes(".permissions");
        if (isPermission) permissionCalls += 1;
        const stdout =
          args![0] === "inspect"
            ? "running"
            : isPermission
              ? JSON.stringify({ push: currentPermission })
              : JSON.stringify({
                  url: PR,
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                });
        return { stdout, stderr: "", exitCode: 0 };
      });
      const target = {
        environmentId: "e1",
        branch: "feature",
        kind: container ? ("container" as const) : ("local" as const),
        containerId: "c1",
        worktreePath: root,
        ready: true,
        prUrl: PR,
        prState: "open" as const,
        hasMergeConflicts: false,
      };
      const detect = () =>
        detectEnvironmentPullRequest(target, {
          viewerPermissions: runtime.prMonitor.viewerPermissions,
        });
      const scope = container ? "container:c1" : "local-gh";
      try {
        expect(await detect()).toMatchObject({ viewerCanMerge: oldPermission });
        let release!: (permission: boolean) => void;
        const otherRepo = { ...repo, repo: "in-flight" };
        const stale = runtime.prMonitor.viewerPermissions.resolve(
          scope,
          otherRepo,
          () =>
            new Promise<boolean>((resolve) => {
              release = resolve;
            }),
        );
        await Promise.resolve();
        if (container) await storage.setGitHubToken("test-new-credential");
        const config = await storage.loadConfig();
        const args =
          change === "set_github_token"
            ? { token: "test-new-credential" }
            : change === "update_global_config"
              ? { global: { ...config.global, useHostGitHubCredentials: true } }
              : change === "save_config"
                ? {
                    config: {
                      ...config,
                      global: { ...config.global, useHostGitHubCredentials: true },
                    },
                  }
                : {};
        await createCommandRegistry().get(change)!(args, context);
        currentPermission = !oldPermission;
        expect(await detect()).toMatchObject({ viewerCanMerge: !oldPermission });
        expect(permissionCalls).toBe(2);
        release(oldPermission);
        expect(await stale).toBeNull();
        expect(
          await runtime.prMonitor.viewerPermissions.resolve(
            scope,
            otherRepo,
            async () => !oldPermission,
          ),
        ).toBe(!oldPermission);
        if (container)
          expect(
            runner.mock.calls.some(
              ([name, args, options]) =>
                name === "docker" &&
                args?.includes("-i") &&
                options?.stdin === "test-new-credential",
            ),
          ).toBe(true);
        else {
          const permissionRun = runner.mock.calls.findLast(([, args]) =>
            args?.includes(".permissions"),
          );
          expect(permissionRun?.[2]?.env?.GH_TOKEN).toBe(
            change === "set_github_token" ? "test-new-credential" : undefined,
          );
        }
      } finally {
        runtime.shutdown();
        runner.mockRestore();
        storage.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
