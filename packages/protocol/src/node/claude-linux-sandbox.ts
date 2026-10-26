/**
 * Whether the Claude CLI's command sandbox can run commands on this Linux host.
 *
 * The CLI checks only that `bwrap` and `socat` are on `PATH`. It then runs each
 * command under bubblewrap (`--unshare-user --unshare-pid … --proc /proc`) and,
 * inside that, its embedded `apply-seccomp` helper, which creates a second user
 * namespace with its own PID and mount namespaces. Ubuntu's AppArmor package
 * ships a `bwrap-userns-restrict` profile that lets bubblewrap create its
 * namespace but strips capabilities from anything nested in it, so on a stock
 * Ubuntu 26.04 host the sandbox starts and every command then fails with
 * `apply-seccomp: write /proc/self/setgroups (nested userns is
 * capability-restricted …): Permission denied`.
 *
 * So the probe runs what the CLI needs rather than looking for programs:
 * bubblewrap creating a user namespace with a nested one inside it. A host that
 * fails is reported with a reason naming the cause, never as able to sandbox.
 *
 * Node-only: the backend (coordinator qualification) and the Claude bridge
 * (the interactive provider sandbox) import this subpath, never a renderer.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Programs the Claude CLI's Linux sandbox needs on PATH (it names both when one is missing). */
export const CLAUDE_LINUX_SANDBOX_PROGRAMS = Object.freeze(["bwrap", "socat"]);

/** Ubuntu's AppArmor profile that strips capabilities from nested namespaces. */
export const APPARMOR_BWRAP_PROFILE = "/etc/apparmor.d/bwrap-userns-restrict";

/** Each probe command's ceiling. The CLI bounds its own bubblewrap probe the same way. */
export const CLAUDE_LINUX_SANDBOX_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long one probe answer is reused. Long enough that a picker, a launch and
 * every prompt in a burst share one run; short enough that a host whose policy
 * the user has just changed is re-read without restarting Orkestrator.
 */
export const CLAUDE_LINUX_SANDBOX_PROBE_TTL_MS = 5 * 60_000;

/** The outer namespace, set up the way the CLI sets up its own. */
const BWRAP_ARGS = Object.freeze([
  "--new-session",
  "--die-with-parent",
  "--unshare-user",
  "--unshare-pid",
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--",
]);

/**
 * What `apply-seccomp` does inside it: a user namespace that maps root (which
 * writes `setgroups`, `uid_map` and `gid_map`), then PID and mount namespaces
 * and a fresh `/proc`. util-linux and BusyBox both accept these options.
 */
const NESTED_ARGS = Object.freeze([
  "unshare",
  "--user",
  "--map-root-user",
  "--pid",
  "--mount",
  "--fork",
  "--mount-proc",
  "true",
]);

export type ClaudeLinuxSandboxFailure =
  /** `bwrap` or `socat` is not on PATH; the CLI refuses a required sandbox. */
  | "missing-programs"
  /** `unshare` is not on PATH, so the nested namespace cannot be checked. */
  | "probe-unavailable"
  /** bubblewrap cannot create its own user namespace. */
  | "user-namespace"
  /** bubblewrap starts, but a user namespace nested inside it is refused. */
  | "nested-user-namespace";

export type ClaudeLinuxSandboxStatus =
  | { available: true }
  | { available: false; failure: ClaudeLinuxSandboxFailure; reason: string };

export interface ClaudeLinuxSandboxProbeResult {
  ok: boolean;
  /** The command's own error output, or why it could not run. */
  stderr: string;
}

export interface ClaudeLinuxSandboxProbeDependencies {
  onPath?: (name: string) => boolean;
  run?: (command: string, args: readonly string[]) => ClaudeLinuxSandboxProbeResult;
  /** Whether AppArmor is enabled and Ubuntu's bwrap profile is installed. */
  appArmorBwrapProfile?: () => boolean;
}

/** Whether `name` is an executable file in one of `PATH`'s directories. */
export function executableOnPath(
  name: string,
  path: string | undefined = process.env.PATH,
): boolean {
  for (const directory of (path ?? "").split(delimiter)) {
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

function runProbeCommand(command: string, args: readonly string[]): ClaudeLinuxSandboxProbeResult {
  const result = spawnSync(command, [...args], {
    timeout: CLAUDE_LINUX_SANDBOX_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  if (result.error) return { ok: false, stderr: result.error.message };
  return { ok: result.status === 0, stderr: result.stderr ?? "" };
}

function appArmorBwrapProfileInstalled(): boolean {
  try {
    const enabled = readFileSync("/sys/module/apparmor/parameters/enabled", "utf8");
    return enabled.trim().startsWith("Y") && existsSync(APPARMOR_BWRAP_PROFILE);
  } catch {
    return false;
  }
}

/** The first line of a probe's error output, bounded for a reason string. */
function probeDetail(stderr: string): string {
  const line =
    stderr
      .split("\n")
      .map((entry) => entry.trim())
      .find(Boolean) ?? "no error output";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const UNAVAILABLE = "Claude's command sandbox cannot run commands on this host";

/** Run the probe now. Prefer {@link claudeLinuxSandboxStatus}, which caches it. */
export function probeClaudeLinuxSandbox(
  dependencies: ClaudeLinuxSandboxProbeDependencies = {},
): ClaudeLinuxSandboxStatus {
  const onPath = dependencies.onPath ?? ((name: string) => executableOnPath(name));
  const run = dependencies.run ?? runProbeCommand;
  const appArmorBwrapProfile = dependencies.appArmorBwrapProfile ?? appArmorBwrapProfileInstalled;

  const missing = CLAUDE_LINUX_SANDBOX_PROGRAMS.filter((name) => !onPath(name));
  if (missing.length > 0) {
    return {
      available: false,
      failure: "missing-programs",
      reason: `${UNAVAILABLE}: the Claude CLI's Linux sandbox needs bubblewrap and socat on PATH, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing. Install the bubblewrap and socat packages.`,
    };
  }
  if (!onPath("unshare")) {
    return {
      available: false,
      failure: "probe-unavailable",
      reason: `${UNAVAILABLE}: whether a user namespace can be nested inside bubblewrap's, which the Claude CLI needs, could not be checked because unshare (util-linux) is not on PATH.`,
    };
  }

  const nested = run("bwrap", [...BWRAP_ARGS, ...NESTED_ARGS]);
  if (nested.ok) return { available: true };

  // Tell the two stages apart, so the reason names the policy that refused.
  const outer = run("bwrap", [...BWRAP_ARGS, "true"]);
  if (!outer.ok) {
    return {
      available: false,
      failure: "user-namespace",
      reason: `${UNAVAILABLE}: bubblewrap cannot create a user namespace (${probeDetail(outer.stderr)}). Unprivileged user namespaces are turned off or restricted here, for example by kernel.unprivileged_userns_clone, AppArmor's kernel.apparmor_restrict_unprivileged_userns, or a container's seccomp profile.`,
    };
  }
  const detail = probeDetail(nested.stderr);
  if (appArmorBwrapProfile()) {
    return {
      available: false,
      failure: "nested-user-namespace",
      reason: `${UNAVAILABLE}: bubblewrap starts, but AppArmor's bwrap-userns-restrict profile strips capabilities from the user namespace the Claude CLI nests inside it, so every sandboxed command would fail (${detail}). Allow nested namespaces for bubblewrap with a local AppArmor profile, or remove bwrap-userns-restrict on a dedicated host; Orkestrator does not change AppArmor policy itself.`,
    };
  }
  return {
    available: false,
    failure: "nested-user-namespace",
    reason: `${UNAVAILABLE}: bubblewrap starts, but a user namespace nested inside it is refused (${detail}), and the Claude CLI's command helper needs one, so every sandboxed command would fail. In a container this is usually the container's seccomp profile or missing capabilities.`,
  };
}

let cached: { status: ClaudeLinuxSandboxStatus; at: number } | undefined;
let pinned: ClaudeLinuxSandboxStatus | undefined;

/**
 * The probe's answer, run at most once per {@link CLAUDE_LINUX_SANDBOX_PROBE_TTL_MS}.
 *
 * Synchronous on purpose: the coordinator table and the bridge's prompt route
 * are synchronous, and the probe is two short-lived processes (a few
 * milliseconds on a working host), each bounded by
 * {@link CLAUDE_LINUX_SANDBOX_PROBE_TIMEOUT_MS}.
 */
export function claudeLinuxSandboxStatus(now: number = Date.now()): ClaudeLinuxSandboxStatus {
  if (pinned) return pinned;
  if (cached && now - cached.at >= 0 && now - cached.at < CLAUDE_LINUX_SANDBOX_PROBE_TTL_MS) {
    return cached.status;
  }
  const status = probeClaudeLinuxSandbox();
  cached = { status, at: now };
  return status;
}

/**
 * Tests only: answer `status` without probing, or probe again when absent.
 * The node test preload pins `available`, so a suite that mocks the CLI does
 * not depend on the machine's bubblewrap; a test of the refusal injects its own.
 */
export function setClaudeLinuxSandboxStatusForTests(
  status: ClaudeLinuxSandboxStatus | undefined,
): void {
  pinned = status;
  cached = undefined;
}
