/**
 * Inspecting a package before anything is enabled
 * (docs/architecture/agent-capabilities-management.md, "Add once").
 *
 * Inspection reads a file tree (fetched, uploaded, authored or an existing
 * installation) and reports, without running anything from it:
 *
 * - its components: skills (`SKILL.md`), native plugin manifests
 *   (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`), commands,
 *   prompts, subagents, hooks and MCP server definitions;
 * - each component's risk, the programs it runs, the hosts it connects to and
 *   the hook triggers it fires on;
 * - operating-system and binary requirements, and the environment *keys* an
 *   MCP server needs (values are dropped; each machine supplies its own);
 * - any secret found in the text (by kind, never the value).
 *
 * Git sources are fetched with hooks off, symbolic links checked out as plain
 * files, no submodules and no install scripts; only the named subdirectory is
 * inspected.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  CAPABILITY_LIMITS,
  capabilityComponentId,
  capabilityPackageId,
  canonicalGitRepo,
  maxCapabilityRisk,
  type CapabilityComponent,
  type CapabilityRisk,
  type ComponentKind,
  type PackageSource,
} from "@orkestrator/protocol/capability-resources";
import { findCapabilitySecrets } from "@orkestrator/protocol/capability-resources-manifest";
import { nonInteractiveGitEnv, runCommand } from "../shell.js";
import { parseSkillFrontmatter } from "../agent-skills.js";
import {
  CapabilityError,
  looksLikeText,
  readPackageTree,
  treeDigest,
  type PackageFile,
} from "./security.js";

export interface InspectedPackage {
  source: PackageSource;
  packageId: string;
  displayName: string;
  description?: string;
  revision: string;
  artifactDigest: string;
  publisher?: string;
  components: CapabilityComponent[];
  files: PackageFile[];
  risk: CapabilityRisk;
  warnings: string[];
  secretsFound: string[];
}

const SCRIPT_EXTENSIONS = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i;
const MAX_NAME = CAPABILITY_LIMITS.maxNameChars;

function clamp(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? Array.from(trimmed).slice(0, max).join("") : undefined;
}

function textOf(file: PackageFile | undefined): string {
  return file && looksLikeText(file.content) ? file.content.toString("utf8") : "";
}

function parseJson(file: PackageFile | undefined): unknown {
  if (!file) return undefined;
  try {
    return JSON.parse(textOf(file));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Simple YAML-ish list values from frontmatter (`os: [linux, darwin]` or `os: linux`). */
function frontmatterList(head: string, key: string): string[] | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(head);
  if (!match) return undefined;
  const raw = match[1]!.trim().replace(/^\[|\]$/g, "");
  const values = raw
    .split(",")
    .map((value) => value.trim().replace(/^["']|["']$/g, ""))
    .filter((value) => /^[A-Za-z0-9._+-]{1,64}$/.test(value));
  return values.length > 0 ? values.slice(0, 16) : undefined;
}

function frontmatterHead(text: string): string {
  if (!text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  return end > 0 ? text.slice(3, end) : "";
}

interface McpDefinitionShape {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  headerKeys: string[];
}

/** `.mcp.json`-style `{ mcpServers: { name: {...} } }` or a bare map. Values of env/headers are dropped. */
export function parseMcpDefinitions(value: unknown, warnings: string[]): McpDefinitionShape[] {
  const map = isRecord(value) && isRecord(value.mcpServers) ? value.mcpServers : value;
  if (!isRecord(map)) return [];
  const result: McpDefinitionShape[] = [];
  for (const [name, raw] of Object.entries(map).slice(0, 50)) {
    if (!isRecord(raw) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) continue;
    const url = typeof raw.url === "string" ? raw.url : undefined;
    const command = typeof raw.command === "string" ? raw.command : undefined;
    const type =
      typeof raw.type === "string"
        ? raw.type
        : typeof raw.transport === "string"
          ? raw.transport
          : undefined;
    const transport = url ? (type === "sse" ? "sse" : "http") : "stdio";
    const envKeys = isRecord(raw.env) ? Object.keys(raw.env).slice(0, 32) : [];
    const headerKeys = isRecord(raw.headers) ? Object.keys(raw.headers).slice(0, 32) : [];
    const literal = [
      ...(isRecord(raw.env) ? Object.values(raw.env) : []),
      ...(isRecord(raw.headers) ? Object.values(raw.headers) : []),
    ].some(
      (entry) =>
        typeof entry === "string" &&
        entry.length > 0 &&
        !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(entry),
    );
    if (literal) {
      warnings.push(
        `${name}: literal environment or header values were removed; each machine supplies its own.`,
      );
    }
    result.push({
      name,
      transport,
      ...(command ? { command } : {}),
      ...(Array.isArray(raw.args)
        ? { args: raw.args.filter((arg): arg is string => typeof arg === "string").slice(0, 64) }
        : {}),
      ...(url ? { url } : {}),
      envKeys,
      headerKeys,
    });
  }
  return result;
}

function endpointHost(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Hook commands from a Claude `hooks.json` (`{ hooks: { Event: [{ hooks: [{ command }] }] } }`). */
function parseHooks(value: unknown): Array<{ trigger: string; commands: string[] }> {
  const root = isRecord(value) && isRecord(value.hooks) ? value.hooks : value;
  if (!isRecord(root)) return [];
  const result: Array<{ trigger: string; commands: string[] }> = [];
  for (const [trigger, groups] of Object.entries(root).slice(0, 32)) {
    if (!Array.isArray(groups)) continue;
    const commands: string[] = [];
    for (const group of groups) {
      const hooks = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : [group];
      for (const hook of hooks) {
        if (isRecord(hook) && typeof hook.command === "string") {
          commands.push(hook.command.slice(0, 300));
        }
      }
    }
    if (commands.length > 0)
      result.push({ trigger: trigger.slice(0, 64), commands: commands.slice(0, 16) });
  }
  return result;
}

interface DetectionContext {
  packageId: string;
  files: PackageFile[];
  byPath: Map<string, PackageFile>;
  warnings: string[];
}

function component(
  ctx: DetectionContext,
  kind: ComponentKind,
  key: string,
  fields: Omit<
    CapabilityComponent,
    "id" | "packageId" | "kind" | "dependencies" | "providerHints" | "requirements"
  > &
    Partial<Pick<CapabilityComponent, "dependencies" | "providerHints" | "requirements">>,
): CapabilityComponent {
  return {
    id: capabilityComponentId(ctx.packageId, kind, key),
    packageId: ctx.packageId,
    kind,
    dependencies: [],
    providerHints: [],
    requirements: {},
    ...fields,
  };
}

function detectSkills(
  ctx: DetectionContext,
  base: string,
  providerHints: AgentPlatform[],
): CapabilityComponent[] {
  const skills: CapabilityComponent[] = [];
  const prefix = base ? `${base}/` : "";
  // Shallowest first, so a skill's own nested references are never taken for skills.
  const candidates = ctx.files
    .filter(
      (file) =>
        file.path.startsWith(prefix) &&
        (file.path === `${prefix}SKILL.md` || file.path.endsWith("/SKILL.md")),
    )
    .sort(
      (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
    );
  for (const file of candidates) {
    const directory = file.path === "SKILL.md" ? "" : file.path.slice(0, -"/SKILL.md".length);
    // A skill inside another skill's directory is one of its references.
    if (
      skills.some((skill) => directory.startsWith(`${skill.pathOrKey}/`) || skill.pathOrKey === "")
    )
      continue;
    const text = textOf(file);
    const head = frontmatterHead(text);
    const meta = parseSkillFrontmatter(text.slice(0, 16_384));
    const dirName = directory.split("/").pop() || "skill";
    const name = clamp(meta.name, MAX_NAME) ?? dirName;
    const inside = ctx.files.filter(
      (other) => directory === "" || other.path.startsWith(`${directory}/`),
    );
    const scripts = inside.filter(
      (other) =>
        other.path !== file.path && (other.executable || SCRIPT_EXTENSIONS.test(other.path)),
    );
    const os = frontmatterList(head, "os");
    const binaries = frontmatterList(head, "requires") ?? frontmatterList(head, "binaries");
    skills.push(
      component(ctx, "skill", directory || name, {
        pathOrKey: directory,
        name,
        ...(meta.description
          ? { description: clamp(meta.description, CAPABILITY_LIMITS.maxDescriptionChars) }
          : {}),
        risk: scripts.length > 0 ? "executable" : "instructions",
        ...(scripts.length > 0
          ? { executes: scripts.slice(0, 16).map((script) => script.path) }
          : {}),
        providerHints,
        requirements: { ...(os ? { os } : {}), ...(binaries ? { binaries } : {}) },
      }),
    );
  }
  return skills;
}

function detectMarkdownDir(
  ctx: DetectionContext,
  directory: string,
  kind: ComponentKind,
  providerHints: AgentPlatform[],
): CapabilityComponent[] {
  const prefix = directory ? `${directory}/` : "";
  return ctx.files
    .filter(
      (file) =>
        file.path.startsWith(prefix) &&
        file.path.endsWith(".md") &&
        !file.path.slice(prefix.length).includes("/"),
    )
    .map((file) => {
      const text = textOf(file);
      const meta = parseSkillFrontmatter(text.slice(0, 16_384));
      const name = file.path.slice(prefix.length, -3);
      // Claude command bodies may run shell with a `!` prefix inside backticks.
      const runsShell = /!`[^`]+`/.test(text);
      return component(ctx, kind, name, {
        pathOrKey: file.path,
        name: clamp(meta.name, MAX_NAME) ?? name,
        ...(meta.description
          ? { description: clamp(meta.description, CAPABILITY_LIMITS.maxDescriptionChars) }
          : {}),
        risk: runsShell ? "executable" : "instructions",
        ...(runsShell ? { executes: ["shell (inline ! command)"] } : {}),
        providerHints,
      });
    });
}

function detectMcp(
  ctx: DetectionContext,
  filePath: string,
  providerHints: AgentPlatform[],
): CapabilityComponent[] {
  const definitions = parseMcpDefinitions(parseJson(ctx.byPath.get(filePath)), ctx.warnings);
  return definitions.map((definition) => {
    const host = definition.url ? endpointHost(definition.url) : undefined;
    return component(ctx, "mcp-server", definition.name, {
      pathOrKey: definition.name,
      name: definition.name,
      description: definition.url
        ? `${definition.transport.toUpperCase()} server at ${host ?? "a configured address"}`
        : `Runs ${definition.command ?? "a local program"}`,
      risk: definition.transport === "stdio" ? "executable" : "network",
      ...(definition.command ? { executes: [definition.command] } : {}),
      ...(host ? { endpoints: [host] } : {}),
      providerHints,
      requirements: {
        ...(definition.command ? { binaries: [path.posix.basename(definition.command)] } : {}),
        ...(definition.envKeys.length || definition.headerKeys.length
          ? { envRefs: [...definition.envKeys, ...definition.headerKeys] }
          : {}),
      },
    });
  });
}

function detectHooks(
  ctx: DetectionContext,
  filePath: string,
  providerHints: AgentPlatform[],
): CapabilityComponent[] {
  const hooks = parseHooks(parseJson(ctx.byPath.get(filePath)));
  return hooks.map((hook) =>
    component(ctx, "hook", hook.trigger, {
      pathOrKey: `${filePath}#${hook.trigger}`,
      name: `${hook.trigger} hook`,
      description: `Runs on ${hook.trigger}`,
      risk: "privileged",
      executes: hook.commands,
      triggers: [hook.trigger],
      providerHints,
    }),
  );
}

/**
 * The components of a file tree. Plugin manifests win: their bundled
 * skills, commands, agents, hooks and MCP servers depend on the plugin
 * component, so a provider without that plugin format can still be shown
 * exactly which parts it would get.
 */
export function detectComponents(
  packageId: string,
  files: PackageFile[],
  warnings: string[] = [],
): {
  components: CapabilityComponent[];
  displayName?: string;
  description?: string;
  publisher?: string;
} {
  const ctx: DetectionContext = {
    packageId,
    files,
    byPath: new Map(files.map((file) => [file.path, file])),
    warnings,
  };
  const components: CapabilityComponent[] = [];
  let displayName: string | undefined;
  let description: string | undefined;
  let publisher: string | undefined;

  const manifests: Array<{ path: string; provider: AgentPlatform }> = [
    { path: ".claude-plugin/plugin.json", provider: "claude" },
    { path: ".codex-plugin/plugin.json", provider: "codex" },
  ];
  for (const manifest of manifests) {
    const value = parseJson(ctx.byPath.get(manifest.path));
    if (!isRecord(value)) continue;
    const name =
      clamp(typeof value.name === "string" ? value.name : undefined, MAX_NAME) ?? "plugin";
    displayName ??= name;
    description ??= clamp(
      typeof value.description === "string" ? value.description : undefined,
      CAPABILITY_LIMITS.maxDescriptionChars,
    );
    const author = isRecord(value.author) ? value.author.name : value.author;
    publisher ??= clamp(typeof author === "string" ? author : undefined, MAX_NAME);
    components.push(
      component(ctx, "native-plugin", `${manifest.provider}:${name}`, {
        pathOrKey: manifest.path,
        name,
        ...(description ? { description } : {}),
        risk: "instructions",
        providerHints: [manifest.provider],
      }),
    );
  }
  const plugin = components.find((entry) => entry.kind === "native-plugin");

  components.push(...detectSkills(ctx, "", []));
  components.push(...detectMarkdownDir(ctx, "commands", "command", []));
  components.push(...detectMarkdownDir(ctx, "prompts", "prompt", []));
  components.push(...detectMarkdownDir(ctx, "agents", "subagent", []));
  for (const hookFile of ["hooks/hooks.json", "hooks.json"]) {
    if (ctx.byPath.has(hookFile)) components.push(...detectHooks(ctx, hookFile, ["claude"]));
  }
  for (const mcpFile of [".mcp.json", "mcp.json"]) {
    if (ctx.byPath.has(mcpFile)) components.push(...detectMcp(ctx, mcpFile, []));
  }
  // A single Markdown file with no other structure is one command.
  if (components.length === 0 && files.length === 1 && files[0]!.path.endsWith(".md")) {
    components.push(...detectMarkdownDir(ctx, "", "command", []));
  }

  if (plugin) {
    const pluginRiskSources: CapabilityRisk[] = [];
    for (const entry of components) {
      if (entry === plugin) continue;
      entry.dependencies = [plugin.id];
      pluginRiskSources.push(entry.risk);
    }
    plugin.risk = maxCapabilityRisk(pluginRiskSources);
    const executes = components.flatMap((entry) =>
      entry === plugin ? [] : (entry.executes ?? []),
    );
    if (executes.length > 0) plugin.executes = [...new Set(executes)].slice(0, 32);
  }
  if (components.length > CAPABILITY_LIMITS.maxComponentsPerPackage) {
    warnings.push(
      `Only the first ${CAPABILITY_LIMITS.maxComponentsPerPackage} components are managed.`,
    );
    components.length = CAPABILITY_LIMITS.maxComponentsPerPackage;
  }
  // Deduplicate ids (two skills with the same directory key cannot exist, but hooks may repeat).
  const seen = new Set<string>();
  const unique = components.filter((entry) =>
    seen.has(entry.id) ? false : (seen.add(entry.id), true),
  );
  return {
    components: unique,
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(publisher ? { publisher } : {}),
  };
}

/** Secrets in the package text, by kind. */
export function scanPackageSecrets(files: readonly PackageFile[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    if (!looksLikeText(file.content)) continue;
    for (const kind of findCapabilitySecrets(file.content.toString("utf8"))) found.add(kind);
    if (/(^|\/)\.env(\.|$)/.test(file.path)) found.add("environment file");
    if (/(^|\/)(id_rsa|id_ed25519|credentials\.json|\.credentials\.json)$/.test(file.path)) {
      found.add("credential file");
    }
  }
  return [...found];
}

/** Inspects an in-memory tree. Nothing in it is executed. */
export function inspectFiles(
  source: PackageSource,
  files: PackageFile[],
  options: { revision?: string; fallbackName?: string } = {},
): InspectedPackage {
  const packageId = capabilityPackageId(source);
  const warnings: string[] = [];
  const detected = detectComponents(packageId, files, warnings);
  if (detected.components.length === 0) {
    throw new CapabilityError(
      "invalid-request",
      "No skill, plugin, command, prompt, hook or MCP server was found in this source.",
    );
  }
  const artifactDigest = treeDigest(files);
  const firstSkill = detected.components.find((entry) => entry.kind === "skill");
  const displayName =
    detected.displayName ??
    (detected.components.length === 1 ? detected.components[0]!.name : undefined) ??
    firstSkill?.name ??
    options.fallbackName ??
    packageId;
  return {
    source,
    packageId,
    displayName: clamp(displayName, MAX_NAME) ?? packageId,
    ...(detected.description
      ? { description: detected.description }
      : detected.components.length === 1 && detected.components[0]!.description
        ? { description: detected.components[0]!.description }
        : {}),
    revision: options.revision ?? artifactDigest.slice("sha256:".length, "sha256:".length + 12),
    artifactDigest,
    ...(detected.publisher ? { publisher: detected.publisher } : {}),
    components: detected.components,
    files,
    risk: maxCapabilityRisk(detected.components.map((entry) => entry.risk)),
    warnings,
    secretsFound: scanPackageSecrets(files),
  };
}

// --- Git -------------------------------------------------------------------

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Refuses local paths, `file://`, `ext::` and option-looking repository strings. */
export function assertFetchableRepo(repo: string): void {
  const value = repo.trim();
  if (!value || value.startsWith("-")) {
    throw new CapabilityError("invalid-request", "Not a repository address.");
  }
  if (/^(?:https:\/\/|ssh:\/\/)[^\s]+$/.test(value)) return;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return;
  throw new CapabilityError(
    "invalid-request",
    "Only https:// and SSH repository addresses can be fetched.",
  );
}

export interface GitFetchOptions {
  timeoutMs?: number;
  workRoot?: string;
  run?: typeof runCommand;
}

/**
 * Fetches `subpath` of `repo` at `channel` (a branch, tag or commit; the
 * default branch when absent) into a temporary directory and returns it with
 * the commit it resolved to. The caller removes the directory.
 */
export async function fetchGitSource(
  source: Extract<PackageSource, { kind: "git" }>,
  options: GitFetchOptions = {},
): Promise<{ directory: string; root: string; commit: string }> {
  assertFetchableRepo(source.repo);
  if (source.channel !== undefined && !SAFE_REF.test(source.channel)) {
    throw new CapabilityError(
      "invalid-request",
      "The ref is not a safe branch, tag or commit name.",
    );
  }
  const run = options.run ?? runCommand;
  const root = await fs.mkdtemp(
    path.join(options.workRoot ?? os.tmpdir(), "orkestrator-capability-"),
  );
  const directory = path.join(root, "checkout");
  const env = {
    ...nonInteractiveGitEnv(undefined),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  const config = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.symlinks=false",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "submodule.recurse=false",
    "-c",
    "advice.detachedHead=false",
  ];
  const timeoutMs = options.timeoutMs ?? 120_000;
  try {
    await run("git", [...config, "init", "--quiet", directory], { env, timeoutMs });
    await run("git", [...config, "-C", directory, "remote", "add", "origin", source.repo.trim()], {
      env,
      timeoutMs,
    });
    await run(
      "git",
      [
        ...config,
        "-C",
        directory,
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "--no-tags",
        "--filter=blob:limit=8m",
        "origin",
        source.channel ?? "HEAD",
      ],
      { env, timeoutMs },
    );
    const subpath = source.subpath
      .split("/")
      .filter((segment) => segment && segment !== ".")
      .join("/");
    if (subpath) {
      await run(
        "git",
        [...config, "-C", directory, "sparse-checkout", "set", "--no-cone", `/${subpath}/`],
        { env, timeoutMs },
      );
    }
    await run("git", [...config, "-C", directory, "checkout", "--quiet", "FETCH_HEAD"], {
      env,
      timeoutMs,
    });
    const { stdout } = await run("git", ["-C", directory, "rev-parse", "HEAD"], { env, timeoutMs });
    const commit = stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      throw new CapabilityError(
        "source-unavailable",
        "The repository did not resolve to a commit.",
      );
    }
    return {
      directory: subpath ? path.join(directory, ...subpath.split("/")) : directory,
      root,
      commit,
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError(
      "source-unavailable",
      `Could not fetch ${canonicalGitRepo(source.repo)}${source.channel ? ` at ${source.channel}` : ""}. Check the address and that this machine can reach it.`,
    );
  }
}

/** The newest commit of `channel` (or the default branch) without fetching content. */
export async function remoteGitHead(
  source: Extract<PackageSource, { kind: "git" }>,
  run: typeof runCommand = runCommand,
): Promise<string | null> {
  assertFetchableRepo(source.repo);
  const ref = source.channel ?? "HEAD";
  if (!SAFE_REF.test(ref)) return null;
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  try {
    const { stdout } = await run(
      "git",
      [
        "-c",
        "protocol.file.allow=never",
        "-c",
        "protocol.ext.allow=never",
        "ls-remote",
        source.repo.trim(),
        ref,
      ],
      { env: nonInteractiveGitEnv(undefined), timeoutMs: 30_000 },
    );
    const line = stdout.split("\n").find((entry) => entry.trim().length > 0);
    const commit = line?.split(/\s+/)[0];
    return commit && /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/** Fetches and inspects a Git source; the temporary checkout is always removed. */
export async function inspectGitSource(
  source: Extract<PackageSource, { kind: "git" }>,
  options: GitFetchOptions = {},
): Promise<InspectedPackage> {
  const fetched = await fetchGitSource(source, options);
  try {
    const exists = await fs.stat(fetched.directory).catch(() => null);
    if (!exists?.isDirectory()) {
      throw new CapabilityError("not-found", "The subdirectory does not exist at that revision.");
    }
    const files = await readPackageTree(fetched.directory);
    const inspected = inspectFiles(source, files, {
      revision: fetched.commit,
      fallbackName:
        source.subpath.split("/").filter(Boolean).pop() ??
        canonicalGitRepo(source.repo).split("/").pop(),
    });
    return inspected;
  } finally {
    await fs.rm(fetched.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function newInspectionId(): string {
  return `insp_${randomBytes(9).toString("hex")}`;
}
