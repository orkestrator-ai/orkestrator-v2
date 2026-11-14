/**
 * Whether this Linux host lets a process create an unprivileged user
 * namespace, which Codex's command sandbox (bubblewrap) needs for every
 * command.
 *
 * A container is recognised by its marker files (`codex-read-only-sandbox.ts`).
 * A host has none, yet its policy can refuse the namespace all the same:
 * Ubuntu 24.04+ with `kernel.apparmor_restrict_unprivileged_userns`, Debian
 * with `kernel.unprivileged_userns_clone=0`, or a hardened kernel. Codex then
 * fails each command with `bwrap: No permissions to create a new namespace`
 * and a read-only reviewer reads nothing.
 *
 * The probe runs what Codex needs rather than inspecting sysctls: bubblewrap
 * creating a user namespace when `bwrap` is on PATH (Codex also ships its own
 * copy, so a missing one proves nothing), else `unshare --user`. When neither
 * program exists the answer is unknown, and the sandbox stays on: only a
 * refusal this probe actually saw turns it off.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Each probe command's ceiling, so a wedged helper cannot stall a prompt. */
export const CODEX_USER_NAMESPACE_PROBE_TIMEOUT_MS = 5_000;

/** How long one answer is reused: a burst of prompts shares a run, a policy change is re-read. */
export const CODEX_USER_NAMESPACE_PROBE_TTL_MS = 5 * 60_000;

export interface CodexUserNamespaceProbeDependencies {
  onPath?: (name: string) => boolean;
  run?: (command: string, args: readonly string[]) => { ok: boolean; stderr: string };
}

function executableOnPath(name: string): boolean {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Not here; keep looking.
    }
  }
  return false;
}

function runProbeCommand(
  command: string,
  args: readonly string[],
): { ok: boolean; stderr: string } {
  const result = spawnSync(command, [...args], {
    timeout: CODEX_USER_NAMESPACE_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  if (result.error) return { ok: false, stderr: result.error.message };
  return { ok: result.status === 0, stderr: result.stderr ?? "" };
}

function firstLine(stderr: string): string {
  const line =
    stderr
      .split("\n")
      .map((entry) => entry.trim())
      .find(Boolean) ?? "no error output";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * The refusal's first error line when this host cannot create a user
 * namespace, or undefined when it can or the probe cannot tell. Runs the
 * probe now; prefer {@link codexUserNamespaceRefusal}, which caches it.
 */
export function probeCodexUserNamespace(
  dependencies: CodexUserNamespaceProbeDependencies = {},
): string | undefined {
  const onPath = dependencies.onPath ?? executableOnPath;
  const run = dependencies.run ?? runProbeCommand;
  const attempt = onPath("bwrap")
    ? run("bwrap", [
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
      ])
    : onPath("unshare")
      ? run("unshare", ["--user", "--map-root-user", "true"])
      : undefined;
  if (!attempt || attempt.ok) return undefined;
  return firstLine(attempt.stderr);
}

let cached: { refusal: string | undefined; at: number } | undefined;

/** The probe's answer, run at most once per {@link CODEX_USER_NAMESPACE_PROBE_TTL_MS}. */
export function codexUserNamespaceRefusal(now: number = Date.now()): string | undefined {
  if (cached && now - cached.at >= 0 && now - cached.at < CODEX_USER_NAMESPACE_PROBE_TTL_MS) {
    return cached.refusal;
  }
  const refusal = probeCodexUserNamespace();
  cached = { refusal, at: now };
  return refusal;
}

/** Tests only: forget the cached answer. */
export function resetCodexUserNamespaceProbeForTests(): void {
  cached = undefined;
}
