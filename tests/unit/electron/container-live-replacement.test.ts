/**
 * Real-Docker qualification for preserving replacement (plan step 06).
 *
 * Opt-in exactly like container-live-qualification.test.ts:
 * RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>. Every
 * resource is labelled with this run's private owner namespace and removed by
 * that label in `afterAll`; nothing else on the daemon is touched.
 *
 * Scenario ids refer to the matrix in
 * docs/improvements/containers/plan/14-integrated-qualification-and-rollout.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { runCommand } from "../../../apps/backend/src/core/shell";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import { waitForContainerBoot } from "../../../apps/backend/src/core/container-readiness";
import type { Environment } from "../../../apps/backend/src/core/models";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 600_000;

let dataDir = "";
let owner = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

beforeAll(async () => {
  if (!ENABLED) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-replacement-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ENABLED) return;
  const ids = (await docker(["ps", "-aq", "--filter", `label=orkestrator-owner=${owner}`]))
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) await docker(["rm", "-f", ...ids]).catch(() => undefined);
  const volumes = (
    await docker(["volume", "ls", "-q", "--filter", `label=orkestrator-owner=${owner}`])
  )
    .split("\n")
    .filter(Boolean);
  if (volumes.length > 0) await docker(["volume", "rm", ...volumes]).catch(() => undefined);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

function replacementContext(environment: Environment) {
  const fixture = memoryLifecycleContext([environment], dataDir);
  Object.assign(fixture.context, {
    dockerImage: IMAGE,
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
  });
  Object.assign(fixture.context.storage, {
    getProject: async () => ({
      id: "project-1",
      name: "Project",
      gitUrl: "https://example.invalid/none.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { allowedDomains: [] },
      repositories: {},
    }),
    listMultiReviewWorkflows: async () => [],
    listAllBuildPipelines: async () => [],
  });
  return fixture;
}

/** Workspace and provider state a user would lose to a naive recreate. */
const POPULATE = [
  "set -e",
  "cd /workspace",
  "git init -q -b main . && git config user.email q@example.invalid && git config user.name q",
  "printf 'tracked\\n' > tracked.txt && printf 'ignored.log\\nnode_modules/\\n' > .gitignore",
  "git add . && git commit -qm base",
  "git checkout -qb feature && printf 'unpushed\\n' > feature.txt && git add feature.txt && git commit -qm unpushed",
  "printf 'edited\\n' >> tracked.txt",
  "printf 'untracked\\n' > untracked.txt && printf 'noise\\n' > ignored.log",
  "mkdir -p node_modules/pkg && printf 'dep\\n' > node_modules/pkg/index.js",
  "head -c 3145728 /dev/urandom > large.bin",
  "printf '#!/bin/sh\\n' > run.sh && chmod 750 run.sh",
  "ln -s tracked.txt internal-link && ln -s /etc/hostname external-link",
  "mkdir -p /home/node/.claude/projects/p && printf '{\"t\":1}\\n' > /home/node/.claude/projects/p/s.jsonl",
  "mkdir -p /home/node/.codex/sessions/2026 && printf '{}\\n' > /home/node/.codex/sessions/2026/r.jsonl",
  "printf 'sqlite-main' > /home/node/.codex/state_5.sqlite && printf 'wal' > /home/node/.codex/state_5.sqlite-wal",
  "printf 'config' > /home/node/.codex/config.toml",
  "mkdir -p /home/node/.local/share/opencode && printf 'db' > /home/node/.local/share/opencode/opencode.db",
  "printf 'snapshot' > /home/node/.local/share/opencode/other.bin",
].join("\n");

const WORKSPACE_SNAPSHOT = [
  "cd /workspace",
  "git rev-parse HEAD feature main",
  "git branch --show-current",
  // `.orkestrator` holds Orkestrator's private storage marker; setup adds it
  // to .git/info/exclude on every start, which this fixture does not run.
  "git status --porcelain --ignored -- . ':!.orkestrator' | sort",
  "stat -c '%a %U' run.sh",
  "readlink internal-link external-link",
  "sha256sum large.bin tracked.txt node_modules/pkg/index.js",
  "git fsck --no-progress 2>&1 | head -3",
].join(" && ");

const STATE_SNAPSHOT = [
  "cat /home/node/.claude/projects/p/s.jsonl",
  "cat /home/node/.codex/sessions/2026/r.jsonl",
  "cat /home/node/.codex/orkestrator-sqlite/state_5.sqlite; echo",
  "cat /home/node/.codex/orkestrator-sqlite/state_5.sqlite-wal; echo",
  "cat /home/node/.local/share/opencode/orkestrator-db/opencode.db; echo",
  "test ! -e /home/node/.local/share/opencode/orkestrator-db/other.bin && echo no-snapshot",
].join(" && ");

async function exec(containerId: string, script: string): Promise<string> {
  return docker(["exec", "-u", "node", containerId, "bash", "-c", script]);
}

async function createLegacyEnvironment(name: string) {
  const { createDockerContainer } =
    await import("../../../apps/backend/src/core/commands-containers");
  const { resolveDockerImage } = await import("../../../apps/backend/src/core/docker-image");
  const environment = lifecycleEnvironment({
    id: `env-${RUN}-${name}`,
    networkAccessMode: "full",
  });
  const fixture = replacementContext(environment);
  const resolved = await resolveDockerImage(IMAGE);
  if (resolved.kind !== "present") throw new Error("qualification image missing");
  // A legacy runtime: no storage set, the workspace lives in the writable layer.
  const containerId = await createDockerContainer(environment, fixture.context, {
    imageId: resolved.imageId,
    runtimeGeneration: 1,
  });
  await docker(["start", containerId]);
  await waitForContainerBoot(containerId);
  await fixture.context.storage.updateEnvironment(environment.id, {
    containerId,
    status: "running",
    containerLifecycle: {
      schemaVersion: 1,
      revision: 1,
      lastRuntimeGeneration: 1,
      runtime: {
        containerId,
        runtimeGeneration: 1,
        owner,
        imageRef: IMAGE,
        imageId: resolved.imageId,
      },
      storage: { format: "legacy-layer", workspaceGeneration: 1 },
      outcomes: [],
    },
  });
  await exec(containerId, POPULATE);
  return { fixture, environmentId: environment.id, containerId };
}

function lifecycleOf(environment: Environment | null) {
  const parsed = parseContainerLifecycle(environment?.containerLifecycle);
  if (!parsed.supported) throw new Error("unsupported lifecycle record");
  return parsed.record;
}

describe("C14 legacy migration preserves the workspace and provider state", () => {
  live(
    "migrates a legacy writable layer onto verified volumes and keeps the source",
    async () => {
      const { replaceRuntimePreservingState } =
        await import("../../../apps/backend/src/core/container-replacement");
      const { fixture, environmentId, containerId } = await createLegacyEnvironment("c14");
      const before = await exec(containerId, WORKSPACE_SNAPSHOT);

      const outcome = await replaceRuntimePreservingState(
        { environmentId, expectedContainerId: containerId },
        fixture.context,
      );
      expect(outcome?.kind).toBe("migrate");
      expect(outcome?.containerId).not.toBe(containerId);

      const environment = await fixture.context.storage.getEnvironment(environmentId);
      const record = lifecycleOf(environment);
      expect(environment?.containerId).toBe(outcome!.containerId);
      expect(record.storage.format).toBe("volume-v1");
      expect(record.runtime?.runtimeGeneration).toBe(2);
      expect(record.retainedRuntimes?.map((entry) => entry.containerId)).toEqual([containerId]);
      expect(record.operation).toBeUndefined();
      expect(record.outcomes.at(-1)).toMatchObject({ kind: "migrate", status: "succeeded" });

      // The source is kept, stopped, as a recovery copy.
      expect(await docker(["inspect", "--format", "{{.State.Status}}", containerId])).toBe(
        "exited",
      );

      await docker(["start", outcome!.containerId]);
      await waitForContainerBoot(outcome!.containerId);
      expect(await exec(outcome!.containerId, WORKSPACE_SNAPSHOT)).toBe(before);
      const state = await exec(outcome!.containerId, STATE_SNAPSHOT);
      expect(state.split("\n")).toEqual([
        '{"t":1}',
        "{}",
        "sqlite-main",
        "wal",
        "db",
        "no-snapshot",
      ]);
      // Configuration and credentials are not carried over as durable state.
      expect(
        await exec(
          outcome!.containerId,
          "test -e /home/node/.codex/config.toml && echo copied || echo absent",
        ),
      ).toBe("absent");
      expect(await exec(outcome!.containerId, "mountpoint -q /workspace && echo mounted")).toBe(
        "mounted",
      );
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C14 volume rebuild copies the storage set before replacing the runtime", () => {
  live(
    "rebuilds a volume-backed runtime and retains the previous storage set",
    async () => {
      const { replaceRuntimePreservingState } =
        await import("../../../apps/backend/src/core/container-replacement");
      const { fixture, environmentId, containerId } = await createLegacyEnvironment("c14b");
      const migrated = await replaceRuntimePreservingState(
        { environmentId, expectedContainerId: containerId },
        fixture.context,
      );
      await docker(["start", migrated!.containerId]);
      await waitForContainerBoot(migrated!.containerId);
      await exec(migrated!.containerId, "printf 'after-migration\\n' > /workspace/new.txt");
      const before = await exec(migrated!.containerId, WORKSPACE_SNAPSHOT);
      const firstSet = lifecycleOf(
        await fixture.context.storage.getEnvironment(environmentId),
      ).storage;
      await fixture.context.storage.updateEnvironment(environmentId, { status: "running" });

      const rebuilt = await replaceRuntimePreservingState(
        { environmentId, expectedContainerId: migrated!.containerId },
        fixture.context,
      );
      expect(rebuilt?.kind).toBe("rebuild");
      const record = lifecycleOf(await fixture.context.storage.getEnvironment(environmentId));
      expect(record.storage.storageSetId).not.toBe(firstSet.storageSetId);
      expect(record.retainedStorage).toEqual([
        expect.objectContaining({
          storageSetId: firstSet.storageSetId,
          reason: "rebuild-source",
        }),
      ]);
      await docker(["start", rebuilt!.containerId]);
      await waitForContainerBoot(rebuilt!.containerId);
      expect(await exec(rebuilt!.containerId, WORKSPACE_SNAPSHOT)).toBe(before);
      expect(await exec(rebuilt!.containerId, "cat /workspace/new.txt")).toBe("after-migration");
      // Candidate writes never reach the retained set.
      await exec(rebuilt!.containerId, "printf 'x' > /workspace/candidate-only.txt");
      const retainedWorkspace = firstSet.volumes?.find((volume) => volume.role === "workspace");
      expect(
        await docker([
          "run",
          "--rm",
          "--label",
          `orkestrator-owner=${owner}`,
          "--entrypoint",
          "sh",
          "--mount",
          `type=volume,src=${retainedWorkspace!.name},dst=/v,readonly`,
          IMAGE,
          "-c",
          "test -e /v/candidate-only.txt && echo leaked || echo isolated",
        ]),
      ).toBe("isolated");
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C15/C16 cancellation, refusal and corrupt sources leave the original authoritative", () => {
  live(
    "a rebuild cancelled during copy removes the candidate and keeps the source",
    async () => {
      const { replaceRuntimePreservingState, requestReplacementCancellation } =
        await import("../../../apps/backend/src/core/container-replacement");
      const { fixture, environmentId, containerId } = await createLegacyEnvironment("c15");
      const before = await exec(containerId, WORKSPACE_SNAPSHOT);
      const emit = fixture.context.emit;
      fixture.context.emit = (event, payload) => {
        const snapshot = (
          payload as { snapshot?: { operation?: { operationId: string; phase: string } } }
        )?.snapshot;
        if (snapshot?.operation?.phase === "copying") {
          requestReplacementCancellation(snapshot.operation.operationId);
        }
        emit(event, payload);
      };
      await expect(
        replaceRuntimePreservingState(
          { environmentId, expectedContainerId: containerId },
          fixture.context,
        ),
      ).rejects.toThrow("cancelled");
      const environment = await fixture.context.storage.getEnvironment(environmentId);
      const record = lifecycleOf(environment);
      expect(environment?.containerId).toBe(containerId);
      expect(record.storage.format).toBe("legacy-layer");
      expect(record.outcomes.at(-1)).toMatchObject({ kind: "migrate", status: "cancelled" });
      expect(record.retainedStorage ?? []).toEqual([]);
      // Only the source container and no candidate volumes remain for this env.
      const containers = await docker([
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `label=environment-id=${environmentId}`,
      ]);
      expect(containers.split("\n").filter(Boolean)).toEqual([containerId]);
      expect(
        await docker(["volume", "ls", "-q", "--filter", `label=environment-id=${environmentId}`]),
      ).toBe("");
      // The original restarts with its files.
      await docker(["start", containerId]);
      await waitForContainerBoot(containerId);
      expect(await exec(containerId, WORKSPACE_SNAPSHOT)).toBe(before);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a copy that fails verification rolls back the candidate and keeps the source",
    async () => {
      const { replaceRuntimePreservingState } =
        await import("../../../apps/backend/src/core/container-replacement");
      const { fixture, environmentId, containerId } = await createLegacyEnvironment("c16c");
      // Docker does not follow a symlink at a copied root, so this session
      // directory would arrive empty; the helper must refuse it.
      await exec(
        containerId,
        "mkdir -p /tmp/elsewhere && printf x > /tmp/elsewhere/s.jsonl && rm -rf /home/node/.claude/projects && ln -s /tmp/elsewhere /home/node/.claude/projects",
      );
      const before = await exec(containerId, WORKSPACE_SNAPSHOT);
      await expect(
        replaceRuntimePreservingState(
          { environmentId, expectedContainerId: containerId },
          fixture.context,
        ),
      ).rejects.toThrow("ContainerLifecycleError:needs-attention");
      const record = lifecycleOf(await fixture.context.storage.getEnvironment(environmentId));
      expect(record.storage.format).toBe("legacy-layer");
      expect(record.runtime?.containerId).toBe(containerId);
      expect(record.outcomes.at(-1)).toMatchObject({ kind: "migrate", status: "failed" });
      expect(
        await docker(["volume", "ls", "-q", "--filter", `label=environment-id=${environmentId}`]),
      ).toBe("");
      await docker(["start", containerId]);
      await waitForContainerBoot(containerId);
      expect(await exec(containerId, WORKSPACE_SNAPSHOT)).toBe(before);
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a runtime that changed after review is refused before anything stops",
    async () => {
      const { replaceRuntimePreservingState } =
        await import("../../../apps/backend/src/core/container-replacement");
      const { fixture, environmentId, containerId } = await createLegacyEnvironment("c15b");
      await expect(
        replaceRuntimePreservingState(
          { environmentId, expectedContainerId: "some-other-container" },
          fixture.context,
        ),
      ).rejects.toThrow("ContainerLifecycleError:runtime-changed");
      expect(await docker(["inspect", "--format", "{{.State.Status}}", containerId])).toBe(
        "running",
      );
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C17/C18 recovery copies and reviewed cleanup", () => {
  live(
    "restoring a copy keeps newer work as another copy and can be reversed",
    async () => {
      const { replaceRuntimePreservingState } =
        await import("../../../apps/backend/src/core/container-replacement");
      const { listRecoveryCopies, restoreRecoveryCopy, discardRecoveryCopy } =
        await import("../../../apps/backend/src/core/recovery-copies");
      const { fixture, environmentId, containerId } = await createLegacyEnvironment("c17");
      const legacySnapshot = await exec(containerId, WORKSPACE_SNAPSHOT);
      const migrated = await replaceRuntimePreservingState(
        { environmentId, expectedContainerId: containerId },
        fixture.context,
      );
      await docker(["start", migrated!.containerId]);
      await waitForContainerBoot(migrated!.containerId);
      await exec(migrated!.containerId, "printf 'newer\\n' > /workspace/newer.txt");
      await docker(["stop", "-t", "5", migrated!.containerId]);

      // Restore the legacy copy: the migrated runtime and its volumes become
      // a restore-source copy in the same commit.
      let list = await listRecoveryCopies(environmentId, fixture.context);
      expect(list.copies.map((copy) => [copy.copyId, copy.kind, copy.restorable])).toEqual([
        [containerId, "legacy-runtime", true],
      ]);
      await restoreRecoveryCopy(
        {
          environmentId,
          copyId: containerId,
          expectedContainerId: migrated!.containerId,
          expectedRevision: list.revision,
        },
        fixture.context,
      );
      let environment = await fixture.context.storage.getEnvironment(environmentId);
      expect(environment?.containerId).toBe(containerId);
      expect(lifecycleOf(environment).storage.format).toBe("legacy-layer");
      await docker(["start", containerId]);
      await waitForContainerBoot(containerId);
      expect(await exec(containerId, WORKSPACE_SNAPSHOT)).toBe(legacySnapshot);
      expect(await exec(containerId, "test -e /workspace/newer.txt && echo yes || echo no")).toBe(
        "no",
      );
      await docker(["stop", "-t", "5", containerId]);

      // The newer work is a restorable copy; restoring it brings it back.
      list = await listRecoveryCopies(environmentId, fixture.context);
      const newer = list.copies.find((copy) => copy.reason === "restore-source");
      expect(newer).toMatchObject({ kind: "storage-set", restorable: true, presence: "present" });
      await restoreRecoveryCopy(
        {
          environmentId,
          copyId: newer!.copyId,
          expectedContainerId: containerId,
          expectedRevision: list.revision,
        },
        fixture.context,
      );
      environment = await fixture.context.storage.getEnvironment(environmentId);
      expect(environment?.containerId).toBe(migrated!.containerId);
      await docker(["start", migrated!.containerId]);
      await waitForContainerBoot(migrated!.containerId);
      expect(await exec(migrated!.containerId, "cat /workspace/newer.txt")).toBe("newer");
      await docker(["stop", "-t", "5", migrated!.containerId]);

      // Discarding the legacy copy removes exactly its container.
      list = await listRecoveryCopies(environmentId, fixture.context);
      expect(list.copies.map((copy) => copy.copyId)).toEqual([containerId]);
      const discarded = await discardRecoveryCopy(
        { environmentId, copyId: containerId, expectedRevision: list.revision },
        fixture.context,
      );
      expect(discarded?.discarded).toBe(true);
      expect(await docker(["ps", "-aq", "--no-trunc", "--filter", `id=${containerId}`])).toBe("");
      expect(
        await docker(["inspect", "--format", "{{.State.Status}}", migrated!.containerId]),
      ).toBe("exited");
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "cleanup offers only unreferenced volumes and removes only the reviewed ones",
    async () => {
      const { previewDockerCleanup, executeDockerCleanup } =
        await import("../../../apps/backend/src/core/docker-cleanup-preview");
      const { fixture, environmentId, containerId } = await createLegacyEnvironment("c18");
      const { replaceRuntimePreservingState } =
        await import("../../../apps/backend/src/core/container-replacement");
      await replaceRuntimePreservingState(
        { environmentId, expectedContainerId: containerId },
        fixture.context,
      );
      const leftover = `ork-${RUN}-leftover`;
      await docker([
        "volume",
        "create",
        "--label",
        "app=orkestrator-v2",
        "--label",
        `orkestrator-owner=${owner}`,
        "--label",
        `environment-id=env-${RUN}-deleted`,
        leftover,
      ]);
      const preview = await previewDockerCleanup(fixture.context);
      const byId = new Map(preview.rows.map((row) => [row.id, row.classification]));
      expect(byId.get(leftover)).toBe("eligible");
      // The migrated environment's volumes and its legacy copy are kept.
      const record = lifecycleOf(await fixture.context.storage.getEnvironment(environmentId));
      for (const volume of record.storage.volumes ?? []) {
        expect(byId.get(volume.name)).toBe("assigned");
      }
      expect(byId.get(containerId)).toBe("retained-recovery");
      const result = await executeDockerCleanup(
        { selectionToken: preview.selectionToken, containerIds: [], volumeNames: [leftover] },
        fixture.context,
      );
      expect(result.outcomes).toEqual([{ kind: "volume", id: leftover, outcome: "removed" }]);
      expect(await docker(["volume", "ls", "-q", "--filter", `name=${leftover}`])).toBe("");
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("C19 deletion interrupted between runtime and volume removal", () => {
  live(
    "the ledger resumes and removes volumes, recovery copies and the network exactly once",
    async () => {
      const { replaceRuntimePreservingState } =
        await import("../../../apps/backend/src/core/container-replacement");
      const { buildEnvironmentCleanupEntry, runEnvironmentCleanupStep } =
        await import("../../../apps/backend/src/core/environment-cleanup");
      const { environmentCleanupLedger } =
        await import("../../../apps/backend/src/core/environment-cleanup-ledger");
      const { reconcileEnvironmentCleanup } =
        await import("../../../apps/backend/src/core/environment-cleanup-reconciler");
      const { fixture, environmentId, containerId } = await createLegacyEnvironment("c19");
      const migrated = await replaceRuntimePreservingState(
        { environmentId, expectedContainerId: containerId },
        fixture.context,
      );
      const environment = (await fixture.context.storage.getEnvironment(environmentId))!;
      const entry = buildEnvironmentCleanupEntry(environment, null, dataDir);
      // Current runtime, the legacy recovery copy, the storage set, the network.
      expect(entry.containerId).toBe(migrated!.containerId);
      expect(entry.retainedContainers).toEqual([containerId]);
      expect(entry.volumes.length).toBe(2);
      expect(entry.pending).toEqual(["container", "volumes", "network", "state-dirs"]);
      const ledger = environmentCleanupLedger(dataDir);
      await ledger.record(entry);
      await fixture.context.storage.removeEnvironment(environmentId);

      // The deletion removes the containers, then the backend "dies".
      expect(await runEnvironmentCleanupStep(entry, "container", fixture.context)).toBe(true);
      expect(await docker(["ps", "-aq", "--filter", `label=environment-id=${environmentId}`])).toBe(
        "",
      );
      expect(
        (await docker(["volume", "ls", "-q", "--filter", `label=environment-id=${environmentId}`]))
          .split("\n")
          .filter(Boolean),
      ).toHaveLength(2);
      expect((await ledger.get(environmentId))?.pending).toEqual([
        "volumes",
        "network",
        "state-dirs",
      ]);

      // A later start's reconciler finishes exactly what is owed.
      const result = await reconcileEnvironmentCleanup(fixture.context, {
        now: () => new Date(Date.now() + 60 * 60_000),
      });
      expect(result.attempted).toBe(1);
      expect(await ledger.get(environmentId)).toBeNull();
      expect(
        await docker(["volume", "ls", "-q", "--filter", `label=environment-id=${environmentId}`]),
      ).toBe("");
      expect(
        await docker(["network", "ls", "-q", "--filter", `label=environment-id=${environmentId}`]),
      ).toBe("");
    },
    LIVE_TIMEOUT_MS,
  );
});
