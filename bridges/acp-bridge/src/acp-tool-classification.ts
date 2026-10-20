/**
 * What kind of work an ACP tool call does, decided from what the agent has
 * said about it so far.
 *
 * ACP agents name a call's kind and tool late: Grok can send a bare
 * `tool_call` and only name `run_terminal_cmd` in a later `tool_call_update`.
 * Every answer here is therefore provisional, and callers re-ask on each
 * update. Shared by the shell measurement (`acp-command-changes.ts`) and the
 * change-evidence adapter (`change-evidence.ts`), so the two never disagree
 * about which call is a command.
 */

import type { ToolKind } from "@orkestrator/protocol/change-evidence";
import { isFileEditToolName } from "@orkestrator/protocol/tool-diff";
import type { AcpToolSourceState } from "./acp-context.js";

/**
 * Tool names that run a shell command, for agents that do not set the
 * standard `execute` kind. Grok's is `run_terminal_cmd` (`run_terminal_command`
 * in its docs); the rest are the names other ACP agents use.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "terminal",
  "run_terminal_cmd",
  "run_terminal_command",
  "run_command",
  "execute_command",
]);
/** ACP tool kinds that change files by some means other than a command. */
export const FILE_CHANGE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);
/** Grok's own file tools, which the shared edit-name list does not know. */
const FILE_CHANGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_replace",
  "write_file",
  "delete_file",
]);

/**
 * Runtime-specific facts about the ACP agent this bridge drives. The bridge is
 * an ACP protocol adapter; a descriptor adds only what the protocol leaves to
 * the agent: its own file-tool names and what it lets a client observe.
 */
export interface AcpRuntimeDescriptor {
  /** Stable runtime name; namespaces evidence binding ids only. */
  name: string;
  /** Agent tool names (lower case) that change files, by canonical kind. */
  fileToolKinds: Readonly<Record<string, ToolKind>>;
  /**
   * Whether work a call leaves running (a background command, a sub-agent)
   * reports its completion to the client.
   */
  backgroundCompletion: "observable" | "launch-only" | "unknown";
}

/**
 * Grok Build. Its mutation tools are `write`, `search_replace`,
 * `run_terminal_cmd` and `Agent` (the read-only agent profile in
 * `acp-readonly-profile.ts` removes exactly these); `write_file` and
 * `delete_file` are the names older builds used. A sub-agent's end arrives as
 * `subagent_finished`, but a background terminal command reports only its
 * launch, so background completion is launch-only.
 */
export const GROK_RUNTIME: AcpRuntimeDescriptor = {
  name: "grok",
  fileToolKinds: {
    write: "file-write",
    write_file: "file-write",
    search_replace: "file-edit",
    delete_file: "file-delete",
  },
  backgroundCompletion: "launch-only",
};

/** Provider ids that name Grok. */
const GROK_ALIASES: ReadonlySet<string> = new Set(["grok", "grok-build", "xai-grok"]);

/** Any other ACP agent: only what the protocol itself guarantees. */
export function genericAcpRuntime(providerId: string): AcpRuntimeDescriptor {
  const name = providerId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 64);
  return { name: name || "acp", fileToolKinds: {}, backgroundCompletion: "unknown" };
}

export function acpRuntimeDescriptor(providerId: string): AcpRuntimeDescriptor {
  return GROK_ALIASES.has(providerId.trim().toLowerCase())
    ? GROK_RUNTIME
    : genericAcpRuntime(providerId);
}

export function acpToolNames(source: AcpToolSourceState): string[] {
  return [source.explicitName, source.inputName, source.metadataName].flatMap((name) => {
    const normalized = name?.trim().toLowerCase();
    return normalized ? [normalized] : [];
  });
}

/** Whether the call is known to run a shell command. */
export function isAcpShellCall(source: AcpToolSourceState): boolean {
  const kind = source.kind?.trim().toLowerCase();
  return kind === "execute" || acpToolNames(source).some((name) => SHELL_TOOL_NAMES.has(name));
}

/**
 * A command that returns as soon as it has started something that keeps
 * running. Its window would close long before the process stops writing, so a
 * count would be both partial and misleading.
 */
export function isBackgroundLaunch(args: AcpToolSourceState["toolArgs"]): boolean {
  return (
    args?.background === true ||
    args?.run_in_background === true ||
    args?.is_background === true ||
    args?.isBackground === true
  );
}

/** Whether a call should be measured, noted, or left alone. */
export function commandChangeRole(source: AcpToolSourceState): "measure" | "note" | undefined {
  if (isAcpShellCall(source)) {
    return isBackgroundLaunch(source.toolArgs) ? undefined : "measure";
  }
  const kind = source.kind?.trim().toLowerCase();
  const names = acpToolNames(source);
  if (
    (kind !== undefined && FILE_CHANGE_KINDS.has(kind)) ||
    names.some((name) => isFileEditToolName(name) || FILE_CHANGE_TOOL_NAMES.has(name)) ||
    source.contentDiffs.length > 0
  ) {
    return "note";
  }
  return undefined;
}

/** The canonical tool kind, as far as the agent has described the call. */
export function acpToolKind(source: AcpToolSourceState, runtime: AcpRuntimeDescriptor): ToolKind {
  if (isAcpShellCall(source)) return "shell";
  const names = acpToolNames(source);
  for (const name of names) {
    if (Object.hasOwn(runtime.fileToolKinds, name)) return runtime.fileToolKinds[name]!;
  }
  const kind = source.kind?.trim().toLowerCase();
  if (kind === "edit") return "file-edit";
  if (kind === "delete") return "file-delete";
  if (kind === "move") return "file-move";
  if (names.some((name) => isFileEditToolName(name)) || source.contentDiffs.length > 0) {
    return "file-edit";
  }
  if (kind === "read") return "read";
  return "other";
}
