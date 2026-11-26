/**
 * Session-private delivery (docs/architecture/agent-capabilities-management.md,
 * "Session-private delivery"; 8314 task 2).
 *
 * A selection made for one session, one graph node or one agent template is
 * not written into a provider home that other sessions and other providers
 * read. For Claude on a host, the components a plugin can carry (skills,
 * commands, prompts and subagents) are instead staged into a content-addressed
 * plugin directory that Orkestrator owns, `<dataDir>/capability-session-plugins/<digest>`,
 * and the backend passes that directory on that session's own turns only
 * (the bridge hands it to the SDK as an inline `--plugin-dir`). No other
 * session, provider or account home ever sees it, so the selection is
 * isolated by construction, and its skills are namespaced
 * (`orkestrator-session:<name>`), so a personal copy cannot shadow them.
 *
 * Pi on a host takes skills the same way: the same directory, whose `skills/`
 * the Pi bridge passes to that session's resource loader as its own
 * `additionalSkillPaths` (per session in the pinned SDK). Pi skills are not
 * namespaced, and Pi keeps the first skill of a name it loads, so a shared
 * skill of the same name wins; runtime proof then reports the shared path,
 * never the private one (`runtime-proof.ts`).
 *
 * The directory is frozen at launch: the launch record names its digest and
 * every later turn passes the same bytes, so a running session never gains or
 * changes a component behind its back. Hooks, MCP servers, native plugins and
 * any component a native plugin carries are never delivered this way: hooks
 * and MCP servers need their own approval and lifecycle, and a plugin's parts
 * are delivered by the plugin as a whole.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  CAPABILITY_SESSION_PLUGINS_DIRECTORY,
  type CapabilityComponent,
  type CapabilityTarget,
  type EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import { canonicalCapabilityJson } from "@orkestrator/protocol/capability-resources-resolve";

import type { CapabilityArtifactStore } from "./artifact-store.js";
import { componentFiles } from "./executor.js";
import { installName } from "./native-ownership.js";
import { sha256 } from "./planning.js";
import {
  CapabilityError,
  readPackageTree,
  replaceDirectoryAtomically,
  sha256Hex,
  treeDigest,
  type PackageFile,
} from "./security.js";
import { assertDistributableArtifact } from "./source-inspection.js";
import type { CapabilityState } from "./types.js";

/** The plugin's name, and so the prefix of its skills and commands. */
export const SESSION_PLUGIN_NAME = "orkestrator-session";
/** Under the backend's data directory. */
export const SESSION_PLUGINS_DIRECTORY = CAPABILITY_SESSION_PLUGINS_DIRECTORY;
/** Bumped whenever the layout changes, so an old directory is never reused. */
const SESSION_PLUGIN_FORMAT = 1;
/** Bytes one session's plugin may hold. */
export const SESSION_PLUGIN_LIMITS = { files: 2_000, bytes: 32 * 1024 * 1024 } as const;
/** Unreferenced plugin directories younger than this are kept (a launch in flight). */
const PRUNE_GRACE_MS = 60 * 60 * 1000;

const PRIVATE_KINDS = new Set<CapabilityComponent["kind"]>([
  "skill",
  "command",
  "prompt",
  "subagent",
]);

/**
 * The kinds each provider's bridge loads from a session's private plugin:
 * Claude every kind a plugin carries, Pi skills (its bridge passes the
 * plugin's `skills/` as the session's skill paths).
 */
const PRIVATE_KINDS_BY_PROVIDER: Partial<
  Record<CapabilityTarget["provider"], ReadonlySet<CapabilityComponent["kind"]>>
> = {
  claude: PRIVATE_KINDS,
  pi: new Set<CapabilityComponent["kind"]>(["skill"]),
};

export interface SessionPrivateItem {
  packageId: string;
  packageDigest: string;
  componentId: string;
  kind: CapabilityComponent["kind"];
  name: string;
  pathOrKey: string;
}

/** What the launch record keeps of a session's private plugin. */
export interface SessionPrivatePluginRecord {
  /** Names the directory: a digest of the items and the layout format. */
  digest: string;
  /** The staged tree's digest, read back after writing. */
  treeDigest: string;
  items: Array<
    Pick<SessionPrivateItem, "packageId" | "componentId" | "packageDigest"> &
      Partial<Pick<SessionPrivateItem, "kind" | "name" | "pathOrKey">>
  >;
}

/**
 * Whether `component` can reach `target` only through its own session.
 * Claude or Pi on a host (any account home: the directory is passed per
 * session, not read from the home), for a kind that provider's bridge loads
 * from the session plugin, not carried by a native plugin of its own package.
 */
export function sessionPrivateDeliverable(
  state: Pick<CapabilityState, "components">,
  target: Pick<CapabilityTarget, "provider" | "environmentIncarnation">,
  component: CapabilityComponent,
): boolean {
  if (target.environmentIncarnation !== undefined) return false;
  const kinds = PRIVATE_KINDS_BY_PROVIDER[target.provider];
  if (!kinds?.has(component.kind)) return false;
  if (component.providerHints.length > 0 && !component.providerHints.includes(target.provider))
    return false;
  return !component.dependencies.some((id) => state.components[id]?.kind === "native-plugin");
}

/** The directory a component goes to inside the plugin. */
function pluginSubdirectory(kind: CapabilityComponent["kind"]): "skills" | "commands" | "agents" {
  if (kind === "skill") return "skills";
  if (kind === "subagent") return "agents";
  return "commands";
}

/** The plugin's directory name for `items`: the same items always give the same name. */
export function sessionPluginDigest(items: readonly SessionPrivateItem[]): string {
  const sorted = [...items]
    .map((item) => [item.packageId, item.componentId, item.packageDigest])
    .sort((a, b) => {
      const left = a.join("|");
      const right = b.join("|");
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return sha256(canonicalCapabilityJson({ format: SESSION_PLUGIN_FORMAT, items: sorted }))
    .replace(/^sha256:/, "")
    .slice(0, 40);
}

export function sessionPluginsRoot(dataDir: string): string {
  return path.join(dataDir, SESSION_PLUGINS_DIRECTORY);
}

/** The absolute directory of a record's plugin; refuses a digest that is not one. */
export function sessionPluginPath(root: string, digest: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(digest)) {
    throw new CapabilityError("invalid-request", "Not a session plugin digest.");
  }
  return path.join(root, digest);
}

function file(relative: string, content: Buffer, executable = false): PackageFile {
  return {
    path: relative,
    bytes: content.length,
    executable,
    sha256: sha256Hex(content),
    content,
  };
}

/** The plugin's files for `items`, from verified artifacts only. */
export async function sessionPluginFiles(
  items: readonly SessionPrivateItem[],
  artifacts: Pick<CapabilityArtifactStore, "get">,
): Promise<PackageFile[]> {
  const files: PackageFile[] = [
    file(
      ".claude-plugin/plugin.json",
      Buffer.from(
        JSON.stringify({
          name: SESSION_PLUGIN_NAME,
          description:
            "Capabilities Orkestrator delivered to this session only, from the revisions its setups select.",
          version: `${SESSION_PLUGIN_FORMAT}.0.0`,
        }),
      ),
    ),
  ];
  const taken = new Map<string, string>();
  let bytes = 0;
  for (const item of [...items].sort((a, b) => a.componentId.localeCompare(b.componentId))) {
    const artifact = await artifacts.get(item.packageDigest);
    assertDistributableArtifact(artifact);
    const selected = componentFiles(artifact, item);
    if (selected.length === 0) {
      throw new CapabilityError(
        "source-unavailable",
        `${item.name} is not in the revision the session selected.`,
      );
    }
    const layout = item.kind === "skill" ? "directory" : "file";
    const name = installName(item.name, item.pathOrKey, layout);
    const entry = `${pluginSubdirectory(item.kind)}/${layout === "file" ? `${name}.md` : name}`;
    const previous = taken.get(entry);
    if (previous && previous !== item.componentId) {
      throw new CapabilityError(
        "conflict",
        `Two components selected for this session are both called ${name}; exclude one of them.`,
      );
    }
    taken.set(entry, item.componentId);
    for (const source of layout === "file" ? [selected[0]!] : selected) {
      const relative = layout === "file" ? entry : `${entry}/${source.path}`;
      files.push({ ...source, path: relative });
      bytes += source.content.length;
    }
    if (files.length > SESSION_PLUGIN_LIMITS.files || bytes > SESSION_PLUGIN_LIMITS.bytes) {
      throw new CapabilityError(
        "too-large",
        "The components selected for this session are too large to deliver to it.",
      );
    }
  }
  return files;
}

/**
 * Writes the session's plugin (or reuses an identical one) and reads it back.
 * A directory whose bytes do not match is replaced; one that cannot be read
 * back to the expected digest fails the delivery.
 */
export async function stageSessionPlugin(input: {
  root: string;
  items: readonly SessionPrivateItem[];
  artifacts: Pick<CapabilityArtifactStore, "get">;
}): Promise<{ directory: string; record: SessionPrivatePluginRecord }> {
  const digest = sessionPluginDigest(input.items);
  const directory = sessionPluginPath(input.root, digest);
  const files = await sessionPluginFiles(input.items, input.artifacts);
  const expected = treeDigest(files);
  await fs.mkdir(input.root, { recursive: true, mode: 0o700 });
  const current = await readBack(input.root, directory);
  if (current !== expected) {
    await replaceDirectoryAtomically(directory, files);
    const written = await readBack(input.root, directory);
    if (written !== expected) {
      throw new CapabilityError(
        "source-unavailable",
        "The session's capability files could not be verified after writing them.",
      );
    }
  } else {
    // Touch it so pruning keeps a directory a new launch reuses.
    const now = new Date();
    await fs.utimes(directory, now, now).catch(() => undefined);
  }
  return {
    directory,
    record: {
      digest,
      treeDigest: expected,
      items: input.items.map((item) => ({ ...item })),
    },
  };
}

async function readBack(root: string, directory: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory()) return null;
    return treeDigest(
      await readPackageTree(directory, {
        within: root,
        maxFiles: SESSION_PLUGIN_LIMITS.files + 1,
        maxBytes: SESSION_PLUGIN_LIMITS.bytes + 64 * 1024,
      }),
    );
  } catch {
    return null;
  }
}

/**
 * The directory a recorded launch's turns pass, after confirming it still
 * holds the recorded bytes. A directory removed since (pruned, or a data
 * directory restored from backup) is re-staged from the artifact cache;
 * one that cannot be is not passed, and the caller reports why.
 */
export async function sessionPluginForTurn(input: {
  root: string;
  record: SessionPrivatePluginRecord;
  state: Pick<CapabilityState, "packages" | "components">;
  artifacts: Pick<CapabilityArtifactStore, "get">;
  resolveItem: (
    entry: SessionPrivatePluginRecord["items"][number],
  ) => SessionPrivateItem | undefined;
}): Promise<string> {
  const directory = sessionPluginPath(input.root, input.record.digest);
  if ((await readBack(input.root, directory)) === input.record.treeDigest) return directory;
  const items = input.record.items.map((entry) => {
    const { kind, name, pathOrKey } = entry;
    const item =
      kind !== undefined && name !== undefined && pathOrKey !== undefined
        ? { ...entry, kind, name, pathOrKey }
        : input.resolveItem(entry);
    if (!item) {
      throw new CapabilityError(
        "source-unavailable",
        "A component this session launched with is no longer in the library.",
      );
    }
    return item;
  });
  const staged = await stageSessionPlugin({ root: input.root, items, artifacts: input.artifacts });
  if (staged.record.treeDigest !== input.record.treeDigest) {
    throw new CapabilityError(
      "source-unavailable",
      "The session's capability files no longer match what it launched with.",
    );
  }
  return staged.directory;
}

/**
 * Removes plugin directories no launch record names, once they are older than
 * the grace period. Housekeeping: a failure costs only disk.
 */
export async function pruneSessionPlugins(
  root: string,
  referenced: ReadonlySet<string>,
  nowMs: number = Date.now(),
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (referenced.has(name)) continue;
    const target = path.join(root, name);
    try {
      const stat = await fs.lstat(target);
      if (nowMs - stat.mtimeMs < PRUNE_GRACE_MS) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Housekeeping only.
    }
  }
  return removed;
}

/**
 * `effective` without `items`, which could not be delivered for `reason`:
 * each one is reported unsupported (and with a warning), and a required one
 * becomes a launch blocker. Never reports a component delivered that is not.
 */
export function withoutPrivateItems(
  effective: EffectiveAgentResources,
  items: readonly SessionPrivateItem[],
  reason: string,
  required: ReadonlySet<string>,
): EffectiveAgentResources {
  if (items.length === 0) return effective;
  const dropped = new Set(items.map((item) => `${item.packageId}|${item.componentId}`));
  const resolvedPackages = effective.resolvedPackages
    .map((pkg) => ({
      ...pkg,
      components: pkg.components.filter((id) => !dropped.has(`${pkg.id}|${id}`)),
    }))
    .filter((pkg) => pkg.components.length > 0);
  return {
    ...effective,
    resolvedPackages,
    unsupported: [
      ...effective.unsupported,
      ...items.map((item) => ({ componentId: item.componentId, reason })),
    ],
    launchBlockers: [
      ...effective.launchBlockers,
      ...items
        .filter((item) => required.has(item.packageId))
        .map((item) => ({ componentId: item.componentId, reason: `${item.name}: ${reason}` })),
    ],
    warnings: [
      ...effective.warnings,
      ...items
        .filter((item) => !required.has(item.packageId))
        .map((item) => `${item.name}: not delivered to this session. ${reason}`),
    ],
    manifestDigest: sha256(
      canonicalCapabilityJson({
        target: effective.target,
        packages: resolvedPackages,
        policy: effective.permissionPolicyDigest,
      }),
    ),
  };
}

const ITEM_KINDS = new Set<string>(PRIVATE_KINDS);

/** Items from an untrusted answer (a leaf reading its command node's reply), bounded. */
export function parseSessionPrivateItems(value: unknown): SessionPrivateItem[] {
  if (!Array.isArray(value)) return [];
  const text = (entry: unknown, max = 512) =>
    typeof entry === "string" && entry.length > 0 && entry.length <= max ? entry : undefined;
  return value.slice(0, 500).flatMap((raw): SessionPrivateItem[] => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const packageId = text(item.packageId);
    const packageDigest = text(item.packageDigest, 200);
    const componentId = text(item.componentId);
    const name = text(item.name, 256);
    const pathOrKey = typeof item.pathOrKey === "string" ? item.pathOrKey.slice(0, 1024) : "";
    const kind = typeof item.kind === "string" && ITEM_KINDS.has(item.kind) ? item.kind : undefined;
    if (!packageId || !packageDigest || !componentId || !name || !kind) return [];
    return [
      {
        packageId,
        packageDigest,
        componentId,
        name,
        pathOrKey,
        kind: kind as CapabilityComponent["kind"],
      },
    ];
  });
}
