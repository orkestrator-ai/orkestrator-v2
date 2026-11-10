import { describe, expect, test } from "bun:test";
import { parseContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { isDockerCopyRemountRefused } from "./docker-cli-errors.js";
import {
  COPY_PROBE_ABSENT_PATH,
  classifyDockerCopyFailure,
  dockerCopyRefusedNow,
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
