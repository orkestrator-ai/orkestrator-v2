/**
 * Where components live on this machine, and who owns each one
 * (docs/architecture/agent-capabilities-management.md, "Ownership").
 *
 * A location id (`claude-user-skills`) maps to a directory under this
 * machine's own homes; no client ever names a path. Inside a location:
 *
 * - a directory component Orkestrator wrote carries a marker file
 *   (`.orkestrator-capability.json`) with its package, component and the
 *   digest it was written with;
 * - file components (commands, prompts, subagents) are recorded in the
 *   location's index (`.orkestrator-capabilities.json`).
 *
 * Anything without a marker or an index entry is **external**: it is listed,
 * never overwritten and never removed. A managed item whose bytes no longer
 * match the recorded digest has **local changes** (drift) and is preserved
 * until the user decides.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { isSafeCapabilitySegment } from "@orkestrator/protocol/capability-resources";
import {
  CAPABILITY_LOCATIONS,
  capabilityLocation,
  type CapabilityLocation,
} from "@orkestrator/protocol/capability-resources-support";

import {
  CAPABILITY_LOCATION_INDEX,
  CAPABILITY_MARKER_FILE,
  type PackageFile,
  CapabilityError,
  readPackageTree,
  recoverDirectoryReplacement,
  recoverLocationReplacements,
  sha256Hex,
  treeDigest,
  writeFileAtomically,
} from "./security.js";

/** The homes this machine's providers read. Overridable for tests. */
export interface CapabilityHomes {
  home: string;
  claudeConfigDir: string;
  codexHome: string;
  xdgConfigHome: string;
}

export function defaultCapabilityHomes(env: NodeJS.ProcessEnv = process.env): CapabilityHomes {
  const home = os.homedir();
  return {
    home,
    claudeConfigDir: env.CLAUDE_CONFIG_DIR?.trim()
      ? path.resolve(env.CLAUDE_CONFIG_DIR.trim())
      : path.join(home, ".claude"),
    codexHome: env.CODEX_HOME?.trim()
      ? path.resolve(env.CODEX_HOME.trim())
      : path.join(home, ".codex"),
    xdgConfigHome: env.XDG_CONFIG_HOME?.trim()
      ? path.resolve(env.XDG_CONFIG_HOME.trim())
      : path.join(home, ".config"),
  };
}

export function testCapabilityHomes(home: string): CapabilityHomes {
  return {
    home,
    claudeConfigDir: path.join(home, ".claude"),
    codexHome: path.join(home, ".codex"),
    xdgConfigHome: path.join(home, ".config"),
  };
}

/**
 * The homes an `agent-test` backend writes capabilities into. Never the
 * host's: by default a directory of the data directory's own
 * (`capability-test-home`), which no agent reads. An isolated `dev:test`
 * profile (`ORKESTRATOR_AGENT_TEST_ISOLATED=1`) gives its backend and bridges
 * a HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME under its data
 * directory (`createBackendProcessEnvironment`); when every one of them is
 * there, those are the homes, so a delivered capability reaches the
 * profile's own agents and a live spec can qualify it. One home outside the
 * data directory falls back to `capability-test-home` for all of them.
 */
export function agentTestCapabilityHomes(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): CapabilityHomes {
  const fallback = testCapabilityHomes(path.join(dataDir, "capability-test-home"));
  if (env.ORKESTRATOR_AGENT_TEST_ISOLATED !== "1") return fallback;
  const home = env.HOME?.trim();
  if (!home || !path.isAbsolute(home)) return fallback;
  const homes: CapabilityHomes = {
    home: path.resolve(home),
    claudeConfigDir: path.resolve(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude")),
    codexHome: path.resolve(env.CODEX_HOME?.trim() || path.join(home, ".codex")),
    xdgConfigHome: path.resolve(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config")),
  };
  const root = path.resolve(dataDir);
  const inside = (candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  return Object.values(homes).every(inside) ? homes : fallback;
}

const LOCATION_PATHS: Record<string, (homes: CapabilityHomes) => string> = {
  "claude-user-skills": (h) => path.join(h.claudeConfigDir, "skills"),
  "agents-shared-skills": (h) => path.join(h.home, ".agents", "skills"),
  "cursor-user-skills": (h) => path.join(h.home, ".cursor", "skills"),
  "grok-user-skills": (h) => path.join(h.home, ".grok", "skills"),
  "pi-user-skills": (h) => path.join(h.home, ".pi", "agent", "skills"),
  "opencode-user-skills": (h) => path.join(h.xdgConfigHome, "opencode", "skills"),
  "codex-user-skills": (h) => path.join(h.codexHome, "skills"),
  "claude-user-commands": (h) => path.join(h.claudeConfigDir, "commands"),
  "cursor-user-commands": (h) => path.join(h.home, ".cursor", "commands"),
  "opencode-user-commands": (h) => path.join(h.xdgConfigHome, "opencode", "command"),
  "codex-user-prompts": (h) => path.join(h.codexHome, "prompts"),
  "pi-user-prompts": (h) => path.join(h.home, ".pi", "agent", "prompts"),
  "claude-user-agents": (h) => path.join(h.claudeConfigDir, "agents"),
  "opencode-user-agents": (h) => path.join(h.xdgConfigHome, "opencode", "agent"),
};

export function locationDirectory(locationId: string, homes: CapabilityHomes): string {
  const resolve = LOCATION_PATHS[locationId];
  if (!resolve || !capabilityLocation(locationId)) {
    throw new CapabilityError("invalid-request", "Unknown capability location.");
  }
  return resolve(homes);
}

export interface OwnershipMarker {
  formatVersion: 1;
  packageId: string;
  componentId: string;
  digest: string;
  writtenAt: string;
}

export interface LocationIndex {
  formatVersion: 1;
  files: Record<string, Omit<OwnershipMarker, "formatVersion">>;
}

function parseMarker(value: unknown): Omit<OwnershipMarker, "formatVersion"> | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.packageId !== "string" ||
    typeof record.componentId !== "string" ||
    typeof record.digest !== "string"
  ) {
    return null;
  }
  return {
    packageId: record.packageId,
    componentId: record.componentId,
    digest: record.digest,
    writtenAt: typeof record.writtenAt === "string" ? record.writtenAt : "",
  };
}

async function readJson(file: string): Promise<unknown> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function readMarker(
  file: string,
): Promise<Omit<OwnershipMarker, "formatVersion"> | null> {
  return parseMarker(await readJson(file));
}

export async function readLocationIndex(
  directory: string,
  options: { strict?: boolean } = {},
): Promise<LocationIndex> {
  const value = (await readJson(
    path.join(directory, CAPABILITY_LOCATION_INDEX),
  )) as Partial<LocationIndex> | null;
  if (
    options.strict &&
    (value?.formatVersion !== 1 ||
      !value.files ||
      typeof value.files !== "object" ||
      Array.isArray(value.files))
  ) {
    throw new CapabilityError("unsafe-content", "The capability ownership index is unreadable.");
  }
  const files: LocationIndex["files"] = {};
  if (value && typeof value.files === "object" && value.files !== null) {
    for (const [name, entry] of Object.entries(value.files)) {
      const marker = parseMarker(entry);
      if (marker && isSafeCapabilitySegment(name)) files[name] = marker;
      else if (options.strict)
        throw new CapabilityError("unsafe-content", "The capability ownership index is invalid.");
    }
  }
  return { formatVersion: 1, files };
}

export async function writeLocationIndex(directory: string, index: LocationIndex): Promise<void> {
  await writeFileAtomically(
    path.join(directory, CAPABILITY_LOCATION_INDEX),
    `${JSON.stringify(index, null, 2)}\n`,
  );
}

export function markerContent(marker: Omit<OwnershipMarker, "formatVersion">): string {
  return `${JSON.stringify({ formatVersion: 1, ...marker }, null, 2)}\n`;
}

/** The name a component is installed under: a safe single path segment. */
export function installName(
  componentName: string,
  pathOrKey: string,
  layout: "directory" | "file",
): string {
  const fromPath = pathOrKey.split("/").filter(Boolean).pop() ?? "";
  const base = layout === "file" ? fromPath.replace(/\.md$/i, "") : fromPath;
  const candidate = (base || componentName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  if (!isSafeCapabilitySegment(candidate)) {
    throw new CapabilityError(
      "unsafe-content",
      "The component name cannot be used as a file name.",
    );
  }
  return candidate;
}

export interface LocatedItem {
  location: CapabilityLocation;
  name: string;
  /** File name inside the location for file layouts (`review.md`). */
  entry: string;
  managed: Omit<OwnershipMarker, "formatVersion"> | null;
  digest: string | null;
  description?: string;
}

/** Single-file layouts are written as regular non-executable Markdown. */
export function installedComponentFiles(
  files: PackageFile[],
  layout: CapabilityLocation["layout"],
  entry: string,
): PackageFile[] {
  return layout === "file" && files.length > 0
    ? [{ ...files[0]!, path: entry, executable: false }]
    : files;
}

/** Digest of one installed item, computed the same way as a package artifact's subtree. */
export async function installedDigest(
  location: CapabilityLocation,
  directory: string,
  entry: string,
  options: { recover?: boolean; recordedDigest?: string } = {},
): Promise<string | null> {
  try {
    if (location.layout === "directory") {
      const destination = path.join(directory, entry);
      if (options.recover !== false) recoverDirectoryReplacement(destination);
      const files = await readPackageTree(destination);
      return treeDigest(files);
    }
    const target = path.join(directory, entry);
    const stat = await fs.lstat(target);
    if (!stat.isFile()) return null;
    const content = await fs.readFile(target);
    const file = { path: entry, executable: false, sha256: sha256Hex(content) };
    const digest = treeDigest([file]);
    // Earlier writers hashed the source's executable bit even though they wrote 0644.
    if (options.recordedDigest && options.recordedDigest !== digest) {
      const legacy = treeDigest([{ ...file, executable: true }]);
      if (legacy === options.recordedDigest) return legacy;
    }
    return digest;
  } catch {
    return null;
  }
}

/** Every item in one location, managed or external, bounded. */
export async function listLocation(
  location: CapabilityLocation,
  homes: CapabilityHomes,
  limit = 500,
): Promise<LocatedItem[]> {
  const directory = locationDirectory(location.id, homes);
  if (location.layout === "directory") await recoverLocationReplacements(directory);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const index = location.layout === "file" ? await readLocationIndex(directory) : null;
  const items: LocatedItem[] = [];
  for (const entry of entries.slice(0, limit)) {
    if (entry.name.startsWith(".")) continue;
    if (location.layout === "directory") {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillFile = path.join(directory, entry.name, "SKILL.md");
      const exists = await fs.stat(skillFile).catch(() => null);
      if (!exists?.isFile()) continue;
      const marker = parseMarker(
        await readJson(path.join(directory, entry.name, CAPABILITY_MARKER_FILE)),
      );
      items.push({
        location,
        name: entry.name,
        entry: entry.name,
        managed: marker,
        digest: await installedDigest(location, directory, entry.name),
      });
    } else {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const managed = index?.files[entry.name] ?? null;
      items.push({
        location,
        name: entry.name.slice(0, -3),
        entry: entry.name,
        managed,
        digest: await installedDigest(location, directory, entry.name, {
          recordedDigest: managed?.digest,
        }),
      });
    }
  }
  return items;
}

/** The locations a provider reads, from the shared table. */
export function locationsReadBy(provider: AgentPlatform): CapabilityLocation[] {
  return CAPABILITY_LOCATIONS.filter((location) => location.readBy.includes(provider));
}
