import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

if (process.platform === "win32") {
  throw new Error("Orkestrator desktop development supports macOS and Linux only.");
}

const DEV_URL = "http://127.0.0.1:1420";
const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const webRoot = path.join(repositoryRoot, "apps", "web");
const electronExecutable = path.join(
  packageRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const build = spawnSync("bunx", ["tsc", "-p", "tsconfig.electron.json"], { cwd: packageRoot, stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const vite = spawn("bun", ["run", "dev"], { cwd: webRoot, env: process.env, stdio: "inherit" });

const shutdown = (code = 0) => {
  vite.kill();
  process.exit(code);
};

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

try {
  await waitForUrl(DEV_URL);
  // Some parent processes (notably editor terminals) export this to make
  // Electron run as plain Node. It must not leak into the desktop app process.
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  // Use this workspace's pinned Electron binary instead of allowing bunx to
  // resolve or download a different version from the repository root.
  const electron = spawn(electronExecutable, ["apps/desktop/dist/electron/main.js"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
      ...electronEnv,
      ELECTRON_DEV: "1",
      VITE_DEV_SERVER_URL: DEV_URL,
    },
  });

  electron.on("exit", (code) => shutdown(code ?? 0));
} catch (error) {
  console.error(error);
  shutdown(1);
}
