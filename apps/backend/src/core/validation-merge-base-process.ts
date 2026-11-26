import type { EnvironmentCommandRunner } from "./commands/index.js";
import { CommandFailedError } from "./shell.js";

export interface MergeBaseRerunResult {
  exitCode: number | null;
  output: string;
  stderr?: string;
  timedOut: boolean;
  truncated?: boolean;
  /** False when the caller cannot prove the step's process group stopped. */
  quiescent?: boolean;
}

export type MergeBaseRerunExec = (
  script: string,
  args: string[],
  timeoutMs: number,
) => Promise<MergeBaseRerunResult>;

/**
 * Runs beside the child, including inside Docker. Killing the host Docker
 * client cannot stop its remote child. Only this worker's acknowledgement
 * permits the next step or worktree cleanup.
 */
const STEP_SUPERVISOR = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const [budget, script, ...args] = process.argv.slice(1);
const bytesLimit = 1024 * 1024;
let bytes = 0, truncated = false, timedOut = false, exited = false, closed = false;
let exitCode = null, missing = false;
const stdout = [], stderr = [];
const child = spawn("bash", ["-c", script, "merge-base-rerun", ...args], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ORKESTRATOR_BASELINE_BUN: process.execPath,
    PATH: path.dirname(process.execPath) + ":" + (process.env.PATH || "") },
});
function collect(buffer) {
  return chunk => {
    if (truncated) return;
    bytes += chunk.length;
    if (bytes <= bytesLimit) buffer.push(chunk);
    else truncated = true;
  };
}
child.stdout.on("data", collect(stdout));
child.stderr.on("data", collect(stderr));
child.on("error", error => { missing = error.code === "ENOENT"; exited = true; });
child.on("exit", code => { exitCode = code; exited = true; });
child.on("close", () => { closed = true; });
const signalGroup = signal => {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch {}
};
let stopAt;
function stop() {
  if (stopAt) return;
  stopAt = Date.now() + 3_000;
  signalGroup("SIGKILL");
}
function groupAlive() {
  if (!child.pid) return false;
  try { process.kill(-child.pid, 0); } catch (error) { return error.code !== "ESRCH"; }
  if (!exited) return true;
  // Docker PID 1 may leave adopted zombies. They cannot access the checkout.
  if (process.platform === "linux") {
    try {
      const entries = fs.readdirSync("/proc");
      if (entries.length > 32_768) return true;
      for (const pid of entries) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
          const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ", 3);
          if (Number(group) === child.pid && state !== "Z") return true;
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ESRCH") return true;
        }
      }
      return false;
    } catch { return true; }
  }
  const list = spawnSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8", timeout: 250, maxBuffer: 1024 * 1024 });
  return list.status !== 0 || list.stdout.split("\n").some(row => {
    const [group, state] = row.trim().split(/\s+/, 2);
    return Number(group) === child.pid && !state?.startsWith("Z");
  });
}
const deadline = Date.now() + Number(budget);
const timer = setInterval(() => {
  if (!stopAt && Date.now() >= deadline && !(exited && closed)) {
    timedOut = true;
    stop();
  }
  if (truncated) stop();
  if (exited && groupAlive()) {
    exitCode = null;
    stop();
  }
  const quiescent = exited && !groupAlive();
  if (!(quiescent && closed) && !(stopAt && Date.now() >= stopAt)) return;
  clearInterval(timer);
  child.stdout.destroy();
  child.stderr.destroy();
  process.stdout.write(JSON.stringify({
    exitCode: missing ? 127 : exitCode,
    output: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
    timedOut,
    truncated: truncated || !closed,
    quiescent: quiescent && closed,
  }));
  // Do not wait indefinitely on an unconfirmed child. The caller keeps the
  // checkout in place and will not use any of this step's observations.
  child.unref();
}, 25);
`;

export function mergeBaseRerunExec(
  runner: EnvironmentCommandRunner,
  options: { bun?: string; env?: NodeJS.ProcessEnv } = {},
): MergeBaseRerunExec {
  return async (script, args, timeoutMs) => {
    const workerArgs = ["--no-env-file", "-e", STEP_SUPERVISOR, String(timeoutMs), script, ...args];
    try {
      const output = options.bun
        ? await runner(options.bun, workerArgs, timeoutMs + 10_000, options.env)
        : await runner(
            "bash",
            ["-lc", 'exec bun "$@"', "merge-base-rerun", ...workerArgs],
            timeoutMs + 10_000,
          );
      const result = JSON.parse(output) as MergeBaseRerunResult;
      if (
        typeof result.output === "string" &&
        typeof result.stderr === "string" &&
        typeof result.quiescent === "boolean" &&
        typeof result.timedOut === "boolean" &&
        typeof result.truncated === "boolean" &&
        (result.exitCode === null || Number.isInteger(result.exitCode))
      )
        return result;
    } catch (error) {
      // No intact acknowledgement: the in-environment child may still be alive.
      return {
        exitCode: error instanceof CommandFailedError ? error.exitCode : null,
        output: "",
        timedOut: error instanceof CommandFailedError && error.timedOut,
        quiescent: false,
      };
    }
    return { exitCode: null, output: "", timedOut: false, quiescent: false };
  };
}
