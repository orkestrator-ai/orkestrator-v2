/**
 * Event definitions (docs/reports/unified-federation.md §11.2). Every backend
 * event is defined per domain under `contract/domains/<domain>/events.ts` and
 * listed in `contract/domains/events.ts` (plan item 7011). The backend emits
 * them through its typed `BackendEmit`; clients receive them through
 * `listenEvent(client, def, handler)`.
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

/**
 * An event name: lower kebab case, as backend event names are, with at most
 * one `:`-separated kebab suffix (the long-standing `claude-tmux:event`).
 */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/u;

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
  /** Set on a member of an event family ({@link EventFamilyDef.at}). */
  readonly family?: AnyEventFamilyDef;
}

export type AnyEventDef = EventDef<AnyDomainDef, string, WireSchema>;

/** The decoded payload of an event (or of every member of an event family). */
export type PayloadOf<E extends AnyEventDef | AnyEventFamilyDef> = E["payload"]["Type"];
/** The payload as it travels on the wire. */
export type EncodedPayloadOf<E extends AnyEventDef | AnyEventFamilyDef> = E["payload"]["Encoded"];

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

/**
 * The default key of an event family: the backend id shape
 * (`federation.ts`), which also covers terminal session and container ids.
 */
export const EVENT_FAMILY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;

/**
 * Events whose name carries a key, such as per-terminal
 * `terminal-output-<sessionId>`. `at(key)` names one member; its payload is
 * the family's. The prefix is kebab case and ends in `-` or `:`.
 */
export interface EventFamilyDef<
  Domain extends AnyDomainDef = AnyDomainDef,
  Prefix extends string = string,
  Payload extends WireSchema = WireSchema,
> {
  readonly kind: "event-family";
  readonly domain: Domain;
  readonly prefix: Prefix;
  /** What a member key looks like. */
  readonly key: RegExp;
  readonly payload: Payload;
  /**
   * The member event for `key`. Cheap (terminal output calls it per chunk):
   * the key is not checked here; the backend's development and test
   * validation checks it (`hasValidEventKey`).
   */
  at(key: string): EventDef<Domain, `${Prefix}${string}`, Payload>;
  /** The key of `name` when it is a member of this family, otherwise `null`. */
  keyOf(name: string): string | null;
}

export type AnyEventFamilyDef = EventFamilyDef<AnyDomainDef, string, WireSchema>;

const EVENT_FAMILY_PREFIX_PATTERN = /^[a-z][a-z0-9-]*[-:]$/u;

/** Defines an event family. Throws at module load on an invalid prefix or key pattern. */
export function defineEventFamily<
  const Domain extends AnyDomainDef,
  const Prefix extends string,
  Payload extends WireSchema,
>(spec: {
  readonly domain: Domain;
  readonly prefix: Prefix;
  readonly payload: Payload;
  readonly key?: RegExp;
}): EventFamilyDef<Domain, Prefix, Payload> {
  const { prefix } = spec;
  const key = spec.key ?? EVENT_FAMILY_KEY_PATTERN;
  if (
    typeof prefix !== "string" ||
    prefix.length > MAX_EVENT_NAME_LENGTH ||
    !EVENT_FAMILY_PREFIX_PATTERN.test(prefix)
  ) {
    throw new Error(`Invalid contract event family prefix "${String(prefix)}".`);
  }
  if (!key.source.startsWith("^") || !key.source.endsWith("$") || key.global || key.sticky) {
    throw new Error(`Contract event family "${prefix}" needs an anchored, stateless key pattern.`);
  }
  const family: EventFamilyDef<Domain, Prefix, Payload> = Object.freeze({
    kind: "event-family" as const,
    domain: spec.domain,
    prefix,
    key,
    payload: spec.payload,
    at: (member: string): EventDef<Domain, `${Prefix}${string}`, Payload> => ({
      kind: "event",
      domain: spec.domain,
      name: `${prefix}${member}` as `${Prefix}${string}`,
      payload: spec.payload,
      family,
    }),
    keyOf: (name: string): string | null =>
      name.length > prefix.length && name.startsWith(prefix) ? name.slice(prefix.length) : null,
  });
  return family;
}

/** Whether `value` is an event family definition. */
export function isEventFamilyDef(value: unknown): value is AnyEventFamilyDef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "event-family"
  );
}

/**
 * Whether `def` has a valid name: a defined event always does; a family
 * member's key must match the family's key pattern.
 */
export function hasValidEventKey(def: AnyEventDef): boolean {
  const family = def.family;
  if (!family) return true;
  const key = family.keyOf(def.name);
  return key !== null && family.key.test(key);
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

/** The part of a client that delivers raw events (`NodeClient.listenRaw`). */
export interface RawEventSource {
  listenRaw(event: string, handler: (payload: unknown) => void): () => void;
}

export interface ListenEventOptions {
  /**
   * Called, instead of the handler, for a payload that does not match the
   * schema. Without it the payload is dropped. The error's message may quote
   * the offending value, so a log line should carry only `error.event`.
   */
  readonly onInvalid?: (error: InvalidEventPayloadError) => void;
}

/**
 * Typed subscription: `handler` receives payloads that decode against `def`'s
 * schema. It gets the payload as sent (keys the schema does not name are kept
 * but untyped), so a schema that pins only the routing fields hides nothing a
 * handler reads today. A payload that does not decode is refused (tolerant
 * reader: unknown keys pass, wrong types do not) and reported to `onInvalid`.
 */
export function listenEvent<E extends AnyEventDef>(
  source: RawEventSource,
  def: E,
  handler: (payload: PayloadOf<E>) => void,
  options: ListenEventOptions = {},
): () => void {
  return source.listenRaw(def.name, (raw) => {
    const decoded = Schema.decodeUnknownResult(def.payload)(raw, { onExcessProperty: "ignore" });
    if (Result.isSuccess(decoded)) {
      handler(raw as PayloadOf<E>);
      return;
    }
    options.onInvalid?.(payloadError(def, decoded.failure));
  });
}
