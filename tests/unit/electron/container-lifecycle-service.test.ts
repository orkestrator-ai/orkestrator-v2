import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MAX_LIFECYCLE_RECORD_BYTES,
  MAX_RECENT_OPERATION_OUTCOMES,
  createOperationId,
  parseContainerLifecycle,
  parseContainerMutationIdentity,
} from "@orkestrator/protocol/container-lifecycle";
import {
  advanceContainerOperation,
  beginContainerOperation,
  completeContainerOperation,
  reconcileContainerOperations,
  resetContainerOwnershipCache,
  resolveContainerOwnership,
  resolveNeedsAttentionOperation,
  runContainerOperation,
} from "../../../apps/backend/src/core/container-lifecycle-service";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import {
  REGISTRY_SCHEMA_MARKER_FILE,
  REGISTRY_WRITER_LEASE_FILE,
  RegistryWriterLease,
  checkRegistrySchemaMarker,
  openRegistryWriter,
} from "../../../apps/backend/src/core/registry-writer-lease";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  resetContainerOwnershipCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const dir = await tempDir("ork-lifecycle-data-");
  cleanup.push(dir);
  return dir;
}

function record(environment: { containerLifecycle?: unknown }) {
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (!parsed.supported) throw new Error("unsupported");
  return parsed.record;
}

describe("container lifecycle operations", () => {
  test("persists intent before effects and deduplicates a repeated request", async () => {
    const { context, environments, events } = memoryLifecycleContext(
      [lifecycleEnvironment()],
      await dataDir(),
    );
    const operationId = createOperationId();
    let effects = 0;
    const first = await runContainerOperation(
      context,
      "env-lifecycle",
      "stop",
      { operationId },
      async (operation) => {
        // Intent is durable before the effect runs.
        expect(record(environments.get("env-lifecycle")!).operation?.operationId).toBe(
          operation.operationId,
        );
        effects += 1;
        return "done";
      },
    );
    expect(first).toEqual({ result: "done" });
    const second = await runContainerOperation(
      context,
      "env-lifecycle",
      "stop",
      { operationId },
      async () => {
        effects += 1;
        return "again";
      },
    );
    expect(second).toEqual({
      replayed: expect.objectContaining({ operationId, status: "succeeded", kind: "stop" }),
    });
    expect(effects).toBe(1);
    const stored = record(environments.get("env-lifecycle")!);
    expect(stored.operation).toBeUndefined();
    expect(stored.revision).toBe(2);
    // Progress is published only after it is durable, with its revision.
    expect(
      events.map(
        (event) => (event.payload as { snapshot: { revision: number } }).snapshot.revision,
      ),
    ).toEqual([1, 2]);
  });

  test("bounds outcomes and refuses a request older than the retained horizon", async () => {
    const { context, environments } = memoryLifecycleContext(
      [lifecycleEnvironment()],
      await dataDir(),
    );
    const base = Date.now() - 1_000_000;
    const ids: string[] = [];
    for (let index = 0; index < MAX_RECENT_OPERATION_OUTCOMES + 3; index += 1) {
      const operationId = createOperationId(base + index * 1_000);
      ids.push(operationId);
      await runContainerOperation(context, "env-lifecycle", "stop", { operationId }, async () => 1);
    }
    const stored = record(environments.get("env-lifecycle")!);
    expect(stored.outcomes).toHaveLength(MAX_RECENT_OPERATION_OUTCOMES);
    expect(JSON.stringify(stored).length).toBeLessThan(MAX_LIFECYCLE_RECORD_BYTES);
    // The evicted request cannot be matched to its result, so it is refused
    // rather than silently run again.
    await expect(
      runContainerOperation(
        context,
        "env-lifecycle",
        "stop",
        { operationId: ids[0] },
        async () => 1,
      ),
    ).rejects.toThrow("ContainerLifecycleError:operation-unknown");
    // A retained one still replays.
    await expect(
      runContainerOperation(
        context,
        "env-lifecycle",
        "stop",
        { operationId: ids.at(-1) },
        async () => 1,
      ),
    ).resolves.toEqual({ replayed: expect.objectContaining({ operationId: ids.at(-1) }) });
  });

  test("conflicts on a stale revision and on a concurrent operation", async () => {
    const { context } = memoryLifecycleContext([lifecycleEnvironment()], await dataDir());
    await expect(
      beginContainerOperation(context, "env-lifecycle", "stop", { expectedRevision: 5 }),
    ).rejects.toThrow("ContainerLifecycleError:revision-conflict");
    const admission = await beginContainerOperation(context, "env-lifecycle", "stop", {
      expectedRevision: 0,
    });
    expect(admission.kind).toBe("begun");
    await expect(beginContainerOperation(context, "env-lifecycle", "start")).rejects.toThrow(
      "ContainerLifecycleError:operation-in-progress",
    );
  });

  test("refuses to mutate a record written by a newer schema", async () => {
    const { context, writes } = memoryLifecycleContext(
      [
        lifecycleEnvironment({
          containerLifecycle: { schemaVersion: 99, revision: 7 } as never,
        }),
      ],
      await dataDir(),
    );
    await expect(beginContainerOperation(context, "env-lifecycle", "stop")).rejects.toThrow(
      "ContainerLifecycleError:unsupported-format",
    );
    expect(writes).toHaveLength(0);
  });

  test("validates operation identities", () => {
    expect(() => parseContainerMutationIdentity({ operationId: "not-a-uuid" })).toThrow(
      "invalid-request",
    );
    expect(() =>
      parseContainerMutationIdentity({ operationId: createOperationId(Date.now() + 3_600_000) }),
    ).toThrow("from the future");
    expect(() => parseContainerMutationIdentity({ expectedRevision: -1 })).toThrow(
      "invalid-request",
    );
    expect(parseContainerMutationIdentity({ expectedRevision: 3 })).toEqual({
      expectedRevision: 3,
    });
  });
});

describe("restart recovery table", () => {
  async function interruptedCreate(
    dockerScript: string,
    overrides: Parameters<typeof lifecycleEnvironment>[0] = {},
  ) {
    const dir = await dataDir();
    const { context, environments } = memoryLifecycleContext(
      [lifecycleEnvironment(overrides)],
      dir,
    );
    // A previous process persisted "creating" and then died.
    const admission = await beginContainerOperation(context, "env-lifecycle", "create");
    if (admission.kind !== "begun") throw new Error("expected begin");
    const { operationId } = admission.operation;
    await advanceContainerOperation(context, "env-lifecycle", operationId, {
      phase: "creating",
      details: { generation: 1 },
    });
    // Simulate the process exit: the next process has no active operation.
    const { releaseActiveContainerOperation } =
      await import("../../../apps/backend/src/core/container-lifecycle-service");
    releaseActiveContainerOperation(context, operationId);
    let results: Awaited<ReturnType<typeof reconcileContainerOperations>> = [];
    await withDockerScript(dockerScript.replaceAll("{{OP}}", operationId), async () => {
      results = await reconcileContainerOperations(context);
    });
    return { environments, results, operationId, context, owner: dockerOwnerNamespace(dir) };
  }

  test("intent with no matching resource settles without creating anything", async () => {
    const { environments, results } = await interruptedCreate(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
[ "$1" = "ps" ] && exit 0
exit 1
`);
    expect(results).toEqual([{ environmentId: "env-lifecycle", result: "settled" }]);
    const stored = record(environments.get("env-lifecycle")!);
    expect(stored.operation).toBeUndefined();
    expect(stored.outcomes.at(-1)).toMatchObject({ status: "interrupted" });
    expect(environments.get("env-lifecycle")!.containerId).toBeNull();
  });

  test("a create that succeeded before the crash is adopted, not repeated", async () => {
    const { environments, results } = await interruptedCreate(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"orkestrator-operation-id={{OP}}"*) printf 'created-before-crash\\t1\\n' ;;
esac
exit 0
`);
    expect(results).toEqual([{ environmentId: "env-lifecycle", result: "adopted" }]);
    const environment = environments.get("env-lifecycle")!;
    expect(environment.containerId).toBe("created-before-crash");
    expect(record(environment).runtime).toMatchObject({
      containerId: "created-before-crash",
      runtimeGeneration: 1,
    });
  });

  test("several candidates need attention and block new writers", async () => {
    const { environments, results, context, operationId, owner } =
      await interruptedCreate(`#!/bin/sh
case "$*" in
  *"orkestrator-operation-id={{OP}}"*) printf 'candidate-a\\t1\\ncandidate-b\\t1\\n' ;;
esac
exit 0
`);
    expect(results).toEqual([{ environmentId: "env-lifecycle", result: "needs-attention" }]);
    expect(environments.get("env-lifecycle")!.containerId).toBeNull();
    await expect(beginContainerOperation(context, "env-lifecycle", "start")).rejects.toThrow(
      "ContainerLifecycleError:needs-attention",
    );
    // The user picks one; the other stays untouched for review.
    await withDockerScript(
      `#!/bin/sh
case "$*" in
  *"inspect"*) printf '%s\\trunning\\torkestrator-v2\\tcandidate-b\\n' '${owner}' ;;
  *"orkestrator-operation-id=${operationId}"*) printf 'candidate-a\\t1\\ncandidate-b\\t1\\n' ;;
esac
exit 0
`,
      async (log) => {
        await resolveNeedsAttentionOperation(context, "env-lifecycle", operationId, {
          kind: "adopt",
          containerId: "candidate-b",
        });
        expect(await log.read()).not.toContain("rm");
      },
    );
    expect(environments.get("env-lifecycle")!.containerId).toBe("candidate-b");
    expect(record(environments.get("env-lifecycle")!).operation).toBeUndefined();
  });

  test("an unreachable daemon keeps the operation for the next attempt", async () => {
    const { environments, results } = await interruptedCreate(`#!/bin/sh
printf 'Cannot connect to the Docker daemon\\n' >&2
exit 1
`);
    expect(results).toEqual([{ environmentId: "env-lifecycle", result: "unreachable" }]);
    expect(record(environments.get("env-lifecycle")!).operation).toMatchObject({
      status: "running",
      phase: "creating",
    });
  });

  test("a deletion tombstone owns the environment's resources", async () => {
    const { results } = await interruptedCreate(
      `#!/bin/sh
printf 'docker must not be called\\n' >&2
exit 1
`,
      { deletionRequestedAt: new Date().toISOString() },
    );
    expect(results).toEqual([{ environmentId: "env-lifecycle", result: "deletion-owned" }]);
  });

  test("a crash after the pointer was persisted keeps exactly one runtime", async () => {
    const dir = await dataDir();
    const { context, environments } = memoryLifecycleContext([lifecycleEnvironment()], dir);
    const admission = await beginContainerOperation(context, "env-lifecycle", "create");
    if (admission.kind !== "begun") throw new Error("expected begin");
    const { operationId } = admission.operation;
    await advanceContainerOperation(context, "env-lifecycle", operationId, {
      phase: "created",
      runtime: {
        containerId: "committed-runtime",
        runtimeGeneration: 1,
        owner: dockerOwnerNamespace(dir),
      },
      environment: { containerId: "committed-runtime" },
    });
    const { releaseActiveContainerOperation } =
      await import("../../../apps/backend/src/core/container-lifecycle-service");
    releaseActiveContainerOperation(context, operationId);
    await withDockerScript("#!/bin/sh\nexit 0\n", async () => {
      await reconcileContainerOperations(context);
    });
    const environment = environments.get("env-lifecycle")!;
    expect(environment.containerId).toBe("committed-runtime");
    expect(record(environment).runtime?.containerId).toBe("committed-runtime");
    expect(record(environment).operation).toBeUndefined();
  });
});

describe("container ownership", () => {
  test("labels decide ownership for an unassociated id in every profile", async () => {
    const dir = await dataDir();
    const owner = dockerOwnerNamespace(dir);
    const { context } = memoryLifecycleContext(
      [lifecycleEnvironment({ containerId: "legacy-assigned" })],
      dir,
    );
    await withDockerScript(
      `#!/bin/sh
case "$4" in
  mine) printf '%s\\trunning\\torkestrator-v2\\tmine-full\\n' '${owner}' ;;
  theirs) printf 'other-owner\\trunning\\torkestrator-v2\\ttheirs\\n' ;;
  legacy-assigned) printf '<no value>\\trunning\\torkestrator-v2\\tlegacy-assigned\\n' ;;
  legacy-stray) printf '<no value>\\trunning\\torkestrator-v2\\tlegacy-stray\\n' ;;
  alien) printf '<no value>\\trunning\\t<no value>\\talien\\n' ;;
  gone) printf 'Error: No such object: gone\\n' >&2; exit 1 ;;
  *) printf 'Cannot connect to the Docker daemon\\n' >&2; exit 1 ;;
esac
`,
      async () => {
        expect(await resolveContainerOwnership("mine", context)).toEqual({
          verdict: "owned",
          labelled: true,
        });
        expect(await resolveContainerOwnership("theirs", context)).toMatchObject({
          verdict: "foreign",
        });
        expect(await resolveContainerOwnership("legacy-assigned", context)).toEqual({
          verdict: "owned",
          labelled: false,
        });
        expect(await resolveContainerOwnership("legacy-stray", context)).toMatchObject({
          verdict: "foreign",
          reason: "unlabelled-unassigned",
        });
        expect(await resolveContainerOwnership("alien", context)).toMatchObject({
          verdict: "foreign",
          reason: "not-orkestrator",
        });
        expect(await resolveContainerOwnership("gone", context)).toEqual({ verdict: "missing" });
        expect(await resolveContainerOwnership("unreachable", context)).toMatchObject({
          verdict: "unknown",
        });
        // Strict profiles never adopt a pre-label container.
        context.strictDockerOwner = true;
        expect(await resolveContainerOwnership("legacy-assigned", context)).toMatchObject({
          verdict: "foreign",
        });
      },
    );
  });
});

describe("registry writer lease", () => {
  test("admits exactly one writer per data directory", async () => {
    const dir = await dataDir();
    const first = await openRegistryWriter(dir);
    const second = await openRegistryWriter(dir);
    expect(first.isHeld()).toBe(true);
    expect(second.isHeld()).toBe(false);
    expect(() => second.assertHeld()).toThrow("ContainerLifecycleError:operation-in-progress");
    // A different data directory is independently writable.
    const other = await openRegistryWriter(await dataDir());
    expect(other.isHeld()).toBe(true);
    await first.release();
    const third = await openRegistryWriter(dir);
    expect(third.isHeld()).toBe(true);
    await third.release();
    await other.release();
  });

  test("reclaims a lease whose holder stopped heartbeating", async () => {
    const dir = await dataDir();
    await fs.writeFile(
      path.join(dir, REGISTRY_WRITER_LEASE_FILE),
      JSON.stringify({ token: "dead", pid: 1, acquiredAt: "2020-01-01T00:00:00.000Z" }),
    );
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(path.join(dir, REGISTRY_WRITER_LEASE_FILE), old, old);
    const lease = await RegistryWriterLease.acquire(dir, { staleMs: 30_000 });
    expect(lease.isHeld()).toBe(true);
    await lease.release();
  });

  test("a newer schema marker makes an older writer read-only", async () => {
    const dir = await dataDir();
    await fs.writeFile(
      path.join(dir, REGISTRY_SCHEMA_MARKER_FILE),
      JSON.stringify({ schemaVersion: 5, minimumWriterVersion: 5, updatedAt: "" }),
    );
    expect((await checkRegistrySchemaMarker(dir)).compatible).toBe(false);
    const writer = await openRegistryWriter(dir);
    expect(writer.isHeld()).toBe(false);
    expect(() => writer.assertHeld()).toThrow("ContainerLifecycleError:unsupported-format");
    // A corrupt marker is not permission to write either.
    await fs.writeFile(path.join(dir, REGISTRY_SCHEMA_MARKER_FILE), "{not json");
    expect((await checkRegistrySchemaMarker(dir)).compatible).toBe(false);
  });

  test("lifecycle writes require the lease when one is configured", async () => {
    const dir = await dataDir();
    const { context } = memoryLifecycleContext([lifecycleEnvironment()], dir);
    const holder = await openRegistryWriter(dir);
    context.registryWriterLease = await openRegistryWriter(dir);
    await expect(beginContainerOperation(context, "env-lifecycle", "stop")).rejects.toThrow(
      "operation-in-progress",
    );
    await holder.release();
    await expect(
      completeContainerOperation(context, "env-lifecycle", "missing-op", "failed"),
    ).rejects.toThrow();
  });
});

describe("runtime generation binding", () => {
  test("a handle for a replaced runtime conflicts instead of connecting", async () => {
    const dir = await dataDir();
    const { assertRuntimeGeneration } =
      await import("../../../apps/backend/src/core/container-lifecycle-service");
    const { context } = memoryLifecycleContext(
      [
        lifecycleEnvironment({
          containerId: "runtime-2",
          containerLifecycle: {
            schemaVersion: 1,
            revision: 4,
            lastRuntimeGeneration: 2,
            runtime: { containerId: "runtime-2", runtimeGeneration: 2, owner: "x" },
            storage: { format: "legacy-layer", workspaceGeneration: 1 },
            outcomes: [],
          },
        }),
      ],
      dir,
    );
    await expect(
      assertRuntimeGeneration(
        { environmentId: "env-lifecycle", expectedRuntimeGeneration: 2 },
        context,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertRuntimeGeneration({ containerId: "runtime-2", expectedRuntimeGeneration: 1 }, context),
    ).rejects.toThrow("ContainerLifecycleError:runtime-changed");
    await expect(
      assertRuntimeGeneration(
        { environmentId: "env-lifecycle", expectedRuntimeGeneration: "2" },
        context,
      ),
    ).rejects.toThrow("invalid-request");
  });
});
