#!/usr/bin/env bun
/**
 * Regenerates the committed Codex app-server protocol artifacts from the exact
 * pinned Codex binary.
 *
 *   bun scripts/generate-codex-app-server-protocol.ts           # write
 *   bun scripts/generate-codex-app-server-protocol.ts --check   # verify, no writes
 *
 * OpenAI generates these bindings from the binary itself, so they are only
 * meaningful when paired with the version that produced them. The committed
 * output is therefore treated as a lockfile: `--check` regenerates into a temp
 * directory and fails on any difference.
 *
 * We commit the TypeScript bindings (the bridge imports them) but only a digest
 * of the JSON Schema bundle — nothing reads the schema at runtime, and 3.5MB of
 * generated JSON would dwarf the signal in a protocol diff. The digest still
 * fails the check if any schema shape moves.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const repoRoot = join(import.meta.dir, "..");
const versionConfigPath = join(repoRoot, "config", "codex-version.json");
export const EXPECTED_PROTOCOL_OUTPUT_DIR = "bridges/codex-bridge/src/app-server/generated";
export const ALLOW_MISSING_PROTOCOL_BINARY_ENV = "CODEX_PROTOCOL_CHECK_ALLOW_MISSING_BINARY";

export interface CodexVersionConfig {
  version: string;
  appServerProtocol: { generatedFrom: string; outputDir: string };
}

export interface ProtocolManifest {
  /** Codex binary version these artifacts were generated from. */
  codexVersion: string;
  /** Digest of the committed TypeScript binding tree. */
  typescriptDigest: string;
  /** Digest of the generated JSON Schema bundle (not committed in full). */
  schemaDigest: string;
  typescriptFileCount: number;
  schemaFileCount: number;
  /** Sorted `ClientRequest` method names the binary accepts. */
  clientRequestMethods: string[];
  /** Sorted `ServerNotification` method names the binary can emit. */
  serverNotificationMethods: string[];
  /** Sorted `ServerRequest` method names the binary can ask the client. */
  serverRequestMethods: string[];
}

async function readVersionConfig(): Promise<CodexVersionConfig> {
  return JSON.parse(await readFile(versionConfigPath, "utf8")) as CodexVersionConfig;
}

export interface ProtocolGeneratorArguments {
  check: boolean;
}

export function parseArguments(args: string[]): ProtocolGeneratorArguments {
  if (args.length === 0) return { check: false };
  if (args.length === 1 && args[0] === "--check") return { check: true };
  throw new Error("usage: bun scripts/generate-codex-app-server-protocol.ts [--check]");
}

export function validateVersionConfig(config: CodexVersionConfig): void {
  if (!/^\d+\.\d+\.\d+$/.test(config.version)) {
    throw new Error(
      `config/codex-version.json: version must be an exact semver, received ${JSON.stringify(config.version)}`,
    );
  }
  if (config.appServerProtocol.generatedFrom !== config.version) {
    throw new Error(
      `config/codex-version.json: appServerProtocol.generatedFrom (${config.appServerProtocol.generatedFrom}) must equal version (${config.version})`,
    );
  }
}

function isPathInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

/**
 * Resolves the configured output through its nearest existing ancestor and
 * refuses both lexical traversal and committed symlink escapes before `write()`
 * performs its recursive removal.
 */
export async function resolveProtocolOutputDir(
  configuredOutputDir: string,
  root: string = repoRoot,
): Promise<string> {
  if (configuredOutputDir !== EXPECTED_PROTOCOL_OUTPUT_DIR) {
    throw new Error(
      `config/codex-version.json: appServerProtocol.outputDir must be ${EXPECTED_PROTOCOL_OUTPUT_DIR}`,
    );
  }

  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(lexicalRoot, configuredOutputDir);
  if (!isPathInside(lexicalRoot, lexicalTarget)) {
    throw new Error("Refusing protocol output path outside the repository");
  }

  let existingAncestor = lexicalTarget;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error("Could not resolve a safe protocol output ancestor");
    }
    existingAncestor = parent;
  }

  const [realRoot, realAncestor] = await Promise.all([
    realpath(lexicalRoot),
    realpath(existingAncestor),
  ]);
  const realTarget = resolve(realAncestor, relative(existingAncestor, lexicalTarget));
  if (!isPathInside(realRoot, realTarget)) {
    throw new Error(
      "Refusing protocol output path whose existing ancestor resolves outside the repository",
    );
  }
  return realTarget;
}

/**
 * Prefers an explicit override, then the managed toolchain copy of the pinned
 * version, then whatever `codex` is on PATH. The version is verified either
 * way, so a wrong PATH binary fails loudly rather than generating stale types.
 */
export interface CandidateBinaryOptions {
  platform?: NodeJS.Platform;
  architecture?: string;
  homeDirectory?: string;
  xdgConfigHome?: string;
  codexPath?: string;
}

export function candidateBinaries(
  pinnedVersion: string,
  options: CandidateBinaryOptions = {},
): string[] {
  const candidates: string[] = [];
  const currentPlatform = options.platform ?? platform();
  const currentArchitecture = options.architecture ?? process.arch;
  const homeDirectory = options.homeDirectory ?? homedir();
  const arch = currentArchitecture === "arm64" ? "arm64" : "x64";
  const managedRoots =
    currentPlatform === "darwin"
      ? [join(homeDirectory, "Library", "Application Support", "orkestrator-v2", "toolchains")]
      : [
          join(
            options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"),
            "orkestrator-v2",
            "toolchains",
          ),
        ];
  for (const root of managedRoots) {
    candidates.push(
      join(
        root,
        "codex",
        pinnedVersion,
        `${currentPlatform === "darwin" ? "darwin" : "linux"}-${arch}`,
        "codex",
      ),
    );
  }

  const configuredPath = options.codexPath ?? process.env.CODEX_PATH;
  if (configuredPath?.trim()) candidates.push(configuredPath.trim());
  candidates.push("codex");
  return candidates;
}

async function reportedVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(binary, ["--version"], { timeout: 30_000 });
    return stdout.trim().split(/\s+/).at(-1) ?? null;
  } catch {
    return null;
  }
}

async function resolveCodexBinary(pinnedVersion: string): Promise<string> {
  /**
   * An explicit override is a hard assertion, not a hint.
   *
   * Falling through to auto-discovery here would be actively dangerous during an
   * upgrade: point `CODEX_PROTOCOL_BINARY` at the new binary but forget to bump
   * `config/codex-version.json`, and we would silently generate bindings from the
   * *old* managed binary — which then "match" the committed artifacts and pass
   * `--check`, hiding the mistake entirely.
   */
  const override = process.env.CODEX_PROTOCOL_BINARY?.trim();
  if (override) {
    if (override.includes(sep) && !existsSync(override)) {
      throw new Error(`CODEX_PROTOCOL_BINARY does not exist: ${override}`);
    }
    const reported = await reportedVersion(override);
    if (reported === null) {
      throw new Error(`CODEX_PROTOCOL_BINARY could not be executed: ${override}`);
    }
    if (reported !== pinnedVersion) {
      throw new Error(
        [
          `CODEX_PROTOCOL_BINARY reports ${reported}, but config/codex-version.json pins ${pinnedVersion}.`,
          "Bump the pinned version, or point at the matching binary — refusing to",
          "generate bindings from a different version than the one pinned.",
        ].join("\n"),
      );
    }
    return override;
  }

  const tried: string[] = [];
  for (const candidate of candidateBinaries(pinnedVersion)) {
    if (candidate.includes(sep) && !existsSync(candidate)) {
      tried.push(`${candidate} (not found)`);
      continue;
    }
    let stdout: string;
    try {
      ({ stdout } = await execFile(candidate, ["--version"], { timeout: 30_000 }));
    } catch (error) {
      tried.push(`${candidate} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const reported = stdout.trim().split(/\s+/).at(-1) ?? "";
    if (reported !== pinnedVersion) {
      tried.push(`${candidate} (reported ${reported || "nothing"})`);
      continue;
    }
    return candidate;
  }

  throw new Error(
    [
      `Could not find a Codex binary reporting version ${pinnedVersion}.`,
      "Set CODEX_PROTOCOL_BINARY to an explicit path, or install the pinned version.",
      "Tried:",
      ...tried.map((entry) => `  - ${entry}`),
    ].join("\n"),
  );
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

/**
 * ts-rs emits extensionless relative specifiers (`from "./ClientInfo"`), which
 * do not resolve under the bridge's NodeNext module resolution. Rewriting them
 * to explicit `.js` is part of generation, so `--check` compares normalized
 * output against normalized output and stays an exact contract test.
 */
function normalizeGeneratedSource(source: string): string {
  return source.replace(
    /(\bfrom\s+")(\.\.?\/[^"]*)(")/g,
    (_match, prefix: string, specifier: string, suffix: string) => {
      if (/\.(js|json)$/.test(specifier)) return `${prefix}${specifier}${suffix}`;
      // `export * as v2 from "./v2"` targets a directory index.
      const target = /\/(v2|serde_json)$/.test(specifier)
        ? `${specifier}/index.js`
        : `${specifier}.js`;
      return `${prefix}${target}${suffix}`;
    },
  );
}

/**
 * `codex app-server generate-json-schema` serializes its `definitions` map from
 * a Rust HashMap, so key order changes between runs of the *same* binary. Digest
 * a canonical form (recursively sorted object keys, plus sorted `required`,
 * which JSON Schema treats as a set) so the check catches real shape changes
 * instead of flapping. Other arrays keep their order — `enum` ordering is
 * meaningful.
 */
function canonicalizeJsonValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((entry) => canonicalizeJsonValue(entry));
    if (key === "required" && items.every((entry) => typeof entry === "string")) {
      return (items as string[]).sort();
    }
    return items;
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const objectKey of Object.keys(source).sort()) {
      sorted[objectKey] = canonicalizeJsonValue(source[objectKey], objectKey);
    }
    return sorted;
  }
  return value;
}

function canonicalizeJson(content: string): string {
  try {
    return JSON.stringify(canonicalizeJsonValue(JSON.parse(content)));
  } catch {
    return content;
  }
}

function digestFiles(files: Array<{ path: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(createHash("sha256").update(file.content).digest("hex"));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function extractMethods(source: string): string[] {
  const methods = new Set<string>();
  for (const match of source.matchAll(/"method"\s*:\s*"([^"]+)"/g)) {
    methods.add(match[1]!);
  }
  return [...methods].sort();
}

interface GeneratedProtocol {
  typescript: Array<{ path: string; content: string }>;
  manifest: ProtocolManifest;
}

async function generate(codexBinary: string, pinnedVersion: string): Promise<GeneratedProtocol> {
  const workDir = await mkdtemp(join(tmpdir(), "orkestrator-codex-protocol-"));
  try {
    const tsDir = join(workDir, "ts");
    const schemaDir = join(workDir, "schema");
    await mkdir(tsDir, { recursive: true });
    await mkdir(schemaDir, { recursive: true });

    await execFile(codexBinary, ["app-server", "generate-ts", "--out", tsDir], {
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    await execFile(codexBinary, ["app-server", "generate-json-schema", "--out", schemaDir], {
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });

    const typescript: Array<{ path: string; content: string }> = [];
    for (const absolute of await walkFiles(tsDir)) {
      typescript.push({
        path: relative(tsDir, absolute).split(sep).join("/"),
        content: normalizeGeneratedSource(await readFile(absolute, "utf8")),
      });
    }
    if (typescript.length === 0) {
      throw new Error("codex app-server generate-ts produced no files");
    }

    const schemaFiles: Array<{ path: string; content: string }> = [];
    for (const absolute of await walkFiles(schemaDir)) {
      schemaFiles.push({
        path: relative(schemaDir, absolute).split(sep).join("/"),
        content: canonicalizeJson(await readFile(absolute, "utf8")),
      });
    }
    if (schemaFiles.length === 0) {
      throw new Error("codex app-server generate-json-schema produced no files");
    }

    const byPath = new Map(typescript.map((file) => [file.path, file.content]));
    const requireFile = (path: string): string => {
      const content = byPath.get(path);
      if (!content) throw new Error(`Generated bindings are missing ${path}`);
      return content;
    };

    return {
      typescript,
      manifest: {
        codexVersion: pinnedVersion,
        typescriptDigest: digestFiles(typescript),
        schemaDigest: digestFiles(schemaFiles),
        typescriptFileCount: typescript.length,
        schemaFileCount: schemaFiles.length,
        clientRequestMethods: extractMethods(requireFile("ClientRequest.ts")),
        serverNotificationMethods: extractMethods(requireFile("ServerNotification.ts")),
        serverRequestMethods: extractMethods(requireFile("ServerRequest.ts")),
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function readCommitted(outputDir: string): Promise<GeneratedProtocol | null> {
  const manifestPath = join(outputDir, "protocol-manifest.json");
  if (!existsSync(manifestPath)) return null;

  const tsRoot = join(outputDir, "typescript");
  const typescript: Array<{ path: string; content: string }> = [];
  for (const absolute of await walkFiles(tsRoot)) {
    typescript.push({
      path: relative(tsRoot, absolute).split(sep).join("/"),
      content: await readFile(absolute, "utf8"),
    });
  }

  return {
    typescript,
    manifest: JSON.parse(await readFile(manifestPath, "utf8")) as ProtocolManifest,
  };
}

function describeDifferences(expected: GeneratedProtocol, actual: GeneratedProtocol): string[] {
  const problems: string[] = [];
  for (const key of ["codexVersion", "typescriptFileCount", "schemaFileCount"] as const) {
    if (expected.manifest[key] !== actual.manifest[key]) {
      problems.push(
        `${key} differs (committed ${actual.manifest[key]}, generated ${expected.manifest[key]})`,
      );
    }
  }
  if (expected.manifest.typescriptDigest !== actual.manifest.typescriptDigest) {
    problems.push(
      `TypeScript binding digest differs (committed ${actual.manifest.typescriptDigest}, generated ${expected.manifest.typescriptDigest})`,
    );
  }
  if (expected.manifest.schemaDigest !== actual.manifest.schemaDigest) {
    problems.push(
      `JSON Schema digest differs (committed ${actual.manifest.schemaDigest}, generated ${expected.manifest.schemaDigest})`,
    );
  }

  const expectedPaths = new Map(expected.typescript.map((file) => [file.path, file.content]));
  const actualPaths = new Map(actual.typescript.map((file) => [file.path, file.content]));
  for (const [path, content] of expectedPaths) {
    const committed = actualPaths.get(path);
    if (committed === undefined) problems.push(`Missing committed binding: typescript/${path}`);
    else if (committed !== content) problems.push(`Committed binding is stale: typescript/${path}`);
  }
  for (const path of actualPaths.keys()) {
    if (!expectedPaths.has(path))
      problems.push(`Committed binding no longer generated: typescript/${path}`);
  }

  for (const key of [
    "clientRequestMethods",
    "serverNotificationMethods",
    "serverRequestMethods",
  ] as const) {
    const generated = new Set(expected.manifest[key]);
    const committed = new Set(actual.manifest[key]);
    for (const method of generated) {
      if (!committed.has(method)) problems.push(`${key}: new method not in manifest: ${method}`);
    }
    for (const method of committed) {
      if (!generated.has(method))
        problems.push(`${key}: manifest method no longer exists: ${method}`);
    }
  }

  return problems;
}

function describeCommittedSelfConsistency(
  committed: GeneratedProtocol,
  pinnedVersion: string,
): string[] {
  const problems: string[] = [];
  if (committed.manifest.codexVersion !== pinnedVersion) {
    problems.push(
      `codexVersion differs from config (manifest ${committed.manifest.codexVersion}, config ${pinnedVersion})`,
    );
  }

  const actualDigest = digestFiles(committed.typescript);
  if (committed.manifest.typescriptDigest !== actualDigest) {
    problems.push(
      `TypeScript binding digest does not describe the committed tree (manifest ${committed.manifest.typescriptDigest}, actual ${actualDigest})`,
    );
  }
  if (committed.manifest.typescriptFileCount !== committed.typescript.length) {
    problems.push(
      `typescriptFileCount differs from the committed tree (manifest ${committed.manifest.typescriptFileCount}, actual ${committed.typescript.length})`,
    );
  }

  const byPath = new Map(committed.typescript.map((file) => [file.path, file.content]));
  for (const [manifestKey, bindingPath] of [
    ["clientRequestMethods", "ClientRequest.ts"],
    ["serverNotificationMethods", "ServerNotification.ts"],
    ["serverRequestMethods", "ServerRequest.ts"],
  ] as const) {
    const source = byPath.get(bindingPath);
    if (source === undefined) {
      problems.push(`Missing committed binding: typescript/${bindingPath}`);
      continue;
    }
    const actualMethods = extractMethods(source);
    const committedMethods = [...committed.manifest[manifestKey]].sort();
    if (JSON.stringify(actualMethods) !== JSON.stringify(committedMethods)) {
      problems.push(`${manifestKey} does not describe typescript/${bindingPath}`);
    }
  }
  return problems;
}

async function write(outputDir: string, generated: GeneratedProtocol): Promise<void> {
  const tsRoot = join(outputDir, "typescript");
  const manifestPath = join(outputDir, "protocol-manifest.json");
  const readmePath = join(outputDir, "README.md");
  // Remove known generated leaves before writing. `writeFile` follows a symlink,
  // so overwriting a committed symlink here could otherwise escape the validated
  // output directory even though the directory itself is safely contained.
  await Promise.all([
    rm(tsRoot, { recursive: true, force: true }),
    rm(manifestPath, { force: true }),
    rm(readmePath, { force: true }),
  ]);
  for (const file of generated.typescript) {
    const absolute = join(tsRoot, ...file.path.split("/"));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, "utf8");
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(generated.manifest, null, 2)}\n`, "utf8");
  await writeFile(
    readmePath,
    [
      "# Generated Codex app-server protocol",
      "",
      "**Do not edit by hand.** Everything here is produced by",
      "`bun scripts/generate-codex-app-server-protocol.ts` from the Codex binary",
      `pinned in \`config/codex-version.json\` (currently ${generated.manifest.codexVersion}).`,
      "",
      "These bindings are only valid for the version that generated them, so they",
      "are treated as a lockfile. The full test pipeline runs the generator with",
      "`--check`: it always verifies the committed TypeScript digest, file count",
      "and method surface, and regenerates from the pinned binary when available.",
      "",
      "That fallback proves only *internal* consistency — the manifest is recomputed",
      "from the same committed files, so bindings edited together with their manifest",
      "would still pass. `bun run verify:codex:protocol` refuses the fallback and",
      "requires the pinned binary; run it on a machine with the Codex toolchain",
      "before releasing, and after any change under this directory.",
      "",
      "`protocol-manifest.json` additionally records a digest of the JSON Schema",
      "bundle. The schema is not committed (nothing reads it at runtime) but the",
      "digest still fails the check if any schema shape moves.",
      "",
      "Relative import specifiers are rewritten to explicit `.js` during",
      "generation so the tree resolves under the bridge's NodeNext config.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function main(): Promise<void> {
  const { check } = parseArguments(process.argv.slice(2));
  const config = await readVersionConfig();
  validateVersionConfig(config);
  const outputDir = await resolveProtocolOutputDir(config.appServerProtocol.outputDir);

  let committed: GeneratedProtocol | null = null;
  if (check) {
    committed = await readCommitted(outputDir);
    if (!committed) {
      throw new Error(
        `No committed protocol artifacts at ${config.appServerProtocol.outputDir}. Run the generator without --check.`,
      );
    }
    const selfConsistencyProblems = describeCommittedSelfConsistency(committed, config.version);
    if (selfConsistencyProblems.length > 0) {
      throw new Error(
        [
          "Committed protocol artifacts are internally inconsistent:",
          ...selfConsistencyProblems.map((problem) => `  - ${problem}`),
        ].join("\n"),
      );
    }
  }

  let codexBinary: string;
  try {
    codexBinary = await resolveCodexBinary(config.version);
  } catch (error) {
    const allowMissing =
      check &&
      !process.env.CODEX_PROTOCOL_BINARY?.trim() &&
      process.env[ALLOW_MISSING_PROTOCOL_BINARY_ENV] === "1";
    if (!allowMissing) throw error;
    /**
     * Say plainly what was *not* checked.
     *
     * Self-consistency only proves the manifest describes the committed tree —
     * it is recomputed from those same files, so bindings edited together with
     * their manifest would pass. Only a regeneration from the pinned binary
     * proves the tree matches the protocol, and `verify:codex:protocol` is the
     * gate that requires it.
     */
    console.warn(
      "[codex-protocol] WARNING: the pinned binary is unavailable, so the " +
        "committed bindings were NOT verified against the protocol. Only " +
        "internal self-consistency was checked. Run `bun run verify:codex:protocol` " +
        "on a machine with the pinned Codex toolchain before releasing.",
    );
    return;
  }
  console.log(`[codex-protocol] Using ${codexBinary} (codex ${config.version})`);
  const generated = await generate(codexBinary, config.version);

  if (!check) {
    await write(outputDir, generated);
    console.log(
      `[codex-protocol] Wrote ${generated.typescript.length} bindings to ${config.appServerProtocol.outputDir}`,
    );
    console.log(`[codex-protocol] typescript ${generated.manifest.typescriptDigest}`);
    console.log(`[codex-protocol] schema     ${generated.manifest.schemaDigest}`);
    return;
  }

  const problems = describeDifferences(generated, committed!);
  if (problems.length > 0) {
    console.error("[codex-protocol] Committed artifacts do not match the pinned binary:");
    for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
    if (problems.length > 40) console.error(`  ... and ${problems.length - 40} more`);
    console.error("");
    console.error("Run: bun scripts/generate-codex-app-server-protocol.ts");
    process.exit(1);
  }

  console.log("[codex-protocol] Committed artifacts match the pinned binary.");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[codex-protocol] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export const __testing = {
  candidateBinaries,
  normalizeGeneratedSource,
  canonicalizeJson,
  digestFiles,
  extractMethods,
  describeDifferences,
  describeCommittedSelfConsistency,
  generate,
  write,
};
