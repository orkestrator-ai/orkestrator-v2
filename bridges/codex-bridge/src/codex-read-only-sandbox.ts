/**
 * Whether a read-only turn can use Codex's own command sandbox, and what it
 * runs under when it cannot.
 *
 * A `readOnly` prompt (Multi Review's reviewer and consolidation reports)
 * asks Codex for its `read-only` sandbox. On Linux Codex enforces that by
 * running every shell command under bubblewrap, which needs an unprivileged
 * user namespace. An environment's container refuses one (Docker's default
 * seccomp profile, no `CAP_SYS_ADMIN`), so every command failed before it
 * started and a reviewer could not read the package it was asked to review:
 * it reported itself blocked with no findings.
 *
 * Where the sandbox cannot run, the turn runs without it, the way Claude's
 * read-only turn does (`claudeReadOnlyCommandSandbox`): under Codex's
 * `untrusted` approval policy the pinned Codex asks before every command no
 * exec-policy rule allows, reads included, and the bridge answers each
 * approval itself at once (`approvalGate`). A command the bridge proves only
 * reads (`codex-read-only-commands.ts`) is approved; every other command, a
 * file change, a permission request and an MCP tool approval are declined,
 * so nothing else runs and an unattended review does not wait on a card
 * nobody will answer. The network denial and
 * the read-only policy are kept; the container firewall still holds the
 * network. The session reports the reason on `/session/:id/status` as
 * `readOnlyCommandSandbox`, which Multi Review shows on the reviewer.
 *
 * A container is recognised from either side. The bridge's own process sees
 * Docker's `/.dockerenv` or Podman's `/run/.containerenv` whatever policy the
 * session carries: a containerised environment can resolve to a `provider`
 * or `none` sandbox (full network, a sandbox override, the `pipeline` policy
 * id), and its bubblewrap is refused all the same. The session's policy also
 * counts on its own (`sandbox: "container"`, or `interactive-container` under
 * an override), for a bridge that cannot see a marker. On a Linux host with
 * neither, Codex's sandbox stays on: a host whose policy refuses bubblewrap's
 * namespace is not probed here yet.
 */
import { existsSync } from "node:fs";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

export const CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER =
  "Codex's command sandbox cannot run commands in this container: its Linux sandbox (bubblewrap) needs an unprivileged user namespace, which the container refuses.";

/**
 * Shown in the transcript for an approval a sandbox-off read-only turn
 * declines that is not a command (a file change, a permission request). A
 * declined command gets its own reason from `codexReadOnlyCommandVerdict`.
 */
export const CODEX_READ_ONLY_APPROVAL_REFUSAL =
  "Codex asked for something other than a reading command. Orkestrator declined it: this read-only turn runs without Codex's command sandbox, so it may only read.";

/** Shown for an MCP tool approval a sandbox-off read-only turn declines. */
export const CODEX_READ_ONLY_MCP_APPROVAL_REFUSAL =
  "Codex asked to call an MCP tool that needs approval. Orkestrator declined it: this read-only turn runs without Codex's command sandbox, and its approvals never wait on a person.";

/** Docker always creates `/.dockerenv`, Podman `/run/.containerenv`. */
function runningInContainer(): boolean {
  return existsSync("/.dockerenv") || existsSync("/run/.containerenv");
}

/**
 * Why a read-only turn under `policy` runs without Codex's command sandbox,
 * or undefined when the sandbox can run.
 *
 * A coordinator is never changed here: it runs under its launcher's
 * permission profile, which this does not touch.
 */
export function codexReadOnlyCommandSandboxOff(
  options: {
    policy?: NativeAgentExecutionPolicy;
    permissionProfile?: string;
    platform?: NodeJS.Platform;
    inContainer?: () => boolean;
  } = {},
): string | undefined {
  if (options.permissionProfile || options.policy?.id === "coordinator-read-only") return undefined;
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const container =
    options.policy?.sandbox === "container" ||
    options.policy?.id === "interactive-container" ||
    (options.inContainer ?? runningInContainer)();
  return container ? CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER : undefined;
}
