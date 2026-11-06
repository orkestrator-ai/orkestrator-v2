import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export interface InteractionFixtureHost {
  process: ChildProcess;
  origin: string;
  directory: string;
}

const stoppedHosts = new WeakSet<InteractionFixtureHost>();

/** Only signal the process group created by this helper, including its fake provider. */
async function signalHost(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code !== "EPERM" || (child.exitCode === null && child.signalCode === null)) throw error;
    // A macOS child can remain in kernel exit (ps state E) after its parent
    // exits. Group signalling then answers EPERM. Wait for the owned group to
    // drain; never turn an unconfirmed or live group into successful cleanup.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const members = execFileSync("ps", ["-axo", "pgid=,stat="], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(([group]) => Number(group) === child.pid);
      if (members.every(([, state]) => state?.startsWith("Z"))) return;
      if (
        members.some(([, state]) => !state?.includes("E") && !state?.startsWith("Z")) ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null || !child.pid;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve(hasExited(child));
    };
    const timer = setTimeout(done, timeoutMs);
    child.once("exit", done);
  });
}

export async function stopInteractionFixtureHost(
  host: InteractionFixtureHost,
  graceMs = 5_000,
): Promise<void> {
  if (stoppedHosts.has(host)) return;
  const child = host.process;
  if (!hasExited(child)) {
    const stopped = waitForExit(child, graceMs);
    await signalHost(child, "SIGTERM");
    await stopped;
  }
  // Also stop descendants if the host has already exited by signal.
  await signalHost(child, "SIGKILL");
  if (!(await waitForExit(child, 5_000))) throw new Error("fixture did not exit after SIGKILL");
  rmSync(host.directory, { recursive: true, force: true });
  stoppedHosts.add(host);
}

export async function startInteractionFixtureHost(
  script: string,
  env: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<InteractionFixtureHost> {
  const directory = mkdtempSync(path.join(tmpdir(), "interaction-host-"));
  const child = spawn("bun", [script], {
    env: { ...process.env, ...env, TMPDIR: directory },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const host = { process: child, origin: "", directory };
  let error = "";
  child.stderr!.on("data", (chunk) => {
    error = (error + String(chunk)).slice(-3000);
  });
  const lines = createInterface({ input: child.stdout! });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onError: (error: Error) => void = () => {};
  let onExit: () => void = () => {};
  try {
    host.origin = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${script} startup timed out`)), timeoutMs);
      onError = reject;
      onExit = () => reject(new Error(`${script} exited before readiness: ${error}`));
      child.once("error", onError);
      child.once("exit", onExit);
      lines.on("line", (line) => {
        if (/^INTERACTION_FIXTURE_READY:\d+$/.test(line))
          resolve(`http://127.0.0.1:${line.split(":")[1]}`);
      });
    });
    return host;
  } catch (failure) {
    await stopInteractionFixtureHost(host);
    throw failure;
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdout!.resume();
    child.off("error", onError);
    child.off("exit", onExit);
  }
}
