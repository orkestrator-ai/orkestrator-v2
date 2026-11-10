/**
 * The checkout's OpenCode configuration, filtered, for a server the launcher
 * starts (to-do 7550, task 3; docs/architecture/agent-approvals.md).
 *
 * On an `opencode-launch=1` image the server runs with project configuration
 * off, because the checkout's `opencode.json` is the agent's to write and its
 * `plugin` key loads code inside the server, beside the password. That also
 * dropped what projects legitimately keep there: agents, commands, MCP servers,
 * permission rules, models and instructions. Before each start the backend
 * reads `/workspace/opencode.json` and `/workspace/opencode.jsonc` (as `node`,
 * bounded), filters them here, and root writes the result where the launcher
 * passes it as `OPENCODE_CONFIG` on an `opencode2-launch=1` image:
 *
 * - **No `plugin` or `plugins` key** (`mergeOpenCodeUserConfig` drops both).
 * - **No `{env:...}` reference.** OpenCode substitutes it from the server's
 *   own environment when it loads the file, before any plugin runs, and that
 *   environment holds the password. Nothing else is in it under `env -i`, so a
 *   project loses nothing it could have had.
 * - **`{file:...}` only inside the checkout, inlined.** The file is read as
 *   `node` now, so a link to `/proc/self/environ` reads that `cat`'s
 *   environment, not the server's. A reference outside the checkout (absolute,
 *   `~/`, or climbing out with `..`) is dropped, and so is one whose content
 *   holds a reference of its own.
 * - **Instructions copied.** OpenCode reads an instruction file by path from
 *   the server's own process each time it builds a prompt, so a checkout
 *   `AGENTS.md` linked to `/proc/self/environ` put the server's password in
 *   the prompt (shown on 2.2.6, 2026-11-10). The checkout's `AGENTS.md` and
 *   each instruction inside the checkout are read now, as `node`, and root
 *   writes the copies beside the document, which names those instead; a path
 *   outside the checkout is dropped. A change to them reaches the server at
 *   its next start.
 *
 * A value that is dropped is removed with its key (or its array slot), never
 * replaced, so the server sees exactly what the project wrote minus those.
 * MCP servers, permission rules and the rest remain the agent's to change, as
 * they were before 7252: they shape what the server does, not what runs inside
 * it. The project's `.opencode/` directories are not read.
 */
import path from "node:path";
import { createLogger } from "@orkestrator/protocol/logger";
import { CONTAINER_ROOT_USER_ARGS } from "./container-scripts.js";
import { dockerExec } from "./commands-container-exec.js";
import {
  OPENCODE2_LAUNCH_PROJECT_CONFIG,
  OPENCODE_LAUNCH_PROJECT_CONFIG,
} from "./agent-credential-files.js";
import type { OpenCodeServerKind } from "./opencode-listener-identity.js";
import { mergeOpenCodeUserConfig } from "./opencode2/user-config.js";
import { runCommand } from "./shell.js";

const log = createLogger("docker");

/** The checkout inside the container. */
export const OPENCODE_PROJECT_DIRECTORY = "/workspace";
/** The project files OpenCode reads at the checkout's root, in the order it merges them. */
export const OPENCODE_PROJECT_CONFIG_FILES = ["opencode.json", "opencode.jsonc"] as const;
/** A project file larger than this is not read. */
export const OPENCODE_PROJECT_CONFIG_MAX_BYTES = 256 * 1024;
/** At most this many `{file:}` references are inlined; the rest are dropped. */
export const OPENCODE_PROJECT_FILE_REFERENCE_LIMIT = 16;
/** At most this many instruction files (the checkout's `AGENTS.md` included) are copied. */
export const OPENCODE_PROJECT_INSTRUCTION_LIMIT = 16;
/** A referenced file larger than this is dropped rather than inlined. */
export const OPENCODE_PROJECT_FILE_REFERENCE_MAX_BYTES = 64 * 1024;
/** Instructions have a separate bound; sixteen copies stay bounded to 16 MiB. */
export const OPENCODE_PROJECT_INSTRUCTION_MAX_BYTES = 1024 * 1024;

const REFERENCE = /\{(env|file):([^}]*)\}/g;
const ANY_REFERENCE = /\{(?:env|file):/;

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `file` as a path inside the checkout, relative to it, or undefined when it leaves it. */
export function checkoutRelativePath(
  file: string,
  root = OPENCODE_PROJECT_DIRECTORY,
): string | undefined {
  const trimmed = file.trim();
  if (!trimmed || trimmed.startsWith("~") || trimmed.includes("\0")) return undefined;
  const resolved = path.posix.resolve(root, trimmed);
  const relative = path.posix.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative)) return undefined;
  return relative;
}

export interface FilteredProjectConfig {
  /** The document to write, or undefined when the project has none (or nothing survived). */
  text?: string;
  /**
   * The instruction files the document names, in order, by content: written
   * beside it as root, so the server never reads an instruction by a path the
   * agent can point elsewhere.
   */
  instructions: string[];
  /** Why values were left out, by kind; never the values. */
  dropped: { plugins: boolean; env: number; file: number; instructions: number };
  /** Files that are not a JSONC object and were left out. */
  rejected: string[];
}

/**
 * Filter the project's files. `readFile` reads a checkout-relative path as
 * `node` and returns undefined when it cannot or the file is too large;
 * `instructionPath` names where the `index`th instruction copy is written.
 * The checkout's `AGENTS.md`, which OpenCode reads as a project instruction,
 * comes first when it exists.
 */
export async function filterProjectOpenCodeConfig(
  files: ReadonlyArray<{ name: string; text: string }>,
  readFile: (relative: string) => Promise<string | undefined>,
  instructionPath: (index: number) => string,
  root = OPENCODE_PROJECT_DIRECTORY,
  readInstruction = readFile,
): Promise<FilteredProjectConfig> {
  const merged = mergeOpenCodeUserConfig(
    files.map((file) => ({ name: file.name, directory: root, text: file.text })),
  );
  const dropped = { plugins: merged.droppedPlugins, env: 0, file: 0, instructions: 0 };
  const document =
    merged.text === undefined
      ? {}
      : (JSON.parse(merged.text.replace(/^(?:\/\/[^\n]*\n)+/, "")) as JsonObject);
  // Provider modules execute inside the credential-bearing process, just like
  // plugins. Only the trusted host configuration may select their implementation.
  if (isObject(document.provider)) {
    for (const provider of Object.values(document.provider)) {
      if (isObject(provider) && Object.hasOwn(provider, "npm")) {
        delete provider.npm;
        dropped.plugins = true;
      }
    }
  }
  let budget = OPENCODE_PROJECT_FILE_REFERENCE_LIMIT;

  /** The string with its references inlined, or undefined when it must be dropped. */
  const resolveString = async (value: string): Promise<string | undefined> => {
    let output = "";
    let last = 0;
    for (const match of value.matchAll(REFERENCE)) {
      const [token, kind, target = ""] = match;
      if (kind === "env") {
        dropped.env++;
        return undefined;
      }
      const relative = checkoutRelativePath(target, root);
      if (!relative || budget <= 0) {
        dropped.file++;
        return undefined;
      }
      budget--;
      const content = await readFile(relative);
      if (content === undefined || ANY_REFERENCE.test(content)) {
        dropped.file++;
        return undefined;
      }
      output += value.slice(last, match.index) + content;
      last = (match.index ?? 0) + token.length;
    }
    output += value.slice(last);
    // A reference split across the substitution, or a malformed one.
    if (ANY_REFERENCE.test(output)) {
      dropped.file++;
      return undefined;
    }
    return output;
  };

  const walk = async (value: Json): Promise<Json | undefined> => {
    if (typeof value === "string") return resolveString(value);
    if (Array.isArray(value)) {
      const out: Json[] = [];
      for (const item of value) {
        const kept = await walk(item);
        if (kept !== undefined) out.push(kept);
      }
      return out;
    }
    if (!isObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (ANY_REFERENCE.test(key)) {
        dropped.file++;
        continue;
      }
      const kept = await walk(item);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  };

  // Instructions are read when the server builds a prompt, by path, from the
  // server's own process: a link to /proc/self/environ there would put its
  // password in the prompt. So each is copied now, read as `node`.
  const requested = [
    "AGENTS.md",
    ...(Array.isArray(document.instructions) ? document.instructions : []),
  ];
  const listed = Object.hasOwn(document, "instructions");
  const instructions: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of requested.entries()) {
    const relative = typeof entry === "string" ? checkoutRelativePath(entry, root) : undefined;
    if (relative && seen.has(relative)) continue;
    const content =
      relative && instructions.length < OPENCODE_PROJECT_INSTRUCTION_LIMIT
        ? await readInstruction(relative)
        : undefined;
    if (relative) seen.add(relative);
    // A missing AGENTS.md is not something the project asked for.
    if (content === undefined) {
      if (index > 0) dropped.instructions++;
      continue;
    }
    instructions.push(content);
  }
  if (instructions.length) {
    document.instructions = instructions.map((_, index) => instructionPath(index));
  } else if (listed) {
    document.instructions = [];
  }
  const filtered = (await walk(document)) as JsonObject;
  if (!Object.keys(filtered).length)
    return { instructions: [], dropped, rejected: merged.rejected };
  const text = `${JSON.stringify(filtered, null, 2)}\n`;
  // OpenCode substitutes references in the file's raw text: none may remain.
  if (ANY_REFERENCE.test(text)) return { instructions: [], dropped, rejected: merged.rejected };
  return { text, instructions, dropped, rejected: merged.rejected };
}

/**
 * Shell, run as `node`, that prints `F` and then a file of at most `maxBytes`
 * (one more to detect overflow), or nothing when it is not a regular file.
 */
function boundedReadCommand(file: string, maxBytes: number): string {
  const quoted = `'${file.replaceAll("'", "'\\''")}'`;
  return `if [ -f ${quoted} ]; then printf F; head -c ${maxBytes + 1} -- ${quoted}; fi`;
}

/** What {@link boundedReadCommand} printed: the file, or undefined when absent or too large. */
function boundedReadResult(output: string | undefined, maxBytes: number): string | undefined {
  if (!output?.startsWith("F")) return undefined;
  const content = output.slice(1);
  return Buffer.byteLength(content) > maxBytes ? undefined : content;
}

/** Read the checkout's project configuration as `node` and filter it for `kind`'s server. */
export async function readFilteredProjectOpenCodeConfig(
  containerId: string,
  kind: OpenCodeServerKind,
  exec: typeof dockerExec = dockerExec,
): Promise<FilteredProjectConfig> {
  const read = async (relative: string, maxBytes: number) =>
    boundedReadResult(
      await exec(
        containerId,
        boundedReadCommand(path.posix.join(OPENCODE_PROJECT_DIRECTORY, relative), maxBytes),
        15_000,
      ).catch(() => undefined),
      maxBytes,
    );
  const files: Array<{ name: string; text: string }> = [];
  for (const name of OPENCODE_PROJECT_CONFIG_FILES) {
    const text = await read(name, OPENCODE_PROJECT_CONFIG_MAX_BYTES);
    if (text === undefined) {
      if (
        await exec(
          containerId,
          `[ -f '${OPENCODE_PROJECT_DIRECTORY}/${name}' ] && echo present`,
          15_000,
        )
          .then((answer) => answer.trim() === "present")
          .catch(() => false)
      ) {
        log.warn("opencode.project-config-too-large", { file: name });
      }
      continue;
    }
    if (text.trim()) files.push({ name, text });
  }
  let oversizedInstructions = 0;
  const result = await filterProjectOpenCodeConfig(
    files,
    (relative) => read(relative, OPENCODE_PROJECT_FILE_REFERENCE_MAX_BYTES),
    (index) => openCodeProjectInstructionPath(kind, index),
    OPENCODE_PROJECT_DIRECTORY,
    async (relative) => {
      const output = await exec(
        containerId,
        boundedReadCommand(
          path.posix.join(OPENCODE_PROJECT_DIRECTORY, relative),
          OPENCODE_PROJECT_INSTRUCTION_MAX_BYTES,
        ),
        15_000,
      ).catch(() => undefined);
      const content = boundedReadResult(output, OPENCODE_PROJECT_INSTRUCTION_MAX_BYTES);
      if (relative === "AGENTS.md" && output?.startsWith("F") && content === undefined)
        oversizedInstructions++;
      return content;
    },
  );
  result.dropped.instructions += oversizedInstructions;
  const { plugins, env, file, instructions } = result.dropped;
  if (plugins || env || file || instructions || result.rejected.length) {
    // Counts and file names only: values may be credentials.
    log.info("opencode.project-config-filtered", {
      plugins,
      env,
      file,
      instructions,
      rejected: result.rejected.join(","),
    });
  }
  return result;
}

export function openCodeProjectConfigPath(kind: OpenCodeServerKind): string {
  return kind === "opencode2" ? OPENCODE2_LAUNCH_PROJECT_CONFIG : OPENCODE_LAUNCH_PROJECT_CONFIG;
}

/** Where root writes the `index`th instruction copy for `kind`'s server. */
export function openCodeProjectInstructionPath(kind: OpenCodeServerKind, index: number): string {
  return `${path.posix.dirname(openCodeProjectConfigPath(kind))}/instructions/${index}.md`;
}

/**
 * Root shell that replaces the project configuration with stdin (or removes
 * it when stdin is empty): root-owned, readable by the server's uid, never a
 * link. The root directory must already be root's (the config script checks).
 */
export function writeProjectOpenCodeConfigScript(kind: OpenCodeServerKind): string {
  const file = openCodeProjectConfigPath(kind);
  const directory = path.posix.dirname(file);
  return [
    "set -eu",
    "umask 022",
    `rm -rf ${directory}`,
    `mkdir -m 755 ${directory}`,
    `tmp=$(mktemp ${directory}/.opencode.XXXXXX)`,
    'cat > "$tmp"',
    `if [ -s "$tmp" ]; then chmod 644 "$tmp"; mv "$tmp" ${file}; else rm -f "$tmp"; fi`,
  ].join("\n");
}

/** Root shell that writes stdin as the `index`th instruction copy, readable by the server. */
export function writeProjectInstructionScript(kind: OpenCodeServerKind, index: number): string {
  const file = openCodeProjectInstructionPath(kind, index);
  const directory = path.posix.dirname(file);
  return [
    "set -eu",
    "umask 022",
    `mkdir -p -m 755 ${directory}`,
    `tmp=$(mktemp ${directory}/.instruction.XXXXXX)`,
    'cat > "$tmp"',
    'chmod 644 "$tmp"',
    `mv "$tmp" ${file}`,
  ].join("\n");
}

async function asRootWithStdin(containerId: string, script: string, stdin: string): Promise<void> {
  await runCommand(
    "docker",
    ["exec", "-i", ...CONTAINER_ROOT_USER_ARGS, containerId, "sh", "-c", script],
    { stdin, timeoutMs: 30_000 },
  );
}

/**
 * Read, filter and write the project configuration and its instruction
 * copies for the next start of `kind`. On an image whose launcher does not
 * pass it (`opencode2-launch` missing), the 1.x file is written and ignored.
 */
export async function stageProjectOpenCodeConfig(
  containerId: string,
  kind: OpenCodeServerKind,
): Promise<void> {
  const filtered = await readFilteredProjectOpenCodeConfig(containerId, kind);
  await asRootWithStdin(containerId, writeProjectOpenCodeConfigScript(kind), filtered.text ?? "");
  for (const [index, content] of filtered.instructions.entries()) {
    await asRootWithStdin(containerId, writeProjectInstructionScript(kind, index), content);
  }
}
