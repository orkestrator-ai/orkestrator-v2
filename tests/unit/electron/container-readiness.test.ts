import { describe, expect, test } from "bun:test";
import {
  emptyContainerLifecycle,
  setupCompletionIsCurrent,
} from "@orkestrator/protocol/container-lifecycle";
import {
  ContainerInitializationError,
  assertContainerNotDraining,
  drainContainerProcesses,
  ensureCurrentBootReady,
  parseBootProbe,
  waitForContainerBoot,
  withEnvironmentDraining,
} from "../../../apps/backend/src/core/container-readiness";
import { withDockerScript } from "./container-lifecycle-fixtures";

const record = (fields: Record<string, unknown>) =>
  JSON.stringify({
    version: 1,
    bootId: "0b0b0b0b-1111-2222-3333-444444444444",
    pid1Start: "5000",
    phase: "ready",
    failureCode: null,
    updatedAt: "2026-09-27T00:00:00Z",
    ...fields,
  });

describe("boot status probe", () => {
  test("accepts only a record written by the current PID 1", () => {
    expect(parseBootProbe(`${record({})}\n5000\n`)).toEqual({
      kind: "current",
      bootId: "0b0b0b0b-1111-2222-3333-444444444444",
      phase: "ready",
      failureCode: null,
    });
    // Left by an earlier start of the same container: not evidence of anything.
    expect(parseBootProbe(`${record({})}\n9000\n`)).toEqual({ kind: "pending" });
    expect(parseBootProbe("ORKESTRATOR_NO_BOOT_STATUS\n9000\n")).toEqual({ kind: "pending" });
    expect(parseBootProbe(`${record({}).slice(0, 30)}\n5000\n`)).toEqual({ kind: "pending" });
    expect(
      parseBootProbe(`${record({ phase: "failed", failureCode: "firewall-failed" })}\n5000\n`),
    ).toEqual({
      kind: "current",
      bootId: "0b0b0b0b-1111-2222-3333-444444444444",
      phase: "failed",
      failureCode: "firewall-failed",
    });
    // Arbitrary text in a failure code is dropped, not echoed.
    expect(
      parseBootProbe(`${record({ phase: "failed", failureCode: "rm -rf /" })}\n5000\n`),
    ).toMatchObject({
      failureCode: null,
    });
    expect(parseBootProbe("ORKESTRATOR_NO_BOOT_DIR\n1\n")).toEqual({ kind: "legacy" });
    expect(parseBootProbe("\n1\n")).toEqual({ kind: "pending" });
    expect(parseBootProbe("unexpected\n1\n")).toEqual({ kind: "pending" });
  });
});

describe("generation-bound readiness", () => {
  test("waits past a stale record for the current boot to become ready", async () => {
    await withDockerScript(
      `#!/bin/sh
count_file="$FAKE_DOCKER_LOG.count"
count=$(cat "$count_file" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$count_file"
if [ "$1" = "exec" ]; then
  if [ "$count" -lt 3 ]; then
    printf '%s\\n5000\\n' '${record({ pid1Start: "4000" })}'
  else
    printf '%s\\n5000\\n' '${record({ bootId: "12345678-aaaa-bbbb-cccc-dddddddddddd" })}'
  fi
fi
`,
      async () => {
        expect(await waitForContainerBoot("container-1", { pollMs: 1 })).toBe(
          "12345678-aaaa-bbbb-cccc-dddddddddddd",
        );
      },
    );
  });

  test("a failed boot, an exited container and a timeout are typed and retryable", async () => {
    await withDockerScript(
      `#!/bin/sh
[ "$1" = "exec" ] && printf '%s\\n5000\\n' '${record({ phase: "failed", failureCode: "firewall-failed" })}'
exit 0
`,
      async () => {
        const failure = await waitForContainerBoot("container-1", { pollMs: 1 }).catch((e) => e);
        expect(failure).toBeInstanceOf(ContainerInitializationError);
        expect(String(failure)).toContain("ContainerLifecycleError:not-ready");
        expect(String(failure)).toContain("firewall-failed");
      },
    );
    await withDockerScript(
      `#!/bin/sh
case "$1" in
  exec) printf 'Error response from daemon: container is not running\\n' >&2; exit 1 ;;
  inspect) printf 'false\\n' ;;
esac
`,
      async () => {
        const failure = await waitForContainerBoot("container-1", { pollMs: 1 }).catch((e) => e);
        expect((failure as ContainerInitializationError).failureCode).toBe("container-exited");
      },
    );
    await withDockerScript(
      `#!/bin/sh
[ "$1" = "exec" ] && printf 'ORKESTRATOR_NO_BOOT_STATUS\\n5000\\n'
exit 0
`,
      async () => {
        const failure = await waitForContainerBoot("container-1", {
          pollMs: 1,
          timeoutMs: 20,
        }).catch((e) => e);
        expect((failure as ContainerInitializationError).reason).toBe("timed-out");
      },
    );
  });

  test("a legacy image bypasses readiness, while an unanswered probe remains gated", async () => {
    await withDockerScript(
      `#!/bin/sh
[ "$1" = "exec" ] && printf 'ORKESTRATOR_NO_BOOT_DIR\\n1\\n'
exit 0
`,
      async () => {
        expect(await ensureCurrentBootReady("container-1")).toBeNull();
      },
    );
    await withDockerScript(
      '#!/bin/sh\n[ "$1" = inspect ] && printf \'true\\n\'\n[ "$1" = exec ] && exit 9\n',
      async () => {
        await expect(
          ensureCurrentBootReady("container-1", { timeoutMs: 20 }),
        ).rejects.toBeInstanceOf(ContainerInitializationError);
      },
    );
  });

  test("a capable image with no boot directory is still gated", async () => {
    await withDockerScript(
      `#!/bin/sh
case "$1:$2" in
  exec:*) printf 'ORKESTRATOR_NO_BOOT_DIR\\n5000\\n' ;;
  inspect:-f) case "$*" in *capabilities*) printf 'boot-status=1,staged-inputs=1\\n' ;; *) printf 'true\\n' ;; esac ;;
esac
`,
      async () => {
        await expect(
          ensureCurrentBootReady("container-1", { timeoutMs: 20 }),
        ).rejects.toBeInstanceOf(ContainerInitializationError);
      },
    );
  });
});

describe("draining", () => {
  test("fences new work only while the drain runs", async () => {
    let fenced = false;
    await withEnvironmentDraining("env-1", "container-1", async () => {
      try {
        assertContainerNotDraining("container-1");
      } catch (error) {
        fenced = String(error).includes("operation-in-progress");
      }
    });
    expect(fenced).toBe(true);
    expect(() => assertContainerNotDraining("container-1")).not.toThrow();
  });

  test("reports what the drain signalled and what remained", async () => {
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
printf 'ORKESTRATOR_DRAIN signalled=4 remaining=1\\n'
`,
      async (log) => {
        expect(await drainContainerProcesses("container-1", 5)).toEqual({
          signalled: 4,
          remaining: 1,
        });
        expect(await log.read()).toContain(
          "exec --user root container-1 /usr/local/bin/orkestrator-drain.sh 5",
        );
      },
    );
  });
});

describe("setup completion currency", () => {
  test("a legacy-layer completion does not survive a runtime replacement", () => {
    const record = {
      ...emptyContainerLifecycle(),
      lastRuntimeGeneration: 2,
      runtime: { containerId: "c2", runtimeGeneration: 2, owner: "o" },
      setup: { runtimeGeneration: 1, workspaceGeneration: 1, completedAt: "" },
    };
    expect(setupCompletionIsCurrent(record)).toBe(false);
    expect(
      setupCompletionIsCurrent({ ...record, setup: { ...record.setup, runtimeGeneration: 2 } }),
    ).toBe(true);
    // Persistent storage keeps project setup across runtime replacement until
    // the workspace itself is reset.
    const persistent = {
      ...record,
      storage: { format: "volume-v1" as const, workspaceGeneration: 3 },
      setup: { runtimeGeneration: 1, workspaceGeneration: 3, completedAt: "" },
    };
    expect(setupCompletionIsCurrent(persistent)).toBe(true);
    expect(
      setupCompletionIsCurrent({
        ...persistent,
        storage: { ...persistent.storage, workspaceGeneration: 4 },
      }),
    ).toBe(false);
    // No record: the generation-less flag is trusted as before.
    expect(setupCompletionIsCurrent(emptyContainerLifecycle())).toBe(true);
  });
});
