import { describe, expect, test } from "bun:test";
import { parseContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { isDockerCopyRemountRefused, isDockerCopySnapshotBusy } from "./docker-cli-errors.js";
import {
  COPY_BUSY_RETRY_DELAYS_MS,
  COPY_PROBE_ABSENT_PATH,
  classifyDockerCopyFailure,
  copyIntoContainer,
  dockerCopyRefusedNow,
  isDockerCopyBusyError,
  isDockerCopyRefusedError,
} from "./docker-copy-refusal.js";
import { CommandFailedError, type runCommand } from "./shell.js";

// Captured from a disposable rootless Engine 29.9.2 (RootlessKit 3.3.0,
// kernel 7.1.8) on 2026-11-10: a container with a read-only bind from a
// mktemp directory under the tmpfs /tmp (rw,nosuid,nodev). Data root redacted.
const REMOUNT_REFUSED =
  "Error response from daemon: remount-ro <data-root>/rootfs/overlayfs/98ba1cdea9a0/ro, flags: 0x1021: operation not permitted";
const OVERLAY2_REMOUNT_REFUSED =
  "Error response from daemon: remount-ro <data-root>/overlay2/05fb2c3ef710/merged/ro, flags: 0x1021: operation not permitted";
// What the CLI prints instead for a copy into a directory on that container.
const STREAM_INTO_DIRECTORY = 'destination "98ba1cdea9a0:/" must be a directory';
const INTO_TRAILING_SLASH = "no such directory";
const PROBE_ABSENT = `Error response from daemon: Could not find the file ${COPY_PROBE_ABSENT_PATH} in container 0ff5e7891eb2`;

const failed = (stderr: string, extra: { timedOut?: boolean } = {}) =>
  new CommandFailedError(`Command failed: docker cp\n${stderr}`, { stderr, ...extra });

type Call = string[];
function scripted(probe: Error | null) {
  const calls: Call[] = [];
  const run = (async (_command: string, args: string[] = []) => {
    calls.push(args);
    if (probe) throw probe;
    return { stdout: "", stderr: "" };
  }) as unknown as typeof runCommand;
  return { run, calls };
}

describe("docker cp remount refusal", () => {
  test("recognises the daemon's refusal under either image store, and nothing else", () => {
    expect(isDockerCopyRemountRefused(REMOUNT_REFUSED)).toBe(true);
    expect(isDockerCopyRemountRefused(OVERLAY2_REMOUNT_REFUSED)).toBe(true);
    expect(isDockerCopyRemountRefused(STREAM_INTO_DIRECTORY)).toBe(false);
    expect(isDockerCopyRemountRefused(PROBE_ABSENT)).toBe(false);
    expect(isDockerCopyRemountRefused("operation not permitted")).toBe(false);
  });

  test("a refusal in the copy's own message is typed without a probe", async () => {
    const { run, calls } = scripted(null);
    const error = await classifyDockerCopyFailure("c1", failed(REMOUNT_REFUSED), "x", run);
    expect(isDockerCopyRefusedError(error)).toBe(true);
    expect(parseContainerLifecycleError(error)?.code).toBe("unsupported-topology");
    expect(String(error)).toContain("nosuid or nodev");
    expect(calls).toEqual([]);
  });

  for (const hidden of [STREAM_INTO_DIRECTORY, INTO_TRAILING_SLASH]) {
    test(`a CLI message that hides it is resolved by asking the daemon: ${hidden}`, async () => {
      const refused = scripted(failed(REMOUNT_REFUSED));
      const error = await classifyDockerCopyFailure(
        "c1",
        failed(hidden),
        "the project seed files into the container",
        refused.run,
      );
      expect(isDockerCopyRefusedError(error)).toBe(true);
      expect(String(error)).toContain("the project seed files into the container");
      expect(refused.calls).toEqual([["cp", `c1:${COPY_PROBE_ABSENT_PATH}`, "-"]]);

      // A daemon that can mount the container answers "could not find".
      const original = failed(hidden);
      const healthy = scripted(failed(PROBE_ABSENT));
      expect(await classifyDockerCopyFailure("c1", original, "x", healthy.run)).toBe(original);
    });
  }

  test("a timeout or an outage is returned unchanged and never probed", async () => {
    const { run, calls } = scripted(failed(REMOUNT_REFUSED));
    const timedOut = failed("", { timedOut: true });
    expect(await classifyDockerCopyFailure("c1", timedOut, "x", run)).toBe(timedOut);
    const outage = failed("Cannot connect to the Docker daemon at unix:///x. Is it running?");
    expect(await classifyDockerCopyFailure("c1", outage, "x", run)).toBe(outage);
    expect(calls).toEqual([]);
  });

  test("the probe reads only the refusal as evidence", async () => {
    expect(await dockerCopyRefusedNow("c1", scripted(failed(REMOUNT_REFUSED)).run)).toBe(true);
    expect(await dockerCopyRefusedNow("c1", scripted(failed(PROBE_ABSENT)).run)).toBe(false);
    expect(await dockerCopyRefusedNow("c1", scripted(null).run)).toBe(false);
    expect(await dockerCopyRefusedNow("c1", scripted(new Error("spawn failed")).run)).toBe(false);
  });
});

// Captured on 2026-11-09 from a disposable rootless Engine 29.9.2 (containerd
// image store, kernel 7.2.15): `docker cp` into a created container of the
// 78-layer environment image. Data root and layer list redacted.
const SNAPSHOT_BUSY =
  'Error response from daemon: failed to mount <data-root>/rootfs/overlayfs/4f0c2a: mount source: "overlay", target: "<data-root>/rootfs/overlayfs/4f0c2a", fstype: overlay, flags: 0, data: "workdir=<w>,upperdir=<u>,userxattr,lowerdir=<l>", err: device or resource busy';

describe("docker cp into a container whose filesystem is busy (to-do 7549 task 2)", () => {
  function sequenced(results: Array<Error | null>) {
    const calls: string[][] = [];
    const run = (async (_command: string, args: string[] = []) => {
      calls.push(args);
      const next = results.shift() ?? null;
      if (next) throw next;
      return { stdout: "", stderr: "" };
    }) as unknown as typeof runCommand;
    return { run, calls };
  }

  test("recognises only the daemon's busy mount", () => {
    expect(isDockerCopySnapshotBusy(SNAPSHOT_BUSY)).toBe(true);
    expect(isDockerCopySnapshotBusy("device or resource busy")).toBe(false);
    expect(isDockerCopySnapshotBusy(REMOUNT_REFUSED)).toBe(false);
  });

  test("a busy copy is retried after the pauses and then delivers", async () => {
    const fixture = sequenced([failed(SNAPSHOT_BUSY), failed(SNAPSHOT_BUSY), null]);
    const pauses: number[] = [];
    const logs = captureLogs();
    await copyIntoContainer("c1", ["cp", "-a", "-", "c1:/"], { timeoutMs: 1 }, "x", {
      run: fixture.run,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    }).finally(() => logs.restore());
    expect(fixture.calls).toEqual(Array.from({ length: 3 }, () => ["cp", "-a", "-", "c1:/"]));
    expect(pauses).toEqual([...COPY_BUSY_RETRY_DELAYS_MS]);
    expect(logs.records().map((record) => record.event)).toEqual([
      "copy-in.snapshot-busy-retrying",
      "copy-in.snapshot-busy-retrying",
      "copy-in.snapshot-busy-recovered",
    ]);
  });

  test("a copy still busy after every retry is a typed error naming what was copied", async () => {
    const fixture = sequenced(
      Array.from({ length: COPY_BUSY_RETRY_DELAYS_MS.length + 1 }, () => failed(SNAPSHOT_BUSY)),
    );
    const error = await copyIntoContainer(
      "c1",
      ["cp", "-a", "-", "c1:/"],
      undefined,
      "the project seed files into the container",
      { run: fixture.run, sleep: async () => undefined },
    ).catch((caught: unknown) => caught);
    expect(isDockerCopyBusyError(error)).toBe(true);
    expect(isDockerCopyRefusedError(error)).toBe(false);
    expect(parseContainerLifecycleError(error)?.code).toBe("unsupported-topology");
    expect(String(error)).toContain("the project seed files into the container");
    expect(String(error)).toContain("device or resource busy");
    // No probe: the daemon said why.
    expect(fixture.calls).toHaveLength(COPY_BUSY_RETRY_DELAYS_MS.length + 1);
  });

  test("any other failure is classified at once, never retried", async () => {
    const fixture = sequenced([failed(REMOUNT_REFUSED)]);
    const pauses: number[] = [];
    const error = await copyIntoContainer("c1", ["cp", "f", "c1:/x"], undefined, "x", {
      run: fixture.run,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    }).catch((caught: unknown) => caught);
    expect(isDockerCopyRefusedError(error)).toBe(true);
    expect(pauses).toEqual([]);
    expect(fixture.calls).toHaveLength(1);
  });
});
