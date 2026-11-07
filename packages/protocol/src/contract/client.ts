/**
 * Domain clients (docs/reports/unified-federation.md §11.2, "Client
 * adapters", §11.4; Decisions 13.6 and 13.9).
 *
 * A domain client is one API with an adapter per domain version it can speak:
 *
 * ```ts
 * export const environmentsClient = domainClient(environments, {
 *   4: (call) => ({ list: (projectId: string) => call(listEnvironments, { projectId }) }),
 *   3: (call) => ({ list: async (projectId: string) => upgradeV3(await call(listEnvironmentsV3, { projectId })) }),
 *   0: (call, legacy) => legacyEnvironmentsApi(call, legacy),
 * });
 *
 * const client = createDomainClient(environmentsClient, { call, domains: () => node.domains.get() });
 * await client.api().list(projectId);
 * ```
 *
 * {@link createDomainClient} binds a definition to one node's transport. It
 * picks one adapter with {@link pickVersion} per connection generation (per
 * `domains` identity), caches it, and refuses with a coded
 * `unsupported-version` when no adapter is in the node's range. Callers never
 * see versions. The client is scope-agnostic and lives in protocol because the
 * pilot domains are called backend to backend (plan item 1010); a node scope
 * (plan item 2011) builds one per node.
 *
 * Version 0 is the legacy adapter: today's capability-gated behaviour for a
 * node that advertises no range for the domain, either because its hello has
 * no `domains` at all (a pre-contract node, §11.4) or because the domain has
 * no defined commands on it yet. It may consult the hello's `capabilities` or
 * the domain's own capability command ({@link LEGACY_CAPABILITY_COMMANDS})
 * through its {@link DomainAdapterContext}. Its calls carry no envelope, so a
 * pre-contract node gets today's `{ command, args }`.
 *
 * Retirement: an adapter for version `v` is deleted when the support floor
 * passes the first Stable release with `v + 1`. Until then every call through
 * an adapter below the domain's current version is counted, content-free
 * (`client-usage.ts`), and the committed adapter list
 * (`packages/protocol/contracts/adapters.json`, `client-adapters.ts`) lets CI
 * check that every (domain, version) in the support window still has one.
 *
 * Browser-safe: no Node or Bun imports.
 */
import * as Result from "effect/Result";
import type { NegotiatedDomainRange, NegotiatedDomains } from "../node-client.js";
import {
  buildInvokeEnvelope,
  decodeCommandResult,
  type AnyCommandDef,
  type ArgsOf,
  type EncodedArgsOf,
  type ResultOf,
} from "./command.js";
import type { AnyDomainDef, DomainName } from "./domain.js";
import { incompatibility, unsupportedVersion } from "./errors.js";

/** The legacy adapter version, used for a node with no range for the domain. */
export const LEGACY_DOMAIN_VERSION = 0;

/** The range a node with no contract information for a domain is treated as having. */
export const PRE_CONTRACT_RANGE: NegotiatedDomainRange = Object.freeze({ min: 0, max: 0 });

/** The transport an adapter calls through, typed by the command definition. */
export type CommandCall = <C extends AnyCommandDef>(
  def: C,
  args: ArgsOf<C>,
) => Promise<ResultOf<C>>;

/**
 * What an adapter gets besides {@link CommandCall}: the version it was picked
 * for and, for the legacy adapter, today's capability gating.
 */
export interface DomainAdapterContext {
  readonly domain: DomainName;
  /** The version this adapter was picked for. */
  readonly version: number;
  /** The node's advertised range for the domain, or `null` when it gives none. */
  readonly range: NegotiatedDomainRange | null;
  /** The hello's `capabilities`, when the transport passed them. */
  readonly capabilities: ReadonlySet<string> | null;
  /**
   * Runs a command that has no definition yet, by name and without an
   * envelope (a legacy adapter's string-registered commands). Throws when the
   * transport gave no `invoke`.
   */
  invoke(command: string, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
  /**
   * The answer of one of this domain's {@link LEGACY_CAPABILITY_COMMANDS},
   * read once per connection generation, or `null` when the node predates the
   * command (`unknown-command`). Any other failure is thrown and not kept, so
   * a transient error is never read as "legacy".
   */
  capability(command: string): Promise<unknown>;
}

/** Builds a domain's API for one version over a transport. */
export type DomainAdapter<Api> = (call: CommandCall, context: DomainAdapterContext) => Api;

/**
 * The per-domain capability commands that exist today (plan item 1009 Notes),
 * which a domain's legacy adapter may read. Each is folded into its domain's
 * version during Phase 7 and leaves this list with its legacy adapter.
 */
export const LEGACY_CAPABILITY_COMMANDS: Readonly<Partial<Record<DomainName, readonly string[]>>> =
  Object.freeze({
    config: Object.freeze(["get_client_state_capabilities"]),
    design: Object.freeze(["design_capabilities"]),
    git: Object.freeze(["changes_get_capabilities"]),
    "native-sessions": Object.freeze([
      "get_agent_handoff_capabilities",
      "get_native_agent_sync_capabilities",
    ]),
    previews: Object.freeze(["get_preview_capabilities"]),
    transcripts: Object.freeze(["transcript_artifact_capabilities"]),
    "web-annotations": Object.freeze(["web_annotations_capabilities"]),
  });

/** A domain client definition. Create it with {@link domainClient}; it is frozen. */
export interface DomainClientDef<Domain extends AnyDomainDef = AnyDomainDef, Api = unknown> {
  readonly kind: "domain-client";
  readonly domain: Domain;
  /** One adapter per domain version, keyed by version. */
  readonly adapters: Readonly<Record<number, DomainAdapter<Api>>>;
  /** The adapter versions, highest first. */
  readonly versions: readonly number[];
}

/** The API a domain client gives, whichever version is picked. */
export type ApiOf<D extends DomainClientDef> =
  D extends DomainClientDef<AnyDomainDef, infer Api> ? Api : never;

/**
 * Defines a domain client. Every adapter must give the same `Api`. Throws on
 * a version key outside `0..domain.version`, or when the domain's current
 * version has no adapter (a build always speaks its own version).
 */
export function domainClient<const Domain extends AnyDomainDef, Api>(
  domain: Domain,
  adapters: Readonly<Record<number, DomainAdapter<Api>>>,
): DomainClientDef<Domain, Api> {
  const versions = Object.keys(adapters).map(Number);
  for (const version of versions) {
    if (!Number.isSafeInteger(version) || version < 0 || version > domain.version) {
      throw new Error(
        `Domain client ${domain.name}: adapter versions must be 0 to ${domain.version}.`,
      );
    }
    if (typeof adapters[version] !== "function") {
      throw new Error(`Domain client ${domain.name}: adapter ${version} is not a function.`);
    }
  }
  if (!versions.includes(domain.version)) {
    throw new Error(
      `Domain client ${domain.name}: no adapter for the current version ${domain.version}.`,
    );
  }
  versions.sort((a, b) => b - a);
  return Object.freeze({
    kind: "domain-client",
    domain,
    adapters: Object.freeze({ ...adapters }),
    versions: Object.freeze(versions),
  });
}

/** Whether `value` is a domain client definition made by {@link domainClient}. */
export function isDomainClientDef(value: unknown): value is DomainClientDef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "domain-client"
  );
}

/**
 * The highest version in `clientVersions` that the node accepts, or `null`
 * when the ranges are disjoint.
 *
 * `negotiated` is the node's advertised `{ min, max }` for the domain. `null`
 * or `undefined` means the node gave no range for it (a pre-contract node, or
 * a domain it does not advertise), which is version 0 only: the legacy
 * adapter, when the client has one.
 */
export function pickVersion(
  clientVersions: Iterable<number>,
  negotiated: NegotiatedDomainRange | null | undefined,
): number | null {
  const range = negotiated ?? PRE_CONTRACT_RANGE;
  let picked: number | null = null;
  for (const version of clientVersions) {
    if (version >= range.min && version <= range.max && (picked === null || version > picked)) {
      picked = version;
    }
  }
  return picked;
}

/**
 * The envelope fields a domain client sends beside `command` and `args`.
 * `args` is left out: over desktop IPC the arguments travel positionally and
 * the envelope is bounded to 4096 characters (plan item 1003), and the HTTP
 * and node-link transports put `command` and `args` in the body themselves.
 */
export interface ContractEnvelopeFields {
  readonly domain: string;
  readonly version: number;
  readonly critical?: readonly string[];
}

/**
 * A domain client's transport: runs `def` on the node with its wire
 * arguments and answers the node's wire result (the client decodes it).
 * `envelope` is `undefined` for the legacy adapter, so a pre-contract node
 * gets today's `{ command, args }`.
 */
export type DomainCall = (
  def: AnyCommandDef,
  args: unknown,
  envelope: ContractEnvelopeFields | undefined,
) => Promise<unknown>;

/** Runs a command by name, without an envelope (legacy adapters only). */
export type LegacyInvoke = (
  command: string,
  args?: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/**
 * Counts one call through an adapter below its domain's current version.
 * Names and numbers only; it must not throw (a throw is swallowed).
 */
export type DomainAdapterUsageRecorder = (domain: DomainName, version: number) => void;

/** A value, or a getter read on every {@link DomainClient.api} call. */
export type DomainClientSource<T> = T | (() => T);

export interface DomainClientOptions {
  readonly call: DomainCall;
  /**
   * The node's negotiated `domains` for its current connection generation, or
   * `null`/`undefined` for a pre-contract node. A getter must answer the same
   * object for the whole generation: the choice is cached per identity, and a
   * new object (a new generation) picks again.
   */
  readonly domains: DomainClientSource<NegotiatedDomains | null | undefined>;
  /** The hello's `capabilities`, for legacy adapters. Cached per identity like `domains`. */
  readonly capabilities?: DomainClientSource<
    readonly string[] | ReadonlySet<string> | null | undefined
  >;
  /** Untyped invoke for legacy adapters' string commands and capability reads. */
  readonly invoke?: LegacyInvoke;
  /** Usage counter for adapters below the current version (`client-usage.ts`). */
  readonly usage?: DomainAdapterUsageRecorder;
  /**
   * Whether results of `hotPath` commands (terminal input and output, plan
   * item 7002) are decoded. Defaults to `true`; a renderer passes `false` in
   * production so the per-keystroke path gains no validation cost, as the
   * backend validates results only in development and tests (plan item
   * 1003). Every other command's result is always decoded.
   */
  readonly validateHotPathResults?: boolean;
}

/** A domain client bound to one node's transport. */
export interface DomainClient<Api> {
  readonly def: DomainClientDef<AnyDomainDef, Api>;
  /**
   * The adapter version picked for the current connection generation, or
   * `null` when no adapter is in the node's range.
   */
  version(): number | null;
  /**
   * The API for the current connection generation. Throws the coded
   * `unsupported-version` error (`UnsupportedVersionError`, with the node's
   * range) when no adapter is in the node's range.
   */
  api(): Api;
  /** Forgets the cached choice, for a transport that reconnects without a new `domains` object. */
  reset(): void;
}

interface Selection<Api> {
  readonly domains: unknown;
  readonly capabilities: unknown;
  readonly version: number | null;
  readonly range: NegotiatedDomainRange | null;
  api?: Api;
}

function read<T>(source: DomainClientSource<T>): T {
  return typeof source === "function" ? (source as () => T)() : source;
}

function ownRange(
  domains: NegotiatedDomains | null | undefined,
  name: string,
): NegotiatedDomainRange | null {
  if (domains === null || domains === undefined || !Object.hasOwn(domains, name)) return null;
  return domains[name] ?? null;
}

/** The envelope fields for `def` at `version`, without `command` and `args`. */
export function contractEnvelopeFields<C extends AnyCommandDef>(
  def: C,
  args: EncodedArgsOf<C>,
  version: number,
): ContractEnvelopeFields {
  const { domain, critical } = buildInvokeEnvelope(def, args, version);
  return critical ? { domain: domain!, version, critical } : { domain: domain!, version };
}

/**
 * Binds a domain client definition to a node's transport (§11.2 "Client
 * adapters"). See the module comment for the selection, caching and legacy
 * rules.
 *
 * An adapter's `call` refuses a command from another domain (its envelope
 * would name the wrong version) and, from version 1 up, a command whose
 * `since` is newer than the adapter's version. Results are decoded with the
 * command's schema, tolerantly (unknown keys dropped); a mismatch throws the
 * `InvalidCommandResultError`. Errors from the transport pass through
 * unchanged, so a node's own `unsupported-version`, `unsupported-field` or
 * `unknown-command` reaches the caller with its code.
 *
 * Promise-based by design: the selection is synchronous and every method is
 * the adapter's own promise. No Effect runtime is involved.
 */
export function createDomainClient<Domain extends AnyDomainDef, Api>(
  def: DomainClientDef<Domain, Api>,
  options: DomainClientOptions,
): DomainClient<Api> {
  const domain = def.domain;
  let cached: Selection<Api> | null = null;

  const select = (): Selection<Api> => {
    const domains = read(options.domains);
    const capabilities =
      options.capabilities === undefined ? undefined : read(options.capabilities);
    if (cached && cached.domains === domains && cached.capabilities === capabilities) {
      return cached;
    }
    const range = ownRange(domains, domain.name);
    cached = {
      domains,
      capabilities,
      range,
      version: pickVersion(def.versions, range),
    };
    return cached;
  };

  const build = (selection: Selection<Api>, version: number): Api => {
    const counted = version < domain.version;
    const count = () => {
      if (!counted || !options.usage) return;
      try {
        options.usage(domain.name, version);
      } catch {
        // Counting never fails a call.
      }
    };
    const legacyInvoke = (command: string, args?: Readonly<Record<string, unknown>>) => {
      if (!options.invoke) {
        return Promise.reject(
          new Error(`Domain client ${domain.name}: this transport has no untyped invoke.`),
        );
      }
      return options.invoke(command, args);
    };
    const call: CommandCall = async (command, args) => {
      if (command.domain.name !== domain.name) {
        throw new Error(
          `Domain client ${domain.name}: ${command.name} belongs to the ${command.domain.name} domain.`,
        );
      }
      if (version > 0 && command.since > version) {
        throw new Error(
          `Domain client ${domain.name}: ${command.name} arrived in version ${command.since}; adapter ${version} cannot call it.`,
        );
      }
      count();
      const wire = args as EncodedArgsOf<typeof command>;
      const envelope = version === 0 ? undefined : contractEnvelopeFields(command, wire, version);
      const raw = await options.call(command, wire, envelope);
      if (command.hotPath && options.validateHotPathResults === false) {
        return raw as ResultOf<typeof command>;
      }
      const decoded = decodeCommandResult(command, raw);
      if (Result.isFailure(decoded)) throw decoded.failure;
      return decoded.success;
    };
    const capabilitySet = toSet(selection.capabilities);
    const allowed = new Set(LEGACY_CAPABILITY_COMMANDS[domain.name] ?? []);
    const answers = new Map<string, Promise<unknown>>();
    const context: DomainAdapterContext = Object.freeze({
      domain: domain.name,
      version,
      range: selection.range,
      capabilities: capabilitySet,
      invoke: (command: string, args?: Readonly<Record<string, unknown>>) => {
        count();
        return legacyInvoke(command, args);
      },
      capability: (command: string) => {
        if (!allowed.has(command)) {
          return Promise.reject(
            new Error(
              `Domain client ${domain.name}: ${command} is not this domain's capability command.`,
            ),
          );
        }
        let answer = answers.get(command);
        if (!answer) {
          answer = legacyInvoke(command).catch((error: unknown) => {
            if (incompatibility(error, command)?.code === "unknown-command") return null;
            answers.delete(command);
            throw error;
          });
          answers.set(command, answer);
        }
        return answer;
      },
    });
    return def.adapters[version]!(call, context);
  };

  return Object.freeze({
    def,
    version: () => select().version,
    api: () => {
      const selection = select();
      if (selection.version === null) {
        throw unsupportedVersion({
          domain: domain.name,
          range: selection.range ?? PRE_CONTRACT_RANGE,
          version: def.versions[0],
        });
      }
      selection.api ??= build(selection, selection.version);
      return selection.api;
    },
    reset: () => {
      cached = null;
    },
  });
}

function toSet(value: unknown): ReadonlySet<string> | null {
  if (value instanceof Set) return value as ReadonlySet<string>;
  if (Array.isArray(value)) return new Set(value.filter((item) => typeof item === "string"));
  return null;
}
