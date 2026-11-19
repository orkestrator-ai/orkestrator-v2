/**
 * MCP servers of a project setup, in a worktree's project MCP file
 * (docs/architecture/agent-capabilities-management.md, "Shared locations and
 * isolation").
 *
 * The server entry is written by this machine's MCP management, through the
 * environment's own target and the provider's project source
 * (`mcpManagementInstaller` with an environment scope in `index.ts`): the
 * same format-preserving editors, revisions and ownership fingerprints as the
 * MCP servers settings. Only the definition is written; environment and
 * header keys stay names, and the user supplies their values on that machine
 * (until then the server is `needs-auth`). This module adds what a worktree
 * needs beyond that:
 *
 * - whether Orkestrator created the file. A file Orkestrator created is kept
 *   out of Git (`info/exclude`) and deleted when its last server is removed
 *   and nothing else is left in it; a file that was already there (the
 *   user's own, untracked) is edited in place and never deleted. A tracked
 *   file, or one behind a link, is a collision (`worktree-writer.ts`).
 * - observation for the scoped pass: present (the recorded digest), missing
 *   (null) or changed by hand (a different value, so it is a local change).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { McpInstaller } from "./executor.js";
import {
  projectMcpLocation,
  projectMcpLocationFor,
  type ProjectMcpLocation,
} from "./scoped-locations.js";
import type { CapabilitiesStorage } from "../storage-capabilities.js";
import type { CapabilityExecutorState } from "./types.js";

export interface ProjectMcpContext {
  storage: { capabilities: CapabilitiesStorage };
  /** This machine (the executor's keys start with it). */
  nodeId: string;
  environmentId: string;
  worktree: string;
}

const MAX_FILE_BYTES = 1024 * 1024;

function keyPrefix(nodeId: string, environmentId: string, locationId: string): string {
  return `${nodeId}|env:${environmentId}|${locationId}|`;
}

function appliedAt(
  executor: CapabilityExecutorState,
  context: Pick<ProjectMcpContext, "nodeId" | "environmentId">,
  locationId: string,
) {
  const prefix = keyPrefix(context.nodeId, context.environmentId, locationId);
  return Object.entries(executor.applied).filter(
    ([key, entry]) => key.startsWith(prefix) && entry.mcp !== undefined,
  );
}

function filePath(worktree: string, location: ProjectMcpLocation): string {
  return path.join(worktree, ...location.relative.split("/"));
}

/** A project MCP file holding nothing but an empty server map (or nothing at all). */
export function isEmptyProjectMcpFile(text: string, location: ProjectMcpLocation): boolean {
  if (location.format === "toml") {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .every((line) => line === `[${location.serverKey}]`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return true;
    const servers = (parsed as Record<string, unknown>)[location.serverKey];
    return (
      keys.length === 1 &&
      keys[0] === location.serverKey &&
      !!servers &&
      typeof servers === "object" &&
      !Array.isArray(servers) &&
      Object.keys(servers).length === 0
    );
  } catch {
    return false;
  }
}

async function deleteIfEmpty(file: string, location: ProjectMcpLocation): Promise<void> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return;
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text !== null && isEmptyProjectMcpFile(text, location))
    await fs.unlink(file).catch(() => undefined);
}

/**
 * The environment's MCP installer, with the worktree's file ownership: an
 * install records whether Orkestrator created the file, and the removal of
 * the last server Orkestrator added deletes a file it created once it is
 * empty.
 */
export function projectMcpInstaller(base: McpInstaller, context: ProjectMcpContext): McpInstaller {
  return {
    ...(base.configured
      ? { configured: (provider, definition) => base.configured!(provider, definition) }
      : {}),
    ...(base.observe ? { observe: (ownership) => base.observe!(ownership) } : {}),
    async install(input) {
      const location = projectMcpLocationFor(input.provider);
      if (!location) {
        return {
          status: "unsupported",
          reason: `${input.provider} reads no project MCP file, so a project setup cannot give it MCP servers; add them to My setup instead.`,
        };
      }
      const file = filePath(context.worktree, location);
      const stat = await fs.lstat(file).catch(() => null);
      if (stat && !stat.isFile()) {
        return {
          status: "failed",
          reason: `${location.relative} in this worktree is not a regular file; Orkestrator does not write through it.`,
        };
      }
      const executor = await context.storage.capabilities.loadCapabilityExecutorState();
      const created =
        !stat ||
        input.previous?.createdFile === true ||
        appliedAt(executor, context, location.id).some(([, entry]) => entry.mcp?.createdFile);
      const result = await base.install(input);
      if (!result.ownership) return result;
      return {
        ...result,
        ownership: { ...result.ownership, ...(created ? { createdFile: true } : {}) },
      };
    },
    async remove(input) {
      const result = await base.remove(input);
      const location = projectMcpLocationFor(input.provider);
      if (result.status !== "ready" || !input.previous.createdFile || !location) return result;
      const executor = await context.storage.capabilities.loadCapabilityExecutorState();
      const others = appliedAt(executor, context, location.id).filter(
        ([, entry]) => entry.mcp?.name !== input.name,
      );
      if (others.length === 0) await deleteIfEmpty(filePath(context.worktree, location), location);
      return result;
    },
  };
}

/**
 * The scoped pass's view of project MCP receipts: the recorded digest while
 * the entry Orkestrator wrote is there unchanged, null when it is gone, and
 * a different value when it was changed by hand. When MCP management cannot
 * answer, the recorded digest stands (a removal is still attempted).
 */
export async function observeProjectMcpEntries(
  storage: { capabilities: CapabilitiesStorage },
  installer: McpInstaller | undefined,
  keys: readonly string[],
): Promise<Map<string, string | null>> {
  const observed = new Map<string, string | null>();
  if (keys.length === 0) return observed;
  const executor = await storage.capabilities.loadCapabilityExecutorState();
  for (const key of keys) {
    const applied = executor.applied[key];
    if (!applied?.mcp) {
      observed.set(key, null);
      continue;
    }
    const seen = installer?.observe
      ? await installer.observe(applied.mcp).catch(() => "unavailable" as const)
      : "unavailable";
    if (seen !== "unavailable") {
      observed.set(
        key,
        seen === "missing"
          ? null
          : seen === "drifted"
            ? `changed:${applied.digest}`
            : applied.digest,
      );
    }
  }
  return observed;
}

/**
 * The project MCP files to keep out of Git: those Orkestrator created (from
 * this machine's executor record), and the files `writing` is about to create.
 */
export async function projectMcpExcludeFiles(
  context: ProjectMcpContext,
  writing: ReadonlyArray<{ locationId: string }>,
): Promise<string[]> {
  const files = new Set<string>();
  const executor = await context.storage.capabilities.loadCapabilityExecutorState();
  for (const [key, entry] of Object.entries(executor.applied)) {
    if (!entry.mcp?.createdFile) continue;
    const prefix = `${context.nodeId}|env:${context.environmentId}|`;
    if (!key.startsWith(prefix)) continue;
    const location = projectMcpLocation(key.slice(prefix.length).split("|")[0] ?? "");
    if (location) files.add(location.relative);
  }
  for (const entry of writing) {
    const location = projectMcpLocation(entry.locationId);
    if (!location || files.has(location.relative)) continue;
    const exists = await fs.lstat(filePath(context.worktree, location)).catch(() => null);
    if (!exists) files.add(location.relative);
  }
  return [...files].sort();
}
