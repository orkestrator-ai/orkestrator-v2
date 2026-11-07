/**
 * The registry side of command contracts (plan item 1003,
 * docs/reports/unified-federation.md §11.2 "Definitions" and
 * "Must-understand").
 *
 * A command registered as `register(def, handler)` gets:
 *
 * - tolerant arguments: unknown keys are stripped before the handler runs;
 * - must-understand fields: a key the envelope lists as `critical` that the
 *   definition does not declare, and that the arguments carry, is refused with
 *   `unsupported-field`;
 * - the existing validation text for a schema failure (`Expected projectId to
 *   be a string`, the `commands-validation.ts` phrasing), so messages users
 *   see do not change when a handler adopts its definition;
 * - result validation in development and tests, except `encoded: true`
 *   definitions (the pre-encoded transcript splice).
 *
 * Every command, defined or not, refuses an envelope whose `domain` and
 * `version` fall outside the range this registry accepts for that domain
 * (`unsupported-version` naming the range). A string-registered command does
 * not know its argument keys, so it refuses any critical field the arguments
 * carry: ignoring a must-understand field is never safe.
 */
import {
  decodeCommandArgs,
  InvalidCommandArgsError,
  validateCommandResult,
  type AnyCommandDef,
} from "@orkestrator/protocol/contract/command";
import {
  unsupportedField,
  unsupportedVersion,
  type VersionRange,
} from "@orkestrator/protocol/contract/errors";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import type { CommandHandler, CommandInvocation } from "./commands-context.js";
import type {
  CommandRegistrar,
  CommandTarget,
  DefinedCommandHandler,
  DefinedCommandOptions,
} from "./commands-registry-types.js";

/** The registered name of a registration target. */
export function commandTargetName(target: CommandTarget): string {
  return typeof target === "string" ? target : target.name;
}

/**
 * A registrar that wraps every handler `register` receives, forwarding both
 * registration forms. `wrap` sees the command's name and the handler as
 * registered; for a definition, that handler receives the decoded arguments
 * (the registry decodes before any wrapper runs).
 */
export function wrapRegistrar(
  register: CommandRegistrar,
  wrap: (name: string, handler: CommandHandler) => CommandHandler,
): CommandRegistrar {
  const wrapped = (
    target: CommandTarget,
    handler: CommandHandler,
    options?: DefinedCommandOptions,
  ): void => registerTarget(register, target, wrap(commandTargetName(target), handler), options);
  return wrapped as CommandRegistrar;
}

/**
 * Registers `handler` under either form of target, for a wrapper that builds
 * its own handler. For a definition, `handler` receives the decoded arguments.
 */
export function registerTarget(
  register: CommandRegistrar,
  target: CommandTarget,
  handler: CommandHandler,
  options?: DefinedCommandOptions,
): void {
  if (typeof target === "string") register(target, handler);
  else if (options) register(target, handler as DefinedCommandHandler<AnyCommandDef>, options);
  else register(target, handler as DefinedCommandHandler<AnyCommandDef>);
}

/**
 * The command map `createCommandRegistry` returns, plus the definitions of the
 * commands registered with one. The manifest generator (plan item 1006) and
 * the hello's domain ranges (plan item 1004) read `contracts`.
 */
export class CommandRegistry extends Map<string, CommandHandler> {
  /** Every command registered with `register(def, handler)`, by name. */
  readonly contracts = new Map<string, AnyCommandDef>();
  /** The version range accepted per domain that has a defined command. */
  readonly domainRanges = new Map<string, VersionRange>();

  /**
   * Records a registration target before its handler is stored. Throws when
   * the name is already registered in the other form, or defined twice, and
   * when two definitions disagree on their domain's versions.
   */
  claim(target: CommandTarget): void {
    const name = commandTargetName(target);
    if (typeof target === "string") {
      if (this.contracts.has(name)) {
        throw new Error(`Command ${name} is already registered with its definition.`);
      }
      return;
    }
    if (this.has(name)) throw new Error(`Command ${name} is already registered.`);
    const domain = target.domain;
    const known = this.domainRanges.get(domain.name);
    if (known && (known.min !== domain.min || known.max !== domain.version)) {
      throw new Error(`Domain ${domain.name} is defined with two version ranges.`);
    }
    this.contracts.set(name, target);
    if (!known) this.domainRanges.set(domain.name, { min: domain.min, max: domain.version });
  }

  /**
   * The hello's `domains` (plan item 1004): every domain with a defined
   * command, as `{ min, max }` where `max` is the domain's current version and
   * `min` the oldest version declared next to it (`defineDomain({ min })`).
   * Sorted by name, and empty until a command is registered with its
   * definition. A fresh object each call.
   */
  helloDomains(): Record<string, VersionRange> {
    const domains: Record<string, VersionRange> = {};
    for (const name of [...this.domainRanges.keys()].sort()) {
      const range = this.domainRanges.get(name)!;
      domains[name] = { min: range.min, max: range.max };
    }
    return domains;
  }
}

/** Whether results are validated by default: in development and tests only. */
export function contractResultValidationDefault(
  env: { readonly NODE_ENV?: string | undefined } = process.env,
): boolean {
  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}

/**
 * Refuses a call whose envelope names a domain version outside this
 * registry's range for that domain. A domain with no defined command has no
 * range here and is not checked (an older client never sends one, and there
 * is no range to report).
 */
export function assertInvocationVersion(
  invocation: CommandInvocation | undefined,
  ranges: ReadonlyMap<string, VersionRange>,
  command: string,
): void {
  const domain = invocation?.domain;
  const version = invocation?.version;
  if (domain === undefined || version === undefined) return;
  const range = ranges.get(domain);
  if (!range || (version >= range.min && version <= range.max)) return;
  throw unsupportedVersion({ domain, range, version, command });
}

function carries(args: unknown, key: string): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    Object.hasOwn(args, key) &&
    (args as Record<string, unknown>)[key] !== undefined
  );
}

/**
 * Wraps a string-registered handler: a critical field the arguments carry is
 * refused, since an untyped command cannot say it understands it. Without a
 * critical list (every older client) the handler is called unchanged.
 */
export function untypedCommandHandler(name: string, handler: CommandHandler): CommandHandler {
  return (args, context, invocation) => {
    for (const key of invocation?.critical ?? []) {
      if (carries(args, key)) throw unsupportedField({ field: key, command: name });
    }
    return handler(args, context, invocation);
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Wraps a defined command's handler: decode the arguments (strip unknown keys,
 * refuse an unknown critical field, keep the existing validation text), run
 * it, and validate the result when `validateResults` is set. The handler's own
 * result is returned, not its encoding, so a validated and an unvalidated run
 * answer the same value. A synchronous handler stays synchronous.
 */
export function contractCommandHandler<C extends AnyCommandDef>(
  def: C,
  handler: DefinedCommandHandler<C>,
  options: { readonly validateResults: boolean },
): CommandHandler {
  const check = (result: unknown): unknown => {
    const validated = validateCommandResult(def, result);
    if (Result.isFailure(validated)) throw validated.failure;
    return result;
  };
  return (args, context, invocation) => {
    const decoded = decodeCommandArgs(
      def,
      args,
      invocation?.critical === undefined ? {} : { critical: invocation.critical },
    );
    if (Result.isFailure(decoded)) {
      const failure = decoded.failure;
      if (failure instanceof InvalidCommandArgsError) {
        throw new InvalidCommandArgsError({
          message: commandArgsErrorMessage(def, failure.cause),
          command: def.name,
          cause: failure.cause,
        });
      }
      throw failure;
    }
    // This registry-wide fence is validated by the container guard, rather
    // than each command schema. Keep it through tolerant schema decoding so
    // a stale (or malformed) fence cannot become an unfenced invocation.
    const guardedArgs = carries(args, "expectedRuntimeGeneration")
      ? {
          ...decoded.success,
          expectedRuntimeGeneration: args.expectedRuntimeGeneration,
        }
      : decoded.success;
    const result = handler(guardedArgs, context, invocation);
    if (!options.validateResults || def.encoded) return result;
    return isPromiseLike(result) ? Promise.resolve(result).then(check) : check(result);
  };
}

/**
 * The text of an argument schema failure, in the phrasing of
 * `commands-validation.ts`: `Expected <path> to be a string`, `... an
 * object`, and so on, for the first failure. A `message` annotation on the
 * failing schema or check (or `messageMissingKey` on an absent key) wins, so a
 * definition can keep any hand-written text exactly. Values never appear.
 */
export function commandArgsErrorMessage(def: AnyCommandDef, error: Schema.SchemaError): string {
  return describeIssue(error.issue, [], def.args.ast);
}

type Path = readonly PropertyKey[];

function formatPath(path: Path): string {
  if (path.length === 0) return "arguments";
  let text = "";
  for (const key of path) {
    if (typeof key === "number") text += `[${key}]`;
    else text += text.length === 0 ? String(key) : `.${String(key)}`;
  }
  return text;
}

function messageOf(annotations: { readonly [key: string]: unknown } | undefined, key = "message") {
  const message = annotations?.[key];
  return typeof message === "string" ? message : undefined;
}

/** The last check's annotations, where Effect keeps a refined schema's message. */
function astMessage(ast: SchemaAST.AST | undefined): string | undefined {
  if (!ast) return undefined;
  const checks = ast.checks;
  const last = checks && checks.length > 0 ? checks[checks.length - 1] : undefined;
  return messageOf(last?.annotations) ?? messageOf(ast.annotations);
}

function describeType(ast: SchemaAST.AST | undefined): string {
  switch (ast?._tag) {
    case "String":
      return "a string";
    case "Number":
      return "a number";
    case "Boolean":
      return "a boolean";
    case "Objects":
      return "an object";
    case "Arrays":
      return "an array";
    case "Literal":
      return JSON.stringify(ast.literal) ?? "valid";
    case "Union":
      if (ast.types.every((member) => member._tag === "Literal")) {
        const literals = ast.types.map((member) =>
          member._tag === "Literal" ? JSON.stringify(member.literal) : "",
        );
        return `one of ${literals.join(", ")}`;
      }
      return "valid";
    default:
      return "valid";
  }
}

/** The schema of `key` inside `parent`, to describe a missing key. */
function childAst(parent: SchemaAST.AST | undefined, key: PropertyKey): SchemaAST.AST | undefined {
  if (parent?._tag === "Objects") {
    return parent.propertySignatures.find((signature) => signature.name === key)?.type;
  }
  if (parent?._tag === "Arrays" && typeof key === "number") {
    return parent.elements[key] ?? parent.rest[0];
  }
  return undefined;
}

function expected(path: Path, phrase: string): string {
  return `Expected ${formatPath(path)} to be ${phrase}`;
}

function describeIssue(
  issue: SchemaIssue.Issue,
  path: Path,
  parent: SchemaAST.AST | undefined,
): string {
  switch (issue._tag) {
    case "Pointer": {
      let ast = parent;
      for (const key of issue.path) ast = childAst(ast, key);
      return describeIssue(issue.issue, [...path, ...issue.path], ast);
    }
    case "Composite": {
      const first = issue.issues[0];
      // A composite's children point into its own schema.
      return first ? describeIssue(first, path, issue.ast) : expected(path, "valid");
    }
    case "Encoding":
      return describeIssue(issue.issue, path, parent);
    case "Filter": {
      const message = messageOf(issue.filter.annotations);
      if (message !== undefined) return message;
      const phrase = issue.filter.annotations?.expected;
      return expected(path, typeof phrase === "string" ? phrase : "valid");
    }
    case "MissingKey":
      return (
        messageOf(issue.annotations, "messageMissingKey") ??
        astMessage(parent) ??
        expected(path, describeType(parent))
      );
    case "InvalidType":
      return astMessage(issue.ast) ?? expected(path, describeType(issue.ast));
    case "AnyOf":
      return astMessage(issue.ast) ?? expected(path, describeType(issue.ast));
    case "InvalidValue":
    case "OneOf":
      return expected(path, "valid");
    case "UnexpectedKey":
    case "Forbidden":
      return `Invalid ${formatPath(path)}`;
  }
}

/** `run` inside the registration's `beforeDecode` wrapper, when it has one. */
function beforeDecode(run: CommandHandler, options: DefinedCommandOptions | undefined) {
  return options?.beforeDecode ? options.beforeDecode(run) : run;
}

/**
 * The registry's own registrar over `commands`: it claims the name (refusing a
 * duplicate across forms), then stores a handler that checks the envelope's
 * domain version, decodes a defined command's arguments (or refuses critical
 * fields for an untyped one), and runs `guard(name, handler)`, all inside
 * `time`. A definition's `beforeDecode` option wraps the decoding and the
 * handler, after the version check. `createCommandRegistry` passes the
 * container guard and command timing; a test can pass neither.
 */
export function createRegistryRegistrar(
  commands: CommandRegistry,
  options: {
    readonly validateResults: boolean;
    readonly guard?: (name: string, handler: CommandHandler) => CommandHandler;
    readonly time?: <T>(name: string, run: () => T) => T;
  },
): CommandRegistrar {
  const { validateResults, guard, time } = options;
  const register = (
    target: CommandTarget,
    handler: CommandHandler,
    registration?: DefinedCommandOptions,
  ): void => {
    const name = commandTargetName(target);
    commands.claim(target);
    const guarded = guard ? guard(name, handler) : handler;
    const run =
      typeof target === "string"
        ? untypedCommandHandler(name, guarded)
        : beforeDecode(
            contractCommandHandler(target, guarded as DefinedCommandHandler<AnyCommandDef>, {
              validateResults,
            }),
            registration,
          );
    const call: CommandHandler = (args, context, invocation) => {
      assertInvocationVersion(invocation, commands.domainRanges, name);
      return run(args, context, invocation);
    };
    commands.set(
      name,
      time
        ? (args, context, invocation) => time(name, () => call(args, context, invocation))
        : call,
    );
  };
  return register as CommandRegistrar;
}

/**
 * A registrar over a plain `(name, handler)` sink, for tests and small
 * collectors: a definition is decoded and validated the same way the registry
 * does, then handed to `sink` under its name.
 */
export function registrarFrom(
  sink: (name: string, handler: CommandHandler) => unknown,
  options: { readonly validateResults?: boolean } = {},
): CommandRegistrar {
  const validateResults = options.validateResults ?? contractResultValidationDefault();
  const register = (
    target: CommandTarget,
    handler: CommandHandler,
    registration?: DefinedCommandOptions,
  ): void => {
    if (typeof target === "string") {
      sink(target, handler);
      return;
    }
    sink(
      target.name,
      beforeDecode(
        contractCommandHandler(target, handler as DefinedCommandHandler<AnyCommandDef>, {
          validateResults,
        }),
        registration,
      ),
    );
  };
  return register as CommandRegistrar;
}
