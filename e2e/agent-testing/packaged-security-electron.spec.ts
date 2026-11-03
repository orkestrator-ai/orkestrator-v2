/** Direct launch of the shipping (inspect-off) binary; never _electron.launch. */
import { expect, test } from "./electron-fixtures";
import { chromium, type Browser } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { ownProcessGroup, stopProcessGroup, withCleanup } from "../process-cleanup";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { packagedLaunchEnvironment, packagedLaunchSwitches } from "./packaged-electron-app";
import { shippingPackage, verifyShippingPackage } from "../../scripts/packaged-security";

const root = path.resolve(import.meta.dirname, "../..");

test("shipping binary has the L3 fuses and ignores hostile dev variables, NODE_OPTIONS and Node inspector arguments", async () => {
  test.skip(
    process.platform !== "darwin" && process.platform !== "linux",
    "macOS/Linux package smoke",
  );
  const pkg = shippingPackage(
    root,
    process.platform,
    process.arch,
    process.env.ORKESTRATOR_SHIPPED_APP_EXECUTABLE?.trim() || undefined,
  );
  const executable = pkg.executable;
  // Missing packages fail rather than turning a green task into skipped qualification.
  expect(existsSync(executable), "Build the shipping --dir package first (not packaged-test)").toBe(
    true,
  );
  // Security report L3: read the fuses this binary actually carries.
  const report = await verifyShippingPackage(pkg);
  expect(
    report.checks.filter((check) => !check.passed),
    report.checks.map((check) => `${check.check}: ${check.detail}`).join("; "),
  ).toEqual([]);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "orkestrator-package-security-"));
  let browser: Browser | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false;
  let requests = 0;
  const hostile = http.createServer((_req, res) => {
    requests++;
    res.end("hostile renderer");
  });
  await withCleanup(async () => {
    await new Promise<void>((resolve) => hostile.listen(0, "127.0.0.1", resolve));
    const address = hostile.address() as net.AddressInfo;
    const [rendererPort, gatewayPort, inspectPort] = await reserveLoopbackPorts(3);
    const profile = resolveRuntimeProfile({
      repositoryRoot: root,
      requestedId: "packaged-security",
      flavor: "agent-test",
      rendererPort: rendererPort!,
      gatewayPort: gatewayPort!,
      roots: {
        developmentRoot: path.join(scratch, "dev"),
        productionDataDir: path.join(scratch, "production"),
        homeDir: scratch,
      },
    });
    const profilePath = await initializeProfile(profile);
    const home = path.join(scratch, "home");
    await mkdir(home);
    const marker = path.join(scratch, "node-options-executed");
    const preload = path.join(scratch, "hostile.cjs");
    await writeFile(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    );
    let stderr = "";
    let spawnError = false;
    child = ownProcessGroup(
      spawn(
        executable,
        [
          ...ELECTRON_TEST_SWITCHES,
          ...packagedLaunchSwitches(process.platform),
          "--remote-debugging-port=0",
          `--inspect=127.0.0.1:${inspectPort}`,
        ],
        {
          detached: true,
          cwd: scratch,
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...packagedLaunchEnvironment(process.env, { home, profilePath }),
            ELECTRON_DEV: "1",
            VITE_DEV_SERVER_URL: `http://127.0.0.1:${address.port}`,
            NODE_OPTIONS: `--require=${preload}`,
          },
        },
      ),
    );
    child.on("error", () => {
      spawnError = true;
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-256 * 1024);
    });
    await expect
      .poll(
        () => {
          expect(spawnError).toBe(false);
          expect(child!.exitCode).toBeNull();
          return /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1];
        },
        { timeout: 60_000 },
      )
      .toBeTruthy();
    browser = await chromium.connectOverCDP(
      /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)![1]!,
    );
    const renderer = pathToFileURL(path.join(pkg.resources, "web/index.html")).href;
    await expect
      .poll(
        () =>
          browser!
            .contexts()
            .flatMap((c) => c.pages())
            .map((p) => p.url()),
        { timeout: 60_000 },
      )
      .toContain(renderer);
    expect(requests).toBe(0);
    expect(stderr).toContain("dev-mode.ignored-packaged");
    expect(stderr).not.toContain("Debugger listening");
    expect(existsSync(marker)).toBe(false);
    // Chromium's CDP is available, but the independent Node inspector port must be closed.
    const inspectorOpen = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: inspectPort! });
      socket.setTimeout(2_000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(true);
      });
    });
    expect(inspectorOpen).toBe(false);
  }, [
    async () => {
      await browser?.close();
    },
    async () => {
      if (child) await stopProcessGroup(child);
      stopped = true;
    },
    async () => {
      await new Promise<void>((resolve, reject) =>
        hostile.close((error) => (error ? reject(error) : resolve())),
      );
    },
    async () => {
      if (stopped) await rm(scratch, { recursive: true, force: true });
    },
  ]);
});
