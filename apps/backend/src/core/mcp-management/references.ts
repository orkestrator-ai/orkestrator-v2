/**
 * Provider-owned references to a server *name* that live outside the server
 * map: Claude Code's per-project enable/disable lists, OpenCode's tool
 * switches keyed by `<server>_<tool>`. A rename moves only the map key, so
 * these keep naming the old server. They are reported, not rewritten: the
 * document edit is verified as exactly one key move, and widening that to
 * list rewrites across projects would weaken the guarantee that nothing else
 * in the file changed.
 */

import type { LoadedCatalog, LoadedSource } from "./catalog.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listsName(value: unknown, name: string): boolean {
  return Array.isArray(value) && value.includes(name);
}

const MAX_NAMED_PROJECTS = 3;

function projectList(projects: string[]): string {
  const shown = projects.slice(0, MAX_NAMED_PROJECTS).map((project) => `"${project}"`);
  const more = projects.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/** Claude Code keeps per-project lists in `~/.claude.json` that name servers. */
function claudeReferences(catalog: LoadedCatalog, source: LoadedSource, name: string): string[] {
  const warnings: string[] = [];
  // The private local map lives at `projects[<worktree>]`; a project file is rooted at it.
  const worktree =
    source.spec.sourceId === "claude:local" ? source.spec.subtree[1] : source.spec.allowedRoot;
  const home = catalog.sources.find(
    (candidate) =>
      candidate.spec.provider === "claude" && candidate.spec.sourceId === "claude:user",
  );
  const document = home?.parsed?.document;
  const projects = isRecord(document) && isRecord(document.projects) ? document.projects : {};
  const scan = (keys: readonly string[], only?: string) => {
    const hits = new Map<string, string[]>();
    for (const [project, settings] of Object.entries(projects)) {
      if (only !== undefined && project !== only) continue;
      if (!isRecord(settings)) continue;
      for (const key of keys) {
        if (!listsName(settings[key], name)) continue;
        hits.set(key, [...(hits.get(key) ?? []), project]);
      }
    }
    return hits;
  };
  const sourceId = source.spec.sourceId;
  if (sourceId === "claude:user" || sourceId === "claude:local") {
    // `/mcp disable` persists user/local servers to the project entry's list.
    const hits = scan(["disabledMcpServers"], sourceId === "claude:local" ? worktree : undefined);
    for (const [key, projectsNaming] of hits) {
      warnings.push(
        `${home!.spec.displayPath} lists "${name}" in ${key} for ${projectList(projectsNaming)}. ` +
          "That list keeps the old name, so the renamed server will be enabled there; disable it again with /mcp if needed.",
      );
    }
  } else if (sourceId === "claude:project" && worktree) {
    const hits = scan(["enabledMcpjsonServers", "disabledMcpjsonServers"], worktree);
    for (const key of hits.keys()) {
      warnings.push(
        `${home!.spec.displayPath} names "${name}" in this project's ${key}. ` +
          "That approval keeps the old name, so Claude Code will ask about the renamed server again.",
      );
    }
  }
  return warnings;
}

/** OpenCode tool switches are keyed `<server>_<tool>`, often as a glob. */
function opencodeReferences(source: LoadedSource, name: string): string[] {
  const document = source.parsed?.document;
  if (!isRecord(document)) return [];
  const prefix = `${name}_`;
  const keys = new Set<string>();
  const collect = (tools: unknown, where: string) => {
    if (!isRecord(tools)) return;
    for (const key of Object.keys(tools)) if (key.startsWith(prefix)) keys.add(`${where}${key}`);
  };
  collect(document.tools, "tools.");
  if (isRecord(document.agent)) {
    for (const [agent, settings] of Object.entries(document.agent))
      if (isRecord(settings)) collect(settings.tools, `agent.${agent}.tools.`);
  }
  if (!keys.size) return [];
  const shown = [...keys].slice(0, 5).join(", ");
  return [
    `This file's tool settings refer to "${name}" (${shown}${keys.size > 5 ? ", …" : ""}). ` +
      "They keep the old name and will no longer match the renamed server's tools.",
  ];
}

/**
 * Warnings for a rename of `name` in `source`. Reads only documents the
 * catalog already loaded; never touches the file system.
 */
export function renameReferenceWarnings(
  catalog: LoadedCatalog,
  source: LoadedSource,
  name: string,
): string[] {
  switch (source.spec.provider) {
    case "claude":
      return claudeReferences(catalog, source, name);
    case "opencode":
      return opencodeReferences(source, name);
    default:
      return [];
  }
}
