/**
 * The invoke envelope (docs/reports/unified-federation.md §11.2,
 * "Must-understand"):
 *
 * ```json
 * { "command": "deliver_node_mail", "args": { … }, "domain": "node-mail",
 *   "version": 1, "critical": ["steer"] }
 * ```
 *
 * `command` and `args` are today's invoke body; `domain`, `version` and
 * `critical` are new and optional, so an older backend that reads only
 * `command` and `args` ignores them. A contract-aware backend refuses a call
 * whose `version` is outside its range (`unsupported-version`) and a call
 * that sends a `critical` field it does not know (`unsupported-field`).
 *
 * The guard is bounded: at most {@link MAX_CRITICAL_FIELDS} critical names,
 * each a valid argument key. A malformed `critical`, `domain` or `version`
 * refuses the whole envelope rather than being dropped, because dropping a
 * must-understand list would silently downgrade the call. Unknown envelope
 * keys are ignored (tolerant reader).
 *
 * Browser-safe: no Node or Bun imports.
 */
import { Data } from "effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { DOMAIN_NAME_PATTERN, MAX_DOMAIN_NAME_LENGTH, MAX_DOMAIN_VERSION } from "./domain.js";

/** The most critical field names one envelope may list. */
export const MAX_CRITICAL_FIELDS = 16;

/** The longest argument key a critical list may name. */
export const MAX_ARG_KEY_LENGTH = 64;

/** An argument key: an identifier, as every command's argument fields are. */
export const ARG_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Whether `value` is a valid argument key. */
export function isArgKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ARG_KEY_LENGTH &&
    ARG_KEY_PATTERN.test(value)
  );
}

/** One argument key, as a schema. */
export const ArgKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ARG_KEY_LENGTH),
  Schema.isPattern(ARG_KEY_PATTERN),
);

/** A bounded critical list. */
export const CriticalFieldsSchema = Schema.Array(ArgKeySchema).check(
  Schema.isMaxLength(MAX_CRITICAL_FIELDS),
);

/** A domain name's shape (known or not: a newer client may name a newer domain). */
export const DomainNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_DOMAIN_NAME_LENGTH),
  Schema.isPattern(DOMAIN_NAME_PATTERN),
);

/** A domain version, 0 (legacy) to {@link MAX_DOMAIN_VERSION}. */
export const DomainVersionSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_DOMAIN_VERSION }),
);

/** The invoke envelope. Unknown keys are dropped when decoding. */
export const InvokeEnvelopeSchema = Schema.Struct({
  command: Schema.String,
  /** Absent means no arguments, as today's invoke body allows. */
  args: Schema.optionalKey(Schema.Unknown),
  domain: Schema.optionalKey(DomainNameSchema),
  version: Schema.optionalKey(DomainVersionSchema),
  critical: Schema.optionalKey(CriticalFieldsSchema),
});

export type InvokeEnvelope = typeof InvokeEnvelopeSchema.Type;

/** An invoke body that is not a valid envelope. The message names the problem, never a value. */
export class InvalidEnvelopeError extends Data.TaggedError("InvalidEnvelopeError")<{
  readonly message: string;
}> {}

const decodeEnvelope = Schema.decodeUnknownResult(InvokeEnvelopeSchema);

/**
 * Decodes an invoke body into the envelope, dropping unknown keys. A body that
 * is not an object, has no string `command`, or carries a malformed `domain`,
 * `version` or `critical` is refused.
 */
export function decodeInvokeEnvelope(
  body: unknown,
): Result.Result<InvokeEnvelope, InvalidEnvelopeError> {
  const decoded = decodeEnvelope(body);
  if (Result.isSuccess(decoded)) return Result.succeed(decoded.success);
  return Result.fail(new InvalidEnvelopeError({ message: envelopeProblem(body) }));
}

/** A value-free description of what is wrong with `body`. */
function envelopeProblem(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "The invoke body must be an object.";
  }
  const record = body as Record<string, unknown>;
  if (typeof record.command !== "string") return "Expected command to be a string";
  for (const [key, schema] of [
    ["domain", DomainNameSchema],
    ["version", DomainVersionSchema],
    ["critical", CriticalFieldsSchema],
  ] as const) {
    if (!Object.hasOwn(record, key)) continue;
    if (Result.isFailure(Schema.decodeUnknownResult(schema)(record[key]))) {
      return key === "critical"
        ? `The envelope's critical list must hold at most ${MAX_CRITICAL_FIELDS} argument keys.`
        : `The envelope's ${key} is invalid.`;
    }
  }
  return "The invoke envelope is invalid.";
}
