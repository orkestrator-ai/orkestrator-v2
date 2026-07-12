import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const DEV_URL = "http://127.0.0.1:1420";
const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const webRoot = path.join(repositoryRoot, "apps", "web");

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
  const electron = spawn("bunx", ["electron", "apps/desktop/dist/electron/main.js"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: {
    ...process.env,
    ELECTRON_DEV: "1",
    VITE_DEV_SERVER_URL: DEV_URL,
    },
  });

  electron.on("exit", (code) => shutdown(code ?? 0));
} catch (error) {
  console.error(error);
  shutdown(1);
}
