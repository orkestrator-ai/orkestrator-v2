/**
 * The user's global OpenCode configuration on an OpenCode 2.x server
 * (docs/todo/agent-engines/0008-opencode-v2.md, "the user's global MCP
 * servers").
 *
 * A 1.x server reads `$XDG_CONFIG_HOME/opencode` (`config.json`,
 * `opencode.json`, `opencode.jsonc`, and the `agent`, `command`, `skills`
 * and `plugin` directories beside them); Orkestrator's `OPENCODE_CONFIG_DIR`
 * only adds a directory. On 2.2.6 `OPENCODE_CONFIG_DIR` *replaces* that
 * global directory (`Global.config` in `packages/util/src/global.ts`), and
 * Orkestrator needs it for the credential plugin. Pointing it at the user's
 * directory instead is not an option: 2.x writes there (`cli.json` on
 * start, `opencode.jsonc` through `Config.update`).
 *
 * So Orkestrator's 2.x config directory mirrors the user's, read-only:
 *
 * - **One merged document**, `opencode.jsonc`, from the user's three files in
 *   1.x's order (later wins; objects merge, `instructions` concatenate), with
 *   `plugin`/`plugins` removed. 2.x loads it as its global layer, below
 *   `OPENCODE_CONFIG`, project files and `.opencode` directories, which is
 *   where 1.x puts the user's files too. A relative `{file:...}` reference is
 *   rebased onto the user's directory, where 1.x resolves it.
 * - **Links** to the user's `agent(s)`, `mode(s)`, `command(s)`, `skill(s)`
 *   and `AGENTS.md`, which 2.x reads from its global directory.
 * - **Never the user's plugins.** A 1.x plugin does not run on 2.x (its
 *   module has no `{ id, setup }`), but 2.x still installs an npm `plugin`
 *   entry and holds its plugin registry until the install settles, and a
 *   2.x `plugins: ["-*"]` would unload Orkestrator's credential plugin.
 *   Neither the `plugin` key nor the user's plugin directories reach 2.x.
 * - **`OPENCODE_CONFIG`**, when the backend has one, is mirrored the same way
 *   to a file of its own and passed in its place.
 *
 * Nothing is ever written below the user's directory. The mirror holds what
 * the user's files hold (API keys included), so it is owner-only, beside the
 * 2.x database that already holds the imported `auth.json` credentials. It is
 * refreshed on every 2.x server start; a running server watches its config
 * directory, so it follows a refresh made by another environment's start.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("native-agent.opencode2");

/** The user's global files, in the order 1.x merges them (later wins). */
export const OPENCODE_USER_CONFIG_FILES = [
  "config.json",
  "opencode.json",
  "opencode.jsonc",
] as const;

/** The merged mirror inside the 2.x config directory. */
export const OPENCODE2_USER_CONFIG_MIRROR_FILE = "opencode.jsonc";

/**
 * Global-directory entries 2.2.6 reads (`config/plugin/agent.ts`,
 * `command.ts`, `skill.ts`, `instruction.ts`), linked from the mirror. The
 * `plugin`/`plugins` directories are deliberately absent.
 */
export const OPENCODE2_LINKED_USER_ENTRIES = [
  "agent",
  "agents",
  "mode",
  "modes",
  "command",
  "commands",
  "skill",
  "skills",
  "AGENTS.md",
] as const;

export interface OpenCodeUserConfigFile {
  /** For diagnostics only. */
  name: string;
  /** The directory the file lives in; relative `{file:...}` references resolve there. */
  directory: string;
  text: string;
}

export interface OpenCodeUserConfigMerge {
  /** The mirror document, or undefined when no file could be read. */
  text?: string;
  /** Files that are not a JSONC object and were left out. */
  rejected: string[];
  /** Whether a `plugin`/`plugins` key was removed. */
  droppedPlugins: boolean;
}

/**
 * Merge the user's files into one 2.x-safe document. Self-contained (it uses
 * only `Bun.JSONC` and built-ins), because the container start script runs
 * its source with the image's Bun (`buildOpenCode2ContainerUserConfigScript`).
 */
export function mergeOpenCodeUserConfig(
  files: readonly OpenCodeUserConfigFile[],
): OpenCodeUserConfigMerge {
  type Json = unknown;
  type JsonObject = Record<string, Json>;
  const jsonc = (globalThis as unknown as { Bun: { JSONC: { parse(text: string): Json } } }).Bun
    .JSONC;
  const isObject = (value: Json): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const isAbsolute = (file: string) =>
    file.startsWith("/") || file.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(file);
  const rebase = (value: Json, directory: string): Json => {
    if (typeof value === "string") {
      return value.replace(/\{file:([^}]+)\}/g, (token, file: string) =>
        file.startsWith("~/") || isAbsolute(file)
          ? token
          : `{file:${directory.replace(/[\\/]+$/, "")}/${file}}`,
      );
    }
    if (Array.isArray(value)) return value.map((item) => rebase(item, directory));
    if (!isObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (key !== "__proto__") out[key] = rebase(item, directory);
    }
    return out;
  };
  const merge = (base: Json, next: Json): Json => {
    if (!isObject(base) || !isObject(next)) return next;
    const out: JsonObject = { ...base };
    for (const [key, item] of Object.entries(next)) {
      if (key === "__proto__") continue;
      out[key] = Object.hasOwn(out, key) ? merge(out[key], item) : item;
    }
    return out;
  };
  const rejected: string[] = [];
  let droppedPlugins = false;
  let merged: JsonObject | undefined;
  for (const file of files) {
    let parsed: Json;
    try {
      parsed = jsonc.parse(file.text);
    } catch {
      rejected.push(file.name);
      continue;
    }
    if (!isObject(parsed)) {
      rejected.push(file.name);
      continue;
    }
    const document = rebase(parsed, file.directory) as JsonObject;
    if (Object.hasOwn(document, "plugin") || Object.hasOwn(document, "plugins")) {
      droppedPlugins = true;
      delete document.plugin;
      delete document.plugins;
    }
    const instructions = [merged?.instructions, document.instructions];
    merged = merged ? (merge(merged, document) as JsonObject) : document;
    if (instructions.every(Array.isArray)) {
      merged.instructions = [...new Set(instructions.flat() as Json[])];
    }
  }
  if (!merged) return { rejected, droppedPlugins };
  const text =
    "// Written by Orkestrator from your OpenCode configuration for its OpenCode 2 servers.\n" +
    "// Replaced whenever one starts; edit the original instead.\n" +
    `${JSON.stringify(merged, null, 2)}\n`;
  return { text, rejected, droppedPlugins };
}

/** The image's own Bun (`docker/Dockerfile`), which runs the container mirror. */
export const OPENCODE2_CONTAINER_BUN = "/usr/local/bin/bun";

/**
 * The container form of {@link mirrorOpenCodeUserConfig}, for the 2.x start
 * script: links the same entries and runs {@link mergeOpenCodeUserConfig}'s
 * own source with the image's Bun. The container's `~/.config/opencode` is
 * the copy the entrypoint made of the host's, plus Orkestrator's 1.x plugins,
 * which stay out like the user's. Any failure leaves the server without the
 * user's files, never without its plugins: it never fails the start.
 * `quote` is the shell quoting of the caller's script.
 */
export function buildOpenCode2ContainerUserConfigScript(
  userDir: string,
  configDir: string,
  quote: (value: string) => string,
): string {
  const mirror = path.posix.join(configDir, OPENCODE2_USER_CONFIG_MIRROR_FILE);
  return [
    `for entry in ${OPENCODE2_LINKED_USER_ENTRIES.join(" ")}; do`,
    `      if [ -L ${configDir}/"$entry" ]; then rm -f ${configDir}/"$entry"; fi`,
    `      if [ -e ${userDir}/"$entry" ]; then ln -s ${userDir}/"$entry" ${configDir}/"$entry" || true; fi`,
    `    done`,
    `    rm -f ${configDir}/opencode.json`,
    `    ${buildOpenCode2UserConfigMergeCommand(userDir, mirror, quote, OPENCODE2_CONTAINER_BUN)} || rm -f ${mirror}`,
  ].join("\n");
}

/**
 * One shell command that writes the merged mirror of `userDir`'s files to
 * `mirror` (owner-only), with `bun` running {@link mergeOpenCodeUserConfig}'s
 * own source. Removes `mirror` when no file could be read.
 */
export function buildOpenCode2UserConfigMergeCommand(
  userDir: string,
  mirror: string,
  quote: (value: string) => string,
  bun: string,
): string {
  const program = `const fs = require("node:fs");
const path = require("node:path");
const merge = (${mergeOpenCodeUserConfig.toString()});
const source = process.env.ORK_OPENCODE_USER_DIR;
const target = process.env.ORK_OPENCODE_MIRROR;
const files = [];
for (const name of ${JSON.stringify(OPENCODE_USER_CONFIG_FILES)}) {
  try {
    files.push({ name, directory: source, text: fs.readFileSync(path.join(source, name), "utf8") });
  } catch {}
}
const result = merge(files);
if (result.rejected.length) {
  process.stderr.write("OpenCode 2 left out unreadable configuration: " + result.rejected.join(", ") + "\\n");
}
if (result.text === undefined) {
  fs.rmSync(target, { force: true });
} else {
  const staged = target + "." + process.pid + ".tmp";
  fs.writeFileSync(staged, result.text, { mode: 0o600 });
  fs.renameSync(staged, target);
}
`;
  return `ORK_OPENCODE_USER_DIR=${quote(userDir)} ORK_OPENCODE_MIRROR=${quote(mirror)} ${bun} -e ${quote(program)}`;
}

/** `$XDG_CONFIG_HOME/opencode`, the user's global OpenCode configuration directory. */
export function openCodeUserConfigDirectory(
  env: NodeJS.ProcessEnv,
  home = env.HOME?.trim() || os.homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg ? path.resolve(xdg) : path.join(home, ".config"), "opencode");
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Write `text` to `file` (owner-only) unless it already holds it; remove it when undefined. */
async function publish(file: string, text: string | undefined): Promise<void> {
  if (text === undefined) {
    await rm(file, { force: true });
    return;
  }
  if ((await readOptional(file)) === text) return;
  // A server starting alongside this one must never load half a file.
  const staged = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, text, { mode: 0o600, flag: "wx" });
    await rename(staged, file);
  } finally {
    await rm(staged, { force: true });
  }
}

async function mirrorFiles(
  files: ReadonlyArray<{ name: string; file: string }>,
  target: string,
  label: string,
): Promise<void> {
  const read: OpenCodeUserConfigFile[] = [];
  for (const { name, file } of files) {
    const text = await readOptional(file).catch((error: unknown) => {
      log.warn("user-config.unreadable", {
        source: label,
        file: name,
        code: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
      return undefined;
    });
    if (text !== undefined) read.push({ name, directory: path.dirname(file), text });
  }
  const result = mergeOpenCodeUserConfig(read);
  // Names only: the files themselves may hold credentials.
  if (result.rejected.length) {
    log.warn("user-config.rejected", { source: label, files: result.rejected.join(",") });
  }
  if (result.droppedPlugins) log.info("user-config.plugins-withheld", { source: label });
  await publish(target, result.text);
}

/** Point `link` at `target`, replacing an older link; never touches anything that is not a link. */
async function ensureLink(link: string, target: string | undefined): Promise<void> {
  const current = await lstat(link).catch(() => undefined);
  if (current && !current.isSymbolicLink()) return;
  if (target === undefined) {
    if (current) await rm(link, { force: true });
    return;
  }
  if (current && (await readlink(link).catch(() => undefined)) === target) return;
  const staged = `${link}.${randomUUID()}.tmp`;
  try {
    await symlink(target, staged);
    await rename(staged, link);
  } finally {
    await rm(staged, { force: true });
  }
}

/**
 * Refresh the mirror of the user's global configuration in `configDir` and,
 * when `env.OPENCODE_CONFIG` names a file, its mirror at `customConfigFile`.
 * Reads only below the user's directory; writes only below Orkestrator's.
 */
export async function mirrorOpenCodeUserConfig(input: {
  configDir: string;
  customConfigFile: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const home = input.env.HOME?.trim() || os.homedir();
  const userDir = openCodeUserConfigDirectory(input.env, home);
  await mirrorFiles(
    OPENCODE_USER_CONFIG_FILES.map((name) => ({ name, file: path.join(userDir, name) })),
    path.join(input.configDir, OPENCODE2_USER_CONFIG_MIRROR_FILE),
    "global",
  );
  // 2.x loads both names from its global directory; only the merged one is ours.
  await rm(path.join(input.configDir, "opencode.json"), { force: true });
  for (const entry of OPENCODE2_LINKED_USER_ENTRIES) {
    const source = path.join(userDir, entry);
    const exists = await lstat(source).then(
      () => true,
      () => false,
    );
    await ensureLink(path.join(input.configDir, entry), exists ? source : undefined);
  }
  const custom = input.env.OPENCODE_CONFIG?.trim();
  const customPath = custom
    ? path.resolve(custom.startsWith("~/") ? path.join(home, custom.slice(2)) : custom)
    : undefined;
  if (customPath) {
    await mkdir(path.dirname(input.customConfigFile), { recursive: true, mode: 0o700 });
    await mirrorFiles(
      [{ name: path.basename(customPath), file: customPath }],
      input.customConfigFile,
      "OPENCODE_CONFIG",
    );
  } else {
    await rm(input.customConfigFile, { force: true });
  }
}
