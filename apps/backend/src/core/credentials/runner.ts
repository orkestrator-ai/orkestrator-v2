import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CREDENTIAL_LIMITS, type CredentialBinding } from "@orkestrator/protocol/agent-credentials";
import { BoundedTail, StreamingRedactor, type RedactionValue } from "./redaction.js";

/**
 * Runs one command with credential values bound into it, owned by the
 * backend from spawn to cleanup (docs/architecture/agent-credentials.md,
 * "Running a command").
 *
 * - Values reach the process only through its own environment or a private
 *   file: never argv, a shell string, a shared process's environment or the
 *   worktree. In a container the value rides in the environment of the host's
 *   `docker exec` client (`-e NAME` names it, the value is read from the
 *   client's environment), so it is not on any command line either.
 * - Every byte of output passes the redactor before it is kept.
 * - A local run gets its own process group; the group is ended when the run
 *   ends (completion, deadline, cancellation) so a background descendant does
 *   not keep the value. A container run is tagged with an identity variable
 *   and ended the same way `!` commands are (`user-command-container.ts`).
 * - Cleanup is reported as confirmed only when every managed copy (process
 *   group, private directory) is known to be gone.
 */

export interface CredentialLaunch {
  target: "worktree" | "container";
  /** Host working directory (worktree) or container working directory. */
  cwd: string;
  containerId?: string;
  /** Environment of the spawned host process: the command itself, or the docker client. */
  env: NodeJS.ProcessEnv;
  /** Login shell for a worktree run. */
  shell?: string;
  /** Releases launch admission (environment work fence). */
  release?: () => void;
}

export interface CredentialRunBinding {
  binding: CredentialBinding;
  value: string;
}

export interface CredentialRunOutput {
  text: string;
  truncated: boolean;
}

export interface CredentialRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: CredentialRunOutput;
  stderr: CredentialRunOutput;
  cleanup: "confirmed" | "unconfirmed";
  /** The process never started; nothing ran. Content-free. */
  spawnError?: string;
}

export interface CredentialRunHandle {
  /** Resolves once the process has started (or failed to start). */
  started: Promise<boolean>;
  result: Promise<CredentialRunResult>;
  /** Stops the run; `hard` kills a worktree run's group at once (shutdown). */
  cancel(options?: { hard?: boolean }): void;
}

export interface StartCredentialRunOptions {
  id: string;
  launch: CredentialLaunch;
  command: string;
  bindings: readonly CredentialRunBinding[];
  redaction: readonly RedactionValue[];
  timeoutMs: number;
  /** Parent of a worktree run's private directory (inside the data directory). */
  runRoot: string;
  /** Recheck the binding after materialization, before the command can start. */
  beforeSpawn?: () => Promise<unknown>;
  /** Synchronously claims the durable reservation immediately before spawn. */
  onDispatch?: () => void;
  /** Test seam: the process spawner. */
  spawnProcess?: typeof spawn;
}

const OUTPUT_CHARS = CREDENTIAL_LIMITS.outputMaxBytes;
const TERMINATE_GRACE_MS = 2_000;
const CLOSE_GRACE_MS = 3_000;
const CONTAINER_STEP_TIMEOUT_MS = 15_000;
const RUN_ID = /^[a-f0-9-]{36}$/u;

class OutputSink {
  private readonly decoder = new TextDecoder("utf-8");
  private readonly redactor: StreamingRedactor;
  readonly tail = new BoundedTail(OUTPUT_CHARS);

  constructor(values: readonly RedactionValue[]) {
    this.redactor = new StreamingRedactor(values);
  }

  write(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.tail.append(this.redactor.push(text));
  }

  end(): CredentialRunOutput {
    this.tail.append(this.redactor.push(this.decoder.decode()));
    this.tail.append(this.redactor.flush());
    return this.tail.snapshot();
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : "spawn-failed";
}

/** Signals a process group this module created detached; false when it is gone. */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals | 0): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function runStep(
  spawnProcess: typeof spawn,
  argv: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child: ChildProcess;
    try {
      child = spawnProcess(argv[0]!, argv.slice(1), {
        env,
        stdio: [input === undefined ? "ignore" : "pipe", "ignore", "ignore"],
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, CONTAINER_STEP_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
    if (input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(input);
    }
  });
}

/** A per-run ticket gates file staging and the daemon's eventual workload start. */
const CONTAINER_PREPARE_SCRIPT = 'umask 077; mkdir -p "$1" && : > "$1/ready"';
const CONTAINER_FILE_SCRIPT =
  'umask 077; exec 9< "$1" && flock -x 9 && [ -f "$1/ready" ] && cat > "$1/$2"';
const CONTAINER_START_SCRIPT = `dir=$1; file=$2
exec 9< "$dir" && flock -x 9 && [ -f "$dir/ready" ] || exit 125
ps -o pgid= -p $$ > "$file" || exit 125
rm -f "$dir/ready" || exit 125
exec 9<&-
exec bash -lc "$3"`;

/**
 * Ends every process of a container run (by process group and by its
 * identity variable) and removes its private directory. True when both are
 * confirmed.
 */
const CONTAINER_CLEANUP_SCRIPT = `file=$1; identity=$2; dir=$3
# The daemon can start an exec after its host client has gone. Close admission
# under the same lock the workload uses to publish its identity.
if [ -d "$dir" ]; then
  (flock -x 9 && rm -f "$dir/ready") 9< "$dir" 2>/dev/null || [ ! -e "$dir" ] || exit 1
fi
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  group=""
  if [ -f "$file" ]; then read -r group < "$file"; fi
  live=""
  for entry in /proc/[0-9]*/stat; do
    [ -r "$entry" ] || continue
    pid=\${entry#/proc/}; pid=\${pid%/stat}
    [ "$pid" = "$$" ] && continue
    line=$(cat "$entry" 2>/dev/null) || continue
    fields=\${line##*) }
    set -- $fields
    state=$1; pgroup=$3
    [ "$state" = Z ] && continue
    if { [ -n "$group" ] && [ "$pgroup" = "$group" ]; } || grep -zqxF "ORKESTRATOR_CREDENTIAL_RUN=$identity" "/proc/$pid/environ" 2>/dev/null; then
      live="$live $pid"
    fi
  done
  if [ -z "$live" ]; then rm -rf "$dir" "$file"; [ ! -e "$dir" ] && [ ! -e "$file" ]; exit $?; fi
  if [ "$attempt" -lt 4 ]; then kill -TERM $live 2>/dev/null; else kill -KILL $live 2>/dev/null; fi
  sleep 0.1
done
exit 1`;

/**
 * Ends every process of a container run and removes its private files; also
 * what startup uses for a container run a previous process left behind.
 */
export async function cleanupContainerRun(options: {
  containerId: string;
  id: string;
  env: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}): Promise<"confirmed" | "unconfirmed"> {
  if (!RUN_ID.test(options.id)) return "unconfirmed";
  const directory = `/tmp/orkestrator-credentials/${options.id}`;
  const ok = await runStep(
    options.spawnProcess ?? spawn,
    [
      "docker",
      "exec",
      "-u",
      "node",
      options.containerId,
      "sh",
      "-c",
      CONTAINER_CLEANUP_SCRIPT,
      "orkestrator-credential-cleanup",
      `${directory}.pid`,
      options.id,
      directory,
    ],
    options.env,
  );
  return ok ? "confirmed" : "unconfirmed";
}

export function startCredentialRun(options: StartCredentialRunOptions): CredentialRunHandle {
  if (!RUN_ID.test(options.id)) throw new Error("Invalid credential run id");
  const spawnProcess = options.spawnProcess ?? spawn;
  const stdout = new OutputSink(options.redaction);
  const stderr = new OutputSink(options.redaction);
  let child: ChildProcess | null = null;
  let timedOut = false;
  let cancelled = false;
  let terminateRequested = false;
  let resolveStarted!: (started: boolean) => void;
  const started = new Promise<boolean>((resolve) => {
    resolveStarted = resolve;
  });
  const container = options.launch.target === "container";
  const containerId = options.launch.containerId ?? "";
  const containerDir = `/tmp/orkestrator-credentials/${options.id}`;
  const containerPidFile = `${containerDir}.pid`;
  const localDir = path.join(options.runRoot, options.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the result is settled: nothing is signalled after that. */
  let settled = false;
  /** Set once the group answered ESRCH: its id may be reused, so never signal it again. */
  let groupGone = false;
  /** Set when the pipes stayed open past the grace period (a detached holder). */
  let pipesLeftOpen = false;
  const killTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Signals the run's own process group (created detached by this module),
   * and only while it can still be ours: before the result settles and
   * before the group was seen gone.
   */
  const signalOwnGroup = (signal: NodeJS.Signals | 0): boolean => {
    if (container || settled || groupGone || !child?.pid) return false;
    if (signalGroup(child.pid, signal)) return true;
    groupGone = true;
    for (const each of killTimers) clearTimeout(each);
    killTimers.clear();
    return false;
  };
  const termThenKill = () => {
    if (!signalOwnGroup("SIGTERM")) return;
    const kill = setTimeout(() => {
      killTimers.delete(kill);
      signalOwnGroup("SIGKILL");
    }, TERMINATE_GRACE_MS);
    kill.unref?.();
    killTimers.add(kill);
  };

  const terminate = () => {
    if (terminateRequested) return;
    terminateRequested = true;
    if (!child) return;
    if (container) {
      // The docker client is not the workload; end the workload inside.
      void cleanupMaterialized()
        .finally(() => child?.kill("SIGKILL"))
        .catch(() => undefined);
      return;
    }
    termThenKill();
  };

  const result = (async (): Promise<CredentialRunResult> => {
    // Give the owner a chance to register cancellation before setup starts.
    await Promise.resolve();
    const env: NodeJS.ProcessEnv = { ...options.launch.env };
    const fileValues = options.bindings.filter((entry) => entry.binding.kind === "file");
    let argv: string[];
    try {
      if (container) {
        if (!containerId) throw Object.assign(new Error("no container"), { code: "no-container" });
        const prepared = await runStep(
          spawnProcess,
          [
            "docker",
            "exec",
            "-u",
            "node",
            containerId,
            "sh",
            "-c",
            CONTAINER_PREPARE_SCRIPT,
            "orkestrator-credential-prepare",
            containerDir,
          ],
          options.launch.env,
        );
        if (!prepared)
          throw Object.assign(new Error("container run preparation failed"), {
            code: "container-setup",
          });
        // Private files first: written from stdin, never from an argument.
        for (const entry of fileValues) {
          if (terminateRequested) break;
          await options.beforeSpawn?.();
          if (terminateRequested) break;
          const ok = await runStep(
            spawnProcess,
            [
              "docker",
              "exec",
              "-i",
              "-u",
              "node",
              containerId,
              "sh",
              "-c",
              CONTAINER_FILE_SCRIPT,
              "orkestrator-credential-file",
              containerDir,
              entry.binding.name,
            ],
            options.launch.env,
            entry.value,
          );
          if (!ok) throw Object.assign(new Error("file binding failed"), { code: "file-binding" });
        }
        const exec = ["docker", "exec", "-u", "node", "-w", options.launch.cwd];
        exec.push("-e", `ORKESTRATOR_CREDENTIAL_RUN=${options.id}`);
        for (const entry of options.bindings) {
          if (entry.binding.kind === "env") {
            exec.push("-e", entry.binding.name);
            env[entry.binding.name] = entry.value;
          } else {
            exec.push("-e", `${entry.binding.name}=${containerDir}/${entry.binding.name}`);
          }
        }
        argv = [
          ...exec,
          containerId,
          "bash",
          "-c",
          CONTAINER_START_SCRIPT,
          "orkestrator-credential-run",
          containerDir,
          containerPidFile,
          options.command,
        ];
      } else {
        if (fileValues.length > 0) {
          await fs.mkdir(options.runRoot, { recursive: true, mode: 0o700 });
          await fs.mkdir(localDir, { mode: 0o700 });
          for (const entry of fileValues) {
            if (terminateRequested) break;
            await options.beforeSpawn?.();
            if (terminateRequested) break;
            const file = path.join(localDir, entry.binding.name);
            const handle = await fs.open(file, "wx", 0o600);
            try {
              await handle.writeFile(entry.value, "utf8");
            } finally {
              await handle.close();
            }
            env[entry.binding.name] = file;
          }
        }
        for (const entry of options.bindings) {
          if (entry.binding.kind === "env") env[entry.binding.name] = entry.value;
        }
        argv = [options.launch.shell ?? "/bin/sh", "-lc", options.command];
      }
      if (!terminateRequested) await options.beforeSpawn?.();
      if (!terminateRequested) options.onDispatch?.();
    } catch (error) {
      resolveStarted(false);
      const cleanup = await cleanupMaterialized();
      settled = true;
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        stdout: { text: "", truncated: false },
        stderr: { text: "", truncated: false },
        cleanup,
        spawnError: errorCode(error),
      };
    }

    // A cancellation or revocation during the setup above wins: nothing starts.
    if (terminateRequested) {
      resolveStarted(false);
      const cleanup = await cleanupMaterialized();
      settled = true;
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: true,
        stdout: { text: "", truncated: false },
        stderr: { text: "", truncated: false },
        cleanup,
        spawnError: "cancelled-before-start",
      };
    }

    const exit = await new Promise<{
      exitCode: number | null;
      signal: string | null;
      spawnError?: string;
    }>((resolve) => {
      let exited: { exitCode: number | null; signal: string | null } | null = null;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: {
        exitCode: number | null;
        signal: string | null;
        spawnError?: string;
      }) => {
        clearTimeout(closeTimer);
        resolve(value);
      };
      try {
        child = spawnProcess(argv[0]!, argv.slice(1), {
          cwd: container ? undefined : options.launch.cwd,
          env,
          detached: !container,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolveStarted(false);
        done({ exitCode: null, signal: null, spawnError: errorCode(error) });
        return;
      }
      child.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));
      child.on("spawn", () => {
        resolveStarted(true);
        if (terminateRequested) {
          terminateRequested = false;
          terminate();
        }
      });
      child.on("error", (error) => {
        resolveStarted(false);
        if (!exited) done({ exitCode: null, signal: null, spawnError: errorCode(error) });
      });
      child.on("exit", (code, signal) => {
        exited = { exitCode: code, signal };
        // End anything the command left behind in its group; the pipes close
        // when the last holder exits.
        if (!container) termThenKill();
        closeTimer = setTimeout(() => {
          // Something outside the group still holds the pipes: stop reading
          // and do not claim the cleanup.
          pipesLeftOpen = true;
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          done(exited!);
        }, CLOSE_GRACE_MS + TERMINATE_GRACE_MS);
      });
      child.on("close", () => {
        if (exited) done(exited);
      });
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
    });
    clearTimeout(timer);
    const materialized = await cleanupMaterialized();
    const cleanup = pipesLeftOpen ? "unconfirmed" : materialized;
    settled = true;
    for (const each of killTimers) clearTimeout(each);
    killTimers.clear();
    return {
      ...exit,
      timedOut,
      cancelled,
      stdout: stdout.end(),
      stderr: stderr.end(),
      cleanup,
    };
  })();

  async function cleanupMaterialized(): Promise<"confirmed" | "unconfirmed"> {
    if (container) {
      if (!containerId) return "confirmed";
      return cleanupContainerRun({
        containerId,
        id: options.id,
        env: options.launch.env,
        spawnProcess,
      });
    }
    let confirmed = true;
    await fs.rm(localDir, { recursive: true, force: true }).catch(() => {
      confirmed = false;
    });
    if (signalOwnGroup(0)) {
      signalOwnGroup("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (signalOwnGroup(0)) confirmed = false;
    }
    return confirmed ? "confirmed" : "unconfirmed";
  }

  return {
    started,
    result: result.finally(() => options.launch.release?.()),
    cancel(options = {}) {
      cancelled = true;
      if (options.hard && !container && child) {
        // Shutdown: no grace period the process could outlive.
        terminateRequested = true;
        signalOwnGroup("SIGKILL");
        return;
      }
      terminate();
    },
  };
}
