/**
 * Command definitions (docs/reports/unified-federation.md §11.2).
 *
 * One `defineCommand` per command gives the backend, web, desktop and CLI one
 * definition: its domain, the domain version that introduced it, how a grant
 * may reach it, whether it is a read, and Effect Schemas for its arguments and
 * result.
 *
 * ```ts
 * export const listEnvironments = defineCommand({
 *   domain: environments,
 *   name: "get_environments",
 *   since: 1,
 *   access: "workspace",
 *   read: true,
 *   args: Schema.Struct({ projectId: Schema.String }),
 *   result: Schema.Array(EnvironmentSchema),
 *   critical: [],
 * });
 * type Args = ArgsOf<typeof listEnvironments>; // { readonly projectId: string }
 * ```
 *
 * Schema rules (plan item 1001), because the manifest digests each schema's
 * JSON Schema export (plan item 1006):
 *
 * - `args` is a `Schema.Struct`; its field names are the argument keys.
 * - `Schema.Finite` for wire numbers, `Schema.optionalKey` for optional
 *   fields, RegExp patterns with the `u` flag, and a named schema shared as one
 *   constant.
 * - Schemas are JSON-shaped: the decoded `Type` and the wire `Encoded` form
 *   coincide (no transformations), because production sends results as
 *   handlers return them. `EncodedArgsOf` and `EncodedResultOf` name the wire
 *   form for transports.
 *
 * Decoding is tolerant: unknown argument keys are dropped (Effect's default
 * `onExcessProperty: "ignore"`), except that a key the caller lists as critical
 * and the definition does not know is refused with `unsupported-field`
 * ({@link decodeCommandArgs}).
 *
 * Browser-safe: no Node or Bun imports.
 */
import { Data } from "effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { AnyDomainDef } from "./domain.js";
import { MAX_CRITICAL_FIELDS, isArgKey, type InvokeEnvelope } from "./envelope.js";
import { unsupportedField, type UnsupportedFieldError } from "./errors.js";

/**
 * How a grant may reach a command, the input to the grant allow-list
 * (§10.2): `workspace` for a workspace grant, `admin` for an admin grant only,
 * `internal` for backend-to-backend and local callers only.
 */
export type CommandAccess = "workspace" | "admin" | "internal";

export const COMMAND_ACCESS = [
  "workspace",
  "admin",
  "internal",
] as const satisfies readonly CommandAccess[];

/** A registered command name: lower snake case, as every backend command is. */
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;

export const MAX_COMMAND_NAME_LENGTH = 128;

/** A schema whose decoding and encoding need no Effect services. */
export type WireSchema = Schema.Codec<unknown, unknown, never, never>;

/** A command's argument schema: a struct, so its field names are the argument keys. */
export interface ArgsSchema extends Schema.Codec<object, unknown, never, never> {
  readonly fields: Schema.Struct.Fields;
}

/** A command definition. Create it with {@link defineCommand}; it is frozen. */
export interface CommandDef<
  Domain extends AnyDomainDef = AnyDomainDef,
  Name extends string = string,
  Args extends ArgsSchema = ArgsSchema,
  Res extends WireSchema = WireSchema,
> {
  readonly kind: "command";
  readonly domain: Domain;
  readonly name: Name;
  /** The domain version that introduced the command. */
  readonly since: number;
  readonly access: CommandAccess;
  /** Routing classification: `true` for a read, replacing the name regex. */
  readonly read: boolean;
  readonly args: Args;
  readonly result: Res;
  /**
   * The argument keys a sender must mark critical when it sends them: those a
   * receiver must not silently ignore (a steer flag, an idempotency key, a
   * safety option). {@link buildInvokeEnvelope} puts the ones present in the
   * envelope.
   */
  readonly critical: readonly string[];
  /**
   * The handler returns pre-encoded JSON that the gateway splices in
   * (transcript bodies). Result validation skips it.
   */
  readonly encoded: boolean;
  /**
   * A per-keystroke or per-frame command (terminal input, resize, output
   * reads; plan item 7002). The backend still validates its result only in
   * development and tests, like every command; a domain client may skip
   * decoding its result in production (`validateHotPathResults`), so the
   * input and output path gains no per-call result validation.
   */
  readonly hotPath: boolean;
}

/** Any command definition, for constraints. */
export type AnyCommandDef = CommandDef<AnyDomainDef, string, ArgsSchema, WireSchema>;

/** The decoded arguments of a command. */
export type ArgsOf<C extends AnyCommandDef> = C["args"]["Type"];
/** The arguments as they travel on the wire. */
export type EncodedArgsOf<C extends AnyCommandDef> = C["args"]["Encoded"];
/** The decoded result of a command. */
export type ResultOf<C extends AnyCommandDef> = C["result"]["Type"];
/** The result as it travels on the wire. */
export type EncodedResultOf<C extends AnyCommandDef> = C["result"]["Encoded"];

/** The argument keys of an args schema, for the `critical` list. */
export type ArgKeyOf<Args extends ArgsSchema> = Extract<keyof Args["fields"], string>;

/**
 * Defines a command. Throws at module load on an invalid name, a `since`
 * outside `1..domain.version`, an unknown access level, or a critical list
 * that is too long or names a key the args schema does not declare.
 */
export function defineCommand<
  const Domain extends AnyDomainDef,
  const Name extends string,
  Args extends ArgsSchema,
  Res extends WireSchema,
>(spec: {
  readonly domain: Domain;
  readonly name: Name;
  readonly since: number;
  readonly access: CommandAccess;
  readonly read: boolean;
  readonly args: Args;
  readonly result: Res;
  readonly critical: readonly ArgKeyOf<Args>[];
  readonly encoded?: boolean;
  readonly hotPath?: boolean;
}): CommandDef<Domain, Name, Args, Res> {
  const { domain, name } = spec;
  if (
    typeof name !== "string" ||
    name.length > MAX_COMMAND_NAME_LENGTH ||
    !COMMAND_NAME_PATTERN.test(name)
  ) {
    throw new Error(`Invalid contract command name "${String(name)}".`);
  }
  if (!Number.isSafeInteger(spec.since) || spec.since < 1 || spec.since > domain.version) {
    throw new Error(`Command ${name}: since must be a version of domain ${domain.name}.`);
  }
  if (!(COMMAND_ACCESS as readonly string[]).includes(spec.access)) {
    throw new Error(`Command ${name}: unknown access level.`);
  }
  if (typeof spec.read !== "boolean") {
    throw new Error(`Command ${name}: read must be a boolean.`);
  }
  const critical = [...new Set<string>(spec.critical)];
  if (critical.length > MAX_CRITICAL_FIELDS) {
    throw new Error(`Command ${name}: at most ${MAX_CRITICAL_FIELDS} critical fields.`);
  }
  for (const key of critical) {
    if (!isArgKey(key) || !Object.hasOwn(spec.args.fields, key)) {
      throw new Error(`Command ${name}: critical field ${key} is not an argument key.`);
    }
  }
  return Object.freeze({
    kind: "command",
    domain,
    name,
    since: spec.since,
    access: spec.access,
    read: spec.read,
    args: spec.args,
    result: spec.result,
    critical: Object.freeze(critical),
    encoded: spec.encoded ?? false,
    hotPath: spec.hotPath ?? false,
  });
}

/** Whether `value` is a command definition. */
export function isCommandDef(value: unknown): value is AnyCommandDef {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "command"
  );
}

/** Arguments that do not match a command's schema. `cause` is the `Schema.SchemaError`. */
export class InvalidCommandArgsError extends Data.TaggedError("InvalidCommandArgsError")<{
  readonly message: string;
  readonly command: string;
  readonly cause: Schema.SchemaError;
}> {}

/** A result that does not match a command's schema. `cause` is the `Schema.SchemaError`. */
export class InvalidCommandResultError extends Data.TaggedError("InvalidCommandResultError")<{
  readonly message: string;
  readonly command: string;
  readonly cause: Schema.SchemaError;
}> {}

function isPresent(record: unknown, key: string): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    Object.hasOwn(record, key) &&
    (record as Record<string, unknown>)[key] !== undefined
  );
}

/**
 * Decodes a command's arguments on the receiving side, tolerantly.
 *
 * - Unknown keys are dropped.
 * - A key in `options.critical` (the envelope's list) that the definition does
 *   not declare and that the arguments actually carry is refused with
 *   `unsupported-field`, naming the first such key. A listed key the
 *   arguments do not carry is ignored: there is nothing to misunderstand.
 * - A schema mismatch fails with {@link InvalidCommandArgsError}.
 * - Absent arguments (`undefined` or `null`) decode as `{}`, as today's
 *   handlers treat a body without `args`.
 *
 * The critical list is assumed bounded already ({@link decodeInvokeEnvelope}).
 */
export function decodeCommandArgs<C extends AnyCommandDef>(
  def: C,
  raw: unknown,
  options: { readonly critical?: readonly string[] } = {},
): Result.Result<ArgsOf<C>, UnsupportedFieldError | InvalidCommandArgsError> {
  for (const key of options.critical ?? []) {
    if (!Object.hasOwn(def.args.fields, key) && isPresent(raw, key)) {
      return Result.fail(
        unsupportedField({ field: key, domain: def.domain.name, command: def.name }),
      );
    }
  }
  const decoded = Schema.decodeUnknownResult(def.args)(raw ?? {}, { onExcessProperty: "ignore" });
  if (Result.isSuccess(decoded)) return Result.succeed(decoded.success as ArgsOf<C>);
  return Result.fail(
    new InvalidCommandArgsError({
      message: `Invalid arguments for ${def.name}: ${decoded.failure.message}`,
      command: def.name,
      cause: decoded.failure,
    }),
  );
}

/**
 * Checks a handler's result against the command's schema and returns its wire
 * form. Meant for development and tests only (the caller decides, from
 * `NODE_ENV`); production skips it. A definition with `encoded: true` is
 * passed through unchecked, because its result is pre-encoded JSON.
 */
export function validateCommandResult<C extends AnyCommandDef>(
  def: C,
  value: unknown,
): Result.Result<EncodedResultOf<C>, InvalidCommandResultError> {
  if (def.encoded) return Result.succeed(value as EncodedResultOf<C>);
  const encoded = Schema.encodeUnknownResult(def.result)(value, { onExcessProperty: "ignore" });
  if (Result.isSuccess(encoded)) return Result.succeed(encoded.success as EncodedResultOf<C>);
  return Result.fail(resultError(def, encoded.failure));
}

/**
 * Decodes a result on the calling side, tolerantly: unknown keys are dropped
 * and a mismatch fails with {@link InvalidCommandResultError}.
 */
export function decodeCommandResult<C extends AnyCommandDef>(
  def: C,
  raw: unknown,
): Result.Result<ResultOf<C>, InvalidCommandResultError> {
  const decoded = Schema.decodeUnknownResult(def.result)(raw, { onExcessProperty: "ignore" });
  if (Result.isSuccess(decoded)) return Result.succeed(decoded.success as ResultOf<C>);
  return Result.fail(resultError(def, decoded.failure));
}

function resultError(def: AnyCommandDef, cause: Schema.SchemaError): InvalidCommandResultError {
  return new InvalidCommandResultError({
    message: `Invalid result from ${def.name}: ${cause.message}`,
    command: def.name,
    cause,
  });
}

/**
 * The envelope a sender puts on an invoke of `def`: the command, its
 * arguments, its domain and version (the domain's current version unless the
 * adapter in use speaks an older one), and the definition's critical keys
 * that `args` actually carries. `critical` is omitted when none are present.
 */
export function buildInvokeEnvelope<C extends AnyCommandDef>(
  def: C,
  args: EncodedArgsOf<C>,
  version: number = def.domain.version,
): InvokeEnvelope {
  const critical = def.critical.filter((key) => isPresent(args, key));
  return {
    command: def.name,
    args,
    domain: def.domain.name,
    version,
    ...(critical.length > 0 ? { critical } : {}),
  };
}
