/** Direct launch of the shipping (inspect-off) binary; never _electron.launch. */
import { expect, test } from "./electron-fixtures";
import { chromium, type Browser } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GATEWAY_RENDERER_CONTENT_SECURITY_POLICY,
  RENDERER_CONTENT_SECURITY_POLICY,
} from "@orkestrator/protocol/renderer-content-security-policy";
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
            ORKESTRATOR_RENDERER_DEV_SERVER_URL: `http://127.0.0.1:${address.port}`,
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
    // Security report M6 and M7: the sandboxed CommonJS preload still exposes the
    // bridge, the document carries the policy, and that policy refuses script.
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url() === renderer)!;
    expect(
      await page.evaluate(async () => {
        const inline = document.createElement("script");
        inline.textContent = "window.__inlineScriptRan = true";
        document.head.append(inline);
        // CDP's evaluate lifts the eval restriction for its synchronous scope.
        await new Promise((resolve) => setTimeout(resolve));
        let evalRan = true;
        try {
          new Function("return 1")();
        } catch {
          evalRan = false;
        }
        return {
          bridge: typeof (window as unknown as { orkestrator?: { invoke?: unknown } }).orkestrator
            ?.invoke,
          nodeIntegration: typeof (window as unknown as { require?: unknown }).require,
          policy: document
            .querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.getAttribute("content"),
          inlineScriptRan: "__inlineScriptRan" in window,
          evalRan,
        };
      }),
    ).toEqual({
      bridge: "function",
      nodeIntegration: "undefined",
      policy: RENDERER_CONTENT_SECURITY_POLICY,
      inlineScriptRan: false,
      evalRan: false,
    });
    expect(stderr).not.toContain("preload-failed");
    // file:// startup alone does not exercise the backend's HTTP renderer path.
    // Authenticate locally without putting the disposable token in any artifact.
    let gatewayPolicy: string | null = null;
    await expect
      .poll(
        async () => {
          try {
            const { token } = JSON.parse(
              await readFile(path.join(profile.dataDir, "gateway-auth.json"), "utf8"),
            );
            const response = await fetch(`http://127.0.0.1:${gatewayPort}/`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(2_000),
              redirect: "manual",
            });
            await response.arrayBuffer();
            gatewayPolicy = response.headers.get("content-security-policy");
            return response.status;
          } catch {
            return 0;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(200);
    expect(gatewayPolicy).toBe(GATEWAY_RENDERER_CONTENT_SECURITY_POLICY);
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

for (const attack of ["asar-header", "app-folder"] as const) {
  test(`shipping binary rejects ${attack} tampering`, async () => {
    test.skip(
      process.platform !== "darwin" && process.platform !== "linux",
      "macOS/Linux package smoke",
    );
    test.skip(
      attack === "asar-header" && process.platform !== "darwin",
      "Electron does not enforce asar integrity on Linux",
    );
    const pkg = shippingPackage(
      root,
      process.platform,
      process.arch,
      process.env.ORKESTRATOR_SHIPPED_APP_EXECUTABLE?.trim() || undefined,
    );
    expect((await verifyShippingPackage(pkg)).passed).toBe(true);
    const scratch = await mkdtemp(path.join(os.tmpdir(), "ork-tamper-"));
    const source =
      process.platform === "darwin"
        ? path.resolve(pkg.executable, "../../..")
        : path.dirname(pkg.executable);
    const copy = path.join(scratch, path.basename(source));
    let child: ReturnType<typeof spawn> | undefined;
    let stopped = false;
    await withCleanup(async () => {
      // Mutate a disposable copy only; retain symlinks inside the macOS bundle.
      await cp(source, copy, { recursive: true, verbatimSymlinks: true });
      const executable = path.join(copy, path.relative(source, pkg.executable));
      const resources = path.join(copy, path.relative(source, pkg.resources));
      const asar = path.join(resources, "app.asar");
      const marker = path.join(scratch, "replacement-ran");
      if (attack === "asar-header") {
        const file = await open(asar, "r+");
        try {
          const prefix = Buffer.alloc(16);
          await file.read(prefix, 0, 16, 0);
          const length = prefix.readUInt32LE(12);
          expect(length).toBeGreaterThan(0);
          expect(length).toBeLessThan(16 * 1024 * 1024);
          const header = Buffer.alloc(length);
          await file.read(header, 0, length, 16);
          const index = header.indexOf('"package.json"');
          expect(index).toBeGreaterThanOrEqual(0);
          // Same length, still valid JSON: only the embedded header hash changes.
          header[index + 1] = "P".charCodeAt(0);
          JSON.parse(header.toString());
          await file.write(header, 0, length, 16);
        } finally {
          await file.close();
        }
      } else {
        await rm(asar);
        const app = path.join(resources, "app");
        await mkdir(app);
        await writeFile(path.join(app, "package.json"), JSON.stringify({ main: "index.js" }));
        await writeFile(
          path.join(app, "index.js"),
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); require('electron').app.exit(0);`,
        );
      }
      const [rendererPort, gatewayPort] = await reserveLoopbackPorts(2);
      const profile = resolveRuntimeProfile({
        repositoryRoot: root,
        requestedId: "tamper",
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
      let stderr = "";
      child = ownProcessGroup(
        spawn(
          executable,
          [
            ...ELECTRON_TEST_SWITCHES,
            ...packagedLaunchSwitches(process.platform),
            "--noerrdialogs",
          ],
          {
            detached: true,
            cwd: scratch,
            stdio: ["ignore", "ignore", "pipe"],
            env: packagedLaunchEnvironment(process.env, { home, profilePath }),
          },
        ),
      );
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child!.once("error", reject);
          child!.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      // Observe spawn errors immediately, including while polling for exit.
      void exited.catch(() => {});
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-256 * 1024);
      });
      await expect
        .poll(() => child!.exitCode !== null || child!.signalCode !== null, { timeout: 30_000 })
        .toBe(true);
      const outcome = await exited;
      expect(outcome.code === 0 && outcome.signal === null).toBe(false);
      expect(existsSync(marker)).toBe(false);
      if (attack === "asar-header") expect(stderr).toContain("Integrity check failed");
    }, [
      async () => {
        if (child) await stopProcessGroup(child);
        stopped = true;
      },
      async () => {
        if (stopped) await rm(scratch, { recursive: true, force: true });
      },
    ]);
  });
}
