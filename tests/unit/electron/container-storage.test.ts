import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import {
  ensureStorageVolumes,
  initializeStorageSet,
  planStorageSet,
  removeStorageVolumes,
  selectStorageFormat,
  storageMountArguments,
  storageVolumeName,
  verifyStorageSet,
} from "../../../apps/backend/src/core/container-storage";
import { PROVIDER_STATE_LAYOUT } from "../../../apps/backend/src/core/container-state-layout";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function context() {
  const dir = await tempDir("ork-storage-");
  cleanup.push(dir);
  return {
    ...memoryLifecycleContext([lifecycleEnvironment()], dir),
    owner: dockerOwnerNamespace(dir),
  };
}

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

describe("storage set identity", () => {
  test("names volumes from owner, environment, storage set and role within Docker's bounds", () => {
    const name = storageVolumeName(
      "0123456789abcdef",
      "Env With Spaces/../x",
      "abc123",
      "workspace",
    );
    expect(name).toBe("ork-0123456789abcdef-env-with-spaces-..-x-abc123-workspace");
    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    const long = storageVolumeName("o".repeat(16), "e".repeat(400), "s".repeat(12), "state");
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("-ssssssssssss-state")).toBe(true);
    const set = planStorageSet("env-1", "owner", 3, "fixedset");
    expect(set).toEqual({
      format: "volume-v1",
      workspaceGeneration: 3,
      storageSetId: "fixedset",
      volumes: [
        { role: "workspace", name: "ork-owner-env-1-fixedset-workspace" },
        { role: "state", name: "ork-owner-env-1-fixedset-state" },
      ],
    });
  });

  test("uses persistent volumes only for a capable image on a sub-path capable engine", () => {
    const capable = { "persistent-workspace": 1 };
    const engine = { kind: "local-engine" as const, serverVersion: "29.7.2" };
    expect(selectStorageFormat(capable, engine, {})).toEqual({ format: "volume-v1" });
    expect(selectStorageFormat(null, engine, {})).toMatchObject({ format: "legacy-layer" });
    expect(selectStorageFormat(capable, { ...engine, serverVersion: "25.0.3" }, {})).toMatchObject({
      reason: "engine-without-volume-subpath",
    });
    expect(
      selectStorageFormat(capable, engine, { ORKESTRATOR_CONTAINER_STORAGE: "legacy-layer" }),
    ).toMatchObject({ reason: "disabled-by-configuration" });
  });

  test("mounts the workspace whole and provider state only at its verified paths", () => {
    const args = storageMountArguments(planStorageSet("env-1", "owner", 1, "set"));
    expect(args.slice(0, 2)).toEqual([
      "--mount",
      "type=volume,src=ork-owner-env-1-set-workspace,dst=/workspace,volume-nocopy",
    ]);
    const stateMounts = args.filter((arg) => arg.includes("-state,"));
    expect(stateMounts).toHaveLength(PROVIDER_STATE_LAYOUT.length);
    for (const mount of stateMounts) expect(mount).toContain("volume-subpath=");
    // Never a whole home directory.
    for (const entry of PROVIDER_STATE_LAYOUT) {
      expect(entry.containerPath).not.toMatch(/^\/home\/node\/?$/);
      expect(entry.containerPath).not.toMatch(/^\/home\/node\/\.[a-z]+\/?$/);
    }
  });
});

describe("volume creation and adoption", () => {
  test("creates missing volumes with labels and adopts an exact earlier creation", async () => {
    const { context: ctx, owner } = await context();
    const storage = planStorageSet("env-lifecycle", owner, 1, "set1");
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1:$2" in
  volume:inspect)
    case "$*" in
      *workspace) printf '{"app":"orkestrator-v2","orkestrator-owner":"${owner}","environment-id":"env-lifecycle","orkestrator-resource-role":"workspace","orkestrator-storage-set":"set1","orkestrator-storage-format":"volume-v1"}\\n' ;;
      *) printf 'Error response from daemon: get x: no such volume\\n' >&2; exit 1 ;;
    esac
    ;;
  volume:create) printf 'created\\n' ;;
esac
`,
      async (log) => {
        await ensureStorageVolumes(ctx, "env-lifecycle", storage);
        const calls = await log.read();
        expect(calls).not.toContain(
          "volume create --label app=orkestrator-v2 --label orkestrator-owner=" +
            owner +
            " --label environment-id=env-lifecycle --label orkestrator-resource-role=workspace",
        );
        expect(calls).toContain("--label orkestrator-resource-role=state");
        expect(calls).toContain("ork-" + owner + "-env-lifecycle-set1-state");
      },
    );
  });

  test("never adopts a same-named volume with other labels", async () => {
    const { context: ctx, owner } = await context();
    const storage = planStorageSet("env-lifecycle", owner, 1, "set1");
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
[ "$1:$2" = "volume:inspect" ] && printf '{"app":"orkestrator-v2","orkestrator-owner":"someone-else"}\\n'
exit 0
`,
      async (log) => {
        await expect(ensureStorageVolumes(ctx, "env-lifecycle", storage)).rejects.toThrow(
          "ContainerLifecycleError:needs-attention",
        );
        expect(await log.read()).not.toContain("volume create");
      },
    );
  });
});

describe("storage helper", () => {
  test("initializes through the image's helper with no network and no entrypoint", async () => {
    const { context: ctx, owner } = await context();
    const storage = planStorageSet("env-lifecycle", owner, 2, "set1");
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
printf 'ORKESTRATOR_STORAGE status=ok initialized=2\\n'
`,
      async (log) => {
        expect(await initializeStorageSet(ctx, IMAGE_ID, "env-lifecycle", storage)).toEqual({
          ok: true,
        });
        const call = await log.read();
        expect(call).toContain("run --rm --network none --user root");
        expect(call).toContain("--entrypoint /usr/local/bin/orkestrator-storage.sh");
        expect(call).toContain(`dst=/storage/workspace,volume-nocopy`);
        expect(call).toContain(`${IMAGE_ID} init env-lifecycle ${owner} set1 2`);
      },
    );
  });

  test("reports unknown content and foreign markers without touching data", async () => {
    const { context: ctx, owner } = await context();
    const storage = planStorageSet("env-lifecycle", owner, 1, "set1");
    for (const [status, expected] of [
      [
        "unknown-content role=workspace",
        { ok: false, status: "unknown-content", role: "workspace" },
      ],
      ["foreign-marker role=state", { ok: false, status: "foreign-marker", role: "state" }],
      ["missing-marker role=workspace", { ok: false, status: "missing-marker", role: "workspace" }],
    ] as const) {
      await withDockerScript(
        `#!/bin/sh
printf 'ORKESTRATOR_STORAGE status=${status}\\n'
exit 3
`,
        async () => {
          expect(await verifyStorageSet(ctx, IMAGE_ID, "env-lifecycle", storage)).toEqual(expected);
        },
      );
    }
    await withDockerScript("#!/bin/sh\nexit 1\n", async () => {
      expect(await verifyStorageSet(ctx, IMAGE_ID, "env-lifecycle", storage)).toEqual({
        ok: false,
        status: "helper-failed",
      });
    });
  });
});

describe("storage removal", () => {
  test("removes only this environment's volumes and keeps a reference to what stays", async () => {
    const { context: ctx, owner } = await context();
    const storage = planStorageSet("env-lifecycle", owner, 1, "set1");
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1:$2" in
  volume:inspect) printf '{"orkestrator-owner":"${owner}","environment-id":"env-lifecycle"}\\n' ;;
  volume:rm)
    case "$3" in
      *state) printf 'Error response from daemon: volume is in use\\n' >&2; exit 1 ;;
    esac
    ;;
esac
`,
      async (log) => {
        const kept = await removeStorageVolumes(ctx, "env-lifecycle", storage);
        expect(kept).toEqual([{ role: "state", name: `ork-${owner}-env-lifecycle-set1-state` }]);
        const calls = await log.read();
        expect(calls).toContain(`volume rm ork-${owner}-env-lifecycle-set1-workspace`);
        expect(calls).not.toContain("volume rm -f");
      },
    );
  });
});
