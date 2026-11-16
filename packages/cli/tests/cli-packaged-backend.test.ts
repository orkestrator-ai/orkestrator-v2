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

// Hang watchdogs, not performance bounds. The test waits on real signals (the
// backend's startup phase lines, its readiness line, then its exit) and
// decides on those alone; a starved host only delays them. Startup fails only
// when no new phase arrives for STARTUP_STALL_MS, so a slow boot that keeps
// progressing passes and a stuck one fails naming the phase it stopped in
// (flake 0080). The bound is per phase, well above what one phase
// takes on a one-core, six-burner host (`mise run test:contention`). The test
// budget is only a last resort for a boot that keeps progressing forever.
const STARTUP_STALL_MS = 90_000;
const EXIT_TIMEOUT_MS = 60_000;
/** Recent stdout lines kept for a failure report: bounded in count and size. */
const STDOUT_TAIL_LINES = 20;
const STDOUT_TAIL_LINE_CHARS = 500;

setDefaultTimeout(600_000);

type StartupMessage = { type?: string; authFile?: string; phase?: string };
type ReadyMessage = StartupMessage;

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
): Promise<{ child: Bun.Subprocess; dataDir: string; ready: ReadyMessage; phases: string[] }> {
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
  // a deadline re-checked between reads would never be evaluated again. Each
  // new phase re-arms the watchdog; nothing else does.
  const started = Date.now();
  let stalled = false;
  let lastPhase = "none (no startup line yet)";
  let lastPhaseAt = started;
  const phases: string[] = [];
  const stdoutTail: string[] = [];
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      stalled = true;
      child.kill("SIGTERM");
    }, STARTUP_STALL_MS);
  };
  armWatchdog();
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
        stdoutTail.push(line.slice(0, STDOUT_TAIL_LINE_CHARS));
        if (stdoutTail.length > STDOUT_TAIL_LINES) stdoutTail.shift();
        let message: StartupMessage;
        try {
          message = JSON.parse(line) as StartupMessage;
        } catch {
          // Human-readable startup logs precede the readiness contract.
          continue;
        }
        if (message.type === "orkestrator-backend-ready") ready = message;
        else if (
          message.type === "orkestrator-backend-startup" &&
          typeof message.phase === "string"
        ) {
          lastPhaseAt = Date.now();
          lastPhase = message.phase;
          phases.push(`${message.phase}@${lastPhaseAt - started}ms`);
          armWatchdog();
        }
      }
    }
  } finally {
    clearTimeout(expiry);
    reader.releaseLock();
  }

  if (!ready) {
    await stopPackagedBackend(child);
    const reason = stalled
      ? `no new startup phase for ${STARTUP_STALL_MS}ms after "${lastPhase}"`
      : `stdout closed after "${lastPhase}" (${Date.now() - lastPhaseAt}ms later)`;
    throw new Error(
      [
        `Packaged backend did not become ready: ${reason}`,
        `phases: ${phases.join(", ") || "none"}`,
        `last stdout lines:\n${stdoutTail.join("\n")}`,
        `stderr:\n${await new Response(child.stderr).text()}`,
      ].join("\n"),
    );
  }
  return { child, dataDir, ready, phases };
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
    const { child, dataDir, ready, phases } = await startPackagedBackend({
      NODE_ENV: "development",
    });
    expect(ready.authFile).toBe(path.join(dataDir, "gateway-auth.json"));
    // Every phase was reported, in order, before the ready line.
    expect(phases.map((phase) => phase.split("@")[0])).toEqual([
      "process",
      "toolchains",
      "host-environment",
      "storage",
      "services",
      "recovery",
      "agent-tools",
      "orphan-reaping",
      "durable-work",
      "agents",
      "gateway",
      "preview-publication",
      "instance-descriptor",
    ]);
    await expect(stopPackagedBackend(child)).resolves.toBe(0);
  });
});
