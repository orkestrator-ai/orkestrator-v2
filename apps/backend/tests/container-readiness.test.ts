import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  emptyContainerLifecycle,
  setupCompletionIsCurrent,
} from "@orkestrator/protocol/container-lifecycle";
import {
  BOOT_STATUS_PATH,
  ContainerInitializationError,
  assertContainerNotDraining,
  bootProbeScript,
  drainContainerProcesses,
  ensureCurrentBootReady,
  parseBootProbe,
  parseExitedBootRecord,
  waitForContainerBoot,
  withEnvironmentDraining,
} from "../src/core/container-readiness";
import { tempDir, withDockerScript } from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** What `docker cp <container>:/run/orkestrator/boot-status.json -` streams. */
async function bootRecordTar(content: string): Promise<string> {
  const dir = await tempDir("ork-boot-record-tar-");
  cleanup.push(dir);
  await fs.writeFile(path.join(dir, "boot-status.json"), content);
  const tarPath = path.join(dir, "out.tar");
  // One-block records, as Docker writes: GNU tar's default 20-block record
  // pads the archive to 10 KiB, past the bounded copy-out's limit.
  const result = spawnSync(
    "tar",
    ["--format=ustar", "-b", "1", "-cf", tarPath, "-C", dir, "boot-status.json"],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  expect(result.status).toBe(0);
  return tarPath;
}

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

describe("an exited container's final boot record", () => {
  const failed = (fields: Record<string, unknown> = {}) =>
    record({
      phase: "failed",
      failureCode: "firewall-failed",
      updatedAt: "2026-09-27T10:00:05Z",
      ...fields,
    });

  test("names the failure only when this run wrote it", () => {
    const startedAt = "2026-09-27T10:00:04.123456789Z";
    expect(parseExitedBootRecord(`${failed()}\n`, startedAt)).toBe("firewall-failed");
    // Written in the same second the run started.
    expect(parseExitedBootRecord(failed(), "2026-09-27T10:00:05.900Z")).toBe("firewall-failed");
    // Left by an earlier start: the entrypoint of this one died before writing.
    expect(parseExitedBootRecord(failed(), "2026-09-27T10:00:06.000Z")).toBeNull();
    expect(parseExitedBootRecord(failed(), "0001-01-01T00:00:00Z")).toBeNull();
    expect(parseExitedBootRecord(failed(), "")).toBeNull();
    // Only a failed boot names a failure, and only with a well-formed code.
    expect(parseExitedBootRecord(failed({ phase: "ready" }), startedAt)).toBeNull();
    expect(parseExitedBootRecord(failed({ failureCode: "rm -rf /" }), startedAt)).toBeNull();
    expect(parseExitedBootRecord(failed({ failureCode: null }), startedAt)).toBeNull();
    expect(parseExitedBootRecord(failed({ version: 2 }), startedAt)).toBeNull();
    expect(parseExitedBootRecord(failed({ updatedAt: "yesterday" }), startedAt)).toBeNull();
    expect(parseExitedBootRecord(failed().slice(0, 40), startedAt)).toBeNull();
  });

  test("a fail-closed boot that exited reports its own code, not container-exited", async () => {
    const tar = await bootRecordTar(
      `${record({ phase: "failed", failureCode: "firewall-missing", updatedAt: "2026-09-27T10:00:05Z" })}\n`,
    );
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  exec) printf 'Error response from daemon: container is not running\\n' >&2; exit 1 ;;
  inspect) printf 'false 2026-09-27T10:00:04.5Z\\n' ;;
  cp) cat '${tar}' ;;
esac
`,
      async (log) => {
        const failure = await waitForContainerBoot("container-1", { pollMs: 1 }).catch((e) => e);
        expect((failure as ContainerInitializationError).failureCode).toBe("firewall-missing");
        expect(String(failure)).toContain("firewall-missing");
        expect(await log.read()).toContain("cp container-1:/run/orkestrator/boot-status.json -");
      },
    );
  });

  test("an unreadable or earlier record still reads as container-exited", async () => {
    const stale = await bootRecordTar(
      `${record({ phase: "failed", failureCode: "firewall-failed", updatedAt: "2026-09-27T09:00:00Z" })}\n`,
    );
    for (const cp of [
      `cat '${stale}'`,
      "printf 'Error response from daemon: Could not find the file /run/orkestrator/boot-status.json in container container-1\\n' >&2; exit 1",
      "printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\\n' >&2; exit 1",
    ]) {
      await withDockerScript(
        `#!/bin/sh
case "$1" in
  exec) exit 1 ;;
  inspect) printf 'false 2026-09-27T10:00:04.5Z\\n' ;;
  cp) ${cp} ;;
esac
`,
        async () => {
          const failure = await waitForContainerBoot("container-1", { pollMs: 1 }).catch((e) => e);
          expect((failure as ContainerInitializationError).failureCode).toBe("container-exited");
        },
      );
    }
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

/**
 * A container's /run/orkestrator and /proc/1/stat, on the host: the probe
 * scripts run under a real `sh` with their paths moved here.
 */
async function fakeBootRoot(pid1Start = "5000") {
  const root = await tempDir("ork-boot-probe-");
  cleanup.push(root);
  const runDir = path.join(root, "run");
  await fs.mkdir(runDir);
  const stat = path.join(root, "stat");
  // Field 22 of /proc/<pid>/stat is the start time.
  await fs.writeFile(stat, `1 (init) S ${"0 ".repeat(18)}${pid1Start} 0\n`);
  const statusFile = path.join(runDir, path.basename(BOOT_STATUS_PATH));
  return {
    runDir,
    statusFile,
    remap: (script: string) =>
      script.replaceAll(path.dirname(BOOT_STATUS_PATH), runDir).replaceAll("/proc/1/stat", stat),
  };
}

/** Replaces a file the way the entrypoint does: write aside, then rename. */
async function writeAtomically(file: string, content: string): Promise<void> {
  await fs.writeFile(`${file}.tmp`, content);
  await fs.rename(`${file}.tmp`, file);
}

async function runSh(script: string): Promise<{ stdout: string; ms: number }> {
  const started = performance.now();
  const child = Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(child.stdout).text();
  await child.exited;
  return { stdout, ms: performance.now() - started };
}

describe("bounded in-container boot wait", () => {
  test("without a window the probe is one read", () => {
    expect(bootProbeScript()).not.toContain("while");
    expect(bootProbeScript(0)).toBe(bootProbeScript());
  });

  test("returns as soon as the current boot is ready, and prints what one read would", async () => {
    const root = await fakeBootRoot();
    await fs.writeFile(root.statusFile, `${record({})}\n`);
    const waited = await runSh(root.remap(bootProbeScript(2_000)));
    const single = await runSh(root.remap(bootProbeScript()));
    expect(waited.stdout).toBe(single.stdout);
    expect(parseBootProbe(waited.stdout)).toMatchObject({ kind: "current", phase: "ready" });
    expect(waited.ms).toBeLessThan(1_000);
  });

  test("sees a boot that finishes during the window", async () => {
    const root = await fakeBootRoot();
    await fs.writeFile(root.statusFile, `${record({ phase: "initializing" })}\n`);
    setTimeout(() => {
      void writeAtomically(
        root.statusFile,
        `${record({ phase: "failed", failureCode: "dns-failed" })}\n`,
      );
    }, 150);
    const waited = await runSh(root.remap(bootProbeScript(2_000)));
    expect(parseBootProbe(waited.stdout)).toMatchObject({
      phase: "failed",
      failureCode: "dns-failed",
    });
    expect(waited.ms).toBeLessThan(1_500);
  });

  test("an earlier boot's ready record does not end the wait", async () => {
    const root = await fakeBootRoot();
    await fs.writeFile(root.statusFile, `${record({ pid1Start: "4000" })}\n`);
    const waited = await runSh(root.remap(bootProbeScript(300)));
    expect(parseBootProbe(waited.stdout)).toEqual({ kind: "pending" });
    expect(waited.ms).toBeGreaterThanOrEqual(250);
  });

  test("a missing status directory answers at once", async () => {
    const root = await fakeBootRoot();
    await fs.rm(root.runDir, { recursive: true });
    const waited = await runSh(root.remap(bootProbeScript(2_000)));
    expect(parseBootProbe(waited.stdout)).toEqual({ kind: "legacy" });
    expect(waited.ms).toBeLessThan(1_000);
  });

  test("a wait costs one exec per window, not one per poll", async () => {
    const root = await fakeBootRoot();
    await fs.writeFile(root.statusFile, `${record({ phase: "network-ready" })}\n`);
    setTimeout(() => void writeAtomically(root.statusFile, `${record({})}\n`), 300);
    // The fake daemon runs the probe it is handed against the fake root.
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$1" >> "$FAKE_DOCKER_LOG"
[ "$1" = exec ] || exit 0
script=$(printf '%s' "$5" | sed -e 's#${path.dirname(BOOT_STATUS_PATH)}#${root.runDir}#g' -e 's#/proc/1/stat#${path.join(path.dirname(root.runDir), "stat")}#g')
exec sh -c "$script"
`,
      async (log) => {
        expect(await waitForContainerBoot("container-1")).toBe(
          "0b0b0b0b-1111-2222-3333-444444444444",
        );
        expect((await log.read()).trim().split("\n")).toEqual(["exec"]);
      },
    );
  });

  test("a probe that comes back early without a final state is spaced, not repeated at once", async () => {
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$1" >> "$FAKE_DOCKER_LOG"
[ "$1" = exec ] && printf 'unexpected\\n5000\\n'
exit 0
`,
      async (log) => {
        const failure = await waitForContainerBoot("container-1", {
          pollMs: 100,
          timeoutMs: 450,
        }).catch((e) => e);
        expect((failure as ContainerInitializationError).reason).toBe("timed-out");
        const execs = (await log.read()).trim().split("\n").length;
        expect(execs).toBeGreaterThanOrEqual(2);
        expect(execs).toBeLessThanOrEqual(6);
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
