/**
 * The user's and the project's skills, for a Cursor coordinator.
 *
 * A Cursor coordinator attaches with `settingSources: []`: the SDK (1.0.40)
 * has no skills-only switch, and the `user` layer would also load the host's
 * `~/.cursor/mcp.json` through the `mcp` capability the coordinator's
 * allowlist has to grant for delegation. So the bridge hosts one tool of its
 * own, `orkestrator-skills__load`, beside the Orkestrator and research tools
 * it already hosts in-process. Its description lists the skills Cursor would
 * discover (`.cursor`, `.agents` and the third-party `.claude`, `.codex` and
 * `.grok` skills directories, under the checkout and under HOME), and calling
 * it returns a skill's `SKILL.md`, or one of the skill's own files, as text.
 *
 * The tool only reads. A skill's instructions can ask for anything, but the
 * coordinator's closed tool allowlist and Cursor's sandbox still decide what
 * runs; no frontmatter key is acted on. A file is served only from inside the
 * skill's own directory, and a directory counts as a skill only when it holds
 * a `SKILL.md` and is not HOME, the root, or an ancestor of either, so a link
 * in the checkout cannot turn the tool into a reader for the user's home.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { SDKCustomTool } from "@cursor/sdk";

/** Reserved like `orkestrator`, so no research server can share the prefix. */
export const COORDINATOR_SKILLS_SERVER = "orkestrator-skills";
export const COORDINATOR_SKILLS_TOOL = `${COORDINATOR_SKILLS_SERVER}__load`;

/** Cursor's own skill directories, in its order. */
const SKILL_DIRECTORIES = [
  [".cursor", "skills"],
  [".agents", "skills"],
  [".claude", "skills"],
  [".codex", "skills"],
  [".grok", "skills"],
] as const;
/** Codex's bundled skills, which Cursor also leaves out of `.codex/skills`. */
const CODEX_SYSTEM_SKILLS = new Set([
  "imagegen",
  "openai-docs",
  "plugin-creator",
  "skill-creator",
  "skill-installer",
]);
const MAX_SKILLS = 200;
const MAX_ENTRIES_PER_DIRECTORY = 256;
const MAX_LISTING_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_FILE_BYTES = 256 * 1024;
const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface CoordinatorSkill {
  name: string;
  description: string;
  scope: "project" | "user";
  /** Real path of the skill's directory. */
  dir: string;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Name and description from a `SKILL.md`, as Cursor lists them. */
export function skillHeader(text: string, dirName: string): { name: string; description: string } {
  const match = FRONTMATTER.exec(text);
  let fields: Record<string, unknown> = {};
  const parse = (globalThis as { Bun?: { YAML?: { parse?: (text: string) => unknown } } }).Bun?.YAML
    ?.parse;
  if (match && parse) {
    try {
      const parsed = parse(match[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fields = parsed as Record<string, unknown>;
      }
    } catch {
      // A skill whose frontmatter does not parse is listed by its directory.
    }
  }
  const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : dirName;
  const description =
    typeof fields.description === "string" ? fields.description.replace(/\s+/g, " ").trim() : "";
  return { name, description: description.slice(0, MAX_DESCRIPTION_CHARS) };
}

/**
 * The skills Cursor would discover for this checkout and HOME, project ones
 * first; a later skill with a name already listed is left out.
 */
export function discoverCoordinatorSkills(
  cwd: string,
  home: string = homedir(),
): CoordinatorSkill[] {
  const homeReal = realOrSelf(home);
  const skillable = (dir: string) =>
    dir !== sep && !isWithin(dir, homeReal) && !isWithin(dir, home);
  const skills: CoordinatorSkill[] = [];
  const names = new Set<string>();
  for (const [root, scope] of [
    [cwd, "project"],
    [home, "user"],
  ] as const) {
    for (const [configDir, subdir] of SKILL_DIRECTORIES) {
      const directory = join(root, configDir, subdir);
      let entries: string[];
      try {
        entries = readdirSync(directory)
          .filter((name) => !name.startsWith("."))
          .sort();
      } catch {
        continue;
      }
      for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
        if (skills.length >= MAX_SKILLS) return skills;
        if (configDir === ".codex" && CODEX_SYSTEM_SKILLS.has(entry)) continue;
        let dir: string;
        let text: string;
        try {
          dir = realpathSync(join(directory, entry));
          if (!statSync(dir).isDirectory() || !skillable(dir)) continue;
          const file = join(dir, "SKILL.md");
          if (!existsSync(file) || statSync(file).size > MAX_FILE_BYTES) continue;
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const header = skillHeader(text, entry);
        if (names.has(header.name)) continue;
        names.add(header.name);
        skills.push({ ...header, scope, dir });
      }
    }
  }
  return skills;
}

function listing(skills: readonly CoordinatorSkill[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const skill of skills) {
    const line = `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`;
    if (size + line.length > MAX_LISTING_CHARS) {
      lines.push(`- … ${skills.length - lines.length} more; call with a skill's name to load it`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/** A file of one skill, as text, or why it cannot be read. */
export function readSkillFile(
  skill: CoordinatorSkill,
  file: string | undefined,
): { ok: true; text: string } | { ok: false; message: string } {
  const requested = file?.trim() || "SKILL.md";
  if (isAbsolute(requested))
    return { ok: false, message: "Name a file inside the skill, not a path." };
  let path: string;
  try {
    path = realpathSync(join(skill.dir, requested));
  } catch {
    return { ok: false, message: `The ${skill.name} skill has no file ${requested}.` };
  }
  if (!isWithin(skill.dir, path)) {
    return { ok: false, message: "Only files inside the skill's own directory can be read." };
  }
  try {
    const info = statSync(path);
    if (info.isDirectory()) {
      const entries = readdirSync(path).slice(0, MAX_ENTRIES_PER_DIRECTORY).sort();
      return { ok: true, text: entries.join("\n") };
    }
    if (info.size > MAX_FILE_BYTES) {
      return { ok: false, message: `${requested} is larger than ${MAX_FILE_BYTES} bytes.` };
    }
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch {
    return { ok: false, message: `${requested} could not be read.` };
  }
}

/**
 * The hosted skill tool for a coordinator process, or undefined when there is
 * nothing to load or this is not a coordinator.
 */
export function hostSkillCustomTools(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string,
  home: string = env.HOME?.trim() || homedir(),
): { customTools: Record<string, SDKCustomTool>; skills: CoordinatorSkill[] } | undefined {
  if (env.ORKESTRATOR_BRIDGE_EXECUTION_POLICY !== "coordinator-read-only") return undefined;
  const skills = discoverCoordinatorSkills(cwd, home);
  if (skills.length === 0) return undefined;
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    skills,
    customTools: {
      [COORDINATOR_SKILLS_TOOL]: {
        description:
          "Load one of the user's or the project's skills: instructions for a task, such as a release " +
          "procedure. Call it with the skill's name to read its SKILL.md, and with `file` set to a path " +
          "inside the skill to read one of its other files. It only reads; follow the skill with the " +
          `tools this session has, and delegate anything that writes. Available skills:\n${listing(skills)}`,
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The skill's name, as listed." },
            file: {
              type: "string",
              description: "Optional path inside the skill, such as references/checklist.md.",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        execute: async (args) => {
          const input = (args && typeof args === "object" ? args : {}) as {
            name?: unknown;
            file?: unknown;
          };
          const name = typeof input.name === "string" ? input.name.trim() : "";
          const skill = byName.get(name);
          if (!skill) return textResult(`There is no skill named ${name || "(none)"}.`, true);
          const read = readSkillFile(
            skill,
            typeof input.file === "string" ? input.file : undefined,
          );
          if (!read.ok) return textResult(read.message, true);
          return textResult(
            input.file === undefined
              ? `Skill: ${skill.name}\nBase directory: ${skill.dir}\n\n${read.text}`
              : read.text,
          );
        },
      },
    },
  };
}
