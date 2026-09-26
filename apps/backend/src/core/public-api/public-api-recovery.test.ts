import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import path from "node:path";
import { CommandFailedError } from "../shell.js";
import { StorageService } from "../storage.js";
import { createPublicApiHarness, type PublicApiHarness } from "./test-support.js";
import { requestKey } from "./operation-ledger.js";

/**
 * Durability and recovery: admission shared by two writers, capacity
 * refusal, restart reconciliation from positive evidence, and the GitHub
 * boundary of project creation (stubbed — never a live repository).
 */

jest.setTimeout(60_000);
const harnesses: PublicApiHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

async function harness(
  options: Parameters<typeof createPublicApiHarness>[0] = {},
): Promise<PublicApiHarness> {
  const created = await createPublicApiHarness(options);
  harnesses.push(created);
  return created;
}

describe("admission", () => {
  test("two storage writers on one data directory converge on one operation", async () => {
    const h = await harness();
    const second = new StorageService(h.dataDir);
    await second.init();
    const admit = (storage: StorageService) =>
      storage.admitPublicOperation({
        authority: "operator",
        action: "project.add",
        scope: "installation",
        requestId: "shared",
        requestKey: requestKey("operator", "project.add", "installation", "shared"),
        fingerprint: "f".repeat(64),
        generation: "g",
      });
    const [a, b] = await Promise.all([admit(h.storage), admit(second)]);
    expect(a.record.operationId).toBe(b.record.operationId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  test("a full namespace refuses new work instead of evicting retained history", async () => {
    const h = await harness();
    h.storage.setPublicOperationLimitsForTesting({ maxOperationsPerNamespace: 2 });
    await h.call(
      "project.add",
      { remote: "https://example.invalid/a.git" },
      { requestId: "cap-1" },
    );
    await h.call(
      "project.add",
      { remote: "https://example.invalid/b.git" },
      { requestId: "cap-2" },
    );
    const refused = await h.call(
      "project.add",
      { remote: "https://example.invalid/c.git" },
      { requestId: "cap-3" },
    );
    expect(!refused.ok && refused.error.code).toBe("store-capacity");
    expect((await h.storage.loadProjects()).length).toBe(2);
    // Earlier keys still replay.
    const replay = await h.call(
      "project.add",
      { remote: "https://example.invalid/a.git" },
      { requestId: "cap-1" },
    );
    expect(replay.receipt?.replayed).toBe(true);
  });
});

describe("restart reconciliation", () => {
  async function forceRunning(
    h: PublicApiHarness,
    operationId: string,
    patch: Record<string, unknown>,
  ) {
    await h.storage.updatePublicOperation(operationId, (record) => ({
      ...record,
      state: "running",
      completedAt: undefined,
      error: undefined,
      generation: "previous-generation",
      ...patch,
    }));
  }

  test("an in-flight start from a dead generation is interrupted, not re-run", async () => {
    const h = await harness();
    const repository = await h.createRepository("restart");
    const added = await h.call<{ project: { id: string } }>(
      "project.add",
      { path: repository.projectPath },
      { requestId: "r-add" },
    );
    if (!added.ok) throw new Error(added.error.message);
    const created = await h.call<{ environment: { id: string } }>(
      "environment.create",
      { projectId: added.result.project.id, type: "local" },
      { requestId: "r-env" },
    );
    if (!created.ok) throw new Error(created.error.message);
    const admitted = await h.storage.admitPublicOperation({
      authority: "operator",
      action: "environment.start",
      scope: `environment:${created.result.environment.id}`,
      requestId: "r-start",
      requestKey: requestKey(
        "operator",
        "environment.start",
        `environment:${created.result.environment.id}`,
        "r-start",
      ),
      fingerprint: "f".repeat(64),
      resources: { environmentId: created.result.environment.id },
      generation: "previous-generation",
    });
    const operationId = admitted.record.operationId;
    await forceRunning(h, operationId, { stage: "starting" });
    const restarted = await h.restart();
    harnesses.push(restarted);
    const read = await restarted.call("run.get", { operationId });
    expect(read.receipt?.state).toBe("interrupted");
    expect(read.receipt?.error?.code).toBe("run-interrupted");
  });

  test("releases a project removal fence after a crash before registration deletion", async () => {
    const h = await harness();
    const repository = await h.createRepository("fenced");
    const project = await h.call<{ project: { id: string } }>(
      "project.add",
      { path: repository.projectPath },
      { requestId: "fence-project" },
    );
    if (!project.ok) throw new Error(project.error.message);
    const projectId = project.result.project.id;
    const admitted = await h.storage.admitPublicOperation({
      authority: "operator",
      action: "project.remove",
      scope: `project:${projectId}`,
      requestId: "fence-remove",
      requestKey: requestKey("operator", "project.remove", `project:${projectId}`, "fence-remove"),
      fingerprint: "f".repeat(64),
      resources: { projectId },
      generation: "previous-generation",
    });
    await h.storage.fenceEmptyProjectForRemoval(projectId);
    await forceRunning(h, admitted.record.operationId, { stage: "cleanup" });
    const restarted = await h.restart();
    harnesses.push(restarted);
    expect(
      (await restarted.call("run.get", { operationId: admitted.record.operationId })).receipt
        ?.state,
    ).toBe("interrupted");
    const environment = await restarted.call(
      "environment.create",
      { projectId, type: "local" },
      { requestId: "after-fence" },
    );
    if (!environment.ok) throw new Error(`${environment.error.code}: ${environment.error.message}`);
    expect(environment.ok).toBe(true);
  });

  test("a create interrupted after its record was written is settled from the environment", async () => {
    const h = await harness();
    const repository = await h.createRepository("restart-create");
    const added = await h.call<{ project: { id: string } }>(
      "project.add",
      { path: repository.projectPath },
      { requestId: "rc-add" },
    );
    if (!added.ok) throw new Error(added.error.message);
    const created = await h.call<{ environment: { id: string } }>(
      "environment.create",
      { projectId: added.result.project.id, type: "local" },
      { requestId: "rc-env" },
    );
    if (!created.ok) throw new Error(created.error.message);
    const operationId = created.receipt!.operationId;
    await forceRunning(h, operationId, { stage: "executing", result: undefined });
    const restarted = await h.restart();
    harnesses.push(restarted);
    const read = await restarted.call("run.get", { operationId });
    expect(read.receipt?.state).toBe("succeeded");
    expect(read.receipt?.resources.environmentId).toBe(created.result.environment.id);
  });

  test("an admitted record from a dead generation runs once when its key is replayed", async () => {
    const h = await harness();
    const admitted = await h.storage.admitPublicOperation({
      authority: "operator",
      action: "project.add",
      scope: "installation",
      requestId: "stale-admit",
      requestKey: (await import("./operation-ledger.js")).requestKey(
        "operator",
        "project.add",
        "installation",
        "stale-admit",
      ),
      fingerprint: (await import("./operation-ledger.js")).intentFingerprint("project.add", {
        remote: "https://example.invalid/stale.git",
        path: undefined,
      }),
      generation: "previous-generation",
    });
    const replay = await h.call(
      "project.add",
      { remote: "https://example.invalid/stale.git" },
      { requestId: "stale-admit" },
    );
    expect(replay.ok).toBe(true);
    expect(replay.receipt?.operationId).toBe(admitted.record.operationId);
    expect((await h.storage.loadProjects()).length).toBe(1);
    const again = await h.call(
      "project.add",
      { remote: "https://example.invalid/stale.git" },
      { requestId: "stale-admit" },
    );
    expect(again.receipt?.replayed).toBe(true);
    expect((await h.storage.loadProjects()).length).toBe(1);
  });

  test("a failed prepare does not claim a stale admission or replay empty success", async () => {
    const h = await harness();
    const { intentFingerprint } = await import("./operation-ledger.js");
    const admitted = await h.storage.admitPublicOperation({
      authority: "operator",
      action: "project.remove",
      scope: "project:missing",
      requestId: "stale-missing",
      requestKey: requestKey("operator", "project.remove", "project:missing", "stale-missing"),
      fingerprint: intentFingerprint("project.remove", {}),
      generation: "previous-generation",
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await h.call(
        "project.remove",
        { projectId: "missing" },
        { requestId: "stale-missing" },
      );
      expect(response.ok).toBe(false);
      const lookup = await h.storage.getPublicOperation(admitted.record.operationId);
      expect(lookup.status === "found" && lookup.record.generation).toBe("previous-generation");
    }
  });

  test("an active same-key replay reports progress with its receipt", async () => {
    const h = await harness();
    const { intentFingerprint } = await import("./operation-ledger.js");
    const capabilities = await h.call("capabilities", {});
    const generation = capabilities.backend!.generation;
    const admitted = await h.storage.admitPublicOperation({
      authority: "operator",
      action: "project.add",
      scope: "installation",
      requestId: "still-running",
      requestKey: requestKey("operator", "project.add", "installation", "still-running"),
      fingerprint: intentFingerprint("project.add", {
        remote: "https://example.invalid/running.git",
        path: undefined,
      }),
      generation,
    });
    const replay = await h.call(
      "project.add",
      { remote: "https://example.invalid/running.git" },
      { requestId: "still-running" },
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("busy");
    expect(replay.receipt?.operationId).toBe(admitted.record.operationId);
  });
});

describe("project.create at the GitHub boundary", () => {
  function recorder(behaviour: "ok" | "ambiguous" | "missing") {
    const calls: string[][] = [];
    const { runCommand } = require("../shell.js") as typeof import("../shell.js");
    const run = mock(
      async (command: string, args: string[] = [], options: Record<string, unknown> = {}) => {
        if (command === "gh") {
          calls.push(args);
          if (behaviour === "missing") {
            throw new CommandFailedError("gh is not installed", { executableMissing: true });
          }
          if (behaviour === "ambiguous") throw new Error("gh: request timed out");
          const source = String(args.find((arg) => arg.startsWith("--source="))).slice(
            "--source=".length,
          );
          await runCommand("git", [
            "-C",
            source,
            "remote",
            "add",
            "origin",
            path.join(source, "..", "remote.git"),
          ]);
          await runCommand("git", [
            "init",
            "--bare",
            "-b",
            "main",
            path.join(source, "..", "remote.git"),
          ]);
          return { stdout: "", stderr: "" };
        }
        return runCommand(command, args, options as never);
      },
    );
    return { run, calls };
  }

  test("an ambiguous remote creation stays unknown and a replay never calls GitHub again", async () => {
    const fake = recorder("ambiguous");
    const h = await harness({ registry: { projectCreation: { runCommand: fake.run as never } } });
    const target = path.join(h.root, "scratch");
    const first = await h.call(
      "project.create",
      { path: target, githubPrivate: true },
      { requestId: "gh-1" },
    );
    expect(first.ok).toBe(false);
    expect(first.receipt?.state).toBe("unknown");
    expect(fake.calls).toHaveLength(1);
    const replay = await h.call(
      "project.create",
      { path: target, githubPrivate: true },
      { requestId: "gh-1" },
    );
    expect(replay.receipt?.replayed).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect((await h.storage.loadProjects()).length).toBe(0);
  });

  test("a missing GitHub CLI fails without leaving a repository behind", async () => {
    const fake = recorder("missing");
    const h = await harness({ registry: { projectCreation: { runCommand: fake.run as never } } });
    const failed = await h.call(
      "project.create",
      { path: path.join(h.root, "scratch-missing"), githubPrivate: true },
      { requestId: "gh-2" },
    );
    expect(failed.ok).toBe(false);
    expect(failed.receipt?.state).toBe("failed");
  });

  test("a successful creation registers the project with its new remote", async () => {
    const fake = recorder("ok");
    const h = await harness({ registry: { projectCreation: { runCommand: fake.run as never } } });
    const created = await h.call<{ project: { id: string; gitUrl: string } }>(
      "project.create",
      { path: path.join(h.root, "scratch-ok"), githubPrivate: true },
      { requestId: "gh-3" },
    );
    if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
    expect(created.result.project.gitUrl).toContain("remote.git");
    expect(fake.calls[0]).toContain("--private");
  });
});
