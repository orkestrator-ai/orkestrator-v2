import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeLayout } from "../src/supervisor/layout.js";
import { createSupervisorRuntime } from "../src/supervisor/runtime.js";
import {
  POLL_INTERVAL_MS,
  STABILITY_WINDOW_MS,
  Supervisor,
  type BackendChild,
} from "../src/supervisor/supervisor.js";

// Real Bun registry staging, the bundled backend, pointers and SQLite restore
// share a disposable data directory. The registry and artifacts are loopback
// fixtures; the only injected failure is the replacement's health response.
test("registry-staged backend cutover drains the failed writer before restoring SQLite and toolchain", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "supervisor-integration-"));
  const packageRoot = path.resolve(import.meta.dir, "..");
  const backendBundle = pathToFileURL(path.join(packageRoot, "dist", "main.js")).href;
  const dataDir = path.join(root, "data with spaces");
  const layout = runtimeLayout(dataDir);
  const artifacts = new Map<string, { bytes: Buffer; sha: string; manifestSha: string }>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let supervisor: Supervisor | undefined;
  let running: Promise<number> | undefined;
  const children: BackendChild[] = [];
  try {
    for (const version of ["2.21.0", "2.22.0"]) {
      const source = path.join(root, version, "package");
      mkdirSync(path.join(source, "bin"), { recursive: true });
      mkdirSync(path.join(source, "resources"));
      const requirements = JSON.parse(
        readFileSync(path.join(packageRoot, "resources", "release-requirements.json"), "utf8"),
      );
      requirements.version = version;
      requirements.container.tag = version;
      const manifest = `${JSON.stringify(requirements)}\n`;
      writeFileSync(path.join(source, "resources", "release-requirements.json"), manifest);
      writeFileSync(
        path.join(source, "package.json"),
        JSON.stringify({ name: "orkestrator", version, type: "module" }),
      );
      writeFileSync(
        path.join(source, "bin", "orkestrator.js"),
        `
        import path from "node:path";
        const root = path.resolve(import.meta.dir, "..");
        const pkg = await Bun.file(path.join(root, "package.json")).json();
        process.env.ORKESTRATOR_VERSION = pkg.version;
        process.env.ORKESTRATOR_APP_ROOT = root;
        process.env.ORKESTRATOR_RESOURCE_ROOT = path.join(root, "resources");
        process.argv.splice(2, 1);
        await import(${JSON.stringify(backendBundle)});
      `,
      );
      const tarball = path.join(root, `${version}.tgz`);
      const tar = Bun.spawnSync(["tar", "-czf", tarball, "package"], {
        cwd: path.dirname(source),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(tar.exitCode).toBe(0);
      const bytes = readFileSync(tarball);
      artifacts.set(version, {
        bytes,
        sha: createHash("sha512").update(bytes).digest("base64"),
        manifestSha: createHash("sha256").update(manifest).digest("hex"),
      });
    }
    let downloads = 0;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const version = /\/(2\.2[12]\.0)\.tgz$/.exec(url.pathname)?.[1];
        if (version) {
          downloads += 1;
          return new Response(new Uint8Array(artifacts.get(version)!.bytes));
        }
        if (url.pathname !== "/orkestrator") return new Response("missing", { status: 404 });
        return Response.json({
          name: "orkestrator",
          "dist-tags": { latest: "2.22.0" },
          versions: Object.fromEntries(
            Array.from(artifacts, ([version, artifact]) => [
              version,
              {
                name: "orkestrator",
                version,
                dist: {
                  tarball: `http://127.0.0.1:${server!.port}/${version}.tgz`,
                  integrity: `sha512-${artifact.sha}`,
                },
              },
            ]),
          ),
        });
      },
    });
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      NODE_ENV: "test",
      NPM_CONFIG_REGISTRY: `http://127.0.0.1:${server.port}`,
      BUN_INSTALL_CACHE_DIR: path.join(root, "cache"),
      ORKESTRATOR_CONTROL_MCP_DISABLED: "1",
      ORKESTRATOR_DISABLE_AUTO_UPDATE: "1",
    };
    const runtime = createSupervisorRuntime({
      dataDir,
      layout,
      bunPath: process.execPath,
      env,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const old = await runtime.stage("2.21.0", artifacts.get("2.21.0")!.manifestSha);
    await runtime.stage("2.22.0", artifacts.get("2.22.0")!.manifestSha);
    expect(downloads).toBe(2);
    await runtime.setCurrent(old);
    const oldTools = path.join(dataDir, "toolchains", "bin", "old");
    const newTools = path.join(dataDir, "toolchains", "bin", "new");
    mkdirSync(oldTools, { recursive: true });
    mkdirSync(newTools);
    await runtime.pointToolchainCurrent(oldTools);
    let sentInstall = false;
    let replacementExited = false;
    let restored = false;
    const spawn = runtime.spawn;
    runtime.spawn = (root, args) => {
      const child = spawn(root, args);
      children.push(child);
      if (root.includes("2.22.0"))
        void child.exited.then(() => {
          replacementExited = true;
        });
      return child;
    };
    const client = runtime.client;
    runtime.client = (endpoint) => {
      const original = client(endpoint);
      return {
        ...original,
        async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
          if (command === "update_host_pending" && !sentInstall) {
            sentInstall = true;
            return [
              {
                kind: "install",
                requestId: "integration-install",
                jobId: "integration-job",
                target: {
                  version: "2.22.0",
                  tag: "v2.22.0",
                  channel: "stable",
                  requirementsSha256: artifacts.get("2.22.0")!.manifestSha,
                },
                fromVersion: "2.21.0",
                restart: "now",
                storageSchemaVersion: 3,
                toolchainBinDir: newTools,
              },
            ] as T;
          }
          return original.invoke<T>(command, args);
        },
        async status() {
          const status = await original.status();
          if (status.appVersion === "2.22.0") {
            // Simulate a migration in the replacement, then fail its health check.
            const db = new Database(path.join(dataDir, "orkestrator.sqlite"));
            try {
              mkdirSync(path.join(dataDir, "backups"), { recursive: true });
              const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
              const snapshot = path.join(dataDir, "backups", `pre-migration-v3-${stamp}.sqlite`);
              db.run("VACUUM INTO ?", [snapshot]);
              db.run("PRAGMA user_version = 4");
            } finally {
              db.close();
            }
            return { ...status, appVersion: "failed-health-check" };
          }
          return status;
        },
      };
    };
    const restoreSnapshot = runtime.restoreSnapshot;
    runtime.restoreSnapshot = async (version, since) => {
      expect(replacementExited).toBe(true);
      restored = await restoreSnapshot(version, since);
      return restored;
    };
    const sleep = runtime.sleep;
    runtime.sleep = (ms) => sleep(ms === POLL_INTERVAL_MS || ms === STABILITY_WINDOW_MS ? 10 : ms);
    supervisor = new Supervisor({
      ownPackageRoot: runtime.packageRootOf(old),
      ownVersion: "2.21.0",
      runtime,
      serveArgs: [
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--allow-non-tailscale-bind",
        "--data-dir",
        dataDir,
        "--worktree-dir",
        path.join(root, "worktrees"),
        "--runtime-flavor",
        "agent-test",
      ],
    });
    running = supervisor.run();
    let completed = false;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const state = await runtime.readState();
      if (state?.cutover === null && children.length === 3 && restored) {
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(completed).toBe(true);
    expect(await runtime.readCurrent()).toBe(old);
    expect(await runtime.readToolchainCurrent()).toBe(oldTools);
    supervisor.stop();
    expect(await running).toBe(0);
    expect(runtime.readUserVersion()).toBe(3);
  } finally {
    supervisor?.stop();
    for (const child of children) child.signal("SIGTERM");
    await Promise.all(children.map((child) => child.exited));
    if (running) await running;
    server?.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
