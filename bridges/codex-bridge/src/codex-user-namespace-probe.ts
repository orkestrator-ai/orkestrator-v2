/**
 * Whether this Linux host lets Codex's command sandbox (bubblewrap) create the
 * unprivileged user namespace it needs for every command.
 *
 * A container is recognised by its marker files (`codex-read-only-sandbox.ts`).
 * A host has none, yet its policy can refuse the namespace all the same:
 * Ubuntu 24.04+ with `kernel.apparmor_restrict_unprivileged_userns`, Debian
 * with `kernel.unprivileged_userns_clone=0`, or a hardened kernel. Codex then
 * fails each command with `bwrap: No permissions to create a new namespace`
 * and a read-only reviewer reads nothing.
 *
 * Turning the sandbox off is the dangerous direction, so the probe has three
 * answers and only `refused` turns it off:
 *
 * - `refused`: a helper ran to a non-zero exit and its error output names a
 *   failed namespace operation (`namespaceRefusalLine`).
 * - `allowed`: Codex's own sandbox ran a command.
 * - `unknown`: anything else. A helper that could not be started, timed out,
 *   was killed by a signal, or failed for another reason (`execvp true: No
 *   such file`, a config error) proves nothing about the host.
 *
 * Which helper is asked matters under AppArmor. Ubuntu's
 * `bwrap-userns-restrict` profile is attached to `/usr/bin/bwrap`, so the
 * system bubblewrap may create a namespace that an unconfined program, Codex's
 * bundled bubblewrap included, is refused. So the probe first runs `true`
 * under Codex's own sandbox (`codex sandbox`), which is exactly what a turn's
 * commands go through; its answer is final when it is `allowed` or `refused`.
 * Only when Codex cannot be asked (no binary, or an unknown answer) does it ask
 * the system programs, and then a success proves nothing about Codex's helper:
 *
 * - `bwrap` on PATH refused: refused. It is the most permitted program on the
 *   host (it carries the AppArmor profile), so Codex's helper, whichever it
 *   runs, is refused too. `bwrap` succeeding: unknown.
 * - no `bwrap`, `unshare --user` refused: refused. With no system bubblewrap
 *   Codex can only run its bundled, unconfined copy, which `unshare` stands
 *   for. `unshare` succeeding: unknown.
 * - neither program: unknown.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { executableOnPath } from "@orkestrator/protocol/node/claude-linux-sandbox";

/** Each probe command's ceiling, so a wedged helper cannot stall a prompt. */
export const CODEX_USER_NAMESPACE_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long a definite answer (`allowed` or `refused`) is reused: a burst of
 * prompts shares a run, and a policy change is re-read without a restart.
 */
export const CODEX_USER_NAMESPACE_PROBE_TTL_MS = 5 * 60_000;

/**
 * How long an `unknown` answer is reused. Shorter, so a transient failure (a
 * timeout on a loaded host) is retried soon, yet a wedged helper still costs
 * one bounded run per window rather than one per prompt.
 */
export const CODEX_USER_NAMESPACE_PROBE_UNKNOWN_TTL_MS = 30_000;

/** What one helper run did: its exit status, or why it has none. */
export interface CodexUserNamespaceProbeRun {
  /** Exit status, or null when the helper was killed or never started. */
  status: number | null;
  /** The signal that ended it, if any (a timeout is a SIGKILL). */
  signal?: string | null;
  /** Why it could not be started or did not finish (ENOENT, ETIMEDOUT). */
  error?: string;
  stderr: string;
}

export type CodexUserNamespaceProbeAnswer =
  { outcome: "allowed" } | { outcome: "refused"; detail: string } | { outcome: "unknown" };

export interface CodexUserNamespaceProbeDependencies {
  onPath?: (name: string) => boolean;
  run?: (command: string, args: readonly string[]) => CodexUserNamespaceProbeRun;
  /** The Codex executable to ask, or undefined when there is none to run. */
  codexExecutable?: () => string | undefined;
}

/**
 * Error output that names a failed namespace operation, as bubblewrap,
 * util-linux `unshare` and Codex's sandbox (which relays bubblewrap) word it.
 */
const NAMESPACE_REFUSAL_PATTERNS: readonly RegExp[] = [
  /no permissions to create (a )?new namespace/i,
  /creating new namespace failed/i,
  /setting up uid map/i,
  /\/proc\/self\/(uid_map|gid_map|setgroups)/i,
  /\bunshare failed\b/i,
  /\bnamespace\b.*\b(operation not permitted|permission denied)\b/i,
];

/** The first error line naming a refused namespace, bounded for a reason string. */
export function namespaceRefusalLine(stderr: string): string | undefined {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => NAMESPACE_REFUSAL_PATTERNS.some((pattern) => pattern.test(entry)));
  if (line === undefined) return undefined;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** Judge one helper run: see the module comment for what counts as a refusal. */
export function classifyCodexUserNamespaceRun(
  run: CodexUserNamespaceProbeRun,
): CodexUserNamespaceProbeAnswer {
  if (run.error !== undefined || run.status === null || run.signal) return { outcome: "unknown" };
  if (run.status === 0) return { outcome: "allowed" };
  const detail = namespaceRefusalLine(run.stderr);
  return detail === undefined ? { outcome: "unknown" } : { outcome: "refused", detail };
}

function runProbeCommand(command: string, args: readonly string[]): CodexUserNamespaceProbeRun {
  const result = spawnSync(command, [...args], {
    timeout: CODEX_USER_NAMESPACE_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error.message } : {}),
    stderr: result.stderr ?? "",
  };
}

/** The executable the bridge launches app-server from (`index.ts`): `CODEX_PATH`, else `codex`. */
function defaultCodexExecutable(): string | undefined {
  const configured = process.env.CODEX_PATH?.trim() || "codex";
  if (!isAbsolute(configured)) return executableOnPath(configured) ? configured : undefined;
  try {
    accessSync(configured, constants.X_OK);
    return configured;
  } catch {
    return undefined;
  }
}

/** `true` under Codex's own read-only command sandbox, the path a turn's commands take. */
export const CODEX_SANDBOX_PROBE_ARGS = Object.freeze([
  "sandbox",
  "-c",
  'sandbox_mode="read-only"',
  "--",
  "true",
]);

/** `true` in a new user namespace under the system bubblewrap. */
export const BWRAP_PROBE_ARGS = Object.freeze([
  "--new-session",
  "--die-with-parent",
  "--unshare-user",
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--",
  "true",
]);

/** `true` in a new user namespace from an unconfined program. */
export const UNSHARE_PROBE_ARGS = Object.freeze(["--user", "--map-root-user", "true"]);

/**
 * Run the probe now. Prefer {@link codexUserNamespaceRefusal}, which caches it.
 * See the module comment for the order and what each answer means.
 */
export function probeCodexUserNamespace(
  dependencies: CodexUserNamespaceProbeDependencies = {},
): CodexUserNamespaceProbeAnswer {
  const onPath = dependencies.onPath ?? executableOnPath;
  const run = dependencies.run ?? runProbeCommand;
  const codex = (dependencies.codexExecutable ?? defaultCodexExecutable)();
  if (codex !== undefined) {
    const answer = classifyCodexUserNamespaceRun(run(codex, CODEX_SANDBOX_PROBE_ARGS));
    if (answer.outcome !== "unknown") return answer;
  }
  const system = onPath("bwrap")
    ? classifyCodexUserNamespaceRun(run("bwrap", BWRAP_PROBE_ARGS))
    : onPath("unshare")
      ? classifyCodexUserNamespaceRun(run("unshare", UNSHARE_PROBE_ARGS))
      : undefined;
  // A system program that can create the namespace says nothing about
  // Codex's helper; only its refusal carries over.
  return system?.outcome === "refused" ? system : { outcome: "unknown" };
}

let cached: { answer: CodexUserNamespaceProbeAnswer; at: number } | undefined;

function cacheLifetime(answer: CodexUserNamespaceProbeAnswer): number {
  return answer.outcome === "unknown"
    ? CODEX_USER_NAMESPACE_PROBE_UNKNOWN_TTL_MS
    : CODEX_USER_NAMESPACE_PROBE_TTL_MS;
}

/**
 * The refusal's error line when this host refuses Codex's sandbox its user
 * namespace, or undefined when it allows it or the probe cannot tell. Runs the
 * probe at most once per {@link CODEX_USER_NAMESPACE_PROBE_TTL_MS} for a
 * definite answer, {@link CODEX_USER_NAMESPACE_PROBE_UNKNOWN_TTL_MS} for an
 * unknown one.
 */
export function codexUserNamespaceRefusal(
  now: number = Date.now(),
  probe: () => CodexUserNamespaceProbeAnswer = probeCodexUserNamespace,
): string | undefined {
  const age = cached ? now - cached.at : -1;
  if (!cached || age < 0 || age >= cacheLifetime(cached.answer)) {
    cached = { answer: probe(), at: now };
  }
  return cached.answer.outcome === "refused" ? cached.answer.detail : undefined;
}

/** Tests only: forget the cached answer. */
export function resetCodexUserNamespaceProbeForTests(): void {
  cached = undefined;
}
