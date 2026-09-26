import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isPublicActionResponse, isPublicCapabilities } from "@orkestrator/protocol/public-api";
import type {
  PublicProjectSummary,
  PublicSettingsSnapshot,
} from "@orkestrator/protocol/public-api-resources";
import {
  commitFile,
  createPublicApiHarness,
  headCommit,
  type PublicApiHarness,
} from "./test-support.js";

const harnesses: PublicApiHarness[] = [];

async function harness(): Promise<PublicApiHarness> {
  const created = await createPublicApiHarness();
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((entry) => entry.cleanup()));
});

async function addProject(
  h: PublicApiHarness,
  name = "fixture",
): Promise<{ project: PublicProjectSummary; projectPath: string; originPath: string }> {
  const repository = await h.createRepository(name);
  const response = await h.call<{ project: PublicProjectSummary }>(
    "project.add",
    { path: repository.projectPath },
    { requestId: `add-${name}` },
  );
  if (!response.ok)
    throw new Error(`project.add failed: ${response.error.code} ${response.error.message}`);
  return { project: response.result.project, ...repository };
}

describe("public_action contract", () => {
  test("every response is a valid envelope carrying the backend identity", async () => {
    const h = await harness();
    const capabilities = await h.call("capabilities", {});
    expect(isPublicActionResponse(capabilities)).toBe(true);
    expect(capabilities.ok).toBe(true);
    if (!capabilities.ok) return;
    expect(isPublicCapabilities(capabilities.result)).toBe(true);
    expect(capabilities.backend?.installationId).toBe(
      (capabilities.result as { backend: { installationId: string } }).backend.installationId,
    );
    const unknown = await h.call("project.get", { projectId: "missing" });
    expect(isPublicActionResponse(unknown)).toBe(true);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatchObject({ code: "not-found", exitCode: 3 });
  });

  test("advertises exactly the actions that have handlers", async () => {
    const h = await harness();
    const response = await h.call<{ actions: Record<string, { available: boolean }> }>(
      "capabilities",
      {},
    );
    if (!response.ok) throw new Error("capabilities failed");
    for (const [name, entry] of Object.entries(response.result.actions)) {
      if (!entry.available) continue;
      // An advertised action must be dispatchable (never "unsupported").
      const probe = await h.call(name as never, {});
      if (!probe.ok) expect(probe.error.code).not.toBe("unsupported");
    }
  });

  test("mutations require a request key and reads refuse one", async () => {
    const h = await harness();
    const missingKey = await h.call("project.add", { remote: "https://example.invalid/r.git" });
    expect(!missingKey.ok && missingKey.error.code).toBe("invalid-input");
    const readWithKey = await h.call("project.list", {}, { requestId: "x" });
    expect(!readWithKey.ok && readWithKey.error.code).toBe("invalid-input");
  });

  test("rejects unknown input fields without echoing them", async () => {
    const h = await harness();
    const response = await h.call("project.list", { secretPromptField: "do not echo this" });
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).not.toContain("do not echo this");
  });
});

describe("request keys and receipts", () => {
  test("same key and intent replays; changed intent conflicts; nothing runs twice", async () => {
    const h = await harness();
    const first = await h.call<{ project: PublicProjectSummary }>(
      "project.add",
      { remote: "https://example.invalid/one.git" },
      { requestId: "k1" },
    );
    expect(first.ok).toBe(true);
    const replay = await h.call<{ project: PublicProjectSummary }>(
      "project.add",
      { remote: "https://example.invalid/one.git" },
      { requestId: "k1" },
    );
    expect(replay.ok).toBe(true);
    expect(replay.receipt?.replayed).toBe(true);
    expect(replay.receipt?.operationId).toBe(first.receipt?.operationId);
    if (first.ok && replay.ok) expect(replay.result.project.id).toBe(first.result.project.id);
    const conflict = await h.call(
      "project.add",
      { remote: "https://example.invalid/two.git" },
      { requestId: "k1" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
    expect((await h.storage.loadProjects()).length).toBe(1);
  });

  test("concurrent identical requests converge on one operation and one effect", async () => {
    const h = await harness();
    const input = { remote: "https://example.invalid/race.git" };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.call("project.add", input, { requestId: "race" })),
    );
    const ids = new Set(results.map((result) => result.receipt?.operationId));
    expect(ids.size).toBe(1);
    expect((await h.storage.loadProjects()).length).toBe(1);
  });

  test("a replay after a restart returns the original receipt without re-executing", async () => {
    const h = await harness();
    const first = await h.call(
      "project.add",
      { remote: "https://example.invalid/restart.git" },
      { requestId: "rs" },
    );
    const restarted = await h.restart();
    harnesses.push(restarted);
    const replay = await restarted.call(
      "project.add",
      { remote: "https://example.invalid/restart.git" },
      { requestId: "rs" },
    );
    expect(replay.receipt?.operationId).toBe(first.receipt?.operationId);
    expect(replay.receipt?.replayed).toBe(true);
    expect((await restarted.storage.loadProjects()).length).toBe(1);
  });

  test("run.get finds an operation by ID and by its request key", async () => {
    const h = await harness();
    const created = await h.call(
      "project.add",
      { remote: "https://example.invalid/lookup.git" },
      { requestId: "lookup" },
    );
    const byId = await h.call("run.get", { operationId: created.receipt!.operationId });
    expect(byId.receipt?.state).toBe("succeeded");
    const byKey = await h.call("run.get", { requestId: "lookup", action: "project.add" });
    expect(byKey.receipt?.operationId).toBe(created.receipt!.operationId);
    const missing = await h.call("run.get", { requestId: "never-sent" });
    expect(!missing.ok && missing.error.code).toBe("not-found");
  });

  test("a retired namespace refuses replays as expired instead of executing them", async () => {
    const h = await harness();
    const now = Date.now();
    const old = await h.storage.publicOperationNamespaces(now - 40 * 24 * 60 * 60 * 1000);
    // Force rotation to a fresh namespace, then collect the old one.
    await h.storage.publicOperationNamespaces(now);
    const collected = await h.storage.collectPublicOperations(now);
    expect(collected.retired).toContain(old.current);
    const replay = await h.call(
      "project.add",
      { remote: "https://example.invalid/expired.git" },
      { requestId: "old-key", namespace: old.current },
    );
    expect(!replay.ok && replay.error.code).toBe("namespace-expired");
    expect((await h.storage.loadProjects()).length).toBe(0);
    const lookup = await h.call("run.get", { requestId: "old-key", namespace: old.current });
    expect(!lookup.ok && lookup.error.code).toBe("history-expired");
  });

  test("a corrupted operation store refuses admission rather than reopening keys", async () => {
    const h = await harness();
    await h.call("project.add", { remote: "https://example.invalid/c.git" }, { requestId: "c1" });
    const directory = path.join(h.dataDir, "public-operations");
    for (const name of await fs.readdir(directory)) {
      if (name.startsWith("ns-") && name.endsWith(".json"))
        await fs.writeFile(path.join(directory, name), "{corrupt");
      if (name.startsWith("ns-") && name.includes(".bak")) await fs.rm(path.join(directory, name));
    }
    const response = await h.call(
      "project.add",
      { remote: "https://example.invalid/c.git" },
      { requestId: "c1" },
    );
    expect(response.ok).toBe(false);
    expect((await h.storage.loadProjects()).length).toBe(1);
  });
});

describe("projects", () => {
  test("attaching a checkout reads its origin on the backend", async () => {
    const h = await harness();
    const { project, originPath, projectPath } = await addProject(h);
    expect(project.gitUrl).toBe(originPath);
    expect(project.localPath).toBe(projectPath);
  });

  test("project.create refuses without explicit GitHub confirmation", async () => {
    const h = await harness();
    const response = await h.call(
      "project.create",
      { path: path.join(h.root, "new") },
      { requestId: "c" },
    );
    expect(!response.ok && response.error.code).toBe("invalid-input");
  });

  test("metadata edits are revision checked and never move the checkout", async () => {
    const h = await harness();
    const { project, projectPath } = await addProject(h);
    const renamed = await h.call<{ project: PublicProjectSummary }>(
      "project.update",
      { projectId: project.id, set: { name: "Renamed" }, expectedRevision: project.revision },
      { requestId: "rename-1" },
    );
    expect(renamed.ok).toBe(true);
    // A UI write in between advances the revision too.
    await h.storage.updateProject(project.id, { folder: "Work" });
    const stale = await h.call(
      "project.update",
      { projectId: project.id, set: { name: "Stale" }, expectedRevision: project.revision },
      { requestId: "rename-2" },
    );
    expect(!stale.ok && stale.error.code).toBe("revision-conflict");
    expect((await h.storage.getProject(project.id))?.name).toBe("Renamed");
    expect((await fs.stat(projectPath)).isDirectory()).toBe(true);
  });

  test("removal refuses a project that owns environments and leaves no orphans", async () => {
    const h = await harness();
    const { project } = await addProject(h);
    const created = await h.call(
      "environment.create",
      { projectId: project.id, type: "local" },
      { requestId: "e1" },
    );
    expect(created.ok).toBe(true);
    const refused = await h.call(
      "project.remove",
      { projectId: project.id },
      { requestId: "rm-1" },
    );
    expect(!refused.ok && refused.error.code).toBe("not-empty");
    expect(await h.storage.getProject(project.id)).not.toBeNull();
  });

  test("an environment create racing a removal cannot attach to the removed project", async () => {
    const h = await harness();
    const { project } = await addProject(h);
    const [removal, creation] = await Promise.all([
      h.call("project.remove", { projectId: project.id }, { requestId: "rm-race" }),
      Promise.resolve(
        h.commands.get("create_environment")!(
          { projectId: project.id, environmentType: "local", name: "late" },
          h.context,
        ),
      ).then(
        () => "created",
        () => "refused",
      ),
    ]);
    const environments = await h.storage.getEnvironmentsByProject(project.id);
    const projectExists = (await h.storage.getProject(project.id)) !== null;
    // Exactly one side wins: either the project stays with its environment,
    // or it is gone and nothing was attached to it.
    if (removal.ok) {
      expect(projectExists).toBe(false);
      expect(environments).toHaveLength(0);
      expect(creation).toBe("refused");
    } else {
      expect(projectExists).toBe(true);
    }
  });

  test("removing an empty project replays its original receipt", async () => {
    const h = await harness();
    const { project } = await addProject(h);
    const removed = await h.call(
      "project.remove",
      { projectId: project.id },
      { requestId: "rm-ok" },
    );
    expect(removed.ok).toBe(true);
    const again = await h.call("project.remove", { projectId: project.id }, { requestId: "rm-ok" });
    expect(again.ok).toBe(true);
    expect(again.receipt?.replayed).toBe(true);
  });
});

describe("settings", () => {
  test("partial edits preserve unrelated fields and conflict on stale revisions", async () => {
    const h = await harness();
    const { project } = await addProject(h);
    const before = await h.call<PublicSettingsSnapshot>("project.config.get", {
      projectId: project.id,
    });
    if (!before.ok) throw new Error("config.get failed");
    await h.storage.updateRepositorySettings(project.id, {
      defaultBranch: "main",
      prBaseBranch: "main",
      filesToCopy: [".env"],
    });
    const stale = await h.call(
      "project.config.set",
      { projectId: project.id, set: { entryPort: 3000 }, expectedRevision: before.result.revision },
      { requestId: "cfg-stale" },
    );
    expect(!stale.ok && stale.error.code).toBe("revision-conflict");
    const applied = await h.call<{ settings: PublicSettingsSnapshot }>(
      "project.config.set",
      { projectId: project.id, set: { entryPort: 3000, "agent.codex.model": "gpt-x" } },
      { requestId: "cfg-ok" },
    );
    expect(applied.ok).toBe(true);
    const repository = await h.storage.getRepositoryConfig(project.id);
    expect(repository.filesToCopy).toEqual([".env"]);
    expect(repository.entryPort).toBe(3000);
    expect(repository.agentSettings?.platforms?.codex?.model).toBe("gpt-x");
    const unset = await h.call(
      "project.config.set",
      { projectId: project.id, unset: ["agent.codex.model"] },
      { requestId: "cfg-unset" },
    );
    expect(unset.ok).toBe(true);
    expect((await h.storage.getRepositoryConfig(project.id)).agentSettings).toBeUndefined();
  });

  test("rejects unknown keys, bad types and null-as-unset", async () => {
    const h = await harness();
    const { project } = await addProject(h);
    for (const input of [
      { set: { githubToken: "x" } },
      { set: { entryPort: 70_000 } },
      { set: { defaultBranch: null } },
      { set: { entryPort: 1 }, unset: ["entryPort"] },
    ]) {
      const response = await h.call(
        "project.config.set",
        { projectId: project.id, ...input },
        { requestId: `bad-${JSON.stringify(input).length}` },
      );
      expect(!response.ok && response.error.code).toBe("invalid-input");
    }
  });

  test("environment defaults never clear pending launch intent", async () => {
    const h = await harness();
    const { project } = await addProject(h);
    const environment = (await h.commands.get("create_environment")!(
      {
        projectId: project.id,
        environmentType: "local",
        initialPrompt: "keep me",
        pendingAgentLaunch: true,
        initialAgentPlatform: "codex",
        initialConversationMode: "plan",
      },
      h.context,
    )) as { id: string };
    const response = await h.call(
      "environment.config.set",
      { environmentId: environment.id, set: { "agent.claude.model": "opus" } },
      { requestId: "env-cfg" },
    );
    expect(response.ok).toBe(true);
    const stored = await h.storage.getEnvironment(environment.id);
    expect(stored?.initialPrompt).toBe("keep me");
    expect(stored?.pendingAgentLaunch).toBe(true);
    expect(stored?.initialConversationMode).toBe("plan");
    expect(stored?.agentSettings?.platforms?.claude?.model).toBe("opus");
  });
});

describe("environment creation", () => {
  test("replays converge; a changed payload under the same key conflicts", async () => {
    const h = await harness();
    const { project } = await addProject(h);
    const first = await h.call<{ environment: { id: string } }>(
      "environment.create",
      { projectId: project.id, type: "local", name: "one" },
      { requestId: "env-key" },
    );
    const replay = await h.call<{ environment: { id: string } }>(
      "environment.create",
      { projectId: project.id, type: "local", name: "one" },
      { requestId: "env-key" },
    );
    if (!first.ok || !replay.ok) throw new Error("create failed");
    expect(replay.result.environment.id).toBe(first.result.environment.id);
    const conflict = await h.call(
      "environment.create",
      { projectId: project.id, type: "local", name: "two" },
      { requestId: "env-key" },
    );
    expect(!conflict.ok && conflict.error.code).toBe("request-conflict");
    expect(await h.storage.getEnvironmentsByProject(project.id)).toHaveLength(1);
  });

  test("a deleted environment is not recreated by replaying its create key", async () => {
    const h = await harness();
    const { project } = await addProject(h);
    const first = await h.call<{ environment: { id: string } }>(
      "environment.create",
      { projectId: project.id, type: "local" },
      { requestId: "gone" },
    );
    if (!first.ok) throw new Error("create failed");
    await h.storage.removeEnvironment(first.result.environment.id);
    const replay = await h.call(
      "environment.create",
      { projectId: project.id, type: "local" },
      { requestId: "gone" },
    );
    expect(replay.receipt?.replayed).toBe(true);
    expect(await h.storage.getEnvironmentsByProject(project.id)).toHaveLength(0);
  });

  test("validates an explicit base and records it", async () => {
    const h = await harness();
    const { project, projectPath } = await addProject(h);
    const base = await headCommit(projectPath);
    await commitFile(projectPath, "later.txt", "later\n");
    const pinned = await h.call<{ environment: { id: string; base: { commit: string | null } } }>(
      "environment.create",
      { projectId: project.id, type: "local", baseBranch: "main", baseCommit: base },
      { requestId: "pinned" },
    );
    expect(pinned.ok).toBe(true);
    if (pinned.ok) expect(pinned.result.environment.base.commit).toBe(base);
    const unknownCommit = await h.call(
      "environment.create",
      { projectId: project.id, type: "local", baseBranch: "main", baseCommit: "f".repeat(40) },
      { requestId: "bad-base" },
    );
    expect(!unknownCommit.ok && unknownCommit.error.code).toBe("not-found");
    const unpublished = await commitFile(projectPath, "local-only.txt", "x\n");
    const container = await h.call(
      "environment.create",
      { projectId: project.id, type: "container", baseBranch: "main", baseCommit: unpublished },
      { requestId: "container-base" },
    );
    expect(!container.ok && container.error.code).toBe("conflict");
    const halfBase = await h.call(
      "environment.create",
      { projectId: project.id, type: "local", baseBranch: "main" },
      { requestId: "half" },
    );
    expect(!halfBase.ok && halfBase.error.code).toBe("invalid-input");
  });

  test("the legacy create path conflicts on a fingerprinted request reused with a different intent", async () => {
    const h = await harness();
    const { project } = await addProject(h);
    const create = h.commands.get("create_environment")!;
    const fingerprintA = "a".repeat(64);
    await create(
      {
        projectId: project.id,
        environmentType: "local",
        controlRequestId: "mcp-1",
        controlRequestFingerprint: fingerprintA,
      },
      h.context,
    );
    await expect(
      Promise.resolve(
        create(
          {
            projectId: project.id,
            environmentType: "local",
            controlRequestId: "mcp-1",
            controlRequestFingerprint: "b".repeat(64),
          },
          h.context,
        ),
      ),
    ).rejects.toThrow("different environment request");
    // Legacy records without a fingerprint keep converging.
    const legacy = (await create(
      { projectId: project.id, environmentType: "local", controlRequestId: "mcp-2" },
      h.context,
    )) as { id: string };
    const again = (await create(
      {
        projectId: project.id,
        environmentType: "local",
        controlRequestId: "mcp-2",
        controlRequestFingerprint: fingerprintA,
      },
      h.context,
    )) as { id: string };
    expect(again.id).toBe(legacy.id);
  });
});
