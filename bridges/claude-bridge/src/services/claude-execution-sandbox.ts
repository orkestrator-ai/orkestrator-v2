import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import {
  claudeLinuxSandboxStatus,
  type ClaudeLinuxSandboxStatus,
} from "@orkestrator/protocol/node/claude-linux-sandbox";
import {
  COORDINATOR_COMMAND_SANDBOX_ENV,
  coordinatorCommandSandboxFromEnv,
  type CoordinatorCommandSandbox,
} from "@orkestrator/protocol/coordinator";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { claudeWorkspaceCwd } from "./claude-query-config.js";
import {
  claudeReadOnlySandbox,
  isCoordinatorReadOnlyPolicy,
  processExecutionPolicyIsCoordinator,
} from "./read-only-policy.js";

/**
 * The paths a read-only turn's commands may not write: the checkout as named
 * and as resolved, since a symlinked path and its target are one directory.
 */
export function claudeReadOnlyWorkspaces(cwd: string): string[] {
  let resolved: string | undefined;
  try {
    resolved = realpathSync(cwd);
  } catch {
    resolved = undefined;
  }
  return [...new Set([cwd, ...(resolved ? [resolved] : [])])];
}

/** Where the platform has no Linux probe answer to give (Windows). */
const READ_ONLY_SANDBOX_UNSUPPORTED =
  "Claude's command sandbox cannot run commands on this host: it needs macOS, or Linux whose bubblewrap can nest a user namespace.";

/**
 * Whether a read-only turn asks the CLI for its command sandbox, and why not.
 *
 * A coordinator's launcher has already probed and says so in
 * `COORDINATOR_COMMAND_SANDBOX_ENV`; its answer stands, and in a coordinator
 * process an absent or malformed one reads as `required`, so an older
 * launcher never turns a missing sandbox into an unsandboxed coordinator
 * (`claudeSandboxRefusal` refuses a host that cannot give it). An ordinary
 * bridge has no launcher answer, so a read-only review
 * turn (Multi Review's reports, plan-mode reviewers) decides from the probe
 * where the CLI runs, the way the backend qualifies a coordinator: macOS's
 * Seatbelt always starts, Linux runs the bubblewrap probe, and anything else
 * has no sandbox. Where it cannot run, asking for it would make the pinned
 * CLI refuse the whole turn (no bubblewrap or socat, every container) or fail
 * every command (a bubblewrap that cannot nest the CLI's namespace), so the
 * turn runs with the sandbox off and the read-only hook and tool allowlist as
 * its boundary, exactly as an `unavailable` coordinator does.
 * `reason` is the probe's, for the turn's reported policy and Multi Review.
 */
export function claudeReadOnlyCommandSandbox(
  options: {
    /** The launcher's answer, as set in `COORDINATOR_COMMAND_SANDBOX_ENV`; absent outside a coordinator. */
    commandSandbox?: string;
    /** Whether this bridge is a coordinator process; read from the environment when absent. */
    coordinatorProcess?: boolean;
    platform?: NodeJS.Platform;
    linuxSandbox?: () => ClaudeLinuxSandboxStatus;
  } = {},
): { commandSandbox: CoordinatorCommandSandbox; reason?: string } {
  const launcher =
    "commandSandbox" in options
      ? options.commandSandbox
      : process.env[COORDINATOR_COMMAND_SANDBOX_ENV];
  if (
    launcher !== undefined ||
    (options.coordinatorProcess ?? processExecutionPolicyIsCoordinator())
  ) {
    return {
      commandSandbox: coordinatorCommandSandboxFromEnv({
        [COORDINATOR_COMMAND_SANDBOX_ENV]: launcher,
      }),
    };
  }
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return { commandSandbox: "required" };
  if (platform !== "linux") {
    return { commandSandbox: "unavailable", reason: READ_ONLY_SANDBOX_UNSUPPORTED };
  }
  const status = (options.linuxSandbox ?? claudeLinuxSandboxStatus)();
  return status.available
    ? { commandSandbox: "required" }
    : { commandSandbox: "unavailable", reason: status.reason };
}

/** The sandbox block passed to the SDK for a real turn. */
export function claudeExecutionSandbox(
  policy: NativeAgentExecutionPolicy | undefined,
  asksForApproval: boolean,
  readOnly: { cwd?: string; commandSandbox?: CoordinatorCommandSandbox } = {},
): Options["sandbox"] {
  if (policy && isCoordinatorReadOnlyPolicy(policy)) {
    return claudeReadOnlySandbox(policy, {
      workspaces: claudeReadOnlyWorkspaces(readOnly.cwd ?? claudeWorkspaceCwd()),
      commandSandbox: readOnly.commandSandbox ?? claudeReadOnlyCommandSandbox().commandSandbox,
    });
  }
  if (policy?.sandbox !== "provider") return undefined;
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: policy.approvals === "auto-approve" && !asksForApproval,
    // Without a human, an escape request would be granted unseen.
    allowUnsandboxedCommands: asksForApproval,
    network: {
      allowLocalBinding: policy.networkAccess === "full",
      // Otherwise an unlisted domain becomes an auto-approved permission request.
      strictAllowlist: policy.networkAccess === "restricted",
    },
  };
}

/**
 * Why this turn cannot run, when it requires a sandbox this host cannot give.
 *
 * The CLI decides that its Linux sandbox is available from the programs alone,
 * so `failIfUnavailable` does not trip on a host whose policy refuses the
 * nested user namespace its seccomp helper creates (Ubuntu's AppArmor
 * `bwrap-userns-restrict`): the turn starts and then every Bash call fails.
 * The bridge runs the same probe as the backend, where the CLI runs (the host,
 * or inside a container), and refuses such a turn before anything is sent.
 *
 * Refused: a provider-sandbox policy, and a coordinator whose launcher
 * qualified it on the sandbox (`required`, or any value but `unavailable`).
 * A read-only review turn in an ordinary bridge (no launcher answer) is never
 * refused: it runs with the sandbox off and the hook as its boundary where the
 * probe finds none (`claudeReadOnlyCommandSandbox`). Only Linux is
 * probed: the nested namespace is a Linux mechanism, and macOS's Seatbelt
 * always starts.
 */
export function claudeSandboxRefusal(
  policy: NativeAgentExecutionPolicy | undefined,
  options: {
    /** The launcher's answer, as set in `COORDINATOR_COMMAND_SANDBOX_ENV`; absent outside a coordinator. */
    commandSandbox?: string;
    platform?: NodeJS.Platform;
    linuxSandbox?: () => ClaudeLinuxSandboxStatus;
  } = {},
): string | undefined {
  if ((options.platform ?? process.platform) !== "linux" || !policy) return undefined;
  const launcher =
    "commandSandbox" in options
      ? options.commandSandbox
      : process.env[COORDINATOR_COMMAND_SANDBOX_ENV];
  const required = isCoordinatorReadOnlyPolicy(policy)
    ? launcher !== undefined && launcher !== "unavailable"
    : policy.sandbox === "provider";
  if (!required) return undefined;
  const status = (options.linuxSandbox ?? claudeLinuxSandboxStatus)();
  return status.available ? undefined : status.reason;
}
