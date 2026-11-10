/**
 * The published package's backend, booted from `bin/orkestrator.js` the way a
 * `bunx orkestrator` user starts it. Slow tier (`scripts/test-tiers.ts`): it
 * waits on a real backend process becoming ready and stopping. The package's
 * static checks stay in `cli.test.ts`. Needs `bun run --cwd packages/cli build`.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];
const processes: Bun.Subprocess[] = [];

// Generous because these run alongside the rest of the workspace suite; the
// timeout only has to be shorter than Bun's own, so a stall reports the child's
// stderr instead of failing as an anonymous hang.
const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 10_000;

setDefaultTimeout(40_000);

type ReadyMessage = { type?: string; authFile?: string };

/** Waits for exit, escalating to SIGKILL so a wedged child cannot hang the run. */
async function stopPackagedBackend(child: Bun.Subprocess): Promise<number> {
  child.kill("SIGTERM");
  const escalation = setTimeout(() => child.kill("SIGKILL"), EXIT_TIMEOUT_MS);
  try {
    return await child.exited;
  } finally {
    clearTimeout(escalation);
  }
}

async function startPackagedBackend(
  environmentOverrides: Record<string, string> = {},
): Promise<{ child: Bun.Subprocess; dataDir: string; ready: ReadyMessage }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-cli-test-"));
  temporaryDirectories.push(dataDir);
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(packageRoot, "bin/orkestrator.js"),
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--allow-non-tailscale-bind",
      "--data-dir",
      dataDir,
    ],
    {
      cwd: dataDir,
      stdout: "pipe",
      stderr: "pipe",
      // Off: each run is a new Docker owner stopped right after ready, so a boot
      // host-reachability probe would leave a network nothing reaps.
      env: { ...process.env, ORKESTRATOR_HOST_REACHABILITY_CHECK: "off", ...environmentOverrides },
    },
  );
  processes.push(child);

  // Killing the child is what unblocks the loop. A backend that starts and then
  // stalls without writing or exiting leaves `reader.read()` pending forever, so
  // a deadline re-checked between reads would never be evaluated again.
  const expiry = setTimeout(() => child.kill("SIGTERM"), READY_TIMEOUT_MS);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let ready: ReadyMessage | undefined;
  try {
    while (!ready) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as ReadyMessage;
          if (message.type === "orkestrator-backend-ready") ready = message;
        } catch {
          // Human-readable startup logs precede the readiness contract.
        }
      }
    }
  } finally {
    clearTimeout(expiry);
    reader.releaseLock();
  }

  if (!ready) {
    await stopPackagedBackend(child);
    throw new Error(
      `Packaged backend did not become ready: ${await new Response(child.stderr).text()}`,
    );
  }
  return { child, dataDir, ready };
}

afterAll(async () => {
  for (const child of processes) child.kill("SIGKILL");
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("orkestrator CLI package", () => {
  test("starts and gracefully stops the packaged backend, keeping the caller's NODE_ENV", async () => {
    // The shim only defaults NODE_ENV, so an inherited value survives. getBridgePath
    // consults the packaged resources root only outside development, and the package
    // has no `bridges/` directory to fall back to, so development is the boot that
    // can break. (Under `bun test` the default case inherits NODE_ENV=test anyway.)
    const { child, dataDir, ready } = await startPackagedBackend({ NODE_ENV: "development" });
    expect(ready.authFile).toBe(path.join(dataDir, "gateway-auth.json"));
    await expect(stopPackagedBackend(child)).resolves.toBe(0);
  });
});
