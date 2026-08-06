import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Read-only discovery of the agent skills installed on the host.
 *
 * Every root here is a *user-level* location: the settings page that consumes
 * this has no project context, so repo-scoped roots (`<repo>/.claude/skills`,
 * `<repo>/.codex/skills`, `<repo>/.agents/skills`, ...) are deliberately out of
 * scope. Nothing in this module writes, and `readAgentSkillFile` refuses any
 * path that does not resolve inside one of the roots we just enumerated — the
 * renderer must not be able to turn this into an arbitrary host file reader.
 */

export const AGENT_SKILL_PROVIDERS = ["claude", "codex", "opencode"] as const;
export type AgentSkillProvider = (typeof AGENT_SKILL_PROVIDERS)[number];

export function isAgentSkillProvider(value: unknown): value is AgentSkillProvider {
  return typeof value === "string"
    && (AGENT_SKILL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Precedence order matters: when two roots expose the same skill name the
 * earlier scope wins and the later one is reported as shadowed. This mirrors
 * Claude's documented enterprise > personal > plugin ordering and Codex's
 * admin > user > system layering.
 */
export type AgentSkillScope = "admin" | "user" | "shared" | "system" | "plugin";

const SCOPE_ORDER: readonly AgentSkillScope[] = ["admin", "user", "shared", "system", "plugin"];

export interface AgentSkillRoot {
  /** Absolute path of the directory holding `<name>/SKILL.md`. */
  path: string;
  /** Display path, home-relative where possible (`~/.claude/skills`). */
  label: string;
  scope: AgentSkillScope;
  /** Set for plugin roots; the plugin the skills are bundled with. */
  plugin?: string;
  exists: boolean;
  skillCount: number;
}

export interface AgentSkill {
  /** Stable within one scan; used as the list selection key. */
  id: string;
  name: string;
  description: string;
  /** Absolute path to the SKILL.md itself. */
  filePath: string;
  /** Home-relative directory the skill lives in — the list's second line. */
  location: string;
  scope: AgentSkillScope;
  plugin?: string;
  /** True when a higher-precedence root exposes the same skill name. */
  shadowed: boolean;
}

export interface AgentSkillScan {
  provider: AgentSkillProvider;
  roots: AgentSkillRoot[];
  skills: AgentSkill[];
  errors: Array<{ path: string; message: string }>;
}

export interface AgentSkillFile {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * Bounds. A skills tree is user-authored and normally tiny, but it is also
 * user-controlled: a stray `skills/` symlink into a package cache should cost a
 * bounded scan, not an unbounded one.
 */
const MAX_ENTRIES_PER_ROOT = 500;
const MAX_SKILLS_PER_PROVIDER = 2_000;
/** Enough for any realistic frontmatter block; we never read further for the list. */
const FRONTMATTER_READ_BYTES = 16 * 1024;
/** The detail pane renders one SKILL.md; anything past this is elided. */
const MAX_SKILL_FILE_BYTES = 1024 * 1024;

/**
 * Test-only home override. `os.homedir()` ignores `$HOME` under Bun, so tests
 * that need a synthetic skills tree have no other way to redirect the roots.
 * Mirrors `setClaudeHomeForTesting` in the claude bridge.
 */
let homeOverride: string | undefined;

export function setAgentSkillsHomeForTesting(home: string | undefined): void {
  homeOverride = home;
}

function homeDir(): string {
  return homeOverride ?? os.homedir();
}

function codexHome(): string {
  // A synthetic home must be a complete isolation boundary. In particular,
  // Codex commonly sets CODEX_HOME for the process running the test suite.
  if (homeOverride !== undefined) return path.join(homeOverride, ".codex");
  const override = process.env.CODEX_HOME?.trim();
  return override ? path.resolve(override) : path.join(homeDir(), ".codex");
}

function opencodeConfigHome(): string {
  // See codexHome(): tests must not escape into the host's XDG config tree.
  if (homeOverride !== undefined) return path.join(homeOverride, ".config", "opencode");
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.join(path.resolve(xdg), "opencode") : path.join(homeDir(), ".config", "opencode");
}

/** `/Users/me/.claude/skills` -> `~/.claude/skills`, for display only. */
export function displayPath(target: string): string {
  const home = homeDir();
  if (target === home) return "~";
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return target.startsWith(prefix) ? `~${path.sep}${target.slice(prefix.length)}` : target;
}

interface RootSpec {
  path: string;
  scope: AgentSkillScope;
  plugin?: string;
  /** Subdirectory names to skip (Codex hides its system cache under `skills/.system`). */
  skip?: readonly string[];
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Claude records every installed plugin's on-disk location in
 * `installed_plugins.json`, so we resolve plugin roots from that rather than
 * globbing the cache: the cache keeps stale version directories around and
 * globbing would list the same skill two or three times.
 */
async function claudePluginRoots(): Promise<RootSpec[]> {
  const manifest = await readJsonFile(path.join(homeDir(), ".claude", "plugins", "installed_plugins.json"));
  if (!manifest || typeof manifest !== "object") return [];
  const plugins = (manifest as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const roots: RootSpec[] = [];
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    const installs = Array.isArray(value) ? value : [];
    for (const install of installs) {
      const installPath = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof installPath !== "string" || !installPath) continue;
      roots.push({
        path: path.join(installPath, "skills"),
        scope: "plugin",
        plugin: key.split("@")[0] || key,
      });
      break; // One install per plugin id; later entries are other scopes of the same plugin.
    }
  }
  return roots;
}

/**
 * Codex tracks plugin enablement in `config.toml` under `[plugins."<id>@<marketplace>"]`.
 * There is no TOML parser in this workspace and pulling one in for two fields is
 * not worth it, so this reads just the table headers and their `enabled` flag.
 * A plugin we fail to recognise is simply not listed — never listed as enabled.
 */
async function codexEnabledPlugins(configPath: string): Promise<Array<{ plugin: string; marketplace: string }>> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return [];
  }

  const enabled: Array<{ plugin: string; marketplace: string }> = [];
  let current: { plugin: string; marketplace: string } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = /^\[plugins\."([^"@]+)@([^"]+)"\]$/.exec(trimmed);
    if (header) {
      current = { plugin: header[1]!, marketplace: header[2]! };
      continue;
    }
    if (trimmed.startsWith("[")) {
      current = null;
      continue;
    }
    if (current && /^enabled\s*=\s*true$/.test(trimmed)) {
      enabled.push(current);
      current = null;
    }
  }
  return enabled;
}

interface RankedVersion {
  kind: "release" | "prerelease" | "fallback";
  numbers: number[];
  prerelease: string;
}

function rankVersionDir(name: string): RankedVersion {
  const version = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(name);
  if (!version) return { kind: "fallback", numbers: [], prerelease: name };
  return {
    kind: version[2] ? "prerelease" : "release",
    numbers: version[1]!.split(".").map(Number),
    prerelease: version[2] ?? "",
  };
}

function compareVersionDirs(a: string, b: string): number {
  const left = rankVersionDir(a);
  const right = rankVersionDir(b);
  const kindRank = { release: 2, prerelease: 1, fallback: 0 } as const;
  const kindDifference = kindRank[right.kind] - kindRank[left.kind];
  if (kindDifference !== 0) return kindDifference;

  const parts = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < parts; index += 1) {
    const difference = (right.numbers[index] ?? 0) - (left.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return right.prerelease.localeCompare(left.prerelease, undefined, { numeric: true });
}

/** Newest released version directory for a cached plugin, or the best fallback. */
async function newestChildDir(parent: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = (await fs.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;
  // Prefer any release over prereleases and non-version cache markers such as
  // `local`/`unknown`; compare versions numerically within each category.
  const ranked = entries.sort(compareVersionDirs);
  return path.join(parent, ranked[0]!);
}

async function codexPluginRoots(home: string): Promise<RootSpec[]> {
  const enabled = await codexEnabledPlugins(path.join(home, "config.toml"));
  const cacheRoot = path.join(home, "plugins", "cache");
  const roots: RootSpec[] = [];
  for (const { plugin, marketplace } of enabled) {
    const versionDir = await newestChildDir(path.join(cacheRoot, marketplace, plugin));
    if (!versionDir) continue;
    roots.push({ path: path.join(versionDir, "skills"), scope: "plugin", plugin });
  }
  return roots;
}

/**
 * The skill roots each agent reads, highest precedence first.
 *
 * Claude: enterprise (managed) > personal > plugin. Claude does **not** read
 * `~/.agents/skills` directly — shared skills only reach it via symlinks into
 * `~/.claude/skills`, which this scanner follows.
 *
 * Codex: `/etc/codex/skills` (admin) > `$CODEX_HOME/skills` (deprecated user
 * location) > `~/.agents/skills` > `$CODEX_HOME/skills/.system` > plugins.
 *
 * OpenCode: its own config dir plus the Claude- and agent-compatible roots.
 */
async function rootSpecsFor(provider: AgentSkillProvider): Promise<RootSpec[]> {
  const home = homeDir();
  const agentsSkills = path.join(home, ".agents", "skills");

  if (provider === "claude") {
    const managed = process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/skills"
      : process.platform === "win32"
        ? path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "ClaudeCode", "skills")
        : "/etc/claude-code/skills";
    return [
      // Fixed machine roots would make synthetic-home tests inspect the host.
      ...(homeOverride !== undefined ? [] : [{ path: managed, scope: "admin" as const }]),
      { path: path.join(home, ".claude", "skills"), scope: "user" },
      ...(await claudePluginRoots()),
    ];
  }

  if (provider === "codex") {
    const codex = codexHome();
    return [
      ...(process.platform === "win32" || homeOverride !== undefined
        ? []
        : [{ path: "/etc/codex/skills", scope: "admin" as const }]),
      { path: path.join(codex, "skills"), scope: "user", skip: [".system"] },
      { path: agentsSkills, scope: "shared" },
      { path: path.join(codex, "skills", ".system"), scope: "system" },
      ...(await codexPluginRoots(codex)),
    ];
  }

  return [
    { path: path.join(opencodeConfigHome(), "skills"), scope: "user" },
    { path: path.join(home, ".claude", "skills"), scope: "shared" },
    { path: agentsSkills, scope: "shared" },
  ];
}

/**
 * Pulls `name` and `description` out of a SKILL.md's YAML frontmatter.
 *
 * Deliberately not a YAML parser: skills only need two scalar keys, and they
 * routinely use block scalars (`description: |`) for multi-line trigger lists,
 * so that is the one non-trivial form handled here.
 */
export function parseSkillFrontmatter(head: string): { name?: string; description?: string } {
  const normalized = head.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(normalized)) return {};

  const lines = normalized.split(/\r?\n/).slice(1);
  const result: { name?: string; description?: string } = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "---" || line === "...") break;

    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (key !== "name" && key !== "description") continue;

    let value = match[2]!.trim();
    if (/^[|>][+-]?\d*$/.test(value)) {
      // Block scalar: consume the indented body that follows.
      const body: string[] = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor]!;
        if (next === "---" || next === "...") break;
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        body.push(next.trim());
      }
      index = cursor - 1;
      value = body.join(" ").replace(/\s+/g, " ").trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    if (value) result[key] = value;
  }

  return result;
}

/** Reads only the head of a file — SKILL.md bodies can be tens of kilobytes. */
async function readHead(filePath: string, bytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    // stat, not lstat: `~/.claude/skills/*` are commonly symlinks into
    // `~/.agents/skills`, and those are exactly the skills we must list.
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Internal shape: `realPath` collapses duplicate roots and never leaves this module. */
type ScannedSkill = Omit<AgentSkill, "shadowed"> & { realPath: string };

async function scanRoot(
  spec: RootSpec,
  errors: Array<{ path: string; message: string }>,
): Promise<{ root: AgentSkillRoot; skills: ScannedSkill[] }> {
  const label = displayPath(spec.path);
  const root: AgentSkillRoot = {
    path: spec.path,
    label,
    scope: spec.scope,
    ...(spec.plugin ? { plugin: spec.plugin } : {}),
    exists: false,
    skillCount: 0,
  };

  let entries: string[];
  try {
    entries = (await fs.readdir(spec.path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !spec.skip?.includes(name))
      .slice(0, MAX_ENTRIES_PER_ROOT);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A root that simply is not there is the normal case, not an error.
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      errors.push({ path: label, message: (error as Error).message });
    }
    return { root, skills: [] };
  }

  root.exists = true;

  const skills: ScannedSkill[] = [];
  for (const name of entries) {
    const skillDir = path.join(spec.path, name);
    const filePath = path.join(skillDir, "SKILL.md");
    if (!(await isDirectory(skillDir))) continue;

    let frontmatter: { name?: string; description?: string };
    try {
      frontmatter = parseSkillFrontmatter(await readHead(filePath, FRONTMATTER_READ_BYTES));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue; // A directory without SKILL.md is not a skill.
      errors.push({ path: displayPath(filePath), message: (error as Error).message });
      continue;
    }

    skills.push({
      id: filePath,
      name: frontmatter.name?.trim() || name,
      description: frontmatter.description ?? "",
      filePath,
      location: displayPath(skillDir),
      scope: spec.scope,
      ...(spec.plugin ? { plugin: spec.plugin } : {}),
      // Two roots can reach one file: OpenCode reads both `~/.claude/skills`
      // and `~/.agents/skills`, and the former is usually symlinks into the
      // latter. Resolving here lets the caller collapse those to one entry.
      realPath: await fs.realpath(filePath).catch(() => filePath),
    });
  }

  root.skillCount = skills.length;
  return { root, skills };
}

export async function scanAgentSkills(provider: AgentSkillProvider): Promise<AgentSkillScan> {
  const specs = await rootSpecsFor(provider);
  const errors: Array<{ path: string; message: string }> = [];
  const results = await Promise.all(specs.map((spec) => scanRoot(spec, errors)));

  const seenNames = new Set<string>();
  const seenFiles = new Set<string>();
  const skills: AgentSkill[] = [];
  // `specs` is already highest-precedence-first, so the first sighting of a name
  // is the one the agent actually loads and every later one is shadowed.
  for (const { skills: rootSkills } of results) {
    for (const skill of rootSkills) {
      if (skills.length >= MAX_SKILLS_PER_PROVIDER) break;
      // One file reachable through two roots is one skill, not two.
      if (seenFiles.has(skill.realPath)) continue;
      seenFiles.add(skill.realPath);

      const key = skill.name.toLowerCase();
      const { realPath: _realPath, ...rest } = skill;
      skills.push({ ...rest, shadowed: seenNames.has(key) });
      seenNames.add(key);
    }
  }

  // Alphabetical by name; within a duplicated name the copy that actually loads
  // comes first, so the shadowed one reads as the alternative beneath it.
  skills.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    || Number(a.shadowed) - Number(b.shadowed)
    || SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope)
    || a.location.localeCompare(b.location));

  return {
    provider,
    roots: results.map(({ root }) => root),
    skills,
    errors,
  };
}

/**
 * Reads one SKILL.md for the detail pane.
 *
 * The renderer supplies an absolute path, so this re-derives the provider's
 * roots and refuses anything that does not sit under one of them.
 *
 * The check is lexical, on the normalised path, and deliberately *not* on the
 * realpath: `~/.claude/skills/<name>` is routinely a symlink into
 * `~/.agents/skills/<name>`, which is not itself a Claude root, so resolving
 * the target first would reject the very skills the scan just listed. `..` is
 * removed by `path.normalize` before the prefix test, and a symlink planted
 * inside a skills directory is content the agent would load anyway — that
 * directory is the user's own.
 */
export async function readAgentSkillFile(
  provider: AgentSkillProvider,
  filePath: string,
): Promise<AgentSkillFile> {
  if (!path.isAbsolute(filePath)) throw new Error("Expected filePath to be absolute");
  const normalized = path.normalize(filePath);
  if (path.basename(normalized) !== "SKILL.md") throw new Error("Expected filePath to be a SKILL.md");

  const specs = await rootSpecsFor(provider);
  const allowed = specs.some((spec) => {
    const root = path.normalize(spec.path);
    return normalized.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
  if (!allowed) throw new Error("Refusing to read a file outside the agent skill directories");

  // Read one byte past the display limit to detect truncation without ever
  // allocating or loading the complete (user-controlled) file.
  const handle = await fs.open(normalized, "r");
  const buffer = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1);
  let bytesRead = 0;
  try {
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  const truncated = bytesRead > MAX_SKILL_FILE_BYTES;
  return {
    path: filePath,
    content: buffer.subarray(0, Math.min(bytesRead, MAX_SKILL_FILE_BYTES)).toString("utf8"),
    truncated,
  };
}
