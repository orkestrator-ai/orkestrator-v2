/**
 * The user's and the project's skills, for a coordinator.
 *
 * A coordinator runs with `settingSources: []`, and the pinned CLI (2.1.309)
 * then reads no skills directory at all: neither `$CLAUDE_CONFIG_DIR/skills`
 * nor `.claude/skills`, whatever `skills` or `additionalDirectories` say. The
 * one channel it still honours is the inline plugin set (`--plugin-dir`),
 * which is how plugin skills already reach a coordinator. Turning a settings
 * source on instead would also load that layer's hooks, permissions, env, MCP
 * servers and CLAUDE.md, so each skills directory is handed over as a
 * bridge-generated plugin, `user-skills` and `project-skills`, and its skills
 * are named `user-skills:<name>` and `project-skills:<name>` there.
 *
 * A skill is more than instructions. Its frontmatter can declare `hooks`
 * (registered as session hooks when it runs, and a command hook runs outside
 * the sandbox), `allowed-tools` (granted without `canUseTool`, so a tool the
 * read-only hook does not name would run), and `context`/`agent` (run in a
 * subagent). So the plugin does not point at the directory: each `SKILL.md` is
 * rewritten with only {@link KEPT_FRONTMATTER_KEYS}, re-serialised by this
 * module rather than copied, so no key the CLI's own parser might read
 * differently can survive. The body is kept as written; its inline shell
 * (`` !`cmd` ``) is turned off by the coordinator's managed settings
 * (`claudeManagedSettings`). Every other file of the skill is a symbolic link
 * to the original, so references and scripts stay readable — and running one
 * is a shell command, which the read-only hook vets like any other.
 *
 * Each mirror is content-addressed: its directory name is a digest of what it
 * holds, so a changed skill set is a changed plugin path, which the launch
 * fingerprint and the command-discovery cache already compare.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV } from "@orkestrator/protocol/coordinator";
import { claudeCoordinatorSkillPluginsDir } from "./claude-home.js";
import { debugLog } from "./logger.js";
import type { SdkPluginConfig } from "./plugin-config.js";

/** Frontmatter a mirrored skill keeps: what it is called and when to use it. */
export const KEPT_FRONTMATTER_KEYS: readonly string[] = Object.freeze([
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "version",
]);

export interface CoordinatorSkillSource {
  /** The generated plugin's name, and so the prefix of its skills. */
  plugin: "user-skills" | "project-skills";
  dir: string;
}

export interface CoordinatorSkillSet {
  plugins: SdkPluginConfig[];
  /** Plugin-qualified names (`project-skills:release`), as the CLI lists them. */
  skills: string[];
}

/** Bumped whenever the mirror layout changes, so an old mirror is never reused. */
const MIRROR_FORMAT = 1;
const MAX_SKILLS_PER_SOURCE = 256;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES_PER_SKILL = 256;
/** Older mirrors of one source kept for a CLI that is still running on one. */
const KEPT_OLD_MIRRORS = 4;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The skills directories a worker on the same account and checkout would
 * read: the user's, which the launcher names because this process's own
 * `CLAUDE_CONFIG_DIR` is the coordinator's private one, and the project's.
 */
export function coordinatorSkillSources(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): CoordinatorSkillSource[] {
  const userDir = env[COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV]?.trim();
  return [
    ...(userDir && isAbsolute(userDir) ? [{ plugin: "user-skills" as const, dir: userDir }] : []),
    { plugin: "project-skills", dir: join(cwd, ".claude", "skills") },
  ];
}

/** Build (or reuse) one plugin per skills directory that holds a usable skill. */
export async function coordinatorSkillPlugins(
  sources: readonly CoordinatorSkillSource[],
  root: string = claudeCoordinatorSkillPluginsDir(),
): Promise<CoordinatorSkillSet> {
  const plugins: SdkPluginConfig[] = [];
  const skills: string[] = [];
  for (const source of sources) {
    try {
      const mirror = await mirrorSkillSource(source, root);
      if (!mirror) continue;
      plugins.push({ type: "local", path: mirror.path });
      skills.push(...mirror.names.map((name) => `${source.plugin}:${name}`));
    } catch (error) {
      // A source that cannot be mirrored loads nothing; the turn still runs.
      debugLog("[coordinator-skills] Skipping skills source", {
        plugin: source.plugin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { plugins, skills };
}

interface MirroredSkill {
  name: string;
  text: string;
  /** Supporting entries: name in the mirror, and the path it links to. */
  links: [string, string][];
}

async function mirrorSkillSource(
  source: CoordinatorSkillSource,
  root: string,
): Promise<{ path: string; names: string[] } | undefined> {
  const dir = await realpath(source.dir).catch(() => undefined);
  if (!dir) return undefined;
  const skills = await readSkills(dir);
  if (skills.length === 0) return undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify([MIRROR_FORMAT, source.plugin, dir, skills]))
    .digest("hex")
    .slice(0, 24);
  const path = join(root, `${source.plugin}-${digest}`);
  if (!(await isMirror(path))) await writeMirror(root, path, source.plugin, skills);
  await pruneOldMirrors(root, source.plugin, path);
  return { path, names: skills.map((skill) => skill.name) };
}

async function readSkills(dir: string): Promise<MirroredSkill[]> {
  const entries = (await readdir(dir)).filter((name) => !name.startsWith(".")).sort();
  const skills: MirroredSkill[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    if (skills.length >= MAX_SKILLS_PER_SOURCE) break;
    const skillDir = await realpath(join(dir, entry)).catch(() => undefined);
    if (!skillDir || !(await stat(skillDir).catch(() => undefined))?.isDirectory()) continue;
    const skill = await readSkill(skillDir, entry);
    if (!skill || names.has(skill.name)) continue;
    names.add(skill.name);
    skills.push(skill);
  }
  return skills;
}

async function readSkill(skillDir: string, dirName: string): Promise<MirroredSkill | undefined> {
  const entries = await readdir(skillDir);
  const skillFile = entries.find((entry) => entry === "SKILL.md");
  if (!skillFile) return undefined;
  const file = join(skillDir, skillFile);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_SKILL_FILE_BYTES) return undefined;
  const sanitized = sanitizeSkillFile(await readFile(file, "utf8"), dirName);
  if (!sanitized) {
    debugLog("[coordinator-skills] Skipping skill with unreadable frontmatter", { dirName });
    return undefined;
  }
  const links: [string, string][] = entries
    .filter((entry) => entry.toLowerCase() !== "skill.md")
    .sort()
    .slice(0, MAX_ENTRIES_PER_SKILL)
    .map((entry) => [entry, join(skillDir, entry)]);
  return { name: sanitized.name, text: sanitized.text, links };
}

type YamlParse = (text: string) => unknown;

/** Bun's parser; a runtime without one (Node) mirrors nothing that has frontmatter. */
function yamlParser(): YamlParse | null {
  const parse = (globalThis as { Bun?: { YAML?: { parse?: YamlParse } } }).Bun?.YAML?.parse;
  return typeof parse === "function" ? parse : null;
}

/**
 * A `SKILL.md` with only {@link KEPT_FRONTMATTER_KEYS}, or undefined when its
 * frontmatter cannot be read (no YAML parser, a syntax error, not a mapping).
 *
 * Values are re-serialised as JSON scalars, which YAML reads as the same
 * strings and booleans, so the output's frontmatter is exactly what this
 * function decided and nothing of the original's syntax carries over. The
 * skill is always named after its mirror directory, so the CLI lists one name
 * whichever of the two it reads.
 */
export function sanitizeSkillFile(
  text: string,
  dirName: string,
  parse: YamlParse | null = yamlParser(),
): { name: string; text: string } | undefined {
  const match = FRONTMATTER.exec(text);
  let fields: Record<string, unknown> = {};
  if (match) {
    if (!parse) return undefined;
    let parsed: unknown;
    try {
      parsed = parse(match[1]!);
    } catch {
      return undefined;
    }
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      fields = parsed as Record<string, unknown>;
    }
  }
  const declared = typeof fields.name === "string" ? fields.name.trim() : "";
  const name = SKILL_NAME.test(declared) ? declared : dirName;
  if (!SKILL_NAME.test(name)) return undefined;
  const lines = [`name: ${JSON.stringify(name)}`];
  for (const key of KEPT_FRONTMATTER_KEYS) {
    if (key === "name" || !Object.hasOwn(fields, key)) continue;
    const value = frontmatterValue(fields[key]);
    if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  const body = match ? text.slice(match[0].length) : text.replace(/^﻿/, "");
  return { name, text: `---\n${lines.join("\n")}\n---\n${body}` };
}

function frontmatterValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(String(value));
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return JSON.stringify(value);
  return undefined;
}

async function isMirror(path: string): Promise<boolean> {
  return (await stat(join(path, ".claude-plugin", "plugin.json")).catch(() => undefined))?.isFile()
    ? true
    : false;
}

/**
 * Write the mirror beside its final path and rename it into place, so a CLI
 * never sees a half-written plugin and two turns building the same mirror
 * leave one copy.
 */
async function writeMirror(
  root: string,
  path: string,
  plugin: CoordinatorSkillSource["plugin"],
  skills: readonly MirroredSkill[],
): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const staging = join(root, `.staging-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(join(staging, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(staging, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: plugin,
        description:
          plugin === "user-skills"
            ? "The user's own Claude skills, mirrored by Orkestrator without hooks or tool grants."
            : "This project's .claude/skills, mirrored by Orkestrator without hooks or tool grants.",
      }),
    );
    for (const skill of skills) {
      const skillDir = join(staging, "skills", skill.name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), skill.text);
      for (const [name, target] of skill.links) await symlink(target, join(skillDir, name));
    }
    try {
      await rename(staging, path);
    } catch (error) {
      // Another turn renamed the same content into place first.
      if (!(await isMirror(path))) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function pruneOldMirrors(
  root: string,
  plugin: CoordinatorSkillSource["plugin"],
  current: string,
): Promise<void> {
  try {
    const old = await Promise.all(
      (await readdir(root))
        .filter((name) => name.startsWith(`${plugin}-`) && join(root, name) !== current)
        .map(async (name) => ({
          path: join(root, name),
          mtimeMs: (await stat(join(root, name)).catch(() => undefined))?.mtimeMs ?? 0,
        })),
    );
    old.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { path } of old.slice(KEPT_OLD_MIRRORS)) {
      await rm(path, { recursive: true, force: true });
    }
  } catch {
    // Pruning is housekeeping; a mirror left behind costs only disk.
  }
}
