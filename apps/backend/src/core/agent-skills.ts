import os from "node:os";
import path from "node:path";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";

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

export const AGENT_SKILL_PROVIDERS = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
] as const;
export type AgentSkillProvider = (typeof AGENT_SKILL_PROVIDERS)[number];

export function isAgentSkillProvider(value: unknown): value is AgentSkillProvider {
  return typeof value === "string" && (AGENT_SKILL_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Precedence order matters: when two roots expose the same skill name the
 * earlier scope wins and the later one is reported as shadowed. This mirrors
 * Claude's documented enterprise > personal > plugin ordering and Codex's
 * admin > user > system layering.
 */
export type AgentSkillScope = "project" | "admin" | "user" | "shared" | "system" | "plugin";

const SCOPE_ORDER: readonly AgentSkillScope[] = [
  "project",
  "admin",
  "user",
  "shared",
  "system",
  "plugin",
];

export interface AgentSkillRoot {
  /** Absolute path of the directory holding `<name>/SKILL.md`. */
  path: string;
  /** Display path, home-relative where possible (`~/.claude/skills`). */
  label: string;
  scope: AgentSkillScope;
  /** Set for plugin roots; the plugin the skills are bundled with. */
  plugin?: string;
  exists: boolean;
  /** How many of this root's skills the scan actually listed, after dedupe and capping. */
  skillCount: number;
  /** Set when the root held more entries than the scan was willing to read. */
  truncated: boolean;
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
/** Depth bound for the recursive roots; mirrors the environment scanner. */
const MAX_SCAN_DEPTH = 32;
/** Enough for any realistic frontmatter block; we never read further for the list. */
const FRONTMATTER_READ_BYTES = 16 * 1024;
/** The detail pane renders one SKILL.md; anything past this is elided. */
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
/**
 * The list clamps descriptions to two lines, but frontmatter is user-controlled
 * and a block scalar can fill the whole 16KiB head. Without this a provider with
 * 2,000 skills could answer one `list_agent_skills` call with ~31MB of JSON.
 */
const MAX_DESCRIPTION_CHARS = 512;

/**
 * Clamps a description without splitting a surrogate pair — descriptions are
 * prose and routinely contain emoji, and half a pair renders as a replacement
 * character rather than being invisibly dropped.
 */
function clampDescription(value: string): string {
  if (value.length <= MAX_DESCRIPTION_CHARS) return value;
  return Array.from(value).slice(0, MAX_DESCRIPTION_CHARS).join("");
}

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
  return xdg
    ? path.join(path.resolve(xdg), "opencode")
    : path.join(homeDir(), ".config", "opencode");
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
  /**
   * Prefix applied to every skill name found under this root. Claude addresses a
   * plugin's skill as `<plugin>:<skill>`, so the bare name would both display
   * wrongly and shadow an unrelated personal skill that happens to share it.
   */
  namePrefix?: string;
  /** Subdirectory names to skip (Codex hides its system cache under `skills/.system`). */
  skip?: readonly string[];
  /**
   * Codex and OpenCode load skills from any depth beneath their roots
   * (`~/.agents/skills/team/review/SKILL.md`); Claude reads only the top level.
   * This must stay in step with `rootPlan` in `environment-agent-skills.ts`,
   * which scans the same layouts from inside an environment.
   */
  recursive?: boolean;
}

/**
 * `@team/quality@official` is a plugin named `@team/quality` from the
 * `official` marketplace, so the id splits at its *last* `@` — splitting at the
 * first one names every scoped plugin the empty string.
 */
function pluginNameFromId(id: string): string {
  const marketplace = id.lastIndexOf("@");
  return marketplace > 0 ? id.slice(0, marketplace) : id;
}

/**
 * Plugin and marketplace ids become path segments, and they arrive from files
 * this module does not own (`config.toml`, `installed_plugins.json`). A segment
 * containing a separator or `..` would not just point the scan somewhere else —
 * it would add that directory to the roots `readAgentSkillFile` accepts, turning
 * a marketplace id into a widening of this module's read allowlist.
 */
function isSafePathSegment(value: string): boolean {
  if (!value || value === "." || value === "..") return false;
  return !value.includes("/") && !value.includes("\\") && !value.includes(path.sep);
}

/** True when `target` is `parent` itself or sits underneath it. */
function isInside(parent: string, target: string): boolean {
  const root = path.normalize(parent);
  const normalized = path.normalize(target);
  if (normalized === root) return true;
  return normalized.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
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
  const manifest = await readJsonFile(
    path.join(homeDir(), ".claude", "plugins", "installed_plugins.json"),
  );
  if (!manifest || typeof manifest !== "object") return [];
  const plugins = (manifest as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const roots: RootSpec[] = [];
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    const installs = Array.isArray(value) ? value : [];
    for (const install of installs) {
      const installPath = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof installPath !== "string" || !installPath) continue;
      // A plugin legitimately installs anywhere, so the path is not confined to
      // a cache root the way Codex's is — but it must still be a real absolute
      // location rather than a relative fragment resolved against our cwd.
      if (!path.isAbsolute(installPath)) continue;
      const plugin = pluginNameFromId(key);
      roots.push({
        path: path.join(installPath, "skills"),
        scope: "plugin",
        plugin,
        namePrefix: `${plugin}:`,
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
async function codexEnabledPlugins(
  configPath: string,
): Promise<Array<{ plugin: string; marketplace: string }>> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return [];
  }

  const enabled: Array<{ plugin: string; marketplace: string }> = [];
  let current: { plugin: string; marketplace: string } | null = null;
  let inPluginsTable = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    // A trailing `# comment` is ordinary TOML; anchoring to end-of-line without
    // allowing one silently dropped every plugin whose entry carried a note.
    const header = /^\[plugins\."([^"@]+)@([^"]+)"\][ \t]*(?:#.*)?$/.exec(trimmed);
    if (header) {
      current = { plugin: header[1]!, marketplace: header[2]! };
      inPluginsTable = false;
      continue;
    }
    if (trimmed.startsWith("[")) {
      current = null;
      inPluginsTable = /^\[plugins\][ \t]*(?:#.*)?$/.test(trimmed);
      continue;
    }
    // `[plugins]` with inline tables: `"id@market" = { enabled = true }`.
    const inline = inPluginsTable
      ? /^"([^"@]+)@([^"]+)"[ \t]*=[ \t]*\{([^}]*)\}[ \t]*(?:#.*)?$/.exec(trimmed)
      : null;
    if (inline) {
      if (/(?:^|,)\s*enabled\s*=\s*true\s*(?:,|$)/.test(inline[3]!)) {
        enabled.push({ plugin: inline[1]!, marketplace: inline[2]! });
      }
      continue;
    }
    if (current && /^enabled\s*=\s*true[ \t]*(?:#.*)?$/.test(trimmed)) {
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
    if (!isSafePathSegment(plugin) || !isSafePathSegment(marketplace)) continue;
    const pluginCache = path.join(cacheRoot, marketplace, plugin);
    // Belt and braces: the segment check above already blocks an escape, but the
    // consequence of one is a wider read allowlist, so confirm the result landed
    // where we meant it to rather than trusting the check alone.
    if (!isInside(cacheRoot, pluginCache)) continue;
    const versionDir = await newestChildDir(pluginCache);
    if (!versionDir) continue;
    roots.push({ path: path.join(versionDir, "skills"), scope: "plugin", plugin, recursive: true });
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
 *
 * Cursor Agent: `~/.cursor/skills` (user) > `~/.cursor/skills-cursor` (built-in)
 * > `~/.agents/skills` > Claude/Codex compatibility roots. Cursor walks these
 * recursively, including category folders.
 *
 * Grok Build: `~/.grok/skills` > `~/.agents/skills` > Claude compatibility.
 */
async function rootSpecsFor(provider: AgentSkillProvider): Promise<RootSpec[]> {
  const home = homeDir();
  const agentsSkills = path.join(home, ".agents", "skills");

  if (provider === "claude") {
    const managed =
      process.platform === "darwin"
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
        : [{ path: "/etc/codex/skills", scope: "admin" as const, recursive: true }]),
      { path: path.join(codex, "skills"), scope: "user", skip: [".system"], recursive: true },
      { path: agentsSkills, scope: "shared", recursive: true },
      { path: path.join(codex, "skills", ".system"), scope: "system", recursive: true },
      ...(await codexPluginRoots(codex)),
    ];
  }

  if (provider === "cursor") {
    return [
      { path: path.join(home, ".cursor", "skills"), scope: "user", recursive: true },
      { path: path.join(home, ".cursor", "skills-cursor"), scope: "system", recursive: true },
      { path: agentsSkills, scope: "shared", recursive: true },
      { path: path.join(home, ".claude", "skills"), scope: "shared", recursive: true },
      {
        path: path.join(codexHome(), "skills"),
        scope: "shared",
        skip: [".system"],
        recursive: true,
      },
    ];
  }

  if (provider === "grok") {
    return [
      { path: path.join(home, ".grok", "skills"), scope: "user", recursive: true },
      { path: agentsSkills, scope: "shared", recursive: true },
      { path: path.join(home, ".claude", "skills"), scope: "shared", recursive: true },
    ];
  }

  if (provider === "pi") {
    // Pi resolves its resources from the agent directory rather than the config
    // directory above it: `~/.pi` holds `agent/`, and everything Pi loads —
    // skills, prompts, extensions, themes — sits inside that. The shared roots
    // follow the other platforms so a skill written once is offered everywhere.
    return [
      { path: path.join(home, ".pi", "agent", "skills"), scope: "user", recursive: true },
      { path: agentsSkills, scope: "shared", recursive: true },
      { path: path.join(home, ".claude", "skills"), scope: "shared", recursive: true },
    ];
  }

  return [
    { path: path.join(opencodeConfigHome(), "skills"), scope: "user", recursive: true },
    { path: path.join(home, ".claude", "skills"), scope: "shared", recursive: true },
    { path: agentsSkills, scope: "shared", recursive: true },
  ];
}

/**
 * YAML allows trailing whitespace on the closing fence, and editors emit it. An
 * exact `=== "---"` check walked straight past it into the body, which then
 * overwrote the real keys — so the terminator is matched on the trimmed line.
 */
function isFrontmatterTerminator(line: string): boolean {
  const trimmed = line.trimEnd();
  return trimmed === "---" || trimmed === "...";
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
  if (!/^---[ \t]*\r?\n/.test(normalized)) return {};

  const lines = normalized.split(/\r?\n/).slice(1);
  const result: { name?: string; description?: string } = {};
  let closed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isFrontmatterTerminator(line)) {
      closed = true;
      break;
    }

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
        if (isFrontmatterTerminator(next)) break;
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        body.push(next.trim());
      }
      index = cursor - 1;
      value = body.join(" ").replace(/\s+/g, " ").trim();
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    if (value) result[key] = value;
  }

  // Without a closing delimiter there is no boundary between metadata and prose,
  // so body text would be reported as the skill's name and description. Report
  // nothing instead and let the caller fall back to the directory name.
  return closed ? result : {};
}

/**
 * Opens a path only once the handle is known to be a regular file.
 *
 * A skills tree is user-controlled, and `open` on a FIFO blocks until a writer
 * appears — with no timeout, one named pipe called `SKILL.md` would hang the
 * whole scan and leak the command's promise. `O_NONBLOCK` makes the open return
 * immediately, and stat-ing the *handle* rather than the path leaves no window
 * between the check and the open.
 */
async function openRegularFile(filePath: string): Promise<FileHandle> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Not a regular file");
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Reads only the head of a file — SKILL.md bodies can be tens of kilobytes. */
async function readHead(filePath: string, bytes: number): Promise<string> {
  const handle = await openRegularFile(filePath);
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

/** Reads one candidate skill directory, or nothing when it holds no SKILL.md. */
async function readSkillDirectory(
  spec: RootSpec,
  skillDir: string,
  errors: Array<{ path: string; message: string }>,
): Promise<ScannedSkill | undefined> {
  const filePath = path.join(skillDir, "SKILL.md");
  let frontmatter: { name?: string; description?: string };
  try {
    frontmatter = parseSkillFrontmatter(await readHead(filePath, FRONTMATTER_READ_BYTES));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined; // A directory without SKILL.md is not a skill.
    errors.push({ path: displayPath(filePath), message: (error as Error).message });
    return undefined;
  }

  return {
    id: filePath,
    name: (spec.namePrefix ?? "") + (frontmatter.name?.trim() || path.basename(skillDir)),
    description: clampDescription(frontmatter.description ?? ""),
    filePath,
    location: displayPath(skillDir),
    scope: spec.scope,
    ...(spec.plugin ? { plugin: spec.plugin } : {}),
    // Two roots can reach one file: OpenCode reads both `~/.claude/skills`
    // and `~/.agents/skills`, and the former is usually symlinks into the
    // latter. Resolving here lets the caller collapse those to one entry.
    realPath: await fs.realpath(filePath).catch(() => filePath),
  };
}

/**
 * Walks one root, depth-first, for directories holding a SKILL.md.
 *
 * `opendir` rather than `readdir` so an enormous directory costs a bounded read
 * instead of materialising every entry only to slice it away afterwards. The
 * entry budget is spent across the whole root rather than per directory, so a
 * recursive root cannot multiply it by its depth, and `visited` is keyed on the
 * resolved path so a symlink cycle terminates.
 */
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
    truncated: false,
  };

  // Probe with `stat`, not `opendir`: a root that simply is not there is the
  // normal case rather than an error, and under Bun `opendir` resolves for a
  // missing directory and only fails once it is iterated — which would report
  // every absent root as present.
  let rootStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    rootStat = await fs.stat(spec.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      errors.push({ path: label, message: (error as Error).message });
    }
    return { root, skills: [] };
  }
  if (!rootStat.isDirectory()) return { root, skills: [] };

  root.exists = true;

  const skills: ScannedSkill[] = [];
  const stack: Array<{ directory: string; depth: number }> = [{ directory: spec.path, depth: 0 }];
  const visited = new Set<string>();
  let entriesRead = 0;

  while (stack.length > 0 && !root.truncated) {
    const current = stack.pop()!;
    const realDirectory = await fs.realpath(current.directory).catch(() => undefined);
    if (!realDirectory || visited.has(realDirectory)) continue;
    visited.add(realDirectory);

    let dir: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    try {
      dir = await fs.opendir(current.directory);
      for await (const entry of dir) {
        entriesRead += 1;
        if (entriesRead > MAX_ENTRIES_PER_ROOT) {
          root.truncated = true;
          break;
        }
        if (current.depth === 0 && spec.skip?.includes(entry.name)) continue;
        // Codex hides its system cache under a dot directory and repositories
        // are full of them; neither is ever a skill.
        if (entry.name.startsWith(".")) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const skillDir = path.join(current.directory, entry.name);
        if (!(await isDirectory(skillDir))) continue;

        const skill = await readSkillDirectory(spec, skillDir, errors);
        if (skill) skills.push(skill);
        if (spec.recursive && current.depth + 1 < MAX_SCAN_DEPTH) {
          stack.push({ directory: skillDir, depth: current.depth + 1 });
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        errors.push({ path: displayPath(current.directory), message: (error as Error).message });
      }
    } finally {
      // Breaking out of `for await` already closes the handle, and Bun's second
      // `close()` returns undefined rather than a promise — so this has to guard
      // against both a throw and a non-thenable, not just a rejection.
      if (dir) {
        try {
          await dir.close();
        } catch {
          // Already closed by the iterator.
        }
      }
    }
  }

  // `skillCount` is finalised by the caller: dedupe and the per-provider cap can
  // both drop entries this root found, and a count that disagrees with the list
  // beside it is worse than no count at all.
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
  for (const { root, skills: rootSkills } of results) {
    let listed = 0;
    for (const skill of rootSkills) {
      // The cap stops the listing, but every root past it still has to say so —
      // otherwise a root the user can see skills in reports a confident zero.
      if (skills.length >= MAX_SKILLS_PER_PROVIDER) {
        root.truncated = true;
        break;
      }
      // One file reachable through two roots is one skill, not two.
      if (seenFiles.has(skill.realPath)) continue;
      seenFiles.add(skill.realPath);

      const key = skill.name.toLowerCase();
      const { realPath: _realPath, ...rest } = skill;
      skills.push({ ...rest, shadowed: seenNames.has(key) });
      seenNames.add(key);
      listed += 1;
    }
    root.skillCount = listed;
  }

  // Alphabetical by name; within a duplicated name the copy that actually loads
  // comes first, so the shadowed one reads as the alternative beneath it.
  skills.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      Number(a.shadowed) - Number(b.shadowed) ||
      SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) ||
      a.location.localeCompare(b.location),
  );

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
  if (path.basename(normalized) !== "SKILL.md")
    throw new Error("Expected filePath to be a SKILL.md");

  const specs = await rootSpecsFor(provider);
  // The separator is load-bearing: without it `~/.claude/skills-evil/x/SKILL.md`
  // would pass as a prefix match on `~/.claude/skills`.
  const allowed = specs.some((spec) => isInside(spec.path, normalized));
  if (!allowed) throw new Error("Refusing to read a file outside the agent skill directories");

  const handle = await openRegularFile(normalized);
  let buffer: Buffer;
  let bytesRead = 0;
  try {
    // Read one byte past the display limit to detect truncation without ever
    // loading the complete (user-controlled) file, and size the allocation from
    // the handle so an ordinary two-kilobyte skill does not cost a megabyte.
    const size = (await handle.stat()).size;
    const capacity = Math.min(size + 1, MAX_SKILL_FILE_BYTES + 1);
    buffer = Buffer.alloc(capacity);
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  const truncated = bytesRead > MAX_SKILL_FILE_BYTES;
  return {
    path: normalized,
    content: buffer.subarray(0, Math.min(bytesRead, MAX_SKILL_FILE_BYTES)).toString("utf8"),
    truncated,
  };
}
