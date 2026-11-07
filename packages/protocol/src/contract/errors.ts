/**
 * Typed incompatibility errors (docs/reports/unified-federation.md §11.2,
 * "Typed incompatibility errors"; plan items 1002 and 1005).
 *
 * Three codes say that a peer cannot serve a call because of version skew,
 * replacing text matching:
 *
 * - `unknown-command`: the peer does not have the command at all;
 * - `unsupported-version`: the call's domain version is outside the peer's
 *   range (`range` is the peer's `{ min, max }`);
 * - `unsupported-field`: the call named a critical (must-understand) field the
 *   peer does not know (`field`).
 *
 * Each code is an Effect `Data.TaggedError`: a real `Error` with a `code`
 * property, so the existing transports carry it unchanged (the gateway already
 * answers `{ error: message, code }` for any error whose `code` matches its
 * pattern, and the node link keeps `code`). The details go on the wire as a
 * bounded `details` object, `{ domain?, range?, field? }`, never an argument
 * value. {@link toWire} and {@link fromWire} convert to and from that body.
 *
 * Callers do not branch on the classes: {@link incompatibility} reads any of
 * them, a coded error rebuilt by a transport, a wire body, or a pre-contract
 * node's legacy `Unknown backend command: <name>` text.
 *
 * Browser-safe: no Node or Bun imports.
 */
import { Data } from "effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { isUnknownCommandError, unknownBackendCommandMessage } from "../unknown-command.js";
import { DomainNameSchema, DomainVersionSchema } from "./envelope.js";

export const INCOMPATIBILITY_CODES = [
  "unknown-command",
  "unsupported-version",
  "unsupported-field",
] as const;

export type IncompatibilityCode = (typeof INCOMPATIBILITY_CODES)[number];

/** A peer's accepted version range for one domain. */
export interface VersionRange {
  readonly min: number;
  readonly max: number;
}

/** What an incompatibility names. Every member is optional and bounded. */
export interface IncompatibilityDetails {
  readonly domain?: string;
  readonly range?: VersionRange;
  readonly field?: string;
}

/** One incompatibility, as {@link incompatibility} reports it. */
export interface Incompatibility extends IncompatibilityDetails {
  readonly code: IncompatibilityCode;
}

/** The longest field name a `details.field` carries (plan item 1005). */
export const MAX_DETAIL_FIELD_LENGTH = 64;

/** The longest error message {@link fromWire} accepts. */
export const MAX_WIRE_MESSAGE_LENGTH = 2_048;

/** The bounded `details` object of a coded error body. Unknown keys are dropped. */
export const IncompatibilityDetailsSchema = Schema.Struct({
  domain: Schema.optionalKey(DomainNameSchema),
  range: Schema.optionalKey(Schema.Struct({ min: DomainVersionSchema, max: DomainVersionSchema })),
  field: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_DETAIL_FIELD_LENGTH)),
  ),
});

/** The JSON error body for an incompatibility: the gateway's `{ error, code }` plus `details`. */
export const IncompatibilityWireSchema = Schema.Struct({
  error: Schema.String.check(Schema.isMaxLength(MAX_WIRE_MESSAGE_LENGTH)),
  code: Schema.Literals(INCOMPATIBILITY_CODES),
  details: Schema.optionalKey(IncompatibilityDetailsSchema),
});

export type IncompatibilityWire = typeof IncompatibilityWireSchema.Type;

/** The peer does not have the command. The message is the legacy text, so older text matchers still work. */
export class UnknownCommandError extends Data.TaggedError("UnknownCommandError")<{
  readonly message: string;
  readonly command?: string;
  readonly domain?: string;
}> {
  readonly code = "unknown-command" as const;
}

/** The call's domain version is outside the peer's range. */
export class UnsupportedVersionError extends Data.TaggedError("UnsupportedVersionError")<{
  readonly message: string;
  readonly command?: string;
  readonly domain?: string;
  readonly range?: VersionRange;
}> {
  readonly code = "unsupported-version" as const;
}

/** The call named a critical field the peer does not understand. */
export class UnsupportedFieldError extends Data.TaggedError("UnsupportedFieldError")<{
  readonly message: string;
  readonly command?: string;
  readonly domain?: string;
  readonly field?: string;
}> {
  readonly code = "unsupported-field" as const;
}

export type IncompatibilityError =
  UnknownCommandError | UnsupportedVersionError | UnsupportedFieldError;

/** Builds the `unknown-command` error with the legacy message text. */
export function unknownCommand(command: string, domain?: string): UnknownCommandError {
  return new UnknownCommandError({
    message: unknownBackendCommandMessage(command),
    command,
    ...(domain === undefined ? {} : { domain }),
  });
}

/** Builds the `unsupported-version` error naming the peer's range. */
export function unsupportedVersion(spec: {
  readonly domain: string;
  readonly range: VersionRange;
  readonly version?: number;
  readonly command?: string;
}): UnsupportedVersionError {
  const asked = spec.version === undefined ? "" : ` version ${spec.version}`;
  const subject = spec.command === undefined ? "" : ` for ${spec.command}`;
  return new UnsupportedVersionError({
    message: `Domain ${spec.domain}${asked}${subject} is not supported; this backend accepts versions ${spec.range.min} to ${spec.range.max}.`,
    domain: spec.domain,
    range: { min: spec.range.min, max: spec.range.max },
    ...(spec.command === undefined ? {} : { command: spec.command }),
  });
}

/** Builds the `unsupported-field` error naming the field (never its value). */
export function unsupportedField(spec: {
  readonly field: string;
  readonly domain?: string;
  readonly command?: string;
}): UnsupportedFieldError {
  const field = spec.field.slice(0, MAX_DETAIL_FIELD_LENGTH);
  const subject = spec.command === undefined ? "" : ` of ${spec.command}`;
  return new UnsupportedFieldError({
    message: `Critical field ${field}${subject} is not supported by this backend.`,
    field,
    ...(spec.domain === undefined ? {} : { domain: spec.domain }),
    ...(spec.command === undefined ? {} : { command: spec.command }),
  });
}

/** Whether `error` is one of the three incompatibility error classes. */
export function isIncompatibilityError(error: unknown): error is IncompatibilityError {
  return (
    error instanceof UnknownCommandError ||
    error instanceof UnsupportedVersionError ||
    error instanceof UnsupportedFieldError
  );
}

function detailsOf(error: IncompatibilityError): IncompatibilityDetails {
  const details: { domain?: string; range?: VersionRange; field?: string } = {};
  if (error.domain !== undefined) details.domain = error.domain;
  if (error._tag === "UnsupportedVersionError" && error.range !== undefined) {
    details.range = { min: error.range.min, max: error.range.max };
  }
  if (error._tag === "UnsupportedFieldError" && error.field !== undefined) {
    details.field = error.field;
  }
  return details;
}

/** The JSON error body for `error`; `details` is omitted when it would be empty. */
export function toWire(error: IncompatibilityError): IncompatibilityWire {
  const details = detailsOf(error);
  return {
    error: error.message.slice(0, MAX_WIRE_MESSAGE_LENGTH),
    code: error.code,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

const decodeWireHead = Schema.decodeUnknownResult(
  Schema.Struct({
    error: IncompatibilityWireSchema.fields.error,
    code: IncompatibilityWireSchema.fields.code,
  }),
);
const decodeDetails = Schema.decodeUnknownResult(IncompatibilityDetailsSchema);

/**
 * Bounded details from an untrusted value. Malformed details are dropped as a
 * whole, and a range whose `min` exceeds its `max` is dropped: an error still
 * says what kind of incompatibility it is without them.
 */
function readDetails(value: unknown): IncompatibilityDetails {
  const decoded = decodeDetails(value);
  if (Result.isFailure(decoded)) return {};
  const { range, ...rest } = decoded.success;
  return range !== undefined && range.min <= range.max ? { ...rest, range } : rest;
}

/** Rebuilds the error class from a JSON error body, or `null` when the body is not a coded incompatibility. */
export function fromWire(body: unknown): IncompatibilityError | null {
  const head = decodeWireHead(body);
  if (Result.isFailure(head)) return null;
  const details = readDetails((body as { details?: unknown }).details ?? {});
  const message = head.success.error;
  switch (head.success.code) {
    case "unknown-command":
      return new UnknownCommandError({ message, ...withDomain(details) });
    case "unsupported-version":
      return new UnsupportedVersionError({
        message,
        ...withDomain(details),
        ...(details.range === undefined ? {} : { range: details.range }),
      });
    case "unsupported-field":
      return new UnsupportedFieldError({
        message,
        ...withDomain(details),
        ...(details.field === undefined ? {} : { field: details.field }),
      });
  }
}

function withDomain(details: IncompatibilityDetails): { domain?: string } {
  return details.domain === undefined ? {} : { domain: details.domain };
}

const CODE_SET: ReadonlySet<string> = new Set(INCOMPATIBILITY_CODES);

/** The detail members an error carries as its own properties, without the absent ones. */
function ownDetails(error: object): Record<string, unknown> {
  const own: Record<string, unknown> = {};
  for (const key of ["domain", "range", "field"] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (value !== undefined) own[key] = value;
  }
  return own;
}

/**
 * Reads an incompatibility from any thrown or received value, or returns
 * `null` for anything else.
 *
 * - A value with an incompatibility `code` (one of the error classes, a
 *   transport's rebuilt error with `code` and `details`, or a wire body) is
 *   read by its code. Details come from its `details` object when it has one,
 *   otherwise from its own `domain`, `range` and `field`.
 * - Otherwise, when `command` is given, a pre-contract node's legacy
 *   `Unknown backend command: <command>` text (in an `Error` or a string) is
 *   read as `unknown-command`, through `isUnknownCommandError`.
 */
export function incompatibility(error: unknown, command?: string): Incompatibility | null {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && CODE_SET.has(code)) {
      const carried = (error as { details?: unknown }).details;
      const details = readDetails(
        typeof carried === "object" && carried !== null ? carried : ownDetails(error),
      );
      return { code: code as IncompatibilityCode, ...details };
    }
  }
  if (command !== undefined && isUnknownCommandError(error, command)) {
    return { code: "unknown-command" };
  }
  return null;
}
