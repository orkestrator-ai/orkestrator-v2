/**
 * The bounded in-container boot wait, run for real: the generated probe
 * scripts poll a fake boot root under `sh`, and the fake `docker exec` runs
 * them, with the waits timed on the wall clock. That makes the file depend on
 * how busy the host is, so it is in the slow tier; the rest of the readiness
 * logic is in container-readiness.test.ts.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import {
  BOOT_STATUS_PATH,
  ContainerInitializationError,
  bootProbeScript,
  parseBootProbe,
  waitForContainerBoot,
} from "../src/core/container-readiness";
import { tempDir, withDockerScript } from "./container-lifecycle-fixtures";

// Each case starts real `sh` probes; the wall-clock bounds the tests assert
// are their own, this only keeps Bun from killing a probe on a loaded host.
setDefaultTimeout(30_000);

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

  test("a pending shell probe is clipped to the remaining overall deadline", async () => {
    const root = await fakeBootRoot();
    await fs.writeFile(root.statusFile, `${record({ phase: "initializing" })}\n`);
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$1" >> "$FAKE_DOCKER_LOG"
[ "$1" = exec ] || exit 1
exec sh -c "$(printf '%s' "$5" | sed -e 's#${path.dirname(BOOT_STATUS_PATH)}#${root.runDir}#g' -e 's#/proc/1/stat#${path.join(path.dirname(root.runDir), "stat")}#g')"
`,
      async (log) => {
        const started = performance.now();
        const failure = await waitForContainerBoot("container-1", {
          timeoutMs: 200,
          pollMs: 1,
        }).catch((error) => error);
        const elapsed = performance.now() - started;
        expect(failure).toBeInstanceOf(ContainerInitializationError);
        expect(failure.reason).toBe("timed-out");
        // A one-shot fake would finish too soon; an unclipped 2 s window
        // would finish too late. The generated wait must actually execute.
        expect(elapsed).toBeGreaterThanOrEqual(150);
        expect(elapsed).toBeLessThan(1_500);
        expect((await log.read()).trim().split("\n")).toEqual(["exec"]);
      },
    );
  });

  test("renews an expired shell wait window and accepts readiness in the next exec", async () => {
    const root = await fakeBootRoot();
    await fs.writeFile(root.statusFile, `${record({ phase: "network-ready" })}\n`);
    await withDockerScript(
      `#!/bin/sh
[ "$1" = exec ] || exit 1
# Publish readiness only when the backend renews the first expired window.
if [ -s "$FAKE_DOCKER_LOG" ]; then
  printf '%s\\n' '${record({})}' > '${root.statusFile}.tmp'
  mv '${root.statusFile}.tmp' '${root.statusFile}'
fi
printf '%s\\n' "$1" >> "$FAKE_DOCKER_LOG"
exec sh -c "$(printf '%s' "$5" | sed -e 's#${path.dirname(BOOT_STATUS_PATH)}#${root.runDir}#g' -e 's#/proc/1/stat#${path.join(path.dirname(root.runDir), "stat")}#g')"
`,
      async (log) => {
        const started = performance.now();
        expect(
          await waitForContainerBoot("container-1", {
            windowMs: 200,
            timeoutMs: 2_000,
            pollMs: 1,
          }),
        ).toBe("0b0b0b0b-1111-2222-3333-444444444444");
        expect(performance.now() - started).toBeGreaterThanOrEqual(200);
        expect((await log.read()).trim().split("\n")).toEqual(["exec", "exec"]);
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
        const pollMs = 100;
        const timeoutMs = 450;
        const probes = () =>
          existsSync(log.path)
            ? readFileSync(log.path, "utf8")
                .split("\n")
                .filter((command) => command === "exec").length
            : 0;
        const startedAt = Date.now();
        const failure = await waitForContainerBoot("container-1", {
          pollMs,
          timeoutMs,
          // Spawning the fake docker can use the whole budget on a loaded host,
          // so the deadline holds off until a second probe has had its turn.
          now: () => (probes() < 2 ? Math.min(Date.now(), startedAt + timeoutMs - 1) : Date.now()),
        }).catch((e) => e);
        const elapsedMs = Date.now() - startedAt;
        expect((failure as ContainerInitializationError).reason).toBe("timed-out");
        const execs = probes();
        expect(execs).toBeGreaterThanOrEqual(2);
        // Probe starts are at least pollMs apart, however long the wait took.
        expect(execs).toBeLessThanOrEqual(Math.ceil(elapsedMs / pollMs) + 1);
      },
    );
  });
});
