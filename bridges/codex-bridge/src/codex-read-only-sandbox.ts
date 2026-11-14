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
 * `untrusted` approval policy Codex runs without asking only the reading
 * programs the bridge's exec-policy rules allow
 * (`codex-read-only-exec-rules.ts`; the pinned Codex has no built-in list of
 * safe commands any more), and the bridge declines every approval the turn
 * asks for at once (`approvalRefusal`, the server-request router's `refuseApproval`),
 * MCP tool approvals included, so nothing else runs and an unattended review
 * does not wait on a card nobody will answer. The network denial and
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
 * neither, the bridge probes whether the host lets a process create a user
 * namespace (`codex-user-namespace-probe.ts`): Ubuntu's AppArmor restriction
 * or a kernel with unprivileged namespaces off fails every Codex command the
 * same way. Only a refusal the probe saw (a helper's exit naming a failed
 * namespace operation) turns the sandbox off; a host that allows the
 * namespace, or one the probe cannot judge (a timeout, a spawn error, any
 * other failure), keeps Codex's sandbox.
 */
import { existsSync } from "node:fs";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

import { codexUserNamespaceRefusal } from "./codex-user-namespace-probe.js";

export const CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER =
  "Codex's command sandbox cannot run commands in this container: its Linux sandbox (bubblewrap) needs an unprivileged user namespace, which the container refuses.";

/** The host counterpart: `detail` is the probe's first line of error output. */
export function codexReadOnlySandboxOffOnHost(detail: string): string {
  return `Codex's command sandbox cannot run commands on this host: its Linux sandbox (bubblewrap) needs an unprivileged user namespace, which the host refuses (${detail}). Unprivileged user namespaces are turned off or restricted here, for example by kernel.unprivileged_userns_clone or AppArmor's kernel.apparmor_restrict_unprivileged_userns; Orkestrator does not change that policy itself.`;
}

/** Shown in the transcript for each approval a sandbox-off read-only turn declines. */
export const CODEX_READ_ONLY_APPROVAL_REFUSAL =
  "Codex asked to run something outside the commands it treats as read-only. Orkestrator declined it: this read-only turn runs without Codex's command sandbox, so it may only read.";

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
    /** The host's refusal of a user namespace (first error line), if any. */
    userNamespaceRefusal?: () => string | undefined;
  } = {},
): string | undefined {
  if (options.permissionProfile || options.policy?.id === "coordinator-read-only") return undefined;
  if ((options.platform ?? process.platform) !== "linux") return undefined;
  const container =
    options.policy?.sandbox === "container" ||
    options.policy?.id === "interactive-container" ||
    (options.inContainer ?? runningInContainer)();
  if (container) return CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER;
  const refusal = (options.userNamespaceRefusal ?? codexUserNamespaceRefusal)();
  return refusal === undefined ? undefined : codexReadOnlySandboxOffOnHost(refusal);
}
