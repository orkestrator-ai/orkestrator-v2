import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { existsSync, readlinkSync } from "node:fs";
import path from "node:path";

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

const ELECTRON = path.resolve(import.meta.dirname, "../../apps/desktop/node_modules/.bin/electron");

// The same churn against a real headless Electron window, watched as the
// Electron specs watch theirs (to-do 7062 task 2). No display, no Docker.
test.skipIf(process.platform !== "linux" || !existsSync(ELECTRON))(
  "a real headless Electron window recovers a network-changed startup through watchElectronStartup",
  async () => {
    const child = Bun.spawn(
      [
        "unshare",
        "--user",
        "--map-root-user",
        "--net",
        process.execPath,
        fileURLToPath(new URL("./electron-startup-recovery-electron-fixture.ts", import.meta.url)),
        readlinkSync("/proc/self/ns/net"),
        ELECTRON,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 110_000 },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // Electron writes its own diagnostics to stderr; only the exit status decides.
    expect({ status, stderr: status === 0 ? "" : stderr.slice(-2_000) }).toEqual({
      status: 0,
      stderr: "",
    });
    const lines = stdout.trim().split("\n");
    const observation = JSON.parse(lines.at(-1)!);
    expect(observation).toMatchObject({ networkChanged: true, reloads: 1 });
    expect(observation.moduleRequests).toBeGreaterThanOrEqual(2);
    expect(lines).toContain(
      "[startup-recovery] renderer start reloaded 1x after net::ERR_NETWORK_CHANGED",
    );
  },
  120_000,
);
