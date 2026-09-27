import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { groupRecoveryCopies } from "../../../apps/backend/src/core/recovery-copy-model";
import {
  discardRecoveryCopy,
  listRecoveryCopies,
  restoreRecoveryCopy,
} from "../../../apps/backend/src/core/recovery-copies";
import {
  classifyVolume,
  executeDockerCleanup,
  previewDockerCleanup,
  resetCleanupGrants,
} from "../../../apps/backend/src/core/docker-cleanup-preview";
import { loadProtection } from "../../../apps/backend/src/core/docker-cleanup-inventory";
import { buildEnvironmentCleanupEntry } from "../../../apps/backend/src/core/environment-cleanup";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import { resetContainerOwnershipCache } from "../../../apps/backend/src/core/container-lifecycle-service";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  resetCleanupGrants();
  resetContainerOwnershipCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function dataDir() {
  const dir = await tempDir("ork-recovery-");
  cleanup.push(dir);
  return { dir, owner: dockerOwnerNamespace(dir) };
}

function volumes(set: string) {
  return [
    { role: "workspace", name: `ork-o-env-${set}-workspace` },
    { role: "state", name: `ork-o-env-${set}-state` },
  ];
}

function record(value: unknown) {
  const parsed = parseContainerLifecycle(value);
  if (!parsed.supported) throw new Error("unsupported");
  return parsed.record;
}

/** An environment that migrated (legacy copy) and then rebuilt (paired copy). */
function recoveryEnvironment(owner: string) {
  return lifecycleEnvironment({
    containerId: "current-container",
    status: "stopped",
    containerLifecycle: {
      schemaVersion: 1,
      revision: 9,
      lastRuntimeGeneration: 3,
      runtime: { containerId: "current-container", runtimeGeneration: 3, owner },
      storage: {
        format: "volume-v1",
        workspaceGeneration: 1,
        storageSetId: "set-b",
        volumes: volumes("set-b"),
      },
      retainedRuntimes: [
        {
          containerId: "legacy-container",
          runtimeGeneration: 1,
          owner,
          retainedAt: "2026-09-01T00:00:00.000Z",
          retainedReason: "migrate-source",
        },
        {
          containerId: "rebuild-container",
          runtimeGeneration: 2,
          owner,
          storageSetId: "set-a",
          retainedReason: "rebuild-source",
        },
      ],
      retainedStorage: [
        {
          storageSetId: "set-a",
          workspaceGeneration: 1,
          volumes: volumes("set-a"),
          retainedAt: "2026-09-02T00:00:00.000Z",
          reason: "rebuild-source",
        },
        {
          storageSetId: "set-x",
          workspaceGeneration: 1,
          volumes: volumes("set-x").slice(0, 1),
          retainedAt: "2026-09-03T00:00:00.000Z",
          reason: "failed-candidate",
        },
      ],
      outcomes: [],
    },
  });
}

describe("recovery copy model", () => {
  test("pairs a retained runtime with the storage set it mounts", () => {
    const groups = groupRecoveryCopies(record(recoveryEnvironment("o").containerLifecycle));
    expect(groups.map((group) => [group.copyId, group.kind, group.reason])).toEqual([
      ["legacy-container", "legacy-runtime", "migrate-source"],
      ["set-a", "storage-set", "rebuild-source"],
      ["set-x", "storage-set", "failed-candidate"],
    ]);
    expect(groups[1]?.runtime?.containerId).toBe("rebuild-container");
    expect(groups[1]?.storage?.storageSetId).toBe("set-a");
  });

  test("lists presence and restorability from Docker", async () => {
    const { dir, owner } = await dataDir();
    const { context } = memoryLifecycleContext([recoveryEnvironment(owner)], dir);
    await withDockerScript(
      `#!/bin/sh
case "$1:$2" in
  inspect:*)
    case "$*" in
      *legacy-container*) printf '${owner}\\texited\\torkestrator-v2\\tlegacy-container\\n' ;;
      *) printf 'Error: No such object\\n' >&2; exit 1 ;;
    esac ;;
  volume:inspect) printf '{}\\n' ;;
esac
exit 0
`,
      async () => {
        const list = await listRecoveryCopies("env-lifecycle", context);
        expect(list.revision).toBe(9);
        expect(list.copies.map((copy) => [copy.copyId, copy.presence, copy.restorable])).toEqual([
          ["legacy-container", "present", true],
          // Its runtime is gone but both volumes exist: still restorable.
          ["set-a", "partial", true],
          ["set-x", "present", false],
        ]);
      },
    );
  });
});

describe("discarding a recovery copy", () => {
  test("removes the copy's container and volumes and releases the reference", async () => {
    const { dir, owner } = await dataDir();
    const { context, environments } = memoryLifecycleContext([recoveryEnvironment(owner)], dir);
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1:$2" in
  inspect:-f)
    case "$*" in
      *"json .Config.Labels"*) printf '{"environment-id":"env-lifecycle"}\\n' ;;
      *) printf '${owner}\\texited\\torkestrator-v2\\trebuild-container\\n' ;;
    esac ;;
  volume:inspect) printf '{"orkestrator-owner":"${owner}","environment-id":"env-lifecycle"}\\n' ;;
esac
exit 0
`,
      async (log) => {
        const result = await discardRecoveryCopy(
          { environmentId: "env-lifecycle", copyId: "set-a", expectedRevision: 9 },
          context,
        );
        expect(result).toMatchObject({ discarded: true });
        const calls = await log.read();
        expect(calls).toContain("rm -f rebuild-container");
        expect(calls).toContain("volume rm ork-o-env-set-a-workspace");
        expect(calls).not.toContain("volume rm -f");
        expect(calls).not.toContain("current-container");
      },
    );
    const lifecycle = record(environments.get("env-lifecycle")?.containerLifecycle);
    expect(lifecycle.retainedRuntimes?.map((runtime) => runtime.containerId)).toEqual([
      "legacy-container",
    ]);
    expect(lifecycle.retainedStorage?.map((entry) => entry.storageSetId)).toEqual(["set-x"]);
  });

  test("keeps referencing what Docker would not remove", async () => {
    const { dir, owner } = await dataDir();
    const { context, environments } = memoryLifecycleContext([recoveryEnvironment(owner)], dir);
    await withDockerScript(
      `#!/bin/sh
case "$1:$2" in
  inspect:-f) printf 'Error: No such object\\n' >&2; exit 1 ;;
  volume:inspect) printf '{"orkestrator-owner":"${owner}","environment-id":"env-lifecycle"}\\n' ;;
  volume:rm)
    case "$3" in *state) printf 'Error response from daemon: volume is in use\\n' >&2; exit 1 ;; esac ;;
esac
exit 0
`,
      async () => {
        const result = await discardRecoveryCopy(
          { environmentId: "env-lifecycle", copyId: "set-a", expectedRevision: 9 },
          context,
        );
        expect(result).toEqual({
          copyId: "set-a",
          discarded: false,
          kept: { containerId: null, volumes: ["ork-o-env-set-a-state"] },
        });
      },
    );
    const lifecycle = record(environments.get("env-lifecycle")?.containerLifecycle);
    // The missing runtime is released; the surviving volume stays referenced.
    expect(lifecycle.retainedRuntimes?.map((runtime) => runtime.containerId)).toEqual([
      "legacy-container",
    ]);
    expect(
      lifecycle.retainedStorage?.find((entry) => entry.storageSetId === "set-a")?.volumes,
    ).toEqual([{ role: "state", name: "ork-o-env-set-a-state" }]);
    expect(lifecycle.outcomes.at(-1)).toMatchObject({ status: "failed" });
  });

  test("a stale review conflicts instead of discarding", async () => {
    const { dir, owner } = await dataDir();
    const { context } = memoryLifecycleContext([recoveryEnvironment(owner)], dir);
    await withDockerScript("#!/bin/sh\nexit 1\n", async () => {
      await expect(
        discardRecoveryCopy(
          { environmentId: "env-lifecycle", copyId: "set-a", expectedRevision: 8 },
          context,
        ),
      ).rejects.toThrow("ContainerLifecycleError:revision-conflict");
      await expect(
        discardRecoveryCopy(
          { environmentId: "env-lifecycle", copyId: "unknown-copy", expectedRevision: 9 },
          context,
        ),
      ).rejects.toThrow("ContainerLifecycleError:revision-conflict");
    });
  });
});

describe("restoring a recovery copy", () => {
  test("refuses a copy that cannot be restored before stopping anything", async () => {
    const { dir, owner } = await dataDir();
    const { context } = memoryLifecycleContext([recoveryEnvironment(owner)], dir);
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
[ "$1:$2" = "volume:inspect" ] && printf '{}\\n'
exit 0
`,
      async (log) => {
        await expect(
          restoreRecoveryCopy(
            {
              environmentId: "env-lifecycle",
              copyId: "set-x",
              expectedContainerId: "current-container",
            },
            context,
          ),
        ).rejects.toThrow("ContainerLifecycleError:needs-attention");
        expect(await log.read()).not.toMatch(/^stop /m);
      },
    );
  });

  test("a changed runtime is refused", async () => {
    const { dir, owner } = await dataDir();
    const { context } = memoryLifecycleContext([recoveryEnvironment(owner)], dir);
    await expect(
      restoreRecoveryCopy(
        { environmentId: "env-lifecycle", copyId: "set-a", expectedContainerId: "other" },
        context,
      ),
    ).rejects.toThrow("ContainerLifecycleError:runtime-changed");
  });
});

describe("deletion and cleanup protection", () => {
  test("deleting an environment owes its recovery copies too", async () => {
    const { dir, owner } = await dataDir();
    const entry = buildEnvironmentCleanupEntry(recoveryEnvironment(owner), null, dir);
    expect(entry.pending).toContain("container");
    expect(entry.retainedContainers).toEqual(["legacy-container", "rebuild-container"]);
    expect(entry.volumes).toEqual(
      expect.arrayContaining([
        "ork-o-env-set-b-workspace",
        "ork-o-env-set-a-state",
        "ork-o-env-set-x-workspace",
      ]),
    );
  });

  test("classifies volumes by what references them", async () => {
    const { dir, owner } = await dataDir();
    const { context } = memoryLifecycleContext([recoveryEnvironment(owner)], dir);
    const protection = await loadProtection(context);
    const labels = (environmentId: string, other = owner) => ({
      app: "orkestrator-v2",
      "orkestrator-owner": other,
      "environment-id": environmentId,
    });
    const classify = (name: string, environmentId = "env-lifecycle", other = owner) =>
      classifyVolume({ name, labels: labels(environmentId, other) }, protection, owner);
    expect(classify("ork-o-env-set-b-state")).toBe("assigned");
    expect(classify("ork-o-env-set-a-state")).toBe("retained-recovery");
    expect(classify("unreferenced", "env-lifecycle")).toBe("live-environment-label");
    expect(classify("leftover", "env-deleted-long-ago")).toBe("eligible");
    expect(classify("theirs", "env-deleted-long-ago", "someone-else")).toBe("foreign-owner");
  });

  test("execution removes only the reviewed selection and rechecks each resource", async () => {
    const { dir, owner } = await dataDir();
    const { context, environments } = memoryLifecycleContext([recoveryEnvironment(owner)], dir);
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1:$2" in
  ps:*) ;;
  volume:ls)
    printf '{"Name":"leftover-1","Labels":"app=orkestrator-v2,orkestrator-owner=${owner},environment-id=env-gone"}\\n'
    printf '{"Name":"leftover-2","Labels":"app=orkestrator-v2,orkestrator-owner=${owner},environment-id=env-gone-2"}\\n'
    printf '{"Name":"ork-o-env-set-a-state","Labels":"app=orkestrator-v2,orkestrator-owner=${owner},environment-id=env-lifecycle"}\\n'
    ;;
  volume:inspect)
    case "$*" in
      *leftover-2*) printf '{"app":"orkestrator-v2","orkestrator-owner":"${owner}","environment-id":"env-gone-2"}\\n' ;;
      *) printf '{"app":"orkestrator-v2","orkestrator-owner":"${owner}","environment-id":"env-gone"}\\n' ;;
    esac ;;
esac
exit 0
`,
      async (log) => {
        const preview = await previewDockerCleanup(context);
        expect(preview.rows.map((row) => [row.id, row.classification])).toEqual([
          ["leftover-1", "eligible"],
          ["leftover-2", "eligible"],
          ["ork-o-env-set-a-state", "retained-recovery"],
        ]);
        // Between review and execution, leftover-2 becomes a live
        // environment's storage.
        environments.set(
          "env-gone-2",
          lifecycleEnvironment({
            id: "env-gone-2",
            containerLifecycle: {
              schemaVersion: 1,
              revision: 1,
              lastRuntimeGeneration: 0,
              storage: {
                format: "volume-v1",
                workspaceGeneration: 1,
                storageSetId: "s",
                volumes: [{ role: "workspace", name: "leftover-2" }],
              },
              outcomes: [],
            },
          }),
        );
        const result = await executeDockerCleanup(
          {
            selectionToken: preview.selectionToken,
            containerIds: [],
            volumeNames: ["leftover-1", "leftover-2", "ork-o-env-set-a-state"],
          },
          context,
        );
        expect(result.outcomes).toEqual([
          { kind: "volume", id: "leftover-1", outcome: "removed" },
          { kind: "volume", id: "leftover-2", outcome: "conflict", reason: "assigned" },
          {
            kind: "volume",
            id: "ork-o-env-set-a-state",
            outcome: "conflict",
            reason: "not-in-preview",
          },
        ]);
        const calls = await log.read();
        expect(calls).toContain("volume rm leftover-1");
        expect(calls).not.toContain("volume rm leftover-2");
        expect(calls).not.toContain("volume rm ork-o-env-set-a-state");
        // The token is consumed.
        await expect(
          executeDockerCleanup(
            { selectionToken: preview.selectionToken, containerIds: [], volumeNames: [] },
            context,
          ),
        ).rejects.toThrow("revision-conflict");
      },
    );
  });
});

describe("recovery copy sizes", () => {
  test("volume sizes come from one system df and unparseable answers stay unknown", async () => {
    const { parseVolumeSizes } = await import("../../../apps/backend/src/core/recovery-copies");
    const sizes = parseVolumeSizes(
      JSON.stringify([
        { Name: "ork-a-workspace", Size: "1.5GB" },
        { Name: "ork-a-state", Size: "12kB" },
        { Name: "odd", Size: "N/A" },
      ]),
    );
    expect(sizes?.get("ork-a-workspace")).toBe(1_500_000_000);
    expect(sizes?.get("ork-a-state")).toBe(12_000);
    expect(sizes?.has("odd")).toBe(false);
    expect(parseVolumeSizes("not json")).toBeNull();
    expect(parseVolumeSizes('{"Name":"x"}')).toBeNull();
  });
});
