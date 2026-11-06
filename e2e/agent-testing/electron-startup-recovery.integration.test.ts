import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readlinkSync } from "node:fs";

// This qualification needs Linux network namespaces, not host-wide Docker churn.
test.skipIf(process.platform !== "linux")(
  "real Chromium console and reload recover a network-changed module import",
  async () => {
    const child = Bun.spawn(
      [
        "unshare",
        "--user",
        "--map-root-user",
        "--net",
        process.execPath,
        fileURLToPath(new URL("./electron-startup-recovery-live-fixture.ts", import.meta.url)),
        readlinkSync("/proc/self/ns/net"),
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 80_000 },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const observation = JSON.parse(stdout);
    expect(observation).toMatchObject({ networkChanged: true, reloads: 1 });
    expect(observation.moduleRequests).toBeGreaterThanOrEqual(2);
  },
  90_000,
);
