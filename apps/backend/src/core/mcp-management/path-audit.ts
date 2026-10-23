/**
 * Container path audit: a definition copied from the backend user can name
 * a command or working directory that exists only on the backend's
 * computer. Each such row gets a warning; nothing is installed or rewritten,
 * and a missing binary stays an actionable runtime failure.
 */

import {
  MCP_MANAGEMENT_LIMITS,
  visibleCommand,
  type McpDefinitionSummary,
} from "@orkestrator/protocol/mcp-management";

import type { LoadedCatalog } from "./catalog.js";
import type { ContainerPathProbe } from "./types.js";

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;

export async function auditContainerPaths(
  catalog: LoadedCatalog,
  definitions: McpDefinitionSummary[],
  containerId: string,
  probe: ContainerPathProbe,
): Promise<void> {
  const byEntry = new Map(definitions.map((definition) => [definition.entryId, definition]));
  const checks: Array<{ entryId: string; path: string; kind: "command" | "cwd"; shown: boolean }> =
    [];
  const windows: Array<{ entryId: string; kind: "command" | "cwd"; shown: string | null }> = [];
  for (const entry of catalog.entries) {
    const definition = entry.definition;
    if (!definition || !byEntry.has(entry.entryId) || definition.transport !== "stdio") continue;
    for (const [kind, value] of [
      ["command", definition.command],
      ["cwd", definition.cwd],
    ] as const) {
      if (!value) continue;
      const shown = kind === "cwd" || visibleCommand(value).kind === "visible";
      if (WINDOWS_PATH.test(value))
        windows.push({ entryId: entry.entryId, kind, shown: shown ? value : null });
      else if (value.startsWith("/"))
        checks.push({ entryId: entry.entryId, path: value, kind, shown });
    }
  }
  const warn = (entryId: string, message: string) => {
    const definition = byEntry.get(entryId)!;
    definition.warnings = [...(definition.warnings ?? []), message];
  };
  for (const item of windows) {
    warn(
      item.entryId,
      item.kind === "command"
        ? `This command is a Windows path${item.shown ? ` (${item.shown})` : ""} and cannot run in this Linux container. Change it to a command installed in the container.`
        : `This working directory is a Windows path (${item.shown}) and does not exist in this Linux container.`,
    );
  }
  const unique = [...new Set(checks.map((check) => check.path))].slice(
    0,
    MCP_MANAGEMENT_LIMITS.containerPathProbesMax,
  );
  if (!unique.length) return;
  const found = await probe(containerId, unique).catch(() => null);
  if (!found) return;
  for (const check of checks) {
    const state = found.get(check.path);
    if (!state) continue;
    const name = check.shown ? ` ${check.path}` : "";
    if (check.kind === "command" && state !== "file")
      warn(
        check.entryId,
        state === "absent"
          ? `The command${name} does not exist in this container; it may be a path from the backend's computer. Install it in the container or change the path. Orkestrator does not install anything.`
          : `The command${name} is a directory in this container, not a program.`,
      );
    if (check.kind === "cwd" && state !== "directory")
      warn(
        check.entryId,
        `The working directory${name} does not exist in this container; it may be a path from the backend's computer.`,
      );
  }
}
