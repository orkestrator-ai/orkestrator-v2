#!/usr/bin/env bun
/**
 * Regenerates the committed contract manifest from the backend command
 * registry (plan item 1006, docs/reports/unified-federation.md §11.3 step 1).
 *
 *   bun scripts/generate-contract-manifest.ts           # write
 *   bun scripts/generate-contract-manifest.ts --check   # verify, no writes
 *
 * `packages/protocol/contracts/manifest.json` describes every registered
 * command, sorted by name:
 *
 * - a command registered with its definition (`register(def, handler)`) as
 *   `{ domain, since, access, read, critical, argsDigest, resultDigest }`,
 *   where each digest is the SHA-256 of the canonical JSON Schema export of
 *   the schema ({@link schemaDigest});
 * - every other command as `{ domain, untyped: true, read }`, its domain from
 *   `apps/backend/src/core/contract-domain-map.ts` and `read` from the routing
 *   classifier `isNodeReadCommand`. A command in neither place fails the
 *   generator, so a new string-registered command has to pick a domain.
 *
 * `domains` holds each defined domain's `{ version, min }`, and `events` every
 * backend event (plan item 7011, `BACKEND_EVENTS`): `{ domain, payloadDigest }`
 * by name, and an event family (per-terminal `terminal-output-<id>`, ...) as
 * `<prefix>*` with `{ domain, family: true, prefix, key, payloadDigest }`.
 * Every event is typed: the backend's `BackendEmit` accepts only a
 * definition, so there is no untyped event to count. `counts` and
 * `untypedByDomain` are derived totals, so a ratchet (plan item 1011) reads
 * the untyped count without walking `commands`.
 *
 * The registry is loaded the way `commands-secret-sweep-test-support.ts` does:
 * in a child process with a constructed environment (temporary HOME and XDG
 * directories, an empty PATH, no inherited `ORKESTRATOR_*` variable) and a
 * `fetch` that refuses, calling `createCommandRegistry()` with no options. No
 * command runs. `--check` regenerates and fails when the committed file
 * differs.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isNodeReadCommand } from "@orkestrator/protocol/command-nodes";
import { canonicalJsonSchema } from "@orkestrator/protocol/contract/json-schema";
import type { AnyCommandDef, CommandAccess } from "@orkestrator/protocol/contract/command";
import {
  BACKEND_EVENTS,
  type BackendEventDefinition,
} from "@orkestrator/protocol/contract/domains/events";
import { isDomainName, type DomainName } from "@orkestrator/protocol/contract/domain";
import type { VersionRange } from "@orkestrator/protocol/contract/errors";
import {
  contractDomainsByCommand,
  type ContractDomainMap,
} from "../apps/backend/src/core/contract-domain-map.js";

const repoRoot = join(import.meta.dir, "..");
const scriptPath = join(import.meta.dir, "generate-contract-manifest.ts");

/** The committed manifest, relative to the repository root. */
export const CONTRACT_MANIFEST_PATH = "packages/protocol/contracts/manifest.json";
/** The manifest file format; a reader refuses a version it does not know. */
export const CONTRACT_MANIFEST_SCHEMA_VERSION = 1;
const DOMAIN_MAP_PATH = "apps/backend/src/core/contract-domain-map.ts";
const CHILD_FLAG = "--child";
const CHILD_TIMEOUT_MS = 60_000;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
/** `bun fmt`'s print width (`bunfig.toml`), so the output is already formatted. */
const PRINT_WIDTH = 100;

export interface DefinedCommandEntry {
  readonly domain: DomainName;
  readonly since: number;
  readonly access: CommandAccess;
  readonly read: boolean;
  /** Sorted. */
  readonly critical: readonly string[];
  readonly argsDigest: string;
  readonly resultDigest: string;
}

export interface UntypedCommandEntry {
  readonly domain: DomainName;
  readonly untyped: true;
  readonly read: boolean;
}

export type CommandEntry = DefinedCommandEntry | UntypedCommandEntry;

export interface EventEntry {
  readonly domain: DomainName;
  readonly payloadDigest: string;
}

/** An event family, keyed `<prefix>*` in `events`. `key` is the member key pattern's source. */
export interface EventFamilyEntry {
  readonly domain: DomainName;
  readonly family: true;
  readonly prefix: string;
  readonly key: string;
  readonly payloadDigest: string;
}

export interface ContractManifest {
  readonly schemaVersion: typeof CONTRACT_MANIFEST_SCHEMA_VERSION;
  readonly generatedBy: string;
  readonly counts: {
    readonly commands: number;
    readonly defined: number;
    readonly untyped: number;
    /** Defined events and event families. */
    readonly events: number;
  };
  /** Untyped commands per domain, only domains that have one. */
  readonly untypedByDomain: { readonly [domain: string]: number };
  /** Every domain with a defined command: its current version and the oldest it accepts. */
  readonly domains: {
    readonly [domain: string]: { readonly version: number; readonly min: number };
  };
  readonly commands: { readonly [command: string]: CommandEntry };
  /** Every backend event (plan item 7011), by name; a family as `<prefix>*`. */
  readonly events: { readonly [event: string]: EventEntry | EventFamilyEntry };
}

/** What the generator reads from a command registry (`CommandRegistry` in the backend). */
export interface ManifestRegistry {
  keys(): Iterable<string>;
  readonly contracts: ReadonlyMap<string, AnyCommandDef>;
  readonly domainRanges: ReadonlyMap<string, VersionRange>;
}

export interface BuildManifestOptions {
  /** The domain of each string-registered command. Defaults to the backend's map. */
  readonly domainMap?: ContractDomainMap;
  /** The read classification of an untyped command. Defaults to `isNodeReadCommand`. */
  readonly isRead?: (command: string) => boolean;
  /** The backend's events. Defaults to `BACKEND_EVENTS`. */
  readonly events?: readonly BackendEventDefinition[];
}

/** The registry and the domain map disagree; `problems` lists every finding. */
export class ContractManifestError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      [
        "The contract manifest cannot be generated:",
        ...problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
    );
    this.name = "ContractManifestError";
  }
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** A schema the manifest digests: a command's `args` or `result`, an event's payload. */
export type DigestedSchema = Parameters<typeof canonicalJsonSchema>[0];

/**
 * `sha256:<hex>` of the canonical JSON Schema export of `schema`
 * (`canonicalJsonSchema` in `@orkestrator/protocol/contract`: the dialect,
 * root schema and definitions of `Schema.toJsonSchemaDocument`, with object
 * keys and `required` sorted and every other array in order).
 */
export function schemaDigest(schema: DigestedSchema): string {
  return `sha256:${createHash("sha256").update(canonicalJsonSchema(schema)).digest("hex")}`;
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): { [key: string]: T } {
  const record: { [key: string]: T } = {};
  for (const [key, value] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    record[key] = value;
  }
  return record;
}

/**
 * Builds the manifest. Throws {@link ContractManifestError} listing every
 * string-registered command without a domain, every map entry for a command
 * that is not registered or is registered with its definition, any duplicate
 * entry and any unknown domain.
 */
export function buildContractManifest(
  registry: ManifestRegistry,
  options: BuildManifestOptions = {},
): ContractManifest {
  const problems: string[] = [];
  let domainOf: ReadonlyMap<string, DomainName>;
  try {
    domainOf = contractDomainsByCommand(options.domainMap);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    domainOf = new Map();
  }
  for (const [command, domain] of domainOf) {
    if (!isDomainName(domain)) {
      problems.push(
        `${command} is mapped to unknown domain ${String(domain)}: add it to DOMAIN_NAMES.`,
      );
    }
  }
  const isRead = options.isRead ?? isNodeReadCommand;
  const names = [...new Set(registry.keys())].sort();
  const registered = new Set(names);
  const missing: string[] = [];
  const commands: Array<readonly [string, CommandEntry]> = [];
  const untypedByDomain = new Map<string, number>();

  for (const name of names) {
    const def = registry.contracts.get(name);
    const mapped = domainOf.get(name);
    if (def) {
      if (mapped !== undefined) {
        problems.push(
          `${name} is registered with its definition (domain ${def.domain.name}); remove it from ${DOMAIN_MAP_PATH}.`,
        );
      }
      commands.push([
        name,
        {
          domain: def.domain.name,
          since: def.since,
          access: def.access,
          read: def.read,
          critical: [...def.critical].sort(),
          argsDigest: schemaDigest(def.args),
          resultDigest: schemaDigest(def.result),
        },
      ]);
      continue;
    }
    if (mapped === undefined) {
      missing.push(name);
      continue;
    }
    untypedByDomain.set(mapped, (untypedByDomain.get(mapped) ?? 0) + 1);
    commands.push([name, { domain: mapped, untyped: true, read: isRead(name) }]);
  }
  if (missing.length > 0) {
    problems.push(
      `No contract domain for ${missing.join(", ")}: register ${missing.length === 1 ? "it" : "each"} with defineCommand, or add ${missing.length === 1 ? "it" : "each"} to ${DOMAIN_MAP_PATH}.`,
    );
  }
  const stale = [...domainOf.keys()].filter((name) => !registered.has(name)).sort();
  if (stale.length > 0) {
    problems.push(
      `${DOMAIN_MAP_PATH} lists commands that are not registered: ${stale.join(", ")}.`,
    );
  }
  const events = eventEntries(options.events ?? BACKEND_EVENTS, problems);
  if (problems.length > 0) throw new ContractManifestError(problems);

  const defined = commands.length - [...untypedByDomain.values()].reduce((a, b) => a + b, 0);
  return {
    schemaVersion: CONTRACT_MANIFEST_SCHEMA_VERSION,
    generatedBy: "scripts/generate-contract-manifest.ts (mise run contract:manifest)",
    counts: {
      commands: commands.length,
      defined,
      untyped: commands.length - defined,
      events: events.length,
    },
    untypedByDomain: sortedRecord(untypedByDomain),
    domains: sortedRecord(
      [...registry.domainRanges].map(
        ([domain, range]) => [domain, { version: range.max, min: range.min }] as const,
      ),
    ),
    commands: sortedRecord(commands),
    events: sortedRecord(events),
  };
}

/** The manifest key of an event definition: its name, or `<prefix>*` for a family. */
export function eventManifestKey(def: BackendEventDefinition): string {
  return def.kind === "event" ? def.name : `${def.prefix}*`;
}

/** The `events` entries; a duplicate key, or a family prefix covering another event, is a problem. */
function eventEntries(
  defs: readonly BackendEventDefinition[],
  problems: string[],
): Array<readonly [string, EventEntry | EventFamilyEntry]> {
  const entries = new Map<string, EventEntry | EventFamilyEntry>();
  for (const def of defs) {
    const key = eventManifestKey(def);
    if (entries.has(key)) {
      problems.push(`Event ${key} is defined twice.`);
      continue;
    }
    const payloadDigest = schemaDigest(def.payload);
    entries.set(
      key,
      def.kind === "event"
        ? { domain: def.domain.name, payloadDigest }
        : {
            domain: def.domain.name,
            family: true,
            prefix: def.prefix,
            key: def.key.source,
            payloadDigest,
          },
    );
  }
  for (const family of defs) {
    if (family.kind !== "event-family") continue;
    for (const other of defs) {
      if (other === family) continue;
      const name = other.kind === "event" ? other.name : other.prefix;
      if (name.startsWith(family.prefix)) {
        problems.push(`Event family ${family.prefix}* also covers ${eventManifestKey(other)}.`);
      }
    }
  }
  return [...entries];
}

/**
 * The untyped command count, total and per domain, from a manifest's text or
 * parsed form, for the shrink-only ratchet (plan item 1011). Reads the
 * derived `counts` and `untypedByDomain`, which `--check` keeps in step with
 * `commands`.
 */
export function untypedCommandCounts(manifest: string | ContractManifest): {
  readonly total: number;
  readonly byDomain: { readonly [domain: string]: number };
} {
  const parsed: ContractManifest = typeof manifest === "string" ? JSON.parse(manifest) : manifest;
  if (parsed.schemaVersion !== CONTRACT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unknown contract manifest schemaVersion ${String(parsed.schemaVersion)}.`);
  }
  return { total: parsed.counts.untyped, byDomain: parsed.untypedByDomain };
}

/**
 * JSON with two-space indentation in the shape `bun fmt` keeps: objects
 * expanded (an empty one as `{}`), and an array of scalars on one line when
 * it fits the print width, one element per line otherwise.
 */
export function serializeContractManifest(manifest: ContractManifest): string {
  return `${formatJson(manifest as unknown as Json, "", "", 0)}\n`;
}

/**
 * `prefix` is what precedes the value on its line (`"key": `), and `suffix`
 * the length of what follows it (1 for a separating comma), so an inline array
 * is measured on the whole line.
 */
function formatJson(value: Json, indent: string, prefix: string, suffix: number): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const scalars = value.every((item) => item === null || typeof item !== "object");
    if (scalars) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (indent.length + prefix.length + inline.length + suffix <= PRINT_WIDTH) return inline;
    }
    const items = value.map(
      (item, index) => `${inner}${formatJson(item, inner, "", index < value.length - 1 ? 1 : 0)}`,
    );
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const record = value as { readonly [key: string]: Json };
  const keys = Object.keys(record);
  if (keys.length === 0) return "{}";
  const lines = keys.map((key, index) => {
    const keyText = `${JSON.stringify(key)}: `;
    const comma = index < keys.length - 1 ? 1 : 0;
    return `${inner}${keyText}${formatJson(record[key] as Json, inner, keyText, comma)}`;
  });
  return `{\n${lines.join(",\n")}\n${indent}}`;
}

/** What changed between the committed manifest text and the generated one. */
export function describeManifestDrift(committed: string | null, generated: string): string[] {
  if (committed === null) return [`${CONTRACT_MANIFEST_PATH} is missing.`];
  if (committed === generated) return [];
  let before: Partial<ContractManifest>;
  try {
    before = JSON.parse(committed) as Partial<ContractManifest>;
  } catch {
    return [`${CONTRACT_MANIFEST_PATH} is not valid JSON.`];
  }
  const after = JSON.parse(generated) as ContractManifest;
  const problems: string[] = [];
  const compare = (
    label: string,
    old: { readonly [key: string]: unknown } | undefined,
    next: { readonly [key: string]: unknown },
  ) => {
    const previous = old ?? {};
    for (const key of Object.keys(next)) {
      if (!Object.hasOwn(previous, key)) problems.push(`${label} added: ${key}`);
      else if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
        problems.push(`${label} changed: ${key}`);
      }
    }
    for (const key of Object.keys(previous)) {
      if (!Object.hasOwn(next, key)) problems.push(`${label} removed: ${key}`);
    }
  };
  compare("command", before.commands, after.commands);
  compare("domain", before.domains, after.domains);
  compare("event", before.events, after.events);
  if (problems.length === 0) {
    problems.push(`${CONTRACT_MANIFEST_PATH} differs from the generated text (format or totals).`);
  }
  return problems;
}

export interface RunOptions {
  readonly check: boolean;
  /** Absolute path of the manifest. */
  readonly manifestPath?: string;
  /** Produces the generated manifest text. Defaults to loading the registry in a child process. */
  readonly generate?: () => Promise<string>;
  readonly log?: (line: string) => void;
}

/** Writes the manifest, or with `check` compares it. Returns the exit status. */
export async function runContractManifest(options: RunOptions): Promise<number> {
  const manifestPath = options.manifestPath ?? join(repoRoot, CONTRACT_MANIFEST_PATH);
  const log = options.log ?? ((line: string) => console.log(line));
  let generated: string;
  try {
    generated = await (options.generate ?? generateInChild)();
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (!options.check) {
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, generated);
    const { counts } = JSON.parse(generated) as ContractManifest;
    log(
      `Wrote ${CONTRACT_MANIFEST_PATH}: ${counts.commands} commands (${counts.defined} defined, ${counts.untyped} untyped), ${counts.events} events.`,
    );
    return 0;
  }
  const committed = existsSync(manifestPath) ? await readFile(manifestPath, "utf8") : null;
  const drift = describeManifestDrift(committed, generated);
  if (drift.length === 0) {
    log(`${CONTRACT_MANIFEST_PATH} is current.`);
    return 0;
  }
  log(`${CONTRACT_MANIFEST_PATH} has drifted from the command registry:`);
  for (const line of drift) log(`  - ${line}`);
  log("Run `mise run contract:manifest` and commit the result.");
  return 1;
}

export function parseArguments(args: readonly string[]): { readonly check: boolean } {
  if (args.length === 0) return { check: false };
  if (args.length === 1 && args[0] === "--check") return { check: true };
  throw new Error("usage: bun scripts/generate-contract-manifest.ts [--check]");
}

/**
 * Loads the registry in a child process with a constructed environment and
 * returns the manifest text it writes, or throws with the child's output.
 */
async function generateInChild(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orkestrator-contract-manifest-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "bin");
    const tmp = join(root, "tmp");
    await Promise.all([home, bin, tmp].map((dir) => mkdir(dir, { recursive: true })));
    const output = join(root, "manifest.json");
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
    const child = spawn(process.execPath, ["--no-env-file", scriptPath, CHILD_FLAG, output], {
      // Not the repository: bun reads bunfig.toml and .env from its cwd.
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    return await readFile(output, "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The child: load the registry, build the manifest, write it to `output`. */
async function childMain(output: string): Promise<void> {
  // No registry module may reach the network while loading.
  globalThis.fetch = (async () => {
    throw new Error("network is disabled while generating the contract manifest");
  }) as unknown as typeof fetch;
  const { createCommandRegistry } = await import("../apps/backend/src/core/commands.js");
  const manifest = buildContractManifest(createCommandRegistry());
  await writeFile(output, serializeContractManifest(manifest));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === CHILD_FLAG && args[1] && args.length === 2) {
    try {
      await childMain(args[1]);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    // Background work a registry module started must not keep the child alive.
    process.exit(0);
  }
  process.exit(await runContractManifest(parseArguments(args)));
}
