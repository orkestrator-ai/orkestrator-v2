/**
 * Event definitions (docs/reports/unified-federation.md §11.2; typed emit and
 * listen arrive with plan item 7011).
 *
 * ```ts
 * export const environmentChanged = defineEvent({
 *   domain: environments,
 *   name: "environment-changed",
 *   payload: EnvironmentChangedSchema,
 * });
 * type Payload = PayloadOf<typeof environmentChanged>;
 * ```
 *
 * The payload schema follows the same rules as command schemas
 * (`command.ts`): JSON-shaped, `Schema.Finite`, `Schema.optionalKey`, `u`
 * patterns. Receivers decode tolerantly, dropping unknown keys.
 *
 * Browser-safe: no Node or Bun imports.
 */
import { Data } from "effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { WireSchema } from "./command.js";
import type { AnyDomainDef } from "./domain.js";

/** An event name: lower kebab case, as backend event names are. */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

export const MAX_EVENT_NAME_LENGTH = 128;

/** An event definition. Create it with {@link defineEvent}; it is frozen. */
export interface EventDef<
  Domain extends AnyDomainDef = AnyDomainDef,
  Name extends string = string,
  Payload extends WireSchema = WireSchema,
> {
  readonly kind: "event";
  readonly domain: Domain;
  readonly name: Name;
  readonly payload: Payload;
}

export type AnyEventDef = EventDef<AnyDomainDef, string, WireSchema>;

/** The decoded payload of an event. */
export type PayloadOf<E extends AnyEventDef> = E["payload"]["Type"];
/** The payload as it travels on the wire. */
export type EncodedPayloadOf<E extends AnyEventDef> = E["payload"]["Encoded"];

/** Defines an event. Throws at module load on an invalid name. */
export function defineEvent<
  const Domain extends AnyDomainDef,
  const Name extends string,
  Payload extends WireSchema,
>(spec: {
  readonly domain: Domain;
  readonly name: Name;
  readonly payload: Payload;
}): EventDef<Domain, Name, Payload> {
  const { name } = spec;
  if (
    typeof name !== "string" ||
    name.length > MAX_EVENT_NAME_LENGTH ||
    !EVENT_NAME_PATTERN.test(name)
  ) {
    throw new Error(`Invalid contract event name "${String(name)}".`);
  }
  return Object.freeze({ kind: "event", domain: spec.domain, name, payload: spec.payload });
}

/** Whether `value` is an event definition. */
export function isEventDef(value: unknown): value is AnyEventDef {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "event"
  );
}

/** A payload that does not match an event's schema. `cause` is the `Schema.SchemaError`. */
export class InvalidEventPayloadError extends Data.TaggedError("InvalidEventPayloadError")<{
  readonly message: string;
  readonly event: string;
  readonly cause: Schema.SchemaError;
}> {}

function payloadError(def: AnyEventDef, cause: Schema.SchemaError): InvalidEventPayloadError {
  return new InvalidEventPayloadError({
    message: `Invalid payload for event ${def.name}: ${cause.message}`,
    event: def.name,
    cause,
  });
}

/** Decodes a received payload, tolerantly (unknown keys dropped). */
export function decodeEventPayload<E extends AnyEventDef>(
  def: E,
  raw: unknown,
): Result.Result<PayloadOf<E>, InvalidEventPayloadError> {
  const decoded = Schema.decodeUnknownResult(def.payload)(raw, { onExcessProperty: "ignore" });
  if (Result.isSuccess(decoded)) return Result.succeed(decoded.success as PayloadOf<E>);
  return Result.fail(payloadError(def, decoded.failure));
}

/**
 * Checks an emitted payload and returns its wire form. Development and tests
 * only, like `validateCommandResult`; the caller decides from `NODE_ENV`.
 */
export function validateEventPayload<E extends AnyEventDef>(
  def: E,
  value: unknown,
): Result.Result<EncodedPayloadOf<E>, InvalidEventPayloadError> {
  const encoded = Schema.encodeUnknownResult(def.payload)(value, { onExcessProperty: "ignore" });
  if (Result.isSuccess(encoded)) return Result.succeed(encoded.success as EncodedPayloadOf<E>);
  return Result.fail(payloadError(def, encoded.failure));
}
