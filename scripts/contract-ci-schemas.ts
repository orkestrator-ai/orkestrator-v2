#!/usr/bin/env bun
/**
 * Argument schemas for the contract CI job (plan item 1008,
 * docs/reports/unified-federation.md §11.3 step 3), so a later tree can
 * compare against what an older release accepted.
 *
 *   bun scripts/contract-ci-schemas.ts   # write the store (run by `mise run contract:manifest`)
 *
 * The manifest and the release snapshots keep only each defined command's
 * `argsDigest` (the SHA-256 of `canonicalJsonSchema(def.args)`). The schema
 * itself is kept here, content addressed:
 * `packages/protocol/contracts/schemas/<hex16>.json` holds
 * `{ schemaVersion, digest, document }`, where `document` is the canonical
 * JSON Schema document (`canonicalJson(Schema.toJsonSchemaDocument(args))`)
 * and `digest` its full `sha256:` digest. The writer adds the schema of every
 * defined command in the current registry and removes only files no
 * registry command, manifest entry or release snapshot references, so a
 * release's schemas stay once it is snapshotted.
 *
 * Stage 2 of the CI job reads the store:
 *
 * - {@link newRequiredFields}: a field required now that an older release's
 *   schema did not require (pure JSON, no registry);
 * - {@link runFixturesInChild}: argument fixtures generated from the older
 *   schema with `effect/Arbitrary` (`SchemaRepresentation.fromJsonSchemaDocument`
 *   then `Arbitrary.schema`), each decoded by the current backend's parser:
 *   `decodeCommandArgs` with the definition the real registry registered
 *   (`registry.contracts`), which is the decode `register(def, handler)` runs
 *   before any handler. No handler runs.
 *
 * The registry is loaded in a sandboxed child, as the manifest generator does
 * (`scripts/generate-contract-manifest.ts`): a constructed environment
 * (temporary HOME, XDG and TMPDIR, an empty PATH, `NODE_ENV=production`,
 * nothing inherited), cwd in the temporary directory, `--no-env-file`, a
 * refusing `fetch`, a 60 s timeout and a 1 MiB output cap.
 *
 * The repository root does not depend on `effect`; the Effect modules are
 * resolved from `packages/protocol` at run time.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@orkestrator/protocol/contract/json-schema";
import { formatSnapshotJson } from "./contract-snapshots.ts";

const repoRoot = join(import.meta.dir, "..");
const scriptPath = join(import.meta.dir, "contract-ci-schemas.ts");
const protocolDirectory = join(repoRoot, "packages/protocol");

/** The store, relative to the contracts directory. */
export const SCHEMA_STORE_DIRECTORY = "schemas";
export const SCHEMA_STORE_SCHEMA_VERSION = 1;
const DIGEST_FILE_CHARS = 16;
const CHILD_FLAG = "--child";
const CHILD_TIMEOUT_MS = 60_000;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
/** Fixtures per (command, schema); seeded, so a run is reproducible. */
export const FIXTURES_PER_SCHEMA = 25;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

/** A canonical JSON Schema document (`Schema.toJsonSchemaDocument`, keys sorted). */
export interface JsonSchemaDocument {
  readonly dialect?: string;
  readonly schema: Json;
  readonly definitions?: { readonly [name: string]: Json };
}

/** `schemas/<hex16>.json`. */
export interface StoredSchema {
  readonly schemaVersion: typeof SCHEMA_STORE_SCHEMA_VERSION;
  readonly digest: string;
  readonly document: JsonSchemaDocument;
}

function fail(message: string): never {
  throw new Error(message);
}

/** `sha256:<hex>` of the canonical text of `document`, as the manifest digests it. */
export function documentDigest(document: unknown): string {
  const text = JSON.stringify(canonicalJson(document));
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** The store file for a digest, relative to the contracts directory. */
export function schemaStoreFile(digest: string): string {
  const hex = /^sha256:([0-9a-f]{64})$/u.exec(digest)?.[1] ?? fail(`bad digest ${digest}`);
  return `${SCHEMA_STORE_DIRECTORY}/${hex.slice(0, DIGEST_FILE_CHARS)}.json`;
}

/**
 * The stored document for `digest`, `null` when there is none. Throws when
 * the file is not a stored schema or does not hash to `digest`.
 */
export function readStoredSchema(
  contractsDirectory: string,
  digest: string,
): JsonSchemaDocument | null {
  const file = join(contractsDirectory, schemaStoreFile(digest));
  if (!existsSync(file)) return null;
  const stored = JSON.parse(readFileSync(file, "utf8")) as StoredSchema;
  if (stored.schemaVersion !== SCHEMA_STORE_SCHEMA_VERSION) {
    fail(`${schemaStoreFile(digest)}: unknown schemaVersion ${String(stored.schemaVersion)}.`);
  }
  if (stored.digest !== digest || documentDigest(stored.document) !== digest) {
    fail(`${schemaStoreFile(digest)} does not hold the schema with digest ${digest}.`);
  }
  return stored.document;
}

/**
 * The store's problems for the digests the CI job needs (digest → the
 * commands and releases that use it): a missing schema or one that does not
 * hash to its digest.
 */
export function checkSchemaStore(
  contractsDirectory: string,
  needed: ReadonlyMap<string, readonly string[]>,
): string[] {
  const problems: string[] = [];
  for (const [digest, users] of needed) {
    try {
      if (readStoredSchema(contractsDirectory, digest) === null) {
        problems.push(
          `No stored argument schema for ${digest} (${users.join(", ")}): run \`mise run contract:manifest\` and commit packages/protocol/contracts/${SCHEMA_STORE_DIRECTORY}/.`,
        );
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return problems;
}

/** The store file's text for a document. */
export function storedSchemaText(document: JsonSchemaDocument): string {
  const canonical = canonicalJson(document) as JsonSchemaDocument;
  const stored: StoredSchema = {
    schemaVersion: SCHEMA_STORE_SCHEMA_VERSION,
    digest: documentDigest(canonical),
    document: canonical,
  };
  return formatSnapshotJson(stored);
}

/**
 * Writes every document not yet stored and removes store files that no
 * digest in `keep` (and no written document) names. Returns the files
 * written and removed, relative to the contracts directory.
 */
export function writeSchemaStore(
  contractsDirectory: string,
  documents: Iterable<JsonSchemaDocument>,
  keep: Iterable<string>,
): { readonly written: readonly string[]; readonly removed: readonly string[] } {
  const directory = join(contractsDirectory, SCHEMA_STORE_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const kept = new Set<string>();
  for (const digest of keep) kept.add(schemaStoreFile(digest));
  const written: string[] = [];
  for (const document of documents) {
    const text = storedSchemaText(document);
    const file = schemaStoreFile(documentDigest(document));
    kept.add(file);
    const target = join(contractsDirectory, file);
    if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
    writeFileSync(target, text);
    written.push(file);
  }
  const removed: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    const file = `${SCHEMA_STORE_DIRECTORY}/${name}`;
    if (!name.endsWith(".json") || kept.has(file)) continue;
    rmSync(join(directory, name));
    removed.push(file);
  }
  return { written, removed };
}

// ---------------------------------------------------------------------------
// New required fields (stage 2, pure JSON)

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveReference(document: JsonSchemaDocument, node: Json | undefined): Json | undefined {
  let current = node;
  for (let hops = 0; hops < 16 && isObject(current) && typeof current.$ref === "string"; hops++) {
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/u.exec(current.$ref);
    if (!match) return current;
    const name = match[1]!.replaceAll("~1", "/").replaceAll("~0", "~");
    current = document.definitions?.[name];
  }
  return current;
}

function requiredOf(node: JsonObject): readonly string[] {
  const required = node.required;
  return Array.isArray(required)
    ? required.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * The fields `after` requires that `before` did not, as dotted paths (`[]`
 * for array items): an older client never sends them. Fields are compared
 * where both schemas have the containing object, through `properties`,
 * `items` and local `$ref`s; union branches (`anyOf`, `oneOf`) are not
 * compared.
 */
export function newRequiredFields(before: JsonSchemaDocument, after: JsonSchemaDocument): string[] {
  const found: string[] = [];
  const walk = (old: Json | undefined, next: Json | undefined, path: string, depth: number) => {
    if (depth > 32) return;
    const a = resolveReference(before, old);
    const b = resolveReference(after, next);
    if (!isObject(a) || !isObject(b)) return;
    const was = new Set(requiredOf(a));
    for (const key of requiredOf(b)) {
      if (!was.has(key)) found.push(path === "" ? key : `${path}.${key}`);
    }
    const oldProperties = isObject(a.properties) ? a.properties : {};
    const newProperties = isObject(b.properties) ? b.properties : {};
    for (const key of Object.keys(newProperties)) {
      if (Object.hasOwn(oldProperties, key)) {
        walk(
          oldProperties[key],
          newProperties[key],
          path === "" ? key : `${path}.${key}`,
          depth + 1,
        );
      }
    }
    if (a.items !== undefined && b.items !== undefined) {
      walk(a.items, b.items, `${path}[]`, depth + 1);
    }
  };
  walk(before.schema, after.schema, "", 0);
  return found.sort();
}

// ---------------------------------------------------------------------------
// Argument fixtures (stage 2, needs effect)

/** One old schema to generate fixtures from, for a command the current registry defines. */
export interface FixtureCase {
  readonly command: string;
  readonly digest: string;
  /** The releases whose snapshot has this command with this schema. */
  readonly releases: readonly string[];
  readonly document: JsonSchemaDocument;
}

export interface FixtureFailure {
  readonly command: string;
  readonly digest: string;
  readonly releases: readonly string[];
  /** The first fixture the current parser refused, JSON. */
  readonly fixture: string;
  readonly message: string;
}

export interface FixtureReport {
  readonly checked: number;
  /**
   * Fixtures refused only inside a value the older schema left unconstrained
   * (`{}`): see {@link isUnconstrainedRefusal}. Counted, not failed.
   */
  readonly unconstrained: number;
  readonly failures: readonly FixtureFailure[];
}

/** What the current parser said about one fixture. */
export interface FixtureRefusal {
  readonly message: string;
  /** Where each issue is, as keys from the arguments object. */
  readonly paths: readonly (readonly (string | number)[])[];
}

/**
 * Property paths, from the arguments object, whose schema in `document` is
 * unconstrained (`{}` or `true`). Follows nested `properties` only.
 */
export function unconstrainedPaths(document: JsonSchemaDocument): string[][] {
  const found: string[][] = [];
  const walk = (schema: Json, path: string[], depth: number): void => {
    if (depth > 32 || schema === null || typeof schema !== "object" || Array.isArray(schema))
      return;
    const properties = (schema as JsonObject).properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return;
    for (const [key, child] of Object.entries(properties as JsonObject)) {
      const at = [...path, key];
      if (
        child === true ||
        (child !== null &&
          typeof child === "object" &&
          !Array.isArray(child) &&
          Object.keys(child).length === 0)
      )
        found.push(at);
      else walk(child, at, depth + 1);
    }
  };
  walk(document.schema, [], 0);
  return found;
}

/**
 * A refusal is no evidence against an older release when every issue lies in
 * a value its schema left unconstrained. Such a value is checked by a
 * validator the JSON Schema cannot express (a web annotation's `capture`), so
 * a generated fixture is arbitrary JSON the older release would have refused
 * too.
 */
export function isUnconstrainedRefusal(
  refusal: FixtureRefusal,
  unconstrained: readonly (readonly string[])[],
): boolean {
  return (
    unconstrained.length > 0 &&
    refusal.paths.length > 0 &&
    refusal.paths.every((path) =>
      unconstrained.some(
        (prefix) =>
          prefix.length <= path.length && prefix.every((key, index) => String(path[index]) === key),
      ),
    )
  );
}

/** What fixture generation needs from `effect`, resolved from `packages/protocol`. */
export interface FixtureGenerator {
  /** Seeded samples of the values `document` accepts. */
  sample(document: JsonSchemaDocument, count: number, seed: string): readonly unknown[];
}

interface EffectFixtureModules {
  readonly Arbitrary: {
    schema(schema: unknown): unknown;
    sampleEffect(arbitrary: unknown, options: { count: number; seed: string }): unknown;
  };
  readonly Effect: { runSync(effect: unknown): readonly unknown[] };
  readonly SchemaRepresentation: {
    fromJsonSchemaDocument(
      document: unknown,
      options: { patterns: "apply"; onEnter: (schema: JsonObject) => JsonObject },
    ): unknown;
  };
}

/** The five JSON types other than `null`, as an importable union. */
const NON_NULL_SCHEMA: JsonObject = Object.freeze({
  anyOf: ["object", "array", "string", "number", "boolean"].map((type) => ({ type })),
});

/**
 * Rewrites what Effect's importer refuses into an equivalent it accepts.
 * `Schema.Struct({})`, the arguments of every command that takes none, exports
 * as `{ not: { type: "null" } }` (any value but `null`), and the importer has
 * no `not`. Only that exact node is rewritten; any other `not` still fails.
 */
export function importableSchemaNode(schema: JsonObject): JsonObject {
  const not = schema.not;
  if (
    not === null ||
    typeof not !== "object" ||
    Array.isArray(not) ||
    Object.keys(not).length !== 1 ||
    (not as JsonObject).type !== "null"
  )
    return schema;
  const { not: _not, ...rest } = schema;
  return Object.keys(rest).length === 0 ? NON_NULL_SCHEMA : { allOf: [rest, NON_NULL_SCHEMA] };
}

/**
 * The `effect/Arbitrary` generator. The stored documents are committed, so
 * their patterns are trusted (`patterns: "apply"`).
 */
export async function loadFixtureGenerator(): Promise<FixtureGenerator> {
  const load = (specifier: string) => import(Bun.resolveSync(specifier, protocolDirectory));
  const [Arbitrary, Effect, SchemaRepresentation] = await Promise.all([
    load("effect/Arbitrary"),
    load("effect/Effect"),
    load("effect/SchemaRepresentation"),
  ]);
  const modules = { Arbitrary, Effect, SchemaRepresentation } as unknown as EffectFixtureModules;
  return {
    sample(document, count, seed) {
      const schema = modules.SchemaRepresentation.fromJsonSchemaDocument(document, {
        patterns: "apply",
        onEnter: importableSchemaNode,
      });
      return modules.Effect.runSync(
        modules.Arbitrary.sampleEffect(modules.Arbitrary.schema(schema), { count, seed }),
      );
    },
  };
}

/**
 * Generates fixtures from each case's old schema and decodes each with
 * `decode` (the current parser). A fixture is sent as JSON, as on the wire.
 * Stops at a case's first refusal.
 */
export function runArgumentFixtures(
  cases: readonly FixtureCase[],
  decode: (command: string, args: unknown) => string | FixtureRefusal | null,
  generator: FixtureGenerator,
  count = FIXTURES_PER_SCHEMA,
): FixtureReport {
  let checked = 0;
  let unconstrained = 0;
  const failures: FixtureFailure[] = [];
  for (const entry of cases) {
    const opaque = unconstrainedPaths(entry.document);
    const { command, digest, releases } = entry;
    let samples: readonly unknown[];
    try {
      samples = generator.sample(entry.document, count, `${command}@${digest}`);
    } catch (error) {
      failures.push({
        command,
        digest,
        releases,
        fixture: "",
        message: `fixtures could not be generated: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const sample of samples) {
      const fixture = JSON.stringify(sample);
      checked += 1;
      const refusal = decode(command, JSON.parse(fixture));
      if (refusal === null) continue;
      if (typeof refusal !== "string" && isUnconstrainedRefusal(refusal, opaque)) {
        unconstrained += 1;
        continue;
      }
      const message = typeof refusal === "string" ? refusal : refusal.message;
      failures.push({ command, digest, releases, fixture, message });
      break;
    }
  }
  return { checked, unconstrained, failures };
}

// ---------------------------------------------------------------------------
// The registry child

type ChildRequest =
  | { readonly mode: "schemas" }
  | { readonly mode: "fixtures"; readonly cases: readonly FixtureCase[]; readonly count?: number };

/** The current registry's defined commands: name → canonical argument schema document. */
export type RegistrySchemas = { readonly [command: string]: JsonSchemaDocument };

async function runChild<T>(request: ChildRequest): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "orkestrator-contract-ci-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "bin");
    const tmp = join(root, "tmp");
    await Promise.all([home, bin, tmp].map((dir) => mkdir(dir, { recursive: true })));
    const input = join(root, "request.json");
    const output = join(root, "response.json");
    await writeFile(input, JSON.stringify(request));
    // Built from nothing rather than filtered from process.env: a production
    // backend's variables on this host must not reach the registry modules.
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      TMPDIR: tmp,
      PATH: bin,
      NODE_ENV: "production",
      LANG: "C.UTF-8",
    };
    const child = spawn(
      process.execPath,
      ["--no-env-file", scriptPath, CHILD_FLAG, input, output],
      {
        // Not the repository: bun reads bunfig.toml and .env from its cwd.
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    const collect = (chunk: Buffer) => {
      if (bytes >= MAX_CHILD_OUTPUT_BYTES) return;
      bytes += chunk.length;
      chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`The registry child did not finish within ${CHILD_TIMEOUT_MS}ms.`));
      }, CHILD_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (code !== 0 || !existsSync(output)) {
      throw new Error(text.length > 0 ? text : `The registry child exited with status ${code}.`);
    }
    return JSON.parse(await readFile(output, "utf8")) as T;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The argument schema of every command the current registry defines. */
export function registrySchemasInChild(): Promise<RegistrySchemas> {
  return runChild<RegistrySchemas>({ mode: "schemas" });
}

/** Decodes fixtures from each case's old schema with the current registry's parser. */
export function runFixturesInChild(
  cases: readonly FixtureCase[],
  count?: number,
): Promise<FixtureReport> {
  if (cases.length === 0) return Promise.resolve({ checked: 0, unconstrained: 0, failures: [] });
  return runChild<FixtureReport>({
    mode: "fixtures",
    cases,
    ...(count === undefined ? {} : { count }),
  });
}

async function childMain(input: string, output: string): Promise<void> {
  // No registry module may reach the network while loading.
  globalThis.fetch = (async () => {
    throw new Error("network is disabled while the contract CI job loads the registry");
  }) as unknown as typeof fetch;
  const request = JSON.parse(await readFile(input, "utf8")) as ChildRequest;
  const { createCommandRegistry } = await import("../apps/backend/src/core/commands.js");
  const registry = createCommandRegistry();
  if (request.mode === "schemas") {
    const { canonicalJsonSchema } = await import("@orkestrator/protocol/contract/json-schema");
    const schemas: { [command: string]: JsonSchemaDocument } = {};
    for (const [name, def] of [...registry.contracts].sort(([a], [b]) => (a < b ? -1 : 1))) {
      schemas[name] = JSON.parse(canonicalJsonSchema(def.args)) as JsonSchemaDocument;
    }
    await writeFile(output, JSON.stringify(schemas));
    return;
  }
  const { decodeCommandArgs } = await import("@orkestrator/protocol/contract/command");
  const { SchemaIssue } = (await import(Bun.resolveSync("effect", protocolDirectory))) as {
    SchemaIssue: {
      makeFormatterStandardSchemaV1(): (issue: unknown) => {
        issues: readonly { path?: readonly PropertyKey[] }[];
      };
    };
  };
  const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1();
  const generator = await loadFixtureGenerator();
  const report = runArgumentFixtures(
    request.cases,
    (command, args) => {
      const def = registry.contracts.get(command);
      if (!def) return `${command} is not defined in the current registry.`;
      const decoded = decodeCommandArgs(def, args);
      if (decoded._tag === "Success") return null;
      const { message, cause } = decoded.failure as {
        message: string;
        cause?: { issue?: unknown };
      };
      // An unsupported critical field has no schema issue, so no path: it is always evidence.
      if (cause?.issue === undefined) return message;
      const paths = standardIssues(cause.issue).issues.map((issue) =>
        (issue.path ?? []).map((key) => (typeof key === "number" ? key : String(key))),
      );
      return { message, paths };
    },
    generator,
    request.count,
  );
  await writeFile(output, JSON.stringify(report));
}

/** Every argument digest a release snapshot file under `releases/` references. */
export function snapshotArgumentDigests(contractsDirectory: string): Set<string> {
  const digests = new Set<string>();
  const domains = join(contractsDirectory, "domains");
  if (!existsSync(domains)) return digests;
  for (const name of readdirSync(domains)) {
    if (!name.endsWith(".json")) continue;
    const blob = JSON.parse(readFileSync(join(domains, name), "utf8")) as {
      readonly commands?: { readonly [command: string]: { readonly argsDigest?: unknown } };
    };
    for (const entry of Object.values(blob.commands ?? {})) {
      if (typeof entry.argsDigest === "string") digests.add(entry.argsDigest);
    }
  }
  return digests;
}

/** Every argument digest the committed manifest references. */
export function manifestArgumentDigests(manifestText: string): Set<string> {
  const manifest = JSON.parse(manifestText) as {
    readonly commands?: { readonly [command: string]: { readonly argsDigest?: unknown } };
  };
  const digests = new Set<string>();
  for (const entry of Object.values(manifest.commands ?? {})) {
    if (typeof entry.argsDigest === "string") digests.add(entry.argsDigest);
  }
  return digests;
}

/** Writes the store from the current registry. Returns the exit status. */
export async function runWriteSchemaStore(
  options: {
    readonly contractsDirectory?: string;
    readonly schemas?: () => Promise<RegistrySchemas>;
    readonly log?: (line: string) => void;
  } = {},
): Promise<number> {
  const contractsDirectory =
    options.contractsDirectory ?? join(repoRoot, "packages/protocol/contracts");
  const log = options.log ?? ((line: string) => console.log(line));
  let schemas: RegistrySchemas;
  try {
    schemas = await (options.schemas ?? registrySchemasInChild)();
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const manifestFile = join(contractsDirectory, "manifest.json");
  const keep = new Set([
    ...snapshotArgumentDigests(contractsDirectory),
    ...(existsSync(manifestFile)
      ? manifestArgumentDigests(readFileSync(manifestFile, "utf8"))
      : []),
  ]);
  const { written, removed } = writeSchemaStore(contractsDirectory, Object.values(schemas), keep);
  log(
    `Argument schema store: ${Object.keys(schemas).length} defined commands, ${written.length} written, ${removed.length} removed.`,
  );
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === CHILD_FLAG && args[1] && args[2] && args.length === 3) {
    try {
      await childMain(args[1], args[2]);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    // Background work a registry module started must not keep the child alive.
    process.exit(0);
  }
  if (args.length > 0) {
    console.error("usage: bun scripts/contract-ci-schemas.ts");
    process.exit(1);
  }
  process.exit(await runWriteSchemaStore());
}
