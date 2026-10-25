import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PublicProjectSummary } from "@orkestrator/protocol/public-api-resources";
import { resolveRemoteWorktreeStartPoint } from "../commands-files.js";
import { runCommand } from "../shell.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";
import { createPublicActionContext, dispatchPublicAction } from "./dispatch.js";
import { controlMcpAuthority } from "./operation-ledger.js";
import { buildPublicHandlerTable } from "./registry.js";
import { PUBLIC_ACTIONS, PUBLIC_API_SCHEMA_VERSION } from "@orkestrator/protocol/public-api";

/**
 * `project.init` (local-only repository, no network) and `project.remove`
 * with `cascade` (environments deleted through the normal lifecycle, one
 * result each, the checkout and remote untouched), on real storage and Git.
 */

const harnesses: PublicApiHarness[] = [];

async function harness(): Promise<PublicApiHarness> {
  const created = await createPublicApiHarness();
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((entry) => entry.cleanup()));
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommand("git", ["-C", cwd, ...args])).stdout.trim();
}

async function addProject(h: PublicApiHarness, name: string): Promise<PublicProjectSummary> {
  const repository = await h.createRepository(name);
  const response = await h.call<{ project: PublicProjectSummary }>(
    "project.add",
    { path: repository.projectPath },
    { requestId: `add-${name}` },
  );
  if (!response.ok) throw new Error(`project.add failed: ${response.error.message}`);
  return response.result.project;
}

async function createEnvironment(h: PublicApiHarness, projectId: string, requestId: string) {
  const created = await h.call<{ environment: { id: string } }>(
    "environment.create",
    { projectId, type: "local" },
    { requestId },
  );
  if (!created.ok) throw new Error(`environment.create failed: ${created.error.message}`);
  return created.result.environment.id;
}

describe("project.init", () => {
  test("initializes a local repository with one commit and no remote, and registers it", async () => {
    const h = await harness();
    const target = path.join(h.root, "scratch", "local-only");
    const response = await h.call<{ project: PublicProjectSummary; remote: null }>(
      "project.init",
      { path: target },
      { requestId: "init-1" },
    );
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.remote).toBeNull();
    expect(response.result.project.localPath).toBe(target);
    expect(await git(target, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(target, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(await git(target, ["remote"])).toBe("");
    expect(response.result.project.gitUrl).toBe(target);
    // Environments of a local-only project start from its own branch; any
    // other checkout without an origin still fails.
    expect(await resolveRemoteWorktreeStartPoint(target, "main", { localOnly: true })).toBe(
      "refs/heads/main",
    );
    await expect(
      resolveRemoteWorktreeStartPoint(target, "missing", { localOnly: true }),
    ).rejects.toThrow(/Base branch not found/);
    await expect(resolveRemoteWorktreeStartPoint(target, "main")).rejects.toThrow();
    const replay = await h.call("project.init", { path: target }, { requestId: "init-1" });
    expect(replay.receipt?.replayed).toBe(true);
    expect(await h.storage.loadProjects()).toHaveLength(1);
  });

  test("refuses a non-empty directory and a path another project uses, creating nothing", async () => {
    const h = await harness();
    const occupied = path.join(h.root, "occupied");
    await fs.mkdir(occupied, { recursive: true });
    await fs.writeFile(path.join(occupied, "notes.txt"), "keep me\n");
    const refused = await h.call("project.init", { path: occupied }, { requestId: "init-busy" });
    expect(refused.ok).toBe(false);
    expect(refused.receipt?.state).toBe("failed");
    expect(await fs.readdir(occupied)).toEqual(["notes.txt"]);
    const project = await addProject(h, "existing");
    const duplicate = await h.call(
      "project.init",
      { path: project.localPath! },
      { requestId: "init-dup" },
    );
    expect(!duplicate.ok && duplicate.error.code).toBe("conflict");
    expect(await h.storage.loadProjects()).toHaveLength(1);
  });

  test("rejects a relative path before admission", async () => {
    const h = await harness();
    const response = await h.call("project.init", { path: "relative/dir" }, { requestId: "rel" });
    expect(!response.ok && response.error.code).toBe("invalid-input");
    expect(response.receipt).toBeUndefined();
  });
});

describe("project.remove with cascade", () => {
  test("deletes every environment, reports each, then removes only the registration", async () => {
    const h = await harness();
    const project = await addProject(h, "cascade");
    const first = await createEnvironment(h, project.id, "env-a");
    const second = await createEnvironment(h, project.id, "env-b");
    const refused = await h.call("project.remove", { projectId: project.id }, { requestId: "rm" });
    expect(!refused.ok && refused.error.code).toBe("not-empty");
    expect(!refused.ok && refused.error.message).toContain("cascade");

    const removed = await h.call<{
      removed?: string;
      environments: { total: number; deleted: number; failed: number; results: unknown[] };
    }>("project.remove", { projectId: project.id, cascade: true }, { requestId: "rm-cascade" });
    if (!removed.ok) throw new Error(`${removed.error.code}: ${removed.error.message}`);
    let receipt = removed.receipt!;
    for (let attempt = 0; receipt.state === "running" && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      receipt = (await h.call("run.get", { operationId: receipt.operationId })).receipt!;
    }
    expect(receipt.state).toBe("succeeded");
    expect(await h.storage.getProject(project.id)).toBeNull();
    expect(await h.storage.getEnvironmentsByProject(project.id)).toHaveLength(0);
    const record = (await h.storage.getPublicOperation(receipt.operationId)) as {
      record?: { result?: Record<string, unknown> };
    };
    const result = record.record?.result as {
      environments: { total: number; deleted: number; failed: number; results: unknown[] };
      effects: string;
    };
    expect(result.environments).toMatchObject({ total: 2, deleted: 2, failed: 0 });
    expect(result.environments.results).toEqual([
      expect.objectContaining({ environmentId: first, state: "deleted" }),
      expect.objectContaining({ environmentId: second, state: "deleted" }),
    ]);
    expect(result.effects).toBe("registration-only");
    // The checkout and its origin are never deleted.
    expect((await fs.stat(project.localPath!)).isDirectory()).toBe(true);
    expect(await git(project.localPath!, ["remote"])).toBe("origin");

    const replay = await h.call(
      "project.remove",
      { projectId: project.id, cascade: true },
      { requestId: "rm-cascade" },
    );
    expect(replay.receipt?.replayed).toBe(true);
    expect(replay.receipt?.operationId).toBe(receipt.operationId);
  });

  test("a failed environment deletion keeps the project and reports partial", async () => {
    const h = await harness();
    const project = await addProject(h, "partial");
    const failing = await createEnvironment(h, project.id, "env-fail");
    const deleting = await createEnvironment(h, project.id, "env-ok");
    const realDelete = h.commands.get("delete_environment")!;
    h.commands.set("delete_environment", async (args, context) => {
      if (args.environmentId === failing) throw new Error("cleanup refused");
      return realDelete(args, context);
    });
    const response = await h.call(
      "project.remove",
      { projectId: project.id, cascade: true },
      { requestId: "rm-partial" },
    );
    let receipt = response.receipt!;
    for (let attempt = 0; receipt.state === "running" && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      receipt = (await h.call("run.get", { operationId: receipt.operationId })).receipt!;
    }
    expect(receipt.state).toBe("partial");
    expect(receipt.error?.code).toBe("partial-failure");
    expect(await h.storage.getProject(project.id)).not.toBeNull();
    const remaining = (await h.storage.getEnvironmentsByProject(project.id)).map((env) => env.id);
    expect(remaining).toEqual([failing]);
    expect(remaining).not.toContain(deleting);
    // The project is still usable: no removal fence was left behind.
    const retry = await h.call(
      "environment.create",
      { projectId: project.id, type: "local" },
      { requestId: "after-partial" },
    );
    expect(retry.ok).toBe(true);
  });

  test("cascade is part of the intent: the same key without it conflicts", async () => {
    const h = await harness();
    const project = await addProject(h, "intent");
    const first = await h.call("project.remove", { projectId: project.id }, { requestId: "k" });
    expect(first.ok).toBe(true);
    const conflict = await h.call(
      "project.remove",
      { projectId: project.id, cascade: true },
      { requestId: "k" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
  });

  test("a Control MCP credential cannot cascade, even with the projects grant", async () => {
    const h = await harness();
    const project = await addProject(h, "mcp");
    await createEnvironment(h, project.id, "env-mcp");
    const context = createPublicActionContext(
      h.context,
      { commands: h.commands } as never,
      { installationId: "test", generation: "test" },
      controlMcpAuthority("worker-1"),
    );
    const response = await dispatchPublicAction(
      buildPublicHandlerTable(),
      {
        schemaVersion: PUBLIC_API_SCHEMA_VERSION,
        action: "project.remove",
        actionVersion: PUBLIC_ACTIONS["project.remove"].version,
        input: { projectId: project.id, cascade: true },
        request: { requestId: "mcp-cascade" },
      },
      context,
    );
    expect(!response.ok && response.error.code).toBe("capability-unavailable");
    expect(response.receipt).toBeUndefined();
    expect(await h.storage.getEnvironmentsByProject(project.id)).toHaveLength(1);
  });
});
