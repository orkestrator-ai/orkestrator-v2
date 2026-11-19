/**
 * Claude native plugins from reviewed, content-addressed bytes
 * (docs/architecture/agent-capabilities-management.md, "Claude plugins").
 *
 * A Claude marketplace is a mutable identifier: `name@marketplace` resolves
 * inside Claude at install time, so the bytes Claude installs could differ
 * from the bytes the user approved. Orkestrator therefore delivers a plugin
 * only from the artifact cache, through a marketplace it owns:
 *
 * - `<Claude home>/orkestrator-marketplace/plugins/<name>/<sha256 hex>/` holds
 *   exactly the approved artifact. A directory is named by its digest and is
 *   never edited in place; an update writes a new directory.
 * - `.claude-plugin/marketplace.json` lists each managed plugin at its
 *   digest directory, and `.orkestrator-marketplace.json` records which
 *   package and component own each plugin name.
 * - The marketplace is registered with Claude's own CLI
 *   (`claude plugin marketplace add <dir> --scope user`), and the plugin is
 *   installed with `claude plugin install <name>@orkestrator-managed`.
 *
 * Claude 2.1.326 reads a directory marketplace's plugins in place
 * (`readFromFolder`) and also copies them into its cache (`installPath`).
 * Every write is followed by a read-back of `claude plugin list --json`: the
 * entry must be enabled, read from the digest directory, and both trees must
 * hash to the approved digest. An ambiguous CLI answer (non-zero exit,
 * timeout, unparsable output) is settled by that observation, never by
 * running the write again.
 *
 * Plugins installed from any other marketplace are external: Orkestrator
 * never updates, disables or uninstalls them. A same-named external plugin
 * blocks delivery (two copies would both load) unless the user chose Adopt
 * and its installed bytes equal the approved digest; the external copy then
 * satisfies the package and is still never removed by Orkestrator.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  isSafeCapabilitySegment,
  type CapabilityComponent,
  type CapabilityTargetStatus,
  type CapabilityVerificationLevel,
} from "@orkestrator/protocol/capability-resources";

import type { CapabilityHomes } from "../native-ownership.js";
import {
  boundedReason,
  CapabilityError,
  readPackageTree,
  removeManagedPath,
  replaceDirectoryAtomically,
  treeDigest,
  writeFileAtomically,
  type PackageFile,
} from "../security.js";
import type { ProviderCli, ProviderCliResult } from "./provider-cli.js";

export const ORKESTRATOR_CLAUDE_MARKETPLACE = "orkestrator-managed";
export const CLAUDE_PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
const MARKETPLACE_DIRECTORY = "orkestrator-marketplace";
const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const INDEX_FILE = ".orkestrator-marketplace.json";
const DIGEST = /^sha256:([0-9a-f]{64})$/;
const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_LISTED_PLUGINS = 500;

export type ClaudeCliResult = ProviderCliResult;
export type ClaudePluginCli = ProviderCli;

/** One entry of `claude plugin list --json`. */
export interface ClaudeInstalledPlugin {
  id: string;
  name: string;
  marketplace: string;
  enabled: boolean;
  version?: string;
  scope?: string;
  installPath?: string;
  readFromFolder?: string;
}

export interface ClaudeMarketplace {
  name: string;
  source?: string;
  path?: string;
}

interface IndexEntry {
  packageId: string;
  componentId: string;
  digest: string;
  writtenAt: string;
}

interface MarketplaceIndex {
  formatVersion: 1;
  plugins: Record<string, IndexEntry>;
}

export interface ClaudePluginResult {
  status: CapabilityTargetStatus;
  verification: CapabilityVerificationLevel | "unverified";
  digest?: string;
  reason?: string;
  replayed?: boolean;
  /** The installed copy is an adopted external plugin, not Orkestrator's. */
  adopted?: string;
}

/** What the inventory reports for one plugin in Orkestrator's marketplace. */
export interface ManagedClaudePluginObservation {
  provider: AgentPlatform;
  qualifiedId: string;
  name: string;
  packageId: string;
  componentId: string;
  expectedDigest: string;
  /** Digest of the bytes Claude reads, when it lists the plugin. */
  digest: string | null;
  enabled: boolean | null;
  installed: boolean;
  drifted: boolean;
}

// --- Pure helpers -------------------------------------------------------------

/** Whether a component is a Claude plugin Orkestrator can deliver from its own artifact. */
export function isDeliverableClaudePlugin(
  component: Pick<CapabilityComponent, "kind" | "pathOrKey" | "providerHints">,
  sourceKind: string | undefined,
): boolean {
  return (
    component.kind === "native-plugin" &&
    component.pathOrKey === CLAUDE_PLUGIN_MANIFEST &&
    component.providerHints.includes("claude") &&
    sourceKind !== "provider-marketplace"
  );
}

/**
 * The component ids a delivered Claude plugin carries: everything that
 * depends on it. Claude loads them from the plugin, so they are not
 * delivered again on their own for Claude.
 */
export function claudePluginCarriedComponents(
  components: readonly Pick<CapabilityComponent, "id" | "dependencies">[],
  deliveredPluginIds: ReadonlySet<string>,
): Set<string> {
  const carried = new Set<string>();
  if (deliveredPluginIds.size === 0) return carried;
  for (const component of components) {
    if (component.dependencies.some((id) => deliveredPluginIds.has(id))) carried.add(component.id);
  }
  return carried;
}

/**
 * For one provider's resolved packages: the components a delivered Claude
 * plugin carries (empty for every provider but Claude).
 */
export function claudeCarriedComponents(
  provider: AgentPlatform,
  resolvedPackages: ReadonlyArray<{ id: string; artifactDigest: string; components: string[] }>,
  revisionComponents: (
    packageId: string,
    digest: string,
  ) => readonly CapabilityComponent[] | undefined,
  sourceKind: (packageId: string) => string | undefined,
): Set<string> {
  const carried = new Set<string>();
  if (provider !== "claude") return carried;
  for (const pkg of resolvedPackages) {
    const revision = revisionComponents(pkg.id, pkg.artifactDigest) ?? [];
    const plugins = new Set(
      revision
        .filter(
          (component) =>
            pkg.components.includes(component.id) &&
            isDeliverableClaudePlugin(component, sourceKind(pkg.id)),
        )
        .map((component) => component.id),
    );
    for (const id of claudePluginCarriedComponents(revision, plugins)) carried.add(id);
  }
  return carried;
}

/** The plugin name in an artifact's `.claude-plugin/plugin.json`. */
export function claudePluginName(files: readonly PackageFile[]): string {
  const manifest = files.find((file) => file.path === CLAUDE_PLUGIN_MANIFEST);
  if (!manifest) {
    throw new CapabilityError("not-found", "The artifact has no .claude-plugin/plugin.json.");
  }
  let name: unknown;
  try {
    const parsed = JSON.parse(manifest.content.toString("utf8")) as Record<string, unknown>;
    name = parsed.name;
    for (const field of ["hooks", "mcpServers", "skills", "commands", "agents", "lspServers"]) {
      if (parsed[field] !== undefined) {
        throw new CapabilityError(
          "unsupported",
          "Managed Claude plugins must use the conventional component paths.",
        );
      }
    }
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("unsafe-content", "The plugin manifest is not valid JSON.");
  }
  if (typeof name !== "string" || !PLUGIN_NAME.test(name) || !isSafeCapabilitySegment(name)) {
    throw new CapabilityError(
      "unsafe-content",
      "The plugin's name cannot be used as a Claude plugin id.",
    );
  }
  return name;
}

function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // `--json` result lines follow any human output on the last line.
    const last = text.split(/\r?\n/).pop() ?? "";
    try {
      return JSON.parse(last);
    } catch {
      return undefined;
    }
  }
}

/** `claude plugin list --json`, validated; `null` when the answer cannot be read. */
export function parseClaudePluginList(stdout: string): ClaudeInstalledPlugin[] | null {
  const value = parseJsonOutput(stdout);
  if (!Array.isArray(value)) return null;
  const plugins: ClaudeInstalledPlugin[] = [];
  for (const raw of value.slice(0, MAX_LISTED_PLUGINS)) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : undefined;
    const at = id ? id.lastIndexOf("@") : -1;
    if (!id || at <= 0) continue;
    const text = (key: string) =>
      typeof entry[key] === "string" && (entry[key] as string).length <= 4_096
        ? (entry[key] as string)
        : undefined;
    plugins.push({
      id,
      name: id.slice(0, at),
      marketplace: id.slice(at + 1),
      enabled: entry.enabled === true,
      ...(text("version") ? { version: text("version")! } : {}),
      ...(text("scope") ? { scope: text("scope")! } : {}),
      ...(text("installPath") ? { installPath: text("installPath")! } : {}),
      ...(text("readFromFolder") ? { readFromFolder: text("readFromFolder")! } : {}),
    });
  }
  return plugins;
}

/** `claude plugin marketplace list --json`, validated; `null` when unreadable. */
export function parseClaudeMarketplaceList(stdout: string): ClaudeMarketplace[] | null {
  const value = parseJsonOutput(stdout);
  if (!Array.isArray(value)) return null;
  return value.flatMap((raw): ClaudeMarketplace[] => {
    if (raw === null || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== "string") return [];
    return [
      {
        name: entry.name,
        ...(typeof entry.source === "string" ? { source: entry.source } : {}),
        ...(typeof entry.path === "string" ? { path: entry.path } : {}),
      },
    ];
  });
}

export function claudeMarketplaceDirectory(homes: CapabilityHomes): string {
  return path.join(homes.claudeConfigDir, MARKETPLACE_DIRECTORY);
}

function digestHex(digest: string): string {
  const match = DIGEST.exec(digest);
  if (!match) throw new CapabilityError("invalid-request", "Not an artifact digest.");
  return match[1]!;
}

async function realpathOrNull(target: string): Promise<string | null> {
  return fs.realpath(target).catch(() => null);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The digest of a tree Claude reports, read only when it is under `root`. */
async function digestUnder(root: string, target: string | undefined): Promise<string | null> {
  if (!target) return null;
  const [realRoot, realTarget] = await Promise.all([realpathOrNull(root), realpathOrNull(target)]);
  if (!realRoot || !realTarget || !isInside(realRoot, realTarget)) return null;
  try {
    return treeDigest(await readPackageTree(realTarget));
  } catch {
    return null;
  }
}

// --- The adapter ----------------------------------------------------------------

export interface ClaudePluginAdapterDeps {
  homes: () => CapabilityHomes;
  cli: ClaudePluginCli;
  now?: () => string;
}

export class ClaudePluginAdapter {
  constructor(private readonly deps: ClaudePluginAdapterDeps) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  private get marketplaceDir(): string {
    return claudeMarketplaceDirectory(this.deps.homes());
  }

  private pluginDir(name: string, digest: string): string {
    return path.join(this.marketplaceDir, "plugins", name, digestHex(digest));
  }

  private qualified(name: string): string {
    return `${name}@${ORKESTRATOR_CLAUDE_MARKETPLACE}`;
  }

  // --- Observation ---------------------------------------------------------------

  async listPlugins(): Promise<ClaudeInstalledPlugin[]> {
    const result = await this.deps.cli(["plugin", "list", "--json"]);
    const plugins = parseClaudePluginList(result.stdout);
    if (!plugins) {
      throw new CapabilityError("source-unavailable", "Claude's plugin list could not be read.");
    }
    return plugins;
  }

  async listMarketplaces(): Promise<ClaudeMarketplace[]> {
    const result = await this.deps.cli(["plugin", "marketplace", "list", "--json"]);
    const marketplaces = parseClaudeMarketplaceList(result.stdout);
    if (!marketplaces) {
      throw new CapabilityError(
        "source-unavailable",
        "Claude's marketplace list could not be read.",
      );
    }
    return marketplaces;
  }

  async readIndex(): Promise<MarketplaceIndex> {
    const file = path.join(this.marketplaceDir, INDEX_FILE);
    const plugins: MarketplaceIndex["plugins"] = {};
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) return { formatVersion: 1, plugins };
      const value = JSON.parse(await fs.readFile(file, "utf8")) as { plugins?: unknown };
      if (value.plugins && typeof value.plugins === "object") {
        for (const [name, raw] of Object.entries(value.plugins as Record<string, unknown>)) {
          const entry = raw as Partial<IndexEntry> | null;
          if (
            PLUGIN_NAME.test(name) &&
            entry &&
            typeof entry.packageId === "string" &&
            typeof entry.componentId === "string" &&
            typeof entry.digest === "string" &&
            DIGEST.test(entry.digest)
          ) {
            plugins[name] = {
              packageId: entry.packageId,
              componentId: entry.componentId,
              digest: entry.digest,
              writtenAt: typeof entry.writtenAt === "string" ? entry.writtenAt : "",
            };
          }
        }
      }
    } catch {
      // Absent or unreadable: nothing is managed.
    }
    return { formatVersion: 1, plugins };
  }

  /**
   * Claude reads a directory marketplace's plugins in place and also keeps
   * a cached copy; both must be the approved bytes.
   */
  private async verify(
    entry: ClaudeInstalledPlugin | undefined,
    name: string,
    digest: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; observed: string | null }> {
    if (!entry) return { ok: false, reason: "Claude does not list the plugin.", observed: null };
    const homes = this.deps.homes();
    const expectedFolder = await realpathOrNull(this.pluginDir(name, digest));
    const readFolder = entry.readFromFolder ? await realpathOrNull(entry.readFromFolder) : null;
    const observed = await digestUnder(this.marketplaceDir, entry.readFromFolder);
    if (!expectedFolder || readFolder !== expectedFolder) {
      return {
        ok: false,
        reason: "Claude reads the plugin from a directory other than the approved revision's.",
        observed,
      };
    }
    if (observed !== digest) {
      return {
        ok: false,
        reason: "The plugin bytes Claude reads differ from the approved revision.",
        observed,
      };
    }
    const cached = await digestUnder(
      path.join(homes.claudeConfigDir, "plugins"),
      entry.installPath,
    );
    if (cached !== digest) {
      return {
        ok: false,
        reason: "Claude's installed copy of the plugin differs from the approved revision.",
        observed,
      };
    }
    if (!entry.enabled) {
      return { ok: false, reason: "The plugin is disabled in Claude.", observed };
    }
    return { ok: true };
  }

  /** Managed plugins as the inventory reports them. */
  async observe(): Promise<ManagedClaudePluginObservation[]> {
    const index = await this.readIndex();
    const names = Object.keys(index.plugins);
    if (names.length === 0) return [];
    const listed = await this.listPlugins();
    const result: ManagedClaudePluginObservation[] = [];
    for (const name of names.sort()) {
      const managed = index.plugins[name]!;
      const entry = listed.find((plugin) => plugin.id === this.qualified(name));
      const source = entry ? await digestUnder(this.marketplaceDir, entry.readFromFolder) : null;
      const cached = entry
        ? await digestUnder(
            path.join(this.deps.homes().claudeConfigDir, "plugins"),
            entry.installPath,
          )
        : null;
      const digest = source === managed.digest ? cached : source;
      result.push({
        provider: "claude",
        qualifiedId: this.qualified(name),
        name,
        packageId: managed.packageId,
        componentId: managed.componentId,
        expectedDigest: managed.digest,
        digest,
        enabled: entry ? entry.enabled : null,
        installed: entry !== undefined,
        drifted: entry !== undefined && (digest !== managed.digest || !entry.enabled),
      });
    }
    return result;
  }

  // --- Writes --------------------------------------------------------------------

  private async writeIndex(index: MarketplaceIndex): Promise<void> {
    await writeFileAtomically(
      path.join(this.marketplaceDir, INDEX_FILE),
      `${JSON.stringify(index, null, 2)}\n`,
    );
  }

  /** `marketplace.json` lists exactly the managed plugins, each at its digest directory. */
  private async writeMarketplace(index: MarketplaceIndex): Promise<void> {
    const plugins = Object.entries(index.plugins)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => ({
        name,
        source: `./plugins/${name}/${digestHex(entry.digest)}`,
      }));
    await writeFileAtomically(
      path.join(this.marketplaceDir, MARKETPLACE_FILE),
      `${JSON.stringify(
        { name: ORKESTRATOR_CLAUDE_MARKETPLACE, owner: { name: "Orkestrator" }, plugins },
        null,
        2,
      )}\n`,
    );
  }

  /** Writes the approved bytes into their digest directory unless they are already there. */
  private async materialize(name: string, files: readonly PackageFile[], digest: string) {
    const directory = this.pluginDir(name, digest);
    const existing = await digestUnder(this.marketplaceDir, directory);
    if (existing === digest) return;
    await replaceDirectoryAtomically(directory, files);
    if ((await digestUnder(this.marketplaceDir, directory)) !== digest) {
      throw new CapabilityError(
        "unsafe-content",
        "The plugin copy does not match the approved revision after writing.",
      );
    }
  }

  /** Removes digest directories of `name` other than `keep`. */
  private async pruneRevisions(name: string, keep: string | null): Promise<void> {
    const parent = path.join(this.marketplaceDir, "plugins", name);
    const entries = await fs.readdir(parent).catch(() => [] as string[]);
    for (const entry of entries) {
      if (keep && entry === digestHex(keep)) continue;
      if (!/^[0-9a-f]{64}$/.test(entry)) continue;
      await removeManagedPath(parent, entry).catch(() => undefined);
    }
    if (!keep) await fs.rmdir(parent).catch(() => undefined);
  }

  /** Registers the marketplace with Claude, refusing a same-named one Orkestrator did not add. */
  private async ensureMarketplace(): Promise<string | undefined> {
    const own = await realpathOrNull(this.marketplaceDir);
    const find = async () =>
      (await this.listMarketplaces()).find(
        (entry) => entry.name === ORKESTRATOR_CLAUDE_MARKETPLACE,
      );
    const existing = await find();
    if (existing) {
      const registered = existing.path ? await realpathOrNull(existing.path) : null;
      return registered && registered === own
        ? undefined
        : `A Claude marketplace named ${ORKESTRATOR_CLAUDE_MARKETPLACE} that Orkestrator did not register already exists; it was left untouched.`;
    }
    await this.deps.cli([
      "plugin",
      "marketplace",
      "add",
      this.marketplaceDir,
      "--scope",
      "user",
      "--json",
    ]);
    // Settled by observation whatever the command answered.
    const added = await find();
    const registered = added?.path ? await realpathOrNull(added.path) : null;
    return registered && registered === own
      ? undefined
      : "Claude did not register Orkestrator's plugin marketplace.";
  }

  async install(input: {
    packageId: string;
    componentId: string;
    files: readonly PackageFile[];
    force?: boolean;
  }): Promise<ClaudePluginResult> {
    const digest = treeDigest(input.files);
    const name = claudePluginName(input.files);
    const qualifiedId = this.qualified(name);
    const index = await this.readIndex();
    const owner = index.plugins[name];
    if (owner && owner.packageId !== input.packageId) {
      return {
        status: "failed",
        verification: "requested",
        reason: `The Claude plugin name ${name} is already used by another package in Orkestrator's marketplace.`,
      };
    }
    const listed = await this.listPlugins();

    // A same-named plugin from any other marketplace is external.
    const external = listed.filter(
      (entry) => entry.name === name && entry.marketplace !== ORKESTRATOR_CLAUDE_MARKETPLACE,
    );
    const enabledExternal = external.filter((entry) => entry.enabled);
    if (enabledExternal.length > 0) {
      const homes = this.deps.homes();
      if (input.force) {
        for (const entry of enabledExternal) {
          const cached = await digestUnder(
            path.join(homes.claudeConfigDir, "plugins"),
            entry.installPath,
          );
          if (cached === digest && !owner) {
            return {
              status: "installed-next-session",
              verification: "enabled",
              digest,
              adopted: entry.id,
              reason: `Satisfied by ${entry.id}, which has exactly the approved bytes. It stays externally installed; Orkestrator will not update or remove it.`,
            };
          }
        }
      }
      return {
        status: "drifted",
        verification: "requested",
        reason: `${enabledExternal.map((entry) => entry.id).join(", ")} is already installed in Claude and Orkestrator does not manage it; it was left untouched. Adopt it (only when its bytes are identical) or remove it in Claude.`,
      };
    }

    const current = listed.find((entry) => entry.id === qualifiedId);
    if (current && owner) {
      if (owner.digest === digest) {
        const verified = await this.verify(current, name, digest);
        if (verified.ok) {
          return {
            status: "installed-next-session",
            verification: "enabled",
            digest,
            replayed: true,
          };
        }
      }
      if (!input.force) {
        const local = await this.verify(current, name, owner.digest);
        if (!local.ok) {
          return {
            status: "drifted",
            verification: "present",
            ...(local.observed ? { digest: local.observed } : {}),
            reason: `${qualifiedId} has local changes (${local.reason.replace(/\.$/, "").toLowerCase()}); they were kept until you decide.`,
          };
        }
      }
    }

    // Approved bytes first, then the listing that points at them.
    await this.materialize(name, input.files, digest);
    index.plugins[name] = {
      packageId: input.packageId,
      componentId: input.componentId,
      digest,
      writtenAt: this.now(),
    };
    await this.writeIndex(index);
    await this.writeMarketplace(index);
    const registration = await this.ensureMarketplace();
    if (registration) {
      return { status: "failed", verification: "requested", reason: registration };
    }

    let answer = "";
    if (current) {
      // Claude caches by the manifest's version, which need not change between
      // revisions: reinstall so its cached copy is the approved one. Plugin data is kept.
      const removed = await this.deps.cli([
        "plugin",
        "uninstall",
        qualifiedId,
        "--scope",
        "user",
        "--keep-data",
        "--json",
      ]);
      if (removed.exitCode !== 0) answer = ` Claude answered: ${resultMessage(removed)}`;
    }
    const installed = await this.deps.cli([
      "plugin",
      "install",
      qualifiedId,
      "--scope",
      "user",
      "--json",
    ]);
    if (installed.exitCode !== 0) answer = ` Claude answered: ${resultMessage(installed)}`;

    // The outcome is whatever Claude now reports, not what the command said.
    const after = (await this.listPlugins()).find((entry) => entry.id === qualifiedId);
    let verified = await this.verify(after, name, digest);
    // Another settings scope may still disable it. Only a user who chose
    // Replace has asked for it to be switched back on.
    if (!verified.ok && input.force && after && !after.enabled) {
      await this.deps.cli(["plugin", "enable", qualifiedId, "--scope", "user", "--json"]);
      verified = await this.verify(
        (await this.listPlugins()).find((entry) => entry.id === qualifiedId),
        name,
        digest,
      );
    }
    if (!verified.ok) {
      return {
        status: "failed",
        verification: after ? "present" : "requested",
        reason: `${verified.reason}${answer}`.slice(0, 400),
      };
    }
    await this.pruneRevisions(name, digest);
    return { status: "installed-next-session", verification: "enabled", digest };
  }

  async remove(input: {
    packageId: string;
    componentId: string;
    force?: boolean;
  }): Promise<ClaudePluginResult> {
    const index = await this.readIndex();
    const name = Object.keys(index.plugins).find(
      (candidate) =>
        index.plugins[candidate]!.packageId === input.packageId &&
        index.plugins[candidate]!.componentId === input.componentId,
    );
    if (!name) {
      return {
        status: "ready",
        verification: "requested",
        reason: "Orkestrator's marketplace has no copy of this plugin; nothing else was touched.",
      };
    }
    const owner = index.plugins[name]!;
    const qualifiedId = this.qualified(name);
    const current = (await this.listPlugins()).find((entry) => entry.id === qualifiedId);
    if (current && !input.force) {
      const local = await this.verify(current, name, owner.digest);
      if (!local.ok && !local.reason.includes("disabled")) {
        return {
          status: "drifted",
          verification: "present",
          reason: `${qualifiedId} has local changes, so it was kept; choose keep or replace first.`,
        };
      }
    }
    let answer = "";
    if (current) {
      const removed = await this.deps.cli([
        "plugin",
        "uninstall",
        qualifiedId,
        "--scope",
        "user",
        "--keep-data",
        "--json",
      ]);
      if (removed.exitCode !== 0) answer = ` Claude answered: ${resultMessage(removed)}`;
      const still = (await this.listPlugins()).some((entry) => entry.id === qualifiedId);
      if (still) {
        return {
          status: "failed",
          verification: "present",
          reason: `Claude still lists ${qualifiedId} after uninstalling it.${answer}`.slice(0, 400),
        };
      }
    }
    delete index.plugins[name];
    await this.writeMarketplace(index);
    await this.writeIndex(index);
    await this.pruneRevisions(name, null);
    if (Object.keys(index.plugins).length === 0) await this.retireMarketplace();
    return { status: "ready", verification: "requested" };
  }

  /** With nothing left to serve, unregister the marketplace and remove its directory. */
  private async retireMarketplace(): Promise<void> {
    try {
      const marketplaces = await this.listMarketplaces();
      const own = await realpathOrNull(this.marketplaceDir);
      const ours = marketplaces.find((entry) => entry.name === ORKESTRATOR_CLAUDE_MARKETPLACE);
      if (ours?.path && (await realpathOrNull(ours.path)) === own) {
        await this.deps.cli([
          "plugin",
          "marketplace",
          "remove",
          ORKESTRATOR_CLAUDE_MARKETPLACE,
          "--scope",
          "user",
          "--json",
        ]);
        const still = (await this.listMarketplaces()).some(
          (entry) => entry.name === ORKESTRATOR_CLAUDE_MARKETPLACE,
        );
        if (still) return;
      } else if (ours) {
        return;
      }
      await fs.rm(this.marketplaceDir, { recursive: true, force: true });
    } catch {
      // An empty registered marketplace is harmless; the next removal retries.
    }
  }
}

function resultMessage(result: ClaudeCliResult): string {
  if (result.timedOut) return "the command timed out.";
  const value = parseJsonOutput(result.stdout) as { message?: unknown } | undefined;
  const message =
    value && typeof value === "object" && typeof value.message === "string"
      ? value.message
      : `exit ${result.exitCode ?? "unknown"}.`;
  return boundedReason(new CapabilityError("unsupported", message.slice(0, 200)));
}
